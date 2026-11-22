// Evidence review shared by assessors (assigned clubs only) and admins.
// Verification is ONE shared status per item, so both assessors do not re-check
// the same evidence. Scores are separate and blind (see assessor.js).
import express from 'express';
import { sys, num } from '../db.js';
import { html, statusBadge, fmtDate, kb, VERIF_LABEL, fmtNum } from '../html.js';
import { SECTIONS, applicable } from '../catalog.js';
import { getReqs, getClub, getItems, getFiles, getStaff, scorable } from '../model.js';
import { sendMail } from '../mail.js';
import { baseUrl } from '../auth.js';

const go = (req, res, msg) => {
  const u = new URL(req.get('referer') ?? `${baseUrl()}/`);
  u.searchParams.delete('err');
  u.searchParams.set('msg', msg);
  res.redirect(u.pathname + u.search + (req.body.anchor ? `#${req.body.anchor}` : ''));
};
const STATUS_FOR = { verified: 'approved', observed: 'approved', returned: 'returned', rejected: 'closed' };

export default function reviewRoutes() {
  const r = express.Router();

  r.post('/:club/item/:req/verify', async (req, res) => {
    const action = req.body.action;
    if (!STATUS_FOR[action]) throw new Error('Unknown action');
    const comment = String(req.body.comment ?? '').trim();
    if (action === 'returned' && !comment) throw new Error('Add a plain-language comment for the club when returning an item.');
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update club_items set status = $3, verification = $4, return_comment = $5, verified_by = $6, verified_at = now()
         where club_id = $1 and req_id = $2`,
        [Number(req.params.club), req.params.req, STATUS_FOR[action], action, action === 'returned' ? comment : null, req.user.id]);
      if (!rowCount) throw new Error('You do not have access to do that.');
    }, comment || `Evidence ${action}`);
    go(req, res, `${req.params.req}: ${VERIF_LABEL[action].toLowerCase()}.`);
  });

  r.post('/:club/item/:req/reopen', async (req, res) => {
    const reason = String(req.body.reason ?? '').trim();
    if (!reason) throw new Error('A reason is required to reopen an item.');
    await req.db(async (tx) => {
      const { rows: [{ n }] } = await tx.query('select count(*)::int n from files where club_id = $1 and req_id = $2', [Number(req.params.club), req.params.req]);
      const { rowCount } = await tx.query(
        `update club_items set status = $3, verification = null, verified_by = null, verified_at = null, return_comment = null
         where club_id = $1 and req_id = $2 and status in ('approved','closed')`,
        [Number(req.params.club), req.params.req, n ? 'submitted' : 'not_started']);
      if (!rowCount) throw new Error('Item is not locked or you do not have access.');
    }, `Reopened: ${reason}`);
    go(req, res, `${req.params.req} reopened.`);
  });

  // Flag a missing item: the only interim contact a club gets during assessment.
  r.post('/:club/item/:req/flag', async (req, res) => {
    const clubId = Number(req.params.club);
    const reqRow = await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update club_items set flagged_at = now() where club_id = $1 and req_id = $2 and status = 'not_started'`, [clubId, req.params.req]);
      if (!rowCount) throw new Error('Only items with no submission can be flagged.');
      return (await tx.query('select id, name from requirements where id = $1', [req.params.req])).rows[0];
    }, 'Flagged missing item');
    // RLS-checked update succeeded; now the trusted mail layer looks up the club contacts.
    const { rows: contacts } = await sys().query('select email, name from users where club_id = $1 and active', [clubId]);
    for (const c of contacts) {
      await sendMail(c.email, `Please check: ${reqRow.id} ${reqRow.name}`,
        `Hello ${c.name},\n\nFQ has noticed there is no submission yet for ${reqRow.id} ${reqRow.name}. Please check whether evidence should be uploaded for this item.\n\nSign in with your personal link to upload.`);
    }
    go(req, res, `${req.params.req} flagged. ${contacts.length} club contact(s) emailed.`);
  });

  r.post('/:club/staff/:row/verify', async (req, res) => {
    const action = req.body.action;
    if (!['verified', 'returned', 'rejected'].includes(action)) throw new Error('Unknown action');
    const comment = String(req.body.comment ?? '').trim();
    if (action === 'returned' && !comment) throw new Error('Add a comment for the club when returning a row.');
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update staff_rows set status = $3, verification = $4, return_comment = $5, verified_by = $6 where club_id = $1 and id = $2`,
        [Number(req.params.club), Number(req.params.row), STATUS_FOR[action], action, action === 'returned' ? comment : null, req.user.id]);
      if (!rowCount) throw new Error('You do not have access to do that.');
    }, comment || `Staff row ${action}`);
    go(req, res, 'Staff row updated.');
  });

  r.post('/:club/staff/:row/reopen', async (req, res) => {
    const reason = String(req.body.reason ?? '').trim();
    if (!reason) throw new Error('A reason is required to reopen a row.');
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update staff_rows set status = 'submitted', verification = null, verified_by = null where club_id = $1 and id = $2 and status in ('approved','closed')`,
        [Number(req.params.club), Number(req.params.row)]);
      if (!rowCount) throw new Error('Row is not locked or you do not have access.');
    }, `Reopened: ${reason}`);
    go(req, res, 'Staff row reopened.');
  });

  return r;
}

