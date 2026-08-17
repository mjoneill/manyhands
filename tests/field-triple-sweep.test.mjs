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
import { auditCreateField, verdictFor, renderTable } from '../tools/field-triple.mjs';
import { CARD_CREATE_PROBES } from '../tools/field-probes.mjs';

/**
 * The known, accepted disagreements. Every entry needs a card number: an
 * exemption with no ticket is how a defect becomes architecture.
 */
const KNOWN_DISAGREEMENTS = {
  parkedBy: 'VALIDATED_THEN_DISCARDED',      // #830 open half
  parkedUntil: 'VALIDATED_THEN_DISCARDED',   // #830 open half
  parkedReason: 'VALIDATED_THEN_DISCARDED',  // #830 open half — found only after
                                             // the noRule self-certification guard
};

async function sweep(baseUrl) {
  const rows = [];
  for (const probe of CARD_CREATE_PROBES) {
    const r = await auditCreateField(baseUrl, probe);
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
