/**
 * #1868: a memory update that the executor APPLIED must never answer 5xx.
 *
 * Generic retry logic acts on a 5xx before any caller can special-case it. If the
 * read-back after a committed write fails and the request answers 503, the caller
 * retries, and an append lands twice. The rule: an applied write answers 200, and the
 * BODY tells the truth: `outcome: "APPLIED"`, `readBack: { status: "unavailable" }`,
 * and the opId. A caller that needs the stored state re-reads, which never duplicates.
 *
 * Real board server, real executor, and a forwarding proxy between them that can drop
 * exactly ONE read: the first /query naming the memory identifier AFTER the armed /update was
 * forwarded (that query is the read-back).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { spawnExecutor } from './helpers/graph-executor-proc.mjs';
import { appliedReadBackNotice } from '../core/applied-read-back.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const DSID = 'applied-1868';
const TOK = mintToken();

function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'a1868-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
const startExecutor = (store) => spawnExecutor(['--store', store, '--port', '0', '--dataset-id', DSID, '--create']).then((x) => ({ p: x.proc, base: x.baseUrl }));

/** Forwards everything. When `armedFor` names a memory id, the first /query naming its identifier AFTER an /update was forwarded is dropped. */
function startProxy(target) {
  const state = { armedFor: null, sawUpdate: false, dropped: 0, updates: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/update') { state.updates += 1; if (state.armedFor) state.sawUpdate = true; }
      if (req.url === '/query' && state.armedFor && state.sawUpdate && body.toString("utf8").includes(state.armedFor)) {
        state.armedFor = null; state.sawUpdate = false; state.dropped += 1;
        req.socket.destroy();
        return;
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      const r = await fetch(`${target}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(text);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

let EXE, PROXY, SRV;
before(async () => {
  if (SKIP) return;
  EXE = await startExecutor(fs.mkdtempSync(path.join(os.tmpdir(), 'a1868-store-')));
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

test('#1868 A1: an APPLIED append whose read-back fails answers 200 with outcome APPLIED, readBack unavailable and the opId; the text lands once', { skip: SKIP }, async () => {
  const m = await call('POST', '/api/memories', { owner: 'bob', title: 'applied-readback', body: 'base' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const u0 = PROXY.state.updates;
  PROXY.state.armedFor = m.body.id;
  const p = await call('PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ' +A' });
  assert.equal(PROXY.state.dropped, 1, 'the fault fired: the read-back after the write was dropped');
  assert.equal(PROXY.state.updates - u0, 1, 'one write dispatched');
  assert.ok(p.status >= 200 && p.status < 300, `an applied write must not read as "retry me": got ${p.status} ${JSON.stringify(p.body)}`);
  assert.equal(p.body.outcome, 'APPLIED');
  assert.equal(p.body.body, 'base +A', 'the body carries what was composed and sent');
  assert.equal(p.body.version, 2);
  assert.equal(p.body.readBack?.status, 'unavailable');
  assert.equal(typeof p.body.opId, 'string');
  assert.ok(p.body.opId.length > 0);
  const after = (await call('GET', `/api/memories/${m.body.id}`)).body;
  assert.equal(after.body, 'base +A', 'stored exactly once');
  assert.equal(after.version, 2);
});

test('#1868 A2 (control): with no fault the update answers 200 with the memory and NO readBack flag', { skip: SKIP }, async () => {
  const m = await call('POST', '/api/memories', { owner: 'bob', title: 'applied-control', body: 'base' });
  const p = await call('PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ' +B' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.body, 'base +B');
  assert.equal(p.body.readBack, undefined);
  assert.equal(PROXY.state.dropped, 1, 'no fault fired in the control');
});

test('#1868 A3: the MCP-facing notice names the unconfirmed read-back and says re-read, never retry; nothing for a confirmed write', () => {
  const n = appliedReadBackNotice({ outcome: 'APPLIED', readBack: { status: 'unavailable' }, opId: 'op-1' });
  assert.match(n, /APPLIED/);
  assert.match(n, /re-read/i);
  assert.match(n, /do not retry/i);
  assert.match(n, /op-1/);
  assert.equal(appliedReadBackNotice({ id: 'x', body: 'y' }), null);
  assert.equal(appliedReadBackNotice(null), null);
});
