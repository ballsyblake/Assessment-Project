# Club Assessment Platform (prototype)

A working prototype that replaces the Excel and SharePoint club development assessment process. It covers the user flow spec end to end: club submission, evidence review, blind double scoring, reconciliation and moderation, gated results release, and an audit log. Line items, score ranges and weightings come from the FQ 2027 Tier 1 info pack (Appendix 7 and 9). All clubs, people and evidence are fictional.

## Run it

Requires Node 20 or later. There is no database server to install: it uses PGlite, a full Postgres engine that runs inside Node, so row level security works exactly as it would on a hosted Postgres.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000/dev. Emails are not sent. The demo mailbox stands in for email: send a sign-in link to any demo user, open it, confirm the email address, then copy the 6 digit code from the mailbox.

```bash
npm run reset
```

Wipes the database. The next start re-seeds it.

## Demo path

| Step | Sign in as | What to do |
|---|---|---|
| 1 | `td@riverside-rovers.example` (club) | Upload evidence under Planning, fix the returned P3, add a staff row with a certificate |
| 2 | `sam.reid@fq-assess.example` (first assessor) | Open Riverside, verify or return evidence, enter scores, lock in |
| 3 | `jordan.lee@fq-assess.example` (second assessor) | Score Riverside blind (Sam's scores are not visible), lock in |
| 4 | `admin@fq-assess.example` (admin) | Reconciliation: resolve disputes or assign a moderator; then Release |
| 5 | Club again | Results page with shield, totals, line items, print to PDF |

Seeded state so every screen has something to show:

| Club | Pool / shield | State |
|---|---|---|
| Riverside Rovers FC | B / Silver | Early: a few submissions, one returned item. Demo club |
| Coastal United SC | A / Gold | All evidence verified, both assessors locked, 3 disputes open, D8 with moderator (Sam) |
| Highland Park FC | C / Bronze | Partly submitted, first assessor part way through scoring |
| Northgate Athletic | B / Silver | Fully reconciled, ready for release |

## How the spec is enforced

Access control is in the database, not just hidden in the UI (`src/schema.sql`):

- Each request runs in a transaction as one of three Postgres roles (`app_club`, `app_assessor`, `app_admin`) with the user id set, so row level security policies apply to every query.
- Clubs have no grant at all on criteria, scores, assignments, moderation, resolutions, settings or the audit log, and only column-level access to item tables (no verification columns). Results rows are readable only after release.
- Blind scoring: an assessor's queries return only their own scores and lock. Admin and the moderator of an item see both scores only after both assessors lock in. Score entries in the audit log are sealed the same way.
- Moderators see only the items they were asked to moderate, and the database refuses a moderator who is first or second assessor on that club. Same person as first and second is blocked by a check constraint.
- Admin has no write permission on scores. Admin resolutions are recorded separately.
- Triggers enforce the club item state machine (submit only; approved items lock; reopen needs a reason), score maximums, locked scores, the Pool A/C planning rules and the two-contact limit.
- Every score, verification, moderation, reopening, resolution and release is written to the audit log by triggers, with the actor and reason.

Login (`src/auth.js`): one link per person, stored as a SHA-256 hash with expiry and revocation. Opening a link asks for the email address, then sends a 6 digit code, so a forwarded link alone is not enough. Issuing a new link revokes the old one. Club sessions last 7 days, assessor and admin sessions 8 hours.

## Scoring (`src/scoring.js`)

- Points = item score x weighting. Decimal scores to one place (new in 2027).
- 2027 Tier 1 thresholds: Gold 75%, Silver 60%, Bronze 45%, Development Committed 35%.
- Maximum 1,340 points for a non-Gold club: staff 330, planning 254, delivery 498, outcomes 258.
- Gold clubs are scored on O12, all others on O8.
- Pool A/C: P2 and P5 plus up to three items the club chooses; other planning items carry forward last cycle's score.
- Non-negotiables are Met or Not met and add no points. If any is not met, the rating cannot rise above the club's current shield.
- Reconciliation: differences above the threshold (default 0.5) are disputed. Smaller differences resolve automatically (average, higher or lower; set by the admin). Non-negotiables always need agreement.

## Tests

```bash
npm test
```

14 tests that query the database directly as each role to prove the access rules (no UI involved).

```bash
npm run reset && npm start
```

```bash
BASE=http://localhost:3000 npm run e2e
```

Browser walkthrough of the whole demo path, including release, using Playwright (needs a Playwright install).

## Assumptions and gaps to decide

- **FQ material in the repo.** Spec section 8 says no real FQ material; this build uses the real line items, weightings and the Appendix 7 rubric text (in `data/rubric.json`, shown to assessors only) because that was requested. Settle the IP position (spec section 9) before this repo is shared. Swapping in dummy text only means editing that one file.
- **Sections.** The spec's club dashboard lists Planning, Staff and Delivery. The rubric also requires club submissions for Outcomes and Non-negotiables, so both are included.
- **Rejected evidence.** The spec gives assessors "rejected" but gives clubs no matching status. Clubs see "Closed" (locked, counts as complete). Confirm wording.
- **Link reuse.** Links work for repeat sign-ins until they expire or are replaced; each sign-in needs a fresh emailed code. The spec mentions a "used" flag, which could instead mean single use.
- **Planning rolling average.** The info pack says both "three" and "five" selected items and does not define the averaging formula. The prototype carries forward the previous score for items not chosen and does not average the assessed ones.
- **Info pack inconsistencies to raise with FQ:** Silver "60% to 74%" against Gold ">75%" leaves 74 to 75% undefined (treated as Silver); Development Committed is 35% in one place and 55% (Tier 2) in another; "Coaches experience" (0-3 x1 = 30) and "Technical Leads" (0-6 x1 = 24) are modelled as 0-30 and 0-24 scales.
- **Tier 2** is not built. The catalogue structure supports it.
- **Production gaps:** PGlite is a single process; production would use hosted Postgres (the schema runs unchanged). Email goes to an outbox table: plug a provider into `src/mail.js` and set `DEMO_MODE=0` to remove `/dev`. File storage is in the database; production would use object storage. Automatic resolutions are recorded when an admin opens progress or reconciliation pages.

## Layout

```
src/schema.sql        tables, roles, grants, RLS policies, guard and audit triggers
src/db.js             PGlite setup and the per-request role switch (asUser)
src/auth.js           magic link + emailed code
src/catalog.js        requirement catalogue and applicability rules
src/guidance.js       club-facing guidance (separate from assessor criteria)
src/scoring.js        scoring engine and reconciliation rule
src/model.js          shared queries (progress, reconciliation, results)
src/routes/*.js       club, review (shared), assessor, admin pages
data/rubric.json      line items, scales, weightings, assessor criteria
test/                 database access tests and browser walkthrough
```
