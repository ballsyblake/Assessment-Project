// Scoring engine: final item scores in, rating out.
// Item scores themselves are computed in the database (trigger trg_score_guard):
//   ticks     -> (Yes = 1, Partial = 0.5, No = 0) / number of criteria x max score, one decimal
//   value     -> highest band whose minimum the measured value reaches
//   direct    -> entered by the assessor
//   yesno     -> compliance non-negotiables (NN1-6): Met / Not met, no effect on the rating
//   threshold -> shield threshold standards (NN7-9): level met, On Notice or Not Met
// Here: points = score x weighting, area and section subtotals, percentage of the applicable
// maximum, rating from the framework thresholds, then the shield threshold rule.
import { applicable, framework } from './catalog.js';

export const THRESHOLDS = framework.thresholds;
const LEVELS = ['Not rated', 'Development Committed', 'Bronze', 'Silver', 'Gold', 'Platinum'];
const r1 = (x) => Math.round(x * 10) / 10;
export const ON_NOTICE = 0.5;
export const thresholdLabel = (code) =>
  (framework.thresholdOutcomes ?? []).find((o) => Number(o.code) === Number(code))?.label ?? (code === null || code === undefined ? 'Not assessed' : String(code));

export function ratingFor(pct) {
  return THRESHOLDS.find((t) => pct >= t.min)?.rating ?? 'Not rated';
}

/**
 * Shield threshold rule (from the 2026 preliminary reports): a club may be on notice for the
 * same threshold item for one season only, and for no more than one item in a year. Breaking
 * either lowers the shield by one level.
 */
export function shieldAdjustment(thresholds) {
  const repeated = thresholds.filter((t) => t.code === ON_NOTICE && t.prior === ON_NOTICE);
  const flagged = thresholds.filter((t) => t.code !== null && t.code <= ON_NOTICE);
  const reasons = [];
  if (repeated.length) reasons.push(`on notice for ${repeated.map((t) => t.name).join(', ')} for two consecutive years`);
  if (flagged.length > 1) reasons.push(`${flagged.length} shield threshold standards not met this year`);
  return { downgrade: reasons.length ? (framework.thresholdRule?.downgradeLevels ?? 1) : 0, reasons };
}

export function computeResult({ reqs, club, items, finals, prior, sections = null }) {
  const lines = [];
  const compliance = [];
  const thresholds = [];
  for (const r of reqs) {
    if (sections && !sections.includes(r.section)) continue;
    const a = applicable(r, club, items[r.id]);
    if (r.type === 'yesno') {
      compliance.push({ id: r.id, name: r.name, met: finals[r.id] === undefined ? null : Number(finals[r.id]) >= 1 });
      continue;
    }
    if (r.type === 'threshold') {
      thresholds.push({ id: r.id, name: r.name, code: finals[r.id] ?? null, prior: prior[r.id] ?? null, label: thresholdLabel(finals[r.id]) });
      continue;
    }
    if (!a.applies && !a.carry) continue;
    const raw = a.carry ? prior[r.id] : finals[r.id];
    const score = raw === undefined || raw === null ? null : Number(raw);
    const max = Number(r.max_score) * Number(r.weight);
    const points = score === null ? 0 : r1(score * r.weight);
    lines.push({ id: r.id, section: r.section, grp: r.grp, name: r.name, score, max_score: Number(r.max_score),
      weight: Number(r.weight), points, max, missed: r1(max - points), source: a.carry ? 'carried forward' : 'assessed' });
  }
  const sum = (ls) => ({ points: r1(ls.reduce((s, l) => s + l.points, 0)), max: ls.reduce((s, l) => s + l.max, 0) });
  const withPct = (t) => ({ ...t, missed: r1(t.max - t.points), pct: t.max ? Math.round((t.points / t.max) * 100) : 0 });

  const bySection = {};
  const areas = {};
  for (const sec of [...new Set(lines.map((l) => l.section))]) {
    const ls = lines.filter((l) => l.section === sec);
    bySection[sec] = withPct(sum(ls));
    areas[sec] = [...new Set(ls.map((l) => l.grp))].map((g) => ({ name: g, lines: ls.filter((l) => l.grp === g), ...withPct(sum(ls.filter((l) => l.grp === g))) }));
  }
  const totals = withPct(sum(lines));
  const pctExact = totals.max ? (totals.points / totals.max) * 100 : 0;
  const scoreRating = ratingFor(pctExact);
  const adj = shieldAdjustment(thresholds);
  const rating = adj.downgrade ? LEVELS[Math.max(0, LEVELS.indexOf(scoreRating) - adj.downgrade)] : scoreRating;

  // Top 5 lists: strengths = full marks, highest weighting first; improve = most points missed.
  const assessed = lines.filter((l) => l.source === 'assessed' && l.score !== null);
  const strengths = assessed.filter((l) => l.score === l.max_score).sort((a, b) => b.weight - a.weight || b.points - a.points).slice(0, 5);
  const improve = assessed.filter((l) => l.missed > 0).sort((a, b) => b.missed - a.missed || b.weight - a.weight).slice(0, 5);

  return {
    total: totals.points, max: totals.max, missed: totals.missed, pct: r1(pctExact), rating, scoreRating,
    downgradeReasons: adj.reasons, nnMet: compliance.every((n) => n.met === true),
    lines, bySection, areas, compliance, thresholds, nn: compliance, strengths, improve,
  };
}

// Score from ticks, mirroring the database (used for previews in the UI only).
export function tickScore(ticks, maxScore) {
  const pv = framework.scoring?.partialValue ?? 0.5;
  const met = ticks.reduce((s, t) => s + (t === 'y' ? 1 : t === 'p' ? pv : 0), 0);
  return r1((met / ticks.length) * maxScore);
}

// Human-readable score for any item type.
export function scoreText(q, score) {
  if (score === null || score === undefined) return '–';
  if (q.type === 'threshold') return thresholdLabel(score);
  if (q.type === 'yesno') return Number(score) >= 1 ? 'Met' : 'Not met';
  return Number(score).toLocaleString('en-AU', { maximumFractionDigits: 1 });
}
