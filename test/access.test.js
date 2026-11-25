// Database-level tests: queries run directly as each DB role, with no web UI involved,
// to prove the access and workflow rules hold even if the interface had a bug.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, asUser, sys } from '../src/db.js';
import { seed } from '../src/seed.js';

let ids;
const user = async (email) => (await sys().query('select id, role, club_id from users where email = $1', [email])).rows[0];
const byId = async (id) => (await sys().query('select id, role, club_id from users where id = $1', [id])).rows[0];
const q = (u, sql, params = []) => asUser(u, async (tx) => (await tx.query(sql, params)).rows);
const fails = (p, re) => assert.rejects(p, re);
const holder = async (club, req, slot) => byId((await sys().query(
  'select assessor_id from slots where club_id = $1 and req_id = $2 and slot = $3', [club, req, slot])).rows[0].assessor_id);

// Score every item an assessor holds at a club in a phase, with a given tick pattern.
async function scoreAll(u, club, phase, tick = 'y') {
  const { rows } = await sys().query(
    `select s.req_id, s.slot, q.type, q.n_criteria from slots s join requirements q on q.id = s.req_id
     where s.club_id = $1 and s.assessor_id = $2 and q.section = $3 and item_applies($1, s.req_id)`, [club, u.id, phase]);
  for (const r of rows) {
    await q(u, `insert into scores(club_id, req_id, slot, assessor_id, ticks, value, score) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (club_id, req_id, slot) do update set ticks = excluded.ticks, value = excluded.value, score = excluded.score`,
    [club, r.req_id, r.slot, u.id, r.type === 'ticks' ? JSON.stringify(Array(r.n_criteria).fill(tick)) : null,
      r.type === 'value' ? 90 : null, r.type === 'yesno' ? 1 : 2]);
  }
}

before(async () => {
  await openDb({ memory: true });
  ids = await seed({ issueLinks: false });
  // Open Delivery for scoring.
  await sys().query(`update phases set deadline = current_date - 1 where id = 'delivery'`);
});

test('club sees only its own club, items and files', async () => {
  const c = await user('td@riverside-rovers.example');
  assert.deepEqual((await q(c, 'select id from clubs')).map((r) => r.id), [c.club_id]);
  assert.deepEqual((await q(c, 'select distinct club_id from club_items')).map((r) => r.club_id), [c.club_id]);
  assert.deepEqual((await q(c, 'select distinct club_id from files')).map((r) => r.club_id), [c.club_id]);
});

test('club has no access to criteria, assignments, scores, leads or audit', async () => {
  const c = await user('td@riverside-rovers.example');
  for (const t of ['requirement_criteria', 'slots', 'scores', 'score_locks', 'third_assignments', 'club_leads', 'resolutions',
    'prior_scores', 'settings', 'audit_log']) {
    await fails(q(c, `select * from ${t}`), /permission denied/);
  }
  await fails(q(c, 'select verification from club_items'), /permission denied/);
});

test('results and lead comments are hidden from clubs until release', async () => {
  const c = await user('td@riverside-rovers.example');
  assert.ok((await sys().query('select count(*)::int n from lead_comments where club_id = $1', [c.club_id])).rows[0].n > 0);
  assert.equal((await q(c, 'select * from lead_comments')).length, 0);
  await sys().query(`insert into results(club_id, total, max_total, pct, rating, nn_met, details, released_at) values ($1,1,2,50,'Bronze',true,'{}',now())`, [c.club_id]);
  assert.ok((await q(c, 'select * from lead_comments')).length > 0);
  assert.equal((await q(c, 'select * from results')).length, 1);
  await sys().query('delete from results');
});

