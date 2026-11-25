// Fictional clubs, people and dummy evidence (spec section 8). No real clubs or people.
// autoComplete() is reused by the demo "fast-forward" so a whole cycle can be shown.
import { sys, schemaVersion } from './db.js';
import { catalogRows, framework } from './catalog.js';
import { suggestStaffScores } from './staffCalc.js';
import { issueLink } from './auth.js';

export function makePdf(lines) {
  const text = lines.map((l, i) => `BT /F1 12 Tf 60 ${760 - i * 18} Td (${String(l).replace(/[()\\]/g, '')}) Tj ET`).join('\n');
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

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const r1 = (x) => Math.round(x * 10) / 10;
const daysFromNow = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

export const CLUBS = [
  { key: 'riverside', name: 'Riverside Rovers FC', pool: 'B', shield: 'Silver', q: 0.62, contact: ['Taylor Morgan', 'td@riverside-rovers.example'] },
  { key: 'coastal', name: 'Coastal United SC', pool: 'A', shield: 'Gold', q: 0.86, contact: ['Jamie Fraser', 'td@coastal-united.example'] },
  { key: 'highland', name: 'Highland Park FC', pool: 'C', shield: 'Bronze', q: 0.5, contact: ['Robin Hale', 'td@highland-park.example'] },
  { key: 'northgate', name: 'Northgate Athletic', pool: 'B', shield: 'Silver', q: 0.7, contact: ['Casey Walsh', 'td@northgate-athletic.example'] },
  { key: 'bayside', name: 'Bayside Wanderers', pool: 'A', shield: 'Gold', q: 0.8, contact: ['Morgan Ellis', 'td@bayside-wanderers.example'] },
  { key: 'westfield', name: 'Westfield City', pool: 'C', shield: 'Development Committed', q: 0.42, contact: ['Jesse Park', 'td@westfield-city.example'] },
];
export const ASSESSORS = [
  ['Sam Reid', 'sam.reid@fq-assess.example'],
  ['Jordan Lee', 'jordan.lee@fq-assess.example'],
  ['Priya Nair', 'priya.nair@fq-assess.example'],
  ['Chris Doyle', 'chris.doyle@fq-assess.example'],
  ['Ellis Grant', 'ellis.grant@fq-assess.example'],
  ['Noor Haddad', 'noor.haddad@fq-assess.example'],
  ['Kai Tanaka', 'kai.tanaka@fq-assess.example'],
  ['Frankie Moss', 'frankie.moss@fq-assess.example'],
];
const DATA_OFFICER = ['Riley Quinn', 'riley.quinn@fq-assess.example'];
const ADMIN = ['Alex Admin', 'admin@fq-assess.example'];
const LEADS = { riverside: 0, coastal: 1, highland: 2, northgate: 3, bayside: 4, westfield: 5 };
const OPTIONAL_PICKS = { coastal: ['P1', 'P8', 'P14'], bayside: ['P3', 'P6', 'P11'], highland: ['P1', 'P9', 'P15'], westfield: ['P4', 'P10', 'P14'] };

// Staff table template: [position, team, gender]. Qualifications are chosen per club from the
// framework's lookup tables, so the staff calculator has realistic inputs.
const STAFF = [
  ['Technical Director', '', 'M'], ['Head of Youth Academy', '', 'M'], ['Head of Junior Academy', '', 'F'],
  ['Head of Girls Academy', '', 'F'], ['Head of Goalkeeping', '', 'M'], ['Female Technical Lead', '', 'F'],
  ['Head of Sports Science and Medicine', '', 'M'],
  ['Head Coach', 'U18 Boys', 'M'], ['Head Coach', 'U17 Girls', 'F'], ['Head Coach', 'U16 Boys', 'M'], ['Head Coach', 'U15 Boys', 'M'],
  ['Head Coach', 'U15 Girls', 'F'], ['Head Coach', 'U14 Boys', 'M'], ['Head Coach', 'U14 Girls', 'F'], ['Head Coach', 'U13 Boys', 'M'],
  ['Head Coach', 'U13 Girls', 'F'], ['Head Coach', 'U12 Boys', 'M'], ['Head Coach', 'U11 Boys', 'M'], ['Head Coach', 'U11 Girls', 'F'],
  ['Head Coach', 'U10 Boys', 'M'], ['Head Coach', 'U9 Boys', 'M'],
];
const COACH_QUALS = ['A Diploma or Equivalent', 'B Diploma or Equivalent', 'C Diploma or Equivalent', 'Foundation of Football', 'Skill Training / Game Training / Senior Certificate'];
const YEARS = ['> 5 years', '3-4 years', '1-2 years', '< 1 year'];
const FIRST = ['Alex', 'Jordan', 'Morgan', 'Riley', 'Avery', 'Quinn', 'Drew', 'Harper', 'Reese', 'Rowan', 'Sky', 'Emerson'];
const LAST = ['Baker', 'Chen', 'Doyle', 'Evans', 'Foster', 'Grant', 'Hughes', 'Ito', 'Jensen', 'Khan', 'Lopez', 'Moore'];
const COMMENTS = {
  planning: 'Planning documents are clear and well organised. The next step is showing more explicitly how the methodology is applied in each development phase.',
  staff: 'Qualification levels are solid across the leadership group. Prioritise course pathways for junior head coaches next season.',
  delivery: 'Sessions observed were well organised with clear objectives. Feedback quality varied between age groups and is the main area to work on.',
  outcomes: 'Retention and member satisfaction are positives. Progressing players into representative pathways remains the biggest opportunity.',
  nn: 'Compliance documents were submitted on time. Shield threshold standards are summarised above; see the notes on any item marked On Notice.',
  overall: 'A strong season with clear progress in planning and delivery. Focus next year on consistent coach feedback and the player pathway.',
};

async function as(uid) { await sys().query(`select set_config('app.uid', $1, false)`, [uid ? String(uid) : '']); }

// Pattern used in 2026: evidence items have one first and one second assessor per item for all clubs;
// observation items are assessed by whoever attends that club's visit.
function slotFor({ req, itemIdx, clubIdx, assessors, dataOfficer }) {
  const n = assessors.length;
  if (req.assessors === 1) return { first: req.type === 'ticks' ? assessors[itemIdx % n] : dataOfficer };
  if (req.kind === 'onfield') return { first: assessors[(clubIdx * 2) % n], second: assessors[(clubIdx * 2 + 5) % n] };
  return { first: assessors[itemIdx % n], second: assessors[(itemIdx + 3) % n] };
}

function genScore(req, q, rand, base) {
  if (req.type === 'ticks') {
    if (base) {
      const t2 = base.ticks.map((t) => (rand() < 0.035 ? (t === 'y' ? 'p' : t === 'p' ? (rand() < 0.5 ? 'y' : 'n') : 'p') : t));
      // Occasionally the same score from different criteria: the admin is told about these.
      if (rand() < 0.08) {
        const i = t2.findIndex((x) => x === 'y'); const j = t2.findIndex((x) => x !== 'y');
        if (i >= 0 && j >= 0) [t2[i], t2[j]] = [t2[j], t2[i]];
      }
      return { ticks: t2 };
    }
    return { ticks: Array.from({ length: req.n_criteria }, () => { const x = rand(); return x < q ? 'y' : x < q + 0.15 ? 'p' : 'n'; }) };
  }
  if (req.type === 'yesno') return { score: base ? base.score : rand() < 0.95 ? 1 : 0 };
  if (req.type === 'threshold') {
    if (base) return { score: base.score };
    const level = q >= 0.78 ? 4 : q >= 0.6 ? 3 : q >= 0.45 ? 2 : 1;
    return { score: rand() < 0.15 ? 0.5 : level };
  }
  if (req.type === 'value') {
    const u = req.unit ?? '';
    const v = u.includes('%') ? Math.round(40 + q * 50 + rand() * 10) : u.includes('NPS') ? Math.round(-5 + q * 50 + rand() * 10) : Math.round(q * 10 * rand() * 1.5);
    return { value: v };
  }
  if (base) return { score: rand() < 0.85 ? base.score : r1(Math.max(0, Math.min(req.max_score, base.score + (rand() < 0.5 ? -0.5 : 0.5) * (req.max_score / 3)))) };
  return { score: r1(Math.min(req.max_score, Math.max(0, req.max_score * (q + (rand() - 0.5) * 0.3)))) };
}

async function ids() {
  const db = sys();
  const clubs = (await db.query('select * from clubs order by id')).rows;
  const assessors = (await db.query(`select id from users where role = 'assessor' and email <> $1 order by id`, [DATA_OFFICER[1]])).rows.map((r) => r.id);
  const dataOfficer = (await db.query('select id from users where email = $1', [DATA_OFFICER[1]])).rows[0]?.id ?? assessors[0];
  const admin = (await db.query(`select id from users where role = 'admin' order by id limit 1`)).rows[0].id;
  return { clubs, assessors, dataOfficer, admin };
}

/**
 * Drive the given phases to completion with dummy data: evidence verified, slots filled,
 * scores entered, locks, third assessments, lead comments, phase closed.
 */
export async function autoComplete({ phases, leaveDisputes = 0, close = true, comments = true, seed = 7 }) {
  const db = sys();
  const { clubs, assessors, dataOfficer, admin } = await ids();
  const reqs = catalogRows();
  const rand = rng(seed);
  for (const phase of phases) {
    const preqs = reqs.filter((r) => r.section === phase);
    await db.query('update phases set deadline = least(coalesce(deadline, current_date - 1), current_date - 1) where id = $1', [phase]);
    for (const [ci, club] of clubs.entries()) {
      const cfg = CLUBS.find((c) => c.name === club.name) ?? { q: 0.6 };
      const contact = (await db.query('select id from users where club_id = $1 order by id limit 1', [club.id])).rows[0]?.id ?? admin;
      let staffSuggest = {};
      if (phase === 'staff') {
        const { rows: [{ n }] } = await db.query('select count(*)::int n from staff_rows where club_id = $1', [club.id]);
        if (!n) await addStaff(club, contact, 'approved');
        await db.query(`update staff_rows set status = 'approved', verification = 'verified' where club_id = $1 and status = 'submitted'`, [club.id]);
        staffSuggest = suggestStaffScores((await db.query('select * from staff_rows where club_id = $1 order by id', [club.id])).rows);
      }
      for (const [ii, req] of preqs.entries()) {
        const { rows: [{ applies }] } = await db.query('select item_applies($1,$2) as applies', [club.id, req.id]);
        if (!applies) continue;
        const slots = slotFor({ req, itemIdx: reqs.indexOf(req), clubIdx: ci, assessors, dataOfficer });
        await as(admin);
        for (const [slot, who] of Object.entries(slots)) {
          await db.query('insert into slots(club_id, req_id, slot, assessor_id) values ($1,$2,$3,$4) on conflict do nothing', [club.id, req.id, slot, who]);
        }
        if (req.kind === 'document') {
          const { rows: [{ n }] } = await db.query('select count(*)::int n from files where club_id = $1 and req_id = $2', [club.id, req.id]);
          if (!n) {
            const data = makePdf([club.name, `${req.id} ${req.name}`, 'Dummy prototype document']);
            await db.query(`insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`,
              [club.id, req.id, `${req.id}_${req.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}.pdf`, data.length, data, contact]);
          }
        }
        if (req.kind !== 'staff') {
          const first = (await db.query(`select assessor_id from slots where club_id = $1 and req_id = $2 and slot = 'first'`, [club.id, req.id])).rows[0].assessor_id;
          await db.query(`update club_items set status = 'approved', verification = $3, verified_by = $4, verified_at = now(), return_comment = null
            where club_id = $1 and req_id = $2 and status not in ('approved','not_accepted')`,
          [club.id, req.id, req.kind === 'document' ? 'verified' : 'observed', first]);
        }
        // scores
        const { rows: have } = await db.query('select slot, ticks, score from scores where club_id = $1 and req_id = $2', [club.id, req.id]);
        const { rows: holders } = await db.query('select slot, assessor_id from slots where club_id = $1 and req_id = $2 order by slot', [club.id, req.id]);
        let firstScore = have.find((h) => h.slot === 'first');
        for (const h of holders) {
          if (have.find((x) => x.slot === h.slot)) continue;
          const s = genScore(req, cfg.q, rand, h.slot === 'second' ? firstScore : null);
          // Staff items: the first assessor accepts the calculated suggestion where there is one.
          if (req.section === 'staff' && h.slot === 'first' && staffSuggest[req.id]?.score != null) s.score = staffSuggest[req.id].score;
          if (req.id === 'NN7' && cfg.key === 'riverside') s.score = 0.5; // on notice again: shows the downgrade rule
          await as(h.assessor_id);
          await db.query(`insert into scores(club_id, req_id, slot, assessor_id, ticks, value, score, comment) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [club.id, req.id, h.slot, h.assessor_id, s.ticks ? JSON.stringify(s.ticks) : null, s.value ?? null, s.score ?? 0,
              h.slot === 'first' ? 'Evidence reviewed against the descriptor.' : 'Reviewed independently against the descriptor.']);
          if (h.slot === 'first') firstScore = { ticks: s.ticks, score: s.score };
        }
      }
    }
    // locks
    const { rows: toLock } = await db.query(
      `select distinct s.club_id, s.assessor_id from slots s join requirements q on q.id = s.req_id
       where q.section = $1 and not exists (select 1 from score_locks l where l.club_id = s.club_id and l.assessor_id = s.assessor_id and l.phase = $1)`, [phase]);
    for (const l of toLock) {
      await as(l.assessor_id);
      await db.query('insert into score_locks(club_id, assessor_id, phase) values ($1,$2,$3)', [l.club_id, l.assessor_id, phase]);
    }
    // disputes -> third assessor
    const { rows: disputes } = await db.query(
      `select q.id req_id, c.id club_id from clubs c cross join requirements q
       where q.section = $1 and item_applies(c.id, q.id) and item_locked(c.id, q.id)
         and not exists (select 1 from resolutions r where r.club_id = c.id and r.req_id = q.id) order by c.id, q.sort`, [phase]);
    for (const [i, d] of disputes.entries()) {
      if (i < leaveDisputes) continue;
      const { rows: hs } = await db.query('select assessor_id from slots where club_id = $1 and req_id = $2', [d.club_id, d.req_id]);
      const third = assessors.find((a, k) => k >= (i % assessors.length) && !hs.some((h) => h.assessor_id === a)) ?? assessors.find((a) => !hs.some((h) => h.assessor_id === a));
      await as(admin);
      await db.query('insert into third_assignments(club_id, req_id, assessor_id, assigned_by) values ($1,$2,$3,$4) on conflict do nothing', [d.club_id, d.req_id, third, admin]);
      const { rows: [f] } = await db.query(`select ticks, score from scores where club_id = $1 and req_id = $2 and slot = $3`, [d.club_id, d.req_id, rand() < 0.5 ? 'first' : 'second']);
      await as(third);
      await db.query(`insert into scores(club_id, req_id, slot, assessor_id, ticks, score, comment) values ($1,$2,'third',$3,$4,$5,$6)`,
        [d.club_id, d.req_id, third, f.ticks ? JSON.stringify(f.ticks) : null, f.score ?? 0, 'Third assessment: reviewed both comments and the submitted evidence.']);
    }
    if (comments) {
      for (const club of clubs) {
        const { rows: [{ open }] } = await db.query(
          `select count(*)::int open from requirements q where q.section = $2 and item_applies($1, q.id)
           and not exists (select 1 from resolutions r where r.club_id = $1 and r.req_id = q.id)`, [club.id, phase]);
        const lead = (await db.query('select lead_id from club_leads where club_id = $1', [club.id])).rows[0]?.lead_id;
        if (open || !lead) continue;
        await as(lead);
        await db.query(`insert into lead_comments(club_id, section, body) values ($1,$2,$3) on conflict do nothing`, [club.id, phase, COMMENTS[phase]]);
      }
    }
    if (close && !leaveDisputes) { await as(admin); await db.query('update phases set closed_at = now() where id = $1 and closed_at is null', [phase]); }
  }
  if (comments) {
    for (const club of clubs) {
      const { rows: [{ open }] } = await db.query(
        `select count(*)::int open from requirements q where item_applies($1, q.id) and not exists (select 1 from resolutions r where r.club_id = $1 and r.req_id = q.id)`, [club.id]);
      const lead = (await db.query('select lead_id from club_leads where club_id = $1', [club.id])).rows[0]?.lead_id;
      if (open || !lead) continue;
      await as(lead);
      await db.query(`insert into lead_comments(club_id, section, body) values ($1,'overall',$2) on conflict do nothing`, [club.id, COMMENTS.overall]);
    }
  }
  await as(null);
}

async function addStaff(club, uploader, status) {
  const db = sys();
  const rand = rng(club.id * 13);
  const q = CLUBS.find((c) => c.name === club.name)?.q ?? 0.6;
  const pick = (list) => list[Math.min(list.length - 1, Math.floor((1 - q) * list.length * 1.3 + rand() * 1.6))];
  let tdName = null;
  for (const [i, [position, team, gender]] of STAFF.entries()) {
    let person = `${FIRST[(i + club.id) % 12]} ${LAST[(i * 5 + club.id) % 12]}`;
    // The Technical Director also coaches the U14 boys: the calculator lowers that coaching score by 1.
    if (position === 'Technical Director') tdName = person;
    if (team === 'U14 Boys' && tdName) person = tdName;
    const qual = position === 'Technical Director' ? (q > 0.75 ? 'A Diploma + 5+ years at the Current Club' : q > 0.55 ? 'A Diploma or Equivalent' : 'B Diploma or Equivalent')
      : position === 'Head of Sports Science and Medicine' ? (q > 0.7 ? 'University Degree' : 'TAFE/Similar')
      : position === 'Head of Goalkeeping' ? (q > 0.7 ? 'B Diploma GK or Level 2 GK' : 'C Diploma GK or Level 1 GK')
      : i < 7 ? pick(COACH_QUALS.slice(0, 3)) : pick(COACH_QUALS);
    const employment = i < 4 ? (q > 0.65 || i === 0 ? 'Full Time' : 'Part Time') : position === 'Head Coach' ? 'Casual' : 'Part Time';
    const { rows: [row] } = await db.query(
      `insert into staff_rows(club_id, position, person, gender, team, qualification, qual_years, qual_expiry, fa_number, blue_card,
         blue_card_expiry, years_at_club, employment_type, status, verification)
       values ($1,$2,$3,$4,$5,$6,$7,'2028-06-30',$8,$9,'2028-12-31',$10,$11,$12,$13) returning id`,
      [club.id, position, person, gender, team || null, qual, YEARS[Math.floor(rand() * 4)], String(10000000 + Math.floor(rand() * 9e7)), `BC${100000 + i}`,
        1 + Math.floor(rand() * 6), employment, status, status === 'approved' ? 'verified' : null]);
    const data = makePdf([person, qual, 'Certificate (dummy)']);
    await db.query(`insert into files(club_id, staff_row_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`,
      [club.id, row.id, `${person.replace(' ', '_')}_${i}_certificate.pdf`, data.length, data, uploader]);
  }
}

export async function seed({ issueLinks = true } = {}) {
  const db = sys();
  const reqs = catalogRows();
  // phases: Planning and Staff finished; Non-negotiables reconciled but not yet closed;
  // Delivery and Outcomes are in their submission period.
  const deadlines = { planning: -60, staff: -40, nn: -40, delivery: 30, outcomes: 60 };
  for (const [i, p] of framework.phases.entries()) {
    await db.query('insert into phases(id, label, sort, deadline) values ($1,$2,$3,$4)', [p.id, p.label, i, daysFromNow(deadlines[p.id] ?? 30)]);
  }
  for (const r of reqs) {
    await db.query(
      `insert into requirements(id, section, grp, name, kind, type, assessors, evidence, max_score, weight, guidance, n_criteria, unit,
        mandatory, optional, only_shields, except_shields, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [r.id, r.section, r.grp, r.name, r.kind, r.type, r.assessors, r.evidence, r.max_score, r.weight, r.guidance, r.n_criteria, r.unit,
        r.mandatory, r.optional, r.only_shields, r.except_shields, r.sort]);
    await db.query('insert into requirement_criteria(req_id, descriptor, criteria, bands) values ($1,$2,$3,$4)',
      [r.id, r.descriptor, JSON.stringify(r.criteria), r.bands ? JSON.stringify(r.bands) : null]);
  }
  const settings = {
    cycle: '2027', internal_deadline: daysFromNow(-1), released_at: '',
    partial_pools: (framework.partialPlanning?.pools ?? []).join(','), max_optional: String(framework.partialPlanning?.maxOptional ?? 0),
    partial_value: String(framework.scoring?.partialValue ?? 0.5),
    schema_version: schemaVersion(),
  };
  for (const [k, v] of Object.entries(settings)) await db.query('insert into settings(key, value) values ($1,$2)', [k, v]);

  const { rows: [admin] } = await db.query(`insert into users(email, name, role) values ($1,$2,'admin') returning id`, [ADMIN[1], ADMIN[0]]);
  await as(admin.id);
  const assessorIds = [];
  for (const [n, e] of [...ASSESSORS, DATA_OFFICER]) {
    assessorIds.push((await db.query(`insert into users(email, name, role) values ($1,$2,'assessor') returning id`, [e, n])).rows[0].id);
  }
  const clubIds = {};
  for (const c of CLUBS) {
    const { rows: [club] } = await db.query('insert into clubs(name, pool, current_shield) values ($1,$2,$3) returning id', [c.name, c.pool, c.shield]);
    clubIds[c.key] = club.id;
    c.userId = (await db.query(`insert into users(email, name, role, club_id, is_primary) values ($1,$2,'club',$3,true) returning id`,
      [c.contact[1], c.contact[0], club.id])).rows[0].id;
    await db.query('insert into club_leads(club_id, lead_id) values ($1,$2)', [club.id, assessorIds[LEADS[c.key]]]);
    const partial = framework.partialPlanning?.pools.includes(c.pool);
    for (const r of reqs) {
      if (r.section === 'staff') continue;
      const selected = !r.optional || !partial || (OPTIONAL_PICKS[c.key] ?? []).includes(r.id);
      await db.query('insert into club_items(club_id, req_id, selected) values ($1,$2,$3)', [club.id, r.id, selected]);
    }
    // previous cycle scores, shown to assessors and used for planning carry-forward
    const rand = rng(club.id * 97);
    for (const r of reqs.filter((x) => x.type !== 'yesno')) {
      const score = r.type === 'threshold'
        ? (c.key === 'riverside' && r.id === 'NN7' ? 0.5 : { Gold: 4, Silver: 3, Bronze: 2 }[c.shield] ?? 1)
        : r1(Math.min(r.max_score, Math.max(0, r.max_score * (c.q + (rand() - 0.5) * 0.3))));
      await db.query('insert into prior_scores(club_id, req_id, score) values ($1,$2,$3)', [club.id, r.id, score]);
    }
  }

  // Finished phases, with two Staff disputes left for the admin to send to a third assessor.
  await autoComplete({ phases: ['planning'], seed: 11 });
  await autoComplete({ phases: ['nn'], close: false, seed: 12 });
  await autoComplete({ phases: ['staff'], leaveDisputes: 2, comments: true, seed: 13 });

  // Delivery submission period: a mix of club progress.
  const upload = async (key, reqId, name) => {
    const c = CLUBS.find((x) => x.key === key);
    const data = makePdf([c.name, `${reqId} evidence`, name, 'Dummy prototype document']);
    await db.query(`insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`,
      [clubIds[key], reqId, name, data.length, data, c.userId]);
    await db.query(`update club_items set status = 'submitted' where club_id = $1 and req_id = $2`, [clubIds[key], reqId]);
  };
  await upload('riverside', 'D1', 'Attendance_and_game_time_2027.pdf');
  await upload('riverside', 'D2', 'Workload_tracking_export.pdf');
  await upload('riverside', 'D3', 'Wellbeing_survey_summary.pdf');
  await db.query(`update club_items set status = 'returned', verification = 'returned', verified_by = $2, verified_at = now(),
    return_comment = 'The wellbeing records are undated. Please upload the dated survey results for each collection point.'
    where club_id = $1 and req_id = 'D3'`, [clubIds.riverside, assessorIds[2]]);
  const rand = rng(5);
  for (const key of ['coastal', 'northgate', 'bayside', 'highland']) {
    for (const r of reqs.filter((x) => x.section === 'delivery' && x.kind === 'document')) {
      if (rand() < ({ coastal: 0.8, bayside: 0.7, northgate: 0.5, highland: 0.25 }[key])) await upload(key, r.id, `${r.id}_${key}_submission.pdf`);
    }
  }
  // Delivery slots are assigned up front so assessors see what is coming.
  const { clubs, assessors, dataOfficer } = await ids();
  for (const ph of ['delivery', 'outcomes']) {
    for (const [ci, club] of clubs.entries()) {
      for (const req of reqs.filter((r) => r.section === ph)) {
        const { rows: [{ applies }] } = await db.query('select item_applies($1,$2) as applies', [club.id, req.id]);
        if (!applies) continue;
        for (const [slot, who] of Object.entries(slotFor({ req, itemIdx: reqs.indexOf(req), clubIdx: ci, assessors, dataOfficer }))) {
          await db.query('insert into slots(club_id, req_id, slot, assessor_id) values ($1,$2,$3,$4) on conflict do nothing', [club.id, req.id, slot, who]);
        }
      }
    }
  }
  await as(null);
  if (issueLinks) {
    for (const u of (await db.query('select id from users order by id')).rows) await issueLink(u.id);
  }
  return { clubIds, admin: admin.id, assessors: assessorIds };
}
