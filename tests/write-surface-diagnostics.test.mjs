/**
 * #831 — WHICH WRITE SURFACES CAN BE AUDITED AT ALL.
 *
 * The three-list invariant needs `declares`, and on a wire surface the only
 * available proxy is "did the route report this field as ignored?". A route
 * that emits no diagnostic cannot answer that — so it cannot be audited, and
 * an auditor that doesn't notice will report it clean.
 *
 * This file is the census. It is deliberately a map of the CURRENT state
 * rather than a pass/fail on a fix, because the fix belongs to each route and
 * lands at different times (#841 covers /api/nodes and is claimed). What must
 * not happen is a surface quietly losing its diagnostic, or a new write
 * surface arriving without one and nobody noticing.
 *
 * ⚠️ THE ASSERTION IS ON THE EXACT MAP, NOT ON A COUNT. "at least N surfaces
 * report" passes when one is fixed and another regresses. Every entry carries
 * why it is where it is.
 *
 * ⭐ Detection is self-calibrating: send a key that cannot be real and see if
 * the route says anything. A route silent about deliberate junk has no
 * diagnostic, whatever it is named — and /api/cards is the positive control,
 * so "no diagnostic" can never be produced by a broken detector.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const JUNK = 'zzz_diagnostic_probe_not_a_real_field';

/**
 * The expected map. `true` = the route reports what it discarded.
 *
 * ⇒ FOUR write surfaces exist and ONE reports. The #823 fix was applied where
 *   each incident happened rather than to the class, so three siblings still
 *   accept a field, return 2xx, discard it, and say nothing.
 */
const EXPECTED = {
  'POST /api/cards': true,      // #829 — the control, and the only one fixed
  'PATCH /api/cards': true,     // #823
  'PATCH /api/nodes': true,     // #841 — SHIPPED. flipped in the merge that landed it.
  'POST /api/conversations': false, // unfixed — now carded as #843
  'PATCH /api/columns': false,      // unfixed — now carded as #843
};

async function probe(baseUrl) {
  const out = {};
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
  const has = (b) => Array.isArray(b?.ignoredFields);

  const created = await j(await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'diag probe', createdBy: 'ada', [JUNK]: 'x' }),
  }));
  out['POST /api/cards'] = has(created.body);
  const shortId = created.body.shortId;

  const patched = await j(await fetch(`${baseUrl}/api/cards/${shortId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'ada', [JUNK]: 'x' }),
  }));
  out['PATCH /api/cards'] = has(patched.body);

  const node = await j(await fetch(`${baseUrl}/api/nodes/${shortId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'n', [JUNK]: 'x' }),
  }));
  out['PATCH /api/nodes'] = has(node.body);

  const conv = await j(await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'probe', author: 'ada', [JUNK]: 'x' }),
  }));
  out['POST /api/conversations'] = has(conv.body);

  const cols = await (await fetch(`${baseUrl}/api/columns`)).json();
  const col = await j(await fetch(`${baseUrl}/api/columns/${cols[0].id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: cols[0].name, [JUNK]: 'x' }),
  }));
  out['PATCH /api/columns'] = has(col.body);

  return out;
}

test('#831 — the write-surface diagnostic census matches the expected map', async () => {
  const server = await startRestServer();
  let actual;
  try {
    actual = await probe(server.baseUrl);
  } finally {
    await server.stop();
  }

  const rows = Object.entries(actual)
    .map(([k, v]) => `  ${v ? '✅ reports' : '⛔ SILENT '}  ${k}`).join('\n');
  console.log(`\n#831 write-surface diagnostics — ${Object.values(actual).filter(Boolean).length}`
    + ` of ${Object.keys(actual).length} report what they discard\n${rows}\n`);

  // The positive control. Without it, an all-false result would be
  // indistinguishable from a probe that never reached the server.
  assert.equal(
    actual['POST /api/cards'], true,
    'the control must report — an all-silent census means the DETECTOR is broken, not the routes',
  );

  assert.deepEqual(
    actual, EXPECTED,
    'the write-surface diagnostic map changed.\n'
    + '  A surface flipping false->true means a fix shipped: update EXPECTED (that is the point).\n'
    + '  A surface flipping true->false is a REGRESSION: a route stopped reporting what it drops.\n'
    + '  A NEW key means a write surface was added — it needs a diagnostic before it ships.',
  );
});

test('#831 — a route with a diagnostic names the offending key, not just its existence', async () => {
  // Guards the weaker failure: an `ignoredFields: []` that is always empty
  // would satisfy Array.isArray and tell a caller nothing.
  const server = await startRestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'named', createdBy: 'ada', [JUNK]: 'x' }),
    });
    const body = await res.json();
    assert.deepEqual(body.ignoredFields, [JUNK], 'the diagnostic must NAME the field');
    assert.equal(body.title, 'named', 'control: the legal half of the write landed');
  } finally {
    await server.stop();
  }
});