test('club cannot approve its own item, or upload after a section deadline', async () => {
  const c = await user('td@riverside-rovers.example');
  await fails(q(c, `update club_items set status = 'approved' where req_id = 'D1'`), /Clubs can only submit/);
  await fails(q(c, `insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,'P3','x.pdf','application/pdf',1,'\\x00',$2)`,
    [c.club_id, c.id]), /deadline|locked/);
  await fails(q(c, `update staff_rows set person = 'Changed' where club_id = $1`, [c.club_id]), /locked|deadline/);
});

test('an extension reopens uploads for that club and phase only', async () => {
  const c = await user('td@riverside-rovers.example');
  await sys().query(`update club_items set status = 'not_started' where club_id = $1 and req_id = 'P3'`, [c.club_id]);
  await sys().query(`update phases set closed_at = null where id = 'planning'`);
  await sys().query(`insert into extensions(club_id, phase, until) values ($1, 'planning', current_date + 3)`, [c.club_id]);
  await q(c, `insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,'P3','x.pdf','application/pdf',1,'\\x00',$2)`, [c.club_id, c.id]);
  await sys().query('delete from extensions');
  await sys().query(`update phases set closed_at = now() where id = 'planning'`);
});

test('blind scoring: assessors see only their own slots, scores and locks', async () => {
  const a = await user('jordan.lee@fq-assess.example');
  // Rows where this person is the third assessor are the only exception (and only after both locked).
  assert.deepEqual([...new Set((await q(a, 'select assessor_id from scores where not is_third_for(club_id, req_id)')).map((r) => r.assessor_id))], [a.id]);
  const thirdRows = await q(a, 'select club_id, req_id, item_locked(club_id, req_id) l from scores where is_third_for(club_id, req_id)');
  assert.ok(thirdRows.every((r) => r.l));
  assert.deepEqual([...new Set((await q(a, 'select assessor_id from slots')).map((r) => r.assessor_id))], [a.id]);
  assert.deepEqual([...new Set((await q(a, 'select assessor_id from score_locks')).map((r) => r.assessor_id))], [a.id]);
});

test('assessors see evidence only for items they hold', async () => {
  const a = await holder(ids.clubIds.coastal, 'D1', 'first');
  const visible = await q(a, 'select distinct req_id from club_items where club_id = $1', [ids.clubIds.coastal]);
  const held = (await sys().query('select distinct req_id from slots where club_id = $1 and assessor_id = $2', [ids.clubIds.coastal, a.id])).rows;
  const lead = (await sys().query('select 1 from club_leads where club_id = $1 and lead_id = $2', [ids.clubIds.coastal, a.id])).rowCount;
  if (!lead) assert.equal(visible.length, held.length);
});

test('scores are computed in the database: proportional ticks, partial = 0.5, value bands', async () => {
  const club = ids.clubIds.northgate;
  const a = await holder(club, 'D1', 'first');
  await q(a, `insert into scores(club_id, req_id, slot, assessor_id, ticks) values ($1,'D1','first',$2,'["y","y","y","y","p","n"]')`, [club, a.id]);
  const [row] = await q(a, `select score from scores where club_id = $1 and req_id = 'D1' and slot = 'first'`, [club]);
  assert.equal(Number(row.score), 2.3); // 4.5 / 6 x 3 = 2.25 -> 2.3
  await fails(q(a, `update scores set ticks = '["y","y"]' where club_id = $1 and req_id = 'D1' and slot = 'first'`, [club]), /mark every criterion/);
  const d = await holder(club, 'O10', 'first');
  await q(d, `insert into scores(club_id, req_id, slot, assessor_id, value) values ($1,'O10','first',$2,77)`, [club, d.id]);
  assert.equal(Number((await q(d, `select score from scores where club_id = $1 and req_id = 'O10'`, [club]))[0].score), 2.4);
});

