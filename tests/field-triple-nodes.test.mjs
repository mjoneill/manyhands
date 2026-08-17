/**
 * #831 — the /api/nodes surface, and the auditor's own blind spot.
 *
 * ⚠️ THE INSTRUMENT BUG THIS FILE EXISTS TO PREVENT.
 *
 * `declares(f)` is measured as "f is absent from the response's ignoredFields".
 * That predicate silently assumes the ROUTE HAS A DIAGNOSTIC. `/api/nodes` does
 * not — #823 fixed the MCP seam and PATCH /api/cards, #829 fixed POST
 * /api/cards, and nobody fixed nodes. On a route that never emits the field,
 * "absent from ignoredFields" is vacuously true for EVERY key, so the auditor
 * would report every field as declared and the surface would come back clean.
 *
 * ⇒ An audit that cannot see a surface must say UNMEASURABLE, never AGREE.
 *   Reporting agreement you did not establish is the exact failure class this
 *   card exists to find — and it is the third time in this build that the
 *   auditor committed it (see the noRule self-certification guard and the
 *   presence-vs-value `reads` bug).
 *
 * The detection is self-calibrating rather than hardcoded: send a key that
 * CANNOT be real, and see whether the route reports it. A route that stays
 * silent about deliberate junk has no diagnostic, whatever its name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';
import { routeHasDiagnostic, auditNodeField, verdictFor } from '../tools/field-triple.mjs';

/** A key no route could plausibly consume. Long and self-describing on purpose. */
const IMPOSSIBLE_KEY = 'zzz_field_triple_diagnostic_probe_not_a_real_field';

test('#831 — /api/cards HAS a diagnostic (the positive control)', async () => {
  // Without this control, "nodes has no diagnostic" could equally mean the
  // detector is broken and reports "no diagnostic" everywhere.
  const server = await startRestServer();
  try {
    const has = await routeHasDiagnostic(server.baseUrl, 'cards');
    assert.equal(has, true, 'POST /api/cards reports ignoredFields since #829 — detector should see it');
  } finally {
    await server.stop();
  }
});

test('#831 — /api/nodes has NO diagnostic, and the auditor must say so', async () => {
  const server = await startRestServer();
  try {
    const has = await routeHasDiagnostic(server.baseUrl, 'nodes');
    assert.equal(has, false, 'PATCH /api/nodes emits no ignoredFields — if this flipped, the route was fixed');

    // `body` IS a real field on this route (it maps to card.description) — the
    // route-relative vocabulary trap. So it is consumed, and the ONLY thing the
    // auditor cannot establish here is `declares`.
    const r = await auditNodeField(server.baseUrl, {
      name: 'body', wellFormed: 'real on the nodes route', storedAs: 'description', noRule: true,
    });
    assert.equal(r.reads, true, 'body maps to description on this route — genuinely consumed');
    assert.equal(r.declares, null, 'declares is UNMEASURABLE without a diagnostic — must not default to true');
    assert.equal(verdictFor(r), 'UNMEASURABLE_NO_DIAGNOSTIC');
  } finally {
    await server.stop();
  }
});

test('#831 — an unknown field on /api/nodes is dropped SILENTLY (the #823 gap, third route)', async () => {
  const server = await startRestServer();
  try {
    const r = await auditNodeField(server.baseUrl, {
      name: 'priority',          // real on /api/cards, unknown on /api/nodes
      wellFormed: 'p0', noRule: true,
    });
    assert.equal(r.reads, false, 'priority is not consumed by the nodes route');
    assert.equal(r.declares, null, 'and the route says nothing about having dropped it');
    assert.equal(verdictFor(r), 'UNMEASURABLE_NO_DIAGNOSTIC');
    assert.equal(
      r.evidence.ignoredFields, undefined,
      'the whole point: 200, data discarded, no diagnostic whatsoever',
    );
  } finally {
    await server.stop();
  }
});

test('#831 — UNMEASURABLE never counts as agreement', () => {
  // The verdict must not start with AGREE, because every sweep in this build
  // filters findings with `!verdict.startsWith('AGREE')`. If UNMEASURABLE were
  // named AGREE_UNKNOWN, an entire unaudited surface would report clean.
  const v = verdictFor({ declares: null, accepts: false, reads: true, noDiagnostic: true });
  assert.equal(v, 'UNMEASURABLE_NO_DIAGNOSTIC');
  assert.ok(!v.startsWith('AGREE'), 'an unmeasured surface must never be filtered out as agreeing');
});
