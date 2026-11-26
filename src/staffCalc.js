// Suggested Technical Staff Qualification scores, calculated from the club's staff table
// using the lookup tables and rules in the framework file (framework.staffScoring).
// These are suggestions: assessors confirm each item, and apply the judgement rules
// (for example "Other" qualifications) themselves.
import { framework } from './catalog.js';

const cfg = () => framework.staffScoring;
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const r1 = (x) => Math.round(x * 10) / 10;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const isFemale = (g) => ['f', 'female'].includes(norm(g));
const ageOf = (team) => Number(String(team ?? '').match(/\d+/)?.[0] ?? 0);

function find(table, key, qual) {
  return table.find((t) => norm(t[key]) === norm(qual));
}
// Coach table: column depends on the coach's gender and the team's age.
function coachBase(row, ageForColumn) {
  const t = find(cfg().coachTable, 'qualification', row.qualification);
  if (!t) return { score: null, note: `${row.person}: qualification "${row.qualification}" not in the table, check manually` };
  const col = isFemale(row.gender) ? 'female' : ageForColumn >= cfg().u15plusFromAge ? 'u15plus' : 'u14minus';
  if (t[col] === null || t[col] === undefined) return { score: null, note: `${row.person}: "${row.qualification}" needs checking` };
  return { score: t[col], note: `${row.person}: ${row.qualification}${col === 'female' ? ' (female coach)' : ''} = ${t[col]}` };
}
function experience(row) {
  const t = find(cfg().experienceTable, 'years', row.qual_years);
  return t ? t.score : 0;
}

export function suggestStaffScores(staff) {
  const c = cfg();
  if (!c) return {};
  const out = {};
  const rowsFor = (pos) => staff.filter((s) => norm(s.position) === norm(pos));
  const person = (pos) => rowsFor(pos)[0];
  const set = (id, score, notes, check = false) => { out[id] = { score: score === null ? null : r1(score), notes, check }; };

  // Leadership and specialist positions
  const td = person(c.positions.T01);
  if (td) {
    const t = find(c.tdTable, 'qualification', td.qualification);
    set('T01', t?.score ?? null, [t ? `${td.person}: ${td.qualification} = ${t.score}` : `${td.person}: "${td.qualification}" needs checking`], !t || t.score === null);
  } else set('T01', 0, ['No Technical Director listed']);
  for (const id of ['T02', 'T03', 'T04', 'T05']) {
    const p = person(c.positions[id]);
    if (!p) { set(id, 0, [`No ${c.positions[id]} listed`]); continue; }
    const b = coachBase({ ...p, gender: 'M' }, 99); // leadership roles use the U15+ column
    set(id, b.score, [b.note], b.score === null);
  }
  const ftl = person(c.positions.T06);
  if (!ftl) set('T06', 0, ['No Female Technical Lead listed']);
  else if (!isFemale(ftl.gender)) set('T06', 0, [`${ftl.person}: Female Technical Lead is not female, qualification score 0`]);
  else { const b = coachBase(ftl, 0); set('T06', b.score, [b.note], b.score === null); }
  const ss = person(c.positions.T07);
  if (!ss) set('T07', 0, ['No Head of Sports Science and Medicine listed']);
  else {
    // The assessor chooses the category from the certificate (not the club).
    set('T07', null, [`${ss.person}: "${ss.qualification}". Assessor to choose the category from the certificate:
      ${c.sportsScienceTable.map((t) => `${t.qualification} = ${t.score}`).join(', ')}`.replace(/\s+/g, ' ')], true);
  }

  // Coaching rows with automatic adjustments
  const heads = { youth: person(c.positions.T02), junior: person(c.positions.T03) };
  const isYouth = (age) => c.youthAges.includes(age);
  const coaching = staff.filter((s) => s.team && c.teams.some((t) => norm(t) === norm(s.team)))
    .map((s, i) => ({ ...s, i, age: ageOf(s.team) }));
  const byPerson = {};
  for (const r of coaching) (byPerson[norm(r.person)] ??= []).push(r);
  const scored = new Map();
  for (const rows of Object.values(byPerson)) {
    const list = rows.map((r) => {
      const b = coachBase(r, r.age);
      return { r, score: b.score, notes: [b.note] };
    });
    const who = norm(rows[0].person);
    const adjust = (pred, label) => {
      list.filter((x) => pred(x.r) && x.score !== null).forEach((x, k) => {
        if (k === 0) { x.score = Math.max(0, x.score - 1); x.notes.push(`${label}: lowered by 1`); } else { x.score = 0; x.notes.push(`${label}: additional team scores 0`); }
      });
    };
    // One adjustment per person: the TD rule takes precedence when the TD also heads a phase.
    if (td && who === norm(td.person)) adjust(() => true, 'Technical Director coaching a team');
    else if (heads.junior && who === norm(heads.junior.person)) adjust((r) => !isYouth(r.age), 'Head of Junior Academy coaching in own phase');
    else if (heads.youth && who === norm(heads.youth.person)) adjust((r) => isYouth(r.age), 'Head of Youth Academy coaching in own phase');
    if (list.length > 2) {
      list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(2).forEach((x) => { x.score = 0; x.notes.push('Third coaching role: removed (maximum two)'); });
    }
    for (const x of list) scored.set(x.r.i, x);
  }

  let expTotal = 0;
  const expNotes = [];
  for (const [id, teams] of Object.entries(c.ageGroups)) {
    const rows = coaching.filter((r) => teams.some((t) => norm(t) === norm(r.team))).map((r) => scored.get(r.i));
    if (!rows.length) { set(id, 0, [`No coach listed for ${teams.join(' / ')}`]); continue; }
    const needsCheck = rows.some((x) => x.score === null);
    const scores = rows.map((x) => x.score ?? 0);
    const exps = rows.map((x) => (x.score ? experience(x.r) : 0));
    set(id, avg(scores), [...rows.flatMap((x) => x.notes), ...(rows.length > 1 ? [`Average of ${rows.length} teams`] : [])], needsCheck);
    expTotal += avg(exps);
    expNotes.push(`${teams.join(' / ')}: ${r1(avg(exps))}`);
  }
  const gk = person(c.positions.T05);
  if (gk && out.T05?.score) { expTotal += experience(gk); expNotes.push(`Head of Goalkeeping: ${experience(gk)}`); }
  set(c.experienceItem, expTotal, expNotes);

  // Full time / part time for leadership roles, each person counted once.
  const seen = new Set();
  let emp = 0;
  const empNotes = [];
  for (const role of c.leadershipRoles) {
    const p = person(role);
    if (!p || seen.has(norm(p.person))) continue;
    seen.add(norm(p.person));
    const pts = c.employmentPoints[p.employment_type] ?? 0;
    emp += pts;
    empNotes.push(`${role}: ${p.employment_type || 'not stated'} = ${pts}`);
  }
  set(c.employmentItem, emp, empNotes);
  return out;
}

export function staffTotal(suggestions, reqs) {
  return r1(reqs.filter((q) => q.section === 'staff').reduce((s, q) => s + (suggestions[q.id]?.score ?? 0) * Number(q.weight), 0));
}
