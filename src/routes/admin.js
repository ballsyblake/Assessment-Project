import express from 'express';
import { sys } from '../db.js';
import { html, progressBar, fmtDate, fmtNum, fmtDay, TICK_LABEL } from '../html.js';
import { sectionLabel, framework } from '../catalog.js';
import {
  getReqs, getClub, getItems, getFiles, getStaff, getPhases, getSettings, submissionProgress, sumProgress,
  scoringStatus, reconciliation, clubResult, leaderboard, assessorStats, republish,
} from '../model.js';
import { evidenceBlock, staffTable } from './review.js';
import { suggestStaffScores, staffTotal } from '../staffCalc.js';
import crypto from 'node:crypto';
import { onedriveConfigured, readConnection, isConnected, authorizeUrl, completeSignIn, disconnect, redirectUri, saveFile, readFile, removeFiles } from '../storage.js';
import { resultsView } from './club.js';
import { issueLink } from '../auth.js';
import { sendMail } from '../mail.js';
import { THRESHOLDS, scoreText, thresholdLabel } from '../scoring.js';

const back = (res, path, msg) => res.redirect(`${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);
const PHASE_IDS = framework.phases.map((p) => p.id);
const COMMENT_SECTIONS = [...PHASE_IDS, 'overall'];
const STATE = {
  resolved: ['b-done', 'Final'], disputed: ['b-bad', 'Scores differ: needs third assessor'], third: ['b-submitted', 'With third assessor'],
  scoring: ['b-muted', 'Scoring in progress'], unassigned: ['b-warn', 'Not assigned'],
};
const METHOD = { agreed: 'Both agreed', single: 'Single assessor', third: 'Third assessor', admin: 'Admin override', review: 'Changed after review' };
const scoreField = (x) => (x.type === 'threshold' ? html`<select name="score" required><option value="">Outcome...</option>${(framework.thresholdOutcomes ?? []).map((o) => html`<option value="${o.code}">${o.label}</option>`)}</select>`
  : x.type === 'yesno' ? html`<select name="score" required><option value="1">Met</option><option value="0">Not met</option></select>`
  : html`<input type="number" name="score" step="0.1" min="0" max="${x.max_score}" required placeholder="Score" style="width:72px">`);

// Calculated staff qualification breakdown from the club's staff table (suggestions, not final scores).
function staffSummary(staff, reqs) {
  const sg = suggestStaffScores(staff);
  const items = reqs.filter((q) => q.section === 'staff');
  const total = staffTotal(sg, reqs);
  const max = items.reduce((t, q) => t + q.max_score * q.weight, 0);
  return html`<h3>Calculated from the staff table</h3>
    <p class="small muted">Suggested scores using FQ's lookup tables and the automatic rules. Assessors confirm each item; final scores come from them.</p>
    <div class="tablewrap"><table><tr><th>Item</th><th>Position</th><th class="num">Suggested</th><th class="num">Weighting</th><th class="num">Points</th><th>Working</th></tr>
      ${items.map((q) => { const x = sg[q.id] ?? { score: null, notes: [] }; return html`<tr><td>${q.id}</td><td>${q.name}</td>
        <td class="num">${x.score === null ? html`<span class="badge b-warn">Check</span>` : `${x.score} / ${q.max_score}`}</td><td class="num">${q.weight}</td>
        <td class="num">${x.score === null ? '–' : fmtNum(x.score * q.weight)}</td><td class="small">${x.notes.join('; ')}</td></tr>`; })}
      <tr class="total"><td colspan="4"><strong>Calculated total</strong></td><td class="num" style="white-space:nowrap"><strong>${fmtNum(total)} / ${max}</strong></td><td></td></tr>
    </table></div>`;
}

export default function adminRoutes() {
  const r = express.Router();

  const overview = (tx) => (async () => {
    const reqs = await getReqs(tx);
    const phases = await getPhases(tx);
    const clubs = (await tx.query(`select c.*, u.name lead from clubs c left join club_leads l on l.club_id = c.id left join users u on u.id = l.lead_id order by c.name`)).rows;
    const status = await scoringStatus(tx);
    const list = [];
    for (const c of clubs) {
      const items = await getItems(tx, c.id);
      const staff = await getStaff(tx, c.id);
      list.push({ club: c, items, prog: sumProgress(submissionProgress(reqs, c, items, staff)), status: status[c.id] ?? {} });
    }
    return { reqs, phases, list };
  })();

  // ---------------------------------------------------------------- overview
  r.get('/', async (req, res) => {
    const d = await req.db((tx) => overview(tx));
    const cell = (s, p) => {
      if (!s || !s.applicable) return html`<span class="muted small">–</span>`;
      const pct = (s.resolved / s.applicable) * 100;
      return html`<div class="small"><strong>${s.resolved}</strong>/${s.applicable} final</div>
        <div class="progress" style="margin:2px 0"><span class="p-approved" style="width:${pct.toFixed(0)}%"></span><span class="p-submitted" style="width:${(((s.locked - s.resolved) / s.applicable) * 100).toFixed(0)}%"></span></div>
        ${s.unassigned ? html`<span class="badge b-warn">${s.unassigned} unassigned</span> ` : ''}
        ${s.disputed ? html`<span class="badge b-bad">${s.disputed} differ</span> ` : ''}
        ${s.with_third ? html`<span class="badge b-submitted">${s.with_third} third</span> ` : ''}
        ${s.tick_mismatch ? html`<span class="badge b-warn" title="Same score, different criteria marks">${s.tick_mismatch} tick diff</span>` : ''}
        ${p.closed ? '' : ''}`;
    };
    res.page('Overview', html`
      <h1>Overview</h1>
      <p class="sub">Every club: submission progress and scoring progress by phase. Final = both assessors locked and agreed, or decided by a third assessor.</p>
      <div class="row small" style="margin-bottom:10px">${d.phases.map((p) => html`<span><strong>${p.label}</strong>
        ${p.closed ? html`<span class="badge b-done">Closed</span>` : p.submissionOpen ? html`<span class="badge b-submitted">Submissions due ${fmtDay(p.deadline)}</span>` : html`<span class="badge b-warn">Scoring</span>`}</span>`)}</div>
      <div class="tablewrap"><table>
        <tr><th>Club</th><th>Submission</th>${d.phases.map((p) => html`<th>${p.label}</th>`)}<th></th></tr>
        ${d.list.map((s) => html`<tr>
          <td><strong>${s.club.name}</strong><br><span class="small muted">Pool ${s.club.pool}, ${s.club.current_shield}<br>Lead: ${s.club.lead ?? 'none'}</span></td>
          <td style="min-width:150px">${progressBar(s.prog.approved, s.prog.submitted, s.prog.total)}
            <span class="small muted">${s.prog.approved} approved, ${s.prog.submitted} submitted / ${s.prog.total}</span></td>
          ${d.phases.map((p) => html`<td style="min-width:120px">${cell(s.status[p.id], p)}</td>`)}
          <td><a class="btn small secondary" href="/admin/club/${s.club.id}">Evidence</a>
            <a class="btn small" href="/admin/reconcile/${s.club.id}">Reconcile</a></td>
        </tr>`)}
      </table></div>
      <div class="card"><h2 style="margin-top:0">Add a club</h2>
        <form method="post" action="/admin/clubs" class="inline">
          <input name="name" placeholder="Club name" required>
          <select name="pool"><option>A</option><option selected>B</option><option>C</option></select>
          <select name="shield">${['None', 'Development Committed', 'Bronze', 'Silver', 'Gold'].map((s) => html`<option>${s}</option>`)}</select>
          <input name="contact" placeholder="Primary contact name" required><input type="email" name="email" placeholder="Contact email" required>
          <button>Create club and email link</button></form></div>`);
  });

  r.post('/clubs', async (req, res) => {
    const uid = await req.db(async (tx) => {
      const { rows: [c] } = await tx.query('insert into clubs(name, pool, current_shield) values ($1,$2,$3) returning id',
        [String(req.body.name).trim(), req.body.pool, req.body.shield]);
      const partial = framework.partialPlanning?.pools.includes(req.body.pool);
      for (const q of (await getReqs(tx)).filter((x) => x.section !== 'staff')) {
        await tx.query('insert into club_items(club_id, req_id, selected) values ($1,$2,$3)', [c.id, q.id, !q.optional || !partial]);
      }
      return (await tx.query(`insert into users(email, name, role, club_id, is_primary) values ($1,$2,'club',$3,true) returning id`,
        [String(req.body.email).trim().toLowerCase(), String(req.body.contact).trim(), c.id])).rows[0].id;
    }, 'Admin created club');
    await issueLink(uid);
    back(res, '/admin', 'Club created and sign-in link emailed. Assign a lead and assessors next.');
  });

  // ---------------------------------------------------------------- evidence (read and verify; no scoring)
  r.get('/club/:id', async (req, res) => {
    const clubId = Number(req.params.id);
    const phase = req.query.phase ?? 'planning';
    const d = await req.db(async (tx) => ({
      club: await getClub(tx, clubId), reqs: (await getReqs(tx)).filter((q) => q.section === phase), items: await getItems(tx, clubId),
      files: await getFiles(tx, clubId), staff: phase === 'staff' ? await getStaff(tx, clubId) : [], phases: await getPhases(tx),
      names: Object.fromEntries((await tx.query('select id, name from users')).rows.map((u) => [u.id, u.name])),
      slots: (await tx.query('select * from slots where club_id = $1', [clubId])).rows,
      applies: Object.fromEntries((await tx.query('select id, item_applies($1, id) a from requirements', [clubId])).rows.map((x) => [x.id, x.a])),
    }));
    if (!d.club) return res.status(404).page('Not found', html`<h1>Not found</h1>`);
    res.page(d.club.name, html`
      <p><a href="/admin">&larr; Overview</a></p>
      <h1>${d.club.name}</h1><p class="sub">Admin view: evidence and verification. Admins do not score.</p>
      <div class="tabs">${d.phases.map((p) => html`<a href="/admin/club/${clubId}?phase=${p.id}" class="${p.id === phase ? 'on' : ''}">${p.label}</a>`)}</div>
      ${phase === 'staff' ? html`${staffTable({ staff: d.staff, files: d.files, clubId, canAct: true })}${staffSummary(d.staff, d.reqs)}` : ''}
      ${d.reqs.filter((q) => d.applies[q.id]).map((q) => {
        const sl = d.slots.filter((s) => s.req_id === q.id);
        return html`<div class="card" id="${q.id}"><div class="row"><span style="font-weight:700;color:var(--brand)">${q.id}</span><strong>${q.name}</strong><span class="spacer"></span>
          <span class="small muted">${sl.length ? sl.map((s) => `${s.slot}: ${d.names[s.assessor_id]}`).join(', ') : 'Not assigned'}</span></div>
          ${q.kind !== 'staff' ? evidenceBlock({ q, it: d.items[q.id] ?? { status: 'not_started' }, files: d.files.filter((f) => f.req_id === q.id), names: d.names, clubId, canAct: true, isAdmin: true }) : ''}</div>`;
      })}`, { active: '/admin' });
  });

  // ---------------------------------------------------------------- phases, deadlines, extensions
  r.get('/phases', async (req, res) => {
    const d = await req.db(async (tx) => ({
      phases: await getPhases(tx), status: await scoringStatus(tx),
      clubs: (await tx.query('select id, name from clubs order by name')).rows,
      ext: (await tx.query('select e.*, c.name club from extensions e join clubs c on c.id = e.club_id order by e.until desc')).rows,
    }));
    const totals = (pid) => Object.values(d.status).reduce((a, s) => ({ app: a.app + (s[pid]?.applicable ?? 0), res: a.res + (s[pid]?.resolved ?? 0) }), { app: 0, res: 0 });
    res.page('Phases', html`
      <h1>Phases</h1>
      <p class="sub">Each phase has a submission deadline. After it, club uploads lock unless you grant an extension or reopen an item.
        Close a phase once every item at every club is final: that unlocks its leaderboard for admins.</p>
      <div class="tablewrap"><table><tr><th>Phase</th><th>Submission deadline</th><th>Final items</th><th>Status</th><th></th></tr>
        ${d.phases.map((p) => {
          const t = totals(p.id);
          return html`<tr><td><strong>${p.label}</strong></td>
            <td><form method="post" action="/admin/phases/${p.id}" class="inline"><input type="date" name="deadline" value="${p.deadlineDay ?? ''}" ${p.closed ? 'disabled' : ''}>
              ${p.closed ? '' : html`<button class="small secondary">Save</button>`}</form></td>
            <td>${progressBar(t.res, 0, t.app)}<span class="small muted">${t.res} of ${t.app}</span></td>
            <td>${p.closed ? html`<span class="badge b-done">Closed ${fmtDate(p.closed_at)}</span>` : p.submissionOpen ? html`<span class="badge b-submitted">Submission period</span>` : html`<span class="badge b-warn">Scoring</span>`}</td>
            <td>${p.closed ? '' : html`<form method="post" action="/admin/phases/${p.id}/close" onsubmit="return confirm('Close ${p.label}? Scores in this phase become fixed.')">
              <button class="small" ${t.res < t.app || p.submissionOpen ? 'disabled' : ''}>Close phase</button></form>`}</td></tr>`;
        })}</table></div>
      <h2>Extensions</h2>
      <form method="post" action="/admin/extensions" class="card inline">
        <select name="club_id" required>${d.clubs.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
        <select name="phase">${d.phases.filter((p) => !p.closed).map((p) => html`<option value="${p.id}">${p.label}</option>`)}</select>
        <input type="date" name="until" required><button>Grant extension</button></form>
      <div class="tablewrap"><table><tr><th>Club</th><th>Phase</th><th>Until</th></tr>
        ${d.ext.map((e) => html`<tr><td>${e.club}</td><td>${sectionLabel(e.phase)}</td><td>${fmtDay(e.until)}</td></tr>`)}
        ${d.ext.length ? '' : html`<tr><td colspan="3" class="muted">None.</td></tr>`}</table></div>`);
  });

  r.post('/phases/:id', async (req, res) => {
    await req.db((tx) => tx.query('update phases set deadline = $2 where id = $1 and closed_at is null', [req.params.id, req.body.deadline || null]), 'Admin changed deadline');
    back(res, '/admin/phases', 'Deadline saved.');
  });
  r.post('/phases/:id/close', async (req, res) => {
    await req.db((tx) => tx.query('update phases set closed_at = now() where id = $1', [req.params.id]), 'Admin closed phase');
    back(res, '/admin/phases', `${sectionLabel(req.params.id)} closed. Its leaderboard is now available.`);
  });
  r.post('/extensions', async (req, res) => {
    await req.db((tx) => tx.query(
      `insert into extensions(club_id, phase, until, granted_by) values ($1,$2,$3,$4)
       on conflict (club_id, phase) do update set until = excluded.until, granted_by = excluded.granted_by`,
      [Number(req.body.club_id), req.body.phase, req.body.until, req.user.id]), 'Admin granted extension');
    back(res, '/admin/phases', 'Extension granted.');
  });

  // ---------------------------------------------------------------- assignment
  r.get('/assignments', async (req, res) => {
    const phase = req.query.phase ?? 'planning';
    const d = await req.db(async (tx) => ({
      phases: await getPhases(tx),
      clubs: (await tx.query(`select c.*, l.lead_id from clubs c left join club_leads l on l.club_id = c.id order by c.pool, c.name`)).rows,
      reqs: (await getReqs(tx)).filter((q) => q.section === phase),
      assessors: (await tx.query(`select id, name from users where role = 'assessor' and active order by name`)).rows,
      slots: (await tx.query('select s.* from slots s join requirements q on q.id = s.req_id where q.section = $1', [phase])).rows,
      applies: (await tx.query(`select c.id club_id, q.id req_id from clubs c cross join requirements q where q.section = $1 and item_applies(c.id, q.id)`, [phase])).rows,
      workload: (await tx.query(`select u.name, count(s.*) filter (where q.section = $1)::int phase, count(s.*)::int total
        from users u left join slots s on s.assessor_id = u.id left join requirements q on q.id = s.req_id
        where u.role = 'assessor' and u.active group by u.name order by u.name`, [phase])).rows,
    }));
    const initials = (id) => (d.assessors.find((a) => a.id === id)?.name ?? '?').split(' ').map((w) => w[0]).join('');
    const applies = new Set(d.applies.map((a) => `${a.club_id}:${a.req_id}`));
    const pools = [...new Set(d.clubs.map((c) => c.pool))];
    res.page('Assignments', html`
      <h1>Assignments</h1>
      <p class="sub">Each item at each club has its own first and second assessor (one for data-based items). There are no fixed pairs.
        The database blocks the same person holding both slots on an item.</p>
      <h2>Club leads</h2>
      <form method="post" action="/admin/leads" class="card"><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">
        ${d.clubs.map((c) => html`<label class="small">${c.name}<br><select name="lead_${c.id}"><option value="">(none)</option>
          ${d.assessors.map((a) => html`<option value="${a.id}" ${c.lead_id === a.id ? 'selected' : ''}>${a.name}</option>`)}</select></label>`)}
        </div><p><button class="small">Save leads</button></p></form>
      <div class="tabs">${d.phases.map((p) => html`<a href="/admin/assignments?phase=${p.id}" class="${p.id === phase ? 'on' : ''}">${p.label}</a>`)}</div>
      <h2>Bulk assign</h2>
      <form method="post" action="/admin/assignments/bulk" class="card">
        <input type="hidden" name="phase" value="${phase}">
        <div class="row">
          <label>Assessor<br><select name="assessor_id"><option value="">(clear slot)</option>${d.assessors.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
          <label>Slot<br><select name="slot"><option value="first">First</option><option value="second">Second</option></select></label>
          <span class="small muted">Tip: one item across a whole pool for evidence items; several items at one club for a club visit.</span>
        </div>
        <p class="small"><strong>Items</strong> <span class="muted">(select one or more)</span></p>
        <div class="row small">${d.reqs.map((q) => html`<label><input type="checkbox" name="items" value="${q.id}"> ${q.id}${q.assessors === 1 ? '*' : ''}</label>`)}</div>
        <p class="small"><strong>Clubs</strong> <span class="muted">or whole pools</span></p>
        <div class="row small">${pools.map((p) => html`<label><input type="checkbox" name="pools" value="${p}"> All Pool ${p}</label>`)}
          ${d.clubs.map((c) => html`<label><input type="checkbox" name="clubs" value="${c.id}"> ${c.name}</label>`)}</div>
        <p><button>Apply to selected</button> <span class="small muted">* data-based item: first slot only.</span></p>
      </form>
      <h2>${sectionLabel(phase)}: who holds each slot</h2>
      <div class="tablewrap"><table class="grid-assign"><tr><th>Club</th>${d.reqs.map((q) => html`<th title="${q.name}">${q.id}</th>`)}</tr>
        ${d.clubs.map((c) => html`<tr><td><strong>${c.name}</strong> <span class="muted">${c.pool}</span></td>${d.reqs.map((q) => {
          if (!applies.has(`${c.id}:${q.id}`)) return html`<td class="muted">n/a</td>`;
          const f = d.slots.find((s) => s.club_id === c.id && s.req_id === q.id && s.slot === 'first');
          const s2 = d.slots.find((s) => s.club_id === c.id && s.req_id === q.id && s.slot === 'second');
          const gap = !f || (q.assessors === 2 && !s2);
          const lead = (id) => (id === c.lead_id ? '★' : '');
          return html`<td class="${gap ? 'gap' : ''}" title="${f ? 'First' : ''}">${f ? initials(f.assessor_id) + lead(f.assessor_id) : '–'}${q.assessors === 2 ? html` / ${s2 ? initials(s2.assessor_id) + lead(s2.assessor_id) : '–'}` : ''}</td>`;
        })}</tr>`)}
      </table></div>
      <p class="small muted">First / second by initials. Red = slot missing. &#9733; = the club's own lead (allowed).</p>
      <h2>Workload</h2>
      <div class="tablewrap"><table><tr><th>Assessor</th><th class="num">${sectionLabel(phase)} slots</th><th class="num">All slots</th></tr>
        ${d.workload.map((w) => html`<tr><td>${w.name}</td><td class="num">${w.phase}</td><td class="num">${w.total}</td></tr>`)}</table></div>`);
  });

  const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  r.post('/assignments/bulk', async (req, res) => {
    const items = arr(req.body.items);
    const pools = arr(req.body.pools);
    const slot = req.body.slot === 'second' ? 'second' : 'first';
    const who = req.body.assessor_id ? Number(req.body.assessor_id) : null;
    if (!items.length) throw new Error('Select at least one item.');
    const result = await req.db(async (tx) => {
      const { rows: clubs } = await tx.query('select id from clubs where id = any($1::int[]) or pool = any($2::text[])', [arr(req.body.clubs).map(Number), pools]);
      if (!clubs.length) throw new Error('Select at least one club or pool.');
      let ok = 0; const errors = [];
      for (const c of clubs) {
        for (const id of items) {
          const { rows: [{ a }] } = await tx.query('select item_applies($1,$2) a', [c.id, id]);
          if (!a) continue;
          await tx.query('savepoint s');
          try {
            if (who) {
              await tx.query(`insert into slots(club_id, req_id, slot, assessor_id) values ($1,$2,$3,$4)
                on conflict (club_id, req_id, slot) do update set assessor_id = excluded.assessor_id, assigned_at = now()`, [c.id, id, slot, who]);
            } else {
              await tx.query('delete from slots where club_id = $1 and req_id = $2 and slot = $3', [c.id, id, slot]);
            }
            await tx.query('release savepoint s');
            ok++;
          } catch (e) {
            await tx.query('rollback to savepoint s');
            errors.push(String(e.message).replace(/^error: /i, ''));
          }
        }
      }
      return { ok, errors };
    }, 'Admin bulk assignment');
    const uniq = [...new Set(result.errors)];
    back(res, `/admin/assignments?phase=${req.body.phase}`, `${result.ok} slot(s) updated.${uniq.length ? ` ${result.errors.length} skipped: ${uniq.slice(0, 3).join('; ')}` : ''}`);
  });

  r.post('/leads', async (req, res) => {
    await req.db(async (tx) => {
      for (const [k, v] of Object.entries(req.body)) {
        if (!k.startsWith('lead_')) continue;
        const clubId = Number(k.slice(5));
        if (v) await tx.query('insert into club_leads(club_id, lead_id) values ($1,$2) on conflict (club_id) do update set lead_id = excluded.lead_id', [clubId, Number(v)]);
        else await tx.query('delete from club_leads where club_id = $1', [clubId]);
      }
    }, 'Admin set club leads');
    back(res, '/admin/assignments', 'Leads saved.');
  });

  // ---------------------------------------------------------------- reconciliation
  r.get('/reconcile', async (req, res) => {
    const d = await req.db((tx) => overview(tx));
    res.page('Reconciliation', html`
      <h1>Reconciliation</h1>
      <p class="sub">Any difference between first and second scores goes to a third assessor, whose score is final.
        Items where both scores match but the criteria marks differ are flagged for your attention.</p>
      <div class="tablewrap"><table><tr><th>Club</th>${d.phases.map((p) => html`<th>${p.label}</th>`)}</tr>
        ${d.list.map((s) => html`<tr><td><a href="/admin/reconcile/${s.club.id}"><strong>${s.club.name}</strong></a></td>
          ${d.phases.map((p) => {
            const x = s.status[p.id];
            if (!x?.applicable) return html`<td class="muted">–</td>`;
            const need = x.disputed;
            return html`<td><a href="/admin/reconcile/${s.club.id}?phase=${p.id}" style="text-decoration:none">
              ${x.resolved === x.applicable ? html`<span class="badge b-done">&#10003; ${x.resolved}/${x.applicable}</span>` : html`<span class="small">${x.resolved}/${x.applicable}</span>`}
              ${need ? html` <span class="badge b-bad">${need} need third</span>` : ''}
              ${x.with_third ? html` <span class="badge b-submitted">${x.with_third} with third</span>` : ''}
              ${x.tick_mismatch ? html` <span class="badge b-warn">${x.tick_mismatch} tick diff</span>` : ''}</a></td>`;
          })}</tr>`)}
      </table></div>`);
  });

  r.get('/reconcile/:club', async (req, res) => {
    const clubId = Number(req.params.club);
    const phase = req.query.phase ?? 'planning';
    const d = await req.db(async (tx) => ({
      club: await getClub(tx, clubId), rows: await reconciliation(tx, clubId, phase), phases: await getPhases(tx),
      result: (await tx.query('select released_at, confirmed_at from results where club_id = $1', [clubId])).rows[0] ?? null,
      criteria: Object.fromEntries((await tx.query('select req_id, criteria from requirement_criteria')).rows.map((c) => [c.req_id, c.criteria])),
      assessors: (await tx.query(`select id, name from users where role = 'assessor' and active order by name`)).rows,
    }), 'Admin reconciliation');
    if (!d.club) return res.status(404).page('Not found', html`<h1>Not found</h1>`);
    const ph = d.phases.find((p) => p.id === phase);
    const filter = req.query.f ?? 'action';
    const rows = d.rows.filter((x) => filter === 'all' || x.state === 'disputed' || x.state === 'third' || x.tick_mismatch || x.state === 'unassigned');
    const ticksTable = (x) => {
      const crit = d.criteria[x.id] ?? [];
      if (!crit.length || !x.sc.first?.ticks) return '';
      return html`<details><summary class="small">Criteria marks</summary><table class="cmp small"><tr><th>#</th><th>First</th><th>Second</th>${x.sc.third ? html`<th>Third</th>` : ''}</tr>
        ${crit.map((c, i) => {
          const a = x.sc.first?.ticks?.[i]; const b = x.sc.second?.ticks?.[i]; const t = x.sc.third?.ticks?.[i];
          return html`<tr title="${c}"><td>${i + 1}</td><td class="${a} ${a !== b ? 'diff' : ''}">${TICK_LABEL[a] ?? ''}</td><td class="${b} ${a !== b ? 'diff' : ''}">${TICK_LABEL[b] ?? ''}</td>${x.sc.third ? html`<td class="${t}">${TICK_LABEL[t] ?? ''}</td>` : ''}</tr>`;
        })}</table></details>`;
    };
    res.page('Reconcile', html`
      <p><a href="/admin/reconcile">&larr; Reconciliation</a></p>
      <div class="row"><div><h1>${d.club.name}</h1><p class="sub">${sectionLabel(phase)} ${ph.closed ? '· phase closed' : ''}</p></div>
        <span class="spacer"></span><a class="btn secondary" href="/admin/results/${clubId}">Preview result</a></div>
      <div class="tabs">${d.phases.map((p) => html`<a href="?phase=${p.id}&f=${filter}" class="${p.id === phase ? 'on' : ''}">${p.label}</a>`)}</div>
      <div class="tabs"><a href="?phase=${phase}&f=action" class="${filter === 'action' ? 'on' : ''}">Needs attention (${d.rows.filter((x) => x.state === 'disputed' || x.state === 'third' || x.tick_mismatch || x.state === 'unassigned').length})</a>
        <a href="?phase=${phase}&f=all" class="${filter === 'all' ? 'on' : ''}">All items (${d.rows.length})</a></div>
      <div class="tablewrap"><table>
        <tr><th>Item</th><th>Assessors</th><th class="num">First</th><th class="num">Second</th><th>State</th><th>Final</th><th style="min-width:300px">Action</th></tr>
        ${rows.map((x) => {
          const holders = x.holders ?? [];
          const eligible = d.assessors.filter((a) => !holders.some((h) => h.assessor_id === a.id));
          return html`<tr id="${x.id}">
          <td><strong>${x.id}</strong> ${x.name}<br><span class="small muted">max ${x.max_score}, x${x.weight}${x.assessors === 1 ? ', single assessor' : ''}</span></td>
          <td class="small">${holders.map((h) => html`${h.slot}: ${h.name} ${h.locked ? html`&#10003;` : html`<span class="muted">(open)</span>`}<br>`)}</td>
          <td class="num">${x.sc.first ? scoreText(x, x.sc.first.score) : '–'}${x.sc.first?.comment ? html`<div class="small muted" style="max-width:220px;text-align:left">${x.sc.first.comment}</div>` : ''}</td>
          <td class="num">${x.sc.second ? scoreText(x, x.sc.second.score) : '–'}${x.sc.second?.comment ? html`<div class="small muted" style="max-width:220px;text-align:left">${x.sc.second.comment}</div>` : ''}</td>
          <td><span class="badge ${STATE[x.state][0]}">${STATE[x.state][1]}</span>
            ${x.tick_mismatch ? html`<br><span class="badge b-warn">Same score, different criteria marks</span>` : ''}
            ${x.third_name ? html`<div class="small muted">Third: ${x.third_name}</div>` : ''}${ticksTable(x)}</td>
          <td>${x.final_score !== null ? html`<strong>${scoreText(x, x.final_score)}</strong><div class="small muted">${METHOD[x.method]}${x.resolver ? `, ${x.resolver}` : ''}</div>
            ${x.note && x.method !== 'agreed' && x.method !== 'single' ? html`<div class="small">${x.note}</div>` : ''}` : ''}</td>
          <td>${ph.closed ? (d.result?.released_at && !d.result?.confirmed_at && x.final_score !== null ? html`<form method="post" action="/admin/reconcile/${clubId}/${x.id}/override" class="inline">
              ${scoreField(x)}<input name="note" required placeholder="Review outcome (from email)" style="width:170px"><button class="small secondary">Apply review outcome</button></form>
              ${x.method === 'review' ? html`<div class="small muted">Changed after review from ${scoreText(x, x.review_from)}</div>` : ''}` : '') : html`
            ${(x.state === 'disputed' || x.state === 'third') ? html`<form method="post" action="/admin/reconcile/${clubId}/${x.id}/third" class="inline">
              <select name="assessor_id" required><option value="">Third assessor...</option>${eligible.map((a) => html`<option value="${a.id}" ${x.third_id === a.id ? 'selected' : ''}>${a.name}</option>`)}</select>
              <button class="small">${x.third_id ? 'Reassign' : 'Assign'}</button></form>` : ''}
            ${x.state !== 'scoring' && x.state !== 'unassigned' ? html`<form method="post" action="/admin/reconcile/${clubId}/${x.id}/override" class="inline">
              ${scoreField(x)}
              <input name="note" required placeholder="Reason for override" style="width:150px"><button class="small secondary">Override</button></form>` : ''}
            ${x.state === 'unassigned' ? html`<a class="small" href="/admin/assignments?phase=${phase}">Assign assessors</a>` : ''}`}</td>
        </tr>`;
        })}
        ${rows.length ? '' : html`<tr><td colspan="7" class="muted">Nothing needs attention in this phase.</td></tr>`}
      </table></div>`, { active: '/admin/reconcile' });
  });

  r.post('/reconcile/:club/:req/third', async (req, res) => {
    const clubId = Number(req.params.club);
    const who = Number(req.body.assessor_id);
    await req.db((tx) => tx.query(
      `insert into third_assignments(club_id, req_id, assessor_id, assigned_by) values ($1,$2,$3,$4)
       on conflict (club_id, req_id) do update set assessor_id = excluded.assessor_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
      [clubId, req.params.req, who, req.user.id]), 'Admin assigned third assessor');
    const { rows: [m] } = await sys().query('select email, name from users where id = $1', [who]);
    await sendMail(m.email, 'Third assessment request', `Hello ${m.name},\n\nYou have been asked to do a third assessment on item ${req.params.req}. Sign in and open "My work" to see it.`);
    const phase = (await sys().query('select section from requirements where id = $1', [req.params.req])).rows[0].section;
    back(res, `/admin/reconcile/${clubId}?phase=${phase}`, 'Third assessor assigned and notified.');
  });

  r.post('/reconcile/:club/:req/override', async (req, res) => {
    const clubId = Number(req.params.club);
    const note = String(req.body.note ?? '').trim();
    const republished = await req.db(async (tx) => {
      await tx.query(
        `insert into resolutions(club_id, req_id, final_score, method, note) values ($1,$2,$3,'admin',$4)
         on conflict (club_id, req_id) do update set final_score = excluded.final_score, method = 'admin', note = excluded.note`,
        [clubId, req.params.req, Math.round(Number(req.body.score) * 10) / 10, note]);
      return republish(tx, await getClub(tx, clubId));
    }, note);
    const phase = (await sys().query('select section from requirements where id = $1', [req.params.req])).rows[0].section;
    back(res, `/admin/reconcile/${clubId}?phase=${phase}&f=all`, republished
      ? `${req.params.req} changed. The club's preliminary result has been updated.` : `${req.params.req} overridden.`);
  });

  // ---------------------------------------------------------------- leaderboard (admin only)
  r.get('/leaderboard', async (req, res) => {
    const d = await req.db(async (tx) => {
      const phases = await getPhases(tx);
      const closed = phases.filter((p) => p.closed && p.id !== 'nn');
      const boards = [];
      for (const p of closed) boards.push({ phase: p, rows: await leaderboard(tx, [p.id]) });
      const all = phases.every((p) => p.closed) ? await leaderboard(tx, null) : null;
      return { phases, boards, all };
    });
    const table = (rows, sections) => html`<div class="tablewrap"><table>
      <tr><th class="num">Rank</th><th>Club</th><th>Pool</th>${sections.map((s) => html`<th class="num">${sectionLabel(s)}</th>`)}<th class="num">Points</th><th class="num">%</th></tr>
      ${rows.map((r2) => html`<tr><td class="num"><strong>${r2.rank}</strong></td><td>${r2.club.name}</td><td>${r2.club.pool}</td>
        ${sections.map((s) => html`<td class="num">${r2.bySection[s] ? `${fmtNum((r2.bySection[s].points / r2.bySection[s].max) * 100)}%` : '–'}</td>`)}
        <td class="num">${fmtNum(r2.total)} / ${fmtNum(r2.max)}</td><td class="num"><strong>${fmtNum(r2.pct)}%</strong></td></tr>`)}
    </table></div>`;
    const open = d.phases.filter((p) => !p.closed);
    res.page('Leaderboard', html`
      <h1>Leaderboard</h1>
      <p class="sub">Admin only. Assessors and leads never see rankings before release, so scoring is not anchored by them.
        A phase's ranking appears once you close it; the full ranking appears when every phase is closed.</p>
      ${d.all ? html`<h2>Full ranking</h2>${table(d.all, ['staff', 'planning', 'delivery', 'outcomes'])}` : ''}
      ${d.boards.map((b) => html`<h2>${b.phase.label}</h2><p class="small muted">Closed ${fmtDate(b.phase.closed_at)}</p>${table(b.rows, [])}`)}
      ${!d.boards.length ? html`<div class="card muted">No phase is closed yet.</div>` : ''}
      ${open.length ? html`<p class="small muted">Not yet available: ${open.map((p) => p.label).join(', ')}.</p>` : ''}`);
  });

  r.get('/assessors', async (req, res) => {
    const rows = await req.db((tx) => assessorStats(tx));
    res.page('Assessors', html`
      <h1>Assessor consistency</h1>
      <p class="sub">Admin only. Based on final items where the assessor was first or second. Bias compares the assessor's score with
        the final score on the same items, as a percentage of each item's maximum: positive means they tend to score higher than the final result.</p>
      <div class="tablewrap"><table><tr><th>Assessor</th><th class="num">Items scored</th><th class="num">Average score</th><th class="num">Bias vs final</th>
        <th class="num">Went to third assessor</th><th class="num">Tick differences</th></tr>
        ${rows.map((x) => html`<tr><td>${x.name}</td><td class="num">${x.scored}</td><td class="num">${fmtNum(x.avg_pct)}%</td>
          <td class="num ${Math.abs(Number(x.bias_pct)) >= 3 ? 'diff-hi' : ''}">${Number(x.bias_pct) > 0 ? '+' : ''}${fmtNum(x.bias_pct)}</td>
          <td class="num">${x.disputes} (${fmtNum((x.disputes / x.scored) * 100)}%)</td><td class="num">${x.tick_mismatch}</td></tr>`)}
        ${rows.length ? '' : html`<tr><td colspan="6" class="muted">No final items yet.</td></tr>`}</table></div>`);
  });

  r.get('/results/:club', async (req, res) => {
    const clubId = Number(req.params.club);
    const d = await req.db(async (tx) => {
      const club = await getClub(tx, clubId);
      const { rows: [released] } = await tx.query('select * from results where club_id = $1', [clubId]);
      if (released) return { club, result: released };
      const r2 = await clubResult(tx, club, await getReqs(tx), await getItems(tx, clubId));
      const comments = Object.fromEntries((await tx.query('select section, body from lead_comments where club_id = $1', [clubId])).rows.map((c) => [c.section, c.body]));
      return { club, result: { total: r2.total, max_total: r2.max, pct: r2.pct, rating: r2.rating, details: { ...r2, comments } } };
    });
    res.page('Result preview', resultsView(d.result, d.club, { preview: !d.result.released_at }), { active: '/admin/release' });
  });

  // ---------------------------------------------------------------- release
  const gate = (tx) => (async () => {
    const settings = await getSettings(tx);
    const phases = await getPhases(tx);
    const reqs = await getReqs(tx);
    const clubs = (await tx.query('select * from clubs order by name')).rows;
    const status = await scoringStatus(tx);
    const list = [];
    for (const c of clubs) {
      const { rows: cm } = await tx.query('select section from lead_comments where club_id = $1', [c.id]);
      const missingComments = COMMENT_SECTIONS.filter((s) => !cm.some((x) => x.section === s));
      const unresolved = Object.values(status[c.id] ?? {}).reduce((a, s) => a + (s.applicable - s.resolved), 0);
      const projected = unresolved ? null : await clubResult(tx, c, reqs, await getItems(tx, c.id));
      const confirmed = (await tx.query('select 1 from results where club_id = $1 and confirmed_at is not null', [c.id])).rowCount > 0;
      list.push({ club: c, missingComments, unresolved, projected, confirmed, ready: !missingComments.length && !unresolved });
    }
    const deadline = settings.internal_deadline;
    const pastDeadline = Boolean(deadline) && new Date(deadline) <= new Date();
    const openPhases = phases.filter((p) => !p.closed);
    const confirmedCount = (await tx.query('select count(*)::int n from results where confirmed_at is not null')).rows[0].n;
    return { settings, phases, reqs, list, deadline, pastDeadline, openPhases, confirmedCount, ok: pastDeadline && !openPhases.length && list.every((x) => x.ready) };
  })();

  r.get('/release', async (req, res) => {
    const g = await req.db((tx) => gate(tx));
    const released = g.settings.released_at;
    res.page('Release results', html`
      <h1>Release results</h1>
      <p class="sub">One action releases preliminary results and lead feedback to every club. Before that, the database blocks clubs from reading results or comments.</p>
      ${released ? html`<div class="notice"><strong>Preliminary results released ${fmtDate(released)}.</strong>
        Clubs have ${framework.review?.days ?? 8} days to request a review. Then confirm the ratings below.</div>
        <form method="post" action="/admin/release/confirm" class="card" onsubmit="return confirm('Confirm ratings now? Clubs with outstanding non-negotiable documents are skipped.')">
          <p class="small">Confirmed: ${g.confirmedCount} of ${g.list.length} clubs. A rating cannot be confirmed while the club has non-negotiable documents outstanding.</p>
          <button class="small" ${g.confirmedCount === g.list.length ? 'disabled' : ''}>Confirm ratings</button></form>` : ''}
      <div class="card"><dl class="kv">
        <dt>Internal deadline</dt><dd><form method="post" action="/admin/release/deadline" class="inline"><input type="date" name="deadline" value="${g.deadline ?? ''}" ${released ? 'disabled' : ''}>
          ${released ? '' : html`<button class="small secondary">Save</button>`}</form>
          ${g.pastDeadline ? html`<span class="badge b-approved">passed</span>` : html`<span class="badge b-warn">not reached</span>`}</dd>
        <dt>Phases</dt><dd>${g.openPhases.length ? html`<span class="badge b-warn">Open: ${g.openPhases.map((p) => p.label).join(', ')}</span>` : html`<span class="badge b-approved">All closed</span>`}</dd>
        <dt>Thresholds</dt><dd>${THRESHOLDS.map((t) => `${t.rating} ${t.min}%`).join(', ')}</dd></dl></div>
      <div class="tablewrap"><table><tr><th>Club</th><th>Scoring</th><th>Lead comments</th><th>Rating</th><th></th></tr>
        ${g.list.map((x) => html`<tr><td>${x.club.name}</td>
          <td>${x.unresolved ? html`<span class="badge b-bad">${x.unresolved} item(s) not final</span>` : html`<span class="badge b-approved">Complete</span>`}</td>
          <td>${x.missingComments.length ? html`<span class="badge b-warn">Missing: ${x.missingComments.map(sectionLabel).join(', ')}</span>` : html`<span class="badge b-approved">Complete</span>`}</td>
          <td style="min-width:300px">${x.projected ? html`<strong>${x.projected.rating}</strong> <span class="small muted">${Math.round(x.projected.pct)}%</span>
              ${x.projected.override ? html`<div class="small">Overridden (rule gives ${x.projected.ruleRating}): ${x.projected.override.reason}</div>`
                : x.projected.downgradeReasons.length ? html`<div class="small muted">Score gives ${x.projected.scoreRating}; lowered: ${x.projected.downgradeReasons.join('; ')}</div>` : ''}
              ${x.confirmed ? '' : html`<div><form method="post" action="/admin/rating-override/${x.club.id}" class="inline">
                <select name="rating" style="width:170px"><option value="">Use rule</option>${['Gold', 'Silver', 'Bronze', 'Development Committed', 'Not rated'].map((r2) => html`<option ${x.projected.override?.rating === r2 ? 'selected' : ''}>${r2}</option>`)}</select>
                <input name="reason" placeholder="Reason, shown to the club" style="width:170px"><button class="small secondary">Save</button></form></div>`}` : html`<span class="muted small">–</span>`}</td>
          <td><a class="btn small secondary" href="/admin/results/${x.club.id}">Preview</a></td></tr>`)}
      </table></div>
      ${released ? '' : html`<form method="post" action="/admin/release" class="card" onsubmit="return confirm('Release results to all clubs now? This cannot be undone.')">
        ${g.ok ? '' : html`<div class="warnbox">Release is blocked until the internal deadline has passed, every phase is closed, and every club's lead has written all section and overall comments.</div>`}
        <button ${g.ok ? '' : 'disabled'}>Release results to all clubs</button></form>`}`);
  });

  r.post('/rating-override/:club', async (req, res) => {
    const clubId = Number(req.params.club);
    const rating = String(req.body.rating ?? '');
    const reason = String(req.body.reason ?? '').trim();
    if (rating && !reason) throw new Error('Give a reason for overriding the rating.');
    await req.db(async (tx) => {
      if (rating) {
        await tx.query(`insert into rating_overrides(club_id, rating, reason, set_by) values ($1,$2,$3,$4)
          on conflict (club_id) do update set rating = excluded.rating, reason = excluded.reason, set_by = excluded.set_by, set_at = now()`, [clubId, rating, reason, req.user.id]);
      } else {
        await tx.query('delete from rating_overrides where club_id = $1', [clubId]);
      }
      await republish(tx, await getClub(tx, clubId));
    }, reason || 'Rating override removed');
    back(res, '/admin/release', rating ? 'Rating override saved.' : 'Override removed: the rule-based rating applies.');
  });

  r.post('/release/confirm', async (req, res) => {
    const out = await req.db(async (tx) => {
      const { rows } = await tx.query(`
        select r.club_id, c.name,
          exists (select 1 from club_items i join requirements q on q.id = i.req_id
                  where i.club_id = r.club_id and q.section = 'nn' and q.kind = 'document' and i.status not in ('approved','not_accepted')) outstanding
        from results r join clubs c on c.id = r.club_id where r.released_at is not null and r.confirmed_at is null`);
      const ok = rows.filter((x) => !x.outstanding);
      if (ok.length) await tx.query('update results set confirmed_at = now() where club_id = any($1::int[])', [ok.map((x) => x.club_id)]);
      return { confirmed: ok.length, skipped: rows.filter((x) => x.outstanding).map((x) => x.name) };
    }, 'Ratings confirmed');
    back(res, '/admin/release', `${out.confirmed} rating(s) confirmed.${out.skipped.length ? ` Not confirmed (non-negotiable documents outstanding): ${out.skipped.join(', ')}.` : ''}`);
  });

  r.post('/release/deadline', async (req, res) => {
    await req.db((tx) => tx.query(`update settings set value = $1 where key = 'internal_deadline'`, [req.body.deadline ?? '']), 'Admin changed release deadline');
    back(res, '/admin/release', 'Deadline saved.');
  });

  r.post('/release', async (req, res) => {
    const contacts = await req.db(async (tx) => {
      const g = await gate(tx);
      if (g.settings.released_at) throw new Error('Results have already been released.');
      if (!g.ok) throw new Error('Release is blocked: check the deadline, open phases and lead comments.');
      for (const x of g.list) {
        const items = await getItems(tx, x.club.id);
        const rr = await clubResult(tx, x.club, g.reqs, items);
        const comments = Object.fromEntries((await tx.query('select section, body from lead_comments where club_id = $1', [x.club.id])).rows.map((c) => [c.section, c.body]));
        await tx.query(`insert into results(club_id, total, max_total, pct, rating, nn_met, details, released_at) values ($1,$2,$3,$4,$5,$6,$7,now())
          on conflict (club_id) do update set total = excluded.total, max_total = excluded.max_total, pct = excluded.pct, rating = excluded.rating,
          nn_met = excluded.nn_met, details = excluded.details, released_at = excluded.released_at`,
        [x.club.id, rr.total, rr.max, rr.pct, rr.rating, rr.nnMet, JSON.stringify({ ...rr, comments })]);
      }
      await tx.query(`update settings set value = now()::text where key = 'released_at'`);
      return g.list.map((x) => x.club.id);
    }, 'Results released');
    const { rows } = await sys().query('select email, name from users where club_id = any($1::int[]) and active', [contacts]);
    for (const u of rows) await sendMail(u.email, 'Your club assessment results are available', `Hello ${u.name},\n\nFQ has released the club assessment results. Sign in with your personal link to view them.`);
    back(res, '/admin/release', 'Results released to all clubs.');
  });

  // ---------------------------------------------------------------- people
  r.get('/users', async (req, res) => {
    const users = await req.db(async (tx) => (await tx.query(
      `select u.*, c.name club from users u left join clubs c on c.id = u.club_id order by u.role, u.name`)).rows);
    const links = (await sys().query(
      `select user_id, max(created_at) issued, max(last_used_at) used from magic_links where revoked_at is null and expires_at > now() group by user_id`)).rows;
    const L = Object.fromEntries(links.map((l) => [l.user_id, l]));
    res.page('People', html`
      <h1>People</h1><p class="sub">Only pre-registered addresses can sign in. Issuing a new link cancels the person's previous link. Leads are assessor accounts linked to clubs on the Assignments page.</p>
      <div class="tablewrap"><table><tr><th>Name</th><th>Role</th><th>Email</th><th>Active link</th><th></th></tr>
        ${users.map((u) => html`<tr style="${u.active ? '' : 'opacity:.5'}"><td>${u.name}</td>
          <td>${u.role}${u.club ? html`<br><span class="small muted">${u.club}${u.is_primary ? ', primary' : ''}</span>` : ''}</td>
          <td class="mono">${u.email}</td>
          <td class="small">${L[u.id] ? html`issued ${fmtDate(L[u.id].issued)}${L[u.id].used ? html`<br>last used ${fmtDate(L[u.id].used)}` : ''}` : html`<span class="muted">none</span>`}</td>
          <td><form method="post" action="/admin/users/${u.id}/link" class="inline"><button class="small" ${u.active ? '' : 'disabled'}>Issue new link</button></form>
            ${u.id !== req.user.id ? html`<form method="post" action="/admin/users/${u.id}/active" class="inline"><input type="hidden" name="active" value="${u.active ? '0' : '1'}">
              <button class="small secondary">${u.active ? 'Deactivate' : 'Reactivate'}</button></form>` : ''}</td></tr>`)}
      </table></div>
      <div class="card"><h2 style="margin-top:0">Register an assessor or admin</h2>
        <form method="post" action="/admin/users" class="inline"><input name="name" placeholder="Full name" required>
          <input type="email" name="email" placeholder="Work email" required>
          <select name="role"><option value="assessor">Assessor</option><option value="admin">Admin</option></select>
          <button>Register and email link</button></form></div>`);
  });

  r.post('/users', async (req, res) => {
    if (!['assessor', 'admin'].includes(req.body.role)) throw new Error('Invalid role');
    const id = await req.db(async (tx) => (await tx.query(`insert into users(email, name, role) values ($1,$2,$3) returning id`,
      [String(req.body.email).trim().toLowerCase(), String(req.body.name).trim(), req.body.role])).rows[0].id, 'Admin registered user');
    await issueLink(id);
    back(res, '/admin/users', 'Registered and link emailed.');
  });

  r.post('/users/:id/link', async (req, res) => {
    const ok = await req.db(async (tx) => (await tx.query('select id from users where id = $1 and active', [Number(req.params.id)])).rowCount);
    if (!ok) throw new Error('User not found or inactive.');
    await issueLink(Number(req.params.id));
    back(res, '/admin/users', 'New link emailed. The previous link no longer works.');
  });

  r.post('/users/:id/active', async (req, res) => {
    await req.db((tx) => tx.query('update users set active = $2 where id = $1', [Number(req.params.id), req.body.active === '1']), 'Admin changed user status');
    if (req.body.active !== '1') {
      await sys().query('update magic_links set revoked_at = now() where user_id = $1 and revoked_at is null', [Number(req.params.id)]);
      await sys().query('delete from sessions where user_id = $1', [Number(req.params.id)]);
    }
    back(res, '/admin/users', 'Updated.');
  });

  // ---------------------------------------------------------------- storage (OneDrive)
  r.get('/storage', async (req, res) => {
    const counts = await req.db(async (tx) => (await tx.query('select storage, count(*)::int n from files group by storage')).rows);
    const n = Object.fromEntries(counts.map((c) => [c.storage, c.n]));
    const conn = readConnection();
    const access = process.env.ONEDRIVE_ACCESS === 'folder' ? 'folder' : 'appfolder';
    res.page('Storage', html`
      <h1>Document storage</h1>
      <p class="sub">Where clubs' uploaded evidence is kept. People always open documents through the platform, which checks who may see them.</p>
      <div class="card"><dl class="kv">
        <dt>New uploads go to</dt><dd><strong>${isConnected() ? 'OneDrive' : 'The platform database'}</strong></dd>
        <dt>Files in the database</dt><dd>${n.db ?? 0}</dd>
        <dt>Files in OneDrive</dt><dd>${n.onedrive ?? 0}</dd>
        ${conn ? html`<dt>Connected account</dt><dd>${conn.name} (${conn.account}), since ${fmtDate(conn.connectedAt)}</dd>
          <dt>Folder</dt><dd>${conn.access === 'folder' ? `OneDrive > ${process.env.ONEDRIVE_FOLDER ?? 'Club Assessment'}` : 'OneDrive > Apps > (the app’s own folder)'}</dd>` : ''}
      </dl></div>
      ${!onedriveConfigured() ? html`<div class="warnbox"><strong>OneDrive is not set up yet.</strong> Add the app registration details to the hosting environment variables, then reload this page.</div>
        <div class="card"><h2 style="margin-top:0">Set up (once)</h2><ol>
          <li>In the Azure portal, open <strong>Microsoft Entra ID</strong>, then <strong>App registrations</strong>, then <strong>New registration</strong>.
            Name it "Club Assessment Prototype", choose <em>Accounts in this organizational directory only</em>, and add a <em>Web</em> redirect URI:<br><code>${redirectUri()}</code></li>
          <li>On the app's <strong>Certificates &amp; secrets</strong> page, create a client secret and copy its value.</li>
          <li>On <strong>API permissions</strong>, add Microsoft Graph delegated permissions: <code>User.Read</code>, <code>offline_access</code> and
            <code>${access === 'folder' ? 'Files.ReadWrite' : 'Files.ReadWrite.AppFolder'}</code>.</li>
          <li>In the hosting service's variables, set <code>MS_CLIENT_ID</code> (Application ID), <code>MS_CLIENT_SECRET</code> (the secret value),
            <code>MS_TENANT</code> (Directory ID) and <code>SECRET_KEY</code> (any long random text).</li>
          <li>Reload this page and choose <strong>Connect OneDrive</strong>.</li></ol>
          <p class="small muted">If your organisation does not let staff register apps or approve permissions, ask IT to do steps 1 to 3.</p></div>`
      : !conn ? html`<div class="card"><p>Sign in with the Microsoft work account whose OneDrive should hold the documents.
          The platform only asks for ${access === 'folder' ? 'access to your files' : 'its own app folder in your OneDrive'}.</p>
          <a class="btn" href="/admin/storage/connect">Connect OneDrive</a></div>`
      : html`<div class="card row">
          <form method="post" action="/admin/storage/test"><button class="secondary">Test upload</button></form>
          ${n.db ? html`<form method="post" action="/admin/storage/migrate" onsubmit="return confirm('Copy ${n.db} file(s) from the database to OneDrive?')"><button>Move ${n.db} existing file(s) to OneDrive</button></form>` : ''}
          <span class="spacer"></span>
          <form method="post" action="/admin/storage/disconnect" onsubmit="return confirm('Disconnect OneDrive? New uploads will go to the database.')"><button class="secondary" ${n.onedrive ? 'disabled title="Files are stored in OneDrive"' : ''}>Disconnect</button></form></div>
        ${n.onedrive ? html`<p class="small muted">Disconnecting is disabled while files are stored in OneDrive; the platform needs the connection to open them.</p>` : ''}`}
      <p class="small muted">This prototype stores documents in one person's OneDrive. For real club data, use an FQ-owned SharePoint site: the platform's storage works the same way.</p>`);
  });

  r.get('/storage/connect', (req, res) => {
    if (!onedriveConfigured()) throw new Error('OneDrive is not set up yet.');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('cap_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: redirectUri().startsWith('https') });
    res.redirect(authorizeUrl(state));
  });

  r.get('/storage/callback', async (req, res) => {
    if (req.query.error) return back(res, '/admin/storage', `Microsoft sign-in was not completed: ${req.query.error_description ?? req.query.error}`);
    if (!req.query.state || req.query.state !== req.cookies.cap_oauth_state) throw new Error('Sign-in could not be verified. Start again from the Storage page.');
    res.clearCookie('cap_oauth_state');
    const conn = await completeSignIn(String(req.query.code));
    back(res, '/admin/storage', `OneDrive connected for ${conn.account}. New uploads will be stored there.`);
  });

  r.post('/storage/test', async (req, res) => {
    const st = await saveFile({ cycle: 'Test', club: 'Connection test', section: 'Test', item: 'Test', filename: `test-${Date.now()}.txt`, buffer: Buffer.from('Club Assessment storage test') });
    const back2 = await readFile({ storage: st.storage, storage_key: st.key, data: st.data });
    await removeFiles([{ storage: st.storage, storage_key: st.key }]);
    back(res, '/admin/storage', back2.toString() === 'Club Assessment storage test' ? 'Test passed: a file was written to OneDrive, read back and deleted.' : 'Test failed: the file read back did not match.');
  });

  r.post('/storage/migrate', async (req, res) => {
    const files = await req.db(async (tx) => (await tx.query(
      `select f.id, f.filename, f.data, c.name club, q.id req_id, q.name req_name, q.section, s.person
       from files f join clubs c on c.id = f.club_id left join requirements q on q.id = f.req_id left join staff_rows s on s.id = f.staff_row_id
       where f.storage = 'db' order by f.id`)).rows);
    let moved = 0;
    for (const f of files) {
      const st = await saveFile({ cycle: (String(framework.id).match(/\d{4}/) ?? [''])[0], club: f.club,
        section: f.req_id ? sectionLabel(f.section) : 'Staff Qualifications', item: f.req_id ? `${f.req_id} ${f.req_name}` : `Certificates - ${f.person}`,
        filename: f.filename, buffer: Buffer.from(f.data) });
      await req.db((tx) => tx.query(`update files set storage = $2, storage_key = $3, storage_url = $4, data = null where id = $1 and storage = 'db'`,
        [f.id, st.storage, st.key, st.url ?? null]), 'Moved file to OneDrive');
      moved++;
    }
    back(res, '/admin/storage', `${moved} file(s) moved to OneDrive.`);
  });

  r.post('/storage/disconnect', async (req, res) => {
    const n = await req.db(async (tx) => (await tx.query(`select count(*)::int n from files where storage = 'onedrive'`)).rows[0].n);
    if (n) throw new Error('Files are stored in OneDrive, so it cannot be disconnected.');
    disconnect();
    back(res, '/admin/storage', 'OneDrive disconnected. New uploads go to the database.');
  });

  // ---------------------------------------------------------------- audit
  r.get('/audit', async (req, res) => {
    const club = req.query.club ? Number(req.query.club) : null;
    const d = await req.db(async (tx) => ({
      rows: (await tx.query(
        `select a.*, u.name actor, c.name club from audit_log a left join users u on u.id = a.actor_id left join clubs c on c.id = a.club_id
         where ($1::int is null or a.club_id = $1) and a.table_name <> 'users' order by a.id desc limit 300`, [club])).rows,
      clubs: (await tx.query('select id, name from clubs order by name')).rows,
    }));
    const summary = (a) => {
      const x = a.detail ?? {};
      switch (a.table_name) {
        case 'club_items': return `status ${x.status}${x.verification ? `, ${x.verification}` : ''}${x.flagged_at ? ', flagged' : ''}`;
        case 'scores': return `${x.slot} assessor score ${x.score}`;
        case 'resolutions': return `final ${x.final_score} (${x.method})${x.tick_mismatch ? ', tick difference' : ''}`;
        case 'third_assignments': return `third assessor #${x.assessor_id}`;
        case 'slots': return `${x.slot} slot: assessor #${x.assessor_id}`;
        case 'score_locks': return `${x.phase} locked by #${x.assessor_id}`;
        case 'club_leads': return `lead #${x.lead_id}`;
        case 'lead_comments': return `${x.section} comment`;
        case 'phases': return `${x.id}: deadline ${x.deadline ?? '-'}${x.closed_at ? ', closed' : ''}`;
        case 'extensions': return `${x.phase} until ${x.until}`;
        case 'files': return x.filename;
        case 'staff_rows': return `${x.person} (${x.position}) ${x.status}`;
        case 'settings': return `${x.key} = ${x.value}`;
        case 'results': return `${x.rating} ${x.pct}%`;
        default: return '';
      }
    };
    res.page('Audit log', html`
      <h1>Audit log</h1><p class="sub">Written by database triggers: every score, verification, assignment, third assessment, override, comment and release,
        with who, when and why. Score entries stay hidden until both assessors on that item have locked in.</p>
      <form class="inline"><select name="club"><option value="">All clubs</option>${d.clubs.map((c) => html`<option value="${c.id}" ${club === c.id ? 'selected' : ''}>${c.name}</option>`)}</select><button class="small secondary">Filter</button></form>
      <div class="tablewrap"><table><tr><th>When</th><th>Who</th><th>What</th><th>Club</th><th>Item</th><th>Detail</th><th>Why</th></tr>
        ${d.rows.map((a) => html`<tr><td class="small">${fmtDate(a.at)}</td><td>${a.actor ?? 'system'}</td><td class="small">${a.action} ${a.table_name}</td>
          <td class="small">${a.club ?? ''}</td><td>${a.req_id ?? ''}</td><td class="small">${summary(a)}</td><td class="small">${a.reason ?? ''}</td></tr>`)}
      </table></div>`);
  });

  return r;
}
