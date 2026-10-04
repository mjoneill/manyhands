/**
 * #1576 — ONLY AN EXPLICIT CLIENT ACK ADVANCES A LANE'S DURABLE CURSOR.
 *
 * #683 committed a pull's serve in `res.end`'s callback and treated the lane's NEXT
 * inbound call as the ack. Measured by the #1571 builder on Node 22: a response whose
 * client destroyed the socket mid-body still gets `res.end`'s callback (no error,
 * writableFinished: true), so a page that never arrived was recorded as served — and
 * the very next inbound call (any MCP request) acked it. #624's loss class, inside its
 * own cure, with the flag OFF as well as ON.
 *
 * The invariant (reviewer a reviewer — the acceptance line):
 *   ONLY    an explicit client ack (POST /api/cursors/ack with the pull's ack_token)
 *           advances `acked` / `graph_acked`.
 *   REPLAY  a disconnect or a lost ack leaves the page replayable.
 *   IDEM    a repeated ack is harmless; an ack never moves a cursor BACKWARD and
 *           never PAST what was served to that lane.
 *   NOT     a successful `res.end` callback (or a resolved push write) is NOT
 *           delivery evidence.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, startPair, mcpSession, freePort, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { appendEvent } from '../core/event-log.mjs';
import { loadCursors } from '../core/cursors.mjs';
import * as svc from '../core/cursor-service.mjs';

// ── PURE ─────────────────────────────────────────────────────────────────────

let n = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `ack1576-${process.pid}-${n++}-`));
const T = (s) => `2026-10-04T12:00:${String(s).padStart(2, '0')}.000Z`;
const card = (dir, i, s = i) => appendEvent(dir, { op: 'update', entity: { kind: 'card', id: `card-${i}`, shortId: i }, state: { title: `c${i}` }, actor: 'ada' }, { now: T(s) });
const gRow = (commitSeq, s) => ({
  kind: 'memory', op: 'create', seq: null, id: `memory-g${commitSeq}`, shortId: null, title: null, column: null, by: 'bob', at: T(s),
  graph: { opId: `urn:ex:op/logborn/memory/${commitSeq}`, commitSeq, version: 1 },
});
const feed = (rows, after, through, extra = {}) => ({ rows: rows.filter((r) => r.graph.commitSeq > after), through, ...extra });
const seat = (dir, key) => loadCursors(dir).seats[key];
const pk = (e) => (e.graph ? `g${e.graph.commitSeq}` : `l${e.seq}`);
const dec = (t) => JSON.parse(Buffer.from(t, 'base64url').toString('utf8'));
const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const KEY = 'registry:lane.ack';

test('#1576 PURE: a non-empty pull carries an ack_token naming its high-water; an empty pull carries none', () => {
  const dir = tmp();
  registerOff(dir);
  card(dir, 1); card(dir, 2);
  const p = svc.serveFor(dir, KEY, { via: 'A' });
  assert.equal(typeof p.ack_token, 'string', 'the page names what it served');
  const t = dec(p.ack_token);
  assert.equal(t.lane, KEY);
  assert.equal(t.log, 2);
  assert.equal(t.via, 'A');
  assert.equal(t.graph, null, 'flag OFF: no executor half');
  p.commit();
  svc.ackFor(dir, KEY, p.ack_token);
  assert.equal(svc.serveFor(dir, KEY).ack_token, null, 'nothing served, nothing to ack');
});
function registerOff(dir) { return svc.registerFor(dir, KEY); }

test('#1576 PURE ONLY: commit + the lane\'s next inbound call do NOT ack; the explicit ack does, exactly to the served high-water', () => {
  const dir = tmp();
  registerOff(dir);
  card(dir, 1); card(dir, 2); card(dir, 3);
  const p = svc.serveFor(dir, KEY, { via: 'A' });
  p.commit();
  svc.noteInbound(dir, KEY, { via: 'A' });
  assert.equal(seat(dir, KEY).acked, 0, 'aliveness after a response is NOT delivery evidence');
  assert.equal(seat(dir, KEY).served, 3, 'the serve is recorded');
  const r = svc.ackFor(dir, KEY, p.ack_token);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.advanced, true);
  assert.equal(seat(dir, KEY).acked, 3, 'exactly the served high-water');
  assert.deepEqual(svc.serveFor(dir, KEY).events, []);
});

test('#1576 PURE IDEM: a repeated ack is a no-op that says so', () => {
  const dir = tmp();
  registerOff(dir);
  card(dir, 1); card(dir, 2);
  const p = svc.serveFor(dir, KEY, { via: 'A' });
  p.commit();
  assert.equal(svc.ackFor(dir, KEY, p.ack_token).advanced, true);
  const before = JSON.stringify(seat(dir, KEY));
  const again = svc.ackFor(dir, KEY, p.ack_token);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.advanced, false);
  assert.equal(again.code, 'ALREADY_ACKED');
  assert.equal(JSON.stringify(seat(dir, KEY)), before, 'state untouched');
});

test('#1576 PURE BACKWARD: an older page\'s token never moves the cursor back (with and without a session `via`)', () => {
  // Both: with a `via` the fence would ALSO refuse the late token (the serve it named is
  // gone), which can mask a backward move — a sabotage run proved it. Without one (a REST
  // client that names no session), only the never-backward rule stands between them.
  for (const via of ['A', null]) {
    const dir = tmp();
    registerOff(dir);
    card(dir, 1); card(dir, 2); card(dir, 3); card(dir, 4);
    const p1 = svc.serveFor(dir, KEY, { via, limit: 2 });
    p1.commit();
    const p2 = svc.serveFor(dir, KEY, { via, limit: 4 });
    p2.commit();
    assert.equal(svc.ackFor(dir, KEY, p2.ack_token).advanced, true);
    assert.equal(seat(dir, KEY).acked, 4);
    const late = svc.ackFor(dir, KEY, p1.ack_token);
    assert.equal(late.advanced, false, `via ${via}: ${JSON.stringify(late)}`);
    assert.equal(late.ok, true, `via ${via}: a stale-but-covered token is a harmless no-op, not an error: ${JSON.stringify(late)}`);
    assert.equal(seat(dir, KEY).acked, 4, `via ${via}: never backward`);
  }
});

test('#1576 PURE PAST: an ack beyond what was served is REFUSED and moves nothing', () => {
  const dir = tmp();
  registerOff(dir);
  card(dir, 1); card(dir, 2); card(dir, 3); card(dir, 4);
  const p = svc.serveFor(dir, KEY, { via: 'A', limit: 2 });
  p.commit();
  const forged = enc({ ...dec(p.ack_token), log: 4 });
  const r = svc.ackFor(dir, KEY, forged);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACK_BEYOND_SERVED');
  assert.equal(seat(dir, KEY).acked, 0);
  // and a token for a page that was never recorded as served (commit never ran)
  const dir2 = tmp();
  svc.registerFor(dir2, KEY);
  card(dir2, 1);
  const uncommitted = svc.serveFor(dir2, KEY, { via: 'A' });
  const r2 = svc.ackFor(dir2, KEY, uncommitted.ack_token);
  assert.equal(r2.code, 'ACK_BEYOND_SERVED', JSON.stringify(r2));
  assert.equal(seat(dir2, KEY).acked, 0);
});

test('#1576 PURE FOREIGN: a token from another lane is refused', () => {
  const dir = tmp();
  registerOff(dir);
  svc.registerFor(dir, 'registry:other.lane');
  card(dir, 1);
  const p = svc.serveFor(dir, 'registry:other.lane', { via: 'A' });
  p.commit();
  svc.serveFor(dir, KEY, { via: 'A' }).commit();
  const r = svc.ackFor(dir, KEY, p.ack_token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACK_FOREIGN_LANE');
  assert.equal(seat(dir, KEY).acked, 0);
  assert.equal(seat(dir, 'registry:other.lane').acked, 0);
});

test('#1576 PURE INVALID: a malformed token is refused, not ignored', () => {
  const dir = tmp();
  registerOff(dir);
  for (const t of ['', 'not-a-token', enc({ lane: KEY }), enc([1, 2])]) {
    const r = svc.ackFor(dir, KEY, t);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(t)}`);
    assert.equal(r.code, 'ACK_TOKEN_INVALID');
  }
});

test('#1576 PURE FENCE: a page re-served to another session cannot be acked with the first session\'s token', () => {
  const dir = tmp();
  registerOff(dir);
  card(dir, 1); card(dir, 2);
  const a = svc.serveFor(dir, KEY, { via: 'A' }); a.commit();
  const b = svc.serveFor(dir, KEY, { via: 'B' }); b.commit();
  const r = svc.ackFor(dir, KEY, a.ack_token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACK_FENCED');
  assert.equal(seat(dir, KEY).acked, 0);
  assert.equal(svc.ackFor(dir, KEY, b.ack_token).advanced, true, 'the session it was last served to acks normally');
});

test('#1576 PURE LOST ACK: no ack ⇒ the next pull re-serves the same page, from BOTH sources', () => {
  const dir = tmp();
  svc.registerFor(dir, KEY, { graphHead: 0, graphEpoch: 1 });
  card(dir, 1);
  const rows = [gRow(1, 2)];
  const first = svc.serveFor(dir, KEY, { via: 'A', graph: feed(rows, 0, 1, { epoch: 1 }) });
  first.commit();
  svc.noteInbound(dir, KEY, { via: 'A' });
  const second = svc.serveFor(dir, KEY, { via: 'A', graph: feed(rows, 0, 1, { epoch: 1 }) });
  assert.deepEqual(second.events.map(pk), first.events.map(pk));
  assert.deepEqual(second.events.map(pk), ['l1', 'g1']);
});

test('#1576 PURE ON: the explicit ack advances BOTH halves exactly to the served high-waters', () => {
  const dir = tmp();
  svc.registerFor(dir, KEY, { graphHead: 0, graphEpoch: 1 });
  card(dir, 1); card(dir, 2);
  const rows = [gRow(1, 1), gRow(2, 3), gRow(3, 4)];
  const p = svc.serveFor(dir, KEY, { via: 'A', limit: 3, graph: feed(rows, 0, 3, { epoch: 1 }) });
  assert.deepEqual(p.events.map(pk), ['l1', 'g1', 'l2']);
  const t = dec(p.ack_token);
  assert.equal(t.log, 2);
  assert.equal(t.graph.commitSeq, 1);
  p.commit();
  svc.noteInbound(dir, KEY, { via: 'A' });
  assert.equal(seat(dir, KEY).graph_acked, 0, 'inbound is not an ack for the executor half either');
  const r = svc.ackFor(dir, KEY, p.ack_token, { store: { epoch: 1, incarnation: null } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seat(dir, KEY).acked, 2);
  assert.equal(seat(dir, KEY).graph_acked, 1);
  const forged = enc({ ...t, graph: { ...t.graph, commitSeq: 3 } });
  assert.equal(svc.ackFor(dir, KEY, forged, { store: { epoch: 1, incarnation: null } }).code, 'ACK_BEYOND_SERVED', 'the executor half is clamped to its serve too');
  assert.equal(seat(dir, KEY).graph_acked, 1);
});

test('#1576 PURE EPOCH: a token from another executor epoch — or incarnation — is refused', () => {
  const dir = tmp();
  svc.registerFor(dir, KEY, { graphHead: 0, graphEpoch: 1, graphIncarnation: 'inc-a' });
  const rows = [gRow(1, 1)];
  const p = svc.serveFor(dir, KEY, { via: 'A', graph: feed(rows, 0, 1, { epoch: 1, incarnation: 'inc-a' }) });
  assert.deepEqual(p.events.map(pk), ['g1']);
  p.commit();
  const t = dec(p.ack_token);
  // the store moved on (a restore was promoted) — the token's epoch is not the store's
  let r = svc.ackFor(dir, KEY, p.ack_token, { store: { epoch: 2, incarnation: 'inc-b' } });
  assert.equal(r.code, 'ACK_EPOCH_STALE', JSON.stringify(r));
  // same epoch, another incarnation (two promoted restores of one backup)
  r = svc.ackFor(dir, KEY, p.ack_token, { store: { epoch: 1, incarnation: 'inc-z' } });
  assert.equal(r.code, 'ACK_EPOCH_STALE', JSON.stringify(r));
  // a token whose epoch was altered to match a store the lane was never served from
  r = svc.ackFor(dir, KEY, enc({ ...t, graph: { ...t.graph, epoch: 2 } }), { store: { epoch: 2, incarnation: 'inc-a' } });
  assert.equal(r.code, 'ACK_EPOCH_STALE', JSON.stringify(r));
  assert.equal(seat(dir, KEY).graph_acked, 0, 'nothing moved');
  // control: the right store acks
  assert.equal(svc.ackFor(dir, KEY, p.ack_token, { store: { epoch: 1, incarnation: 'inc-a' } }).advanced, true);
  assert.equal(seat(dir, KEY).graph_acked, 1);
});

test('#1576 PURE: a push write (#782 markServed) is not an ack and does not raise the pull\'s served ceiling', () => {
  const dir = tmp();
  registerOff(dir);
  card(dir, 1); card(dir, 2); card(dir, 3);
  const p = svc.serveFor(dir, KEY, { via: 'A', limit: 1 });
  p.commit();
  svc.markServed(dir, KEY, { seq: 3, via: 'A' });
  svc.noteInbound(dir, KEY, { via: 'A' });
  assert.equal(seat(dir, KEY).acked, 0, 'a resolved push write is a server-side "sent", not delivery');
  const forged = enc({ ...dec(p.ack_token), log: 3 });
  assert.equal(svc.ackFor(dir, KEY, forged).code, 'ACK_BEYOND_SERVED', 'the push high-water is not a pull serve');
});

// ── WIRE ─────────────────────────────────────────────────────────────────────

const TOK = { bob: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ack1576-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ack1576-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
async function boot({ dsid, unit }) {
  const executorUrl = `http://127.0.0.1:${await freePort()}`;
  const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack1576-events-'));
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: executorUrl, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_EVENT_LOG_DIR: eventDir,
    SCRUM_TRIAL_EXECUTOR_STORE: initStore(dsid), GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(),
    SCRUM_AUTH: 'required', ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  srv.eventDir = eventDir;
  return srv;
}
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` };
const call = async (srv, method, p, body) => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let laneN = 0;
async function lane(srv) {
  const id = `acklane${laneN++}.t`;
  const r = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return `registry:${id}`;
}
const pull = async (srv, identity, via = 'v1') => { const r = await call(srv, 'GET', `/api/cursors/pull?identity=${encodeURIComponent(identity)}&via=${via}`); await pause(); return r; };
const ack = (srv, identity, token) => call(srv, 'POST', '/api/cursors/ack', { identity, token });
const inbound = (srv, identity, via = 'v1') => call(srv, 'POST', '/api/cursors/inbound', { identity, via });
const ours = (events) => events.filter((e) => e.op !== 'refused');
const kindOps = (events) => ours(events).map((e) => `${e.entity.kind}:${e.op}`);

/** A pull whose client reads the first bytes, then destroys the socket mid-body (#1571's instrument). */
function diedPull(srv, identity, via) {
  const u = new URL(srv.baseUrl);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname, () => {
      s.write(`GET /api/cursors/pull?identity=${encodeURIComponent(identity)}&via=${via} HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${TOK.bob}\r\n\r\n`);
    });
    s.once('data', (chunk) => {
      s.pause();
      setTimeout(() => { s.destroy(); setTimeout(() => resolve(String(chunk).split('\r\n')[0]), 300); }, 200);
    });
    s.on('error', reject);
  });
}
function bigEvents(srv, tag) {
  const big = 'x'.repeat(3 * 1024 * 1024);
  for (let i = 0; i < 8; i++) appendEvent(srv.eventDir, { op: 'update', entity: { kind: 'card', id: `${tag}-${i}`, shortId: 9100 + i }, state: { title: 'big', description: big }, actor: 'bob' });
}

