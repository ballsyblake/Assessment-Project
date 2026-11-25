# Club Assessment Platform (prototype)

A working prototype that replaces the Excel and SharePoint club development assessment process. It covers club submission, evidence review, blind double scoring by tick criteria, third assessments, club leads (CDAs) and their feedback, phases with deadlines, an admin-only leaderboard, the gated results release, and an audit log. All clubs, people and evidence are fictional.

## Run it

Requires Node 20 or later. There is no database server to install: it uses PGlite, a full Postgres engine running inside Node, so row level security works exactly as on hosted Postgres.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000/dev. Emails are not sent; the demo mailbox stands in for email. Send a sign-in link to any demo user, open it, confirm the email address, then copy the 6 digit code from the mailbox.

```bash
npm run reset
```

Wipes the database (stop the app first). The next start re-seeds it. On a running site, use **Reset demo data** on `/dev` instead.

## Demo state

Six fictional clubs, eight assessors, one data officer and one admin. Each club has a lead.

| Phase | State |
|---|---|
| Planning | Finished and closed. Its leaderboard is visible to the admin |
| Staff Qualifications | Scored and locked. Two Riverside items differ and need a third assessor |
| Non-negotiables | All final. Ready for the admin to close |
| Delivery | Submission period: clubs uploading, assessors can review evidence. Scoring opens after the deadline |
| Outcomes | Submission period |

Suggested walkthrough:

