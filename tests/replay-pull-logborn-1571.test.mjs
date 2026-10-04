/**
 * #1571 — replay_pull sees the log-born unit's writes.
 *
 * With SCRUM_GRAPH_UNIT_LOGBORN=1 memory / decision / seat-state writes go to the
 * graph executor and never reach the event log, so a lane's replay cursor (which
 * walked the LOG only) was blind to them. The change feed solved the same
 * two-source problem in #1561 (core/logborn-feed.mjs + core/changes-log-query.mjs);
 * this file holds replay_pull to the same rules:
 *
 *   BOTH      a lane's cursor tracks the acked log seq AND the acked executor
 *             commitSeq, separately — never by time.
 *   #624      commit() is the only thing that records a serve, and only an explicit
 *             ack (#1576 ackFor) advances either half: a response that is never acked
 *             re-serves the same rows from BOTH sources.
 *   PAGES     an interleaving of log and executor rows, pulled limit-at-a-time, is
 *             served exactly once each.
 *   APPLIED   PRECONDITION_FAILED / replayed ops are not rows (logborn-feed's rule).
 *   VISIBLE   an unreadable executor fails the pull — never a log-only answer —
 *             and moves neither cursor.
 *   OFF       with the flag off, the reply and the stored cursor are byte-for-byte
 *             today's shape.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { memoryReviseIntention, decisionCreateIntention } from '../core/logborn-unit.mjs';
import { appendEvent } from '../core/event-log.mjs';
import { loadCursors, saveCursors } from '../core/cursors.mjs';
import { registerFor, serveFor, noteInbound, ackFor, envelopeFor, discardPendingServes, ACK_FENCED } from '../core/cursor-service.mjs';

// ── PURE: the cursor service over a real event log and fabricated executor rows ──

let n = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `rp1571-${process.pid}-${n++}-`));
const T = (s) => `2026-10-04T12:00:${String(s).padStart(2, '0')}.000Z`;
const card = (dir, i, s) => appendEvent(dir, { op: 'update', entity: { kind: 'card', id: `card-${i}`, shortId: i }, state: { title: `c${i}` }, actor: 'ada' }, { now: T(s) });
const gRow = (commitSeq, s, kind = 'memory') => ({
  kind, op: 'create', seq: null, id: `${kind}-g${commitSeq}`, shortId: null, title: null, column: null, by: 'bob', at: T(s),
  graph: { opId: `urn:ex:op/logborn/${kind}/${commitSeq}`, commitSeq, version: 1 },
});
/** What the server passes: the feed rows past the lane's graph cursor, and the high-water. */
const feedPast = (rows, after, through) => ({ rows: rows.filter((r) => r.graph.commitSeq > after), through });
const graphAcked = (dir, key) => loadCursors(dir).seats[key]?.graph_acked ?? 0;
const pk = (e) => (e.graph ? `g${e.graph.commitSeq}` : `l${e.seq}`);
const KEY = 'registry:lane.t';

test('#1571 PURE OFF: no graph source → the reply, envelope and stored cursor are today\'s shape', () => {
  const dir = tmp();
  card(dir, 1, 1);
  registerFor(dir, KEY);
  card(dir, 2, 2);
  const p = serveFor(dir, KEY);
  assert.deepEqual(p.events.map(pk), ['l2']);
  assert.deepEqual(Object.keys(p.envelope).sort(), ['dedup', 'delivery_identity', 'head_seq', 'known', 'lag',
    'last_acked_seq', 'last_served_seq', 'oldest_unserved_at', 'oldest_unserved_state'].sort());
  assert.equal(p.commit(), 2, 'commit returns the log seq it recorded, as before');
  ackFor(dir, KEY, p.ack_token);   // #1576 — the explicit ack (was: the next inbound call)
  const seat = loadCursors(dir).seats[KEY];
  assert.deepEqual(Object.keys(seat).sort(), ['acked', 'last_inbound_at', 'last_inbound_seq', 'registered_at', 'served'].sort());
  assert.equal(seat.acked, 2);
});

