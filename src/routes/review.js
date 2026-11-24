// Evidence verification, shared by assessors (only on items they hold) and admins.
// Verification is ONE shared status per item; scores are separate and blind.
import express from 'express';
import { sys } from '../db.js';
import { html, statusBadge, fmtDate, kb, VERIF_LABEL } from '../html.js';
import { sendMail } from '../mail.js';
import { baseUrl } from '../auth.js';

const go = (req, res, msg) => {
  const u = new URL(req.get('referer') ?? `${baseUrl()}/`);
  u.searchParams.delete('err');
  u.searchParams.set('msg', msg);
  res.redirect(u.pathname + u.search + (req.body.anchor ? `#${req.body.anchor}` : ''));
};
const STATUS_FOR = { verified: 'approved', observed: 'approved', returned: 'returned', not_accepted: 'not_accepted' };
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export default function reviewRoutes() {
  const r = express.Router();

  r.post('/:club/item/:req/verify', async (req, res) => {
    const action = req.body.action;
    if (!STATUS_FOR[action]) throw new Error('Unknown action');
    const comment = String(req.body.comment ?? '').trim();
    if ((action === 'returned' || action === 'not_accepted') && !comment) {
      throw new Error('Add a plain-language comment for the club. It is shown with the item.');
    }
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update club_items set status = $3, verification = $4, return_comment = $5, verified_by = $6, verified_at = now()
         where club_id = $1 and req_id = $2`,
        [Number(req.params.club), req.params.req, STATUS_FOR[action], action, comment || null, req.user.id]);
      if (!rowCount) throw new Error('You do not have access to do that.');
    }, comment || `Evidence ${action}`);
    go(req, res, `${req.params.req}: ${VERIF_LABEL[action].toLowerCase()}.`);
  });

  // Reopen a locked item. An admin reopening after the deadline also lets the club upload for 7 days.
  r.post('/:club/item/:req/reopen', async (req, res) => {
    const reason = String(req.body.reason ?? '').trim();
    if (!reason) throw new Error('A reason is required to reopen an item.');
    await req.db(async (tx) => {
      const { rows: [{ n }] } = await tx.query('select count(*)::int n from files where club_id = $1 and req_id = $2', [Number(req.params.club), req.params.req]);
      const { rowCount } = await tx.query(
        `update club_items set status = $3, verification = null, verified_by = null, verified_at = null, return_comment = null
         where club_id = $1 and req_id = $2 and status in ('approved','not_accepted')`,
        [Number(req.params.club), req.params.req, n ? 'submitted' : 'not_started']);
      if (!rowCount) throw new Error('Item is not locked or you do not have access.');
      if (req.user.role === 'admin' && req.body.allow_upload) {
        await tx.query('update club_items set upload_until = $3 where club_id = $1 and req_id = $2', [Number(req.params.club), req.params.req, inDays(7)]);
      }
    }, `Reopened: ${reason}`);
    go(req, res, `${req.params.req} reopened.`);
  });

  r.post('/:club/item/:req/flag', async (req, res) => {
    const clubId = Number(req.params.club);
    const q = await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update club_items set flagged_at = now() where club_id = $1 and req_id = $2 and status = 'not_started'`, [clubId, req.params.req]);
      if (!rowCount) throw new Error('Only items with no submission can be flagged.');
      return (await tx.query('select id, name from requirements where id = $1', [req.params.req])).rows[0];
    }, 'Flagged missing item');
    const { rows: contacts } = await sys().query('select email, name from users where club_id = $1 and active', [clubId]);
    for (const c of contacts) {
      await sendMail(c.email, `Please check: ${q.id} ${q.name}`,
        `Hello ${c.name},\n\nFQ has noticed there is no submission yet for ${q.id} ${q.name}. Please check whether evidence should be uploaded for this item.\n\nSign in with your personal link to upload.`);
    }
    go(req, res, `${req.params.req} flagged. ${contacts.length} club contact(s) emailed.`);
  });

  r.post('/:club/staff/:row/verify', async (req, res) => {
    const action = req.body.action;
    if (!['verified', 'returned', 'not_accepted'].includes(action)) throw new Error('Unknown action');
    const comment = String(req.body.comment ?? '').trim();
    if (action !== 'verified' && !comment) throw new Error('Add a comment for the club.');
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update staff_rows set status = $3, verification = $4, return_comment = $5, verified_by = $6 where club_id = $1 and id = $2`,
        [Number(req.params.club), Number(req.params.row), STATUS_FOR[action], action, comment || null, req.user.id]);
      if (!rowCount) throw new Error('You do not have access to do that.');
    }, comment || `Staff row ${action}`);
    go(req, res, 'Staff row updated.');
  });

  r.post('/:club/staff/:row/reopen', async (req, res) => {
    const reason = String(req.body.reason ?? '').trim();
    if (!reason) throw new Error('A reason is required to reopen a row.');
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update staff_rows set status = 'submitted', verification = null, verified_by = null, return_comment = null
         where club_id = $1 and id = $2 and status in ('approved','not_accepted')`, [Number(req.params.club), Number(req.params.row)]);
      if (!rowCount) throw new Error('Row is not locked or you do not have access.');
    }, `Reopened: ${reason}`);
    go(req, res, 'Staff row reopened.');
  });

  return r;
}

