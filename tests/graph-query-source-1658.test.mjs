/**
 * #1658, THE SERVER HALF: `POST /api/graph` (the graph_query path) names the store that answered, in its RESPONSE, and can be ASKED for a store per request. Test author's rows, written BEFORE the build
 * (2026-10-09). Why: after the #1570 flip `SCRUM_GRAPH_QUERY_SOURCE` is read once at start and every caller is answered from the executor, so the differential harness's "replica" leg silently became the
 * executor and every comparison read `equal` by construction. The retro adopted a guard: each leg of a comparison reports its own source in its response, never from a flag, and the harness refuses
 * missing / swapped / identical sources. This file pins the endpoint half; the harness half is pinned in diagnostics (graph-differential-source.test.mjs).
 *
 * CONTRACT PINNED HERE:
 *   - every 200 response from POST /api/graph carries a top-level string `source`: 'replica' or 'executor' (the store that answered), whatever the process default is;
 *   - an optional body field `source` ('replica' | 'executor') asks for a store for THIS request; absent means the process default (SCRUM_GRAPH_QUERY_SOURCE, as today);
 *   - a request that cannot be honoured (an unknown value, or 'executor' when this process has no executor configured) is refused loudly (4xx or 503, an `error` string, NO rows), never silently answered from the other store.
 *
 *   G0 CONTROL  the switch unset: a request with no `source` is answered by the replica and SAYS 'replica'
 *   G1          the switch on: no `source` in the request is answered by the executor and SAYS 'executor' (the flip's behaviour, kept)
 *   G2          the switch on: a request with `source: 'replica'` is answered by the REPLICA (it does not see a marker row the proxy injects into the executor's answers) and SAYS 'replica'
 *   G3          the switch unset but an executor configured: `source: 'executor'` is answered by the executor (it sees the marker) and SAYS 'executor'
 *   G4          an unknown `source` value (a string that is neither, a number, an object) is refused: not 200, an `error` string, no `rows`
 *   G5          `source: 'executor'` on a process with NO executor configured is refused loudly and is NOT answered from the replica
 *
 * NOT covered, by name: graph_neighbors and the other graph endpoints; the MCP tool's own argument (the tool may pass `source` through or not; no row pins it); authorisation of who may ask for a store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const MARKER = 'https://example.test/marker-1658';
const ROSTER_FILE = path.join(os.tmpdir(), `g1658-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

/** A proxy in front of the executor that adds ONE marker row to every SELECT answer of the PUBLIC dataset: the replica never sees it, so it names which store answered. */
async function startMarkerProxy(execUrl) {
  const p = {}; p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    let t = await f.text();
    if (req.method === 'POST' && req.url.startsWith('/query?dataset=public')) { try { const j = JSON.parse(t); if (Array.isArray(j?.results?.bindings) && j.head.vars.includes('s')) { j.results.bindings.push({ s: { type: 'uri', value: MARKER } }); t = JSON.stringify(j); } } catch { /* not a SELECT */ } }
    res.statusCode = f.status; res.setHeader('content-type', f.headers.get('content-type') || 'application/json'); res.end(t);
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function withRest({ switchOn, executor = true }, body) {
  const exec = executor ? await startExecutor({ store: tmpStore('g1658-'), datasetId: 'g1658-test', create: true }) : null;
  const proxy = exec ? await startMarkerProxy(exec.baseUrl) : null;
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, ...(exec ? { SCRUM_GRAPH_DATASET_ID: 'g1658-test', SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}), ...(switchOn ? { SCRUM_GRAPH_QUERY_SOURCE: 'executor' } : {}) };
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }), env });
  try { return await body(rest); } finally { await rest.stop(); if (proxy) await proxy.down(); if (exec) await killExecutor(exec); }
}
const Q = 'SELECT ?s WHERE { ?s a <https://schema.org/CreativeWork> }';
const ask = async (rest, extra = {}) => { const r = await fetch(`${rest.baseUrl}/api/graph`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: Q, ...extra }), signal: AbortSignal.timeout(30000) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text }; };
const sawMarker = (j) => (j?.rows ?? []).some((x) => String(x.s ?? '').includes('marker-1658'));

