import express from 'express';
import { num } from '../db.js';
import { html, raw, progressBar, fmtDate, fmtDay, fmtNum, TICK_LABEL } from '../html.js';
import { sectionLabel, framework } from '../catalog.js';
import { scoreText } from '../scoring.js';
import { suggestStaffScores } from '../staffCalc.js';
import { getReqs, getClub, getItems, getFiles, getStaff, getPhases, submissionProgress, sumProgress, clubResult } from '../model.js';
import { evidenceBlock, staffTable } from './review.js';

const PHASE_IDS = framework.phases.map((p) => p.id);
const COMMENT_SECTIONS = [...PHASE_IDS, 'overall'];

export default function assessorRoutes() {
  const r = express.Router();

  // ---------------------------------------------------------------- dashboard
  r.get('/', async (req, res) => {
    const d = await req.db(async (tx) => {
      const phases = await getPhases(tx);
      // RLS returns only this assessor's own slots, locks and third assignments.
      const { rows: mine } = await tx.query(
        `select s.club_id, s.req_id, s.slot, q.section, q.kind, c.name club, c.pool,
           exists (select 1 from scores x where x.club_id = s.club_id and x.req_id = s.req_id and x.slot = s.slot) scored,
           item_applies(s.club_id, s.req_id) applies, ci.status
         from slots s join requirements q on q.id = s.req_id join clubs c on c.id = s.club_id
         left join club_items ci on ci.club_id = s.club_id and ci.req_id = s.req_id
         order by c.name, q.sort`);
      const { rows: locks } = await tx.query('select club_id, phase, locked_at from score_locks');
      const { rows: thirds } = await tx.query(
        `select t.*, c.name club, q.name item, q.section, r.final_score
         from third_assignments t join clubs c on c.id = t.club_id join requirements q on q.id = t.req_id
         left join resolutions r on r.club_id = t.club_id and r.req_id = t.req_id order by t.assigned_at`);
      const { rows: leads } = await tx.query('select c.* from club_leads l join clubs c on c.id = l.club_id order by c.name');
      const reqs = await getReqs(tx);
      const leadRows = [];
      for (const c of leads) {
        const items = await getItems(tx, c.id);
        const staff = await getStaff(tx, c.id);
        const { rows: [cm] } = await tx.query('select count(*)::int n from lead_comments where club_id = $1', [c.id]);
        leadRows.push({ club: c, prog: sumProgress(submissionProgress(reqs, c, items, staff)), comments: cm.n });
      }
      return { phases, mine: mine.filter((m) => m.applies), locks, thirds, leadRows };
    });

    const byPhase = (pid) => {
      const rows = d.mine.filter((m) => m.section === pid);
      const clubs = new Map();
      for (const m of rows) {
        const c = clubs.get(m.club_id) ?? { id: m.club_id, name: m.club, items: [] };
        c.items.push(m);
        clubs.set(m.club_id, c);
      }
      return [...clubs.values()];
    };

    const phaseBlock = (p) => {
      const clubs = byPhase(p.id);
      if (!clubs.length) return '';
      const head = html`<div class="phase-head"><h2>${p.label}</h2>
        ${p.closed ? html`<span class="badge b-done">Closed</span>` : p.submissionOpen ? html`<span class="badge b-submitted">Submission period · due ${fmtDay(p.deadline)}</span>`
          : html`<span class="badge b-warn">Scoring</span>`}</div>`;
      if (p.closed) return html`${head}<p class="small muted">Finished. ${clubs.length} club(s).</p>`;
      if (p.submissionOpen) {
        return html`${head}<p class="small muted">Clubs are still submitting. You can review evidence as it arrives; scoring opens after the deadline.</p>
          <div class="tablewrap"><table><tr><th>Club</th><th>Your items</th><th>Club submission on your items</th><th></th></tr>
          ${clubs.map((c) => {
            const docs = c.items.filter((i) => i.kind === 'document');
            const sub = docs.filter((i) => i.status && i.status !== 'not_started').length;
            const ok = docs.filter((i) => i.status === 'approved').length;
            return html`<tr><td><strong>${c.name}</strong></td><td class="small">${c.items.map((i) => i.req_id).join(', ')}</td>
              <td style="min-width:180px">${docs.length ? html`${progressBar(ok, sub - ok, docs.length)}<span class="small muted">${sub} of ${docs.length} submitted · ${ok} verified</span>` : html`<span class="small muted">Observed or data items</span>`}</td>
              <td><a class="btn small secondary" href="/assessor/club/${c.id}?phase=${p.id}">Open</a></td></tr>`;
          })}</table></div>`;
      }
      return html`${head}<div class="tablewrap"><table><tr><th>Club</th><th>Status</th><th></th></tr>
        ${clubs.map((c) => {
          const lock = d.locks.find((l) => l.club_id === c.id && l.phase === p.id);
          const todo = c.items.filter((i) => !i.scored);
          return html`<tr><td><strong>${c.name}</strong></td>
            <td>${lock ? html`<span class="badge b-done">&#10003; Locked</span>`
              : todo.length ? html`<span class="badge b-warn">${todo.length} to score</span> <span class="small muted">${todo.map((i) => i.req_id).join(', ')}</span>`
                : html`<span class="badge b-submitted">Ready to lock</span>`}</td>
            <td>${lock ? '' : html`<a class="btn small" href="/assessor/club/${c.id}?phase=${p.id}">Open</a>`}</td></tr>`;
        })}</table></div>`;
    };

    const openThirds = d.thirds.filter((t) => t.final_score === null);
    res.page('My work', html`
      <h1>My work</h1>
      <p class="sub">Your items by phase. Scoring is blind: you cannot see anyone else's scores or progress.</p>
      ${d.thirds.length ? html`<h2>Third assessments</h2>
        <div class="tablewrap"><table><tr><th>Club</th><th>Item</th><th>Assigned</th><th>Status</th><th></th></tr>
        ${d.thirds.map((t) => html`<tr><td>${t.club}</td><td>${t.req_id} ${t.item}</td><td>${fmtDate(t.assigned_at)}</td>
          <td>${t.final_score !== null ? html`<span class="badge b-done">Decided: ${fmtNum(t.final_score)}</span>` : html`<span class="badge b-warn">Awaiting your decision</span>`}</td>
          <td><a class="btn small ${t.final_score !== null ? 'secondary' : ''}" href="/assessor/third/${t.club_id}/${t.req_id}">Open</a></td></tr>`)}
        </table></div>${openThirds.length ? '' : ''}` : ''}
      ${d.leadRows.length ? html`<h2>Clubs you lead</h2>
        <div class="tablewrap"><table><tr><th>Club</th><th>Submission</th><th>Feedback comments</th><th></th></tr>
        ${d.leadRows.map((l) => html`<tr><td><strong>${l.club.name}</strong><br><span class="small muted">Pool ${l.club.pool}</span></td>
          <td style="min-width:180px">${progressBar(l.prog.approved, l.prog.submitted, l.prog.total)}<span class="small muted">${l.prog.approved} approved · ${l.prog.submitted} awaiting review</span></td>
          <td>${l.comments} of ${COMMENT_SECTIONS.length} written</td>
          <td><a class="btn small secondary" href="/assessor/lead/${l.club.id}">Open</a></td></tr>`)}
        </table></div>` : ''}
      ${d.phases.map(phaseBlock)}
      ${d.mine.length ? '' : html`<div class="card muted">No items are assigned to you yet.</div>`}`);
  });

  // ---------------------------------------------------------------- club work page (my items only)
  const loadWork = (req, clubId, phase) => req.db(async (tx) => {
    const club = await getClub(tx, clubId);
    if (!club) return null;
    const { rows: mySlots } = await tx.query(
      `select s.req_id, s.slot from slots s join requirements q on q.id = s.req_id
       where s.club_id = $1 and q.section = $2 and item_applies($1, s.req_id) order by q.sort`, [clubId, phase]);
    const reqs = (await getReqs(tx)).filter((q) => mySlots.some((m) => m.req_id === q.id));
    const { rows: crit } = await tx.query('select * from requirement_criteria where req_id = any($1::text[])', [reqs.map((q) => q.id)]);
    const { rows: scores } = await tx.query('select * from scores where club_id = $1', [clubId]); // RLS: own rows only
    const { rows: prior } = await tx.query('select req_id, score from prior_scores where club_id = $1', [clubId]);
    const items = await getItems(tx, clubId);
    const { rows: names } = await tx.query(`select id, name from users where role in ('assessor','admin')`);
    const { rows: [lock] } = await tx.query('select locked_at from score_locks where club_id = $1 and phase = $2', [clubId, phase]);
    const phases = await getPhases(tx);
    const staffSlot = phase === 'staff' && mySlots.length > 0;
    const staffRows = staffSlot ? await getStaff(tx, clubId) : [];
    return {
      club, reqs, mySlots, items, phase: phases.find((p) => p.id === phase), lock: lock?.locked_at,
      crit: Object.fromEntries(crit.map((c) => [c.req_id, c])),
      mine: Object.fromEntries(scores.filter((s) => s.assessor_id === req.user.id && s.slot !== 'third').map((s) => [s.req_id, s])),
      prior: Object.fromEntries(prior.map((p) => [p.req_id, num(p.score)])),
      files: await getFiles(tx, clubId), names: Object.fromEntries(names.map((n) => [n.id, n.name])),
      staff: staffRows,
      suggest: staffSlot ? suggestStaffScores(staffRows) : {},
    };
  });

  r.get('/club/:id', async (req, res) => {
    const clubId = Number(req.params.id);
    const phases = await req.db((tx) => getPhases(tx));
    let phase = req.query.phase;
    const d0 = phase ? null : await req.db(async (tx) => (await tx.query(
      `select q.section from slots s join requirements q on q.id = s.req_id where s.club_id = $1 order by q.sort limit 1`, [clubId])).rows[0]);
    phase ??= d0?.section ?? 'planning';
    const d = await loadWork(req, clubId, phase);
    if (!d || !d.mySlots.length) {
      return res.status(404).page('Not found', html`<h1>Nothing assigned</h1><p>You have no items for this club in ${sectionLabel(phase)}.</p><p><a href="/assessor">Back to my work</a></p>`, { active: '/assessor' });
    }
    const scoringOpen = !d.phase.submissionOpen && !d.phase.closed && !d.lock;
    const scored = d.reqs.filter((q) => d.mine[q.id]).length;
    res.page(d.club.name, html`
      <p><a href="/assessor">&larr; My work</a></p>
      <div class="row"><div><h1>${d.club.name}</h1>
        <p class="sub">${sectionLabel(phase)} · Pool ${d.club.pool} · current shield ${d.club.current_shield} · ${d.reqs.length} item(s) assigned to you</p></div>
        <span class="spacer"></span>
        <div class="card" style="margin:0"><div class="small muted">My scoring</div>
          <div><strong>${scored}</strong> of ${d.reqs.length} scored</div>
          ${d.lock ? html`<span class="badge b-done">&#10003; Locked ${fmtDate(d.lock)}</span>`
            : d.phase.submissionOpen ? html`<span class="small muted">Scoring opens after ${fmtDay(d.phase.deadline)}</span>`
            : html`<form method="post" action="/assessor/club/${d.club.id}/lock" onsubmit="return confirm('Lock in your ${sectionLabel(phase)} scores for this club? You will not be able to change them.')">
              <input type="hidden" name="phase" value="${phase}"><button class="small" ${scored < d.reqs.length ? 'disabled' : ''}>Lock in ${sectionLabel(phase)}</button></form>`}</div>
      </div>
      <div class="notice small">Blind scoring: you see only your own marks. Mark each criterion Yes, Partial or No; the score is calculated
        as criteria met (partial = ${framework.scoring?.partialValue ?? 0.5}) out of the total, times the item maximum. Once both assessors lock, any difference goes to a third assessor.</div>
      <div class="tabs">${phases.filter((p) => p.id).map((p) => html`<a href="/assessor/club/${d.club.id}?phase=${p.id}" class="${p.id === phase ? 'on' : ''}">${p.label}</a>`)}</div>
      ${phase === 'staff' && d.staff.length ? html`<h3>Staff table submitted by the club</h3>${staffTable({ staff: d.staff, files: d.files, clubId: d.club.id, canAct: true })}` : ''}
      ${d.reqs.map((q) => itemCard(q, d, scoringOpen))}
      ${scoringOpen ? html`<form id="scoreform" method="post" action="/assessor/club/${d.club.id}/scores" class="card noprint" style="position:sticky;bottom:0;display:flex;gap:12px;align-items:center;box-shadow:0 -2px 10px rgba(0,0,0,.06)">
        <input type="hidden" name="phase" value="${phase}">
        <span class="small muted">Saves every item on this page that is fully marked.</span><span class="spacer"></span>
        <button>Save my scores</button></form>` : ''}`, { active: '/assessor' });
  });

  r.post('/club/:id/scores', async (req, res) => {
    const clubId = Number(req.params.id);
    const phase = req.body.phase;
    const saved = [];
    const skipped = [];
    await req.db(async (tx) => {
      const { rows: mySlots } = await tx.query(
        `select s.req_id, s.slot, q.type, q.n_criteria from slots s join requirements q on q.id = s.req_id where s.club_id = $1 and q.section = $2`, [clubId, phase]);
      for (const m of mySlots) {
        const comment = String(req.body[`c_${m.req_id}`] ?? '').trim() || null;
        let ticks = null; let value = null; let score = 0;
        if (m.type === 'ticks') {
          ticks = Array.from({ length: m.n_criteria }, (_, i) => req.body[`t_${m.req_id}_${i}`]);
          if (ticks.every((t) => !t)) continue;
          if (ticks.some((t) => !['y', 'p', 'n'].includes(t))) { skipped.push(m.req_id); continue; }
        } else if (m.type === 'value') {
          if (req.body[`v_${m.req_id}`] === undefined || req.body[`v_${m.req_id}`] === '') continue;
          value = Number(req.body[`v_${m.req_id}`]);
        } else {
          if (req.body[`s_${m.req_id}`] === undefined || req.body[`s_${m.req_id}`] === '') continue;
          score = Math.round(Number(req.body[`s_${m.req_id}`]) * 10) / 10;
        }
        await tx.query(
          `insert into scores(club_id, req_id, slot, assessor_id, ticks, value, score, comment) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (club_id, req_id, slot) do update set ticks = excluded.ticks, value = excluded.value, score = excluded.score, comment = excluded.comment`,
          [clubId, m.req_id, m.slot, req.user.id, ticks ? JSON.stringify(ticks) : null, value, score, comment]);
        saved.push(m.req_id);
      }
    }, 'Assessor saved scores');
    const msg = `${saved.length} item(s) saved.${skipped.length ? ` Not saved, some criteria unmarked: ${skipped.join(', ')}.` : ''}`;
    res.redirect(`/assessor/club/${clubId}?phase=${encodeURIComponent(phase)}&msg=${encodeURIComponent(msg)}`);
  });

  r.post('/club/:id/lock', async (req, res) => {
    const clubId = Number(req.params.id);
    await req.db((tx) => tx.query('insert into score_locks(club_id, assessor_id, phase) values ($1,$2,$3)', [clubId, req.user.id, req.body.phase]), 'Assessor locked in scores');
    res.redirect(`/assessor?msg=${encodeURIComponent(`${sectionLabel(req.body.phase)} locked in. Items where both assessors agree are now final.`)}`);
  });

  // ---------------------------------------------------------------- third assessment
  const loadThird = (req) => req.db(async (tx) => {
    const clubId = Number(req.params.club);
    const { rows: [t] } = await tx.query('select * from third_assignments where club_id = $1 and req_id = $2', [clubId, req.params.req]);
    if (!t) return null;
    const club = await getClub(tx, clubId);
    const q = (await getReqs(tx)).find((x) => x.id === req.params.req);
    const { rows: [crit] } = await tx.query('select * from requirement_criteria where req_id = $1', [q.id]);
    // RLS returns first and second scores only because this person is the third assessor and both have locked.
    const { rows: scores } = await tx.query(
      `select x.*, u.name from scores x join users u on u.id = x.assessor_id where x.club_id = $1 and x.req_id = $2 order by x.slot`, [clubId, q.id]);
    const items = await getItems(tx, clubId);
    const allFiles = await getFiles(tx, clubId);
    const files = allFiles.filter((f) => f.req_id === q.id);
    const staff = q.section === 'staff' ? await getStaff(tx, clubId) : [];
    const { rows: [resn] } = await tx.query('select * from resolutions where club_id = $1 and req_id = $2', [clubId, q.id]);
    return { club, q, crit, scores, item: items[q.id], files, resn, staff, allFiles };
  });

  r.get('/third/:club/:req', async (req, res) => {
    const d = await loadThird(req);
    if (!d) return res.status(404).page('Not found', html`<h1>Not found</h1>`, { active: '/assessor' });
    const s = Object.fromEntries(d.scores.map((x) => [x.slot, x]));
    const criteria = d.crit.criteria ?? [];
    res.page('Third assessment', html`
      <p><a href="/assessor">&larr; My work</a></p>
      <h1>Third assessment: ${d.q.id} ${d.q.name}</h1>
      <p class="sub">${d.club.name} · max ${d.q.max_score} · weighting ${d.q.weight}. Read both assessors' comments, check the evidence, then mark the criteria yourself. Your score becomes the final score.</p>
      <div class="grid">${['first', 'second'].map((sl) => s[sl] ? html`<div class="card"><div class="small muted">${sl} assessor · ${s[sl].name}</div>
        <div class="stat">${scoreText(d.q, s[sl].score)}</div><div class="small">${s[sl].comment ?? html`<span class="muted">No comment</span>`}</div></div>` : '')}</div>
      ${criteria.length ? html`<h2>Criteria marks</h2><div class="tablewrap"><table class="cmp"><tr><th>#</th><th>Criterion</th><th>First</th><th>Second</th></tr>
        ${criteria.map((c, i) => {
          const a = s.first?.ticks?.[i]; const b = s.second?.ticks?.[i];
          return html`<tr><td>${i + 1}</td><td class="small">${c}</td><td class="${a} ${a !== b ? 'diff' : ''}">${TICK_LABEL[a] ?? ''}</td><td class="${b} ${a !== b ? 'diff' : ''}">${TICK_LABEL[b] ?? ''}</td></tr>`;
        })}</table></div>` : ''}
      <h2>Evidence</h2>
      ${d.q.section === 'staff' ? html`<div class="guid">${d.q.guidance}</div>${suggestStaffScores(d.staff)[d.q.id] ? suggestionBox(suggestStaffScores(d.staff)[d.q.id], d.q) : ''}${staffTable({ staff: d.staff, files: d.allFiles, clubId: d.club.id, canAct: false })}`
        : evidenceBlock({ q: d.q, it: d.item ?? { status: 'not_started' }, files: d.files, names: {}, clubId: d.club.id, canAct: false })}
      <details><summary>Descriptor</summary><div class="criteria">${d.crit.descriptor}</div></details>
      <h2>Your decision</h2>
      ${d.resn?.method === 'third' ? html`<div class="notice">Recorded final score <strong>${fmtNum(d.resn.final_score)}</strong> on ${fmtDate(d.resn.resolved_at)}.</div>` : ''}
      <form method="post" class="card">
        ${scoreInputs(d.q, d.crit, s.third, true, '')}
        <p><label>Reason for the final score (required)<br><textarea name="c_${d.q.id}" required>${s.third?.comment ?? ''}</textarea></label></p>
        <button>${s.third ? 'Update decision' : 'Record decision'}</button></form>`, { active: '/assessor' });
  });

  r.post('/third/:club/:req', async (req, res) => {
    const id = req.params.req;
    const comment = String(req.body[`c_${id}`] ?? '').trim();
    if (!comment) throw new Error('A reason is required.');
    await req.db(async (tx) => {
      const { rows: [q] } = await tx.query('select * from requirements where id = $1', [id]);
      let ticks = null; let value = null; let score = 0;
      if (q.type === 'ticks') {
        ticks = Array.from({ length: q.n_criteria }, (_, i) => req.body[`t_${id}_${i}`]);
        if (ticks.some((t) => !['y', 'p', 'n'].includes(t))) throw new Error('Mark every criterion Yes, Partial or No.');
      } else if (q.type === 'value') value = Number(req.body[`v_${id}`]);
      else score = Math.round(Number(req.body[`s_${id}`]) * 10) / 10;
      await tx.query(
        `insert into scores(club_id, req_id, slot, assessor_id, ticks, value, score, comment) values ($1,$2,'third',$3,$4,$5,$6,$7)
         on conflict (club_id, req_id, slot) do update set ticks = excluded.ticks, value = excluded.value, score = excluded.score, comment = excluded.comment`,
        [Number(req.params.club), id, req.user.id, ticks ? JSON.stringify(ticks) : null, value, score, comment]);
    }, comment);
    res.redirect(`/assessor/third/${req.params.club}/${id}?msg=${encodeURIComponent('Decision recorded. This is now the final score.')}`);
  });

  // ---------------------------------------------------------------- lead (CDA) page
  r.get('/lead/:club', async (req, res) => {
    const clubId = Number(req.params.club);
    const d = await req.db(async (tx) => {
      const { rows: [l] } = await tx.query('select 1 from club_leads where club_id = $1', [clubId]);
      if (!l) return null;
      const club = await getClub(tx, clubId);
      const reqs = await getReqs(tx);
      const items = await getItems(tx, clubId);
      const staff = await getStaff(tx, clubId);
      // Leads see final (resolved) scores only. Individual blind scores are not visible to them.
      const { rows: res } = await tx.query(
        `select r.req_id, r.final_score, item_applies($1, q.id) applies, q.section from requirements q
         left join resolutions r on r.club_id = $1 and r.req_id = q.id`, [clubId]);
      const { rows: cm } = await tx.query('select * from lead_comments where club_id = $1', [clubId]);
      const { rows: [released] } = await tx.query('select released_for($1) r', [clubId]);
      const all = res.filter((x) => x.applies).every((x) => x.final_score !== null);
      const result = all ? await clubResult(tx, club, reqs, items) : null;
      const { rows: hl } = await tx.query('select kind, items from lead_highlights where club_id = $1', [clubId]);
      return { club, reqs, items, staff, res, comments: Object.fromEntries(cm.map((c) => [c.section, c])), phases: await getPhases(tx), released: released.r,
        result, picks: Object.fromEntries(hl.map((h) => [h.kind, h.items])) };
    });
    if (!d) return res.status(404).page('Not found', html`<h1>Not your club</h1>`, { active: '/assessor' });
    const prog = submissionProgress(d.reqs, d.club, d.items, d.staff);
    const sectionDone = (s) => d.res.filter((x) => x.applies && (s === 'overall' || x.section === s)).every((x) => x.final_score !== null);
    const resBy = Object.fromEntries(d.res.map((x) => [x.req_id, x]));
    res.page(`Lead: ${d.club.name}`, html`
      <p><a href="/assessor">&larr; My work</a></p>
      <h1>${d.club.name}</h1>
      <p class="sub">You are this club's lead. You see submission progress and final scores once each section is reconciled. Individual assessors' scores are never shown to you. Your comments are hidden from the club until results are released.</p>
      ${d.phases.map((p) => {
        const pr = prog[p.id];
        const done = sectionDone(p.id);
        const lines = d.reqs.filter((q) => q.section === p.id && resBy[q.id]?.applies);
        return html`<div class="card">
          <div class="row"><strong>${p.label}</strong>${done ? html`<span class="badge b-done">Reconciled</span>` : html`<span class="badge b-muted">In progress</span>`}<span class="spacer"></span>
            <span class="small muted">${pr ? `${pr.approved} approved · ${pr.submitted} awaiting review of ${pr.total}` : ''}</span></div>
          ${pr ? progressBar(pr.approved, pr.submitted, pr.total) : ''}
          ${done ? html`<details><summary>Final scores (${lines.length} items)</summary><div class="tablewrap"><table>
              <tr><th>Item</th><th>Line item</th><th class="num">Final</th></tr>
              ${lines.map((q) => html`<tr><td>${q.id}</td><td>${q.name}</td><td class="num">${q.type === 'threshold' || q.type === 'yesno' ? scoreText(q, resBy[q.id].final_score) : `${fmtNum(resBy[q.id].final_score)} / ${q.max_score}`}</td></tr>`)}
            </table></div></details>` : html`<p class="small muted">Final scores and feedback open once every item in this section is reconciled.</p>`}
          ${commentForm(d, p.id, done)}
        </div>`;
      })}
      <div class="card"><strong>Overall comment</strong>${commentForm(d, 'overall', sectionDone('overall'))}</div>
      ${d.result ? highlightsForm(d) : html`<div class="card"><strong>Top 5 strengths and areas to improve</strong><p class="small muted">Opens once every section is reconciled.</p></div>`}`, { active: '/assessor' });
  });

  r.post('/lead/:club/highlights', async (req, res) => {
    const kind = req.body.kind === 'improve' ? 'improve' : 'strengths';
    const picked = [].concat(req.body.items ?? []).map(String);
    if (req.body.reset !== '1' && (picked.length < 1 || picked.length > 5)) throw new Error('Choose between one and five items.');
    await req.db((tx) => (req.body.reset === '1'
      ? tx.query('delete from lead_highlights where club_id = $1 and kind = $2', [Number(req.params.club), kind])
      : tx.query(`insert into lead_highlights(club_id, kind, items, updated_by) values ($1,$2,$3,$4)
          on conflict (club_id, kind) do update set items = excluded.items, updated_by = excluded.updated_by, updated_at = now()`,
        [Number(req.params.club), kind, picked, req.user.id])), 'Lead top 5 selection');
    res.redirect(`/assessor/lead/${req.params.club}?msg=${encodeURIComponent(req.body.reset === '1' ? 'Using the suggested list.' : 'Your list is saved.')}#highlights`);
  });

  r.post('/lead/:club/comment', async (req, res) => {
    const section = req.body.section;
    if (!COMMENT_SECTIONS.includes(section)) throw new Error('Unknown section');
    await req.db((tx) => tx.query(
      `insert into lead_comments(club_id, section, body) values ($1,$2,$3)
       on conflict (club_id, section) do update set body = excluded.body`, [Number(req.params.club), section, String(req.body.body ?? '').trim()]), 'Lead comment');
    res.redirect(`/assessor/lead/${req.params.club}?msg=${encodeURIComponent(`${sectionLabel(section)} comment saved.`)}`);
  });

  return r;
}

