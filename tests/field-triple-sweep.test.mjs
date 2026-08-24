/**
 * #831 — the sweep: apply the three-list invariant to every caller-settable
 * field on the /api/cards CREATE surface, and pin the result.
 *
 * This is the regression half. tests/field-triple-audit.test.mjs proves the
 * AUDITOR works; tests/field-triple-coverage.test.mjs proves the probe table
 * covers the field universe; this file asserts WHAT THE AUDIT CURRENTLY FINDS,
 * so that a new field landing un-consumed turns a test red instead of waiting
 * to be discovered by a caller whose data evaporated.
 *
 * ⚠️ The assertion is on the exact SET of disagreements, not on a count. A
 * count passes when one defect is fixed and another appears, which is the
 * failure mode of every "no more than N warnings" gate ever written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';
import { auditCreateField, auditPatchField, verdictFor, renderTable } from '../tools/field-triple.mjs';
import { CARD_CREATE_PROBES } from '../tools/field-probes.mjs';

/**
 * The known, accepted disagreements. Every entry needs a card number: an
 * exemption with no ticket is how a defect becomes architecture.
 */
// ⭐ EMPTY, and it was not empty an hour ago. The park trio was
// VALIDATED_THEN_DISCARDED here until #830's open half shipped: create no
// longer validates fields it does not consume, and the MCP card_create schema
// no longer advertises them. All three lists now agree at ABSENT.
//
// ⚠️ This going non-empty means a field was added to the schema or validator
// without being added to the consumer. Do not "fix" that by editing this
// object — the object records what we have ACCEPTED, and an exemption with no
// card number is how a defect becomes architecture.
const KNOWN_DISAGREEMENTS = {};

/**
 * `id` is immutable on PATCH, so it is not a patchable field and is excluded
 * there — written out rather than filtered inline, because a silent exclusion
 * is how a surface stops being audited.
 */
const PATCH_EXCLUDED = new Set(['id']);

/**
 * The known, accepted disagreements on PATCH. Both are #823-class holes: the
 * route reports unknown fields but two paths bypass that reporting.
 */
// ⭐ EMPTY. Both PATCH defects the sweep found are fixed:
//   assignee  was VALIDATED_THEN_DISCARDED — the loop did `card[k] = v`, writing
//             a raw `assignee` key while `assignees` stayed untouched. Now
//             normalized the way create always has.
//   createdBy was DECLARED_NOT_CONSUMED — IMMUTABLE_CARD_FIELDS was skipped by a
//             `continue` sitting ABOVE the ignoredFields push. Now reported in a
//             separate `refusedFields`, because refused and ignored are
//             different facts.
//
// ⚠️ Same rule as the create list: this going non-empty means a field was added
// to a schema or validator without being added to the consumer. Do not edit
// this object to make a red run green — it records what we have ACCEPTED, and
// an exemption with no card number is how a defect becomes architecture.
//
// ── #534 ifVersion — ACCEPTED, and the card number is the point ──────────
//
// ⚠️ This is the FIRST entry in this object since both original defects were
// fixed, so it deserves more than a line. It is NOT a defect being waved
// through; it is a limitation of the audit, recorded where the audit can see it.
//
// `ifVersion` is a compare-and-swap PRECONDITION: validated (400 on a
// non-integer) and never stored, because a precondition is CONSUMED — it
// decides whether the write happens at all. The audit's `reads` predicate asks
// "did the value land in stored state?", and for a control parameter the honest
// answer is always no. So `accepts && !reads` fires and reports
// VALIDATED_THEN_DISCARDED, which mischaracterises it: the value is not
// discarded, it is the thing the write was conditioned on.
//
// ⛔ It cannot be marked `noRule` — a rule genuinely fires, and this suite's own
// NORULE_CLAIM_REFUTED check would catch that lie. Nor can `storedAs` point
// anywhere, because there is no stored effect to point at.
//
// ⇒ The real gap is that the taxonomy has no CONSUMED_CONTROL verdict, and
// closing it means changing an instrument other people's verdicts depend on.
// ⇒ CARDED AS #1023, which is the card number this object's own contract
// requires. Not done inline: a wrong exemption SUPPRESSES findings, which is
// the failure this file already recorded once about `parkedReason`, and a
// taxonomy change deserves its own review rather than a ride on a feature
// commit. Until #1023 lands, this entry is the record that someone looked at
// this row and understood it.
//
// ⇒ `return` (#1032) is the SAME taxonomy gap arriving from a second direction,
// and its presence here is evidence about #1023 rather than a new problem.
//
// It is a RESPONSE-SHAPE parameter: it decides what the reply CONTAINS, never
// what the card holds. So `reads` ("did the value land in stored state?") is
// honestly false, `accepts` is true, and the sweep reports
// VALIDATED_THEN_DISCARDED — which again mischaracterises it. The value was not
// discarded; it was consumed by the response writer, which is the only place it
// could possibly have an effect.
//
// ⛔ Not `noRule`: a rule genuinely fires (an unsupported shape is refused with
// 400 before the write), and NORULE_CLAIM_REFUTED would catch that lie.
// ⛔ Not `storedAs`: there is no stored effect to point at, by design.
//
// ⭐ Worth noting for whoever takes #1023: the gap now has TWO members with
// different flavours — a PRECONDITION (ifVersion, decides whether the write
// happens) and a PRESENTATION parameter (return, decides what the reply says).
// A single CONSUMED_CONTROL verdict may not fit both; "consumed by the write
// decision" and "consumed by the response" are different enough that one label
// could blur them. Two instances is when that becomes visible, which is the
// argument for registering this here rather than quietly widening a set.
const KNOWN_PATCH_DISAGREEMENTS = {
  ifVersion: 'VALIDATED_THEN_DISCARDED',
  return: 'VALIDATED_THEN_DISCARDED',
};