// ---------------------------------------------------------------- shared club review page
export async function loadReview(req, clubId) {
  return req.db(async (tx) => {
    const club = await getClub(tx, clubId);
    if (!club) return null;
    const reqs = await getReqs(tx);
    const items = await getItems(tx, clubId);
    const { rows: crit } = await tx.query('select * from requirement_criteria');
    const { rows: prior } = await tx.query('select req_id, score from prior_scores where club_id = $1', [clubId]);
    const { rows: names } = await tx.query('select id, name from users where id = any($1::int[])',
      [[...new Set([...Object.values(items).map((i) => i.verified_by)].filter(Boolean))]]);
    // Deliberately unfiltered by assessor: RLS returns only the caller's own scores
    // (or nothing, for an admin before both assessors lock in).
    const { rows: scores } = await tx.query('select req_id, score, note, assessor_id from scores where club_id = $1', [clubId]);
    const { rows: [lock] } = await tx.query('select locked_at from score_locks where club_id = $1 and assessor_id = $2', [clubId, req.user.id]);
    const { rows: [slot] } = await tx.query('select assessor_slot($1) as s', [clubId]);
    return {
      club, reqs, items, files: await getFiles(tx, clubId), staff: await getStaff(tx, clubId),
      criteria: Object.fromEntries(crit.map((c) => [c.req_id, c.criteria])),
      prior: Object.fromEntries(prior.map((p) => [p.req_id, num(p.score)])),
      names: Object.fromEntries(names.map((n) => [n.id, n.name])),
      myScores: Object.fromEntries(scores.filter((s) => s.assessor_id === req.user.id).map((s) => [s.req_id, s])),
      locked: lock?.locked_at ?? null, slot: slot.s,
    };
  });
}

