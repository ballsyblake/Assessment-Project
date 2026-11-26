import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb, sys, asUser, resetDb, schemaVersion } from './db.js';
import { seed, autoComplete } from './seed.js';
import { readFile } from './storage.js';
import { startMirrorWorker } from './mirror.js';
import { layout, html, NAV, fmtDate } from './html.js';
import { linkValid, requestCode, verifyCode, userForSession, endSession, issueLink, secureCookies } from './auth.js';
import clubRoutes from './routes/club.js';
import reviewRoutes from './routes/review.js';
import assessorRoutes from './routes/assessor.js';
import adminRoutes from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.env.DEMO_MODE !== '0';
const COOKIE = 'cap_session';

export async function createApp(opts = {}) {
  const { fresh } = await openDb(opts);
  if (fresh) await seed();
  else if (DEMO) {
    // Demo deployments: if the schema or framework changed since the data was created,
    // rebuild the demo database so an update never leaves the live demo broken.
    const { rows } = await sys().query(`select value from settings where key = 'schema_version'`).catch(() => ({ rows: [] }));
    if (rows[0]?.value !== schemaVersion()) {
      console.log('Schema or framework changed: rebuilding demo data');
      await resetDb();
      await seed();
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the hosting provider's HTTPS proxy
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use('/static', express.static(path.join(here, '..', 'public')));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Optional site-wide password (set SITE_PASSWORD). Required for any public demo:
  // without it anyone with the address could use the demo mailbox to sign in as the admin.
  // Trimmed so a stray space or line break pasted into the hosting dashboard doesn't lock everyone out.
  const SITE_PASSWORD = process.env.SITE_PASSWORD?.trim();
  if (SITE_PASSWORD) {
    const GATE = 'cap_site';
    const token = crypto.createHmac('sha256', SITE_PASSWORD).update('site-access-v1').digest('hex');
    const ok = (v) => typeof v === 'string' && v.length === token.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(token));
    const page = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Club Assessment</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&family=Barlow+Semi+Condensed:wght@500;600;700&display=swap"><link rel="stylesheet" href="/static/style.css"></head><body>
      <main class="wrap"><div class="login card"><h1>Club Assessment prototype</h1><p>Enter the access password you were given.</p>
      ${error ? '<div class="flash err">Incorrect password.</div>' : ''}
      <form method="post" action="/site-access"><p><input type="password" name="password" required autofocus style="width:100%"></p>
      <button>Continue</button></form></div></main></body></html>`;
    app.post('/site-access', express.urlencoded({ extended: false }), async (req, res) => {
      const given = crypto.createHmac('sha256', SITE_PASSWORD).update('site-access-v1').digest('hex');
      const candidate = crypto.createHmac('sha256', String(req.body.password ?? '').trim()).update('site-access-v1').digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(candidate))) {
        await new Promise((r) => setTimeout(r, 800)); // slow down guessing
        return res.status(401).send(page(true));
      }
      res.cookie(GATE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 30 * 864e5 });
      res.redirect('/');
    });
    app.use((req, res, next) => (ok(req.cookies[GATE]) ? next() : res.status(401).send(page(false))));
  }

  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin'); // magic link tokens never leave in Referer headers to other sites
    next();
  });

  // Basic CSRF defence: session cookie is SameSite=Lax and POSTs must come from our own origin.
  app.use((req, res, next) => {
    if (req.method === 'POST') {
      const origin = req.get('origin');
      let host = null;
      try { host = origin ? new URL(origin).host : req.get('host'); } catch { host = null; }
      if (host !== req.get('host')) return res.status(403).send('Cross-site request blocked');
    }
    next();
  });

  app.use(async (req, res, next) => {
    try {
      req.user = await userForSession(req.cookies[COOKIE]);
      res.page = (title, body, extra = {}) => res.send(String(layout({
        title, user: req.user, nav: req.user ? NAV[req.user.role] : [], active: extra.active ?? req.baseUrl + req.path,
        body, flash: req.query.msg, error: extra.error ?? req.query.err,
      })));
      // Run fn inside a transaction as the signed-in user's DB role (RLS applies).
      req.db = (fn, reason) => asUser(req.user, fn, reason);
      next();
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- auth
  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.redirect({ club: '/club', assessor: '/assessor', admin: '/admin' }[req.user.role]);
  });

  app.get('/login', (req, res) => res.page('Sign in', html`<div class="login card">
    <h1>Sign in</h1>
    <p>This platform has no passwords. Open the personal sign-in link FQ emailed to you, confirm your email address,
    and enter the code we send.</p>
    <p class="muted small">Club contacts: lost your link? Contact your FQ Club Development Ambassador.
    Assessors: ask an FQ admin to issue a new link. Issuing a new link cancels the old one.</p>
    ${DEMO ? html`<div class="notice"><strong>Prototype:</strong> emails are not sent. Use the <a href="/dev">demo mailbox</a>
      to send yourself a link as any demo user.</div>` : ''}
  </div>`));

  app.get('/auth/link/:token', async (req, res) => {
    if (!(await linkValid(req.params.token))) {
      return res.page('Link expired', html`<div class="login card"><h1>Link not valid</h1>
        <p>This sign-in link has expired or been replaced by a newer one. Ask FQ to send you a new link.</p></div>`);
    }
    res.page('Confirm your email', html`<div class="login card"><h1>Confirm your email</h1>
      <p>Enter the email address this link was sent to. We will email you a 6 digit code.</p>
      <form method="post" action="/auth/link/${req.params.token}/email">
        <p><input type="email" name="email" required autocomplete="email" style="width:100%" placeholder="you@club.example"></p>
        <button>Send code</button></form></div>`);
  });

  app.post('/auth/link/:token/email', async (req, res) => {
    const r = await requestCode(req.params.token, req.body.email);
    if (!r.ok) {
      return res.page('Confirm your email', html`<div class="login card"><h1>Confirm your email</h1>
        <div class="flash err">${r.error}</div><p><a href="/auth/link/${req.params.token}">Try again</a></p></div>`);
    }
    res.page('Enter code', codeForm(req.params.token));
  });

  app.post('/auth/link/:token/code', async (req, res) => {
    const r = await verifyCode(req.params.token, req.body.code);
    if (!r.ok) return res.page('Enter code', codeForm(req.params.token, r.error));
    res.cookie(COOKIE, r.sessionToken, { httpOnly: true, sameSite: 'lax', maxAge: r.maxAgeMs, secure: secureCookies() });
    res.redirect('/');
  });

  app.post('/logout', async (req, res) => {
    await endSession(req.cookies[COOKIE]);
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  // ---------------------------------------------------------------- demo mailbox (prototype only)
  if (DEMO) {
    app.get('/dev', async (req, res) => {
      const { rows: users } = await sys().query(
        `select u.id, u.name, u.email, u.role, c.name as club from users u left join clubs c on c.id = u.club_id where u.active order by u.role, u.id`);
      const { rows: mail } = await sys().query('select * from emails order by id desc limit 30');
      const linkify = (body) => body.split(/(https?:\/\/\S+)/g).map((p, i) => (i % 2 ? html`<a href="${p}">${p}</a>` : p));
      res.page('Demo mailbox', html`
        <h1>Demo mailbox</h1>
        <p class="sub">Stands in for email in the prototype. Send a fresh sign-in link to any demo user, then open it below.
        Sending a new link cancels the previous one, exactly as in production.</p>
        <div class="tablewrap"><table><tr><th>Person</th><th>Role</th><th>Email</th><th></th></tr>
        ${users.map((u) => html`<tr><td>${u.name}</td><td>${u.role}${u.club ? html`, ${u.club}` : ''}</td><td class="mono">${u.email}</td>
          <td><form method="post" action="/dev/send/${u.id}"><button class="small">Send sign-in link</button></form></td></tr>`)}
        </table></div>
        <div class="card"><strong>Demo shortcut</strong>
          <p class="small muted">Completes every open phase with dummy scores, third assessments and lead comments, so the release and the
          club results page can be shown. Use it only after walking through the parts you want to demonstrate by hand.</p>
          <div class="row"><form method="post" action="/dev/fast-forward" onsubmit="return confirm('Complete all open phases with dummy data?')"><button class="small secondary">Fast-forward to release</button></form>
          <form method="post" action="/dev/reset" onsubmit="return confirm('Wipe all data and go back to the starting demo state?')"><button class="small danger">Reset demo data</button></form></div></div>
        <h2>Outbox (latest 30)</h2>
        ${mail.map((m) => html`<div class="card"><div class="row"><strong>${m.subject}</strong><span class="spacer"></span>
          <span class="muted small">to ${m.to_addr}, ${fmtDate(m.created_at)}</span></div>
          <div class="mail">${linkify(m.body)}</div></div>`)}`, { active: '/dev' });
    });
    app.post('/dev/fast-forward', async (req, res) => {
      const { rows } = await sys().query('select id from phases where closed_at is null order by sort');
      await autoComplete({ phases: rows.map((r) => r.id), seed: 99 });
      res.redirect('/dev?msg=' + encodeURIComponent('All phases completed and closed. Sign in as the admin to release results.'));
    });
    app.post('/dev/reset', async (req, res) => {
      await resetDb();
      await seed();
      res.clearCookie(COOKIE);
      res.redirect('/dev?msg=' + encodeURIComponent('Demo data reset to the starting state. Everyone has been signed out.'));
    });
    app.post('/dev/send/:id', async (req, res) => {
      await issueLink(Number(req.params.id));
      res.redirect('/dev?msg=' + encodeURIComponent('Link sent. Open it from the outbox below.'));
    });
  }

  // ---------------------------------------------------------------- role areas
  const need = (...roles) => (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.status(403).page('Not allowed', html`<h1>Not allowed</h1>`);
    next();
  };
  app.use('/club', need('club'), clubRoutes());
  app.use('/review', need('assessor', 'admin'), reviewRoutes());
  app.use('/assessor', need('assessor'), assessorRoutes());
  app.use('/admin', need('admin'), adminRoutes());

  // File download: any signed-in role; RLS decides whether the row is visible.
  app.get('/files/:id', need('club', 'assessor', 'admin'), async (req, res) => {
    const f = await req.db(async (tx) => (await tx.query('select filename, mime, data, storage, storage_key from files where id = $1', [Number(req.params.id)])).rows[0]);
    if (!f) return res.status(404).page('Not found', html`<h1>File not found</h1>`);
    const bytes = await readFile(f); // database or OneDrive; access was checked above
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
    res.send(bytes);
  });

  app.use((req, res) => res.status(404).page('Not found', html`<h1>Not found</h1>`));

  // Database permission / trigger errors become readable messages.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const msg = String(err?.message ?? err);
    const denied = /row-level security|permission denied/i.test(msg);
    // P0001 = raised by our own triggers: a business-rule message meant for the user.
    if (!denied && err?.code !== 'P0001' && !(err instanceof Error && err.constructor === Error)) console.error(err);
    const text = denied ? 'You do not have access to do that.' : msg.replace(/^error: /i, '');
    const back = req.get('referer');
    if (req.method === 'POST' && back) {
      const u = new URL(back);
      u.searchParams.delete('msg');
      u.searchParams.set('err', text);
      return res.redirect(u.pathname + u.search);
    }
    res.status(denied ? 403 : 400);
    if (res.page) return res.page('Error', html`<h1>Something went wrong</h1><p>${text}</p>`);
    res.send(text);
  });
  return app;
}

function codeForm(token, error) {
  return html`<div class="login card"><h1>Enter your code</h1>
    ${error ? html`<div class="flash err">${error}</div>` : ''}
    <p>We emailed a 6 digit code to your address. It expires in 10 minutes.</p>
    <form method="post" action="/auth/link/${token}/code">
      <p><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" style="width:160px;font-size:22px;letter-spacing:4px"></p>
      <button>Sign in</button></form>
    <p class="small muted">No code? <a href="/auth/link/${token}">Request another</a>.</p></div>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const app = await createApp();
  startMirrorWorker();
  app.listen(port, () => console.log(`Club Assessment prototype on http://localhost:${port}${DEMO ? '  (demo mailbox: /dev)' : ''}`));
}
