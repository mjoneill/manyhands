/**
 * #1386 — THE STORE METER: decision d0c5839d's ceilings as a standing check
 * that reports crossings, and raw readings a trend can plot.
 *
 * The card's own TEST, verbatim: "the block reports triples/RSS/boot path;
 * with a ceiling env lowered to below the current RSS the standing check
 * reports one row naming rss; at the default ceilings, zero rows. Negative
 * control: a check that cannot read the process reports error, never zero
 * rows."
 *
 * Sabotages, each failing a different test: drop the rss comparison → the
 * lowered-ceiling served test; return [] instead of throwing on a null store
 * → the negative control; drop the boot record → the served block's boot.path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStoreMeter, meterCeilings, meterLine } from '../core/store-meter.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const MB = 1048576;
const mem = (o = {}) => ({ rss: 900 * MB, heapTotal: 300 * MB, heapUsed: 200 * MB, external: 600 * MB, arrayBuffers: 591 * MB, ...o });

test('#1386 within bounds ⇒ readings and ZERO crossed; each ceiling crossed ⇒ exactly its row', () => {
  const base = { store: { size: 432_000 }, memory: mem(), boot: { path: 'warm', ms: 1064, seq: 32157 }, replayTailMs: 1332, snapshot: { seq: 32157, bytes: 110 * MB, dumpedAt: '2026-09-15T12:40:03Z' } };
  const ok = readStoreMeter(base);
  assert.deepEqual(ok.crossed, []);
  assert.equal(ok.readings.triples, 432_000);
  assert.equal(ok.readings.storeMB, 591);
  assert.equal(ok.readings.kbPerTriple, 1.4, 'the number the 09-15/16 reads argued about, reported not gated');
  assert.equal(ok.readings.boot.path, 'warm');

  assert.deepEqual(readStoreMeter({ ...base, memory: mem({ arrayBuffers: 1700 * MB }) }).crossed.map((c) => c.measure), ['storeMB']);
  assert.deepEqual(readStoreMeter({ ...base, memory: mem({ rss: 4200 * MB }) }).crossed.map((c) => c.measure), ['rssMB']);
  assert.deepEqual(readStoreMeter({ ...base, boot: { path: 'warm', ms: 12_000 } }).crossed.map((c) => c.measure), ['warmBootMs']);
  assert.deepEqual(readStoreMeter({ ...base, boot: { path: 'cold', ms: 0 }, replayTailMs: 15_021 }).crossed, [], 'a COLD boot\'s 15 s is not a warm-start crossing; it is the replay tail, under 60 s');
  assert.deepEqual(readStoreMeter({ ...base, replayTailMs: 1_600_925 }).crossed.map((c) => c.measure), ['replayTailMs'], 'the 09-15 18:41Z sync (26.7 min) would have been a row');
  const c = readStoreMeter({ ...base, memory: mem({ arrayBuffers: 1700 * MB }) }).crossed[0];
  assert.deepEqual(Object.keys(c).sort(), ['ceiling', 'measure', 'value'], 'a row is {measure, value, ceiling}');
});

test('#1386 NEGATIVE CONTROL — no store or no memory is an ERROR, never zero rows', () => {
  assert.throws(() => readStoreMeter({ store: null, memory: mem() }), /store not built/);
  assert.throws(() => readStoreMeter({ store: { size: 1 }, memory: null }), /memory unreadable/);
});

test('#1386 ceilings come from env with the proposal\'s defaults; a bad value falls back', () => {
  assert.deepEqual(meterCeilings({}), { storeMB: 1536, rssMB: 4096, warmBootMs: 10_000, replayTailMs: 60_000 });
  assert.equal(meterCeilings({ SCRUM_METER_RSS_CEILING_MB: '1' }).rssMB, 1);
  assert.equal(meterCeilings({ SCRUM_METER_RSS_CEILING_MB: 'lots' }).rssMB, 4096);
  const line = meterLine(readStoreMeter({ store: { size: 10 }, memory: mem(), boot: { path: 'warm', ms: 900 } }).readings, [{ measure: 'rssMB', value: 5000, ceiling: 4096 }]);
  assert.match(line, /^graph-store-meter: 10 triples .* boot warm 900ms .* ⚠️ CROSSED rssMB=5000>4096$/);
});

/** Served: the real server, its real replica, its real memory. */
test('#1386 served — /api/checks carries storeMeter with triples/RSS/boot path; default ceilings ⇒ zero rows; a 1 MB RSS ceiling ⇒ one row naming rssMB', async () => {
  const board = makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'a card', description: '', type: 'task', column: 'backlog', order: 0, assignees: [], labels: [], createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z', version: 1, relationships: { relatedTo: [], blockedBy: [] } }], conversations: [] });
  const srv = await startRestServer({ board });
  try {
    const checks = await (await fetch(`${srv.baseUrl}/api/checks`)).json();
    const std = checks.standing.find((s) => s.id === 'graph-store-meter');
    assert.ok(std, 'the standing row exists');
    assert.equal(std.error, undefined, `no error on a built replica: ${JSON.stringify(std)}`);
    assert.deepEqual(std.rows, [], 'default ceilings on a fixture board: within bounds');
    const m = checks.storeMeter;
    assert.ok(m && typeof m.triples === 'number' && m.triples > 0, `triples read from the live store: ${JSON.stringify(m)}`);
    assert.ok(m.rssMB > 0 && m.storeMB >= 0, 'process memory read');
    assert.ok(m.boot && ['warm', 'cold'].includes(m.boot.path), `boot path recorded at the boot: ${JSON.stringify(m.boot)}`);
    assert.equal(m.boot.path, 'cold', 'a fixture board has no snapshot beside it');
    assert.equal(typeof m.replayTailMs, 'number', 'the first sync after boot is the replay tail');
    assert.equal(m.snapshot, null, 'no sidecar yet');
    assert.match(m.storeMBmeans, /arrayBuffers/, 'the proxy is named as one on the payload');
  } finally { await srv.stop(); }

  const low = await startRestServer({ board, env: { SCRUM_METER_RSS_CEILING_MB: '1' } });
  try {
    const checks = await (await fetch(`${low.baseUrl}/api/checks`)).json();
    const std = checks.standing.find((s) => s.id === 'graph-store-meter');
    assert.deepEqual(std.rows.map((r) => r.measure), ['rssMB'], `a 1 MB RSS ceiling is crossed by any process: ${JSON.stringify(std.rows)}`);
    assert.equal(std.rows[0].ceiling, 1);
    assert.ok(std.rows[0].value > 1);
  } finally { await low.stop(); }
});