export function reviewPage(d, { mode, section, base }) {
  const scoring = mode === 'assessor' && d.slot;
  const canScore = scoring && !d.locked;
  const scorableIds = new Set(scorable(d.reqs, d.club, d.items).map((r) => r.id));
  const scoredCount = [...scorableIds].filter((id) => d.myScores[id]).length;
  const reqs = d.reqs.filter((r) => r.section === section);
  const files = (id) => d.files.filter((f) => f.req_id === id);
  let lastGroup = '';

  const scoreInput = (q) => {
    if (!scoring) return '';
    const mine = d.myScores[q.id];
    if (!scorableIds.has(q.id)) return '';
    if (q.section === 'nn') {
      return html`<div class="noprint"><label class="small muted">My assessment</label><br>
        <select name="s_${q.id}" form="scoreform" ${canScore ? '' : 'disabled'}>
          <option value=""></option><option value="1" ${mine && num(mine.score) === 1 ? 'selected' : ''}>Met</option>
          <option value="0" ${mine && num(mine.score) === 0 ? 'selected' : ''}>Not met</option></select></div>`;
    }
    return html`<div class="noprint"><label class="small muted">My score (0-${q.max_score})</label><br>
      <input type="number" name="s_${q.id}" form="scoreform" min="0" max="${q.max_score}" step="0.1" value="${mine ? num(mine.score) : ''}" ${canScore ? '' : 'disabled'}>
      <div class="small muted">x ${q.weight}</div>
      <textarea name="n_${q.id}" form="scoreform" placeholder="Private note" style="min-height:34px;width:150px;margin-top:4px" ${canScore ? '' : 'disabled'}>${mine?.note ?? ''}</textarea></div>`;
  };

  const actions = (q, it) => {
    const act = `/review/${d.club.id}/item/${q.id}`;
    if (q.kind === 'onfield' || q.kind === 'fq') {
      if (it.status === 'approved') {
        return html`<form class="inline" method="post" action="${act}/reopen"><input type="hidden" name="anchor" value="${q.id}">
          <input name="reason" placeholder="Reason to reopen" required><button class="small secondary">Reopen</button></form>`;
      }
      return html`<form class="inline" method="post" action="${act}/verify"><input type="hidden" name="anchor" value="${q.id}">
        <input type="hidden" name="action" value="observed"><button class="small">Mark as assessed</button></form>`;
    }
    if (it.status === 'submitted') {
      return html`<form method="post" action="${act}/verify" class="inline"><input type="hidden" name="anchor" value="${q.id}">
          <button class="small" name="action" value="verified">Verify</button>
          <button class="small danger" name="action" value="rejected" onclick="return confirm('Reject this evidence? The item will be closed.')">Reject</button>
          <input name="comment" placeholder="Comment for club (required to return)" style="min-width:240px">
          <button class="small secondary" name="action" value="returned">Return with comment</button></form>`;
    }
    if (it.status === 'approved' || it.status === 'closed') {
      return html`<form class="inline" method="post" action="${act}/reopen"><input type="hidden" name="anchor" value="${q.id}">
        <input name="reason" placeholder="Reason to reopen" required><button class="small secondary">Reopen</button></form>`;
    }
    if (it.status === 'not_started') {
      return it.flagged_at ? html`<span class="small muted">Flagged ${fmtDate(it.flagged_at)}</span>`
        : html`<form class="inline" method="post" action="${act}/flag"><input type="hidden" name="anchor" value="${q.id}">
          <button class="small secondary">Flag missing (emails club)</button></form>`;
    }
    return html`<span class="small muted">Waiting for the club to resubmit.</span>`;
  };

  const itemCard = (q) => {
    const it = d.items[q.id];
    const a = applicable(q, d.club, it);
    const grp = q.grp !== lastGroup ? html`<h3>${(lastGroup = q.grp)}</h3>` : '';
    if (!a.applies) {
      return html`${grp}<div class="card item" style="opacity:.65"><div class="code">${q.id}</div><div><strong>${q.name}</strong>
        <div class="guid">${a.why}${a.carry && d.prior[q.id] !== undefined ? html` Previous score: <strong>${fmtNum(d.prior[q.id])}</strong>.` : ''}</div></div><div></div></div>`;
    }
    const fl = files(q.id);
    return html`${grp}<div class="card item" id="${q.id}">
      <div class="code">${q.id}</div>
      <div>
        <div class="row"><strong>${q.name}</strong>${statusBadge(it.status, q.kind)}
          ${it.verification ? html`<span class="small muted">${VERIF_LABEL[it.verification]} by ${d.names[it.verified_by] ?? 'FQ'} ${fmtDate(it.verified_at)}</span>` : ''}</div>
        <div class="guid">${q.guidance} <span class="small">Evidence: ${q.evidence}.</span></div>
        ${it.return_comment ? html`<div class="comment small"><strong>Returned:</strong> ${it.return_comment}</div>` : ''}
        ${fl.length ? html`<ul class="files">${fl.map((f) => html`<li><a href="/files/${f.id}" target="_blank">${f.filename}</a>
          <span class="muted small">${kb(f.size)} · ${fmtDate(f.uploaded_at)}</span></li>`)}</ul>`
          : q.kind === 'document' ? html`<div class="small muted">No evidence uploaded.</div>` : ''}
        ${actions(q, it)}
        <details><summary>Assessor criteria</summary><div class="criteria">${d.criteria[q.id]}</div></details>
      </div>
      ${scoreInput(q)}
    </div>`;
  };

  const staffTab = () => html`
    <h3>Staff table submitted by the club</h3>
    <div class="tablewrap"><table>
      <tr><th>Person</th><th>Role</th><th>Team</th><th>Qualification</th><th>Expiry</th><th>Blue card</th><th>Yrs</th><th>Type</th><th>Certificate</th><th>Status</th><th></th></tr>
      ${d.staff.map((s) => html`<tr>
        <td>${s.person}</td><td>${s.position}</td><td>${s.team}</td><td>${s.qualification}</td>
        <td>${s.qual_expiry ? new Date(s.qual_expiry).toISOString().slice(0, 10) : ''}</td>
        <td class="mono">${s.blue_card}<br><span class="muted">${s.blue_card_expiry ? new Date(s.blue_card_expiry).toISOString().slice(0, 10) : ''}</span></td>
        <td>${s.years_at_club}</td><td>${s.employment_type}</td>
        <td>${d.files.filter((f) => f.staff_row_id === s.id).map((f) => html`<a href="/files/${f.id}" target="_blank">${f.filename}</a><br>`)}</td>
        <td>${statusBadge(s.status)}</td>
        <td>${s.status === 'submitted' ? html`<form method="post" action="/review/${d.club.id}/staff/${s.id}/verify" class="inline">
            <button class="small" name="action" value="verified">Verify</button>
            <input name="comment" placeholder="Comment" style="width:120px"><button class="small secondary" name="action" value="returned">Return</button>
            <button class="small danger" name="action" value="rejected">Reject</button></form>`
          : ['approved', 'closed'].includes(s.status) ? html`<form method="post" action="/review/${d.club.id}/staff/${s.id}/reopen" class="inline">
            <input name="reason" placeholder="Reason" required style="width:110px"><button class="small secondary">Reopen</button></form>`
          : html`<span class="small muted">${s.return_comment}</span>`}</td>
      </tr>`)}
      ${d.staff.length ? '' : html`<tr><td colspan="11" class="muted">No staff rows submitted.</td></tr>`}
    </table></div>
    <h3>Scored positions</h3>
    ${reqs.map((q) => html`<div class="card item" id="${q.id}"><div class="code">${q.id}</div><div><strong>${q.name}</strong>
      <div class="guid">${q.guidance}</div>
      <details><summary>Assessor criteria</summary><div class="criteria">${d.criteria[q.id]}</div></details></div>${scoreInput(q)}</div>`)}`;

  return html`
    <div class="row"><div><h1>${d.club.name}</h1>
      <p class="sub">Pool ${d.club.pool} · current shield ${d.club.current_shield} ·
      ${scoring ? html`you are the <strong>${d.slot} assessor</strong>` : mode === 'admin' ? 'admin view (oversight only, no scoring)' : 'moderator access'}</p></div>
      <span class="spacer"></span>
      ${scoring ? html`<div class="card" style="margin:0"><div class="small muted">My scoring</div>
        <div><strong>${scoredCount}</strong> of ${scorableIds.size} items scored</div>
        ${d.locked ? html`<span class="badge b-approved">Locked in ${fmtDate(d.locked)}</span>`
          : html`<form method="post" action="/assessor/club/${d.club.id}/lock" onsubmit="return confirm('Lock in your scores for this club? You will not be able to change them.')">
            <button class="small" ${scoredCount === 0 ? 'disabled' : ''}>Lock in my scores</button></form>`}</div>` : ''}
    </div>
    ${scoring ? html`<div class="notice small">Blind scoring: your scores are private. You cannot see the other assessor's scores or progress, and they cannot see yours.
      Scores become visible to the admin and any moderator only after both assessors lock in.</div>` : ''}
    <div class="tabs">${SECTIONS.map((s) => html`<a href="${base}?s=${s.id}" class="${s.id === section ? 'on' : ''}">${s.label}</a>`)}</div>
    ${section === 'staff' ? staffTab() : reqs.map(itemCard)}
    ${canScore ? html`<form id="scoreform" method="post" action="/assessor/club/${d.club.id}/scores" class="card noprint" style="position:sticky;bottom:0;display:flex;gap:12px;align-items:center;box-shadow:0 -2px 10px rgba(0,0,0,.06)">
      <input type="hidden" name="section" value="${section}">
      <span class="small muted">Scores save for this tab only. Decimals allowed (one place).</span><span class="spacer"></span>
      <button>Save my scores</button></form>` : ''}
  `;
}
