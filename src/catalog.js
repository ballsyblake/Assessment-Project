// Loads the assessment framework (items, criteria, bands, thresholds, rules) from a
// JSON file, so the platform code carries no FQ-specific content.
// Set FRAMEWORK_FILE to use a framework kept outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.FRAMEWORK_FILE ?? path.join(here, '..', 'data', 'frameworks', 'fq-tier1-2027.json');

export const framework = JSON.parse(fs.readFileSync(FILE, 'utf8'));
export const SECTIONS = framework.phases.map((p) => ({ id: p.id, label: p.label }));
export const sectionLabel = (id) => (id === 'overall' ? 'Overall' : SECTIONS.find((s) => s.id === id)?.label ?? id);

export const STAFF_POSITIONS = [
  'Technical Director', 'Head of Youth Academy', 'Head of Junior Academy', 'Head of Girls Academy',
  'Head of Goalkeeping', 'Female Technical Lead', 'Head of Sports Science and Medicine',
  'Head Coach', 'Goalkeeping Coach', 'Assistant Coach',
];
export const STAFF_TEAMS = ['', 'U9 Boys', 'U10 Boys', 'U10 Girls', 'U11 Boys', 'U11 Girls', 'U12 Boys', 'U12 Girls',
  'U13 Boys', 'U13 Girls', 'U14 Boys', 'U14 Girls', 'U15 Boys', 'U15 Girls', 'U16 Boys', 'U16 Girls',
  'U18 Boys', 'U18 Girls'];

export function catalogRows() {
  return framework.items.map((it, i) => ({
    id: it.id, section: it.section, grp: it.group, name: it.name, kind: it.kind, type: it.type,
    assessors: it.assessors, evidence: it.evidence, max_score: it.maxScore, weight: it.weight,
    guidance: it.guidance, n_criteria: it.criteria?.length ?? 0, unit: it.unit ?? null,
    mandatory: Boolean(it.mandatory), optional: Boolean(it.optional),
    only_shields: it.onlyShields ?? null, except_shields: it.exceptShields ?? null, sort: i,
    descriptor: it.descriptor, criteria: it.criteria ?? [], bands: it.bands ?? null,
  }));
}

// UI mirror of the database function item_applies(): the database is authoritative.
export function applicable(req, club, item) {
  if (req.only_shields && !req.only_shields.includes(club.current_shield)) return { applies: false, why: `Only ${req.only_shields.join('/')} clubs are assessed on this item` };
  if (req.except_shields && req.except_shields.includes(club.current_shield)) return { applies: false, why: `${req.except_shields.join('/')} clubs are not assessed on this item` };
  if (req.optional && framework.partialPlanning?.pools.includes(club.pool) && item && !item.selected) {
    return { applies: false, carry: true, why: 'Not assessed this cycle (previous score carried forward)' };
  }
  return { applies: true };
}