// Lead chooses the top 5 lists shown on the club's report; suggestions are preselected.
function highlightsForm(d) {
  const lines = d.result.lines.filter((l) => l.score !== null && l.source !== 'carried forward');
  const block = (kind, title, hint) => {
    const own = d.picks[kind];
    const chosen = new Set(own ?? d.result.suggested[kind].map((l) => l.id));
    return html`<div class="card"><div class="row"><strong>${title}</strong>
      ${own ? html`<span class="badge b-submitted">Your choice</span>` : html`<span class="badge b-muted">Suggested</span>`}</div>
      <p class="small muted">${hint} Choose up to five.</p>
      ${d.released ? html`<ul>${[...chosen].map((id) => html`<li>${id} ${lines.find((l) => l.id === id)?.name ?? ''}</li>`)}</ul>` : html`
      <form method="post" action="/assessor/lead/${d.club.id}/highlights"><input type="hidden" name="kind" value="${kind}">
        <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 10px">
        ${lines.map((l) => html`<label class="small" style="display:block"><input type="checkbox" name="items" value="${l.id}" ${chosen.has(l.id) ? 'checked' : ''}>
          ${l.id} ${l.name} <span class="muted">· ${fmtNum(l.score)}/${l.max_score} · ${fmtNum(l.missed)} pts missed</span></label>`)}</div>
        <div class="row" style="margin-top:6px"><button class="small">Save my list</button>
          ${own ? html`<button class="small secondary" name="reset" value="1" formnovalidate>Use suggested list</button>` : ''}</div></form>`}</div>`;
  };
  return html`<h2 id="highlights">Top 5 lists for the report</h2>
    ${block('strengths', 'Top 5 strengths', 'Suggested: items at full marks, highest weighting first.')}
    ${block('improve', 'Top 5 areas to improve', 'Suggested: items with the most points missed.')}`;
}

