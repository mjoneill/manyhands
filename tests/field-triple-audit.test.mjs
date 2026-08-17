/**
 * #831 RELEASE CONDITION 0a — THE AUDIT IS AUDITED BEFORE IT RUNS.
 *
 * The card's rule: "the audit's first run should be against a known-good
 * control, not production. Saturation is the signature of a check that hasn't
 * been tested against known-good data." Precedent: an orphan-check whose first
 * run reported 61 of 61 orphaned — the extractor had matched nothing, and a
 * total failure is what a broken instrument looks like from the outside.
 *
 * ⚠️ The control below is built so that NO SINGLE DEGENERATE AUDITOR CAN PASS IT.
 * That is the whole design constraint, and it is why the expected verdicts are
 * deliberately mixed rather than "these four should pass":
 *
 *   an auditor that always says AGREE        fails the two noRule-refutation rows
 *   an auditor that always says DISAGREE     fails implementedBy, priority, titel
 *   an auditor that never measures (null)    fails on every row
 *   an auditor that confuses declared/absent fails on titel vs implementedBy
 *   an auditor that BELIEVES the probe table fails the noRule-refutation rows
 *
 * A fixture with no expected-PASS cannot tell a correct audit from one that
 * refuses everything. A fixture with no expected-FAIL cannot tell a correct
 * audit from one that accepts everything. This has both, in the same run.
 *
 * ⛔ AND THE EXPECTED-FAIL ROWS ARE SYNTHETIC ON PURPOSE. They used to be the
 * real #830 park defect, which meant the calibration depended on production
 * staying broken — when that shipped, the control lost every expected-DISAGREE
 * row at once. A fixture must manufacture its own disagreement, or fixing a bug
 * blinds the instrument that found it.
 *
 * The expected verdicts are NOT read off the implementation. Each is
 * independently established:
 *   implementedBy  — #830 (df83e34) made create consume it; verified by a fresh
 *                    GET in tests/card-create-declared-fields.test.mjs
 *   priority       — long-standing; validated (invalid priority → 400) and stored
 *   titel          — a typo: consistently unknown on all three lists (#829)
 *   parked*        — #830's open half: create no longer validates, advertises or
 *                    consumes them; PATCH keeps every rule
 *   type/priority  — as noRule rows: deliberately FALSE markings the guard must
 *     marked noRule   refute rather than believe
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';
import { auditCreateField, verdictFor, renderTable } from '../tools/field-triple.mjs';

const FUTURE = '2026-12-01T00:00:00.000Z';
const SHA = 'a'.repeat(40);

/**
 * The control. Every row's `expect` is justified in the comment beside it.
 * `why` is printed on failure so a red run says which belief broke, not just
 * which string mismatched.
 */
const CONTROL = [
  {
    // EXPECTED-PASS #1 — the supported shape. All three lists agree, positively.
    probe: {
      name: 'implementedBy',
      wellFormed: [SHA],
      malformed: ['a75a247'],          // short sha — refused since #814's rule
    },
    expect: 'AGREE_SUPPORTED',
    why: 'df83e34 (#830) added implementedBy to CREATE_CONSUMED_FIELDS and to the '
       + 'constructor; validation for full-40-char shas already existed',
  },
  {
    // EXPECTED-PASS #2 — the supported shape via a DIFFERENT field, so a single
    // implementedBy-shaped special case cannot carry the positive column alone.
    probe: {
      name: 'priority',
      wellFormed: 'p1',
      malformed: 'p9',                 // not in CARD_PRIORITIES
    },
    expect: 'AGREE_SUPPORTED',
    why: 'priority is declared, validated against CARD_PRIORITIES, and stored',
  },
  {
    // EXPECTED-PASS #3 — the ABSENT shape. Consistent absence is agreement too,
    // and an auditor that flags unknown keys as findings would fail here.
    probe: {
      name: 'titel',
      wellFormed: 'misspelled',
      malformed: 12345,
    },
    expect: 'AGREE_ABSENT',
    why: 'a typo: no schema entry, no validation rule, no consumer — #829 reports '
       + 'it in ignoredFields, which is correct behaviour, not a finding',
  },
  // ⛔⛔ A CONTROL KEYED TO A LIVE DEFECT EXPIRES WHEN THE DEFECT IS FIXED.
  //
  // These two rows used to be `parkedBy` and `parkedUntil`, both expected
  // VALIDATED_THEN_DISCARDED — the real #830 defect. That made the calibration
  // depend on the codebase staying broken. When #830's open half shipped, both
  // rows flipped to AGREE_ABSENT, the control lost its only expected-DISAGREE
  // entries, and this file went red for the best possible reason.
  //
  // ⇒ A calibration fixture must MANUFACTURE its own disagreement rather than
  //   borrow one from production. The rows below are synthetic and permanent:
  //   they disagree because the probe is deliberately wrong, not because the
  //   server is. Fixing a bug must never blind the instrument that found it.
  {
    // EXPECTED-FAIL #1 — a field with a real rule, deliberately marked noRule.
    // The self-certification guard must refute the marking.
    probe: { name: 'type', wellFormed: 'bug', malformed: null, noRule: true },
    expect: 'NORULE_CLAIM_REFUTED',
    why: 'type is validated against CARD_TYPES; claiming it has no rule is false '
       + 'and the auditor must measure that rather than believe the probe',
  },
  {
    // EXPECTED-FAIL #2 — a DIFFERENT field, same lie, so the FAIL column is not
    // carried by one row.
    probe: { name: 'priority', wellFormed: 'p1', malformed: null, noRule: true },
    expect: 'NORULE_CLAIM_REFUTED',
    why: 'same synthetic disagreement on a second validated field',
  },
  {
    // And the park trio, now as expected-PASS — recording the #830 fix so a
    // regression turns this red.
    probe: {
      name: 'parkedBy', wellFormed: 'ada', malformed: null, noRule: true,
      with: { parkedUntil: FUTURE },
    },
    expect: 'AGREE_ABSENT',
    why: '#830 open half shipped: create no longer validates, advertises, or '
       + 'consumes the park fields — all three lists agree at absent',
  },
];