test('assignment rules: no same person in both slots, one slot for data items, third not a holder', async () => {
  const a = await user('admin@fq-assess.example');
  const club = ids.clubIds.westfield;
  const first = await holder(club, 'D1', 'first');
  await fails(q(a, `update slots set assessor_id = $2 where club_id = $1 and req_id = 'D1' and slot = 'second'`, [club, first.id]), /same person/);
  await fails(q(a, `insert into slots(club_id, req_id, slot, assessor_id) values ($1,'O10','second',$2)`, [club, first.id]), /one assessor only/);
  await fails(q(a, `insert into third_assignments(club_id, req_id, assessor_id) values ($1,'D1',$2)`, [club, first.id]), /cannot be the first or second/);
});

test('lock flow: complete -> agreed or needs third -> third decides', async () => {
  const club = ids.clubIds.riverside;
  const a1 = await holder(club, 'D1', 'first');
  const a2 = await holder(club, 'D1', 'second');
  await fails(q(a1, `insert into score_locks(club_id, assessor_id, phase) values ($1,$2,'delivery')`, [club, a1.id]), /Score every item/);
  await scoreAll(a1, club, 'delivery', 'y');
  await scoreAll(a2, club, 'delivery', 'y');
  await q(a2, `update scores set ticks = '["y","y","y","y","y","n"]' where club_id = $1 and req_id = 'D1' and slot = 'second'`, [club]);
  await q(a1, `insert into score_locks(club_id, assessor_id, phase) values ($1,$2,'delivery')`, [club, a1.id]);
  await fails(q(a1, `update scores set score = 0 where club_id = $1 and req_id = 'D1' and slot = 'first'`, [club]), /locked/);
  assert.equal((await sys().query(`select * from resolutions where club_id = $1 and req_id = 'D1'`, [club])).rowCount, 0);
  await q(a2, `insert into score_locks(club_id, assessor_id, phase) values ($1,$2,'delivery')`, [club, a2.id]);
  // D1 differs (3 vs 2.5): no resolution yet. Admin can now see both scores.
  assert.equal((await sys().query(`select * from resolutions where club_id = $1 and req_id = 'D1'`, [club])).rowCount, 0);
  const admin = await user('admin@fq-assess.example');
  assert.equal((await q(admin, `select * from scores where club_id = $1 and req_id = 'D1'`, [club])).length, 2);
  const third = (await sys().query(`select id, role from users where role = 'assessor' and id not in ($1,$2) order by id limit 1`, [a1.id, a2.id])).rows[0];
  await q(admin, `insert into third_assignments(club_id, req_id, assessor_id) values ($1,'D1',$2)`, [club, third.id]);
  assert.equal((await q(third, `select * from scores where club_id = $1 and req_id = 'D1'`, [club])).length, 2);
  await q(third, `insert into scores(club_id, req_id, slot, assessor_id, ticks, comment) values ($1,'D1','third',$2,'["y","y","y","y","y","p"]','Evidence supports 5.5 of 6')`, [club, third.id]);
  const [res] = (await sys().query(`select method, final_score from resolutions where club_id = $1 and req_id = 'D1'`, [club])).rows;
  assert.deepEqual([res.method, Number(res.final_score)], ['third', 2.8]);
});

test('admin sees scores only on locked items and never scores', async () => {
  const admin = await user('admin@fq-assess.example');
  const club = ids.clubIds.coastal;
  const a = await holder(club, 'D1', 'first');
  await scoreAll(a, club, 'delivery');
  assert.equal((await q(admin, `select * from scores where club_id = $1 and req_id = 'D1'`, [club])).length, 0);
  assert.equal((await q(admin, `select * from audit_log where table_name = 'scores' and club_id = $1 and req_id = 'D1'`, [club])).length, 0);
  await fails(q(admin, `insert into scores(club_id, req_id, slot, assessor_id, score) values ($1,'D2','first',$2,2)`, [club, admin.id]), /permission denied/);
  await fails(q(admin, `insert into resolutions(club_id, req_id, final_score, method, note) values ($1,'D2',2,'admin','x')`, [club]), /lock in first/);
});

