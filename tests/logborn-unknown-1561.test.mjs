/**
 * #1561 — an UNKNOWN write through the log-born unit, on a REAL board server and a REAL
 * executor, with a fault-injecting proxy between them (reviewer a reviewer's surviving mutant:
 * no test induced UNKNOWN through the unit).
 *
 * The proxy forwards every request unchanged, except ONE armed /update:
 *   'drop-reply'    forward it, let the executor APPLY it, then reset the server's socket
 *                   instead of answering — the client cannot know it committed (UNKNOWN).
 *   'drop-request'  reset the socket WITHOUT forwarding — dispatched as far as the client
 *                   can tell, never applied (UNKNOWN, and the receipt is ABSENT).
 *
 * What the unit must do (core/logborn-unit.mjs write()): reconcile by the SAME opId's
 * receipt; trust APPLIED; replay the SAME intention only when the receipt is ABSENT.
 * Each test asserts EXACTLY ONE effect: one memory / one appended text, one receipt, and
 * the opIds the proxy saw.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { readExecutor, parsePending, reconcilePending } from '../scripts/rollback-logborn-1561.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const EXEC = path.join(PROJECT_DIR, 'graph-executor', 'executor.py');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const DSID = 'lb-unknown';
const TOK = mintToken();

function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lbu-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
function startExecutor(store) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', DSID, '--create'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`executor exited ${code}: ${err}`)));
  });
}
/** A forwarding proxy that can fault exactly one armed /update. `log` records every /update's opId and fate. */
function startProxy(target) {
  const state = { armed: null, log: [], receiptReads: 0, failReceipts: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const op = req.headers['x-op-id'] || null;
      const fault = req.url === '/update' ? state.armed : null;
      if (fault) state.armed = null;
      if (req.url.startsWith('/receipt/')) {
        state.receiptReads += 1;
        if (state.failReceipts > 0) { state.failReceipts -= 1; req.socket.destroy(); return; }   // the reconcile cannot learn either
      }
      if (req.url === '/update') state.log.push({ op, fault });
      if (fault === 'drop-request') { req.socket.destroy(); return; }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      const r = await fetch(`${target}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
      const text = await r.text();
      if (fault === 'drop-reply') { req.socket.destroy(); return; }   // the executor HAS answered: it applied
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(text);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

let EXE, PROXY, SRV;
before(async () => {
  if (SKIP) return;
  EXE = await startExecutor(fs.mkdtempSync(path.join(os.tmpdir(), 'lbu-store-')));
  PROXY = await startProxy(EXE.base);
  SRV = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: PROXY.base, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_UNIT_LOGBORN: '1',
    SCRUM_SEAT_TOKENS: tokensFile(), SCRUM_AUTH: 'required', GRAPH_EXECUTOR_PYTHON: PY,
  } });
});
after(async () => { await SRV?.stop(); PROXY?.srv.close(); EXE?.p.kill('SIGKILL'); });

const call = async (method, p, body) => {
  const r = await fetch(`${SRV.baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
/** Every receipt in the store whose op recorded something about memory `id` (direct to the executor, past the proxy). */
async function receiptsFor(id) {
  const M = `https://scrumboard.local/memory/${id}`;
  // #1638: receipts (outcome, target) and the recordedBy stamp are bookkeeping, read from their named graph; ofMemory is domain.
  const q = `SELECT DISTINCT ?op ?out WHERE { GRAPH <urn:scrum:bookkeeping:executor> { ?op <urn:ex:outcome> ?out } { GRAPH <urn:scrum:bookkeeping:executor> { ?op <urn:ex:target> <${M}> } } UNION { GRAPH <urn:scrum:bookkeeping:executor> { ?v <urn:ex:recordedBy> ?op } ?v <https://scrumboard.local/ns#ofMemory> <${M}> } }`;
  const r = await (await fetch(`${EXE.base}/query`, { method: 'POST', body: q })).json();
  return r.results.bindings.map((b) => ({ op: b.op.value, outcome: b.out.value.replace(/^.*[#/:]/, '') }));
}
const allReceipts = async () => (await (await fetch(`${EXE.base}/query`, { method: 'POST', body: 'SELECT ?op WHERE { GRAPH <urn:scrum:bookkeeping:executor> { ?op <urn:ex:outcome> ?o } }' })).json()).results.bindings.length;

test('#1561 UNKNOWN (applied, reply lost): memory.create is reconciled by its receipt — one memory, one receipt, one dispatch', { skip: SKIP }, async () => {
  const r0 = await allReceipts();
  const n0 = PROXY.state.log.length, rr0 = PROXY.state.receiptReads;
  PROXY.state.armed = 'drop-reply';
  const m = await call('POST', '/api/memories', { owner: 'bob', title: 'unknown-create', body: 'once' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const sent = PROXY.state.log.slice(n0);
  assert.equal(sent[0]?.fault, 'drop-reply', 'the fault was injected on this write');
  assert.equal(sent.length, 1, `the reconcile said APPLIED, so nothing was dispatched again: ${JSON.stringify(sent)}`);
  assert.ok(PROXY.state.receiptReads > rr0, 'the unit READ the receipt (reconciled) rather than assuming');
  const list = (await call('GET', '/api/memories')).body.memories.filter((x) => x.title === 'unknown-create');
  assert.equal(list.length, 1, 'exactly one memory');
  assert.equal(await allReceipts(), r0 + 1, 'exactly one receipt');
  assert.deepEqual((await receiptsFor(m.body.id)).map((x) => x.outcome), ['APPLIED']);
});

test('#1561 UNKNOWN (never applied, request lost): the receipt is ABSENT, the SAME opId is replayed once — one memory, one receipt', { skip: SKIP }, async () => {
  const r0 = await allReceipts();
  const n0 = PROXY.state.log.length;
  PROXY.state.armed = 'drop-request';
  const m = await call('POST', '/api/memories', { owner: 'bob', title: 'unknown-absent', body: 'once' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const sent = PROXY.state.log.slice(n0);
  assert.equal(sent.length, 2, `dropped, then replayed exactly once: ${JSON.stringify(sent)}`);
  assert.equal(sent[0].op, sent[1].op, 'the replay is the SAME intention (same opId), never a freshly minted one');
  assert.equal((await call('GET', '/api/memories')).body.memories.filter((x) => x.title === 'unknown-absent').length, 1);
  assert.equal(await allReceipts(), r0 + 1, 'exactly one receipt');
});

test('#1561 UNKNOWN on an APPEND (applied, reply lost): the text is appended ONCE — a fresh-opId retry would re-read and append it again', { skip: SKIP }, async () => {
  const m = await call('POST', '/api/memories', { owner: 'bob', title: 'unknown-append', body: 'base' });
  assert.equal(m.status, 201);
  const n0 = PROXY.state.log.length;
  PROXY.state.armed = 'drop-reply';
  const p = await call('PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ' +A' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const after = (await call('GET', `/api/memories/${m.body.id}`)).body;
  assert.equal(after.body, 'base +A', 'appended exactly once');
  assert.equal(after.version, 2);
  assert.equal(PROXY.state.log.slice(n0).length, 1, 'one dispatch');
  assert.deepEqual((await call('GET', `/api/memories/${m.body.id}/versions`)).body.versions.map((v) => v.version), [1, 2]);
  assert.deepEqual((await receiptsFor(m.body.id)).map((x) => x.outcome).sort(), ['APPLIED', 'APPLIED'], 'create + one revise, nothing else');
});

test('#1561 UNKNOWN that the server CANNOT reconcile (reply AND receipt read lost): 503 carries the opId, stderr records it, and the rollback reconciles it by receipt as APPLIED', { skip: SKIP }, async () => {
  PROXY.state.armed = 'drop-reply';
  PROXY.state.failReceipts = 1;
  const m = await call('POST', '/api/memories', { owner: 'bob', title: 'unknown-outstanding', body: 'maybe' });
  assert.equal(m.status, 503, JSON.stringify(m.body));
  assert.equal(m.body.code, 'GRAPH_WRITE_UNKNOWN');
  assert.match(m.body.opId, /^urn:ex:op\/logborn\/memory\//, 'the caller is told WHICH write is outstanding');
  const pending = parsePending(SRV.stderr());
  const mine = pending.filter((p) => p.opId === m.body.opId);
  assert.equal(mine.length, 1, `the server's stderr records the outstanding opId: ${SRV.stderr().slice(-2000)}`);
  assert.equal(mine[0].kind, 'memory.create');
  assert.equal(mine[0].actor, 'urn:ex:seat/bob');
  // the executor DID apply it (drop-reply): the rollback's reconciliation says so, by receipt
  const ex = await readExecutor(createGraphClient({ baseUrl: EXE.base, expectedDatasetId: DSID }));
  const r = reconcilePending([...mine, { opId: 'urn:ex:op/logborn/memory/never-sent' }], ex);
  assert.deepEqual(r, { applied: [m.body.opId], absent: ['urn:ex:op/logborn/memory/never-sent'], notApplied: [], unreconcilable: [] });
});