let ON, OFF;
before(async () => {
  if (SKIP) return;
  [ON, OFF] = await Promise.all([boot({ dsid: 'ack-on', unit: true }), boot({ dsid: 'ack-off', unit: false })]);
});
after(async () => { await ON?.stop(); await OFF?.stop(); });

for (const [label, get, unit] of [['ON', () => ON, true], ['OFF', () => OFF, false]]) {
  test(`#1576 WIRE ${label}: a pull that dies mid-body advances nothing (even after the lane's next inbound); the next pull re-serves; the ack lands exactly`, { skip: SKIP }, async () => {
    const srv = get();
    const id = await lane(srv);
    const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: `died-${label}`, body: 'x' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    bigEvents(srv, `died-${label}`);
    const before0 = loadCursors(srv.eventDir).seats[id];
    const status = await diedPull(srv, id, 'v1');
    assert.match(status, /^HTTP\/1\.1 200/, 'the control: the server handled the pull and started the response');
    await pause(100);
    await inbound(srv, id, 'v1');
    const after0 = loadCursors(srv.eventDir).seats[id];
    assert.equal(after0.acked, before0.acked, `log cursor did not move: ${JSON.stringify(after0)}`);
    assert.equal(after0.graph_acked, before0.graph_acked, `executor cursor did not move: ${JSON.stringify(after0)}`);
    const r = await pull(srv, id);
    assert.equal(r.status, 200);
    assert.deepEqual(kindOps(r.body.events), ['memory:create', ...Array(8).fill('card:update')], 're-served in full');
    assert.equal(typeof r.body.ack_token, 'string');
    const a = await ack(srv, id, r.body.ack_token);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.advanced, true);
    const s = loadCursors(srv.eventDir).seats[id];
    const logMax = Math.max(...r.body.events.filter((e) => Number.isInteger(e.seq)).map((e) => e.seq));
    assert.equal(s.acked, logMax, 'the log cursor is exactly the served high-water');
    if (unit) assert.equal(s.graph_acked, Math.max(...r.body.events.filter((e) => e.graph).map((e) => e.graph.commitSeq)));
    else assert.ok(!Object.keys(s).some((k) => k.startsWith('graph_')), `OFF keeps today's cursor shape: ${JSON.stringify(s)}`);
    const again = await ack(srv, id, r.body.ack_token);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.advanced, false);
    assert.equal(again.body.code, 'ALREADY_ACKED');
    assert.deepEqual(ours((await pull(srv, id)).body.events), []);
  });

  test(`#1576 WIRE ${label}: a lost ack re-serves; a foreign-lane token and a token past the serve are refused visibly`, { skip: SKIP }, async () => {
    const srv = get();
    const id = await lane(srv);
    const other = await lane(srv);
    assert.equal((await call(srv, 'POST', '/api/cards', { title: `lost-${label}`, column: 'backlog' })).status, 201);
    const r1 = await pull(srv, id);
    await inbound(srv, id);                       // the lane is alive — and that is not an ack
    const r2 = await pull(srv, id);
    assert.deepEqual(kindOps(r2.body.events), kindOps(r1.body.events), 'lost ack ⇒ the same page again');
    assert.ok(kindOps(r2.body.events).includes('card:create'));
    const otherPull = await pull(srv, other);
    const foreign = await ack(srv, id, otherPull.body.ack_token);
    assert.equal(foreign.status, 409, JSON.stringify(foreign.body));
    assert.equal(foreign.body.code, 'ACK_FOREIGN_LANE');
    const past = await ack(srv, id, enc({ ...dec(r2.body.ack_token), log: dec(r2.body.ack_token).log + 5 }));
    assert.equal(past.status, 409, JSON.stringify(past.body));
    assert.equal(past.body.code, 'ACK_BEYOND_SERVED');
    const bad = await ack(srv, id, 'garbage');
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'ACK_TOKEN_INVALID');
    assert.equal(loadCursors(srv.eventDir).seats[id].acked, (await call(srv, 'GET', '/api/cursors')).body.lanes.find((l) => l.identity === id).last_acked_seq);
    const before1 = loadCursors(srv.eventDir).seats[id];
    assert.ok(dec(r2.body.ack_token).log > before1.acked, 'nothing refused above moved the cursor');
    assert.equal((await ack(srv, id, r2.body.ack_token)).body.advanced, true, 'control: the real token acks');
  });
}

