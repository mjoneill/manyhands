/**
 * #1885 — THE TWO DECISION-MAKERS READ THE GRAPH. stale-claims and role-expiry were switched off under the graph conversations unit (#1574) because they
 * read the DOCUMENT's posts, and with the unit on an ordinary post lives only in the graph. #1885 (PO decision, Planning 2026-11-19, sprint #1977) re-enables
 * both by giving them the graph's posts. REAL executor, REAL REST server, REAL MCP adapter with tending on (the harness is decision-makers-disabled-r1's, copied).
 * Without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass (set GRAPH_EXECUTOR_PYTHON).
 *
 *   G1 RUNS ON THE GRAPH  unit on: the same fixture DM3 pins with the unit off now behaves the same with it on. The working holder's post exists ONLY in the
 *                graph and still counts (she is not asked); the silent holder is asked exactly once; role-expiry reports the expiring grant; neither row is
 *                disabled or errored; no startup line calls either engine disabled. RED before #1885: both rows answer `disabled`.
 *   G2 LAPSED BUT ACTING, FROM A GRAPH POST  unit on: a role that has just lapsed, and a graph-only post by its holder AFTER the lapse, makes a
 *                `lapsed-but-acting` row whose lastWriteAt is that post. This is the branch DM's header names as not covered.
 *   G3 CONTROL  unit on: the same lapsed role with NO post after the lapse makes no row (the row in G2 comes from the post, not from the lapse).
 *
 * NOT COVERED, by name: production's exact pass (SCRUM_GRAPH_CHECKS_SOURCE=executor with SCRUM_GRAPH_UNIT_LOGBORN=1). There the declarations come
 * from the log-born reader (liveSeatDecls, unchanged code) and the posts from the same graph read as here; a log-born world needs credentials on
 * every write (SCRUM_AUTH=required), which this harness does not carry. It is checked LIVE after deploy instead: the next digest's ⏸ line no longer
 * names either engine, and /api/checks shows both rows running (#1885 DONE WHEN 2). On the executor pass WITHOUT log-born, role-expiry is paused
 * with its own reason rather than build the in-process copy (#1645); checks-consumers-1643 K1 and no-replica-routes-1645 pin that.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer, startMcpServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'g1885-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const H = 3.6e6;
const GHOST = 'ghost|2026-09-01T00:00:00.000Z|2026-09-01T00:00:00.000Z|';
const TICKS_MS = 3500;   // MCP_WHISPER_TICK_MS is 400: at least eight ticks

const ROSTER_FILE = path.join(os.tmpdir(), `g1885-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' }, cy: { name: 'Cy', glyph: 'c', color: '#e0b060' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

after(() => fs.rmSync(ROSTER_FILE, { force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

/** Two held cards claimed three hours ago, and three document posts (the unit's migrated board starts with them). */
function fixture() {
  const card = (id, shortId, by) => ({
    id, shortId, title: `card ${shortId}`, description: '', type: 'task', column: 'in-progress', order: 0, assignees: [], labels: [], priority: null,
    createdAt: new Date(Date.now() - 24 * H).toISOString(), updatedAt: new Date(Date.now() - 3 * H).toISOString(), version: 1,
    relationships: { relatedTo: [], blockedBy: [] }, claimedBy: by, claimedAt: new Date(Date.now() - 3 * H).toISOString() });
  const docPosts = [1, 2, 3].map((i) => ({ id: `d${i}`, body: `doc ${i}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], postSeq: i, createdAt: '2026-10-04T12:00:00.000Z' }));
  return makeBoardFixture({ cards: [card('working', 10, 'bea'), card('silent', 20, 'cy')], conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: 4, nextShortId: 21 });
}

/** REST + MCP (tending on, 400 ms ticks) on one fixture. `unit` on = the flag and a real executor; off = neither. Then the SCENARIO: bea (the working holder)
 *  posts on her card, ada holds a role expiring in two hours. Returns what every row needs. */
async function scenario(body, { unit, roleInMs = 2 * H, extraEnv = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1885-'));
  const stateFile = path.join(dir, 'stale-claim-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ asked: { [GHOST]: '2026-09-01T00:10:00.000Z' } }, null, 2));
  let exec = null;
  const store = unit ? tmpStore('g1885-store-') : null;
  if (unit) exec = await startExecutor({ store, datasetId: DSID, create: true });
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, ...(unit ? { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}), ...extraEnv } });
  let mcp = null;
  try {
    // the scenario is written BEFORE the adapter starts, so its first tick already sees it
    const posted = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'bea', attachedTo: 'working', body: 'still on it, next observable is the next green run' });
    assert.equal(posted.status, 201, `the working holder's post on her card: ${posted.text}`);
    const minted = await api(rest.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master', definition: 'Establishes Scrum here and holds the cadence; asks, never asserts.', definedBy: 10 });
    assert.ok(minted.status === 200 || minted.status === 201, `the role is minted first: ${minted.status} ${minted.text}`);
    const declared = await api(rest.baseUrl, 'PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, role: 'scrum-master', expiresAt: new Date(Date.now() + roleInMs).toISOString() });
    assert.equal(declared.status, 200, `the role declaration: ${declared.text}`);
    // #1785 — tending is switched on through the surface the owner uses; the adapter reads it from REST, never from a file
    const tending = await api(rest.baseUrl, 'POST', '/api/tending-config', { enabled: true, quietAfterMinutes: 69 });
    assert.equal(tending.status, 200, `tending on: ${tending.text}`);
    mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_STALE_CLAIM_STATE_FILE: stateFile, MCP_WHISPER_TICK_MS: '400' } });
    const ctx = {
      post: async (author, attachedTo, body) => api(rest.baseUrl, 'POST', '/api/conversations', { author, attachedTo, body }),
      rest, mcp, stateFile, base: rest.baseUrl,
      checks: async () => (await api(rest.baseUrl, 'GET', '/api/checks?fresh=1')).body,
      standing: async (id) => ((await ctx.checks()).standing || []).find((s) => s.id === id),
      asks: async () => (await api(rest.baseUrl, 'GET', '/api/conversations')).body.filter((m) => m.author === 'board' && /^🕰 #/.test(m.body || '')),
      claim: async (id) => (await api(rest.baseUrl, 'GET', `/api/cards/${id}`)).body.claimedBy,
      linesNaming: () => rest.stderr().split('\n').filter((l) => /stale-claims|role-expiry/.test(l)),
    };
    return await body(ctx);
  } finally {
    if (mcp) await mcp.stop(); await rest.stop(); if (exec) await killExecutor(exec);
    // this file leaves nothing behind (the suite fails a NEW temp leak by name)
    fs.rmSync(dir, { recursive: true, force: true }); if (store) fs.rmSync(store, { recursive: true, force: true });
  }
}


test('G1 RUNS ON THE GRAPH — unit on: the working holder (graph-only post) is not asked, the silent holder is asked once, role-expiry reports, nothing disabled', { skip: SKIP }, async () => {
  await scenario(async (c) => {
    await sleep(TICKS_MS);
    const stale = await c.standing('stale-claims');
    assert.equal(stale.disabled, undefined, `stale-claims runs (no disabled key): ${JSON.stringify(stale)}`);
    assert.equal(stale.error, undefined, `and does not error: ${JSON.stringify(stale)}`);
    assert.deepEqual((stale.rows || []).map((r) => [r.shortId, r.holder]), [[20, 'cy']], `the silent holder's row, not the working holder's: ${JSON.stringify(stale)}`);
    const asks = await c.asks();
    assert.equal(asks.length, 1, `exactly ONE ask across the ticks: ${JSON.stringify(asks.map((m) => m.body))}`);
    assert.match(asks[0].body, /#20 «card 20» — cy, what happened\?/);
    assert.doesNotMatch(asks[0].body, /#10/, 'the working holder, whose post is only in the graph, is never asked');
    assert.equal(await c.claim('silent'), 'cy', 'and nothing is reclaimed');
    const role = await c.standing('role-expiry');
    assert.equal(role.disabled, undefined, `role-expiry runs (no disabled key): ${JSON.stringify(role)}`);
    assert.equal(role.error, undefined, `and does not error: ${JSON.stringify(role)}`);
    assert.deepEqual((role.rows || []).map((r) => [r.seat, r.state]), [['ada', 'expiring']], `role-expiry reports the expiring grant: ${JSON.stringify(role)}`);
    assert.deepEqual(c.linesNaming().filter((l) => /disabled/i.test(l)), [], `no line calls either engine disabled: ${JSON.stringify(c.linesNaming())}`);
  }, { unit: true });
});

test('G2 LAPSED BUT ACTING, FROM A GRAPH POST — unit on: a post by the holder after the lapse makes the row, with that post as lastWriteAt', { skip: SKIP }, async () => {
  await scenario(async (c) => {
    await sleep(3000);   // the grant (3 s) has lapsed
    const p = await c.post('ada', null, 'still running the cadence');
    assert.equal(p.status, 201, `the holder's post after the lapse: ${p.text}`);
    const role = await c.standing('role-expiry');
    assert.equal(role.disabled, undefined, `role-expiry runs: ${JSON.stringify(role)}`);
    const rows = (role.rows || []).filter((r) => r.seat === 'ada');
    assert.deepEqual(rows.map((r) => r.state), ['lapsed-but-acting'], `the lapsed holder who posted after the lapse: ${JSON.stringify(role)}`);
    assert.equal(Date.parse(rows[0].lastWriteAt), Date.parse(p.body.createdAt), `lastWriteAt is THAT post: ${JSON.stringify(rows[0])} vs ${p.body.createdAt}`);
  }, { unit: true, roleInMs: 2000 });
});

test('G3 CONTROL — unit on: the same lapsed grant with no post after the lapse makes no row', { skip: SKIP }, async () => {
  await scenario(async (c) => {
    await sleep(3000);
    const role = await c.standing('role-expiry');
    assert.equal(role.disabled, undefined, `role-expiry runs: ${JSON.stringify(role)}`);
    assert.equal(role.error, undefined, `and does not error: ${JSON.stringify(role)}`);
    assert.deepEqual((role.rows || []).filter((r) => r.seat === 'ada'), [], `no row: a lapse nobody acts on is not a row: ${JSON.stringify(role)}`);
  }, { unit: true, roleInMs: 2000 });
});