function commentForm(d, section, ready) {
  const c = d.comments[section];
  if (d.released) return c ? html`<div class="lead-comment">${c.body}</div>` : '';
  if (!ready) return c ? html`<div class="lead-comment">${c.body}</div>` : html`<p class="small muted">Opens once ${section === 'overall' ? 'every section' : 'this section'} is reconciled.</p>`;
  return html`<form method="post" action="/assessor/lead/${d.club.id}/comment" style="margin-top:8px">
    <input type="hidden" name="section" value="${section}">
    <textarea name="body" required placeholder="Feedback for the club on ${sectionLabel(section)}">${c?.body ?? ''}</textarea>
    <div class="row"><button class="small">${c ? 'Update comment' : 'Save comment'}</button>
    ${c ? html`<span class="small muted">Saved ${fmtDate(c.updated_at)}</span>` : ''}</div></form>`;
}

// Inputs for one item, by scoring type. `form` attribute lets them live outside the form element.
export function suggestionBox(sg, q) {
  return html`<div class="notice small"><strong>Suggested from the staff table: ${sg.score === null ? 'needs checking' : `${sg.score} / ${q.max_score}`}</strong>
    ${sg.check ? html` <span class="badge b-warn">Check</span>` : ''}
    <ul style="margin:4px 0 0 18px;padding:0">${sg.notes.map((n) => html`<li>${n}</li>`)}</ul>
    <div class="muted">Confirm or adjust. Apply the judgement rules (for example "Other" qualifications, two roles in the same phase) yourself.</div></div>`;
}

