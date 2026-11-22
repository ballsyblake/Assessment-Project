import express from 'express';
import { num } from '../db.js';
import { html, progressBar, fmtDate, fmtNum, kb } from '../html.js';
import { getReqs, getClub, getItems, getStaff, submissionProgress, sumProgress, scorable } from '../model.js';
import { loadReview, reviewPage } from './review.js';

export default function assessorRoutes() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const d = await req.db(async (tx) => {
      const reqs = await getReqs(tx);
      // RLS: only assigned clubs (or clubs where this person moderates) are returned.
      const { rows: assigned } = await tx.query('select * from assignments order by club_id');
      const clubs = [];
      for (const a of assigned) {
        const club = await getClub(tx, a.club_id);
        const items = await getItems(tx, club.id);
        const staff = await getStaff(tx, club.id);
        const { rows: [{ n }] } = await tx.query('select count(*)::int n from scores where club_id = $1', [club.id]);
        const { rows: [lock] } = await tx.query('select locked_at from score_locks where club_id = $1', [club.id]);
        clubs.push({ club, slot: a.first_id === req.user.id ? 'First' : 'Second', prog: sumProgress(submissionProgress(reqs, club, items, staff)),
          waiting: Object.values(items).filter((i) => i.status === 'submitted').length + staff.filter((s) => s.status === 'submitted').length,
          scored: n, total: scorable(reqs, club, items).length, locked: lock?.locked_at });
      }
      const { rows: mods } = await tx.query(
        `select m.*, c.name club, q.name item, (select final_score from resolutions r where r.club_id = m.club_id and r.req_id = m.req_id) final
         from moderations m join clubs c on c.id = m.club_id join requirements q on q.id = m.req_id order by m.assigned_at`);
      return { clubs, mods };
    });
    res.page('My clubs', html`
      <h1>My clubs</h1><p class="sub">Clubs assigned to you this cycle.</p>
      <div class="tablewrap"><table>
        <tr><th>Club</th><th>My role</th><th>Club submission</th><th class="num">Waiting for review</th><th>My scoring</th><th></th></tr>
        ${d.clubs.map((c) => html`<tr>
          <td><strong>${c.club.name}</strong><br><span class="small muted">Pool ${c.club.pool}</span></td>
          <td>${c.slot} assessor</td>
          <td style="min-width:180px">${progressBar(c.prog.approved, c.prog.submitted, c.prog.total)}<span class="small muted">${c.prog.approved} approved · ${c.prog.submitted} submitted · ${c.prog.total} total</span></td>
          <td class="num">${c.waiting ? html`<span class="badge b-submitted">${c.waiting}</span>` : '0'}</td>
          <td>${c.locked ? html`<span class="badge b-approved">Locked</span>` : html`${c.scored} / ${c.total} scored`}</td>
          <td><a class="btn small" href="/assessor/club/${c.club.id}">Open</a></td></tr>`)}
        ${d.clubs.length ? '' : html`<tr><td colspan="6" class="muted">No clubs assigned yet.</td></tr>`}
      </table></div>
      <h2>Moderation requests</h2>
      <p class="sub">Disputed items the admin has asked you to decide. You are never asked to moderate a club you assess.</p>
      <div class="tablewrap"><table><tr><th>Club</th><th>Item</th><th>Assigned</th><th>Status</th><th></th></tr>
        ${d.mods.map((m) => html`<tr><td>${m.club}</td><td>${m.req_id} ${m.item}</td><td>${fmtDate(m.assigned_at)}</td>
          <td>${m.final !== null ? html`<span class="badge b-approved">Decided: ${fmtNum(m.final)}</span>` : html`<span class="badge b-warn">Awaiting decision</span>`}</td>
          <td><a class="btn small" href="/assessor/moderate/${m.club_id}/${m.req_id}">Open</a></td></tr>`)}
        ${d.mods.length ? '' : html`<tr><td colspan="5" class="muted">None.</td></tr>`}
      </table></div>`);
  });

  r.get('/club/:id', async (req, res) => {
    const d = await loadReview(req, Number(req.params.id));
    if (!d || !d.slot) return res.status(404).page('Not found', html`<h1>Club not found</h1><p>You are not assigned to this club.</p>`);
    const section = req.query.s ?? 'planning';
    res.page(d.club.name, reviewPage(d, { mode: 'assessor', section, base: `/assessor/club/${d.club.id}` }), { active: '/assessor' });
  });

  r.post('/club/:id/scores', async (req, res) => {
    const clubId = Number(req.params.id);
    let saved = 0;
    await req.db(async (tx) => {
      for (const [k, v] of Object.entries(req.body)) {
        if (!k.startsWith('s_')) continue;
        const reqId = k.slice(2);
        const note = String(req.body[`n_${reqId}`] ?? '').trim() || null;
        if (v === '' || v === undefined) {
          await tx.query('delete from scores where club_id = $1 and req_id = $2 and assessor_id = $3', [clubId, reqId, req.user.id]);
          continue;
        }
        const score = Math.round(Number(v) * 10) / 10;
        if (!Number.isFinite(score)) throw new Error(`${reqId}: score must be a number`);
        await tx.query(
          `insert into scores(club_id, req_id, assessor_id, slot, score, note) values ($1,$2,$3,'first',$4,$5)
           on conflict (club_id, req_id, assessor_id) do update set score = excluded.score, note = excluded.note`,
          [clubId, reqId, req.user.id, score, note]);
        saved++;
      }
    }, 'Assessor saved scores');
    res.redirect(`/assessor/club/${clubId}?s=${encodeURIComponent(req.body.section ?? 'planning')}&msg=${encodeURIComponent(`${saved} score(s) saved.`)}`);
  });

  r.post('/club/:id/lock', async (req, res) => {
    const clubId = Number(req.params.id);
    await req.db((tx) => tx.query('insert into score_locks(club_id, assessor_id) values ($1,$2)', [clubId, req.user.id]), 'Assessor locked in scores');
    res.redirect(`/assessor/club/${clubId}?msg=${encodeURIComponent('Scores locked in. The admin will reconcile once both assessors have locked.')}`);
  });

  // ---------------------------------------------------------------- moderation
  const loadMod = (req) => req.db(async (tx) => {
    const clubId = Number(req.params.club);
    const { rows: [m] } = await tx.query('select * from moderations where club_id = $1 and req_id = $2', [clubId, req.params.req]);
    if (!m) return null;
    const club = await getClub(tx, clubId);
    const { rows: [q] } = await tx.query('select * from requirements where id = $1', [req.params.req]);
    const { rows: [crit] } = await tx.query('select criteria from requirement_criteria where req_id = $1', [req.params.req]);
    // RLS returns both assessors' scores only because this person is the moderator and both have locked.
    const { rows: scores } = await tx.query(
      `select s.score, s.note, s.slot, u.name from scores s join users u on u.id = s.assessor_id where s.club_id = $1 and s.req_id = $2 order by s.slot`, [clubId, req.params.req]);
    const { rows: files } = await tx.query('select id, filename, size from files where club_id = $1 and req_id = $2', [clubId, req.params.req]);
    const { rows: [resn] } = await tx.query('select * from resolutions where club_id = $1 and req_id = $2', [clubId, req.params.req]);
    const items = await getItems(tx, clubId);
    return { m, club, q, crit: crit?.criteria, scores, files, resn, item: items[req.params.req] };
  });

  r.get('/moderate/:club/:req', async (req, res) => {
    const d = await loadMod(req);
    if (!d) return res.status(404).page('Not found', html`<h1>Not found</h1>`);
    res.page('Moderation', html`
      <p><a href="/assessor">&larr; My clubs</a></p>
      <h1>Moderate ${d.q.id}: ${d.q.name}</h1><p class="sub">${d.club.name} · max score ${num(d.q.max_score)} · weighting ${num(d.q.weight)}</p>
      <div class="grid">${d.scores.map((s) => html`<div class="card"><div class="small muted">${s.slot} assessor · ${s.name}</div>
        <div class="stat">${fmtNum(s.score)}</div>${s.note ? html`<div class="small">${s.note}</div>` : ''}</div>`)}
        ${d.scores.length < 2 ? html`<div class="card muted">Only ${d.scores.length} score(s) recorded for this item.</div>` : ''}</div>
      ${d.files.length ? html`<h2>Evidence</h2><ul class="files">${d.files.map((f) => html`<li><a href="/files/${f.id}" target="_blank">${f.filename}</a> <span class="small muted">${kb(f.size)}</span></li>`)}</ul>` : ''}
      <details open><summary>Assessor criteria</summary><div class="criteria">${d.crit}</div></details>
      <h2>Your decision</h2>
      ${d.resn ? html`<div class="notice">Recorded final score <strong>${fmtNum(d.resn.final_score)}</strong> on ${fmtDate(d.resn.resolved_at)}: ${d.resn.note}</div>` : ''}
      <form method="post" class="card">
        <label>Final score (0-${num(d.q.max_score)})<br><input type="number" step="0.1" min="0" max="${num(d.q.max_score)}" name="score" required value="${d.resn ? num(d.resn.final_score) : ''}"></label>
        <p><label>Short reason<br><textarea name="note" required>${d.resn?.note ?? ''}</textarea></label></p>
        <button>${d.resn ? 'Update decision' : 'Record decision'}</button></form>`, { active: '/assessor' });
  });

  r.post('/moderate/:club/:req', async (req, res) => {
    const note = String(req.body.note ?? '').trim();
    if (!note) throw new Error('A short reason is required.');
    await req.db((tx) => tx.query(
      `insert into resolutions(club_id, req_id, final_score, method, note) values ($1,$2,$3,'moderator',$4)
       on conflict (club_id, req_id) do update set final_score = excluded.final_score, note = excluded.note, method = 'moderator'`,
      [Number(req.params.club), req.params.req, Math.round(Number(req.body.score) * 10) / 10, note]), note);
    res.redirect(`/assessor/moderate/${req.params.club}/${req.params.req}?msg=${encodeURIComponent('Decision recorded.')}`);
  });

  return r;
}