test('G0 CONTROL, switch unset: no source in the request is answered by the replica and the response SAYS replica', { skip: SKIP, timeout: 200000 }, async () => {
  await withRest({ switchOn: false }, async (rest) => {
    const r = await ask(rest); assert.equal(r.status, 200, r.text.slice(0, 200)); assert.ok(!sawMarker(r.json), 'the replica never sees the executor-only marker');
    assert.equal(r.json.source, 'replica', 'every response names the store that answered');
  });
});
test('G1 switch on: no source in the request is answered by the executor and SAYS executor', { skip: SKIP, timeout: 200000 }, async () => {
  await withRest({ switchOn: true }, async (rest) => {
    const r = await ask(rest); assert.equal(r.status, 200, r.text.slice(0, 200)); assert.ok(sawMarker(r.json), 'CONTROL: the executor leg shows the marker the proxy adds'); assert.equal(r.json.source, 'executor');
  });
});
test('G2 switch on: source "replica" in the request is answered by the REPLICA (no marker) and SAYS replica', { skip: SKIP, timeout: 200000 }, async () => {
  await withRest({ switchOn: true }, async (rest) => {
    const def = await ask(rest); assert.ok(sawMarker(def.json), 'CONTROL: without the field, the executor answers and the marker is there');
    const r = await ask(rest, { source: 'replica' }); assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(!sawMarker(r.json), 'the replica was asked for: the executor-only marker must be absent'); assert.equal(r.json.source, 'replica');
  });
});
test('G3 switch unset but an executor configured: source "executor" is answered by the executor and SAYS executor', { skip: SKIP, timeout: 200000 }, async () => {
  await withRest({ switchOn: false }, async (rest) => {
    const def = await ask(rest); assert.ok(!sawMarker(def.json), 'CONTROL: by default the replica answers');
    const r = await ask(rest, { source: 'executor' }); assert.equal(r.status, 200, r.text.slice(0, 200)); assert.ok(sawMarker(r.json), 'the executor was asked for: the marker is there'); assert.equal(r.json.source, 'executor');
  });
});
test('G4 an unknown source value is refused: not 200, an error string, no rows', { skip: SKIP, timeout: 200000 }, async () => {
  await withRest({ switchOn: true }, async (rest) => {
    for (const bad of ['both', 'Replica', '', 42, null, { x: 1 }, ['replica']]) {   // null is refused too: an explicit null is not "absent"
      const r = await ask(rest, { source: bad });
      assert.notEqual(r.status, 200, `source ${JSON.stringify(bad)} must be refused (got ${r.status}: ${r.text.slice(0, 120)})`);
      assert.equal(typeof r.json?.error, 'string', `${JSON.stringify(bad)}: an error string`); assert.ok(!('rows' in (r.json ?? {})), `${JSON.stringify(bad)}: no rows`);
    }
    assert.equal((await ask(rest)).status, 200, 'CONTROL: a valid request still answers');
  });
});
test('G5 source "executor" on a process with NO executor configured is refused loudly, not answered from the replica', { skip: SKIP, timeout: 200000 }, async () => {
  await withRest({ switchOn: false, executor: false }, async (rest) => {
    const r = await ask(rest, { source: 'executor' });   // the refusal is asserted FIRST, so a build that lacks the `source` field cannot hide this row's own assertion behind its control
    assert.notEqual(r.status, 200, `an executor request with no executor must be refused (got ${r.status}: ${r.text.slice(0, 160)})`); assert.equal(typeof r.json?.error, 'string'); assert.ok(!('rows' in (r.json ?? {})), 'and carries no rows');
    assert.equal(r.json.code, 'SOURCE_UNAVAILABLE', 'and says WHY: not configured is a different fact from the executor being unreachable (GRAPH_UNAVAILABLE, with a misleading ERR_INVALID_URL when the URL is empty)');
    const ok = await ask(rest); assert.equal(ok.status, 200, 'CONTROL: the default replica answer still works on the same process'); assert.equal(ok.json.source, 'replica');
  });
});
