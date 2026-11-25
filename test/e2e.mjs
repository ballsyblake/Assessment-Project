// End-to-end walk through the 2027 flow with a real browser.
// Usage: start the server on a fresh database (npm run reset && npm start), then
//   BASE=http://localhost:3000 node test/e2e.mjs [screenshotDir]
// Add SITE_PASSWORD=... if the server runs with a site password.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
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
  page.on('dialog', (d) => d.accept());
  if (process.env.SITE_PASSWORD) {
    // Pass the site-wide password gate used on public demos.
    await page.goto(`${BASE}/`);
    await page.fill('input[name=password]', process.env.SITE_PASSWORD);
    await Promise.all([page.waitForNavigation(), page.click('button')]);
  }
  return page;
}
async function shot(page, name) {
  if (shots) await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, '0')}-${name}.png`), fullPage: true });
}
function expect(cond, msg) {
  if (!cond) { errors.push(`FAIL: ${msg}`); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`);
}
async function go(page, target) {
  const loc = typeof target === 'string' ? page.locator(target) : target;
  await Promise.all([page.waitForNavigation(), loc.click()]);
}
const flash = async (page) => (await page.locator('.flash').allInnerTexts()).join(' | ');
const text = async (page) => page.locator('main').innerText();

async function login(email) {
  const page = await newPage();
  await page.goto(`${BASE}/dev`);
  await go(page, page.locator('tr', { hasText: email }).locator('button'));
  const link = (await page.content()).match(new RegExp(`to ${email.replace(/\./g, '\\.')}[\\s\\S]*?(http[^"<\\s]+/auth/link/[\\w-]+)`))[1];
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
const emailOf = (name) => `${name.toLowerCase().replace(' ', '.')}@fq-assess.example`;

// Mark every unscored item on an assessor club page: ticks all Yes except one Partial, values/scores mid-range.
async function fillAll(page) {
  const radios = await page.locator('.tick').count();
  for (let i = 0; i < radios; i++) {
    const row = page.locator('.tick').nth(i);
    if (await row.locator('input:checked').count()) continue;
    await row.locator(`input[value=${i % 5 === 0 ? 'p' : 'y'}]`).dispatchEvent('click');
  }
  for (const el of await page.locator('input[name^=s_]:not([disabled]), input[name^=v_]:not([disabled])').all()) {
    if (!(await el.inputValue())) await el.fill('2');
  }
  for (const el of await page.locator('select[name^=s_]:not([disabled])').all()) await el.selectOption('1');
  if (await page.locator('button:has-text("Save my scores")').count()) await go(page, 'button:has-text("Save my scores")');
}

console.log('Sign-in: a forwarded link without the matching email is refused');
{
  const page = await newPage();
  await page.goto(`${BASE}/dev`);
  await go(page, page.locator('tr', { hasText: 'td@riverside-rovers.example' }).locator('button'));
  const link = (await page.content()).match(/(http[^"<\s]+\/auth\/link\/[\w-]+)/)[1];
  await page.goto(link);
  await page.fill('input[name=email]', 'someone.else@example.com');
  await go(page, 'main button');
  expect((await page.content()).includes('does not match'), 'wrong email rejected');
}

console.log('Club: Riverside Rovers during the Delivery submission period');
const club = await login('td@riverside-rovers.example');
await shot(club, 'club-dashboard');
await club.goto(`${BASE}/club/s/planning`);
expect((await text(club)).includes('deadline for this section has passed'), 'planning uploads locked after its deadline');
expect(await club.locator('input[type=file]').count() === 0, 'no upload controls on a closed section');
await club.goto(`${BASE}/club/s/delivery`);
const tmp = path.join(shots ?? process.env.TMPDIR ?? '/tmp', 'e2e-evidence.pdf');
fs.writeFileSync(tmp, '%PDF-1.4\n% dummy evidence\n');
await club.locator('#D4 input[type=file]').setInputFiles(tmp);
await go(club, club.locator('#D4 button', { hasText: 'Upload and submit' }));
expect((await flash(club)).includes('submitted for D4'), 'D4 uploaded in an open phase');
await club.locator('#D3 input[type=file]').setInputFiles(tmp);
await go(club, club.locator('#D3 button', { hasText: 'Upload and resubmit' }));
expect((await club.locator('#D3 .badge').first().innerText()).includes('Submitted'), 'returned D3 resubmitted');
expect((await club.locator('#D8').innerText()).includes('Awaiting FQ assessment'), 'observed item is read-only');
const clubHtml = await club.content();
expect(!/Descriptor|criteria marks|Partial/.test(clubHtml), 'club sees no assessor criteria');
await shot(club, 'club-delivery');
await club.goto(`${BASE}/club/staff`);
expect((await text(club)).includes('deadline for staff qualifications has passed'), 'staff table locked after its deadline');
await club.goto(`${BASE}/club/results`);
expect((await text(club)).includes('not been released'), 'results hidden before release');
for (const p of ['/assessor', '/admin', '/admin/leaderboard']) {
  await club.goto(BASE + p);
  expect((await club.content()).includes('Not allowed'), `club blocked from ${p}`);
}

console.log('Admin: assign a third assessor to a disagreement (Riverside NN9)');
const admin = await login('admin@fq-assess.example');
await shot(admin, 'admin-overview');
await admin.goto(`${BASE}/admin/reconcile`);
await shot(admin, 'admin-reconcile-list');
const disputedLink = admin.locator('a', { hasText: 'need third' }).first();
const href = await disputedLink.getAttribute('href');
await admin.goto(BASE + href);
const row = admin.locator('tr', { hasText: 'Scores differ' }).first();
const itemCode = (await row.locator('td strong').first().innerText()).trim();
const thirdName = (await row.locator('select[name=assessor_id] option').nth(1).innerText()).trim();
await row.locator('select[name=assessor_id]').selectOption({ label: thirdName });
await go(admin, row.locator('button', { hasText: 'Assign' }));
expect((await flash(admin)).includes('Third assessor assigned'), `third assessor ${thirdName} assigned to ${itemCode}`);
await shot(admin, 'admin-reconcile-club');

console.log('Third assessor decides');
const third = await login(emailOf(thirdName));
await third.goto(`${BASE}/assessor`);
await shot(third, 'assessor-my-work');
await go(third, third.locator('tr', { hasText: itemCode }).filter({ hasText: 'Awaiting your decision' }).locator('a', { hasText: 'Open' }));
expect((await third.locator('.stat').count()) === 2, 'third assessor sees both scores and comments');
await shot(third, 'third-assessment');
if (await third.locator('select[name^=s_]').count()) await third.locator('select[name^=s_]').selectOption('1');
else await third.locator('input[name^=s_]').fill('2.5');
await third.locator('textarea').fill('Certificates confirm the higher qualification; second assessor missed the upgrade.');
await go(third, 'button:has-text("Record decision")');
expect((await flash(third)).includes('final score'), 'third assessor decision becomes final');

console.log('Admin opens Delivery scoring; assessors score blind with partial ticks');
await admin.goto(`${BASE}/admin/phases`);
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const delRow = admin.locator('tr', { hasText: 'Delivery' });
await delRow.locator('input[type=date]').fill(yesterday);
await go(admin, delRow.locator('button', { hasText: 'Save' }));
await admin.goto(`${BASE}/admin/club/1?phase=delivery`);
const holders = await admin.locator('#D1 .row .small.muted').innerText();
const [firstName, secondName] = [holders.match(/first: ([^·]+)/)[1].trim(), holders.match(/second: (.+)$/)[1].trim()];
console.log(`  D1 at Riverside: first ${firstName}, second ${secondName}`);

const a1 = await login(emailOf(firstName));
await a1.goto(`${BASE}/assessor/club/1?phase=delivery`);
const n = await a1.locator('#D1 .tick').count();
for (let i = 0; i < n; i++) await a1.locator(`#D1 .tick`).nth(i).locator(`input[value=${i === 0 ? 'p' : i === 1 ? 'n' : 'y'}]`).dispatchEvent('click');
await go(a1, 'button:has-text("Save my scores")');
const expected = Math.round(((n - 2 + 0.5) / n) * 3 * 10) / 10;
const badge = await a1.locator('#D1 .badge', { hasText: 'My score' }).innerText();
expect(badge.includes(`${expected.toLocaleString('en-AU', { maximumFractionDigits: 1 })} / 3`), `D1 score is proportional: ${n - 1.5} of ${n} criteria -> ${expected} (${badge})`);
await shot(a1, 'assessor-scoring');
await fillAll(a1);
await go(a1, 'button:has-text("Lock in Delivery")');
expect((await flash(a1)).includes('locked in'), `${firstName} locked Delivery at Riverside`);

const a2 = await login(emailOf(secondName));
await a2.goto(`${BASE}/assessor/club/1?phase=delivery`);
expect(await a2.locator('#D1 .tick input:checked').count() === 0, 'blind: second assessor sees no marks from the first');
await fillAll(a2);
await go(a2, 'button:has-text("Lock in Delivery")');
expect((await flash(a2)).includes('locked in'), `${secondName} locked Delivery at Riverside`);

console.log('Lead (CDA) writes feedback; never sees individual scores');
const lead = await login('sam.reid@fq-assess.example');
await lead.goto(`${BASE}/assessor/lead/1`);
const leadText = await text(lead);
expect(leadText.includes('Final scores') && !/first assessor|second assessor/i.test(leadText), 'lead sees final scores only');
await lead.locator('form:has(input[value=planning]) textarea').fill('Planning documents are thorough. Next step: link the playing style to each age group.');
await go(lead, lead.locator('form:has(input[value=planning]) button'));
expect((await flash(lead)).includes('comment saved'), 'lead saved Planning comment');
await shot(lead, 'lead-page');
await lead.goto(`${BASE}/admin/leaderboard`);
expect((await lead.content()).includes('Not allowed'), 'lead cannot see the leaderboard');

console.log('Admin: assignment rules, phase close, leaderboard');
await admin.goto(`${BASE}/admin/assignments?phase=outcomes`);
await shot(admin, 'admin-assignments');
await admin.selectOption('select[name=assessor_id]', { label: 'Jordan Lee' });
await admin.selectOption('select[name=slot]', 'second');
await admin.check('input[name=items][value=O10]');
await admin.check('input[name=clubs][value="1"]');
await go(admin, 'button:has-text("Apply to selected")');
expect((await flash(admin)).includes('one assessor only'), 'second slot refused on a data-based item');
await admin.goto(`${BASE}/admin/assignments?phase=delivery`);
await admin.selectOption('select[name=assessor_id]', { label: firstName });
await admin.selectOption('select[name=slot]', 'second');
await admin.check('input[name=items][value=D1]');
await admin.check('input[name=clubs][value="1"]');
await go(admin, 'button:has-text("Apply to selected")');
const f2 = await flash(admin);
expect(f2.includes('0 slot(s) updated') && /same person|already been entered/.test(f2), `bulk assign refuses first assessor as second on the same item (${f2.slice(0, 110)})`);
await admin.goto(`${BASE}/admin/phases`);
await go(admin, admin.locator('tr', { hasText: 'Non-negotiables' }).locator('button', { hasText: 'Close phase' }));
expect((await flash(admin)).includes('closed'), 'Non-negotiables phase closed');
await admin.goto(`${BASE}/admin/leaderboard`);
expect((await text(admin)).includes('Planning') && (await admin.locator('table').count()) >= 1, 'Planning leaderboard visible after its phase closed');
await shot(admin, 'admin-leaderboard');
await admin.goto(`${BASE}/admin/assessors`);
await shot(admin, 'admin-assessors');
await admin.goto(`${BASE}/admin/release`);
expect(await admin.locator('button:has-text("Release results")').isDisabled(), 'release blocked while phases are open');

console.log('Demo fast-forward, then release');
await admin.goto(`${BASE}/dev`);
await go(admin, 'button:has-text("Fast-forward")');
console.log('Lead picks own top 5; admin overrides a rating');
await lead.goto(`${BASE}/assessor/lead/1#highlights`);
const strengthsForm = lead.locator('form:has(input[name=kind][value=strengths])');
while (await strengthsForm.locator('input[name=items]:checked').count()) await strengthsForm.locator('input[name=items]:checked').first().uncheck();
await strengthsForm.locator('input[name=items][value=D1]').check();
await go(lead, strengthsForm.locator('button', { hasText: 'Save my list' }));
expect((await flash(lead)).includes('saved'), 'lead saved own top 5 strengths');
await shot(lead, 'lead-highlights');
await admin.goto(`${BASE}/admin/club/2?phase=staff`);
expect((await text(admin)).includes('Calculated total'), 'admin sees calculated staff qualification total');
await shot(admin, 'admin-staff-calc');
await admin.goto(`${BASE}/admin/release`);
const nRow = admin.locator('tr', { hasText: 'Northgate' });
await nRow.locator('select[name=rating]').selectOption('Gold');
await nRow.locator('input[name=reason]').fill('Exceptional circumstances agreed by the panel');
await go(admin, nRow.locator('button', { hasText: 'Save' }));
expect((await flash(admin)).includes('override saved'), 'rating override saved');
await admin.goto(`${BASE}/admin/release`);
await shot(admin, 'admin-release');
const rel = admin.locator('button:has-text("Release results")');
expect(!(await rel.isDisabled()), 'release enabled once phases closed and comments written');
await go(admin, rel);
expect((await flash(admin)).includes('released'), 'results released');
await admin.goto(`${BASE}/admin/leaderboard`);
expect((await text(admin)).includes('Full ranking'), 'full ranking after every phase closed');
console.log('Review outcome by email, applied before confirmation');
await admin.goto(`${BASE}/admin/reconcile/1?phase=planning&f=all`);
const p1 = admin.locator('tr#P1');
await p1.locator('input[name=score]').fill('3');
await p1.locator('input[name=note]').fill('Review: P1 evidence in the review folder accepted');
await go(admin, p1.locator('button', { hasText: 'Apply review outcome' }));
expect((await flash(admin)).includes('preliminary result has been updated'), 'review outcome republished the preliminary result');

await admin.goto(`${BASE}/admin/release`);
await go(admin, 'button:has-text("Confirm ratings")');
expect((await flash(admin)).includes('confirmed'), `ratings confirmed (${(await flash(admin)).slice(0, 80)})`);
console.log('Club sees results with lead feedback');
await club.goto(`${BASE}/club/results`);
const res = await text(club);
expect(/Club audit summary/.test(res) && res.includes('Next step: link the playing style'), 'club sees the audit summary and the lead comment');
expect(/Top 5 strengths/.test(res) && /Shield threshold standards/.test(res), 'report has top 5 lists and shield thresholds');
expect(/two consecutive years/.test(res), 'Riverside downgrade explained (on notice two years running)');
expect(/Changed after review/.test(res), 'review change shown on the report');
expect((await club.locator('h2:has-text("Top 5 strengths") + .tablewrap').innerText()).includes('D1'), "lead's own top 5 used on the report");
await shot(club, 'club-results');
expect(/Confirmed rating/.test(await text(club)), 'club sees the rating as confirmed');
await club.setViewportSize({ width: 390, height: 844 });
for (const p of ['/club', '/club/results']) {
  await club.goto(BASE + p);
  expect(!(await club.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `no horizontal scroll at phone width on ${p}`);
}

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
