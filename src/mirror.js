// OneDrive copy through Power Automate (no Azure app registration needed).
// Each uploaded file is emailed to MIRROR_TO with the destination folder in the subject:
//   [ClubAssessment] Club Assessment 2027/Riverside Rovers FC/Delivery/D5 Return To Play Process
// A Power Automate flow in that mailbox saves the attachment into the same path in OneDrive.
// The platform keeps the master copy; the OneDrive copy is one-way (removals are not copied).
//
//   MIRROR_TO       mailbox the flow watches (required to switch this on)
//   MIRROR_MAX_MB   larger files are skipped and listed for manual copying (default 20)
import { sys } from './db.js';
import { framework, sectionLabel } from './catalog.js';
import { deliver, mailerConfigured } from './mailer.js';
import { readFile, safeName } from './storage.js';
import { sendMail } from './mail.js';

export const MARKER = '[ClubAssessment]';
const MAX_ATTEMPTS = 5;
const maxBytes = () => Number(process.env.MIRROR_MAX_MB ?? 20) * 1024 * 1024;
const cycle = () => (String(framework.id).match(/\d{4}/) ?? [new Date().getFullYear()])[0];
export const mirrorEnabled = () => Boolean(process.env.MIRROR_TO) && mailerConfigured();

export async function enqueue(fileIds) {
  if (!mirrorEnabled() || !fileIds.length) return;
  for (const id of fileIds) await sys().query('insert into mirror_queue(file_id) values ($1) on conflict (file_id) do nothing', [id]);
}

// Queue every file that has never been copied (e.g. after switching this on).
export async function backfill() {
  const { rowCount } = await sys().query(
    `insert into mirror_queue(file_id) select id from files f where not exists (select 1 from mirror_queue m where m.file_id = f.id)`);
  return rowCount;
}

export function folderFor(f) {
  return [`Club Assessment ${cycle()}`, f.club,
    f.req_id ? sectionLabel(f.section) : 'Staff Qualifications',
    f.req_id ? `${f.req_id} ${f.req_name}` : `Certificates - ${f.person}`].map(safeName).join('/');
}
// Keep the original name, made unique so the flow never collides with an earlier upload.
export function fileNameFor(f) {
  const n = safeName(f.filename);
  const dot = n.lastIndexOf('.');
  return dot > 0 ? `${n.slice(0, dot)} (${f.id})${n.slice(dot)}` : `${n} (${f.id})`;
}

let running = false;
export async function processQueue() {
  if (running || !mirrorEnabled()) return 0;
  running = true;
  let sent = 0;
  try {
    const { rows } = await sys().query(
      `select m.id qid, m.attempts, f.id, f.filename, f.mime, f.size, f.data, f.storage, f.storage_key, f.req_id,
              c.name club, q.name req_name, q.section, s.person, u.name uploader
       from mirror_queue m join files f on f.id = m.file_id join clubs c on c.id = f.club_id
       left join requirements q on q.id = f.req_id left join staff_rows s on s.id = f.staff_row_id
       left join users u on u.id = f.uploaded_by
       where m.status = 'pending' and m.attempts < $1 order by m.id limit 20`, [MAX_ATTEMPTS]);
    for (const f of rows) {
      try {
        if (f.size > maxBytes()) {
          await sys().query(`update mirror_queue set status = 'skipped', last_error = $2 where id = $1`,
            [f.qid, `Larger than ${process.env.MIRROR_MAX_MB ?? 20} MB: copy it to OneDrive by hand`]);
          continue;
        }
        const folder = folderFor(f);
        await deliver({
          to: process.env.MIRROR_TO,
          subject: `${MARKER} ${folder}`,
          text: `Club: ${f.club}\nItem: ${f.req_id ? `${f.req_id} ${f.req_name}` : `Staff certificate: ${f.person}`}\nUploaded by: ${f.uploader}\nFolder: ${folder}\n\nSent automatically by the Club Assessment platform for the OneDrive copy.`,
          attachments: [{ filename: fileNameFor(f), content: await readFile(f), contentType: f.mime }],
        });
        await sys().query(`update mirror_queue set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $1`, [f.qid]);
        sent++;
      } catch (e) {
        const attempts = f.attempts + 1;
        await sys().query(`update mirror_queue set attempts = $2, last_error = $3, status = $4 where id = $1`,
          [f.qid, attempts, String(e.message).slice(0, 300), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending']);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

export async function status() {
  const { rows } = await sys().query('select status, count(*)::int n from mirror_queue group by status');
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const { rows: problems } = await sys().query(
    `select m.status, m.last_error, m.attempts, f.filename, c.name club from mirror_queue m join files f on f.id = m.file_id join clubs c on c.id = f.club_id
     where m.status in ('failed','skipped') or (m.status = 'pending' and m.attempts > 0) order by m.id desc limit 20`);
  return { counts, problems };
}

export async function retryFailed() {
  const { rowCount } = await sys().query(`update mirror_queue set status = 'pending', attempts = 0 where status = 'failed'`);
  return rowCount;
}

export async function sendTest() {
  await deliver({
    to: process.env.MIRROR_TO,
    subject: `${MARKER} Club Assessment ${cycle()}/Connection test`,
    text: 'Test from the Club Assessment platform. If your flow is set up, test.txt appears in OneDrive under Club Assessment / Connection test.',
    attachments: [{ filename: 'test.txt', content: Buffer.from(`Club Assessment test ${new Date().toISOString()}`), contentType: 'text/plain' }],
  });
  await sendMail(process.env.MIRROR_TO, `${MARKER} test sent`, 'A test copy was emailed for the Power Automate flow.');
}

// Background worker: tries the queue every 30 seconds.
export function startMirrorWorker() {
  const t = setInterval(() => { processQueue().catch((e) => console.error('mirror', e.message)); }, 30_000);
  t.unref();
}
