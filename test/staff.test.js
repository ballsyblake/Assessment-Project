// Staff qualification calculator, on fictional staff rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestStaffScores } from '../src/staffCalc.js';

const rows = [
  { position: 'Technical Director', person: 'Ash Lee', gender: 'M', qualification: 'A Diploma or Equivalent', employment_type: 'Full Time' },
  { position: 'Head of Youth Academy', person: 'Ash Lee', gender: 'M', qualification: 'A Diploma or Equivalent', employment_type: 'Full Time' },
  { position: 'Head of Junior Academy', person: 'Bo Ray', gender: 'M', qualification: 'C Diploma or Equivalent', employment_type: 'Part Time' },
  { position: 'Female Technical Lead', person: 'Cy Fox', gender: 'M', qualification: 'B Diploma or Equivalent' },
  { position: 'Head of Sports Science and Medicine', person: 'Di Orr', gender: 'F', qualification: 'TAFE/Similar' },
  { position: 'Head Coach', team: 'U14 Boys', person: 'Ash Lee', gender: 'M', qualification: 'A Diploma or Equivalent', qual_years: '> 5 years' },
  { position: 'Head Coach', team: 'U14 Girls', person: 'Em Kay', gender: 'F', qualification: 'C Diploma or Equivalent', qual_years: '1-2 years' },
  { position: 'Head Coach', team: 'U9 Boys', person: 'Bo Ray', gender: 'M', qualification: 'C Diploma or Equivalent', qual_years: '3-4 years' },
  { position: 'Head Coach', team: 'U16 Boys', person: 'Fi Ng', gender: 'M', qualification: 'B Diploma or Equivalent', qual_years: '< 1 year' },
];
const s = suggestStaffScores(rows);

test('lookup tables: TD table, leadership column, sports science table', () => {
  assert.equal(s.T01.score, 2); // A Diploma in the TD table
  assert.equal(s.T02.score, 3);
  assert.equal(s.T07.score, 2); // TAFE/Similar
});
test('Female Technical Lead who is not female scores 0', () => assert.equal(s.T06.score, 0));
test('TD coaching a team is lowered by 1; age group averages its teams', () => {
  // U14: TD 3 (u14-) - 1 = 2; female coach C = 2 -> average 2
  assert.equal(s.T11.score, 2);
});
test('Head of Junior coaching in own phase is lowered by 1', () => assert.equal(s.T16.score, 1)); // C u14- = 2, minus 1
test('U15+ column for youth teams', () => assert.equal(s.T09.score, 2)); // B Diploma, U16 -> 2
test('experience: average per age group, 0 when qualification score is 0', () => {
  // U14: (>5 = 3, 1-2 = 1) avg 2; U9: 3-4 = 2; U16: <1 = 0 -> 4
  assert.equal(s.T17.score, 4);
});
test('full/part time counted once per person across leadership roles', () => {
  assert.equal(s.T18.score, 6 + 3); // TD+HoY same person (6), HoJ part time (3)
});
test('missing age group scores 0 with a note', () => {
  assert.equal(s.T08.score, 0);
  assert.match(s.T08.notes[0], /No coach listed/);
});
