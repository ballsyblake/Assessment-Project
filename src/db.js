import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLE = { club: 'app_club', assessor: 'app_assessor', admin: 'app_admin' };

export let db;

export async function openDb({ dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data', 'pgdata'), memory = false } = {}) {
  const fresh = memory || !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  db = memory ? new PGlite() : new PGlite(dataDir);
  await db.waitReady;
  if (fresh) {
    await db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  }
  return { db, fresh };
}

// Trusted system access (auth layer, seeding, outbox). Bypasses RLS as table owner.
export function sys() {
  return db;
}

// Every user-initiated data access goes through here: the transaction switches to
// the user's DB role and sets app.uid so RLS policies apply.
export async function asUser(user, fn, reason = '') {
  if (!user || !ROLE[user.role]) throw new Error('No user');
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${ROLE[user.role]}`);
    await tx.query(`select set_config('app.uid', $1, true), set_config('app.reason', $2, true)`, [String(user.id), reason]);
    return fn(tx);
  });
}

export const num = (v) => (v === null || v === undefined ? null : Number(v));
