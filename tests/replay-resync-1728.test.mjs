/**
 * #1728 outcome 2 — a refused lane heals ITSELF through replay_pull, and only itself.
 *
 * Before: a lane refused CURSOR_EPOCH_CHANGED was told to call POST /api/cursors/register
 * with resync "epoch" — REST, keyed by whatever lane the body names. A seat with only MCP
 * could not reach it (commons 44628), so nine lanes waited on a human (10-23).
 *
 * The rows (pre-registered by a reviewer on the card, 2026-11-02; numbering kept):
 *   R1  own lane only: the resync moves the caller's lane; another lane's record is untouched;
 *       the tool's schema has no identity key.
 *   R2  refused → resync → an envelope with no code, serving a row written after the resync.
 *   R3  the resync call serves no page and acks nothing; it names the re-read obligation.
 *   R4  the refusal, read through MCP, names the remedy the caller can reach (this tool).
 *   R6  resync on a healthy lane moves nothing, and says so.
 *   R7  no lane ⇒ NO_DELIVERY_IDENTITY, with or without resync; no cursor created.
 *   R8  REST register is unchanged — held by the existing #1575 / #1577 files, which this
 *       change does not touch (server.js is not in the diff).
 * NOT here: R5 (the rollback twin) runs the same code path with resync "rollback"; building a
 * provable-rollback world over MCP is the #1561 harness's job — the description and remedy
 * text for it are asserted below, the server behaviour is #1561's.
 *
 * A lane is made REFUSED the way #1577 defines it: its stored executor cursor names another
 * store incarnation than the live one (what a restore promotion leaves behind).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, startMcpServer, mcpSession, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { loadCursors, saveCursors } from '../core/cursors.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `rs1728-${p}-`));
const TOK = mintToken();   // a test credential for the memory WRITES that make rows to serve; the lanes use none
function tokensFile() {
  const f = path.join(tmpdir('tok'), 'seat-tokens.json');
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function initStore(dsid) {
  const store = tmpdir('store');
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}

const LIVE = [];
after(async () => { for (const s of LIVE.reverse()) await s.stop(); });

let W = null;
async function world() {
  if (W) return W;
  const dsid = 'rs1728';
  const eventDir = tmpdir('events');
  const rest = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_EVENT_LOG_DIR: eventDir, SCRUM_TRIAL_EXECUTOR_STORE: initStore(dsid), GRAPH_EXECUTOR_PYTHON: PY,
    SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_SEAT_TOKENS: tokensFile(),
  } });
  LIVE.push(rest);
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${rest.baseUrl}/api/trial/counters`)).json().catch(() => ({}));
    if (c.executor) break;
    if (i === 199) throw new Error('executor never came up');
    await pause(50);
  }
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  LIVE.push(mcp);
  W = { rest, mcp, eventDir };
  return W;
}

async function seat(w, seatId) {
  const s = await mcpSession(w.mcp.mcpUrl);
  if (seatId) {
    const reg = await s.rpc('scrum/session/register', { seatId });
    assert.ok(reg?.result?.ok, JSON.stringify(reg));
  }
  return s;
}
const text = (res) => res?.result?.content?.[0]?.text ?? JSON.stringify(res);
const body = (res) => JSON.parse(text(res));
const isError = (res) => !!res?.result?.isError || !!res?.error;
const memory = async (w, title) => {
  const r = await fetch(`${w.rest.baseUrl}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` }, body: JSON.stringify({ owner: 'bob', title, body: 'x' }) });
  const t = await r.text();
  assert.equal(r.status, 201, t);
  return JSON.parse(t).id;
};
/** Make a lane REFUSED: its executor cursor names a store incarnation that is not this one (#1577). */
function strand(eventDir, key) {
  const st = loadCursors(eventDir);
  assert.ok(st.seats[key], `lane ${key} exists`);
  st.seats[key].graph_epoch = 1;
  st.seats[key].graph_incarnation = '0'.repeat(32);
  saveCursors(eventDir, st);
}
const lane = (w, key) => loadCursors(w.eventDir).seats[key];
const MOVING = ['acked', 'served', 'graph_acked', 'graph_served', 'graph_epoch', 'graph_incarnation'];
const pick = (s) => Object.fromEntries(MOVING.map((k) => [k, s?.[k] ?? null]));

test('#1728 schema: replay_pull takes limit and resync, and NO identity key', { skip: SKIP }, async () => {
  const w = await world();
  const s = await seat(w, null);
  const tools = (await s.listTools()).result.tools;
  const t = tools.find((x) => x.name === 'replay_pull');
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['limit', 'resync']);
  assert.deepEqual([...t.inputSchema.properties.resync.enum].sort(), ['epoch', 'rollback']);
  assert.match(t.description, /CURSOR_EPOCH_CHANGED[^]*resync: "epoch"/);
  assert.match(t.description, /CURSOR_ROLLED_BACK[^]*resync: "rollback"/);
  assert.doesNotMatch(t.description, /POST \/api\/cursors\/register/, 'the description no longer routes an MCP seat to REST');
});

