// End-to-end walk through the demo path with a real browser.
// Usage: start the server on a fresh database (npm run reset && npm start), then
//   BASE=http://localhost:3000 node test/e2e.mjs [screenshotDir]
import { createRequire } from 'node:module';
// Uses the globally installed Playwright (or a local devDependency).
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
const errors = [];
let step = 0;

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  return page;
}
async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, '0')}-${name}.png`), fullPage: true });
}
function expect(cond, msg) {
  if (!cond) { errors.push(`FAIL: ${msg}`); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`);
}
// Click something that submits a form and wait for the resulting page load.
async function go(page, target) {
  const loc = typeof target === 'string' ? page.locator(target) : target;
  await Promise.all([page.waitForNavigation(), loc.click()]);
}
const flash = async (page) => (await page.locator('.flash').allInnerTexts()).join(' | ');

async function login(email) {
  const page = await newPage();
  await page.goto(`${BASE}/dev`);
  await page.locator('tr', { hasText: email }).locator('button').click();
  await page.waitForURL(/msg=/);
  const body = await page.content();
  const link = body.match(new RegExp(`to ${email.replace(/\./g, '\\.')}[\\s\\S]*?(http[^"<\\s]+/auth/link/[\\w-]+)`))[1];
  await page.goto(link);
  await page.fill('input[name=email]', email);
  await go(page, 'main button');
  const dev = await page.context().newPage();
  await dev.goto(`${BASE}/dev`);
  const code = (await dev.content()).match(/Your sign-in code: (\d{6})/)[1];
  await dev.close();
  await page.fill('input[name=code]', code);
  await go(page, 'main button');
  return page;
}

