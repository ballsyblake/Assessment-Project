// Scoring engine: final item scores in, rating out.
// Item scores themselves are computed in the database (trigger trg_score_guard):
//   ticks  -> (Yes = 1, Partial = 0.5, No = 0) / number of criteria x max score, one decimal
//   value  -> highest band whose minimum the measured value reaches
//   direct / yesno -> entered by the assessor
// Here: points = score x weighting; percentage of applicable maximum; thresholds and the
// non-negotiable cap come from the framework file.
import { applicable, framework } from './catalog.js';

export const THRESHOLDS = framework.thresholds;
const RANK = { 'Not rated': 0, None: 0, 'Development Committed': 1, Bronze: 2, Silver: 3, Gold: 4, Platinum: 5 };

export function ratingFor(pct) {
  return THRESHOLDS.find((t) => pct >= t.min)?.rating ?? 'Not rated';
}

const r1 = (x) => Math.round(x * 10) / 10;

export function computeResult({ reqs, club, items, finals, prior, sections = null }) {
  const lines = [];
  const nn = [];
  for (const r of reqs) {
    if (sections && !sections.includes(r.section)) continue;
    const a = applicable(r, club, items[r.id]);
    if (r.section === 'nn') {
      nn.push({ id: r.id, name: r.name, met: finals[r.id] === undefined ? null : Number(finals[r.id]) >= 1 });
      continue;
    }
    if (!a.applies && !a.carry) continue;
    const raw = a.carry ? prior[r.id] : finals[r.id];
    const score = raw === undefined || raw === null ? null : Number(raw);
    const lineMax = Number(r.max_score) * Number(r.weight);
    lines.push({ id: r.id, section: r.section, grp: r.grp, name: r.name, score, max_score: Number(r.max_score),
      weight: Number(r.weight), points: score === null ? 0 : r1(score * r.weight), max: lineMax,
      source: a.carry ? 'carried forward' : 'assessed' });
  }
  const total = r1(lines.reduce((s, l) => s + l.points, 0));
  const max = lines.reduce((s, l) => s + l.max, 0);
  const pct = max ? r1((total / max) * 100) : 0;
  const nnMet = nn.every((n) => n.met === true);
  let rating = ratingFor(pct);
  let capped = false;
  if (framework.nnCapsRating && !nnMet && RANK[rating] > RANK[club.current_shield ?? 'None']) {
    rating = RANK[club.current_shield] ? club.current_shield : 'Not rated';
    capped = true;
  }
  const bySection = {};
  for (const l of lines) {
    bySection[l.section] ??= { points: 0, max: 0 };
    bySection[l.section].points = r1(bySection[l.section].points + l.points);
    bySection[l.section].max += l.max;
  }
  return { total, max, pct, rating, nnMet, capped, lines, nn, bySection };
}

// Score from ticks, mirroring the database (used for previews in the UI only).
export function tickScore(ticks, maxScore) {
  const pv = framework.scoring?.partialValue ?? 0.5;
  const met = ticks.reduce((s, t) => s + (t === 'y' ? 1 : t === 'p' ? pv : 0), 0);
  return r1((met / ticks.length) * maxScore);
}
