/**
 * #1104 — GET /api/graph/vocabulary runs vocabularyDrift over the SERVED graph, so "is the guard refusing a working query right now" is a number
 * about production, with the position that says which state of the graph it is about.
 *
 * REWRITTEN for #1645 slice 2a (2026-10-17, by the test author, not the builder: the original, 0b1faf1, pinned the in-process replica and its
 * watermark, and #1645 retires the replica). The subject is unchanged: drift is reported for the source actually served, with its currency.
 * The served source is now the executor's public dataset, and the currency is the executor's position.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { Q_POSITION } from '../core/logborn-unit.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';

test('GET /api/graph/vocabulary reports drift over the served executor, with its position', { skip: SKIP, timeout: 240000 }, async () => {
  const w = await wholeBoardWorld();
  try {
    const r = await fetch(`${w.rest.baseUrl}/api/graph/vocabulary`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true, `undeclared on the fixture board: ${JSON.stringify(d.undeclared)}`);
    assert.deepEqual(d.undeclared, []);
    assert.ok(d.emitted > 0, 'non-vacuous: the served graph emitted terms');
    assert.ok(Array.isArray(d.unused));
    assert.match(d.means.undeclared, /refused/);
    const pos = await fetch(`${w.exec.baseUrl}/query`, { method: 'POST', body: Q_POSITION });
    const b = JSON.parse(await pos.text()).results.bindings[0];
    assert.equal(d.executorPosition, `${b.e.value}:${b.seq.value}`, 'the number names the graph state it is about: the executor\'s position');
    assert.equal(d.source, 'executor');
    assert.ok('rebuiltMs' in d);
  } finally { await w.stop(); }
});

test('with no executor configured, GET /api/graph/vocabulary is a 503 that says so, never an answer from somewhere else', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/graph/vocabulary`);
    assert.equal(r.status, 503, `a REST with no executor cannot measure the served graph (got ${r.status})`);
    const d = await r.json();
    assert.ok(typeof d.error === 'string' && d.error.length > 0 && typeof d.code === 'string', `it says why, with a code (got ${JSON.stringify(d).slice(0, 200)})`);
    assert.ok(!('emitted' in d) && !('watermark' in d), 'and carries no drift body and no replica watermark');
  } finally { await srv.stop(); }
});