console.log('Forwarded link without the matching email is refused');
{
  const page = await newPage();
  await page.goto(`${BASE}/dev`);
  await page.locator('tr', { hasText: 'td@riverside-rovers.example' }).locator('button').click();
  await page.waitForURL(/msg=/);
  const link = (await page.content()).match(/(http[^"<\s]+\/auth\/link\/[\w-]+)/)[1];
  await page.goto(link);
  await page.fill('input[name=email]', 'someone.else@example.com');
  await go(page, 'main button');
  expect((await page.content()).includes('does not match'), 'wrong email rejected');
  const r = await page.request.get(`${BASE}/club`, { maxRedirects: 0 });
  expect(r.status() === 302, 'no session created');
}

console.log('Club: Riverside Rovers submits evidence');
const club = await login('td@riverside-rovers.example');
expect(club.url().endsWith('/club'), 'club lands on dashboard');
await shot(club, 'club-dashboard');
await club.goto(`${BASE}/club/s/planning`);
await shot(club, 'club-planning');
const tmp = path.join(process.env.TMPDIR ?? '/tmp', 'e2e-evidence.pdf');
fs.writeFileSync(tmp, '%PDF-1.4\n% dummy evidence\n');
await club.locator('#P4 input[type=file]').setInputFiles(tmp);
await go(club, club.locator('#P4 button', { hasText: 'Upload and submit' }));
expect((await flash(club)).includes('submitted for P4'), 'P4 uploaded');
await club.locator('#P3 input[type=file]').setInputFiles(tmp);
await go(club, club.locator('#P3 button', { hasText: 'Upload and resubmit' }));
expect((await club.locator('#P3 .badge').innerText()).includes('Submitted'), 'returned P3 resubmitted');
const html = await club.content();
expect(!html.includes('Assessor criteria') && !/Weighting|weighting/.test(html), 'club page shows no criteria or weightings');
await club.goto(`${BASE}/club/s/delivery`);
expect((await club.locator('#D8').innerText()).includes('Awaiting FQ assessment'), 'on-field item read-only');
expect(await club.locator('#D8 input[type=file]').count() === 0, 'no upload on on-field item');
await club.goto(`${BASE}/club/staff`);
await club.fill('input[name=person]', 'Pat Example');
await club.selectOption('select[name=position]', 'Head of Goalkeeping');
await club.fill('input[name=qualification]', 'AFC GK B Diploma');
await club.locator('input[name=certificate]').setInputFiles(tmp);
await go(club, 'button:has-text("Add and submit")');
expect((await flash(club)).includes('added'), 'staff row added');
await shot(club, 'club-staff');
await club.goto(`${BASE}/club/results`);
expect((await club.content()).includes('not been released'), 'results hidden before release');
for (const p of ['/assessor', '/admin', '/admin/audit']) {
  await club.goto(BASE + p);
  expect((await club.content()).includes('Not allowed'), `club blocked from ${p}`);
}
await club.goto(`${BASE}/club/team`);
await club.fill('input[name=name]', 'Second Person');
await club.fill('input[name=email]', 'second@riverside-rovers.example');
await go(club, 'button:has-text("Send invite")');
expect((await flash(club)).includes('Invitation sent'), 'second contact invited');

console.log('Assessor: Sam (first on Riverside) reviews and scores');
const sam = await login('sam.reid@fq-assess.example');
await shot(sam, 'assessor-my-clubs');
await sam.goto(`${BASE}/assessor/club/1?s=planning`);
await go(sam, sam.locator('#P1 button[value=verified]'));
expect((await flash(sam)).includes('verified'), 'P1 verified');
await sam.locator('#P4 input[name=comment]').fill('Please add the review dates for each player.');
await go(sam, sam.locator('#P4 button[value=returned]'));
expect((await flash(sam)).includes('returned'), 'P4 returned');
await go(sam, sam.locator('#P5 button', { hasText: 'Flag missing' }));
expect((await flash(sam)).includes('flagged'), 'P5 flagged');
for (const [id, v] of [['P1', '2.4'], ['P2', '3.1'], ['P3', '2']]) await sam.fill(`input[name=s_${id}]`, v);
await go(sam, 'button:has-text("Save my scores")');
expect((await flash(sam)).includes('3 score(s) saved'), 'scores saved');
await shot(sam, 'assessor-club-planning');
// Bypass the browser's own max validation to prove the database rejects it.
const over = await sam.request.post(`${BASE}/assessor/club/1/scores`, {
  form: { s_P1: '9', section: 'planning' }, headers: { referer: `${BASE}/assessor/club/1?s=planning` }, maxRedirects: 0 });
expect(decodeURIComponent((over.headers().location ?? '').replace(/\+/g, ' ')).includes('exceeds maximum'), 'score above max rejected by DB');
await sam.goto(`${BASE}/assessor/club/2`);
expect((await sam.content()).includes('not assigned'), 'assessor cannot open unassigned club');
const f = await sam.request.get(`${BASE}/files/40`);
expect(f.status() === 404, 'assessor cannot download unassigned club file');
await sam.goto(`${BASE}/assessor/moderate/2/D8`);
expect((await sam.locator('.stat').count()) === 2, 'moderator sees both locked scores');
await shot(sam, 'moderator');
await sam.fill('input[name=score]', '3.2');
await sam.fill('textarea[name=note]', 'Observation notes support the higher score; consistent delivery across both programs.');
await go(sam, 'button:has-text("Record decision")');
expect((await flash(sam)).includes('recorded'), 'moderator decision recorded');

console.log('Assessor: Jordan (second on Riverside) cannot see Sam\'s scores');
const jordan = await login('jordan.lee@fq-assess.example');
await jordan.goto(`${BASE}/assessor/club/1?s=planning`);
expect((await jordan.inputValue('input[name=s_P2]')) === '', 'blind: second assessor sees empty P2');
expect((await jordan.locator('#P1 .badge').first().innerText()).includes('Approved'), 'shared verification visible');
await jordan.goto(`${BASE}/assessor`);
expect(!(await jordan.locator('tr', { hasText: 'Riverside' }).innerText()).includes('Locked'), 'cannot see other assessor lock state');

console.log('Admin: oversight, reconciliation, release');
const admin = await login('admin@fq-assess.example');
await shot(admin, 'admin-progress');
await admin.goto(`${BASE}/admin/reconcile/1`);
expect((await admin.content()).includes('sealed'), 'admin cannot see Riverside scores before both lock');
await admin.goto(`${BASE}/admin/reconcile/2`);
await shot(admin, 'admin-reconcile');
const rows = admin.locator('tr', { has: admin.locator('form[action$="/resolve"]') });
const n = await rows.count();
expect(n >= 2, `Coastal has ${n} open items`);
for (let i = 0; i < n; i++) {
  const row = rows.first();
  const max = await row.locator('input[name=score]').getAttribute('max');
  await row.locator('input[name=score]').fill(String(Math.min(Number(max), 2.5)));
  await row.locator('select[name=method]').selectOption('consensus');
  await row.locator('input[name=note]').fill('Agreed at moderation meeting');
  await go(admin, row.locator('button', { hasText: 'Resolve' }));
}
expect((await admin.content()).includes('Nothing needs action'), 'Coastal fully reconciled');
await admin.goto(`${BASE}/admin/assignments`);
const fm = admin.locator('form[action="/admin/assignments/1"]');
await fm.locator('select[name=first_id]').selectOption({ label: 'Jordan Lee' });
await fm.locator('select[name=second_id]').selectOption({ label: 'Jordan Lee' });
await go(admin, fm.locator('button'));
expect((await admin.locator('.flash.err').innerText()).includes('same person'), 'same assessor twice blocked');
await admin.goto(`${BASE}/admin/release`);
expect(await admin.locator('button:has-text("Release results")').isDisabled(), 'release blocked while clubs incomplete');
await shot(admin, 'admin-release');
await admin.goto(`${BASE}/admin/results/2`);
await shot(admin, 'admin-result-preview');
await admin.goto(`${BASE}/admin/audit`);
expect((await admin.content()).includes('Agreed at moderation meeting'), 'audit records resolutions with reason');
await shot(admin, 'admin-audit');
for (const p of ['/admin', '/admin/reconcile', '/admin/users', '/admin/settings', '/admin/club/1?s=staff']) {
  await admin.goto(BASE + p);
  expect(!(await admin.content()).includes('Something went wrong'), `admin ${p} renders`);
}

console.log('Finish the cycle: both Riverside & Highland assessors lock, admin resolves, release');
// Make the remaining clubs complete so the release gate opens.
async function finishClub(clubId, firstEmail, secondEmail) {
  for (const email of [firstEmail, secondEmail]) {
    const p = await login(email);
    for (const s of ['staff', 'planning', 'delivery', 'outcomes', 'nn']) {
      await p.goto(`${BASE}/assessor/club/${clubId}?s=${s}`);
      const inputs = p.locator('[name^=s_]:not([disabled])');
      const k = await inputs.count();
      for (let i = 0; i < k; i++) {
        const el = inputs.nth(i);
        if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption('1');
        else if (!(await el.inputValue())) await el.fill(String(Math.min(Number(await el.getAttribute('max')), 2)));
      }
      if (k) await go(p, 'button:has-text("Save my scores")');
    }
    p.once('dialog', (d) => d.accept());
    await go(p, 'button:has-text("Lock in my scores")');
    expect((await flash(p)).includes('locked'), `${email} locked club ${clubId}`);
    await p.context().close();
  }
}
await finishClub(1, 'sam.reid@fq-assess.example', 'jordan.lee@fq-assess.example');
await finishClub(3, 'priya.nair@fq-assess.example', 'chris.doyle@fq-assess.example');
for (const id of [1, 3]) {
  await admin.goto(`${BASE}/admin/reconcile/${id}`);
  const r2 = admin.locator('tr', { has: admin.locator('form[action$="/resolve"]') });
  while (await r2.count()) {
    const row = r2.first();
    await row.locator('input[name=score]').fill('2');
    await row.locator('input[name=note]').fill('Resolved by admin after team discussion');
    await go(admin, row.locator('button', { hasText: 'Resolve' }));
  }
}
await admin.goto(`${BASE}/admin/release`);
const btn = admin.locator('button:has-text("Release results")');
expect(!(await btn.isDisabled()), 'release enabled once every club is complete');
admin.once('dialog', (d) => d.accept());
await go(admin, btn);
expect((await flash(admin)).includes('released'), 'results released');

console.log('Club sees results');
await club.goto(`${BASE}/club/results`);
const res = await club.content();
expect(/Total score/.test(res) && /(GOLD|SILVER|BRONZE|DEVELOPMENT|NOT RATED)/.test(res), 'club sees rating and total');
await shot(club, 'club-results');
await club.setViewportSize({ width: 390, height: 844 });
await club.goto(`${BASE}/club`);
await shot(club, 'club-dashboard-mobile');
const overflow = await club.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
expect(!overflow, 'no horizontal scroll at phone width');

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
