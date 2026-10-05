/**
 * DECISION-MAKERS UNDER THE UNIT (#1574, rubric #1602): the stale-claim inquiry and the role-expiry check are DISABLED, VISIBLY, while the graph conversations
 * unit is on. Pre-registered by the separate test author BEFORE the disable is built. Copy unchanged into tests/. REAL executor, REAL REST server, REAL MCP
 * adapter with tending on; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: both engines read the DOCUMENT's posts (`data.conversations`), and with the unit on an ordinary post lives only in the graph. stale-claims would ask a
 * holder who IS working ("what happened?") because their post on the card is invisible to it; role-expiry would report a seat as not acting on a lapsed grant
 * when it is. Both are decisions about people, taken from a window that is missing every new post. Until they read the graph (a later slice) they must not
 * run under the unit, and the disabled state must be SAYABLE, never an empty "nothing is stale".
 *
 * THE SURFACE (read from the source at 3d5a3d6, not from the plan): both are STANDING CHECKS served in `/api/checks` `standing[]` with `id: 'stale-claims'`
 * and `id: 'role-expiry'` (server.js STANDING_CHECKS). `/api/misses` is the retrieval-need log and carries neither; the plan's wording named it, the code does
 * not. The stale-claim ask is the MCP adapter's checks tick (mcp-server.mjs `staleClaimAskOnce`), which reads the `stale-claims` row from the same payload,
 * posts one commons line per silence episode as `board`, and keeps a dedupe memory in a state file (`SCRUM_STALE_CLAIM_STATE_FILE`).
 *
 * THREE ROWS (the three conditions posted 19:12Z; each is a behaviour at the surface above, not a mechanism):
 *   DM1 VISIBLE  with the unit on, each of the two standing rows says `disabled: true` with a reason that names #1574 and the graph, and is NOT shaped like a
 *                clean check (an empty `rows` array is exactly what "nothing is stale" looks like). The server logs ONE startup line naming both. The other
 *                standing checks still run (the disable is not blanket).
 *   DM2 INERT AND QUIET  with the unit on, a graph-only seat that is working on its card and a truly silent holder: NO ask is posted (for either), no claim is
 *                touched, the adapter logs nothing about #455, the ask's dedupe memory is not rewritten (a disabled engine must forget nothing, or re-enabling
 *                asks about every old episode again), neither row carries an `error` (a decision is not an instrument failure), and the startup line is still
 *                the ONLY line naming either engine after several ticks (no per-tick noise).
 *   DM3 UNCHANGED  with the unit OFF and no executor, the SAME fixture behaves as today: the silent holder's row and exactly ONE ask, the working holder not
 *                asked, a role-expiry row, no `disabled` key, no startup line, and the dedupe memory IS rewritten (a ghost entry is pruned). DM3 is also the
 *                control for DM2: the same ticks, the same wait, with the engine RUNNING, produce the ask and the rewrite that DM2 pins as absent.
 *
 * NOT COVERED, by name: role-expiry's `lapsed-but-acting` branch (a lapsed grant needs a past expiry; only the `expiring` branch is exercised); the daily
 * digest's rendering of a disabled row (a row with no `rows` reads as clean there and it is the builder's call whether the digest should say so; pinned only
 * is that /api/checks and the startup line do); the unit on with the executor UNREACHABLE; the graph-aware replacement of either engine (a later slice, rows then).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer, startMcpServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'dm-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const H = 3.6e6;
const GHOST = 'ghost|2026-09-01T00:00:00.000Z|2026-09-01T00:00:00.000Z|';
const TICKS_MS = 3500;   // MCP_WHISPER_TICK_MS is 400: at least eight ticks

const ROSTER_FILE = path.join(os.tmpdir(), `dm-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' }, cy: { name: 'Cy', glyph: 'c', color: '#e0b060' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

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
async function scenario(body, { unit }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  const stateFile = path.join(dir, 'stale-claim-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ asked: { [GHOST]: '2026-09-01T00:10:00.000Z' } }, null, 2));
  const tendingFile = path.join(dir, 'tending.json'); fs.writeFileSync(tendingFile, JSON.stringify({ enabled: true, quietAfterMinutes: 69 }));
  let exec = null;
  if (unit) exec = await startExecutor({ store: tmpStore('dm-store-'), datasetId: DSID, create: true });
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, ...(unit ? { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) } });
  let mcp = null;
  try {
    // the scenario is written BEFORE the adapter starts, so its first tick already sees it
    const posted = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'bea', attachedTo: 'working', body: 'still on it, next observable is the next green run' });
    assert.equal(posted.status, 201, `the working holder's post on her card: ${posted.text}`);
    const minted = await api(rest.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master', definition: 'Establishes Scrum here and holds the cadence; asks, never asserts.', definedBy: 10 });
    assert.ok(minted.status === 200 || minted.status === 201, `the role is minted first: ${minted.status} ${minted.text}`);
    const declared = await api(rest.baseUrl, 'PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, role: 'scrum-master', expiresAt: new Date(Date.now() + 2 * H).toISOString() });
    assert.equal(declared.status, 200, `the role declaration: ${declared.text}`);
    mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_TENDING_CONFIG_FILE: tendingFile, SCRUM_STALE_CLAIM_STATE_FILE: stateFile, MCP_WHISPER_TICK_MS: '400' } });
    const ctx = {
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
  }
}

test('DM1 VISIBLE — with the unit on, each decision-maker row says disabled, names #1574 and the graph, is not shaped like a clean check; one startup line names both; the others still run', { skip: SKIP }, async () => {
  await scenario(async (c) => {
    for (const id of ['stale-claims', 'role-expiry']) {
      const row = await c.standing(id);
      assert.ok(row, `the ${id} standing row is still PRESENT (a vanished row reads as no such check): ${JSON.stringify((await c.checks()).standing?.map((s) => s.id))}`);
      assert.equal(row.disabled, true, `${id} says disabled: true: ${JSON.stringify(row)}`);
      assert.equal(typeof row.reason, 'string', `${id} gives a reason: ${JSON.stringify(row)}`);
      assert.match(row.reason, /#1574/, `${id}'s reason names the unit's card: ${row.reason}`);
      assert.match(row.reason, /graph/i, `${id}'s reason says why (the graph): ${row.reason}`);
      assert.ok(!(Array.isArray(row.rows) && row.rows.length === 0), `${id} is NOT shaped like a clean check (an empty rows array is "nothing found"): ${JSON.stringify(row)}`);
    }
    const others = ((await c.checks()).standing || []).filter((s) => s.id !== 'stale-claims' && s.id !== 'role-expiry');
    assert.ok(others.length > 0, 'there are other standing checks to compare against');
    assert.ok(others.every((s) => s.disabled !== true), `the disable is not blanket; also disabled: ${JSON.stringify(others.filter((s) => s.disabled).map((s) => s.id))}`);
    assert.ok(others.some((s) => Array.isArray(s.rows)), 'at least one other standing check still ran and returned rows');
    assert.equal(await c.rest.waitForStderr(/stale-claims/, 3000), true, `the startup line exists: ${c.rest.stderr().slice(-600)}`);
    const lines = c.linesNaming();
    assert.equal(lines.length, 1, `exactly ONE line names the engines, at startup: ${JSON.stringify(lines)}`);
    assert.ok(/stale-claims/.test(lines[0]) && /role-expiry/.test(lines[0]) && /#1574/.test(lines[0]) && /disabled/i.test(lines[0]), `and it names BOTH, the unit and "disabled": ${lines[0]}`);
  }, { unit: true });
});

test('DM2 INERT AND QUIET — with the unit on, a working graph-only holder is not asked, a silent holder is not asked, nothing is reclaimed, the dedupe memory is not rewritten, no error, no per-tick noise', { skip: SKIP }, async () => {
  await scenario(async (c) => {
    const before = sha(c.stateFile);
    await sleep(TICKS_MS);
    const asks = await c.asks();
    assert.deepEqual(asks.map((m) => m.body), [], `NO ask about anyone (the misread would ask the WORKING holder #10, and a disabled engine knows nothing about #20): ${JSON.stringify(asks.map((m) => m.body))}`);
    assert.equal(await c.claim('working'), 'bea', 'the working holder still holds');
    assert.equal(await c.claim('silent'), 'cy', 'the silent holder still holds: nothing reclaims');
    assert.ok(!/#455/.test(c.mcp.stderrText()), `the adapter logged nothing about #455: ${c.mcp.stderrText().split('\n').filter((l) => /#455/.test(l)).join(' | ')}`);
    assert.equal(sha(c.stateFile), before, `the ask's dedupe memory is byte-identical (a disabled engine forgets nothing): ${fs.readFileSync(c.stateFile, 'utf8')}`);
    assert.ok(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')).asked[GHOST], 'and the old episode is still remembered');
    for (const id of ['stale-claims', 'role-expiry']) {
      const row = await c.standing(id);
      assert.ok(row && row.disabled === true, `${id} is still disabled after the ticks: ${JSON.stringify(row)}`);
      assert.equal(row.error, undefined, `${id} carries no error (a decision is not an instrument failure): ${JSON.stringify(row)}`);
    }
    assert.equal(c.linesNaming().length, 1, `still ONE line naming the engines after the ticks (no per-tick noise): ${JSON.stringify(c.linesNaming())}`);
  }, { unit: true });
});

test('DM3 UNCHANGED — with the unit off the same fixture behaves as today: the silent holder is asked once, the working holder is not, role-expiry reports, no disabled key, no startup line, the dedupe memory is rewritten', { skip: SKIP }, async () => {
  await scenario(async (c) => {
    const before = sha(c.stateFile);
    await sleep(TICKS_MS);
    const asks = await c.asks();
    assert.equal(asks.length, 1, `exactly ONE ask across the ticks: ${JSON.stringify(asks.map((m) => m.body))}`);
    assert.match(asks[0].body, /#20 «card 20» — cy, what happened\?/);
    assert.doesNotMatch(asks[0].body, /#10/, 'the working holder (a post on the card) is never asked');
    assert.equal(await c.claim('silent'), 'cy', 'and nothing is reclaimed');
    const stale = await c.standing('stale-claims');
    assert.equal(stale.disabled, undefined, `no disabled key: ${JSON.stringify(stale)}`);
    assert.deepEqual((stale.rows || []).map((r) => [r.shortId, r.holder]), [[20, 'cy']], `the silent holder's row, not the working holder's: ${JSON.stringify(stale)}`);
    const role = await c.standing('role-expiry');
    assert.equal(role.disabled, undefined, `no disabled key: ${JSON.stringify(role)}`);
    assert.deepEqual((role.rows || []).map((r) => [r.seat, r.state]), [['ada', 'expiring']], `role-expiry reports the expiring grant: ${JSON.stringify(role)}`);
    assert.equal(c.linesNaming().length, 0, `no startup line about either engine: ${JSON.stringify(c.linesNaming())}`);
    assert.notEqual(sha(c.stateFile), before, 'the dedupe memory IS rewritten when the engine runs (control: DM2 pins it as unchanged)');
    const asked = JSON.parse(fs.readFileSync(c.stateFile, 'utf8')).asked;
    assert.equal(asked[GHOST], undefined, 'the ghost episode with no row is pruned, as today');
    assert.equal(Object.keys(asked).length, 1, `and the silent holder's episode is recorded: ${JSON.stringify(asked)}`);
  }, { unit: false });
});