test('#1728 R1–R4: a refused lane is told the remedy it can reach, resyncs ITSELF (no page, no ack, the other lane untouched), then is served', { skip: SKIP }, async () => {
  const w = await world();
  const A = await seat(w, 'a1728.t');
  await seat(w, 'b1728.t');
  const KA = 'registry:a1728.t', KB = 'registry:b1728.t';
  await memory(w, 'before');
  strand(w.eventDir, KA);
  strand(w.eventDir, KB);
  const bBefore = JSON.stringify(lane(w, KB));

  // R2(a) + R4 — refused, and the refusal names THIS tool's resync
  const refused = await A.callTool('replay_pull', {});
  assert.ok(isError(refused), `refused, not served: ${text(refused)}`);
  assert.match(text(refused), /CURSOR_EPOCH_CHANGED/);
  assert.match(text(refused), /remedy \(this tool\): call replay_pull with resync: "epoch"/);
  assert.match(text(refused), /re-read memories \/ decisions \/ seat state/);

  // R2(b) + R3 — the resync: what moved, the re-read obligation, no page, no ack
  const aBefore = lane(w, KA);
  const rs = await A.callTool('replay_pull', { resync: 'epoch' });
  assert.ok(!isError(rs), text(rs));
  const r = body(rs);
  assert.equal(r.moved, true, JSON.stringify(r));
  assert.equal(r.lane, KA);
  assert.equal(r.resynced.to_epoch, 1);
  assert.equal(r.resynced.from_commit_seq, aBefore.graph_acked ?? 0);
  assert.deepEqual(r.events, [], 'R3: the resync serves no page');
  assert.equal(r.ack_token, undefined, 'R3: no ack token');
  assert.deepEqual(r.ack, { advanced: false, code: 'RESYNC_SERVES_NO_PAGE' });
  assert.match(r.reread, /re-read memories \/ decisions \/ seat state/);
  const aAfter = lane(w, KA);
  assert.equal(aAfter.acked, aBefore.acked, 'R3: the log half is not acked by a resync');
  assert.equal(aAfter.graph_acked, r.resynced.baseline_commit_seq, 'the executor half moved to the stated baseline');
  assert.notEqual(aAfter.graph_incarnation, '0'.repeat(32), 'and now names the live store');

  // R1 — the other lane is byte-identical (it was never named, and cannot be)
  assert.equal(JSON.stringify(lane(w, KB)), bBefore, 'R1: B untouched by A\'s resync');
  const bStill = await (await seat(w, 'b1728.t')).callTool('replay_pull', {});
  assert.match(text(bStill), /CURSOR_EPOCH_CHANGED/, 'R1: B is still refused');

  // R2(c) — served, no code, including a row written after the resync
  const fresh = `https://scrumboard.local/memory/${await memory(w, 'after-resync')}`;
  let got = [];
  for (let i = 0; i < 5 && !got.includes(fresh); i++) {
    const p = await A.callTool('replay_pull', {});
    assert.ok(!isError(p), text(p));
    const pb = body(p);
    assert.equal(pb.code, undefined);
    got.push(...pb.events.filter((e) => e.graph).map((e) => e.id ?? e.entity?.id));
  }
  assert.ok(got.includes(fresh), `the post-resync row is served: ${JSON.stringify(got)}`);
});

test('#1728 R6: resync on a healthy lane moves nothing, and says so', { skip: SKIP }, async () => {
  const w = await world();
  const A = await seat(w, 'h1728.t');
  const K = 'registry:h1728.t';
  await memory(w, 'healthy');
  const p = await A.callTool('replay_pull', {});
  assert.ok(!isError(p), text(p));
  const before = pick(lane(w, K));
  const rs = body(await A.callTool('replay_pull', { resync: 'epoch' }));
  assert.equal(rs.moved, false, JSON.stringify(rs));
  assert.match(rs.note, /nothing moved: this lane is not refused/);
  assert.equal(rs.reread, undefined);
  assert.deepEqual(pick(lane(w, K)), before, 'every cursor field is unchanged (last_inbound_at is inbound evidence, as on any call)');
  const rb = body(await A.callTool('replay_pull', { resync: 'rollback' }));
  assert.equal(rb.moved, false, JSON.stringify(rb));
  assert.ok(rb.refused, `with the executor live, a rollback resync is refused by the server and says why: ${JSON.stringify(rb)}`);
  assert.deepEqual(pick(lane(w, K)), before);
});

test('#1728 R7: no lane ⇒ NO_DELIVERY_IDENTITY, with or without resync; no cursor is created', { skip: SKIP }, async () => {
  const w = await world();
  const s = await seat(w, null);
  const lanesBefore = Object.keys(loadCursors(w.eventDir).seats).sort();
  for (const args of [{}, { resync: 'epoch' }, { resync: 'rollback' }]) {
    const r = body(await s.callTool('replay_pull', args));
    assert.equal(r.code, 'NO_DELIVERY_IDENTITY', JSON.stringify(r));
  }
  assert.deepEqual(Object.keys(loadCursors(w.eventDir).seats).sort(), lanesBefore);
});