test('#1571 PURE ON: rows from both sources, merged; commit + ack advances BOTH; the next pull is empty', () => {
  const dir = tmp();
  registerFor(dir, KEY, { graphHead: 0 });
  card(dir, 1, 1);
  const graph = [gRow(1, 2), gRow(2, 3, 'decision')];
  card(dir, 2, 4);
  const p = serveFor(dir, KEY, { graph: feedPast(graph, 0, 2) });
  assert.deepEqual(p.events.map(pk), ['l1', 'g1', 'g2', 'l2']);
  const g = p.events[1];
  assert.deepEqual(g, { seq: null, recorded_at: T(2), occurred_at: T(2), actor: 'bob', op: 'create',
    entity: { kind: 'memory', id: 'memory-g1', shortId: null }, state: null, graph: graph[0].graph }, 'event-shaped');
  assert.equal(p.envelope.lag, 4, 'two log events + two executor rows');
  assert.equal(p.envelope.log_lag, 2);
  assert.deepEqual(p.envelope.graph, { head_commit_seq: 2, last_acked_commit_seq: 0, last_served_commit_seq: null, lag: 2 });
  p.commit();
  assert.equal(ackFor(dir, KEY, p.ack_token).advanced, true);   // #1576 — explicit
  const seat = loadCursors(dir).seats[KEY];
  assert.equal(seat.acked, 2);
  assert.equal(seat.graph_acked, 2);
  const again = serveFor(dir, KEY, { graph: feedPast(graph, graphAcked(dir, KEY), 2) });
  assert.deepEqual(again.events, []);
  assert.equal(again.envelope.lag, 0);
  assert.equal(again.envelope.oldest_unserved_state, 'none');
});

test('#1571 PURE #624: a response that dies before commit re-serves the same rows from BOTH sources', () => {
  const dir = tmp();
  registerFor(dir, KEY, { graphHead: 0 });
  card(dir, 1, 1);
  const graph = [gRow(1, 2)];
  const first = serveFor(dir, KEY, { graph: feedPast(graph, 0, 1) });
  assert.deepEqual(first.events.map(pk), ['l1', 'g1']);
  // no commit — the response died in flight. The lane calls again.
  noteInbound(dir, KEY, { via: null });
  const seat = loadCursors(dir).seats[KEY];
  assert.equal(seat.acked, 0, 'the log cursor did not move');
  assert.equal(seat.graph_acked ?? 0, 0, 'the executor cursor did not move');
  const second = serveFor(dir, KEY, { graph: feedPast(graph, graphAcked(dir, KEY), 1) });
  assert.deepEqual(second.events.map(pk), ['l1', 'g1']);
});