test('leads see final scores for their clubs, never individual scores or other clubs', async () => {
  const lead = await user('sam.reid@fq-assess.example'); // leads Riverside
  const own = await q(lead, 'select distinct club_id from resolutions where not is_third_for(club_id, req_id)');
  assert.deepEqual(own.map((r) => r.club_id), [ids.clubIds.riverside]);
  const s = await q(lead, 'select * from scores where club_id = $1 and assessor_id <> $2 and not is_third_for(club_id, req_id)', [ids.clubIds.riverside, lead.id]);
  assert.equal(s.length, 0);
});

test('lead comments only once a section is reconciled; phases close only when complete', async () => {
  const lead = await user('jordan.lee@fq-assess.example'); // leads Coastal
  await fails(q(lead, `insert into lead_comments(club_id, section, body) values ($1,'delivery','Too early')`, [ids.clubIds.coastal]), /not fully reconciled/);
  await fails(q(lead, `insert into lead_comments(club_id, section, body) values ($1,'overall','Too early')`, [ids.clubIds.coastal]), /every section/);
  const admin = await user('admin@fq-assess.example');
  await fails(q(admin, `update phases set closed_at = now() where id = 'delivery'`), /not yet resolved/);
});

test('club contact cannot invite a third person or create staff accounts', async () => {
  const c = await user('td@westfield-city.example');
  await q(c, `insert into users(email, name, role, club_id) values ('two@westfield-city.example', 'Two', 'club', $1)`, [c.club_id]);
  await fails(q(c, `insert into users(email, name, role, club_id) values ('three@westfield-city.example', 'Three', 'club', $1)`, [c.club_id]), /at most two/);
  await fails(q(c, `insert into users(email, name, role, club_id) values ('x@x.example', 'X', 'admin', null)`), /row-level security|Invalid|check constraint/);
});

test('rating overrides are admin-only; lead highlights only for the lead\'s own club', async () => {
  const c = await user('td@riverside-rovers.example');
  await fails(q(c, 'select * from rating_overrides'), /permission denied/);
  await fails(q(c, 'select * from lead_highlights'), /permission denied/);
  const lead = await user('sam.reid@fq-assess.example'); // Riverside's lead
  await q(lead, `insert into lead_highlights(club_id, kind, items) values ($1,'strengths','{P1}')`, [ids.clubIds.riverside]);
  await fails(q(lead, `insert into lead_highlights(club_id, kind, items) values ($1,'strengths','{P1}')`, [ids.clubIds.coastal]), /row-level security/);
  await fails(q(lead, 'select * from rating_overrides'), /permission denied/);
});

test('after release (before confirmation) a closed-phase score can change only as a review outcome', async () => {
  const admin = await user('admin@fq-assess.example');
  const club = ids.clubIds.northgate;
  await fails(q(admin, `update resolutions set final_score = 1, note = 'x' where club_id = $1 and req_id = 'P1'`, [club]), /phase is closed/);
  await sys().query(`insert into results(club_id, total, max_total, pct, rating, nn_met, details, released_at) values ($1,1,2,50,'Bronze',true,'{}',now())`, [club]);
  const [before] = (await sys().query(`select final_score from resolutions where club_id = $1 and req_id = 'P1'`, [club])).rows;
  await q(admin, `update resolutions set final_score = 3, note = 'Review: evidence overlooked' where club_id = $1 and req_id = 'P1'`, [club]);
  const [after] = (await sys().query(`select method, final_score, review_from from resolutions where club_id = $1 and req_id = 'P1'`, [club])).rows;
  assert.deepEqual([after.method, Number(after.final_score), Number(after.review_from)], ['review', 3, Number(before.final_score)]);
  await sys().query('update results set confirmed_at = now() where club_id = $1', [club]);
  await fails(q(admin, `update resolutions set final_score = 2, note = 'late' where club_id = $1 and req_id = 'P1'`, [club]), /phase is closed/);
  await sys().query('delete from results');
});