function scoreInputs(q, crit, mine, enabled, formId = 'scoreform', suggested = null) {
  const f = formId ? `form="${formId}"` : '';
  const dis = enabled ? '' : 'disabled';
  if (q.type === 'ticks') {
    const ticks = mine?.ticks ?? [];
    return html`<div class="ticks">${(crit.criteria ?? []).map((c, i) => html`<div class="tick"><div>${i + 1}. ${c}</div><div class="opts">
      ${['y', 'p', 'n'].map((v) => html`<label><input type="radio" name="t_${q.id}_${i}" value="${v}" ${ticks[i] === v ? 'checked' : ''} ${raw(f)} ${dis}><span>${TICK_LABEL[v]}</span></label>`)}
      </div></div>`)}</div>`;
  }
  if (q.type === 'value') {
    return html`<label class="small">Measured value (${q.unit})<br><input type="number" step="0.1" name="v_${q.id}" value="${mine?.value ?? ''}" ${raw(f)} ${dis}></label>
      <div class="small muted">Bands: ${(crit.bands ?? []).map((b) => `${b.min}+ = ${b.score}`).join(' · ')}</div>`;
  }
  if (q.type === 'threshold') {
    return html`<label class="small">Shield threshold outcome<br><select name="s_${q.id}" ${raw(f)} ${dis}><option value=""></option>
      ${(framework.thresholdOutcomes ?? []).map((o) => html`<option value="${o.code}" ${mine && num(mine.score) === Number(o.code) ? 'selected' : ''}>${o.label}</option>`)}</select></label>
      <div class="small muted">${framework.thresholdRule?.description ?? ''}</div>`;
  }
  if (q.type === 'yesno') {
    return html`<label class="small">Outcome<br><select name="s_${q.id}" ${raw(f)} ${dis}><option value=""></option>
      <option value="1" ${mine && num(mine.score) === 1 ? 'selected' : ''}>Met</option><option value="0" ${mine && num(mine.score) === 0 ? 'selected' : ''}>Not met</option></select></label>`;
  }
  const val = mine ? num(mine.score) : (enabled && suggested !== null && suggested !== undefined ? suggested : '');
  return html`<label class="small">Score (0-${q.max_score})${!mine && val !== '' ? ' · prefilled with the suggestion' : ''}<br><input type="number" min="0" max="${q.max_score}" step="0.1" name="s_${q.id}" value="${val}" ${raw(f)} ${dis}></label>`;
}

