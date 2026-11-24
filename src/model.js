// Queries shared by the route modules. Every function takes a transaction that is
// already running as the signed-in user's DB role, so RLS decides what comes back.
import { applicable } from './catalog.js';
import { computeResult } from './scoring.js';
import { num } from './db.js';

const CLUB_ITEM_COLS = 'id, club_id, req_id, status, return_comment, selected, flagged_at, upload_until, updated_at';
const CLUB_STAFF_COLS = `id, club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
  blue_card_expiry, years_at_club, employment_type, status, return_comment, updated_at`;
const isClubRole = async (tx) => (await tx.query('select current_user as u')).rows[0].u === 'app_club';

export async function getReqs(tx) {
  return (await tx.query('select * from requirements order by sort')).rows
    .map((r) => ({ ...r, max_score: num(r.max_score), weight: num(r.weight) }));
}
export async function getPhases(tx) {
  const today = new Date().toISOString().slice(0, 10);
  return (await tx.query('select * from phases order by sort')).rows.map((p) => {
    const d = p.deadline ? new Date(p.deadline).toISOString().slice(0, 10) : null;
    return { ...p, deadlineDay: d, submissionOpen: !p.closed_at && (!d || today <= d), closed: Boolean(p.closed_at) };
  });
}
export async function getSettings(tx) {
  const { rows } = await tx.query('select key, value from settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export async function getClub(tx, clubId) {
  return (await tx.query('select * from clubs where id = $1', [clubId])).rows[0] ?? null;
}
export async function getItems(tx, clubId) {
  const cols = (await isClubRole(tx)) ? CLUB_ITEM_COLS : '*';
  const { rows } = await tx.query(`select ${cols} from club_items where club_id = $1`, [clubId]);
  return Object.fromEntries(rows.map((r) => [r.req_id, r]));
}
export async function getFiles(tx, clubId) {
  return (await tx.query('select id, req_id, staff_row_id, filename, size, uploaded_at from files where club_id = $1 order by id', [clubId])).rows;
}
export async function getStaff(tx, clubId) {
  const cols = (await isClubRole(tx)) ? CLUB_STAFF_COLS : '*';
  return (await tx.query(`select ${cols} from staff_rows where club_id = $1 order by id`, [clubId])).rows;
}

const DONE = (s) => s === 'approved' || s === 'not_accepted';

// Club-facing submission progress. Only items the club submits count.
export function submissionProgress(reqs, club, items, staff) {
  const out = {};
  for (const sec of ['planning', 'delivery', 'outcomes', 'nn']) {
    const st = reqs.filter((r) => r.section === sec && r.kind === 'document' && applicable(r, club, items[r.id]).applies)
      .map((r) => items[r.id]?.status ?? 'not_started');
    out[sec] = { total: st.length, approved: st.filter(DONE).length, submitted: st.filter((s) => s === 'submitted').length,
      returned: st.filter((s) => s === 'returned').length };
  }
  out.staff = { total: Math.max(staff.length, 7), approved: staff.filter((s) => DONE(s.status)).length,
    submitted: staff.filter((s) => s.status === 'submitted').length, returned: staff.filter((s) => s.status === 'returned').length };
  return out;
}
export function sumProgress(p) {
  return Object.values(p).reduce((a, s) => ({ total: a.total + s.total, approved: a.approved + s.approved,
    submitted: a.submitted + s.submitted, returned: a.returned + s.returned }), { total: 0, approved: 0, submitted: 0, returned: 0 });
}

// Scoring status per club and phase (admin). Uses only lock and resolution data, never score values.
export async function scoringStatus(tx, clubId = null) {
  const { rows } = await tx.query(`
    select c.id club_id, q.section,
      count(*) filter (where item_applies(c.id, q.id))::int applicable,
      count(*) filter (where item_applies(c.id, q.id) and (select count(*) from slots s where s.club_id = c.id and s.req_id = q.id) < q.assessors)::int unassigned,
      count(*) filter (where item_applies(c.id, q.id) and item_locked(c.id, q.id))::int locked,
      count(r.req_id) filter (where item_applies(c.id, q.id))::int resolved,
      count(*) filter (where item_applies(c.id, q.id) and item_locked(c.id, q.id) and r.req_id is null and t.req_id is null)::int disputed,
      count(*) filter (where item_applies(c.id, q.id) and r.req_id is null and t.req_id is not null)::int with_third,
      count(*) filter (where r.tick_mismatch)::int tick_mismatch
    from clubs c cross join requirements q
    left join resolutions r on r.club_id = c.id and r.req_id = q.id
    left join third_assignments t on t.club_id = c.id and t.req_id = q.id
    where ($1::int is null or c.id = $1)
    group by c.id, q.section`, [clubId]);
  const out = {};
  for (const r of rows) (out[r.club_id] ??= {})[r.section] = r;
  return out;
}

// Reconciliation detail for one club and phase (admin). Score values come back only for locked items (RLS).
export async function reconciliation(tx, clubId, phase) {
  const { rows } = await tx.query(`
    select q.*, item_applies($1, q.id) applies, item_locked($1, q.id) locked,
      (select json_agg(json_build_object('slot', s.slot, 'assessor_id', s.assessor_id, 'name', u.name,
          'locked', exists (select 1 from score_locks l where l.club_id = s.club_id and l.assessor_id = s.assessor_id and l.phase = q.section)))
       from slots s join users u on u.id = s.assessor_id where s.club_id = $1 and s.req_id = q.id) holders,
      (select json_agg(json_build_object('slot', x.slot, 'score', x.score, 'ticks', x.ticks, 'value', x.value, 'comment', x.comment))
       from scores x where x.club_id = $1 and x.req_id = q.id) scores,
      r.final_score, r.method, r.note, r.tick_mismatch, ru.name resolver,
      t.assessor_id third_id, tu.name third_name
    from requirements q
    left join resolutions r on r.club_id = $1 and r.req_id = q.id
    left join users ru on ru.id = r.resolved_by
    left join third_assignments t on t.club_id = $1 and t.req_id = q.id
    left join users tu on tu.id = t.assessor_id
    where q.section = $2 order by q.sort`, [clubId, phase]);
  return rows.filter((r) => r.applies).map((r) => {
    const sc = Object.fromEntries((r.scores ?? []).map((s) => [s.slot, { ...s, score: num(s.score) }]));
    let state = 'resolved';
    if (r.final_score === null) {
      const holders = r.holders ?? [];
      if (holders.length < r.assessors) state = 'unassigned';
      else if (!r.locked) state = 'scoring';
      else if (r.third_id) state = 'third';
      else state = 'disputed';
    }
    return { ...r, max_score: num(r.max_score), weight: num(r.weight), final_score: num(r.final_score), sc, state };
  });
}

export async function finalsFor(tx, clubId) {
  const { rows: res } = await tx.query('select req_id, final_score from resolutions where club_id = $1', [clubId]);
  const { rows: prior } = await tx.query('select req_id, score from prior_scores where club_id = $1', [clubId]);
  return { finals: Object.fromEntries(res.map((r) => [r.req_id, num(r.final_score)])),
    prior: Object.fromEntries(prior.map((r) => [r.req_id, num(r.score)])) };
}

export async function clubResult(tx, club, reqs, items, sections = null) {
  return computeResult({ reqs, club, items, ...(await finalsFor(tx, club.id)), sections });
}

// Admin-only leaderboard from closed phases. Counts only resolved items (both assessors locked).
export async function leaderboard(tx, phaseIds) {
  const reqs = await getReqs(tx);
  const clubs = (await tx.query('select * from clubs order by name')).rows;
  const rows = [];
  for (const club of clubs) {
    const items = await getItems(tx, club.id);
    const r = await clubResult(tx, club, reqs, items, phaseIds);
    rows.push({ club, total: r.total, max: r.max, pct: r.pct, bySection: r.bySection });
  }
  rows.sort((a, b) => b.pct - a.pct);
  rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].pct === r.pct ? rows[i - 1].rank : i + 1; });
  return rows;
}

// Admin-only: how each assessor's scores compare with the final scores on the same items.
export async function assessorStats(tx) {
  return (await tx.query(`
    select u.id, u.name,
      count(*)::int scored,
      round(avg(x.score / nullif(q.max_score, 0) * 100), 1) avg_pct,
      round(avg((x.score - r.final_score) / nullif(q.max_score, 0) * 100), 1) bias_pct,
      count(*) filter (where r.method = 'third')::int disputes,
      count(*) filter (where r.tick_mismatch)::int tick_mismatch
    from scores x
    join users u on u.id = x.assessor_id
    join requirements q on q.id = x.req_id
    join resolutions r on r.club_id = x.club_id and r.req_id = x.req_id
    where x.slot in ('first','second') and q.assessors = 2 and q.type <> 'yesno'
    group by u.id, u.name order by u.name`)).rows;
}