async function sweep(baseUrl, fn = auditCreateField, probes = CARD_CREATE_PROBES) {
  const rows = [];
  for (const probe of probes) {
    const r = await fn(baseUrl, probe);
    rows.push({ ...r, verdict: verdictFor(r) });
  }
  return rows;
}

test('#831 — the create surface has exactly the known three-list disagreements', async () => {
  const server = await startRestServer();
  let rows;
  try {
    rows = await sweep(server.baseUrl);
  } finally {
    await server.stop();
  }

  console.log(`\n#831 sweep — /api/cards create, ${rows.length} fields\n${renderTable(rows)}\n`);

  // No row may be unmeasured or refuted-by-its-own-marking: both mean the
  // instrument could not answer, and an unanswered field is not a clean one.
  for (const r of rows) {
    assert.notEqual(r.verdict, 'UNMEASURED', `${r.field}: unmeasured — ${r.error}`);
    assert.notEqual(
      r.verdict, 'NORULE_CLAIM_REFUTED',
      `${r.field}: marked noRule in the probe table, but a rule fired. `
      + `Fix the marking — a wrong exemption SUPPRESSES findings. ${r.error}`,
    );
  }

  const actual = Object.fromEntries(
    rows.filter((r) => !r.verdict.startsWith('AGREE')).map((r) => [r.field, r.verdict]),
  );

  assert.deepEqual(
    actual, KNOWN_DISAGREEMENTS,
    'the set of three-list disagreements changed.\n'
    + `  expected: ${JSON.stringify(KNOWN_DISAGREEMENTS, null, 2)}\n`
    + `  actual  : ${JSON.stringify(actual, null, 2)}\n`
    + 'If a defect was FIXED, remove it from KNOWN_DISAGREEMENTS. If a new one appeared, '
    + 'a field was added to the schema or validator without being added to the consumer.',
  );
});

test('#831 — a wrong `noRule` marking is refuted, not believed', async () => {
  // The guard that makes the exemption non-self-certifying. `noRule` is
  // author-declared, so a wrong marking silently suppresses a real finding —
  // this audit committing the exact failure class it exists to detect. That is
  // not hypothetical: marking parkedReason noRule hid a VALIDATED_THEN_DISCARDED
  // until this guard was added.
  const server = await startRestServer();
  try {
    const r = await auditCreateField(server.baseUrl, {
      name: 'type',              // very much HAS a rule (CARD_TYPES)
      wellFormed: 'bug',
      malformed: null,
      noRule: true,              // the lie under test
    });
    assert.equal(verdictFor(r), 'NORULE_CLAIM_REFUTED');
    assert.equal(r.noRuleClaimRefuted, true);
    assert.match(r.error, /marked noRule, but a validation rule fired/);
  } finally {
    await server.stop();
  }
});

