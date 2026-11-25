// Pure tests of the scoring engine (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeResult, shieldAdjustment, ratingFor, ON_NOTICE } from '../src/scoring.js';

const club = { pool: 'B', current_shield: 'Silver' };
const reqs = [
  { id: 'P1', section: 'planning', grp: 'Youth Development Plan', name: 'Values', type: 'ticks', max_score: 3, weight: 6 },
  { id: 'P2', section: 'planning', grp: 'Youth Development Plan', name: 'Methodology', type: 'ticks', max_score: 4, weight: 8 },
  { id: 'D1', section: 'delivery', grp: 'Program Management', name: 'Attendance', type: 'ticks', max_score: 3, weight: 4 },
  { id: 'NN1', section: 'nn', grp: 'NN', name: 'Fee Transparency', type: 'yesno', max_score: 1, weight: 0 },
  { id: 'NN7', section: 'nn', grp: 'NN', name: 'Club Structure Standards', type: 'threshold', max_score: 4, weight: 0 },
  { id: 'NN8', section: 'nn', grp: 'NN', name: 'Coaching Standards', type: 'threshold', max_score: 4, weight: 0 },
];
const items = {};
const run = (finals, prior = {}) => computeResult({ reqs, club, items, finals, prior });

test('totals, points missed, area and section grades', () => {
  const r = run({ P1: 3, P2: 2.5, D1: 3, NN1: 1, NN7: 4, NN8: 4 });
  assert.equal(r.total, 18 + 20 + 12);
  assert.equal(r.max, 18 + 32 + 12);
  assert.equal(r.missed, 12);
  assert.equal(r.bySection.planning.pct, Math.round((38 / 50) * 100));
  assert.equal(r.areas.planning[0].missed, 12);
  assert.equal(r.rating, 'Gold'); // 50 / 62 = 80.6%
});

test('compliance non-negotiables do not change the rating', () => {
  const r = run({ P1: 3, P2: 4, D1: 3, NN1: 0, NN7: 4, NN8: 4 });
  assert.equal(r.compliance[0].met, false);
  assert.equal(r.rating, 'Gold');
});

test('first year on notice for one threshold: no downgrade', () => {
  const r = run({ P1: 3, P2: 4, D1: 3, NN1: 1, NN7: ON_NOTICE, NN8: 4 });
  assert.equal(r.rating, 'Gold');
});

test('same threshold on notice two years running: one shield lower', () => {
  const r = run({ P1: 3, P2: 4, D1: 3, NN1: 1, NN7: ON_NOTICE, NN8: 4 }, { NN7: ON_NOTICE });
  assert.equal(r.scoreRating, 'Gold');
  assert.equal(r.rating, 'Silver');
  assert.match(r.downgradeReasons[0], /two consecutive years/);
});

test('more than one threshold not met: one shield lower', () => {
  assert.equal(shieldAdjustment([{ name: 'A', code: ON_NOTICE }, { name: 'B', code: 0 }]).downgrade, 1);
});

test('rating thresholds are inclusive (75.3% is Gold)', () => {
  assert.equal(ratingFor(75.34), 'Gold');
  assert.equal(ratingFor(74.99), 'Silver');
});

test('top 5 lists: strengths are full marks, improvements are most points missed', () => {
  const r = run({ P1: 3, P2: 1, D1: 2, NN1: 1, NN7: 4, NN8: 4 });
  assert.deepEqual(r.strengths.map((l) => l.id), ['P1']);
  assert.equal(r.improve[0].id, 'P2');
});
