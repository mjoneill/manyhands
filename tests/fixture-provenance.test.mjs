/**
 * #849 — a fixture cannot carry a live actor into the public tree by hand alone.
 *
 * The publication gate scans what a PUSH ADDS. Nothing watched the moment a
 * fixture is authored, and the one fixture in this tree is a real board export
 * that was sanitised by hand with nothing enforcing it.
 *
 * ⛔ THE GUARD IS INVERTED ON PURPOSE: it allowlists SYNTHETIC actors and fails
 * on everything else, so it never has to name what it protects. A guard that
 * lists the real names publishes them — the exact failure it exists to prevent.
 * The side benefit is that it also catches a name nobody has thought of yet.
 *
 * ⚠️ Every assertion here has a control, because a guard that cannot fail is
 * indistinguishable from a clean tree, and this suite's whole subject is
 * instruments that report agreement they never established.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanFixtures, SYNTHETIC_ACTORS, ACTOR_KEYS } from '../tools/fixture-provenance.mjs';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

/** Write records to a throwaway fixtures dir and scan it. */
function scanTemp(records, name = 'probe.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixprov-'));
  try {
    fs.writeFileSync(path.join(dir, name), records.map((r) => JSON.stringify(r)).join('\n'));
    return scanFixtures(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('#849 the tracked fixtures are clean', async () => {
  const findings = scanFixtures(FIXTURES);
  assert.deepEqual(
    findings, [],
    'a fixture names an actor that is not in the synthetic cast.\n'
    + '  Replace it with a synthetic seat, or add a genuinely-synthetic name to\n'
    + '  SYNTHETIC_ACTORS. Do NOT add a real one — that publishes what this guards.',
  );
});

test('#849 POSITIVE CONTROL — an unsanitised actor is caught', () => {
  // Without this, "the fixtures are clean" is satisfied equally well by a
  // scanner that returns [] unconditionally. The name here is invented and
  // belongs to nobody: the guard must fail on ANY non-synthetic actor, which
  // is precisely why it needs no list of real ones.
  const findings = scanTemp([{ id: 1, declaredBy: 'zzz_not_a_synthetic_seat' }]);
  assert.equal(findings.length, 1, 'the scanner must flag an actor outside the synthetic cast');
  assert.equal(findings[0].key, 'declaredBy');
  assert.equal(findings[0].value, 'zzz_not_a_synthetic_seat');
});

test('#849 the replyBy TRAP — a timestamp under a by-shaped key is NOT an actor', () => {
  // ⛔ THE REASON THIS TEST EXISTS. A naive "any key containing 'by'" heuristic
  // matches `replyBy`, whose value is an ISO-8601 timestamp — 13 of them on the
  // only fixture in the tree. That guard would have fired on day one, on
  // everything, and been switched off by the end of the week.
  const findings = scanTemp([{ replyBy: '2026-08-12T13:32:30.635Z', by: 'ada' }]);
  assert.deepEqual(findings, [], 'a timestamp is never an actor, whatever key it arrives under');
});

test('#849 a UUID under an actor key is not treated as a name', () => {
  const findings = scanTemp([{ by: '960e5d02-1111-4222-8333-3a7732c4080f' }]);
  assert.deepEqual(findings, [], 'an opaque id names nobody on its own');
});

test('#849 actors are found at DEPTH and inside arrays, not just at the top level', () => {
  // A real export nests. A scanner that only reads top-level keys would pass
  // the tracked fixture and every live export ever committed.
  const nested = scanTemp([{ work: { grant: { holder: 'zzz_deep_actor' } } }]);
  assert.equal(nested.length, 1, 'nested actor must be found');
  assert.equal(nested[0].value, 'zzz_deep_actor');

  const arrayed = scanTemp([{ assignee: ['ada', 'zzz_array_actor'] }]);
  assert.equal(arrayed.length, 1, 'array members must be checked individually');
  assert.equal(arrayed[0].value, 'zzz_array_actor');
});

test('#849 the synthetic cast passes, and matching is case-insensitive', () => {
  const findings = scanTemp([
    { by: 'ada', declaredBy: 'bo', author: 'grace' },
    { createdBy: 'Ada', claimedBy: 'UNASSIGNED' },
  ]);
  assert.deepEqual(findings, [], 'the synthetic cast must not trip the guard in any casing');
});

test('#849 the guard file itself names no real seat — the constraint, asserted', () => {
  // ⚠️ A guard that lists the names it protects publishes them. This asserts
  // the property structurally rather than trusting the author to remember:
  // every allowlisted actor must be a placeholder, and the module must not have
  // acquired a forbidden-list of real names.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'tools', 'fixture-provenance.mjs'), 'utf8');

  // ⚠️ Asserted on a DECLARATION, not on the bare word. The first version of
  // this check matched /FORBIDDEN|DENY/i and went red against the module's own
  // header, which explains why the push gate makes the opposite trade. A guard
  // that cannot distinguish "discusses a deny-list" from "declares one" fires
  // on its own documentation — the always-fires rule, reproduced inside the
  // test written to keep this file honest.
  assert.ok(!/^\s*(export\s+)?const\s+(FORBIDDEN|REAL_ACTORS|DENY\w*)\s*=/m.test(src),
    'this guard must stay an allowlist — a deny-list here would name what it protects');
  assert.ok(SYNTHETIC_ACTORS.size >= 8 && ACTOR_KEYS.size >= 8,
    'sanity: the exported sets are populated, so an empty-set scan cannot pass vacuously');
});
