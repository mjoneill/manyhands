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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ #841 — THE ROUTE WAS FIXED, AND THIS FILE IS THE REGRESSION TEST.
 *
 * The assertions below were INVERTED, not deleted. That distinction is the
 * point: this file's original job was to prove `/api/nodes` had no diagnostic,
 * and its new job is to prove it has one. Deleting it would have removed the
 * only thing that fails if the diagnostic is ever taken away again — and the
 * whole reason this surface went unfixed for three rounds is that nothing was
 * watching it. The original assertion carried its own instruction for this
 * moment — "if this flipped, the route was fixed." It flipped, on purpose, at
 * #841, and the assertion was turned around rather than removed.
 *
 * ⚠️ The `UNMEASURABLE_NO_DIAGNOSTIC` machinery it exercises is NOT dead code —
 * it is the auditor's answer for any FUTURE surface without a diagnostic, which
 * is why the pure-unit test at the bottom is untouched and still guards the
 * "never report agreement you did not establish" rule.
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

test('#841 — /api/nodes NOW HAS a diagnostic, and the surface became measurable', async () => {
  const server = await startRestServer();
  try {
    const has = await routeHasDiagnostic(server.baseUrl, 'nodes');
    assert.equal(has, true, 'PATCH /api/nodes emits ignoredFields since #841 — if this flipped back, the fix was lost');

    // `body` IS a real field on this route (it maps to card.description) — the
    // route-relative vocabulary trap. It is consumed AND, now, declared: a
    // consumed field must never appear in ignoredFields.
    const r = await auditNodeField(server.baseUrl, {
      name: 'body', wellFormed: 'real on the nodes route', storedAs: 'description', noRule: true,
    });
    assert.equal(r.reads, true, 'body maps to description on this route — genuinely consumed');
    assert.equal(r.declares, true, 'and the route does NOT report its own real field as ignored');
    assert.equal(verdictFor(r), 'AGREE_SUPPORTED_NO_RULE');

    // ⚠️ The `declares` value that matters is the one that CHANGED. Before #841
    // it was null — not false — because "the route said nothing" and "the route
    // said this field is fine" are different facts, and only one of them is
    // evidence. This assertion is what stops a future regression from being
    // read as agreement.
    assert.notEqual(r.declares, null, 'declares must be a measurement now, not an absence');
  } finally {
    await server.stop();
  }
});

test('#841 — an unknown field on /api/nodes is dropped and SAID SO (the #823 gap, closed)', async () => {
  const server = await startRestServer();
  try {
    const r = await auditNodeField(server.baseUrl, {
      name: 'priority',          // real on /api/cards, unknown on /api/nodes
      wellFormed: 'p0', noRule: true,
    });
    assert.equal(r.reads, false, 'priority is still not consumed by the nodes route — the fix stores nothing new');
    assert.equal(r.declares, false, 'and the route now NAMES it as dropped');
    assert.equal(verdictFor(r), 'AGREE_ABSENT', 'absent from both lists, and honestly reported as such');
    assert.ok(
      (r.evidence.ignoredFields || []).includes('priority'),
      'the whole point, inverted: 200, data discarded, AND the caller is told which key',
    );

    // ⚠️ The behaviour that must NOT have changed. #841 is a diagnostic, not a
    // feature: a route that started *consuming* priority would also make the
    // assertion above pass, and would be a different and much worse change.
    //
    // ⛔ Asserted against the PROBE VALUE, not against undefined. A fresh card
    // is born carrying `priority: null`, so "is it absent?" is answered by the
    // default rather than by the write — the exact presence-vs-value error this
    // auditor's own `reads` predicate was fixed for. The only honest question
    // is whether the value I sent came back.
    assert.notEqual(r.evidence.storedValue, 'p0', 'the probe value must NOT have been stored by this route');
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