test('#1571 PURE PAGES: an interleaving pulled limit-at-a-time is served exactly once each, for every limit', () => {
  for (const limit of [1, 2, 3, 5]) {
    const dir = tmp();
    registerFor(dir, KEY, { graphHead: 0 });
    const graph = [];
    for (let i = 0; i < 6; i++) { card(dir, i, 2 * i); graph.push(gRow(i + 1, 2 * i + 1)); }
    graph.push(gRow(7, 0));   // a receipt whose clock ran behind: it keeps its commit order
    const seen = [];
    for (let guard = 0; guard < 50; guard++) {
      const p = serveFor(dir, KEY, { limit, graph: feedPast(graph, graphAcked(dir, KEY), 7) });
      if (!p.events.length) break;
      assert.ok(p.events.length <= limit, `limit ${limit} respected`);
      seen.push(...p.events.map(pk));
      p.commit();
      ackFor(dir, KEY, p.ack_token);   // #1576 — explicit
    }
    assert.equal(new Set(seen).size, seen.length, `no row twice (limit ${limit}): ${seen}`);
    assert.deepEqual([...seen].sort(), ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'], `every row (limit ${limit})`);
  }
});

test('#1571 PURE FENCE: a page re-served to another session cannot be acked by the first — BOTH halves (#1576: explicit acks)', () => {
  const dir = tmp();
  registerFor(dir, KEY, { graphHead: 0 });
  card(dir, 1, 1);
  const graph = [gRow(1, 2)];
  const a = serveFor(dir, KEY, { via: 'A', graph: feedPast(graph, 0, 1) }); a.commit();
  serveFor(dir, KEY, { via: 'B', graph: feedPast(graph, 0, 1) }).commit();
  const r = ackFor(dir, KEY, a.ack_token);
  assert.equal(r.code, ACK_FENCED);
  assert.equal(loadCursors(dir).seats[KEY].acked, 0);
  assert.equal(graphAcked(dir, KEY), 0);
  const again = serveFor(dir, KEY, { via: 'B', graph: feedPast(graph, graphAcked(dir, KEY), 1) });
  assert.deepEqual(again.events.map(pk), ['l1', 'g1']);
});

test('#1571 PURE: a fenced range that is ONLY executor rows is still fenced', () => {
  const dir = tmp();
  registerFor(dir, KEY, { graphHead: 0 });
  const graph = [gRow(1, 2)];
  const a = serveFor(dir, KEY, { via: 'A', graph: feedPast(graph, 0, 1) }); a.commit();
  serveFor(dir, KEY, { via: 'B', graph: feedPast(graph, 0, 1) }).commit();
  assert.equal(ackFor(dir, KEY, a.ack_token).code, ACK_FENCED);
  assert.equal(graphAcked(dir, KEY), 0);
});

test('#1571 PURE: a boot discards pending serves on both halves; acked is untouched', () => {
  const dir = tmp();
  registerFor(dir, KEY, { graphHead: 0 });
  serveFor(dir, KEY, { via: 'A', graph: feedPast([gRow(1, 2)], 0, 1) }).commit();
  assert.equal(loadCursors(dir).seats[KEY].graph_served, 1);
  assert.equal(discardPendingServes(dir), 1);
  assert.equal(loadCursors(dir).seats[KEY].graph_served ?? null, null);
});

test('#1571 PURE RETENTION: the log side still refuses CURSOR_TOO_OLD with executor rows pending; commit is a no-op', () => {
  const dir = tmp();
  card(dir, 1, 1); card(dir, 2, 2);
  registerFor(dir, KEY, { graphHead: 0 });
  const st = loadCursors(dir); st.seats[KEY].acked = 0; saveCursors(dir, st);
  // trim: drop the first event by rewriting the only segment without it
  const seg = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  const lines = fs.readFileSync(path.join(dir, seg), 'utf8').trim().split('\n');
  fs.writeFileSync(path.join(dir, seg), `${lines.slice(1).join('\n')}\n`);
  const p = serveFor(dir, KEY, { graph: feedPast([gRow(1, 3)], 0, 1) });
  assert.equal(p.refused, 'CURSOR_TOO_OLD');
  assert.deepEqual(p.events, []);
  assert.equal(p.commit(), null);
  assert.equal(loadCursors(dir).seats[KEY].graph_served ?? null, null);
});

test('#1571 PURE REGISTER: a fresh lane starts at the executor head; a known lane keeps both cursors; a legacy lane owes from 0', () => {
  const dir = tmp();
  card(dir, 1, 1);
  const fresh = registerFor(dir, KEY, { graphHead: 9 });
  assert.equal(fresh.fresh, true);
  assert.equal(loadCursors(dir).seats[KEY].graph_acked, 9);
  registerFor(dir, KEY, { graphHead: 40 });
  assert.equal(loadCursors(dir).seats[KEY].graph_acked, 9, 'a known lane keeps its executor cursor');
  // a lane registered before the flag: log cursor kept, executor cursor ABSENT → owed every live row
  registerFor(dir, 'registry:legacy');
  assert.equal(loadCursors(dir).seats['registry:legacy'].graph_acked, undefined);
  registerFor(dir, 'registry:legacy', { graphHead: 40 });
  assert.equal(loadCursors(dir).seats['registry:legacy'].graph_acked, undefined, 'never adopt head over rows it is owed');
  const p = serveFor(dir, 'registry:legacy', { graph: feedPast([gRow(3, 5)], 0, 40) });
  assert.deepEqual(p.events.map(pk), ['g3']);
  // a lane adopted on its first inbound call starts at both heads
  noteInbound(dir, 'bearer:new', { graphHead: 12 });
  assert.equal(loadCursors(dir).seats['bearer:new'].graph_acked, 12);
});

test('#1571 PURE ENVELOPE: oldest_unserved_at is the older of the two sources\' oldest unserved row', () => {
  const dir = tmp();
  registerFor(dir, KEY, { graphHead: 0 });
  card(dir, 1, 7);
  const env = envelopeFor(dir, KEY, { graph: feedPast([gRow(1, 3)], 0, 1) });
  assert.equal(env.oldest_unserved_at, T(3));
  assert.equal(env.oldest_unserved_state, 'known');
});

// ── WIRE: a real server with a real executor ─────────────────────────────────

const TOK = { bob: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp1571-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'rp1571-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
async function boot({ dsid, unit }) {
  const executorUrl = `http://127.0.0.1:${await freePort()}`;
  const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp1571-events-'));
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: executorUrl, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_EVENT_LOG_DIR: eventDir,
    SCRUM_TRIAL_EXECUTOR_STORE: initStore(dsid), GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(),
    SCRUM_AUTH: 'required', ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  await executorUp(srv);
  srv.executorUrl = executorUrl;
  srv.eventDir = eventDir;
  return srv;
}
async function executorUp(srv) {
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('executor never came up');
}
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` };
const call = async (srv, method, p, body) => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const later = new Date(Date.now() + 7 * 86400_000).toISOString();
const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
let laneN = 0;
async function lane(srv) {
  const id = `lane${laneN++}.t`;
  const r = await call(srv, 'POST', '/api/cursors/register', { registrySeatId: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return `registry:${id}`;
}
// #1576 — the ack is EXPLICIT: a pull answers an `ack_token`, and only POST /api/cursors/ack
// with it advances the lane. `ack()` acks the lane's last pull; with no token held (no pull
// since, or the last one died / was refused) it is just an inbound call — which acks nothing.
const tokens = new Map();
async function pull(srv, identity, { via = 'v1', limit } = {}) {
  const q = new URLSearchParams({ identity, via, ...(limit ? { limit: String(limit) } : {}) });
  const r = await call(srv, 'GET', `/api/cursors/pull?${q}`);
  tokens.set(`${srv.baseUrl}|${identity}`, r.body?.ack_token ?? null);
  await pause(30);
  return r;
}
async function ack(srv, identity, via = 'v1') {
  const k = `${srv.baseUrl}|${identity}`;
  const token = tokens.get(k);
  tokens.delete(k);
  if (!token) return call(srv, 'POST', '/api/cursors/inbound', { identity, via });
  const r = await call(srv, 'POST', '/api/cursors/ack', { identity, token });
  assert.equal(r.status, 200, `ack: ${JSON.stringify(r.body)}`);
  return r;
}
const ours = (events) => events.filter((e) => e.op !== 'refused');
const kindOps = (events) => ours(events).map((e) => `${e.entity.kind}:${e.op}`);

let ON, OFF;
before(async () => {
  if (SKIP) return;
  [ON, OFF] = await Promise.all([boot({ dsid: 'rp-on', unit: true }), boot({ dsid: 'rp-off', unit: false })]);
});
after(async () => { await ON?.stop(); await OFF?.stop(); });

async function threeKinds(srv) {
  const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: 'rp', body: 'x' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  await pause();
  const d = await call(srv, 'POST', '/api/decisions', { statement: 'rp', decidedBy: 'bob', constrains: ['rp'], reopensIf: 'r', force: true });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  await pause();
  assert.equal((await call(srv, 'PUT', '/api/seats/bob/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later })).status, 200);
  return { memoryId: m.body.id };
}

test('#1571 WIRE ON: memory + decision + seat declaration are served; after commit and ack the next pull has nothing new', { skip: SKIP }, async () => {
  const id = await lane(ON);
  const { memoryId } = await threeKinds(ON);
  const r = await pull(ON, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(kindOps(r.body.events), ['memory:create', 'decision:create', 'seat-state:create'], JSON.stringify(r.body.events));
  const mem = r.body.events.find((e) => e.entity.kind === 'memory');
  assert.equal(mem.entity.id, `https://scrumboard.local/memory/${memoryId}`);
  assert.equal(mem.seq, null);
  assert.match(mem.graph.opId, /^urn:ex:op\/logborn\/memory\//);
  assert.equal(r.body.envelope.graph.lag, 3);
  await ack(ON, id);
  const seat = loadCursors(ON.eventDir).seats[id];
  assert.equal(seat.graph_acked, Math.max(...r.body.events.filter((e) => e.graph).map((e) => e.graph.commitSeq)));
  const again = await pull(ON, id);
  assert.deepEqual(ours(again.body.events), [], JSON.stringify(again.body));
  assert.equal(again.body.envelope.graph.lag, 0);
});

/**
 * A pull whose response DIES on the wire: the client takes the first bytes, stops
 * reading, and goes away before the body is through. The body is made bigger than the
 * loopback socket buffers (a few large log events), so the server's write cannot have
 * finished when the socket closes — `res.end`'s callback never fires, and a server
 * that committed before writing is caught. (A client that closes BEFORE the server
 * handles the request does not exercise this: the handler never runs.)
 */
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
// FLIPPED by #1576 (was a TODO): measured on Node 22.23.1, a response whose client read
// 128 KB of a 24 MB body and then destroyed its socket still gets `res.end`'s callback —
// no error, writableFinished: true — so "commit in the end callback, ack on the next
// inbound" did not hold the #624 guard on the wire for EITHER source. #1576 makes the ack
// EXPLICIT: the dead response is never acked, so the next inbound moves nothing and the
// next pull re-serves. (Flag-OFF twin: tests/cursor-explicit-ack-1576.test.mjs.)
test('#1571 WIRE ON #624: a pull whose response dies on the wire re-serves the same rows from both sources', { skip: SKIP }, async () => {
  const id = await lane(ON);
  await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'rp-624', body: 'x' });
  const big = 'x'.repeat(3 * 1024 * 1024);
  for (let i = 0; i < 8; i++) appendEvent(ON.eventDir, { op: 'update', entity: { kind: 'card', id: `big-${i}`, shortId: 9000 + i }, state: { title: 'big', description: big }, actor: 'bob' });
  const before = loadCursors(ON.eventDir).seats[id];
  const status = await diedPull(ON, id, 'v1');
  assert.match(status, /^HTTP\/1\.1 200/, 'the control: the server DID handle the pull and start the response');
  await ack(ON, id);
  const seat = loadCursors(ON.eventDir).seats[id];
  assert.equal(seat.acked, before.acked, `the log cursor did not move: ${JSON.stringify(seat)}`);
  assert.equal(seat.graph_acked, before.graph_acked, `the executor cursor did not move: ${JSON.stringify(seat)}`);
  const r = await pull(ON, id);
  assert.deepEqual(kindOps(r.body.events), ['memory:create', ...Array(8).fill('card:update')]);
  await ack(ON, id);   // leave the lane current, so the big events are not anyone else's
});