test('#831 RC0a — the auditor reproduces every known verdict in the control', async () => {
  const server = await startRestServer();
  const rows = [];
  try {
    for (const { probe } of CONTROL) {
      const r = await auditCreateField(server.baseUrl, probe);
      rows.push({ ...r, verdict: verdictFor(r) });
    }
  } finally {
    await server.stop();
  }

  // Printed on every run, pass or fail: RC0a requires the control's RESULT in
  // the report, as a line that cannot be written without having run it.
  const passes = CONTROL.filter((c) => c.expect.startsWith('AGREE')).length;
  const fails = CONTROL.length - passes;
  console.log(
    `\n#831 RC0a calibration: ${CONTROL.length} fields · `
    + `${passes} expected-AGREE · ${fails} expected-DISAGREE\n`
    + renderTable(rows) + '\n',
  );

  // ⚠️ No row may be UNMEASURED. A well-formed probe that fails to create
  // returns nulls, and three nulls would otherwise slide past a lenient
  // comparison as "not disagreeing".
  for (const r of rows) {
    assert.notEqual(
      r.verdict, 'UNMEASURED',
      `${r.field}: the auditor could not measure it — ${r.error}`,
    );
  }

  // The control itself must be able to discriminate. If every expected verdict
  // were the same string, a constant-output auditor would score 100%.
  const distinct = new Set(CONTROL.map((c) => c.expect));
  assert.ok(
    distinct.size >= 2 && [...distinct].some((v) => v.startsWith('AGREE'))
      && [...distinct].some((v) => !v.startsWith('AGREE')),
    'the control must contain both an expected-AGREE and an expected-DISAGREE, '
    + `else it cannot distinguish a correct audit from a constant one — got ${[...distinct]}`,
  );

  for (const [i, { probe, expect, why }] of CONTROL.entries()) {
    assert.equal(
      rows[i].verdict, expect,
      `${probe.name}: expected ${expect}, got ${rows[i].verdict}\n`
      + `  basis for the expectation: ${why}\n`
      + `  measured: ${JSON.stringify(rows[i].evidence)}`,
    );
  }
});

test('#831 RC0a — the control probes actually exercised the surface', async () => {
  // The anti-vacuity check. Every assertion above would also pass against a
  // server that silently ignored the entire request, if the expectations
  // happened to be "absent". This asserts the writes really happened: the
  // paired control key landed on each well-formed create.
  const server = await startRestServer();
  try {
    for (const { probe } of CONTROL) {
      const r = await auditCreateField(server.baseUrl, probe);
      assert.equal(
        r.evidence.wellFormedStatus, 201,
        `${probe.name}: the well-formed probe must create, else the row is vacuous`,
      );
      assert.ok(
        r.evidence.controlTitleLanded,
        `${probe.name}: the paired control key did not land — the probe is broken, `
        + 'and a broken probe reads as a finding',
      );
    }
  } finally {
    await server.stop();
  }
});

test('#831 RC0a — verdictFor separates the disagreement shapes', () => {
  // Collapsing every disagreement to "FAIL" loses the only information that
  // says what to do about it: remove from two lists, or add to the third.
  assert.equal(verdictFor({ declares: true, accepts: true, reads: true }), 'AGREE_SUPPORTED');
  assert.equal(verdictFor({ declares: false, accepts: false, reads: false }), 'AGREE_ABSENT');
  assert.equal(verdictFor({ declares: false, accepts: true, reads: false }), 'VALIDATED_THEN_DISCARDED');
  assert.equal(verdictFor({ declares: true, accepts: true, reads: false }), 'VALIDATED_THEN_DISCARDED');
  assert.equal(verdictFor({ declares: false, accepts: false, reads: true }), 'CONSUMED_UNDECLARED');
  assert.equal(verdictFor({ declares: true, accepts: false, reads: true }), 'CONSUMED_UNVALIDATED');
  assert.equal(verdictFor({ declares: true, accepts: false, reads: false }), 'DECLARED_NOT_CONSUMED');
  assert.equal(verdictFor({ declares: null, accepts: null, reads: null }), 'UNMEASURED');
});