// ---------------------------------------------------------------- shared fragments
export function evidenceBlock({ q, it, files, names, clubId, canAct, isAdmin }) {
  const act = `/review/${clubId}/item/${q.id}`;
  let actions = '';
  if (canAct) {
    if (q.kind === 'onfield' || q.kind === 'fq') {
      actions = it.status === 'approved'
        ? html`<form class="inline" method="post" action="${act}/reopen"><input type="hidden" name="anchor" value="${q.id}">
            <input name="reason" placeholder="Reason to reopen" required><button class="small secondary">Reopen</button></form>`
        : html`<form class="inline" method="post" action="${act}/verify"><input type="hidden" name="anchor" value="${q.id}">
            <input type="hidden" name="action" value="observed"><button class="small">Mark as assessed</button></form>`;
    } else if (it.status === 'submitted') {
      actions = html`<form method="post" action="${act}/verify" class="inline"><input type="hidden" name="anchor" value="${q.id}">
          <button class="small" name="action" value="verified">Verify</button>
          <input name="comment" placeholder="Comment for the club (required to return or not accept)" style="min-width:280px">
          <button class="small secondary" name="action" value="returned">Return with comment</button>
          <button class="small danger" name="action" value="not_accepted" onclick="return confirm('Mark this evidence as not accepted? The club cannot resubmit it.')">Not accepted</button></form>`;
    } else if (it.status === 'approved' || it.status === 'not_accepted') {
      actions = html`<form class="inline" method="post" action="${act}/reopen"><input type="hidden" name="anchor" value="${q.id}">
        <input name="reason" placeholder="Reason to reopen" required>
        ${isAdmin ? html`<label class="small"><input type="checkbox" name="allow_upload" value="1"> let the club upload for 7 days</label>` : ''}
        <button class="small secondary">Reopen</button></form>`;
    } else if (it.status === 'not_started') {
      actions = it.flagged_at ? html`<span class="small muted">Flagged ${fmtDate(it.flagged_at)}</span>`
        : html`<form class="inline" method="post" action="${act}/flag"><input type="hidden" name="anchor" value="${q.id}">
          <button class="small secondary">Flag missing (emails club)</button></form>`;
    } else {
      actions = html`<span class="small muted">Waiting for the club to resubmit.</span>`;
    }
  }
  return html`
    <div class="row">${statusBadge(it.status, q.kind)}
      ${it.verification ? html`<span class="small muted">${VERIF_LABEL[it.verification]} by ${names[it.verified_by] ?? 'FQ'} ${fmtDate(it.verified_at)}</span>` : ''}</div>
    <div class="guid">${q.guidance} <span class="small">Evidence: ${q.evidence}.</span></div>
    ${it.return_comment ? html`<div class="comment small"><strong>${it.status === 'not_accepted' ? 'Not accepted' : 'Returned'}:</strong> ${it.return_comment}</div>` : ''}
    ${files.length ? html`<ul class="files">${files.map((f) => html`<li><a href="/files/${f.id}" target="_blank">${f.filename}</a>
      <span class="muted small">${kb(f.size)} · ${fmtDate(f.uploaded_at)}</span></li>`)}</ul>`
      : q.kind === 'document' ? html`<div class="small muted">No evidence uploaded.</div>` : ''}
    ${actions}`;
}

export function staffTable({ staff, files, clubId, canAct }) {
  return html`<div class="tablewrap"><table>
    <tr><th>Person</th><th>Role</th><th>Team</th><th>Qualification</th><th>Expiry</th><th>Blue card</th><th>Yrs</th><th>Type</th><th>Certificate</th><th>Status</th>${canAct ? html`<th></th>` : ''}</tr>
    ${staff.map((s) => html`<tr>
      <td>${s.person}</td><td>${s.position}</td><td>${s.team}</td><td>${s.qualification}</td>
      <td>${s.qual_expiry ? new Date(s.qual_expiry).toISOString().slice(0, 10) : ''}</td>
      <td class="mono">${s.blue_card}<br><span class="muted">${s.blue_card_expiry ? new Date(s.blue_card_expiry).toISOString().slice(0, 10) : ''}</span></td>
      <td>${s.years_at_club}</td><td>${s.employment_type}</td>
      <td>${files.filter((f) => f.staff_row_id === s.id).map((f) => html`<a href="/files/${f.id}" target="_blank">${f.filename}</a><br>`)}</td>
      <td>${statusBadge(s.status)}${s.return_comment ? html`<div class="small muted">${s.return_comment}</div>` : ''}</td>
      ${canAct ? html`<td>${s.status === 'submitted' ? html`<form method="post" action="/review/${clubId}/staff/${s.id}/verify" class="inline">
          <button class="small" name="action" value="verified">Verify</button>
          <input name="comment" placeholder="Comment" style="width:120px"><button class="small secondary" name="action" value="returned">Return</button>
          <button class="small danger" name="action" value="not_accepted">Not accepted</button></form>`
        : ['approved', 'not_accepted'].includes(s.status) ? html`<form method="post" action="/review/${clubId}/staff/${s.id}/reopen" class="inline">
          <input name="reason" placeholder="Reason" required style="width:110px"><button class="small secondary">Reopen</button></form>` : ''}</td>` : ''}
    </tr>`)}
    ${staff.length ? '' : html`<tr><td colspan="11" class="muted">No staff rows submitted.</td></tr>`}
  </table></div>`;
}
