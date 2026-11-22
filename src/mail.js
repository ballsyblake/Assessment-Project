// Prototype mail sink: messages are written to the `emails` table and shown at
// /dev/outbox. Swap sendMail for a real provider (SES, Graph API, SMTP) later.
import { sys } from './db.js';

export async function sendMail(to, subject, body) {
  await sys().query('insert into emails(to_addr, subject, body) values ($1, $2, $3)', [to, subject, body]);
  if (process.env.LOG_MAIL) console.log(`[mail] to=${to} subject=${subject}`);
}