function itemCard(q, d, scoringOpen) {
  const it = d.items[q.id] ?? { status: 'not_started' };
  const mine = d.mine[q.id];
  const crit = d.crit[q.id] ?? {};
  return html`<div class="card" id="${q.id}">
    <div class="row"><span class="code" style="font-weight:700;color:var(--brand)">${q.id}</span><strong>${q.name}</strong>
      <span class="spacer"></span>
      ${d.prior[q.id] !== undefined ? html`<span class="small muted">Last cycle: ${fmtNum(d.prior[q.id])}</span>` : ''}
      ${mine ? html`<span class="badge b-done">My score ${q.type === 'threshold' || q.type === 'yesno' ? scoreText(q, mine.score) : `${fmtNum(mine.score)} / ${q.max_score}`}</span>` : html`<span class="badge b-muted">Not scored</span>`}</div>
    ${q.kind !== 'staff' ? evidenceBlock({ q, it, files: d.files.filter((f) => f.req_id === q.id), names: d.names, clubId: d.club.id, canAct: !d.phase.closed }) : html`<div class="guid">${q.guidance}</div>`}
    ${d.suggest?.[q.id] ? suggestionBox(d.suggest[q.id], q) : ''}
    <details><summary>Descriptor</summary><div class="criteria">${crit.descriptor}</div></details>
    ${scoringOpen || mine ? html`${scoreInputs(q, crit, mine, scoringOpen, 'scoreform', d.suggest?.[q.id]?.score)}
      <label class="small">My comment<br><textarea name="c_${q.id}" form="scoreform" ${scoringOpen ? '' : 'disabled'} style="min-height:40px">${mine?.comment ?? ''}</textarea></label>`
      : html`<p class="small muted">Scoring opens after the submission deadline (${fmtDay(d.phase.deadline)}).</p>`}
  </div>`;
}
