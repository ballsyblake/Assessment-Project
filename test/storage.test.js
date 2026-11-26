// OneDrive storage adapter against a simulated Microsoft sign-in and Graph API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const items = new Map();   // id -> { name, path, data }
const sessions = new Map();
let server; let base; let lastScope = '';
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url);
    const data = await body(req);
    if (url.includes('/oauth2/v2.0/token')) {
      lastScope = new URLSearchParams(data.toString()).get('scope');
      return send(res, 200, { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 });
    }
    if (url.startsWith('/upload/')) {
      const s = sessions.get(url.slice(8));
      s.parts.push(data);
      const [, end, total] = req.headers['content-range'].match(/bytes \d+-(\d+)\/(\d+)/);
      if (Number(end) + 1 < Number(total)) return send(res, 202, {});
      const id = `i${items.size + 1}`; items.set(id, { path: s.path, data: Buffer.concat(s.parts) });
      return send(res, 201, { id, webUrl: `https://od/${id}` });
    }
    if (req.headers.authorization !== 'Bearer AT') return send(res, 401, { error: { message: 'no token' } });
    if (url.startsWith('/v1.0/me?')) return send(res, 200, { displayName: 'Test Person', userPrincipalName: 'test@example.org' });
    if (url === '/v1.0/me/drive/special/approot') return send(res, 200, { id: 'root1' });
    let m = url.match(/^\/v1\.0\/me\/drive\/items\/root1:\/(.+):\/content/);
    if (m && req.method === 'PUT') { const id = `i${items.size + 1}`; items.set(id, { path: m[1], data }); return send(res, 201, { id, webUrl: `https://od/${id}` }); }
    m = url.match(/^\/v1\.0\/me\/drive\/items\/root1:\/(.+):\/createUploadSession/);
    if (m) { const sid = `s${sessions.size + 1}`; sessions.set(sid, { path: m[1], parts: [] }); return send(res, 200, { uploadUrl: `${base}/upload/${sid}` }); }
    m = url.match(/^\/v1\.0\/me\/drive\/items\/([^/]+)\/content$/);
    if (m) return items.has(m[1]) ? send(res, 200, items.get(m[1]).data, 'application/octet-stream') : send(res, 404, {});
    m = url.match(/^\/v1\.0\/me\/drive\/items\/([^/]+)$/);
    if (m && req.method === 'DELETE') { items.delete(m[1]); res.writeHead(204); return res.end(); }
    send(res, 404, { error: { message: `unhandled ${req.method} ${url}` } });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    GRAPH_BASE: `${base}/v1.0`, LOGIN_BASE: base, MS_CLIENT_ID: 'cid', MS_CLIENT_SECRET: 'secret', MS_TENANT: 'tenant',
    SECRET_KEY: 'k', STORAGE_TOKEN_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')), 'conn.json'),
  });
});
after(() => server.close());

test('connect, upload small and large files into club folders, read back, delete', async () => {
  const st = await import('../src/storage.js');
  assert.equal(st.isConnected(), false);
  const conn = await st.completeSignIn('code123');
  assert.equal(conn.account, 'test@example.org');
  assert.match(lastScope, /Files\.ReadWrite\.AppFolder/);
  assert.equal(st.isConnected(), true);
  assert.ok(!fs.readFileSync(process.env.STORAGE_TOKEN_FILE, 'utf8').includes('RT2'), 'token is encrypted at rest');

  const small = await st.saveFile({ cycle: '2027', club: 'Riverside Rovers FC', section: 'Delivery', item: 'D4 Sport Science: Monitoring', filename: 'plan.pdf', buffer: Buffer.from('hello') });
  assert.equal(small.storage, 'onedrive');
  assert.equal(items.get(small.key).path, 'Club Assessment 2027/Riverside Rovers FC/Delivery/D4 Sport Science- Monitoring/plan.pdf');
  assert.equal((await st.readFile({ storage: 'onedrive', storage_key: small.key })).toString(), 'hello');

  const bigBuf = Buffer.alloc(11 * 1024 * 1024, 7); // > 4 MB: chunked upload session
  const big = await st.saveFile({ cycle: '2027', club: 'Riverside Rovers FC', section: 'Delivery', item: 'D6', filename: 'video.mp4', buffer: bigBuf });
  assert.equal(sessions.get('s1').parts.length, 3);
  assert.ok((await st.readFile({ storage: 'onedrive', storage_key: big.key })).equals(bigBuf));

  await st.removeFiles([{ storage: 'onedrive', storage_key: small.key }]);
  assert.equal(items.has(small.key), false);
  st.disconnect();
  assert.equal(st.isConnected(), false);
});
