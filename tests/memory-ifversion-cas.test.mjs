/**
 * #466 slice — OPTIONAL compare-and-swap on memory updates.
 *
 * #466 specified the mechanism on 2026-07-25: a monotonic version inside the
 * existing write mutex, `ifVersion` → 409 carrying the current version, reusing
 * the claim rail's "409 means yield, not retry". This is that, on the smallest
 * surface in the codebase.
 *
 * ⭐ WHY THE MEMORY STORE FIRST, and it is not arbitrary:
 *   · the version already exists, already increments monotonically inside
 *     withWriteLock, and is already echoed in every response — the precondition
 *     needs no new state and no new field on disk
 *   · every prior version is PRESERVED (the handler is append-only by design),
 *     so getting this wrong destroys nothing and the experiment is reversible
 *
 * ⛔ OPT-IN BY CONSTRUCTION. A caller that sends no `ifVersion` is unaffected —
 * identical behaviour to before. Only a caller who explicitly asks for the
 * precondition can be refused. That is what makes this safe to land on a running
 * store: it cannot break a writer that does not opt in, and test 1 pins exactly
 * that, because a precondition that silently applies to everyone is a far worse
 * defect than the one it fixes.
 *
 * ⚠️ WHAT THIS IS NOT: the card-write and whole-board-save paths (#534, #237)
 * carry the same defect and are NOT touched here. Those destroy data; this
 * surface only forks it. This proves the pattern where it is cheapest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const MEM = { title: 'probe', body: 'ORIGINAL', tags: [], owner: 'ada' };

test('#466 omitting ifVersion is UNCHANGED behaviour — the precondition is opt-in', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;
    assert.equal(c.body.version, 1);

    // No ifVersion anywhere. This is every existing caller.
    const u1 = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { body: 'SECOND', by: 'bex' });
    assert.equal(u1.status, 200, 'a caller that does not opt in must never be refused');
    assert.equal(u1.body.version, 2);

    const u2 = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { body: 'THIRD', by: 'cy' });
    assert.equal(u2.status, 200, 'still unaffected on a subsequent write');
    assert.equal(u2.body.version, 3, 'versions keep incrementing exactly as before');
  } finally { await s.stop(); }
});

test('#466 a CORRECT ifVersion is accepted and advances the version', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;

    const ok = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { body: 'SECOND', by: 'bex', ifVersion: 1 });
    assert.equal(ok.status, 200, `a matching precondition must succeed. Got ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.version, 2);
    assert.equal(ok.body.body, 'SECOND');
  } finally { await s.stop(); }
});

test('#466 a STALE ifVersion is REFUSED with 409, and nothing is written', async () => {
  // ⭐ THE LOAD-BEARING TEST. A 409 that still wrote would be worse than no
  // precondition at all: the caller is told it yielded while its text landed.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;

    // Another writer moves it to version 2.
    const other = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { body: 'FROM B', by: 'bex' });
    assert.equal(other.body.version, 2, 'the other writer must land first, or this asserts nothing');

    // A writes back declaring the version it read — which is now stale.
    const stale = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { body: 'FROM A (STALE)', by: 'ada', ifVersion: 1 });

    assert.equal(stale.status, 409,
      `a stale precondition must be REFUSED. Got ${stale.status}: ${JSON.stringify(stale.body)}`);
    assert.equal(stale.body.currentVersion, 2,
      'the 409 must carry the CURRENT version so the caller can re-read and retry, '
      + `not merely say no. Got ${JSON.stringify(stale.body)}`);

    // ⛔ ANTI-VACUITY: the refusal must have written NOTHING.
    const after = await api(s.baseUrl, 'GET', `/api/memories/${id}`);
    assert.equal(after.body.version, 2, 'a refused write must NOT advance the version');
    assert.equal(after.body.body, 'FROM B',
      "the other writer's text must survive — a 409 that still wrote is the defect wearing a status code");
  } finally { await s.stop(); }
});
