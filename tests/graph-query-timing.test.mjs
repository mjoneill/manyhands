/**
 * #898 — what does `ms` MEASURE, and can the next slow query explain itself?
 *
 * Two production rows logged 9,443ms and 28,610ms for queries that reproduce
 * in 1ms and 53ms. Every explanation offered died: not the projection
 * (rebuiltMs was null), not the query shape (2–5ms live, twelve runs), not the
 * corpus (a larger isolated store answers in 1–20ms). The time was genuinely
 * spent inside a synchronous store.query() and nothing recorded what else was
 * true of the process at that moment — so the rows can never be explained,
 * only re-measured. Meanwhile three shipped hints quoted them as facts.
 *
 * The exit is a build, not a fourth measurement:
 *   1  the instrument SAYS what each number measures, on every response — the
 *      `blindTo` discipline the watermark already follows;
 *   2  a call slower than a published threshold records the process's state
 *      at that moment (load, memory, event-loop utilization) so the NEXT
 *      transient carries its own context;
 *   3  the #887 hint stops teaching a rule whose only basis was one of those
 *      two rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const Q = 'SELECT ?c WHERE { ?c a schema:CreativeWork } LIMIT 1';

async function query(srv, q = Q) {
  return fetch(`${srv.baseUrl}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, by: 'ada' }),
  }).then((r) => r.json());
}
function logEntries(srv) {
  const f = path.join(path.dirname(srv.boardFile), 'graph-query-log.jsonl');
  return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('every /api/graph response says what its numbers MEASURE — ms is synchronous engine time, and the response says so beside the number', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const r = await query(srv);
    assert.equal(typeof r.ms, 'number');
    assert.ok(r.timing, 'a timing block rides every response');
    assert.equal(typeof r.timing.totalMs, 'number');
    assert.ok(r.timing.totalMs >= r.ms, 'wall time contains engine time');
    assert.ok('rebuiltMs' in r.timing, 'rebuiltMs is present even when null — "no sync ran" is a fact, not an absence');
    assert.match(r.timing.means.ms, /synchronous/i, 'ms is defined as synchronous engine time');
    assert.match(r.timing.means.totalMs, /wall/i);
    assert.match(r.timing.means.rebuiltMs, /null/i, 'says what null means');
    assert.equal(typeof r.timing.slowAfterMs, 'number', 'the slow threshold is published beside the verdict it produces');
  } finally {
    await srv.stop();
  }
});

test('a fast call logs NO process context — the log does not grow on the happy path', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    await query(srv);
    const [e] = logEntries(srv);
    assert.equal(typeof e.ms, 'number');
    assert.equal(typeof e.totalMs, 'number');
    assert.equal('slow' in e, false);
  } finally {
    await srv.stop();
  }
});

test('a call over the threshold records the PROCESS at that moment — load, memory, event-loop utilization — in the log AND the response', async () => {
  // GRAPH_SLOW_MS=0 makes every call "slow": the shape under test is the record, not the stall.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { GRAPH_SLOW_MS: '0' } });
  try {
    const r = await query(srv);
    assert.equal(r.timing.slowAfterMs, 0);
    assert.ok(r.timing.slow, 'the response carries the context too, so the caller who felt the stall sees why');
    const [e] = logEntries(srv);
    assert.ok(e.slow, 'the log row carries it');
    for (const s of [e.slow, r.timing.slow]) {
      assert.equal(typeof s.loadavg1, 'number');
      assert.equal(typeof s.rssMb, 'number');
      assert.equal(typeof s.heapUsedMb, 'number');
      assert.ok(s.eventLoopUtilization >= 0 && s.eventLoopUtilization <= 1, 'ELU over the call is a fraction');
      assert.equal(typeof s.uptimeS, 'number');
    }
    assert.equal(e.slow.loadavg1, r.timing.slow.loadavg1, 'one reading, two outlets');
  } finally {
    await srv.stop();
  }
});

test('the threshold is read from the environment, published as read, and defaults to 2000ms', async () => {
  const a = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const b = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { GRAPH_SLOW_MS: '750' } });
  try {
    assert.equal((await query(a)).timing.slowAfterMs, 2000);
    assert.equal((await query(b)).timing.slowAfterMs, 750);
  } finally {
    await a.stop(); await b.stop();
  }
});

test('#887 hint: the UNBOUNDED_PATH refusal no longer teaches from the unreproducible 28.6s row', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT ?x WHERE { ?a schema:identifier "1" . ?a !<urn:none>* ?x }' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.code, 'UNBOUNDED_PATH', 'the refusal itself is unchanged — only its teaching sentence');
    assert.doesNotMatch(body.hint, /28\.6|28,6|SECONDS/i, 'no number from an uncharacterised instrument');
    assert.match(body.hint, /CONSTRAIN/i, 'the advice survives as reasoning');
    assert.match(body.hint, /schema:CreativeWork/, 'the measured form is still shown');
  } finally {
    await srv.stop();
  }
});
