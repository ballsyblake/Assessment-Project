import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLE = { club: 'app_club', assessor: 'app_assessor', admin: 'app_admin' };

export let db;

export async function openDb({ dataDir = dataDirDefault(), memory = false } = {}) {
  const fresh = memory || !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (!memory) fs.mkdirSync(dataDir, { recursive: true });
  db = memory ? new PGlite() : new PGlite(dataDir);
  await db.waitReady;
  if (fresh) {
    await db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  }
  return { db, fresh };
}

// Fingerprint of the schema and framework file, stored with the data so a demo can detect drift.
export function schemaVersion() {
  const fw = process.env.FRAMEWORK_FILE ?? path.join(here, '..', 'data', 'frameworks', 'fq-tier1-2027.json');
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(here, 'schema.sql'))).update(fs.readFileSync(fw)).digest('hex').slice(0, 16);
}

export const dataDirDefault = () => process.env.DATA_DIR ?? path.join(here, '..', 'data', 'pgdata');

// Demo only: wipe the database files and start again.
export async function resetDb() {
  const dir = dataDirDefault();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return openDb({ dataDir: dir });
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
