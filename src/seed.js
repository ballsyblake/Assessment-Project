// Fake clubs and dummy data only (spec section 8). No real clubs or people.
import { sys } from './db.js';
import { loadCatalog } from './catalog.js';
import { issueLink } from './auth.js';

// Minimal valid one-page PDF so evidence downloads open in a viewer.
export function makePdf(lines) {
  const text = lines.map((l, i) => `BT /F1 12 Tf 60 ${760 - i * 18} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

// Deterministic pseudo-random numbers so the demo is the same every reset.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const round1 = (x) => Math.round(x * 10) / 10;

const CLUBS = [
  { key: 'riverside', name: 'Riverside Rovers FC', pool: 'B', shield: 'Silver', contact: ['Taylor Morgan', 'td@riverside-rovers.example'] },
  { key: 'coastal', name: 'Coastal United SC', pool: 'A', shield: 'Gold', contact: ['Jamie Fraser', 'td@coastal-united.example'] },
  { key: 'highland', name: 'Highland Park FC', pool: 'C', shield: 'Bronze', contact: ['Robin Hale', 'td@highland-park.example'] },
  { key: 'northgate', name: 'Northgate Athletic', pool: 'B', shield: 'Silver', contact: ['Casey Walsh', 'td@northgate-athletic.example'] },
];
const ASSESSORS = [
  ['Sam Reid', 'sam.reid@fq-assess.example'],
  ['Jordan Lee', 'jordan.lee@fq-assess.example'],
  ['Priya Nair', 'priya.nair@fq-assess.example'],
  ['Chris Doyle', 'chris.doyle@fq-assess.example'],
];
const ADMIN = ['Alex Admin', 'admin@fq-assess.example'];

const STAFF = [
  ['Technical Director', '', 'AFC A Diploma', 'M'],
  ['Head of Youth Academy', '', 'AFC B Diploma', 'M'],
  ['Head of Junior Academy', '', 'AFC C Diploma', 'F'],
  ['Head of Girls Academy', '', 'AFC B Diploma', 'F'],
  ['Head of Goalkeeping', '', 'AFC GK B Diploma', 'M'],
  ['Female Technical Lead', '', 'AFC C Diploma', 'F'],
  ['Head of Sports Science and Medicine', '', 'BSc Sport Science', 'M'],
  ['Head Coach', 'U18 Boys', 'AFC B Diploma', 'M'],
  ['Head Coach', 'U16 Girls', 'AFC C Diploma', 'F'],
  ['Head Coach', 'U13 Boys', 'AFC C Diploma', 'M'],
  ['Head Coach', 'U11 Girls', 'Skill Training Certificate', 'F'],
  ['Head Coach', 'U9 Boys', 'Skill Training Certificate', 'M'],
];
const FIRST = ['Alex', 'Jordan', 'Morgan', 'Riley', 'Avery', 'Quinn', 'Drew', 'Harper', 'Reese', 'Rowan', 'Sky', 'Emerson'];
const LAST = ['Baker', 'Chen', 'Doyle', 'Evans', 'Foster', 'Grant', 'Hughes', 'Ito', 'Jensen', 'Khan', 'Lopez', 'Moore'];

export async function seed({ issueLinks = true } = {}) {
  const db = sys();
  const reqs = loadCatalog();
  for (const r of reqs) {
    await db.query(
      `insert into requirements(id, section, grp, name, kind, evidence, max_score, weight, guidance, sort)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, r.section, r.grp, r.name, r.kind, r.evidence, r.max_score, r.weight, r.guidance, r.sort]);
    await db.query('insert into requirement_criteria(req_id, criteria) values ($1,$2)', [r.id, r.criteria]);
  }
  for (const [k, v] of Object.entries({
    threshold: '0.5', auto_rule: 'average', internal_deadline: '2026-11-20', released_at: '', cycle: '2027',
  })) await db.query('insert into settings(key, value) values ($1,$2)', [k, v]);

  const { rows: [admin] } = await db.query(
    `insert into users(email, name, role) values ($1,$2,'admin') returning id`, [ADMIN[1], ADMIN[0]]);
  await db.query(`select set_config('app.uid', $1, false)`, [String(admin.id)]);
  const assessors = [];
  for (const [n, e] of ASSESSORS) {
    const { rows: [u] } = await db.query(`insert into users(email, name, role) values ($1,$2,'assessor') returning id`, [e, n]);
    assessors.push(u.id);
  }
  const [sam, jordan, priya, chris] = assessors;
  const assign = { riverside: [sam, jordan], coastal: [jordan, priya], highland: [priya, chris], northgate: [chris, sam] };

  const clubIds = {};
  for (const c of CLUBS) {
    const { rows: [club] } = await db.query(
      `insert into clubs(name, pool, current_shield) values ($1,$2,$3) returning id`, [c.name, c.pool, c.shield]);
    clubIds[c.key] = club.id;
    const { rows: [u] } = await db.query(
      `insert into users(email, name, role, club_id, is_primary) values ($1,$2,'club',$3,true) returning id`,
      [c.contact[1], c.contact[0], club.id]);
    c.userId = u.id;
    await db.query('insert into assignments(club_id, first_id, second_id) values ($1,$2,$3)', [club.id, ...assign[c.key]]);
    const optional = ['P1', 'P8', 'P14'];
    for (const r of reqs) {
      if (r.section === 'staff') continue;
      const selected = r.section !== 'planning' || c.pool === 'B' || ['P2', 'P5', ...optional].includes(r.id);
      await db.query('insert into club_items(club_id, req_id, selected) values ($1,$2,$3)', [club.id, r.id, selected]);
    }
    if (c.pool !== 'B') {
      const rand = rng(club.id * 97);
      for (const r of reqs.filter((x) => x.section === 'planning')) {
        await db.query('insert into prior_scores(club_id, req_id, score) values ($1,$2,$3)',
          [club.id, r.id, round1(Math.min(r.max_score, 1.5 + rand() * 1.4))]);
      }
    }
  }

  // ---- evidence and statuses
  const upload = async (clubKey, reqId, name) => {
    const c = CLUBS.find((x) => x.key === clubKey);
    const data = makePdf([c.name, `${reqId} evidence`, name, 'Dummy prototype document']);
    await db.query(
      `insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`,
      [clubIds[clubKey], reqId, name, data.length, data, c.userId]);
  };
  const setItem = (clubKey, reqId, status, verification = null, comment = null, by = null) => db.query(
    `update club_items set status=$3, verification=$4, return_comment=$5, verified_by=$6, verified_at = case when $4::text is null then null else now() end
     where club_id=$1 and req_id=$2`, [clubIds[clubKey], reqId, status, verification, comment, by]);

  const addStaff = async (clubKey, count, status, by) => {
    const c = CLUBS.find((x) => x.key === clubKey);
    const rand = rng(clubIds[clubKey] * 13);
    for (const [i, [position, team, qual, gender]] of STAFF.slice(0, count).entries()) {
      const person = `${FIRST[(i + clubIds[clubKey]) % 12]} ${LAST[(i * 5 + clubIds[clubKey]) % 12]}`;
      const { rows: [row] } = await db.query(
        `insert into staff_rows(club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
           blue_card_expiry, years_at_club, employment_type, status, verification, verified_by)
         values ($1,$2,$3,$4,$5,$6,'2028-06-30',$7,$8,'2028-12-31',$9,$10,$11,$12,$13) returning id`,
        [clubIds[clubKey], position, person, gender, team, qual, String(10000000 + Math.floor(rand() * 9e7)),
          `BC${100000 + i}`, 1 + Math.floor(rand() * 6), position === 'Head Coach' ? 'Casual' : (i < 2 ? 'Full time' : 'Part time'),
          status, status === 'approved' ? 'verified' : null, status === 'approved' ? by : null]);
      const data = makePdf([person, qual, 'Certificate (dummy)']);
      await db.query(
        `insert into files(club_id, staff_row_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`,
        [clubIds[clubKey], row.id, `${person.replace(' ', '_')}_certificate.pdf`, data.length, data, c.userId]);
    }
  };

  const docReqs = reqs.filter((r) => r.kind === 'document');
  const fieldReqs = reqs.filter((r) => r.kind === 'onfield' || r.kind === 'fq');

  // Riverside (demo club): early in the cycle.
  await upload('riverside', 'P1', 'Club_Values_Mission_Vision_2027.pdf');
  await setItem('riverside', 'P1', 'submitted');
  await upload('riverside', 'P2', 'Player_Development_Methodology_v3.pdf');
  await upload('riverside', 'P2', 'Age_Specific_Coaching_Content.pdf');
  await setItem('riverside', 'P2', 'submitted');
  await upload('riverside', 'P3', 'Playing_Style_draft.pdf');
  await setItem('riverside', 'P3', 'returned', 'returned',
    'The playing style document covers the senior team only. Please add the principles for each academy phase (U9-U13 and U14-U18).', sam);
  await upload('riverside', 'NN1', 'Fee_Breakdown_FQ_Template.pdf');
  await setItem('riverside', 'NN1', 'approved', 'verified', null, jordan);
  await addStaff('riverside', 4, 'submitted');

  // Coastal (Gold, pool A), Northgate (pool B): everything in and verified.
  for (const key of ['coastal', 'northgate']) {
    const [f] = assign[key];
    for (const r of docReqs) {
      const { rows: [it] } = await db.query('select selected from club_items where club_id=$1 and req_id=$2', [clubIds[key], r.id]);
      if (!it.selected) continue;
      await upload(key, r.id, `${r.id}_${r.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}.pdf`);
      await setItem(key, r.id, 'approved', 'verified', null, f);
    }
    for (const r of fieldReqs) await setItem(key, r.id, 'approved', 'observed', null, f);
    await addStaff(key, STAFF.length, 'approved', f);
  }

  // Highland (pool C): partially submitted, one returned, first assessor part way through scoring.
  for (const id of ['P2', 'P5', 'P1', 'D1', 'D2', 'D6', 'O10', 'NN1', 'NN3']) {
    await upload('highland', id, `${id}_highland_submission.pdf`);
    await setItem('highland', id, id === 'D2' ? 'returned' : 'submitted', id === 'D2' ? 'returned' : null,
      id === 'D2' ? 'The workload file has no dates. Please upload the dated tracking export for the full season so far.' : null, priya);
  }
  await addStaff('highland', 8, 'submitted');

  // ---- scores
  const allScorable = async (key) => {
    const club = CLUBS.find((c) => c.key === key);
    const { rows: items } = await db.query('select req_id, selected from club_items where club_id=$1', [clubIds[key]]);
    const sel = Object.fromEntries(items.map((i) => [i.req_id, i.selected]));
    return reqs.filter((r) => {
      if (r.id === 'O8' && club.shield === 'Gold') return false;
      if (r.id === 'O12' && club.shield !== 'Gold') return false;
      if (r.section === 'planning' && sel[r.id] === false) return false;
      return true;
    });
  };
  const putScore = (key, reqId, assessor, score, note = null) => db.query(
    `insert into scores(club_id, req_id, assessor_id, slot, score, note) values ($1,$2,$3,'first',$4,$5)`,
    [clubIds[key], reqId, assessor, score, note]);

  const scoreClub = async (key, base, spread, { disputes = [], skipSecond = [], lock = true }) => {
    const [a1, a2] = assign[key];
    const rand = rng(clubIds[key] * 31);
    for (const r of await allScorable(key)) {
      const m = Number(r.max_score);
      let s1 = r.section === 'nn' ? 1 : round1(Math.min(m, Math.max(0, m * (base + (rand() - 0.5) * spread))));
      let s2 = r.section === 'nn' ? 1 : round1(Math.min(m, Math.max(0, s1 + (rand() - 0.5) * 0.8 * (m / 3))));
      if (r.section !== 'nn' && Math.abs(s1 - s2) > 0.5) s2 = round1(s1 + (s2 > s1 ? 0.5 : -0.5));
      s2 = Math.min(m, Math.max(0, s2));
      if (disputes.includes(r.id)) s2 = round1(Math.max(0, s1 - Math.max(1, m / 3)));
      await putScore(key, r.id, a1, s1);
      if (!skipSecond.includes(r.id)) await putScore(key, r.id, a2, s2);
    }
    if (lock) {
      await db.query('insert into score_locks(club_id, assessor_id) values ($1,$2),($1,$3)', [clubIds[key], a1, a2]);
    }
  };
  await scoreClub('coastal', 0.82, 0.25, { disputes: ['P2', 'D8', 'O10'], skipSecond: ['D21'] });
  await scoreClub('northgate', 0.66, 0.3, { disputes: ['D16'] });

  // Highland: first assessor has scored a handful of items, not locked.
  for (const [id, s] of [['P2', 2.5], ['P5', 2], ['P1', 1.8], ['D1', 2.1], ['T01', 2.4]]) await putScore('highland', id, priya, s);

  // Northgate fully reconciled: auto within threshold (average), D16 by team consensus.
  const { rows: ns } = await db.query(
    'select req_id, array_agg(score::float8 order by slot) s from scores where club_id=$1 group by req_id', [clubIds.northgate]);
  for (const r of ns) {
    if (r.req_id === 'D16') {
      await db.query(`insert into resolutions(club_id, req_id, final_score, method, note) values ($1,'D16',2.6,'consensus',$2)`,
        [clubIds.northgate, 'Agreed at team moderation meeting after reviewing match footage notes.']);
    } else {
      const final = r.req_id.startsWith('NN') ? r.s[0] : round1((r.s[0] + r.s[1]) / 2);
      await db.query(`insert into resolutions(club_id, req_id, final_score, method, note) values ($1,$2,$3,'auto','Within threshold: average')`,
        [clubIds.northgate, r.req_id, final]);
    }
  }

  // Coastal: D8 disagreement already handed to a moderator (Sam is not an assessor on Coastal).
  await db.query('insert into moderations(club_id, req_id, moderator_id, assigned_by) values ($1,$2,$3,$4)',
    [clubIds.coastal, 'D8', sam, admin.id]);

  await db.query(`select set_config('app.uid', '', false)`);

  if (issueLinks) {
    const { rows: users } = await db.query('select id from users order by id');
    for (const u of users) await issueLink(u.id);
  }
  return { clubIds, admin: admin.id, assessors };
}
