// Magic link + emailed code login (spec section 2).
// - Only a SHA-256 hash of the long random link token is stored, with expiry and
//   revoked / last-used markers server side.
// - Opening a link asks the person to confirm their email; a 6 digit code is then
//   emailed, so a forwarded link alone is not enough.
// - Issuing a new link revokes every previous link for that user.
// - Club sessions last longer than assessor/admin sessions.
import crypto from 'node:crypto';
import { sys } from './db.js';
import { sendMail } from './mail.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const LINK_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const SESSION_HOURS = { club: 24 * 7, assessor: 8, admin: 8 };

export function baseUrl() {
  return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

export async function issueLink(userId) {
  const db = sys();
  const { rows: [u] } = await db.query('select * from users where id = $1 and active', [userId]);
  if (!u) throw new Error('Unknown or inactive user');
  await db.query('update magic_links set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `insert into magic_links(user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha(token), LINK_DAYS],
  );
  const url = `${baseUrl()}/auth/link/${token}`;
  await sendMail(u.email, 'Your Club Assessment Platform sign-in link',
    `Hello ${u.name},\n\nUse this personal link to sign in. It expires in ${LINK_DAYS} days and any earlier link has been cancelled.\n\n${url}\n\nYou will be asked to confirm your email address and enter a code we send you. Do not forward this link.`);
  return url;
}

async function findLink(token) {
  const { rows: [l] } = await sys().query(
    `select l.*, u.email, u.name, u.role, u.active from magic_links l join users u on u.id = l.user_id
     where l.token_hash = $1`, [sha(token)]);
  if (!l || l.revoked_at || new Date(l.expires_at) < new Date() || !l.active) return null;
  return l;
}

export async function linkValid(token) {
  return Boolean(await findLink(token));
}

// Step 1: person confirms their email. If it matches the link owner, email a code.
export async function requestCode(token, email) {
  const l = await findLink(token);
  if (!l) return { ok: false, error: 'This link is no longer valid. Ask FQ for a new one.' };
  if (String(email).trim().toLowerCase() !== l.email) {
    return { ok: false, error: 'That email does not match this link.' };
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await sys().query('update login_codes set used_at = now() where link_id = $1 and used_at is null', [l.id]);
  await sys().query(
    `insert into login_codes(link_id, code_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
    [l.id, sha(`${l.id}:${code}`), CODE_MINUTES]);
  await sendMail(l.email, `Your sign-in code: ${code}`,
    `Your Club Assessment Platform sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.`);
  return { ok: true };
}

// Step 2: verify the code, create a session.
export async function verifyCode(token, code) {
  const l = await findLink(token);
  if (!l) return { ok: false, error: 'This link is no longer valid. Ask FQ for a new one.' };
  const db = sys();
  const { rows: [c] } = await db.query(
    `select * from login_codes where link_id = $1 and used_at is null order by id desc limit 1`, [l.id]);
  if (!c || new Date(c.expires_at) < new Date()) return { ok: false, error: 'Code expired. Request a new one.' };
  if (c.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: 'Too many attempts. Request a new code.' };
  const good = crypto.timingSafeEqual(Buffer.from(sha(`${l.id}:${String(code).trim()}`)), Buffer.from(c.code_hash));
  if (!good) {
    await db.query('update login_codes set attempts = attempts + 1 where id = $1', [c.id]);
    return { ok: false, error: 'Incorrect code.' };
  }
  await db.query('update login_codes set used_at = now() where id = $1', [c.id]);
  await db.query('update magic_links set last_used_at = now() where id = $1', [l.id]);
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const hours = SESSION_HOURS[l.role];
  await db.query(
    `insert into sessions(token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))`,
    [sha(sessionToken), l.user_id, hours]);
  return { ok: true, sessionToken, maxAgeMs: hours * 3600 * 1000, role: l.role };
}

export async function userForSession(sessionToken) {
  if (!sessionToken) return null;
  const { rows: [u] } = await sys().query(
    `select u.id, u.email, u.name, u.role, u.club_id, u.is_primary
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and u.active`, [sha(sessionToken)]);
  return u ?? null;
}

export async function endSession(sessionToken) {
  if (sessionToken) await sys().query('delete from sessions where token_hash = $1', [sha(sessionToken)]);
}
