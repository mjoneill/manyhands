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
 *   an auditor that always says AGREE        fails on parkedBy/parkedUntil
 *   an auditor that always says DISAGREE     fails on implementedBy and titel
 *   an auditor that never measures (null)    fails on every row
 *   an auditor that confuses declared/absent fails on titel vs implementedBy
 *
 * A fixture with no expected-PASS cannot tell a correct audit from one that
 * refuses everything. A fixture with no expected-FAIL cannot tell a correct
 * audit from one that accepts everything. This has both, in the same run.
 *
 * The expected verdicts are NOT read off the implementation. Each is
 * independently established:
 *   implementedBy  — #830 (df83e34) made create consume it; verified by a fresh
 *                    GET in tests/card-create-declared-fields.test.mjs
 *   parked*        — the #830 OPEN half, measured by a probe recorded on #831:
 *                    `parkedBy+parkedUntil → 201, stored=undefined`
 *   priority       — long-standing; validated (invalid priority → 400) and stored
 *   titel          — a typo: consistently unknown on all three lists (#829)
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
  {
    // EXPECTED-FAIL #1 — the headline defect. Validated, then discarded.
    probe: {
      name: 'parkedBy',
      wellFormed: 'ada',
      malformed: 'not a valid seat key!!',
      with: { parkedUntil: FUTURE },   // a park needs both halves or the PAIR refuses
    },
    expect: 'VALIDATED_THEN_DISCARDED',
    why: 'the #830 OPEN half: validateCardFields enforces the park rules at create, '
       + 'but parkedBy is absent from CREATE_CONSUMED_FIELDS and the constructor',
  },
  {
    // EXPECTED-FAIL #2 — the same defect on the paired field, so the FAIL column
    // is not carried by one row either.
    probe: {
      name: 'parkedUntil',
      wellFormed: FUTURE,
      malformed: 'not-a-timestamp',
      with: { parkedBy: 'ada' },
    },
    expect: 'VALIDATED_THEN_DISCARDED',
    why: 'same defect, the other half of the park pair',
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
