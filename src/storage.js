// Where uploaded evidence is kept.
//
//   db        - file bytes in the database (default; demo data always lives here)
//   onedrive  - a OneDrive for Business folder, written through Microsoft Graph after an
//               admin signs in once (delegated). The same code works for an FQ SharePoint
//               document library later by pointing the drive at the site instead of /me.
//
// The database always keeps the file record (name, size, uploader, item, storage key), so
// access rules stay in the platform: people open files through /files/:id, never by a link.
//
// Configuration (environment variables):
//   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT   Entra ID app registration
//   ONEDRIVE_ACCESS = appfolder | folder         appfolder (default): Files.ReadWrite.AppFolder,
//                                                the app only sees Apps/<app name>.
//                                                folder: Files.ReadWrite, files go in ONEDRIVE_FOLDER.
//   ONEDRIVE_FOLDER = "Club Assessment"          root folder name in folder mode
//   SECRET_KEY                                   encrypts the stored sign-in token
//   GRAPH_BASE, LOGIN_BASE                       overridable for tests
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirDefault } from './db.js';
import { baseUrl } from './auth.js';

const GRAPH = () => process.env.GRAPH_BASE ?? 'https://graph.microsoft.com/v1.0';
const LOGIN = () => process.env.LOGIN_BASE ?? 'https://login.microsoftonline.com';
const ACCESS = () => (process.env.ONEDRIVE_ACCESS === 'folder' ? 'folder' : 'appfolder');
const SCOPES = () => `offline_access User.Read ${ACCESS() === 'folder' ? 'Files.ReadWrite' : 'Files.ReadWrite.AppFolder'}`;
const SMALL = 4 * 1024 * 1024;           // simple upload limit
const CHUNK = 320 * 1024 * 16;           // 5 MiB, a multiple of 320 KiB as Graph requires

export const onedriveConfigured = () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
export const redirectUri = () => `${baseUrl()}/admin/storage/callback`;

// ---------------------------------------------------------------- token file (on the volume, outside the database,
// so a demo reset or schema rebuild does not disconnect OneDrive)
const tokenFile = () => process.env.STORAGE_TOKEN_FILE ?? path.join(path.dirname(dataDirDefault()), 'onedrive-connection.json');
const key = () => crypto.createHash('sha256').update(process.env.SECRET_KEY ?? `${process.env.MS_CLIENT_SECRET ?? ''}:storage`).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
export function readConnection() {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    return { ...raw, refreshToken: decrypt(raw.refreshToken) };
  } catch { return null; }
}
function writeConnection(c) {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify({ ...c, refreshToken: encrypt(c.refreshToken) }), { mode: 0o600 });
}
export function disconnect() {
  try { fs.unlinkSync(tokenFile()); } catch { /* already gone */ }
  cached = null;
}

// ---------------------------------------------------------------- sign-in (authorisation code flow)
export function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(),
    response_mode: 'query', scope: SCOPES(), state, prompt: 'select_account',
  });
  return `${LOGIN()}/${process.env.MS_TENANT ?? 'organizations'}/oauth2/v2.0/authorize?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${LOGIN()}/${process.env.MS_TENANT ?? 'organizations'}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: SCOPES(), redirect_uri: redirectUri(), ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Microsoft sign-in failed: ${j.error_description?.split('\n')[0] ?? j.error ?? r.status}`);
  return j;
}

let cached = null; // { token, expires }
export async function completeSignIn(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code });
  cached = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  const me = await graph('GET', '/me?$select=displayName,userPrincipalName');
  const conn = { refreshToken: t.refresh_token, account: me.userPrincipalName, name: me.displayName, access: ACCESS(), connectedAt: new Date().toISOString() };
  writeConnection(conn);
  await rootFolder(); // creates the app folder / root folder and proves write access
  return conn;
}

async function accessToken() {
  if (cached && cached.expires > Date.now()) return cached.token;
  const conn = readConnection();
  if (!conn) throw new Error('OneDrive is not connected. An admin must connect it on the Storage page.');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refreshToken });
  cached = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  if (t.refresh_token && t.refresh_token !== conn.refreshToken) writeConnection({ ...conn, refreshToken: t.refresh_token });
  return cached.token;
}

async function graph(method, url, body, headers = {}, raw = false) {
  const r = await fetch(url.startsWith('http') ? url : `${GRAPH()}${url}`, {
    method, body, redirect: 'follow',
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body && !(body instanceof Buffer) && typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
  if (raw) {
    if (!r.ok) throw new Error(`OneDrive returned ${r.status}`);
    return r;
  }
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OneDrive: ${j.error?.message ?? r.status}`);
  return j;
}

// ---------------------------------------------------------------- folders
const ILLEGAL = /["*:<>?/\\|#%]/g;
export const safeName = (s) => String(s).replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'file';
async function rootFolder() {
  if (ACCESS() === 'appfolder') return graph('GET', '/me/drive/special/approot');
  const name = safeName(process.env.ONEDRIVE_FOLDER ?? 'Club Assessment');
  try { return await graph('GET', `/me/drive/root:/${encodeURIComponent(name)}`); }
  catch { return graph('POST', '/me/drive/root/children', JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' })); }
}
const itemPath = (parts) => parts.map((p) => encodeURIComponent(safeName(p))).join('/');

// ---------------------------------------------------------------- adapters
const dbStore = {
  name: 'db',
  async put({ buffer }) { return { storage: 'db', key: null, data: buffer }; },
  async read(file) { return Buffer.from(file.data); },
  async remove() {},
};

const onedriveStore = {
  name: 'onedrive',
  // folders: Cycle / Club / Section / Item / file
  async put({ folders, filename, buffer }) {
    const root = await rootFolder();
    const rel = `${itemPath([...folders, filename])}`;
    let item;
    if (buffer.length <= SMALL) {
      item = await graph('PUT', `/me/drive/items/${root.id}:/${rel}:/content?@microsoft.graph.conflictBehavior=rename`, buffer, { 'Content-Type': 'application/octet-stream' });
    } else {
      const session = await graph('POST', `/me/drive/items/${root.id}:/${rel}:/createUploadSession`, JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }));
      for (let start = 0; start < buffer.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, buffer.length);
        const r = await fetch(session.uploadUrl, { method: 'PUT', body: buffer.subarray(start, end),
          headers: { 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}` } });
        if (!r.ok) throw new Error(`OneDrive upload failed (${r.status})`);
        if (end === buffer.length) item = await r.json();
      }
    }
    return { storage: 'onedrive', key: item.id, url: item.webUrl ?? null, data: null };
  },
  async read(file) {
    const r = await graph('GET', `/me/drive/items/${file.storage_key}/content`, undefined, {}, true);
    return Buffer.from(await r.arrayBuffer());
  },
  // Deleting moves the file to the OneDrive recycle bin (recoverable for 93 days).
  async remove(file) { await graph('DELETE', `/me/drive/items/${file.storage_key}`).catch(() => {}); },
};

export const isConnected = () => onedriveConfigured() && Boolean(readConnection());
// New uploads go to OneDrive once it is connected; existing files stay where they are.
export const currentStore = () => (isConnected() ? onedriveStore : dbStore);
export const storeFor = (file) => (file.storage === 'onedrive' ? onedriveStore : dbStore);

// Save a buffer and return the columns for the files row.
export async function saveFile({ cycle, club, section, item, filename, buffer }) {
  return currentStore().put({ folders: [`Club Assessment ${cycle}`, club, section, item], filename, buffer });
}
export async function readFile(file) { return storeFor(file).read(file); }
export async function removeFiles(files) {
  for (const f of files) await storeFor(f).remove(f);
}
