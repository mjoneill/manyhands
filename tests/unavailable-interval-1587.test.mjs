/**
 * #1587 — a failed executor CALL carries its own interval. The board logs these errors
 * as `GET <route>: <e.message>`, and a blocked event loop can write that line long after
 * the call failed, so the line's position in the log cannot place it against a replica
 * stall. The error itself must say when the call STARTED and how long it ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogbornUnit } from '../core/logborn-unit.mjs';
import { IRI } from '../core/graph-replica.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function unitWith({ fence = async () => null, query }) {
  return createLogbornUnit({ slice: { fence, client: { query } }, loadIri: async () => IRI, audit: () => {} });
}

test('#1587 a transport failure carries the CALL\'s start time and elapsed ms, in fields and in the logged message', async () => {
  const unit = unitWith({ query: async () => { await sleep(60); return { ok: false, reason: 'transport: AbortError' }; } });
  const before = Date.now();
  const err = await unit.readMemories().then(() => null, (e) => e);
  const after = Date.now();
  assert.ok(err, 'the read must fail');
  assert.equal(err.code, 'GRAPH_EXECUTOR_UNAVAILABLE');
  assert.match(err.startedAt, ISO);
  const started = Date.parse(err.startedAt);
  assert.ok(started >= before - 5 && started <= after, `startedAt ${err.startedAt} is the call's start`);
  assert.ok(err.elapsedMs >= 55, `elapsedMs ${err.elapsedMs} covers the failed call`);
  // what the board actually logs is e.message: the interval must be IN it
  assert.ok(err.message.includes(`call started ${err.startedAt}`), err.message);
  assert.ok(err.message.includes(`failed after ${err.elapsedMs} ms`), err.message);
  assert.ok(err.message.endsWith('transport: AbortError'), err.message);
});

test('#1587 a fenced (refused before the call) failure carries its interval too', async () => {
  const unit = unitWith({ fence: async () => 'executor fenced: dataset mismatch', query: async () => ({ ok: true, rows: [] }) });
  const err = await unit.readMemories().then(() => null, (e) => e);
  assert.equal(err.code, 'GRAPH_EXECUTOR_UNAVAILABLE');
  assert.match(err.startedAt, ISO);
  assert.ok(Number.isInteger(err.elapsedMs) && err.elapsedMs >= 0);
  assert.match(err.message, /^graph executor unavailable \(call started .+, failed after \d+ ms\): executor fenced/);
});
