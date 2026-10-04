/**
 * #1561 (a reviewer's Person review, 15:01Z) — peopleFromRows used to NORMALISE malformed
 * identities: an invalid `resolved` became false, and two names chose whichever row
 * came last (reversing the rows changed the name). Malformed data must not reach the
 * planner looking valid: cardinality and values are checked BEFORE folding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleFromRows } from '../core/logborn-unit.mjs';
import { LOGBORN_TERMS as TM } from '../core/graph-compiler.mjs';

const P = 'https://scrumboard.local/person/ada';
const ok = () => [
  { s: P, p: TM.identifier, o: 'ada' }, { s: P, p: TM.name, o: 'Ada' },
  { s: P, p: TM.resolved, o: 'true' }, { s: P, p: TM.aliases, o: 'a' }, { s: P, p: TM.aliases, o: 'ad' },
];

test('#1561 a well-formed Person folds, and row order does not matter (twin)', () => {
  const a = peopleFromRows(ok()), b = peopleFromRows(ok().reverse());
  assert.deepEqual(a, b);
  assert.equal(a[0].name, 'Ada');
  assert.equal(a[0]['scrum:resolved'], true);
  assert.deepEqual(a[0]['scrum:aliases'], ['a', 'ad']);
});

test('#1561 two names for one Person is an integrity error, in either row order', () => {
  const rows = [...ok(), { s: P, p: TM.name, o: 'Ada Lovelace' }];
  assert.throws(() => peopleFromRows(rows), /PERSON_INTEGRITY|more than one/);
  assert.throws(() => peopleFromRows([...rows].reverse()), /PERSON_INTEGRITY|more than one/);
});

test('#1561 a resolved value other than "true"/"false" is an integrity error, not false', () => {
  const rows = ok().map((r) => (r.p === TM.resolved ? { ...r, o: 'yes' } : r));
  assert.throws(() => peopleFromRows(rows), /PERSON_INTEGRITY|resolved/);
});

test('#1561 a Person with no identifier, or two, is an integrity error', () => {
  assert.throws(() => peopleFromRows(ok().filter((r) => r.p !== TM.identifier)), /PERSON_INTEGRITY|identifier/);
  assert.throws(() => peopleFromRows([...ok(), { s: P, p: TM.identifier, o: 'ada2' }]), /PERSON_INTEGRITY|identifier/);
});