test('#831 — a field with no rule genuinely has none (the exemption is earned)', async () => {
  // The paired control for the test above: if the hostile probe 400'd on
  // everything, the guard would refute every marking and the previous test
  // would pass for the wrong reason.
  const server = await startRestServer();
  try {
    const r = await auditCreateField(server.baseUrl, {
      name: 'description', wellFormed: 'text', malformed: null, noRule: true,
    });
    assert.notEqual(r.noRuleClaimRefuted, true,
      `description should have no validation rule, but the hostile probe got `
      + `${r.evidence.noRuleProbeStatus}: ${JSON.stringify(r.evidence.noRuleProbeError)}`);
    assert.equal(verdictFor(r), 'AGREE_SUPPORTED_NO_RULE');
  } finally {
    await server.stop();
  }
});

test('#831 — the PATCH surface has exactly the known three-list disagreements', async () => {
  // ⚠️ `unknown` is ROUTE-RELATIVE, so PATCH gets its own sweep rather than
  // sharing create's verdicts. The parked* trio is broken on create and CORRECT
  // here; assignee is correct on create and broken here. A single audit over
  // "the card fields" would average the two and report a defect on neither.
  const server = await startRestServer();
  let rows;
  try {
    rows = await sweep(
      server.baseUrl, auditPatchField,
      CARD_CREATE_PROBES.filter((p) => !PATCH_EXCLUDED.has(p.name)),
    );
  } finally {
    await server.stop();
  }

  console.log(`\n#831 sweep — /api/cards PATCH, ${rows.length} fields\n${renderTable(rows)}\n`);

  for (const r of rows) {
    assert.notEqual(r.verdict, 'UNMEASURED', `${r.field}: unmeasured — ${r.error}`);
    assert.notEqual(r.verdict, 'NORULE_CLAIM_REFUTED',
      `${r.field}: marked noRule but a rule fired — fix the marking. ${r.error}`);
  }

  const actual = Object.fromEntries(
    rows.filter((r) => !r.verdict.startsWith('AGREE')).map((r) => [r.field, r.verdict]),
  );
  assert.deepEqual(
    actual, KNOWN_PATCH_DISAGREEMENTS,
    'the set of PATCH three-list disagreements changed.\n'
    + `  expected: ${JSON.stringify(KNOWN_PATCH_DISAGREEMENTS, null, 2)}\n`
    + `  actual  : ${JSON.stringify(actual, null, 2)}`,
  );
});

test('#831 — a probe value equal to the surface DEFAULT cannot discriminate', async () => {
  // The regression guard for the instrument bug this sweep was built on top of.
  // `reads` used to ask "is the field present after the write?", which is true
  // for every field the server defaults — so a silently-discarded PATCH read as
  // a clean AGREE because the value was already there. Here the probe sends
  // exactly what create writes; a presence-based predicate says "stored", and a
  // value-comparing one must still say "stored" — the point is that the probe
  // is UNABLE to tell, which is why field-probes.mjs sends 'grace' instead.
  const server = await startRestServer();
  try {
    const blind = await auditPatchField(server.baseUrl, {
      name: 'createdBy', wellFormed: 'ada', malformed: null, noRule: true,
    });
    assert.equal(blind.reads, true,
      'sanity: a probe echoing the default cannot detect the discard — that is the trap');

    const sighted = await auditPatchField(server.baseUrl, {
      name: 'createdBy', wellFormed: 'grace', malformed: null, noRule: true,
    });
    assert.equal(sighted.reads, false,
      'a probe whose value DIFFERS from the default must see that the patch was discarded');
    // Verdict is AGREE_REFUSED rather than DECLARED_NOT_CONSUMED since #831
    // taught the route to say `refusedFields` out loud: createdBy is immutable
    // BY DESIGN (#631), and immutability that reports itself is a legitimate
    // state. The discrimination this test exists for is unchanged — `reads`
    // still flips on the probe value, which is the property under test.
    assert.equal(verdictFor(sighted), 'AGREE_REFUSED');
  } finally {
    await server.stop();
  }
});