| Sign in as | Try |
|---|---|
| `td@riverside-rovers.example` (club) | Planning is locked after its deadline; upload Delivery evidence; fix the returned D3 |
| `admin@fq-assess.example` | Reconciliation > Riverside > Staff: assign a third assessor. Phases: move the Delivery deadline to yesterday to open scoring |
| The third assessor | My work > Third assessments: see both scores and comments, decide |
| An assessor with Delivery items | My work > club: mark criteria Yes, Partial or No, save, lock |
| `sam.reid@fq-assess.example` (Riverside's lead) | Clubs you lead: final scores per reconciled section, write feedback |
| Admin | Close Non-negotiables, see the Planning leaderboard and the assessor statistics |

To show the release without scoring everything by hand, use **Fast-forward to release** on `/dev`. It completes the open phases with dummy data. Then release as the admin and view the club's results.

## Put it online (Railway)

The repo is ready for Railway (`railway.json`). Railway builds from GitHub and redeploys on every push.

1. Sign up at railway.app with your GitHub account. Choose the Hobby plan, about US$5 a month.
2. **New Project > Deploy from GitHub repo**. Pick `Assessment-Project`. If asked, allow Railway access to the repo.
3. Open the new service, then **Settings > Source**. Set the branch to `claude/compassionate-wright-4yxte6`.
4. **Add a volume** to the service: right-click the service on the canvas, or use the command palette (Ctrl/Cmd+K) and search "volume". Set the mount path to `/data`.
5. **Variables** tab, add:
   - `DATA_DIR` = `/data/pgdata`. The database lives on the volume, so data survives restarts and redeploys.
   - `SITE_PASSWORD` = a password you choose. Required: it guards the whole site, including the demo mailbox.
6. **Settings > Networking > Generate Domain**. Railway gives an `https://...up.railway.app` address, and sign-in links use it automatically. With your own domain, also set `BASE_URL` = `https://your.domain`.
7. Wait for the deploy to show as active, then open the address. Enter the site password, then go to `/dev`.

On the live site, the `/dev` page has **Reset demo data**, which puts everything back to the starting state, and **Fast-forward to release**.

Only share the address and password with people you are demonstrating to. This deployment is for fictional data only: see "Moving to hosted Postgres" before any real FQ data is used.

| Variable | Purpose |
|---|---|
| `SITE_PASSWORD` | Site-wide password gate (strongly recommended on any public address) |
| `DATA_DIR` | Where the database files live (point at the volume) |
| `BASE_URL` | Public address for sign-in links (defaults to Railway's domain, then localhost) |
| `DEMO_MODE` | `0` removes the demo mailbox (`/dev`); only once real email is connected |
| `FRAMEWORK_FILE` | Use a framework file kept outside the repo |

## How it works

**Framework file.** All FQ-specific content lives in `data/frameworks/fq-tier1-2027.json`: line items, weightings, score ranges, tick criteria, outcome bands, thresholds, phases, the partial-planning rule and the O8/O12 rule. The code has no FQ item codes in it. Point `FRAMEWORK_FILE` at a file outside the repo to keep FQ material out of the codebase.

The tick criteria in that file are **placeholders** drafted from the 2027 descriptors, until FQ supplies the final 2027 criteria. The criteria counts follow 2026. Outcome bands come from the 2027 descriptors for O10, O11, O13 and O15, and from the 2026 workbooks for O1 to O7.

**Scoring** (computed by the database, not the browser):
- Tick items: Yes = 1, Partial = 0.5, No = 0. Score = criteria met ÷ number of criteria × item maximum, to one decimal. This is the proportional method, chosen deliberately.
- Outcome value items: the assessor enters the number (players, %, NPS) and the band gives the score.
- Staff items: direct score entry. Non-negotiables: Met or Not met.
- Outcomes have one assessor (data based). Everything else has a first and a second assessor.
- Points = score × weighting. 2027 thresholds: Gold 75%, Silver 60%, Bronze 45%, Development Committed 35%. Failing a non-negotiable caps the rating at the current shield.

**Assignment.** One row per club × item × slot. There are no fixed pairs. Bulk tools assign one item across a pool (evidence items) or several items at one club (a visit). The database blocks the same person holding both slots on an item, and blocks a second slot on single-assessor items. A club's lead may score their own club.

**Reconciliation.**
- An assessor locks a phase at a club once all their items there are scored.
- When both assessors on an item have locked, equal scores become final automatically.
- Any difference needs a third assessor, who can be anyone except the two who scored the item. The third assessor sees both scores, both comments and the criteria marks, checks the evidence, and their score is final.
- Items with equal scores but different criteria marks are flagged to the admin.
- The admin can override with a reason. The admin never scores.

**Phases.** Each section is a phase with its own submission deadline. After the deadline, club uploads lock unless the admin grants an extension (per club and phase) or reopens an item with upload allowed for 7 days. The admin closes a phase once every item at every club is final.

**Staff qualifications.**
- Clubs pick each person's qualification and years held from FQ's lists.
- The platform calculates a suggested score for each Technical Staff item, using FQ's lookup tables and the automatic rules (`src/staffCalc.js`, tables in the framework file). Age groups average over the coaches listed, so no "case" number is needed.
- Assessors see the suggestion with its working, already filled in, and confirm or adjust it. The judgement rules, such as "Other" qualifications and heads coaching in their own phase, remain with them.
- The admin sees the calculated total on the club's Staff tab.
- Checked against the 2026 rubric workbooks: Brisbane Strikers 188 (FQ 188), Brisbane City 204.1 (FQ 203.67), once the sports science category is entered.

**Rolling average (Pools A and C).** Planning items assessed this year score the average of this year and last year. Items not chosen keep last year's score. The report shows both figures.

**Ratings.**
- Non-negotiables NN1 to NN6 are Yes/No compliance items and do not change the rating.
- NN7 to NN9 are shield thresholds. Being on notice for the same one two years running, or for more than one in a year, lowers the shield by one level.
- The admin can override any club's rating on the Release page, with a reason that is shown to the club.

**Reviews.** Review requests and outcomes are handled by FQ's official email. After release and before confirmation, the admin applies each agreed outcome on the Reconciliation page with a note. The club's preliminary report updates, and the item shows "Changed after review (+n)". "Confirm ratings" then makes the ratings final, skipping any club with non-negotiable documents outstanding.

**Top 5 lists.** Suggested automatically: strengths are items at full marks, highest weighting first; areas to improve are those with the most points missed. The lead can replace either list with their own choice on their club page.

**Leads (CDAs).**
- A lead sees their clubs' submission progress, and final scores once a section is reconciled.
- A lead never sees individual assessors' scores.
- A lead writes one comment per section once that section is reconciled, plus an overall comment once everything is reconciled.
- Clubs see the comments only after release.

**Leaderboard and statistics (admin only).**
- A phase's ranking appears once the phase is closed. The full ranking appears when every phase is closed.
- Only final items count.
- Assessor statistics show each assessor's average score, their bias against the final scores on the same items, how often their items went to a third assessor, and their tick differences.

**Release.** One action releases results to every club. It is blocked until the internal deadline has passed, every phase is closed, and every lead comment is written. Clubs see the rating and badge first, then the overall comment, then each section with its comment and line-item table. The page prints to PDF.

**Access control is in the database** (`src/schema.sql`):
- Each request runs as `app_club`, `app_assessor` or `app_admin`, with row level security and column grants.
- Clubs have no access to criteria, assignments, scores, leads, resolutions or the audit log.
- Assessors see only their own slots and scores, and evidence only for items they hold.
- Third assessors see the first and second scores for their item only after both have locked.
- The admin sees score values only on locked items. Score entries in the audit log are sealed the same way.
- Triggers compute scores, enforce deadlines and locks, create final scores, and write the audit log.

**Sign-in.**
- A magic link plus a code emailed to the confirmed address, so a forwarded link alone is not enough.
- Only hashed tokens are stored. A new link revokes the old one.
- Club sessions last 7 days; assessor and admin sessions last 8 hours.

## Tests

```bash
npm test
```

Database tests run as each role (plus unit tests for the scoring engine and the staff calculator), with no UI involved: access, blind scoring, tick and value scoring maths, assignment rules, the lock and third-assessor flow, deadlines and extensions, lead visibility, comment and phase-close gates.

```bash
npm run reset && npm start
```

```bash
BASE=http://localhost:3000 npm run e2e
```

Browser walkthrough of the whole cycle through to release, using Playwright.

## Moving to hosted Postgres

- Replace PGlite in `src/db.js` with a `pg` connection pool, about 40 lines.
- `asUser()` already wraps each request in a transaction with `set local role` and `set_config`.
- The schema, policies and triggers run unchanged.
- The app must connect as a login role that is a member of `app_club`, `app_assessor` and `app_admin` but does not own the tables, because the owner bypasses row level security. Seeding and migrations use a separate owner connection.
- Evidence files are stored in the database today. For production, keep the `files` row (name, size, storage key) and put the bytes in S3 or Azure Blob. Downloads would check the row under RLS, then hand out a short-lived signed URL. This changes the upload routes in `src/routes/club.js` and the download route in `src/server.js`.
- Email: plug a provider into `src/mail.js` and set `DEMO_MODE=0` to remove `/dev`.

## Open items

- **2027 criteria:** replace the placeholder criteria and confirm the O1 to O7 bands when FQ finalises them.
- **Real past club check:** needs one club's final 2026 report, including Staff Qualifications and Non-negotiables.
- **Not built:** the review and appeal process, Tier 2, and the CDA club visit tracker.
- **Leaderboard and results layouts:** waiting on FQ's reference templates.

## Layout

```
data/frameworks/       framework file: items, criteria, bands, thresholds, rules
src/schema.sql         roles, grants, RLS policies, scoring and workflow triggers, audit
src/db.js              PGlite setup and the per-request role switch (asUser)
src/auth.js            magic link + emailed code
src/catalog.js         framework loader
src/scoring.js         points, percentage, rating
src/model.js           shared queries (progress, reconciliation, leaderboard, statistics)
src/seed.js            fictional demo data and the fast-forward helper
src/routes/*.js        club, assessor (incl. third and lead), admin, shared review
test/                  database tests and browser walkthrough
```
