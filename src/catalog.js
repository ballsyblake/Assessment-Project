import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDANCE } from './guidance.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SECTIONS = [
  { id: 'planning', label: 'Planning' },
  { id: 'staff', label: 'Staff Qualifications' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'outcomes', label: 'Outcomes' },
  { id: 'nn', label: 'Non-negotiables' },
];
export const sectionLabel = (id) => SECTIONS.find((s) => s.id === id)?.label ?? id;

// Staff table positions offered to clubs (maps rows to the T-items assessors score).
export const STAFF_POSITIONS = [
  'Technical Director', 'Head of Youth Academy', 'Head of Junior Academy', 'Head of Girls Academy',
  'Head of Goalkeeping', 'Female Technical Lead', 'Head of Sports Science and Medicine',
  'Head Coach', 'Goalkeeping Coach', 'Assistant Coach',
];
export const STAFF_TEAMS = ['', 'U9 Boys', 'U10 Boys', 'U10 Girls', 'U11 Boys', 'U11 Girls', 'U12 Boys', 'U12 Girls',
  'U13 Boys', 'U13 Girls', 'U14 Boys', 'U14 Girls', 'U15 Boys', 'U15 Girls', 'U16 Boys', 'U16 Girls',
  'U18 Boys', 'U18 Girls'];

function kindFor(r) {
  if (r.section === 'staff') return 'staff';
  const e = r.evidence.toLowerCase();
  if (e.includes('assessed by fq')) return 'fq';
  if (e.includes('electronic') || e.includes('supporting') || e.includes('submission') || e.includes('email list')) return 'document';
  return 'onfield';
}

// Source: FQ Club Development Info Pack 2027, Appendix 7 (Tier 1 rubric descriptors).
export function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'rubric.json'), 'utf8'));
  return raw.map((r, i) => ({
    id: r.code,
    section: r.section,
    grp: r.group,
    name: r.name,
    kind: kindFor(r),
    evidence: r.evidence,
    max_score: r.maxScore,
    weight: r.weight,
    guidance: GUIDANCE[r.code] ?? 'Upload the evidence for this item.',
    criteria: r.criteria,
    sort: i,
  }));
}

// Which requirements apply to a given club this cycle.
//  - Gold clubs are assessed on O12, all others on O8 (Appendix 7 note).
//  - Pool A/C clubs: planning is assessed on P2, P5 + up to three chosen items;
//    the rest carry forward from the previous cycle.
export function applicable(req, club, item) {
  if (req.id === 'O8' && club.current_shield === 'Gold') return { applies: false, why: 'Gold clubs are assessed on O12 instead' };
  if (req.id === 'O12' && club.current_shield !== 'Gold') return { applies: false, why: 'Only Gold clubs are assessed on O12' };
  if (req.section === 'planning' && (club.pool === 'A' || club.pool === 'C')) {
    if (item && !item.selected) return { applies: false, carry: true, why: 'Not assessed this cycle (previous score carried forward)' };
  }
  return { applies: true };
}
