// Queries shared by the route modules. All take a transaction already running as
// the signed-in user's DB role, so RLS decides what comes back.
import { applicable } from './catalog.js';
import { reconcile, computeResult } from './scoring.js';
import { num } from './db.js';

export async function getReqs(tx) {
  return (await tx.query('select * from requirements order by sort')).rows
    .map((r) => ({ ...r, max_score: num(r.max_score), weight: num(r.weight) }));
}

export async function getSettings(tx) {
  const { rows } = await tx.query('select key, value from settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...s, threshold: Number(s.threshold ?? 0.5), auto_rule: s.auto_rule ?? 'average' };
}

export async function getClub(tx, clubId) {
  const { rows: [club] } = await tx.query('select * from clubs where id = $1', [clubId]);
  return club ?? null;
}

// The club DB role has column-level grants only, so it must not `select *`
// on tables that hold assessor-only columns.
const CLUB_ITEM_COLS = 'id, club_id, req_id, status, return_comment, selected, flagged_at, updated_at';
const CLUB_STAFF_COLS = `id, club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
  blue_card_expiry, years_at_club, employment_type, status, return_comment, updated_at`;
async function isClubRole(tx) {
  return (await tx.query('select current_user as u')).rows[0].u === 'app_club';
}

export async function getItems(tx, clubId) {
  const cols = (await isClubRole(tx)) ? CLUB_ITEM_COLS : '*';
  const { rows } = await tx.query(`select ${cols} from club_items where club_id = $1`, [clubId]);
  return Object.fromEntries(rows.map((r) => [r.req_id, r]));
}

export async function getFiles(tx, clubId) {
  const { rows } = await tx.query(
    'select id, req_id, staff_row_id, filename, size, uploaded_at from files where club_id = $1 order by id', [clubId]);
  return rows;
}

export async function getStaff(tx, clubId) {
  const cols = (await isClubRole(tx)) ? CLUB_STAFF_COLS : '*';
  return (await tx.query(`select ${cols} from staff_rows where club_id = $1 order by id`, [clubId])).rows;
}

// Requirements an assessor must score for this club.
export function scorable(reqs, club, items) {
  return reqs.filter((r) => applicable(r, club, items[r.id]).applies);
}

// Club-facing submission progress. Only items the club submits count.
export function submissionProgress(reqs, club, items, staff) {
  const out = {};
  for (const sec of ['planning', 'delivery', 'outcomes', 'nn']) {
    const list = reqs.filter((r) => r.section === sec && r.kind === 'document' && applicable(r, club, items[r.id]).applies);
    const st = list.map((r) => items[r.id]?.status ?? 'not_started');
    out[sec] = {
      total: list.length,
      approved: st.filter((s) => s === 'approved' || s === 'closed').length,
      submitted: st.filter((s) => s === 'submitted').length,
      returned: st.filter((s) => s === 'returned').length,
    };
  }
  const minRows = 7; // seven leadership positions
  out.staff = {
    total: Math.max(staff.length, minRows),
    approved: staff.filter((s) => s.status === 'approved' || s.status === 'closed').length,
    submitted: staff.filter((s) => s.status === 'submitted').length,
    returned: staff.filter((s) => s.status === 'returned').length,
  };
  return out;
}

export function sumProgress(p) {
  return Object.values(p).reduce((a, s) => ({
    total: a.total + s.total, approved: a.approved + s.approved, submitted: a.submitted + s.submitted, returned: a.returned + s.returned,
  }), { total: 0, approved: 0, submitted: 0, returned: 0 });
}

export async function assignmentFor(tx, clubId) {
  const { rows: [a] } = await tx.query('select * from assignments where club_id = $1', [clubId]);
  return a ?? null;
}

// Reconciliation state for every scorable item of a club (admin or moderator view).
// Only returns score values when both assessors have locked: RLS returns no rows otherwise.
export async function reconciliation(tx, club, reqs, items, settings) {
  const a = await assignmentFor(tx, club.id);
  const { rows: scores } = await tx.query('select * from scores where club_id = $1', [club.id]);
  const { rows: res } = await tx.query('select r.*, u.name as resolver from resolutions r left join users u on u.id = r.resolved_by where r.club_id = $1', [club.id]);
  const { rows: mods } = await tx.query('select m.*, u.name as moderator from moderations m join users u on u.id = m.moderator_id where m.club_id = $1', [club.id]);
  const resBy = Object.fromEntries(res.map((r) => [r.req_id, r]));
  const modBy = Object.fromEntries(mods.map((m) => [m.req_id, m]));
  const rows = scorable(reqs, club, items).map((r) => {
    const s1 = scores.find((s) => s.req_id === r.id && s.assessor_id === a?.first_id);
    const s2 = scores.find((s) => s.req_id === r.id && s.assessor_id === a?.second_id);
    const thr = r.section === 'nn' ? 0 : settings.threshold;
    const rec = reconcile(s1 ? num(s1.score) : null, s2 ? num(s2.score) : null, { threshold: thr, rule: settings.auto_rule });
    const resolution = resBy[r.id];
    let state = rec.state;
    if (resolution) state = 'resolved';
    else if (modBy[r.id]) state = 'moderation';
    return { req: r, s1: s1 ? num(s1.score) : null, s2: s2 ? num(s2.score) : null, n1: s1?.note, n2: s2?.note,
      rec, state, resolution, moderation: modBy[r.id] };
  });
  return { assignment: a, rows };
}

// Record auto-resolutions for items within threshold. Admin only (RLS).
export async function applyAuto(tx, club, reqs, items, settings) {
  const { rows } = await reconciliation(tx, club, reqs, items, settings);
  let n = 0;
  for (const row of rows) {
    if (row.state === 'auto') {
      await tx.query(
        `insert into resolutions(club_id, req_id, final_score, method, note) values ($1,$2,$3,'auto',$4)
         on conflict (club_id, req_id) do nothing`,
        [club.id, row.req.id, row.rec.final, `Within threshold (${settings.threshold}): ${settings.auto_rule}`]);
      n++;
    }
  }
  return n;
}

export async function bothLocked(tx, clubId) {
  return (await tx.query('select both_locked($1) as b', [clubId])).rows[0].b;
}

export async function clubResult(tx, club, reqs, items) {
  const { rows: res } = await tx.query('select req_id, final_score from resolutions where club_id = $1', [club.id]);
  const { rows: prior } = await tx.query('select req_id, score from prior_scores where club_id = $1', [club.id]);
  return computeResult({
    reqs, club, items,
    finals: Object.fromEntries(res.map((r) => [r.req_id, num(r.final_score)])),
    prior: Object.fromEntries(prior.map((r) => [r.req_id, num(r.score)])),
  });
}

// Overall state of a club for admin oversight and the release gate.
export async function clubStatus(tx, club, reqs, settings) {
  const items = await getItems(tx, club.id);
  const staff = await getStaff(tx, club.id);
  const prog = sumProgress(submissionProgress(reqs, club, items, staff));
  const a = await assignmentFor(tx, club.id);
  const { rows: locks } = await tx.query('select assessor_id from score_locks where club_id = $1', [club.id]);
  const locked = new Set(locks.map((l) => l.assessor_id));
  const both = a?.first_id && a?.second_id && locked.has(a.first_id) && locked.has(a.second_id);
  let rec = null;
  if (both) {
    await applyAuto(tx, club, reqs, items, settings);
    const r = await reconciliation(tx, club, reqs, items, settings);
    const count = (st) => r.rows.filter((x) => x.state === st).length;
    rec = { total: r.rows.length, resolved: count('resolved'), disputed: count('disputed'), unscored: count('unscored'), moderation: count('moderation') };
  }
  const awaitingReview = Object.values(items).filter((i) => i.status === 'submitted').length
    + staff.filter((s) => s.status === 'submitted').length;
  const complete = Boolean(both && rec && rec.resolved === rec.total);
  return { club, items, staff, prog, assignment: a, firstLocked: a && locked.has(a.first_id), secondLocked: a && locked.has(a.second_id),
    both: Boolean(both), rec, awaitingReview, complete };
}