test('#1571 WIRE ON PAGES: interleaved card (log) and memory (executor) writes are served exactly once across limit-sized pages', { skip: SKIP }, async () => {
  const id = await lane(ON);
  const want = [];
  for (let i = 0; i < 4; i++) {
    assert.equal((await call(ON, 'POST', '/api/cards', { title: `pg ${i}`, column: 'backlog' })).status, 201); want.push('card'); await pause(3);
    assert.equal((await call(ON, 'POST', '/api/memories', { owner: 'bob', title: `pg${i}`, body: 'x' })).status, 201); want.push('memory'); await pause(3);
  }
  const seen = [];
  let pages = 0;
  for (;;) {
    const r = await pull(ON, id, { limit: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (!r.body.events.length) break;
    assert.ok(r.body.events.length <= 3);
    seen.push(...ours(r.body.events));
    await ack(ON, id);
    assert.ok(++pages < 20);
  }
  assert.ok(pages >= 3, `really paginated (${pages})`);
  const keys = seen.map((e) => (e.graph ? `g${e.graph.commitSeq}` : `l${e.seq}`));
  assert.equal(new Set(keys).size, keys.length, `no row twice: ${keys}`);
  assert.deepEqual(seen.map((e) => e.entity.kind), want, 'every row, in write order');
});

test('#1571 WIRE ON APPLIED: PRECONDITION_FAILED and a replayed opId produce no rows (the first apply is the control)', { skip: SKIP }, async () => {
  const id = await lane(ON);
  const client = createGraphClient({ baseUrl: ON.executorUrl });
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'pf', body: 'x' });
  const pf = memoryReviseIntention({ actor: 'urn:ex:seat/bob', identity: { '@id': `https://scrumboard.local/memory/${m.body.id}`, name: 'stale' }, newVersions: [], expectedRev: 999 });
  assert.equal((await client.update(pf)).outcome, 'PRECONDITION_FAILED');
  const uuid = '22222222-3333-4444-8555-666666666666';
  const intention = decisionCreateIntention({ actor: 'urn:ex:seat/bob', opId: `urn:ex:op/logborn/decision/${uuid}`, entity: {
    '@id': `https://scrumboard.local/decision/${uuid}`, identifier: uuid, 'scrum:statement': 'replayed', 'scrum:decidedBy': 'bob',
    'scrum:constrains': ['replay'], 'scrum:reopensIf': 'r', dateCreated: new Date().toISOString() } });
  assert.equal((await client.update(intention)).outcome, 'APPLIED');
  assert.equal((await client.update(intention)).outcome, 'APPLIED', 'the replay answers from the stored receipt');
  const r = await pull(ON, id);
  assert.deepEqual(kindOps(r.body.events), ['memory:create', 'decision:create'], JSON.stringify(r.body.events));
});

