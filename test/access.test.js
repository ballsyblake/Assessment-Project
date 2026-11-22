// Database-level access tests: run the queries directly as each DB role, with no
// web UI involved, to prove the rules hold even if the interface had a bug.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, asUser, sys } from '../src/db.js';
import { seed } from '../src/seed.js';

let ids;
const user = async (email) => (await sys().query('select id, role, club_id from users where email = $1', [email])).rows[0];
const q = (u, sql, params = []) => asUser(u, async (tx) => (await tx.query(sql, params)).rows);
const fails = async (p, re) => assert.rejects(p, re);

before(async () => {
  await openDb({ memory: true });
  ids = await seed({ issueLinks: false });
});

test('club sees only its own club and items', async () => {
  const c = await user('td@riverside-rovers.example');
  assert.deepEqual((await q(c, 'select id from clubs')).map((r) => r.id), [c.club_id]);
  const items = await q(c, 'select distinct club_id from club_items');
  assert.deepEqual(items.map((r) => r.club_id), [c.club_id]);
  const files = await q(c, 'select distinct club_id from files');
  assert.deepEqual(files.map((r) => r.club_id), [c.club_id]);
});

test('club has no access to criteria, scores, assignments, audit or hidden columns', async () => {
  const c = await user('td@riverside-rovers.example');
  for (const t of ['requirement_criteria', 'scores', 'score_locks', 'assignments', 'moderations', 'resolutions', 'audit_log', 'settings', 'prior_scores']) {
    await fails(q(c, `select * from ${t}`), /permission denied/);
  }
  await fails(q(c, 'select verification from club_items'), /permission denied/);
});

test('club cannot read results before release', async () => {
  await sys().query(`insert into results(club_id, total, max_total, pct, rating, nn_met, details) values ($1, 1, 2, 50, 'Bronze', true, '{}')`, [ids.clubIds.riverside]);
  const c = await user('td@riverside-rovers.example');
  assert.equal((await q(c, 'select * from results')).length, 0);
  await sys().query('update results set released_at = now() where club_id = $1', [ids.clubIds.riverside]);
  assert.equal((await q(c, 'select * from results')).length, 1);
  await sys().query('delete from results');
});

test('club cannot approve its own item or change a locked one', async () => {
  const c = await user('td@riverside-rovers.example');
  await fails(q(c, `update club_items set status = 'approved' where req_id = 'P1'`), /Clubs can only submit/);
  await fails(q(c, `update club_items set status = 'submitted' where req_id = 'NN1'`), /Clubs can only submit/); // NN1 is approved
});

test('blind scoring: assessors see only their own scores and locks', async () => {
  const jordan = await user('jordan.lee@fq-assess.example');
  const rows = await q(jordan, 'select distinct assessor_id from scores');
  assert.deepEqual(rows.map((r) => r.assessor_id), [jordan.id]);
  const locks = await q(jordan, 'select distinct assessor_id from score_locks');
  assert.deepEqual(locks.map((r) => r.assessor_id), [jordan.id]);
});

test('admin sees scores only after both assessors lock in', async () => {
  const a = await user('admin@fq-assess.example');
  const visible = await q(a, 'select distinct club_id from scores order by club_id');
  // Coastal and Northgate are locked; Highland has scores but is not.
  assert.deepEqual(visible.map((r) => r.club_id), [ids.clubIds.coastal, ids.clubIds.northgate]);
  const sealed = await q(a, `select * from audit_log where table_name = 'scores' and club_id = $1`, [ids.clubIds.highland]);
  assert.equal(sealed.length, 0);
});

test('admin never scores', async () => {
  const a = await user('admin@fq-assess.example');
  await fails(q(a, `insert into scores(club_id, req_id, assessor_id, slot, score) values ($1, 'P1', $2, 'first', 2)`, [ids.clubIds.riverside, a.id]), /permission denied/);
});

test('assessor cannot score an unassigned club or edit after locking', async () => {
  const sam = await user('sam.reid@fq-assess.example');
  await fails(q(sam, `insert into scores(club_id, req_id, assessor_id, slot, score) values ($1, 'P1', $2, 'first', 2)`, [ids.clubIds.coastal, sam.id]), /row-level security|Not assigned/);
  const jordan = await user('jordan.lee@fq-assess.example');
  await fails(q(jordan, `update scores set score = 1 where club_id = $1 and req_id = 'P2'`, [ids.clubIds.coastal]), /locked/);
});

test('same person cannot be first and second, or moderate a club they assess', async () => {
  const a = await user('admin@fq-assess.example');
  const sam = await user('sam.reid@fq-assess.example');
  await fails(q(a, 'update assignments set second_id = first_id where club_id = $1', [ids.clubIds.riverside]), /check constraint/);
  await fails(q(a, `insert into moderations(club_id, req_id, moderator_id) values ($1, 'P1', $2)`, [ids.clubIds.riverside, sam.id]), /cannot be the first or second/);
});

test('moderator sees both scores only for the moderated item, and only that evidence', async () => {
  const sam = await user('sam.reid@fq-assess.example');
  const rows = await q(sam, 'select distinct req_id from scores where club_id = $1', [ids.clubIds.coastal]);
  assert.deepEqual(rows.map((r) => r.req_id), ['D8']);
  const items = await q(sam, 'select req_id from club_items where club_id = $1', [ids.clubIds.coastal]);
  assert.deepEqual(items.map((r) => r.req_id), ['D8']);
  assert.equal((await q(sam, 'select * from files where club_id = $1', [ids.clubIds.coastal])).length, 0);
});

test('assessor sees criteria; every score change is audited', async () => {
  const sam = await user('sam.reid@fq-assess.example');
  assert.ok((await q(sam, 'select * from requirement_criteria')).length > 80);
  await q(sam, `insert into scores(club_id, req_id, assessor_id, slot, score) values ($1, 'P3', $2, 'first', 1.5)`, [ids.clubIds.riverside, sam.id]);
  const { rows } = await sys().query(`select * from audit_log where table_name = 'scores' and actor_id = $1 and req_id = 'P3'`, [sam.id]);
  assert.equal(rows.length, 1);
});

test('club cannot upload to a locked item or edit a locked staff row', async () => {
  const c = await user('td@coastal-united.example');
  await fails(q(c, `insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1, 'P2', 'x.pdf', 'application/pdf', 1, '\\x00', $2)`,
    [c.club_id, c.id]), /locked/);
  await fails(q(c, `update staff_rows set person = 'Changed' where club_id = $1`, [c.club_id]), /locked/);
});

test('pool A/C clubs: P2 and P5 mandatory, at most three optional planning items', async () => {
  const c = await user('td@highland-park.example'); // pool C, P1/P8/P14 already chosen
  await fails(q(c, `update club_items set selected = false where req_id = 'P2'`), /mandatory/);
  await fails(q(c, `update club_items set selected = true where req_id = 'P3'`), /at most three/);
});

test('club contact cannot invite a third person or create staff accounts', async () => {
  const c = await user('td@riverside-rovers.example');
  await q(c, `insert into users(email, name, role, club_id) values ('two@riverside-rovers.example', 'Two', 'club', $1)`, [c.club_id]);
  await fails(q(c, `insert into users(email, name, role, club_id) values ('three@riverside-rovers.example', 'Three', 'club', $1)`, [c.club_id]), /at most two/);
  await fails(q(c, `insert into users(email, name, role, club_id) values ('x@x.example', 'X', 'admin', null)`), /row-level security|Invalid|check constraint/);
});
