import express from 'express';
import { num, sys } from '../db.js';
import { html, progressBar, fmtDate, fmtNum, fmtDay } from '../html.js';
import { getReqs, getSettings, getClub, getItems, clubStatus, reconciliation, applyAuto, clubResult, bothLocked } from '../model.js';
import { loadReview, reviewPage } from './review.js';
import { resultsView } from './club.js';
import { issueLink } from '../auth.js';
import { sendMail } from '../mail.js';
import { THRESHOLDS_2027 } from '../scoring.js';

const back = (res, path, msg) => res.redirect(`${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);
const STATE = {
  resolved: ['b-done', 'Resolved'], auto: ['b-done', 'Within threshold'], disputed: ['b-bad', 'Disputed'],
  unscored: ['b-warn', 'Not scored by one assessor'], moderation: ['b-submitted', 'Awaiting moderator'],
};
const METHOD = { auto: 'Auto (within threshold)', moderator: 'Moderator', consensus: 'Team consensus', admin: 'Admin decision' };

export default function adminRoutes() {
  const r = express.Router();

  const allStatus = (tx) => (async () => {
    const reqs = await getReqs(tx);
    const settings = await getSettings(tx);
    const { rows: clubs } = await tx.query('select * from clubs order by name');
    const { rows: people } = await tx.query(`select id, name from users where role = 'assessor'`);
    const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
    const list = [];
    for (const c of clubs) list.push(await clubStatus(tx, c, reqs, settings));
    return { list, names, settings, reqs };
  })();

  // ---------------------------------------------------------------- progress oversight
  r.get('/', async (req, res) => {
    const d = await req.db((tx) => allStatus(tx), 'Admin overview (auto-resolution)');
    const lock = (assigned, locked) => (!assigned ? html`<span class="badge b-bad">Unassigned</span>`
      : locked ? html`<span class="badge b-approved">Locked</span>` : html`<span class="badge b-muted">In progress</span>`);
    res.page('Progress', html`
      <h1>Progress</h1><p class="sub">All clubs: submission progress, evidence review and assessor completion. Cycle ${d.settings.cycle}.</p>
      <div class="tablewrap"><table>
        <tr><th>Club</th><th>Submission</th><th class="num">Awaiting review</th><th>First assessor</th><th>Second assessor</th><th>Reconciliation</th><th></th></tr>
        ${d.list.map((s) => html`<tr>
          <td><strong>${s.club.name}</strong><br><span class="small muted">Pool ${s.club.pool} · ${s.club.current_shield}</span></td>
          <td style="min-width:170px">${progressBar(s.prog.approved, s.prog.submitted, s.prog.total)}
            <span class="small muted">${s.prog.approved} approved · ${s.prog.submitted} submitted${s.prog.returned ? ` · ${s.prog.returned} returned` : ''} / ${s.prog.total}</span></td>
          <td class="num">${s.awaitingReview}</td>
          <td>${d.names[s.assignment?.first_id] ?? ''}<br>${lock(s.assignment?.first_id, s.firstLocked)}</td>
          <td>${d.names[s.assignment?.second_id] ?? ''}<br>${lock(s.assignment?.second_id, s.secondLocked)}</td>
          <td>${s.rec ? html`${s.rec.resolved} / ${s.rec.total} resolved
              ${s.rec.disputed ? html`<br><span class="badge b-bad">${s.rec.disputed} disputed</span>` : ''}
              ${s.rec.unscored ? html` <span class="badge b-warn">${s.rec.unscored} unscored</span>` : ''}
              ${s.rec.moderation ? html` <span class="badge b-submitted">${s.rec.moderation} with moderator</span>` : ''}`
            : html`<span class="muted small">Sealed until both lock in</span>`}</td>
          <td><a class="btn small secondary" href="/admin/club/${s.club.id}">Evidence</a>
            ${s.both ? html` <a class="btn small" href="/admin/reconcile/${s.club.id}">Reconcile</a>` : ''}</td>
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
      const reqs = await getReqs(tx);
      for (const q of reqs.filter((x) => x.section !== 'staff')) {
        const selected = q.section !== 'planning' || req.body.pool === 'B' || ['P2', 'P5'].includes(q.id);
        await tx.query('insert into club_items(club_id, req_id, selected) values ($1,$2,$3)', [c.id, q.id, selected]);
      }
      await tx.query('insert into assignments(club_id) values ($1)', [c.id]);
      return (await tx.query(`insert into users(email, name, role, club_id, is_primary) values ($1,$2,'club',$3,true) returning id`,
        [String(req.body.email).trim().toLowerCase(), String(req.body.contact).trim(), c.id])).rows[0].id;
    }, 'Admin created club');
    await issueLink(uid);
    back(res, '/admin', 'Club created and sign-in link emailed to the contact. Assign assessors next.');
  });

  r.get('/club/:id', async (req, res) => {
    const d = await loadReview(req, Number(req.params.id));
    if (!d) return res.status(404).page('Not found', html`<h1>Not found</h1>`);
    res.page(d.club.name, reviewPage(d, { mode: 'admin', section: req.query.s ?? 'planning', base: `/admin/club/${d.club.id}` }), { active: '/admin' });
  });

  // ---------------------------------------------------------------- assignment
  r.get('/assignments', async (req, res) => {
    const d = await req.db(async (tx) => ({
      clubs: (await tx.query('select c.*, a.first_id, a.second_id from clubs c left join assignments a on a.club_id = c.id order by c.name')).rows,
      assessors: (await tx.query(`select id, name from users where role = 'assessor' and active order by name`)).rows,
      locks: (await tx.query('select * from score_locks')).rows,
    }));
    const sel = (name, cur) => html`<select name="${name}"><option value="">(none)</option>
      ${d.assessors.map((a) => html`<option value="${a.id}" ${cur === a.id ? 'selected' : ''}>${a.name}</option>`)}</select>`;
    res.page('Assignments', html`
      <h1>Assessor assignments</h1>
      <p class="sub">Each club needs a first and a second assessor. The system blocks the same person in both roles,
      and blocks anyone who is moderating items for that club.</p>
      <div class="tablewrap"><table><tr><th>Club</th><th>First assessor</th><th>Second assessor</th><th></th></tr>
        ${d.clubs.map((c) => {
          const started = d.locks.some((l) => l.club_id === c.id);
          return html`<tr><td>${c.name}</td>
            <td colspan="3"><form method="post" action="/admin/assignments/${c.id}" class="inline">
              ${sel('first_id', c.first_id)} ${sel('second_id', c.second_id)}
              <button class="small" ${started ? 'disabled title="An assessor has already locked in scores"' : ''}>Save</button>
              ${started ? html`<span class="small muted">Locked: an assessor has already locked in.</span>` : ''}</form></td></tr>`;
        })}</table></div>`);
  });

  r.post('/assignments/:club', async (req, res) => {
    const f = req.body.first_id ? Number(req.body.first_id) : null;
    const s = req.body.second_id ? Number(req.body.second_id) : null;
    if (f && s && f === s) throw new Error('The same person cannot be both first and second assessor.');
    await req.db(async (tx) => {
      const { rows: [{ n }] } = await tx.query('select count(*)::int n from score_locks where club_id = $1', [Number(req.params.club)]);
      if (n) throw new Error('Assignments cannot change after an assessor has locked in scores.');
      await tx.query(`insert into assignments(club_id, first_id, second_id) values ($1,$2,$3)
        on conflict (club_id) do update set first_id = excluded.first_id, second_id = excluded.second_id`, [Number(req.params.club), f, s]);
    }, 'Admin changed assignment');
    back(res, '/admin/assignments', 'Assignment saved.');
  });

  // ---------------------------------------------------------------- reconciliation
  r.get('/reconcile', async (req, res) => {
    const d = await req.db((tx) => allStatus(tx), 'Admin reconciliation (auto-resolution)');
    res.page('Reconciliation', html`
      <h1>Reconciliation</h1>
      <p class="sub">Items where the two scores differ by more than ${d.settings.threshold} are disputed. Smaller differences resolve automatically
      (rule: ${d.settings.auto_rule}). You own every disagreement: resolve it directly or assign a moderator.</p>
      <div class="tablewrap"><table><tr><th>Club</th><th>Status</th><th class="num">Disputed</th><th class="num">Unscored</th><th class="num">With moderator</th><th class="num">Resolved</th><th></th></tr>
        ${d.list.map((s) => html`<tr><td>${s.club.name}</td>
          <td>${s.complete ? html`<span class="badge b-approved">Complete</span>` : s.both ? html`<span class="badge b-warn">Open</span>`
            : html`<span class="badge b-muted">Waiting for ${[!s.firstLocked && 'first', !s.secondLocked && 'second'].filter(Boolean).join(' and ')} assessor</span>`}</td>
          <td class="num">${s.rec?.disputed ?? '–'}</td><td class="num">${s.rec?.unscored ?? '–'}</td><td class="num">${s.rec?.moderation ?? '–'}</td>
          <td class="num">${s.rec ? `${s.rec.resolved} / ${s.rec.total}` : '–'}</td>
          <td>${s.both ? html`<a class="btn small" href="/admin/reconcile/${s.club.id}">Open</a>` : ''}</td></tr>`)}
      </table></div>`);
  });

  r.get('/reconcile/:club', async (req, res) => {
    const clubId = Number(req.params.club);
    const d = await req.db(async (tx) => {
      const club = await getClub(tx, clubId);
      const reqs = await getReqs(tx);
      const items = await getItems(tx, clubId);
      const settings = await getSettings(tx);
      if (!(await bothLocked(tx, clubId))) return { club, sealed: true };
      await applyAuto(tx, club, reqs, items, settings);
      const rec = await reconciliation(tx, club, reqs, items, settings);
      const { rows: people } = await tx.query(`select id, name from users where role = 'assessor' and active order by name`);
      return { club, rec, settings, people, result: await clubResult(tx, club, reqs, items) };
    }, 'Admin reconciliation (auto-resolution)');
    if (d.sealed) return res.page('Reconciliation', html`<h1>${d.club.name}</h1><div class="card">Scores are sealed until both assessors lock in.</div>`, { active: '/admin/reconcile' });
    const a = d.rec.assignment;
    const nameOf = (id) => d.people.find((p) => p.id === id)?.name ?? '';
    const filter = req.query.f ?? 'open';
    const rows = d.rec.rows.filter((x) => (filter === 'all' ? true : x.state !== 'resolved'));
    const eligible = d.people.filter((p) => p.id !== a.first_id && p.id !== a.second_id);
    res.page('Reconcile', html`
      <p><a href="/admin/reconcile">&larr; Reconciliation</a></p>
      <div class="row"><div><h1>${d.club.name}</h1>
        <p class="sub">First: ${nameOf(a.first_id)} · Second: ${nameOf(a.second_id)} · threshold ${d.settings.threshold} · auto rule ${d.settings.auto_rule}</p></div>
        <span class="spacer"></span><a class="btn secondary" href="/admin/results/${d.club.id}">Preview result</a></div>
      <div class="tabs"><a href="?f=open" class="${filter === 'open' ? 'on' : ''}">Needs action (${d.rec.rows.filter((x) => x.state !== 'resolved').length})</a>
        <a href="?f=all" class="${filter === 'all' ? 'on' : ''}">All items (${d.rec.rows.length})</a></div>
      <div class="tablewrap"><table>
        <tr><th>Item</th><th class="num">First</th><th class="num">Second</th><th class="num">Diff</th><th>State</th><th>Final</th><th style="min-width:360px">Action</th></tr>
        ${rows.map((x) => html`<tr id="${x.req.id}">
          <td><strong>${x.req.id}</strong> ${x.req.name}<br><span class="small muted">max ${x.req.max_score} · x${x.req.weight}</span></td>
          <td class="num">${fmtNum(x.s1)}${x.n1 ? html`<div class="small muted">${x.n1}</div>` : ''}</td>
          <td class="num">${fmtNum(x.s2)}${x.n2 ? html`<div class="small muted">${x.n2}</div>` : ''}</td>
          <td class="num ${x.rec.state === 'disputed' ? 'diff-hi' : ''}">${x.rec.diff !== undefined ? fmtNum(x.rec.diff) : '–'}</td>
          <td><span class="badge ${STATE[x.state][0]}">${STATE[x.state][1]}</span>
            ${x.moderation ? html`<div class="small muted">Moderator: ${x.moderation.moderator}</div>` : ''}</td>
          <td>${x.resolution ? html`<strong>${fmtNum(x.resolution.final_score)}</strong><div class="small muted">${METHOD[x.resolution.method]}${x.resolution.resolver ? ` · ${x.resolution.resolver}` : ''}</div>
            ${x.resolution.note ? html`<div class="small">${x.resolution.note}</div>` : ''}` : ''}</td>
          <td>${x.state === 'resolved' && x.resolution.method !== 'auto' ? html`<form method="post" action="/admin/reconcile/${d.club.id}/${x.req.id}/clear" class="inline">
                <button class="small secondary">Reopen decision</button></form>` : x.state === 'resolved' ? '' : html`
            <form method="post" action="/admin/reconcile/${d.club.id}/${x.req.id}/resolve" class="inline">
              <input type="number" name="score" step="0.1" min="0" max="${x.req.max_score}" required placeholder="Final" style="width:72px">
              <select name="method"><option value="admin">Admin decision</option><option value="consensus">Team consensus</option></select>
              <input name="note" required placeholder="Short note" style="width:150px"><button class="small">Resolve</button></form>
            <form method="post" action="/admin/reconcile/${d.club.id}/${x.req.id}/moderator" class="inline">
              <select name="moderator_id" required><option value="">Assign moderator...</option>${eligible.map((p) => html`<option value="${p.id}" ${x.moderation?.moderator_id === p.id ? 'selected' : ''}>${p.name}</option>`)}</select>
              <button class="small secondary">${x.moderation ? 'Reassign' : 'Assign'}</button></form>`}</td>
        </tr>`)}
        ${rows.length ? '' : html`<tr><td colspan="7" class="muted">Nothing needs action. All items are resolved.</td></tr>`}
      </table></div>
      <p class="small muted">Moderator list excludes this club's first and second assessor; the database also rejects them.</p>`, { active: '/admin/reconcile' });
  });

  r.post('/reconcile/:club/:req/resolve', async (req, res) => {
    const note = String(req.body.note ?? '').trim();
    if (!note) throw new Error('A short note is required.');
    if (!['admin', 'consensus'].includes(req.body.method)) throw new Error('Unknown method');
    await req.db((tx) => tx.query(
      `insert into resolutions(club_id, req_id, final_score, method, note) values ($1,$2,$3,$4,$5)
       on conflict (club_id, req_id) do update set final_score = excluded.final_score, method = excluded.method, note = excluded.note`,
      [Number(req.params.club), req.params.req, Math.round(Number(req.body.score) * 10) / 10, req.body.method, note]), note);
    back(res, `/admin/reconcile/${req.params.club}`, `${req.params.req} resolved.`);
  });

  r.post('/reconcile/:club/:req/clear', async (req, res) => {
    await req.db((tx) => tx.query(`delete from resolutions where club_id = $1 and req_id = $2 and method <> 'auto'`,
      [Number(req.params.club), req.params.req]), 'Admin reopened resolution');
    back(res, `/admin/reconcile/${req.params.club}?f=all`, `${req.params.req} decision reopened.`);
  });

  r.post('/reconcile/:club/:req/moderator', async (req, res) => {
    const clubId = Number(req.params.club);
    const modId = Number(req.body.moderator_id);
    await req.db((tx) => tx.query(
      `insert into moderations(club_id, req_id, moderator_id, assigned_by) values ($1,$2,$3,$4)
       on conflict (club_id, req_id) do update set moderator_id = excluded.moderator_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
      [clubId, req.params.req, modId, req.user.id]), 'Admin assigned moderator');
    const { rows: [m] } = await sys().query('select email, name from users where id = $1', [modId]);
    await sendMail(m.email, 'Moderation request', `Hello ${m.name},\n\nYou have been asked to moderate item ${req.params.req}. Sign in and open "My clubs" to see the request.`);
    back(res, `/admin/reconcile/${clubId}`, 'Moderator assigned and notified.');
  });

  r.get('/results/:club', async (req, res) => {
    const clubId = Number(req.params.club);
    const d = await req.db(async (tx) => {
      const club = await getClub(tx, clubId);
      const { rows: [released] } = await tx.query('select * from results where club_id = $1', [clubId]);
      if (released) return { club, result: released };
      const reqs = await getReqs(tx);
      const items = await getItems(tx, clubId);
      const r2 = await clubResult(tx, club, reqs, items);
      return { club, result: { total: r2.total, max_total: r2.max, pct: r2.pct, rating: r2.rating, details: r2 } };
    });
    res.page('Result preview', resultsView(d.result, d.club, { preview: !d.result.released_at }), { active: '/admin/release' });
  });

  // ---------------------------------------------------------------- release
  r.get('/release', async (req, res) => {
    const d = await req.db((tx) => allStatus(tx), 'Admin release check');
    const released = d.settings.released_at;
    const deadline = d.settings.internal_deadline;
    const pastDeadline = deadline && new Date(deadline) <= new Date();
    const incomplete = d.list.filter((s) => !s.complete);
    const why = (s) => {
      if (!s.assignment?.first_id || !s.assignment?.second_id) return 'Assessors not assigned';
      if (!s.both) return `Waiting for ${[!s.firstLocked && 'first', !s.secondLocked && 'second'].filter(Boolean).join(' and ')} assessor to lock in`;
      return `${s.rec.total - s.rec.resolved} item(s) unresolved`;
    };
    res.page('Release results', html`
      <h1>Release results</h1>
      <p class="sub">One action releases results to every club. Clubs see nothing until then; the database blocks them from reading result rows before release.</p>
      ${released ? html`<div class="notice"><strong>Results released ${fmtDate(released)}.</strong> Clubs can now view their results.</div>` : ''}
      <div class="card"><dl class="kv">
        <dt>Internal deadline</dt><dd>${deadline ? fmtDay(deadline) : 'not set'} ${pastDeadline ? html`<span class="badge b-approved">passed</span>` : html`<span class="badge b-warn">not yet reached</span>`}</dd>
        <dt>Clubs complete</dt><dd>${d.list.length - incomplete.length} of ${d.list.length}</dd>
        <dt>Thresholds</dt><dd>${THRESHOLDS_2027.map((t) => `${t.rating} ${t.min}%`).join(' · ')}</dd></dl></div>
      <div class="tablewrap"><table><tr><th>Club</th><th>Status</th><th>Projected</th><th></th></tr>
        ${await Promise.all(d.list.map(async (s) => html`<tr><td>${s.club.name}</td>
          <td>${s.complete ? html`<span class="badge b-approved">Ready</span>` : html`<span class="badge b-bad">Incomplete</span> <span class="small">${why(s)}</span>`}</td>
          <td>${s.complete ? await req.db(async (tx) => { const rr = await clubResult(tx, s.club, d.reqs, s.items); return `${rr.rating} · ${rr.pct}%`; }) : '–'}</td>
          <td><a class="btn small secondary" href="/admin/results/${s.club.id}">Preview</a></td></tr>`))}
      </table></div>
      ${released ? '' : html`<form method="post" action="/admin/release" class="card" onsubmit="return confirm('Release results to all clubs now? This cannot be undone.')">
        ${incomplete.length || !pastDeadline ? html`<div class="warnbox">Release is blocked:
          ${!pastDeadline ? ' the internal deadline has not been reached.' : ''}
          ${incomplete.length ? html` ${incomplete.length} club(s) incomplete: ${incomplete.map((s) => s.club.name).join(', ')}.` : ''}</div>` : ''}
        <button ${incomplete.length || !pastDeadline ? 'disabled' : ''}>Release results to all clubs</button></form>`}`);
  });

  r.post('/release', async (req, res) => {
    const contacts = await req.db(async (tx) => {
      const st = await allStatus(tx);
      if (st.settings.released_at) throw new Error('Results have already been released.');
      if (!st.settings.internal_deadline || new Date(st.settings.internal_deadline) > new Date()) throw new Error('The internal deadline has not been reached.');
      const bad = st.list.filter((s) => !s.complete);
      if (bad.length) throw new Error(`Release blocked. Incomplete: ${bad.map((s) => s.club.name).join(', ')}`);
      for (const s of st.list) {
        const rr = await clubResult(tx, s.club, st.reqs, s.items);
        await tx.query(`insert into results(club_id, total, max_total, pct, rating, nn_met, details, released_at) values ($1,$2,$3,$4,$5,$6,$7,now())
          on conflict (club_id) do update set total = excluded.total, max_total = excluded.max_total, pct = excluded.pct, rating = excluded.rating,
          nn_met = excluded.nn_met, details = excluded.details, released_at = excluded.released_at`,
          [s.club.id, rr.total, rr.max, rr.pct, rr.rating, rr.nnMet, JSON.stringify(rr)]);
      }
      await tx.query(`update settings set value = now()::text where key = 'released_at'`);
      return st.list.map((s) => s.club.id);
    }, 'Results released');
    const { rows } = await sys().query('select email, name from users where club_id = any($1::int[]) and active', [contacts]);
    for (const u of rows) await sendMail(u.email, 'Your club assessment results are available', `Hello ${u.name},\n\nFQ has released the 2027 club assessment results. Sign in with your personal link to view them.`);
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
      <h1>People</h1><p class="sub">Only pre-registered addresses can sign in. Issuing a new link cancels the person's previous link.</p>
      <div class="tablewrap"><table><tr><th>Name</th><th>Role</th><th>Email</th><th>Active link</th><th></th></tr>
        ${users.map((u) => html`<tr style="${u.active ? '' : 'opacity:.5'}"><td>${u.name}</td>
          <td>${u.role}${u.club ? html`<br><span class="small muted">${u.club}${u.is_primary ? ' · primary' : ''}</span>` : ''}</td>
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
    // Confirm the admin can see this user under RLS before using the trusted mail layer.
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

  // ---------------------------------------------------------------- settings
  r.get('/settings', async (req, res) => {
    const s = await req.db((tx) => getSettings(tx));
    res.page('Settings', html`
      <h1>Settings</h1>
      <form method="post" class="card" style="max-width:640px">
        <p><label>Disagreement threshold (points of item score)<br><input type="number" name="threshold" step="0.1" min="0" max="4" value="${s.threshold}"></label>
          <br><span class="small muted">Scores that differ by more than this are disputed. Non-negotiables always need agreement.</span></p>
        <p><label>Auto-resolution rule for differences within the threshold<br>
          <select name="auto_rule">${['average', 'higher', 'lower'].map((x) => html`<option ${s.auto_rule === x ? 'selected' : ''}>${x}</option>`)}</select></label></p>
        <p><label>Internal deadline (results cannot be released before)<br><input type="date" name="internal_deadline" value="${s.internal_deadline}"></label></p>
        <p class="small muted">Changing the threshold or rule recalculates every automatic resolution. Manual decisions are kept.</p>
        <button>Save settings</button></form>
      <div class="notice small">Open decision (spec 9): the threshold rule depends on FQ scoring documentation. The info pack confirms 0-3 / 0-4 item scores with decimals allowed from 2027.</div>`);
  });

  r.post('/settings', async (req, res) => {
    const threshold = Number(req.body.threshold);
    if (!(threshold >= 0 && threshold <= 4)) throw new Error('Threshold must be between 0 and 4.');
    if (!['average', 'higher', 'lower'].includes(req.body.auto_rule)) throw new Error('Unknown rule');
    await req.db(async (tx) => {
      const cur = await getSettings(tx);
      for (const [k, v] of [['threshold', String(threshold)], ['auto_rule', req.body.auto_rule], ['internal_deadline', req.body.internal_deadline ?? '']]) {
        await tx.query('update settings set value = $2 where key = $1', [k, v]);
      }
      if (cur.threshold !== threshold || cur.auto_rule !== req.body.auto_rule) {
        if (cur.released_at) throw new Error('Results are already released; scoring rules can no longer change.');
        await tx.query(`delete from resolutions where method = 'auto'`);
      }
    }, 'Admin changed settings');
    back(res, '/admin/settings', 'Settings saved.');
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
        case 'resolutions': return `final ${x.final_score} (${x.method})`;
        case 'moderations': return `moderator #${x.moderator_id}`;
        case 'assignments': return `first #${x.first_id ?? '-'}, second #${x.second_id ?? '-'}`;
        case 'score_locks': return `assessor #${x.assessor_id} locked in`;
        case 'files': return x.filename;
        case 'staff_rows': return `${x.person} (${x.position}) ${x.status}`;
        case 'settings': return `${x.key} = ${x.value}`;
        case 'results': return `${x.rating} ${x.pct}%`;
        default: return '';
      }
    };
    res.page('Audit log', html`
      <h1>Audit log</h1><p class="sub">Written by database triggers: every score, verification, moderation, reopening and resolution, with who, when and why.
        Score entries stay hidden until both assessors on that club lock in.</p>
      <form class="inline"><select name="club"><option value="">All clubs</option>${d.clubs.map((c) => html`<option value="${c.id}" ${club === c.id ? 'selected' : ''}>${c.name}</option>`)}</select><button class="small secondary">Filter</button></form>
      <div class="tablewrap"><table><tr><th>When</th><th>Who</th><th>What</th><th>Club</th><th>Item</th><th>Detail</th><th>Why</th></tr>
        ${d.rows.map((a) => html`<tr><td class="small">${fmtDate(a.at)}</td><td>${a.actor ?? 'system'}</td><td class="small">${a.action} ${a.table_name}</td>
          <td class="small">${a.club ?? ''}</td><td>${a.req_id ?? ''}</td><td class="small">${summary(a)}</td><td class="small">${a.reason ?? ''}</td></tr>`)}
      </table></div>`);
  });

  return r;
}