test('#1571 WIRE ON VISIBLE: an unreadable executor fails the pull (503) and moves neither cursor', { skip: SKIP }, async () => {
  const id = await lane(ON);
  await call(ON, 'POST', '/api/cards', { title: 'rp-down', column: 'backlog' });
  await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'rp-down', body: 'x' });
  const before = JSON.stringify(loadCursors(ON.eventDir).seats[id]);
  assert.equal((await call(ON, 'POST', '/api/trial/executor/stop')).status < 300, true);
  try {
    const r = await pull(ON, id);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'GRAPH_EXECUTOR_UNAVAILABLE');
    assert.ok(!Array.isArray(r.body.events), 'no log-only answer');
    assert.equal(JSON.stringify(loadCursors(ON.eventDir).seats[id]), before, 'cursor state untouched');
  } finally {
    await call(ON, 'POST', '/api/trial/executor/start');
    await executorUp(ON);
  }
  await ack(ON, id);
  const r = await pull(ON, id);
  assert.deepEqual(kindOps(r.body.events), ['card:create', 'memory:create'], 'and both rows are still owed');
});

test('#1571 WIRE OFF twin: log events only, no graph fields in the reply or the stored cursor', { skip: SKIP }, async () => {
  const id = await lane(OFF);
  await threeKinds(OFF);
  const r = await pull(OFF, id);
  assert.equal(r.status, 200);
  assert.deepEqual(kindOps(r.body.events), ['memory:create', 'decision:create', 'seat-state:create']);
  assert.ok(r.body.events.every((e) => Number.isInteger(e.seq) && !('graph' in e)));
  assert.ok(!('graph' in r.body.envelope) && !('log_lag' in r.body.envelope), JSON.stringify(r.body.envelope));
  await ack(OFF, id);
  const seat = loadCursors(OFF.eventDir).seats[id];
  assert.ok(!Object.keys(seat).some((k) => k.startsWith('graph_')), JSON.stringify(seat));
  assert.deepEqual(ours((await pull(OFF, id)).body.events), []);
});
