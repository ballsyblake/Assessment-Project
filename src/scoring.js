// Scoring engine. Black box per spec section 7: final item scores in, rating out.
// Rules implemented from the FQ Club Development Info Pack 2027:
//   points = score x weighting; percentage = points / max points of applicable items
//   2027 Tier 1 thresholds: Gold >= 75%, Silver >= 60%, Bronze >= 45%,
//   Development Committed >= 35%. Decimal scores (one place) are allowed.
//   Non-negotiables are Yes/No and do not add points. A club that fails any
//   non-negotiable cannot move above its current shield.
import { applicable } from './catalog.js';

export const THRESHOLDS_2027 = [
  { rating: 'Gold', min: 75 },
  { rating: 'Silver', min: 60 },
  { rating: 'Bronze', min: 45 },
  { rating: 'Development Committed', min: 35 },
];
const RANK = { 'Not rated': 0, None: 0, 'Development Committed': 1, Bronze: 2, Silver: 3, Gold: 4 };

export function ratingFor(pct) {
  return THRESHOLDS_2027.find((t) => pct >= t.min)?.rating ?? 'Not rated';
}

/**
 * @param reqs      requirement catalogue rows
 * @param club      { pool, current_shield }
 * @param items     map req_id -> club_items row (for planning selection)
 * @param finals    map req_id -> final score (resolutions)
 * @param prior     map req_id -> previous-cycle score (planning carry-forward)
 */
export function computeResult({ reqs, club, items, finals, prior }) {
  const lines = [];
  let total = 0;
  let max = 0;
  const nn = [];
  for (const r of reqs) {
    const a = applicable(r, club, items[r.id]);
    if (r.section === 'nn') {
      const met = finals[r.id] === undefined ? null : Number(finals[r.id]) >= 1;
      nn.push({ id: r.id, name: r.name, met });
      continue;
    }
    if (!a.applies && !a.carry) continue;
    let score = a.carry ? prior[r.id] : finals[r.id];
    const source = a.carry ? 'carried forward' : 'assessed';
    score = score === undefined || score === null ? null : Number(score);
    const points = score === null ? 0 : Math.round(score * r.weight * 10) / 10;
    const lineMax = Number(r.max_score) * Number(r.weight);
    total += points;
    max += lineMax;
    lines.push({ id: r.id, section: r.section, grp: r.grp, name: r.name, score, max_score: Number(r.max_score),
      weight: Number(r.weight), points, max: lineMax, source });
  }
  total = Math.round(total * 10) / 10;
  const pct = max ? Math.round((total / max) * 1000) / 10 : 0;
  const nnMet = nn.every((n) => n.met === true);
  let rating = ratingFor(pct);
  let capped = false;
  if (!nnMet && RANK[rating] > RANK[club.current_shield ?? 'None']) {
    rating = RANK[club.current_shield] ? club.current_shield : 'Not rated';
    capped = true;
  }
  const bySection = {};
  for (const l of lines) {
    bySection[l.section] ??= { points: 0, max: 0 };
    bySection[l.section].points = Math.round((bySection[l.section].points + l.points) * 10) / 10;
    bySection[l.section].max += l.max;
  }
  return { total, max, pct, rating, nnMet, capped, lines, nn, bySection };
}

// Reconciliation of two independent scores for one item.
export function reconcile(a, b, { threshold, rule }) {
  if (a === null || a === undefined || b === null || b === undefined) return { state: 'unscored' };
  a = Number(a); b = Number(b);
  const diff = Math.round(Math.abs(a - b) * 10) / 10;
  if (diff > threshold) return { state: 'disputed', diff };
  let final;
  if (rule === 'higher') final = Math.max(a, b);
  else if (rule === 'lower') final = Math.min(a, b);
  else final = Math.round(((a + b) / 2) * 10) / 10;
  return { state: 'auto', diff, final };
}
