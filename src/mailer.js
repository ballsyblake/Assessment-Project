// Real email delivery (used for evidence copies to Power Automate; not for demo sign-in mail).
//   RESEND_API_KEY            Resend's HTTPS API (works on hosts that block SMTP ports)
//   MAIL_FROM                 sender, e.g. "Club Assessment <onboarding@resend.dev>"
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE   any SMTP service instead
//   MAIL_TRANSPORT=json       tests: capture messages instead of sending
import nodemailer from 'nodemailer';

export const captured = [];
export const mailerConfigured = () => Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST || process.env.MAIL_TRANSPORT === 'json');
export const mailerName = () => (process.env.RESEND_API_KEY ? 'Resend' : process.env.SMTP_HOST ? `SMTP (${process.env.SMTP_HOST})` : process.env.MAIL_TRANSPORT === 'json' ? 'test capture' : 'not set');
const from = () => process.env.MAIL_FROM ?? 'Club Assessment <onboarding@resend.dev>';

export async function deliver({ to, subject, text, attachments = [] }) {
  if (process.env.MAIL_TRANSPORT === 'json') {
    captured.push({ to, subject, text, attachments });
    return;
  }
  if (process.env.RESEND_API_KEY) {
    const r = await fetch(process.env.RESEND_BASE ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from(), to: [to], subject, text,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) }),
    });
    if (!r.ok) throw new Error(`Email service returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (process.env.SMTP_HOST) {
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await t.sendMail({ from: from(), to, subject, text, attachments });
    return;
  }
  throw new Error('No email service is configured.');
}
