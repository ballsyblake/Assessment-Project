// OneDrive copy through Power Automate: queue, email format, size limit, retries.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, sys } from '../src/db.js';
import { seed } from '../src/seed.js';

let mirror; let mailer;
before(async () => {
  Object.assign(process.env, { MAIL_TRANSPORT: 'json', MIRROR_TO: 'me@example.org', MIRROR_MAX_MB: '1' });
  await openDb({ memory: true });
  await seed({ issueLinks: false });
  mirror = await import('../src/mirror.js');
  mailer = await import('../src/mailer.js');
});

test('copies are emailed with the OneDrive folder in the subject and a unique file name', async () => {
  const { rows: [f] } = await sys().query(
    `select f.id, f.filename from files f join clubs c on c.id = f.club_id where c.name = 'Riverside Rovers FC' and f.req_id = 'D1' limit 1`);
  await mirror.enqueue([f.id]);
  assert.equal(await mirror.processQueue(), 1);
  const m = mailer.captured.at(-1);
  assert.equal(m.to, 'me@example.org');
  assert.equal(m.subject, '[ClubAssessment] Club Assessment 2027/Riverside Rovers FC/Delivery/D1 Attendance and Game Time Record');
  assert.equal(m.attachments[0].filename, f.filename.replace(/\.pdf$/, ` (${f.id}).pdf`));
  assert.ok(m.attachments[0].content.subarray(0, 4).toString() === '%PDF');
  // queued once only
  await mirror.enqueue([f.id]);
  assert.equal(await mirror.processQueue(), 0);
});

test('staff certificates go to a per-person certificates folder', async () => {
  const { rows: [f] } = await sys().query(`select f.id, s.person from files f join staff_rows s on s.id = f.staff_row_id limit 1`);
  await mirror.enqueue([f.id]);
  await mirror.processQueue();
  assert.match(mailer.captured.at(-1).subject, new RegExp(`/Staff Qualifications/Certificates - ${f.person}$`));
});

test('files over the size limit are skipped and reported', async () => {
  const { rows: [f] } = await sys().query(`select id from files where storage = 'db' and id not in (select file_id from mirror_queue) limit 1`);
  await sys().query('update files set size = $2, data = $3 where id = $1', [f.id, 2 * 1024 * 1024, Buffer.alloc(2 * 1024 * 1024)]);
  await mirror.enqueue([f.id]);
  await mirror.processQueue();
  const st = await mirror.status();
  assert.equal(st.counts.skipped, 1);
  assert.match(st.problems[0].last_error, /Larger than 1 MB/);
});

test('failed sends are retried, then marked failed after five attempts', async () => {
  Object.assign(process.env, { MAIL_TRANSPORT: '', RESEND_API_KEY: 'x', RESEND_BASE: 'http://127.0.0.1:9/emails' });
  const { rows: [f] } = await sys().query(`select id from files where id not in (select file_id from mirror_queue) limit 1`);
  await mirror.enqueue([f.id]);
  for (let i = 0; i < 5; i++) await mirror.processQueue();
  const { rows: [q] } = await sys().query('select status, attempts from mirror_queue where file_id = $1', [f.id]);
  assert.deepEqual([q.status, q.attempts], ['failed', 5]);
  assert.equal(await mirror.retryFailed(), 1);
});

test('backfill queues every file not yet copied', async () => {
  Object.assign(process.env, { MAIL_TRANSPORT: 'json', RESEND_API_KEY: '' });
  const n = await mirror.backfill();
  const { rows: [{ total }] } = await sys().query('select count(*)::int total from files');
  const { rows: [{ queued }] } = await sys().query('select count(*)::int queued from mirror_queue');
  assert.equal(queued, total);
  assert.ok(n > 0);
});
