/**
 * #1561 — the CHANGE FEED sees the log-born unit's writes.
 *
 * With SCRUM_GRAPH_UNIT_LOGBORN=1 memory / decision / seat-state writes go to the
 * graph executor and no longer append to the event log, so GET /api/changes (and
 * changes_since, and the resident's wake prompt, which read it) went blind to them.
 *
 *   PRESENCE   the six write kinds appear in /api/changes with the unit ON.
 *   PARITY     the rows have the flag-OFF row shape and values (ids/times normalised).
 *   APPLIED    only applied domain changes are rows: a PRECONDITION_FAILED receipt, a
 *              refused write and a replayed opId produce none.
 *   CURSORS    a forward cursor and a backward page token that track the event log and
 *              the executor SEPARATELY; walking pages yields every row exactly once.
 *   WAKE       one graph-native write appears in an actual assembled wake prompt.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { memoryReviseIntention, decisionCreateIntention } from '../core/logborn-unit.mjs';
import { fetchBoundedChanges, guestOnce } from '../core/guest-loop.mjs';
import { queryChangesFromLog } from '../core/changes-log-query.mjs';

const TOK = { bob: mintToken(), ada: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lbf-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (p) => ({ tokenHash: hashToken(p), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null });
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, v]) => [k, { credentials: [cred(v)] }])) }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lbf-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
async function boot({ dsid, unit }) {
  const executorUrl = `http://127.0.0.1:${await freePort()}`;
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: executorUrl, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_TRIAL_EXECUTOR_STORE: initStore(dsid), GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(),
    SCRUM_AUTH: 'required', ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  srv.executorUrl = executorUrl;
  return srv;
}
const H = (seat = 'bob') => ({ 'content-type': 'application/json', authorization: `Bearer ${TOK[seat]}` });
const call = async (srv, method, p, body, seat = 'bob') => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: H(seat), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const later = new Date(Date.now() + 7 * 86400_000).toISOString();
const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const LOGBORN_KINDS = new Set(['memory', 'decision', 'seat-state']);

let ON, OFF;
before(async () => {
  if (SKIP) return;
  [ON, OFF] = await Promise.all([boot({ dsid: 'lbf-on', unit: true }), boot({ dsid: 'lbf-off', unit: false })]);
});
after(async () => { await ON?.stop(); await OFF?.stop(); });

/** Every one of the six kinds the unit owns, once, plus a card (an event-log row). */
async function sixKinds(srv) {
  const since = new Date().toISOString();
  await pause(5);
  const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: 'feed', body: 'first' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  await pause();
  assert.equal((await call(srv, 'PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ' +more' })).status, 200);
  await pause();
  const dA = await call(srv, 'POST', '/api/decisions', { statement: 'A', decidedBy: 'bob', constrains: ['feed'], reopensIf: 'r', force: true });
  assert.equal(dA.status, 201, JSON.stringify(dA.body));
  await pause();
  const dB = await call(srv, 'POST', '/api/decisions', { statement: 'B', decidedBy: 'bob', constrains: ['feed'], reopensIf: 'r', force: true });
  await pause();
  assert.equal((await call(srv, 'POST', `/api/decisions/${dB.body.id}/relations`, { by: 'bob', supersedes: [dA.body.id] })).status, 201);
  await pause();
  assert.equal((await call(srv, 'PUT', '/api/seats/bob/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later })).status, 200);
  await pause();
  assert.equal((await call(srv, 'PUT', '/api/seats/bob/state', { mode: 'resting', acceptsRoutineWork: false, expiresAt: later })).status, 200);
  await pause();
  assert.equal((await call(srv, 'DELETE', '/api/seats/bob/state')).status, 200);
  return { since, memoryId: m.body.id, decisions: [dA.body.id, dB.body.id] };
}
const changes = async (srv, qs) => call(srv, 'GET', `/api/changes?${qs}`);

test('#1561 PRESENCE: with the unit ON, memory/decision/seat-state writes appear in /api/changes', { skip: SKIP }, async () => {
  const { since } = await sixKinds(ON);
  const r = await changes(ON, `since=${encodeURIComponent(since)}&history=true`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = r.body.changes.filter((c) => LOGBORN_KINDS.has(c.kind)).map((c) => `${c.kind}:${c.op}`);
  assert.deepEqual(got, [
    'memory:create', 'memory:update', 'decision:create', 'decision:create', 'decision:update',
    'seat-state:create', 'seat-state:update', 'seat-state:delete',
  ], `rows: ${JSON.stringify(r.body.changes)}`);
});

// ── PARITY: the rows a flag-OFF server writes to its log, with the unit ON ────
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function shapeOf(rows) {
  const map = new Map();
  const ph = (u) => { if (!map.has(u)) map.set(u, `<ID${map.size}>`); return map.get(u); };
  return rows.filter((c) => LOGBORN_KINDS.has(c.kind)).map(({ seq, at, graph, ...rest }) => (
    { ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' ? v.replace(UUID, ph) : v])), seq: typeof seq, at: typeof at }));
}
test('#1561 PARITY: the unit-ON rows carry the flag-OFF row fields and values (history and latest-per-entity)', { skip: SKIP }, async () => {
  const [on, off] = [await sixKinds(ON), await sixKinds(OFF)];
  for (const qs of ['history=true', 'history=false']) {
    const a = (await changes(ON, `since=${encodeURIComponent(on.since)}&${qs}`)).body.changes;
    const b = (await changes(OFF, `since=${encodeURIComponent(off.since)}&${qs}`)).body.changes;
    const offShape = shapeOf(b);
    assert.ok(offShape.length >= 3, `the flag-OFF control served the kinds (${qs}): ${JSON.stringify(b)}`);
    // seq: a receipt has no log seq — null, the one deliberate difference, and said here
    assert.deepEqual(shapeOf(a).map((r) => ({ ...r, seq: 'number' })), offShape, qs);
    for (const r of a.filter((c) => LOGBORN_KINDS.has(c.kind))) {
      const o = b.find((x) => x.kind === r.kind);
      const { graph, ...base } = r;
      assert.deepEqual(Object.keys(base), Object.keys(o), 'the same fields, in the same order');
      assert.equal(r.seq, null);
      assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the log\'s ISO form');
      assert.deepEqual(Object.keys(graph), ['opId', 'commitSeq', 'version']);
    }
  }
  // the memory rows say WHICH version the write minted
  const mem = (await changes(ON, `since=${encodeURIComponent(on.since)}&history=true`)).body.changes.filter((c) => c.kind === 'memory');
  assert.deepEqual(mem.map((c) => c.graph.version), [1, 2]);
});

// ── APPLIED only: a receipt is not a change ─────────────────────────────────
const graphRows = (rows) => rows.filter((c) => c.graph);
test('#1561 APPLIED: a PRECONDITION_FAILED receipt is NOT a feed row (its receipt exists: the control)', { skip: SKIP }, async () => {
  const since = new Date().toISOString();
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'pf', body: 'x' });
  const before = graphRows((await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes);
  assert.equal(before.length, 1);
  const client = createGraphClient({ baseUrl: ON.executorUrl });
  const intention = memoryReviseIntention({ actor: 'urn:ex:seat/bob', identity: { '@id': before[0].id, name: 'stale' }, newVersions: [], expectedRev: 999 });
  const r = await client.update(intention);
  assert.equal(r.outcome, 'PRECONDITION_FAILED', JSON.stringify(r));
  assert.equal((await client.reconcile(intention)).outcome, 'PRECONDITION_FAILED', 'the receipt is stored');
  const after = graphRows((await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes);
  assert.deepEqual(after.map((c) => c.graph.opId), before.map((c) => c.graph.opId), 'no row for the failed op');
  assert.equal((await call(ON, 'GET', `/api/memories/${m.body.id}`)).body.title, 'pf');
});

test('#1561 APPLIED: a REFUSED write is not a graph feed row', { skip: SKIP }, async () => {
  const since = new Date().toISOString();
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'rf', body: 'x' });
  const n0 = graphRows((await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes).length;
  assert.equal(n0, 1, 'the control: the applied create IS a row');
  assert.equal((await call(ON, 'PATCH', `/api/memories/${m.body.id}`, { body: 'nope', ifVersion: 7 })).status, 409);
  assert.equal((await call(ON, 'PUT', '/api/seats/bob/state', { seat: 'ada', mode: 'available', acceptsRoutineWork: true, expiresAt: later })).status, 403);
  assert.equal((await call(ON, 'POST', '/api/decisions/zzzzzzzz/relations', { by: 'bob', supersedes: ['yyyyyyyy'] })).status, 400);
  const all = (await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes;
  assert.equal(graphRows(all).length, n0, `rows: ${JSON.stringify(graphRows(all))}`);
  assert.ok(!all.some((c) => LOGBORN_KINDS.has(c.kind) && c.op !== 'create' && c.op !== 'refused'), 'no update/delete row from a refusal');
});

test('#1561 APPLIED: a REPLAYED opId is one row, not two', { skip: SKIP }, async () => {
  const since = new Date().toISOString();
  const client = createGraphClient({ baseUrl: ON.executorUrl });
  const uuid = '11111111-2222-4333-8444-555555555555';
  const intention = decisionCreateIntention({ actor: 'urn:ex:seat/bob', opId: `urn:ex:op/logborn/decision/${uuid}`, entity: {
    '@id': `https://scrumboard.local/decision/${uuid}`, identifier: uuid, 'scrum:statement': 'replayed', 'scrum:decidedBy': 'bob',
    'scrum:constrains': ['replay'], 'scrum:reopensIf': 'r', dateCreated: new Date().toISOString() } });
  assert.equal((await client.update(intention)).outcome, 'APPLIED');
  const once = graphRows((await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes);
  assert.equal(once.length, 1, 'the control: the first apply IS a row');
  assert.equal((await client.update(intention)).outcome, 'APPLIED', 'the replay answers from the stored receipt');
  const twice = graphRows((await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes);
  assert.deepEqual(twice, once);
  assert.equal(twice[0].id, `https://scrumboard.local/decision/${uuid}`);
});

test('#1561 APPLIED: a MIGRATION receipt is not a row (its record is already in the event log)', { skip: SKIP }, async () => {
  const since = new Date().toISOString();
  const client = createGraphClient({ baseUrl: ON.executorUrl });
  const uuid = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const entity = { '@id': `https://scrumboard.local/decision/${uuid}`, identifier: uuid, 'scrum:statement': 'migrated', 'scrum:decidedBy': 'bob',
    'scrum:constrains': ['mig'], 'scrum:reopensIf': 'r', dateCreated: new Date().toISOString() };
  assert.equal((await client.update(decisionCreateIntention({ actor: 'urn:ex:seat/bob', opId: `urn:ex:op/migrate-1561/decision/${uuid}`, entity }))).outcome, 'APPLIED');
  const list = (await call(ON, 'GET', '/api/decisions')).body;
  assert.ok((Array.isArray(list) ? list : list.decisions).some((d) => d.id === uuid), 'the control: the record IS in the store');
  assert.deepEqual(graphRows((await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body.changes), []);
});

// ── CURSORS on a real server: interleaved sources, forward resume, page walk ──
async function mixed(srv, n) {
  const since = new Date().toISOString();
  await pause(5);
  const want = [];
  for (let i = 0; i < n; i++) {
    const c = await call(srv, 'POST', '/api/cards', { title: `card ${i}`, column: 'backlog' }); assert.equal(c.status, 201, JSON.stringify(c.body)); want.push('card'); await pause(3);
    const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: `m${i}`, body: 'x' }); assert.equal(m.status, 201); want.push('memory'); await pause(3);
    const p = await call(srv, 'POST', '/api/conversations', { author: 'bob', body: `post ${i}` }); assert.ok(p.status < 300, JSON.stringify(p.body)); want.push('conversation'); await pause(3);
    if (i % 2 === 0) { assert.equal((await call(srv, 'POST', '/api/decisions', { statement: `d${i}`, decidedBy: 'bob', constrains: ['mx'], reopensIf: 'r', force: true })).status, 201); want.push('decision'); await pause(3); }
  }
  return { since, want };
}
const keyOf = (c) => `${c.kind}|${c.op}|${c.seq ?? 'g' + c.graph.commitSeq}`;

test('#1561 CURSORS: interleaved log and receipt rows come back in write order; each source keeps its own order', { skip: SKIP }, async () => {
  const { since, want } = await mixed(ON, 3);
  const all = (await changes(ON, `since=${encodeURIComponent(since)}&history=true&limitCards=500&limitPosts=500`)).body.changes;
  assert.deepEqual(all.map((c) => c.kind), want);
  const logSeqs = all.filter((c) => c.seq != null).map((c) => c.seq);
  const commits = all.filter((c) => c.graph).map((c) => c.graph.commitSeq);
  assert.deepEqual(logSeqs, [...logSeqs].sort((a, b) => a - b));
  assert.deepEqual(commits, [...commits].sort((a, b) => a - b));
});

test('#1561 CURSORS: walking nextBefore pages with a small limit yields exactly the full set, no duplicates', { skip: SKIP }, async () => {
  const { since } = await mixed(ON, 4);
  const q = `since=${encodeURIComponent(since)}&history=true`;
  const full = (await changes(ON, `${q}&limitCards=500&limitPosts=500`)).body.changes.map(keyOf);
  const seen = [];
  let page = (await changes(ON, `${q}&limitCards=2&limitPosts=1`)).body;
  let pages = 1;
  seen.push(...page.changes.map(keyOf));
  while (page.nextBefore) {
    page = (await changes(ON, `${q}&limitCards=2&limitPosts=1&before=${encodeURIComponent(page.nextBefore)}`)).body;
    assert.ok(Array.isArray(page.changes), JSON.stringify(page));
    seen.push(...page.changes.map(keyOf));
    assert.ok(++pages < 100, 'the walk ends');
  }
  assert.ok(pages >= 4, `small pages really paginated (${pages})`);
  assert.equal(new Set(seen).size, seen.length, 'no row twice');
  assert.deepEqual([...seen].sort(), [...full].sort(), 'every row once');
});

test('#1561 CURSORS: the forward cursor resumes with exactly the rows committed after it, from both sources', { skip: SKIP }, async () => {
  const since = new Date().toISOString();
  await mixed(ON, 1);
  const first = (await changes(ON, `since=${encodeURIComponent(since)}&history=true`)).body;
  assert.match(first.cursor, /^chg3\.\d+\.[0-9a-f]{32}\.1\.\d+$/, '#1575: the token names the executor epoch (#1577: and its incarnation)');
  const quiet = (await changes(ON, `since=${encodeURIComponent(first.cursor)}&history=true`)).body;
  assert.deepEqual(quiet.changes, [], 'nothing new, nothing served');
  assert.equal(quiet.cursor, first.cursor, 'and the cursor does not move');
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'after', body: 'x' });
  await call(ON, 'POST', '/api/cards', { title: 'after card', column: 'backlog' });
  const next = (await changes(ON, `since=${encodeURIComponent(first.cursor)}&history=true`)).body;
  assert.deepEqual(next.changes.map((c) => c.kind), ['memory', 'card']);
  assert.equal(next.changes[0].id, `https://scrumboard.local/memory/${m.body.id}`);
});

test('#1561 CURSORS: an old numeric `before` still pages, relative to that log row', { skip: SKIP }, async () => {
  const { since } = await mixed(ON, 2);
  const all = (await changes(ON, `since=${encodeURIComponent(since)}&history=true&limitCards=500&limitPosts=500`)).body.changes;
  const pivot = all.findLast((c) => c.kind === 'card');
  const r = (await changes(ON, `since=${encodeURIComponent(since)}&history=true&limitCards=500&limitPosts=500&before=${pivot.seq}`)).body.changes;
  assert.deepEqual(r.map(keyOf), all.slice(0, all.indexOf(pivot)).map(keyOf));
});

// ── WAKE: one graph-native write in an actual assembled wake prompt ──────────
test('#1561 WAKE: a memory written through the executor is in the resident\'s assembled wake prompt', { skip: SKIP }, async () => {
  const since = new Date(Date.now() - 1000).toISOString();
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'wake-visible', body: 'graph-native' });
  assert.equal(m.status, 201);
  // the runner's own fetch (scripts/guest-once.mjs → fetchBoundedChanges), against the real server
  const get = async (p) => { const r = await call(ON, 'GET', p); return { status: r.status, body: r.body }; };
  const rows = await fetchBoundedChanges(get, since);
  let prompt = null;
  const out = await guestOnce({
    agent: { seatKey: 'gizmo', residency: 'resident', model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' } },
    wake: { kind: 'mention', id: 'w1', author: 'ada', body: '@gizmo what changed?', createdAt: new Date().toISOString() },
    changes: () => rows,
    callModel: async (agent, messages) => { prompt = messages; return { text: 'NO_REPLY', toolCalls: [], stopReason: 'stop', usage: {} }; },
    post: async () => ({ id: 'p' }),
    ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lbf-ledger-')), 'l.jsonl'),
  });
  assert.ok(prompt, `the model was called (${JSON.stringify(out)})`);
  const text = prompt.map((x) => (typeof x.content === 'string' ? x.content : JSON.stringify(x.content))).join('\n');
  assert.match(text, new RegExp(`memory create https://scrumboard\\.local/memory/${m.body.id} \\(by bob\\)`), text);
});

// ── PURE: the merge and the cursors, with clocks chosen adversarially ─────────
const T = (s) => `2026-10-04T12:00:${String(s).padStart(2, '0')}.000Z`;
const logEv = (seq, s, kind = 'card') => ({ seq, recorded_at: T(s), actor: 'ada', op: 'update', entity: { kind, id: `${kind}-${seq}`, shortId: kind === 'card' ? seq : null }, state: {} });
const gRow = (commitSeq, s, kind = 'memory') => ({ kind, op: 'create', seq: null, id: `${kind}-g${commitSeq}`, shortId: null, title: null, column: null, by: 'bob', at: T(s), graph: { opId: `urn:ex:op/logborn/x/${commitSeq}`, commitSeq, version: 1 } });
const pk = (c) => (c.graph ? `g${c.graph.commitSeq}` : `l${c.seq}`);
const SINCE = '2026-10-04T00:00:00Z';

test('#1561 PURE: interleaved and EQUAL timestamps merge deterministically, log row first on a tie, neither source reordered', () => {
  const events = [logEv(1, 1), logEv(2, 3), logEv(3, 5), logEv(4, 5, 'conversation')];
  const graph = [gRow(1, 2), gRow(2, 5), gRow(3, 5), gRow(4, 6)];
  const r = queryChangesFromLog(events, { since: SINCE, history: true, graphRows: graph, graphThrough: 4 });
  assert.deepEqual(r.changes.map(pk), ['l1', 'g1', 'l2', 'l3', 'l4', 'g2', 'g3', 'g4']);
  const again = queryChangesFromLog(events, { since: SINCE, history: true, graphRows: [...graph].reverse(), graphThrough: 4 });
  assert.deepEqual(again.changes.map(pk), r.changes.map(pk), 'input order of the receipts does not matter');
  // a receipt whose clock ran BEHIND its commit order keeps its commit order
  const skew = queryChangesFromLog([], { since: SINCE, history: true, graphRows: [gRow(1, 9), gRow(2, 4)], graphThrough: 2 });
  assert.deepEqual(skew.changes.map(pk), ['g1', 'g2']);
});

test('#1561 PURE: a receipt committed AFTER a read but stamped BEFORE the newest row is skipped by time and delivered by the cursor', () => {
  const events = [logEv(1, 10)];
  const read1 = queryChangesFromLog(events, { since: SINCE, history: true, graphRows: [], graphThrough: 0, logThrough: 1 });
  // the executor evaluated NOW() at :05, but committed after read1 returned
  const late = [gRow(1, 5)];
  const byTime = queryChangesFromLog(events, { since: read1.newest, history: true, graphRows: late, graphThrough: 1, logThrough: 1 });
  assert.deepEqual(byTime.changes.map(pk), ['l1'], 'resuming by time: the late receipt is lost (and l1 is served twice)');
  const byCursor = queryChangesFromLog(events, { since: read1.cursor, history: true, graphRows: late, graphThrough: 1, logThrough: 1 });
  assert.deepEqual(byCursor.changes.map(pk), ['g1'], 'resuming by cursor: exactly the late receipt');
});

test('#1561 PURE: page walks over every limit pair yield the full set exactly once (equal stamps, both buckets, skewed receipt clock)', () => {
  const events = []; const graph = [];
  let seq = 0, cs = 0;
  for (let i = 0; i < 30; i++) {
    const s = Math.floor(i / 3);   // three rows share each second
    if (i % 3 === 0) events.push(logEv(++seq, s, 'conversation'));
    else if (i % 3 === 1) events.push(logEv(++seq, s));
    else graph.push(gRow(++cs, i % 7 === 0 ? 0 : s));   // some receipts stamped early
  }
  const all = queryChangesFromLog(events, { since: SINCE, history: true, graphRows: graph, graphThrough: cs, logThrough: seq, limit: { cards: 500, posts: 500 } }).changes.map(pk);
  assert.equal(all.length, 30);
  for (const cards of [1, 2, 3, 7]) for (const posts of [1, 2, 5]) {
    const seen = [];
    let before; let guard = 0;
    do {
      const r = queryChangesFromLog(events, { since: SINCE, history: true, graphRows: graph, graphThrough: cs, logThrough: seq, limit: { cards, posts }, before });
      seen.push(...r.changes.map(pk));
      before = r.nextBefore;
      assert.ok(++guard < 200);
    } while (before);
    assert.equal(new Set(seen).size, seen.length, `no duplicates (cards ${cards}, posts ${posts})`);
    assert.deepEqual([...seen].sort(), [...all].sort(), `every row (cards ${cards}, posts ${posts})`);
  }
});

test('#1561 PURE: with NO graph source the reply is today\'s, plus the two additive cursor fields', () => {
  const events = [logEv(1, 1), logEv(2, 2, 'conversation'), logEv(3, 3)];
  const r = queryChangesFromLog(events, { since: SINCE, history: true, limit: { cards: 1, posts: 1 } });
  assert.deepEqual(r.changes.map(pk), ['l2', 'l3']);
  assert.equal(r.cursor, 'chg2.3.1.0');   // #1575: <log>.<epoch>.<commitSeq>; no graph source → epoch 1
  assert.equal(r.nextBefore, 'chgb2.3.2.1.1');
  const p2 = queryChangesFromLog(events, { since: SINCE, history: true, limit: { cards: 1, posts: 1 }, before: r.nextBefore });
  assert.deepEqual(p2.changes.map(pk), ['l1']);
});

// ── WHO (a reviewer, 14:48Z): `by` is the seat that MADE the change, never the owner ──
// Under enforced auth the server fills `by` with the authenticated seat (#1343), so
// flag OFF credits bob for retagging ada's memory. fanout-decide (#717) reads `by`
// as "the newest attributed write per seat": crediting ada would hide bob's write.
test('#1561 WHO: bob retagging ada\'s memory is a row BY bob, ON as OFF (a decision create credits decidedBy, ON as OFF)', { skip: SKIP }, async () => {
  const byOf = async (srv) => {
    const since = new Date().toISOString();
    await pause(5);
    const m = await call(srv, 'POST', '/api/memories', { owner: 'ada', title: 'ada-own', body: 'x' }, 'ada');
    assert.equal(m.status, 201, JSON.stringify(m.body));
    await pause();
    assert.equal((await call(srv, 'PATCH', `/api/memories/${m.body.id}`, { tags: ['retagged'] }, 'bob')).status, 200);
    await pause();
    const d = await call(srv, 'POST', '/api/decisions', { statement: 'for ada', decidedBy: 'ada', constrains: ['who'], reopensIf: 'r', force: true }, 'bob');
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const r = await changes(srv, `since=${encodeURIComponent(since)}&history=true`);
    return r.body.changes.filter((c) => c.kind === 'memory' || c.kind === 'decision').map((c) => `${c.kind}:${c.op}:${c.by}`);
  };
  const off = await byOf(OFF);
  const on = await byOf(ON);
  // measured 14:50Z: flag OFF credits a decision CREATE to its decidedBy, not the writer (existing behaviour, not changed here)
  assert.deepEqual(off, ['memory:create:ada', 'memory:update:bob', 'decision:create:ada'], 'control: what flag OFF records');
  assert.deepEqual(on, off, 'flag ON credits the same seats');
});
