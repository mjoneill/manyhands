/**
 * #1251 item 2 — the report points at the ASK, and its zero is trustworthy.
 *
 * These are mostly tests of the CONTROL, not of the counting. Counting rows is
 * not where this fails; the failure is a clean confident zero produced by a
 * broken instrument and read as a finding about the room. That happened twice
 * in one afternoon on #1114 and it is the reason this module exists, so the
 * tests that matter are the ones that make a silent detector loud.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askShapeReport, runControls, modelCallRows, CONTROL_FIXTURES } from '../core/ask-shape.mjs';

const call = (over = {}) => ({
  '@type': 'scrum:ModelCall',
  'scrum:agent': 'ada',
  'scrum:wakeKind': 'mention',
  'scrum:toolHops': [],
  'scrum:postedText': 'a plain answer with no claim in it',
  'scrum:unbackedLookupClaims': [],
  'scrum:calledAt': '2026-09-07T12:00:00.000Z',
  ...over,
});
const doc = (...rows) => ({ '@graph': rows });

test('#1251 — the controls pass against the real detector', () => {
  const c = runControls();
  assert.equal(c.ok, true, c.results.filter((r) => !r.pass).map((r) => `${r.name}: expected ${r.expect}, got ${r.got}`).join('; '));
  assert.equal(c.results.length, CONTROL_FIXTURES.length);
  // Both directions, or the control only proves the detector is enthusiastic.
  assert.ok(c.results.some((r) => r.expect === 1), 'a control must show it CAN fire');
  assert.ok(c.results.some((r) => r.expect === 0), 'a control must show it can STAY QUIET');
});

test('#1251 — every control names what it proves, so a failure says which direction broke', () => {
  for (const r of runControls().results) {
    assert.equal(typeof r.proves, 'string');
    assert.ok(r.proves.length > 10, `${r.name} must say what it proves`);
  }
});

test('#1251 ⛔ THE POINT — a detector that NEVER FIRES does not produce a finding of zero', () => {
  // A plausible-looking break: something that always returns nothing. Every
  // count comes out zero and every row looks clean.
  const dead = () => [];
  const r = askShapeReport(doc(call(), call(), call()), { detect: dead });

  assert.equal(r.totals.stored, 0);
  assert.equal(r.totals.recomputed, 0);
  assert.equal(r.controls.ok, false, 'the controls must catch a detector that cannot fire');
  assert.equal(r.verdict.code, 'INSTRUMENT_FAILED');
  assert.match(r.verdict.says, /NOT a finding of zero/i);
  assert.doesNotMatch(r.verdict.says, /cannot be answered/i, 'a broken instrument must not borrow the empty-population wording');
});

test('#1251 ⛔ and a detector that fires on EVERYTHING is caught too', () => {
  const trigger_happy = () => [{ verb: 'read', phrase: 'x', index: 0 }];
  const r = askShapeReport(doc(call()), { detect: trigger_happy });
  assert.equal(r.controls.ok, false, 'a detector that flags honest speech must fail the controls');
  assert.equal(r.verdict.code, 'INSTRUMENT_FAILED');
});

test('#1251 — with a WORKING detector and no flags, the verdict says the question cannot be answered', () => {
  const r = askShapeReport(doc(call(), call({ 'scrum:agent': 'grace' })));
  assert.equal(r.controls.ok, true);
  assert.equal(r.verdict.code, 'NO_FLAGS');
  assert.match(r.verdict.says, /CANNOT be answered/i);
  assert.match(r.verdict.says, /principle, not on a rate/i, 'it must name what the card should be told');
});

test('#1251 ⛔ THE CARD\'S OWN REFUTATION CONDITION is reported when it is met', () => {
  // Flags on one seat only. #1251 says that would make its premise wrong, so
  // the report has to say so rather than quietly tabulating it.
  const flag = [{ verb: 'read', phrase: 'I have read', index: 0 }];
  const r = askShapeReport(doc(
    call({ 'scrum:agent': 'ada', 'scrum:unbackedLookupClaims': flag, 'scrum:postedText': 'I have read the genesis prompt.' }),
    call({ 'scrum:agent': 'ada', 'scrum:unbackedLookupClaims': flag, 'scrum:postedText': 'I have read the genesis prompt.' }),
    call({ 'scrum:agent': 'grace' }),
  ));
  assert.equal(r.verdict.code, 'SINGLE_SEAT');
  assert.match(r.verdict.says, /premise .* is wrong/i);
  assert.equal(r.flagged.length, 2);
});

test('#1251 — flags across seats report the ask-vs-seat discriminator instead', () => {
  const flag = [{ verb: 'read', phrase: 'I have read', index: 0 }];
  const text = 'I have read the genesis prompt.';
  const r = askShapeReport(doc(
    call({ 'scrum:agent': 'ada', 'scrum:unbackedLookupClaims': flag, 'scrum:postedText': text }),
    call({ 'scrum:agent': 'grace', 'scrum:unbackedLookupClaims': flag, 'scrum:postedText': text }),
  ));
  assert.equal(r.verdict.code, 'MULTI_SEAT');
  assert.match(r.verdict.says, /wakeKind/);
});

test('#1251 ⛔ a STALE stored flag is reported — the record is re-derived, not trusted', () => {
  // The row says it was flagged; its own text says otherwise. A flag computed
  // once and never re-checked is a claim about the past nothing verifies.
  const r = askShapeReport(doc(
    call({ 'scrum:unbackedLookupClaims': [{ verb: 'read', phrase: 'I have read', index: 0 }], 'scrum:postedText': 'nothing claimed here at all' }),
  ));
  assert.equal(r.disagreements.length, 1);
  assert.deepEqual(
    { stored: r.disagreements[0].stored, recomputed: r.disagreements[0].recomputed },
    { stored: 1, recomputed: 0 },
  );
});

test('#1251 ⛔ and so is the opposite — text that flags NOW but was stored clean', () => {
  const r = askShapeReport(doc(
    call({ 'scrum:unbackedLookupClaims': [], 'scrum:postedText': 'I have read the genesis prompt and it says so.' }),
  ));
  assert.equal(r.disagreements.length, 1);
  assert.deepEqual(
    { stored: r.disagreements[0].stored, recomputed: r.disagreements[0].recomputed },
    { stored: 0, recomputed: 1 },
  );
  // The claim under test is that a RECOMPUTED flag counts as a flag, so the
  // report cannot read as an empty population. Which non-empty verdict it
  // lands on is a function of how many seats the fixture has, not of this.
  assert.notEqual(r.verdict.code, 'NO_FLAGS', 'a recomputed flag counts as a flag — the verdict must not read as an empty population');
  assert.equal(r.verdict.code, 'SINGLE_SEAT', 'one seat in the fixture, so the single-seat refutation notice is the right one');
});

test('#1251 — the group is (agent, wakeKind), which is what makes ask-vs-seat visible', () => {
  const r = askShapeReport(doc(
    call({ 'scrum:agent': 'ada', 'scrum:wakeKind': 'mention' }),
    call({ 'scrum:agent': 'ada', 'scrum:wakeKind': 'schedule' }),
    call({ 'scrum:agent': 'grace', 'scrum:wakeKind': 'mention' }),
  ));
  assert.equal(r.groups.length, 3, 'one row per (agent, wakeKind) pair');
  const mentions = r.groups.filter((g) => g.wakeKind === 'mention').map((g) => g.agent).sort();
  assert.deepEqual(mentions, ['ada', 'grace'], 'the same ask reaching two seats must be two comparable rows');
});

test('#1251 — a no-tool call that posted nothing is not counted as a no-tool POST', () => {
  // The population that matters is "spoke without looking", not "woke without
  // looking": a wake that stayed quiet had no opportunity to claim anything.
  const r = askShapeReport(doc(
    call({ 'scrum:postedText': '' }),
    call({ 'scrum:postedText': '   ' }),
    call({ 'scrum:postedText': 'said something' }),
  ));
  assert.equal(r.totals.noTool, 3);
  assert.equal(r.totals.noToolPosted, 1);
  assert.equal(r.totals.posted, 1);
});

test('#1251 — a call WITH tool hops is not in the no-tool population', () => {
  const r = askShapeReport(doc(
    call({ 'scrum:toolHops': [{ ok: true }] }),
    call({ 'scrum:toolHops': [] }),
  ));
  assert.equal(r.totals.calls, 2);
  assert.equal(r.totals.noTool, 1);
});

test('#1251 — rows without the field are not model calls, and an empty document is not an error', () => {
  assert.equal(modelCallRows(doc({ '@type': 'scrum:Card', 'scrum:title': 'not a model call' })).length, 0);
  assert.equal(modelCallRows({}).length, 0);
  assert.equal(modelCallRows(null).length, 0);
  const r = askShapeReport({ '@graph': [] });
  assert.equal(r.totals.calls, 0);
  assert.equal(r.verdict.code, 'NO_FLAGS', 'an empty board is honestly zero, because the controls still ran');
});

test('#1251 — an unattributed row is grouped, never dropped', () => {
  const r = askShapeReport(doc(call({ 'scrum:agent': undefined, 'scrum:wakeKind': undefined })));
  assert.equal(r.totals.calls, 1);
  assert.equal(r.groups[0].agent, '(unattributed)');
  assert.equal(r.groups[0].wakeKind, '(none)');
});