test('#1576 WIRE ON: a token naming another executor epoch / incarnation is refused against the live store', { skip: SKIP }, async () => {
  const id = await lane(ON);
  assert.equal((await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'epoch', body: 'x' })).status, 201);
  const r = await pull(ON, id);
  const t = dec(r.body.ack_token);
  assert.ok(t.graph, `the ON token carries the executor half: ${JSON.stringify(t)}`);
  const before = JSON.stringify(loadCursors(ON.eventDir).seats[id]);
  for (const graph of [{ ...t.graph, epoch: (t.graph.epoch ?? 1) + 1 }, { ...t.graph, incarnation: 'not-this-store' }]) {
    const a = await ack(ON, id, enc({ ...t, graph }));
    assert.equal(a.status, 409, JSON.stringify(a.body));
    assert.equal(a.body.code, 'ACK_EPOCH_STALE');
  }
  assert.equal(JSON.stringify(loadCursors(ON.eventDir).seats[id]), before, 'nothing moved');
  assert.equal((await ack(ON, id, r.body.ack_token)).body.advanced, true, 'control: the untampered token acks');
});

// ── MCP: replay_pull acks only after the MCP process holds the whole body ────

test('#1576 MCP replay_pull: the tool acks the page it received, so the cursor advances WITHOUT any further inbound call', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const s = await mcpSession(pair.mcp.mcpUrl);
    const reg = await s.rpc('scrum/session/register', { seatId: 'acker.t' });
    assert.ok(reg?.result?.ok, JSON.stringify(reg));
    const c = await fetch(`${pair.rest.baseUrl}/api/cards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'mcp-ack', column: 'backlog' }) });
    assert.equal(c.status, 201);
    const res = await s.callTool('replay_pull', {});
    const body = JSON.parse(res.result.content[0].text);
    assert.ok(body.events.some((e) => e.entity?.kind === 'card'), JSON.stringify(body));
    assert.equal(body.ack?.advanced, true, `the tool reports its ack: ${JSON.stringify(body.ack)}`);
    // read the cursor over REST — NOT through MCP, which would itself be an inbound call
    const rep = await (await fetch(`${pair.rest.baseUrl}/api/cursors`)).json();
    const laneRow = rep.lanes.find((l) => l.identity === 'registry:acker.t');
    const maxSeq = Math.max(...body.events.filter((e) => Number.isInteger(e.seq)).map((e) => e.seq));
    assert.equal(laneRow.last_acked_seq, maxSeq, JSON.stringify(laneRow));
    const res2 = await s.callTool('replay_pull', {});
    assert.deepEqual(JSON.parse(res2.result.content[0].text).events, []);
  } finally {
    await pair.stop();
  }
});
