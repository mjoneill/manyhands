/**
 * #1786 — the whisper's two once-per-window guards are graph state decided by REST under its write lock, so the guarantee
 * holds ACROSS PROCESSES. The test author's rows, written black-box against the "#1786 CONTRACT" and its amendment
 * (commons, 2026-10-26 21:35Z; the builder's message ~21:40Z). The builder does not write these rows.
 *
 * THE CONTRACT (one table, so a rename is one edit): POST /api/tending/windows {window} answers 201 for the first
 * reservation of a window and 409 {already:true} for any later one, and the reservation is a scrum:TendingWindowReservation
 * at https://scrumboard.local/tending/window/<encodeURIComponent(window)> with scrum:clockWindow; it is NOT a TendingMint (a mint is recorded
 * only after delivery). POST /api/tending/claims {window, seat, receivedAt, reached, periodMs?} answers {granted, reason,
 * window, heldBy?}: granted iff window is REST's current window and no grant exists for it; a grant writes a
 * scrum:TendingClaimAttempt carrying scrum:clockWindow. GET /api/tending/claims?limit=N answers {history:[{window, seat, at}]}.
 * The MCP's whisper_claim tool settles through REST.
 *
 * THE WORLD: a fresh executor with the conversations and small-kinds units on (the collections path), REST over a board
 * fixture, tending enabled by its config file (shared by REST and MCP).
 *
 * ROWS:
 *   W1  two CONCURRENT reservations of one window: exactly one 201 and one 409 {already:true}; exactly one reservation node,
 *       and no TendingMint for that window (a reservation is not a firing)
 *   W2  two CONCURRENT claims of the current window by different seats: exactly one granted; the loser is
 *       already-whispered-this-window with heldBy = the winner; exactly one TendingClaimAttempt for the window
 *   W3  a claim for a PAST window is expired-window and writes nothing
 *   W4  the history lists the grant (window and seat)
 *   W5  a REST restart keeps both guards: the window is still reserved (409) and the claim still held (heldBy)
 *   M1  TWO MCP PROCESSES race whisper_claim for one window through their own sessions: exactly one is granted, the other
 *       is told heldBy, across processes
 *
 * NOT COVERED, BY NAME: the MCP tick's pick → reserve → post → record order, and "a reserved window whose delivery fails has
 * a reservation and NO TendingMint" through the tick (driving a delivery failure needs an injected fault; W1 holds the graph
 * half: a reservation alone is not a mint).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'wg-1786';
const RS = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const HOUR = 3_600_000;
const hourOf = (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** the current hour window, waiting out the last 30 s of an hour so a row never straddles a boundary */
async function currentWindow() { const into = Date.now() % HOUR; if (HOUR - into < 30_000) await sleep(HOUR - into + 1000); return hourOf(Date.now()); }

async function world(body) {
  const store = tmpStore('wg-1786-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-1786-'));
  const tending = path.join(dir, 'tending-config.json');
  fs.writeFileSync(tending, JSON.stringify({ enabled: true, quietAfterMinutes: 60 }));
  const roster = path.join(dir, 'roster.json');
  fs.writeFileSync(roster, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c47ca0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_TENDING_CONFIG_FILE: tending, SCRUM_ROSTER_FILE: roster };
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'wg-1786' });
  const q = async (s) => { const r = await gc.query(s); assert.ok(r.ok, r.reason); return r.rows; };
  const servers = [];
  let rest = null, boardFile = null;
  const start = async () => {
    if (rest) rest.kill();
    rest = await startRestServer(boardFile ? { boardFile, env } : { board: makeBoardFixture({ cards: [], conversations: [] }), env });
    boardFile = rest.boardFile; servers.push(rest);
    return rest;
  };
  const call = async (method, route, payload) => {
    const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
    const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
  };
  try { await body({ q, start, call, rest: () => rest, env, tending, roster }); }
  finally { for (const r of servers.reverse()) await r.stop().catch(() => {}); await killExecutor(exec); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
}
const ofType = async (q, type, window) => (await q(`SELECT DISTINCT ?s WHERE { ?s <${RDF_TYPE}> <${RS}${type}> ; <${RS}clockWindow> ?w . FILTER(STR(?w) = ${JSON.stringify(window)}) }`)).map((r) => r.s.value);

test('#1786 W1–W5 — one reservation and one grant per window, decided by REST, and both survive a restart', T, async () => {
  await world(async ({ q, start, call }) => {
    await start();
    // W1 two concurrent reservations of one window (a window that is not the current one: reservation does not judge time)
    const W = '2026-10-26T03:00:00.000Z';
    const [a, b] = await Promise.all([call('POST', '/api/tending/windows', { window: W }), call('POST', '/api/tending/windows', { window: W })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `W1: exactly one 201 and one 409 (${a.status}, ${b.status}: ${a.text.slice(0, 120)} / ${b.text.slice(0, 120)})`);
    assert.equal((a.status === 409 ? a : b).json?.already, true, 'W1: the loser is told {already:true}');
    const res1 = await ofType(q, 'TendingWindowReservation', W);
    assert.deepEqual(res1, [`https://scrumboard.local/tending/window/${encodeURIComponent(W)}`], 'W1: exactly one reservation node, at its IRI (the window percent-encoded in the path)');
    assert.deepEqual(await ofType(q, 'TendingMint', W), [], 'W1: a reservation is not a TendingMint (nothing was delivered)');

    // W2 two concurrent claims of the current window by different seats
    const NOW = await currentWindow();
    const at = new Date().toISOString();
    const [ca, cb] = await Promise.all([
      call('POST', '/api/tending/claims', { window: NOW, seat: 'ada', receivedAt: at, reached: ['ada', 'bea'] }),
      call('POST', '/api/tending/claims', { window: NOW, seat: 'bea', receivedAt: at, reached: ['ada', 'bea'] }),
    ]);
    assert.equal(ca.status, 200, `W2: claim A answered (${ca.status} ${ca.text.slice(0, 160)})`); assert.equal(cb.status, 200, `W2: claim B answered (${cb.status})`);
    const granted = [ca, cb].filter((r) => r.json.granted === true), refused = [ca, cb].filter((r) => r.json.granted === false);
    assert.equal(granted.length, 1, `W2: exactly one claim is granted (${JSON.stringify([ca.json, cb.json])})`);
    const winner = granted[0] === ca ? 'ada' : 'bea';
    assert.equal(refused[0].json.reason, 'already-whispered-this-window', 'W2: the loser is told someone got there first');
    assert.equal(refused[0].json.heldBy, winner, 'W2: and who');
    assert.equal((await ofType(q, 'TendingClaimAttempt', NOW)).length, 1, 'W2: exactly one TendingClaimAttempt for the window (refusals stay log-only)');

    // W3 a claim for a past window
    const PAST = hourOf(Date.now() - 2 * HOUR);
    const cp = await call('POST', '/api/tending/claims', { window: PAST, seat: 'ada', receivedAt: new Date().toISOString(), reached: [] });
    assert.equal(cp.json?.granted, false, 'W3: a past window is not granted');
    assert.equal(cp.json?.reason, 'expired-window', 'W3: it is expired-window');
    assert.equal((await ofType(q, 'TendingClaimAttempt', PAST)).length, 0, 'W3: and writes nothing');

    // W4 the history lists the grant
    const h = await call('GET', '/api/tending/claims?limit=10');
    assert.equal(h.status, 200, `W4: history answered (${h.status})`);
    assert.ok((h.json.history || []).some((e) => e.window === NOW && e.seat === winner), `W4: the grant is in the history (${JSON.stringify(h.json.history)})`);

    // W5 a REST restart keeps both guards
    await start();
    const again = await call('POST', '/api/tending/windows', { window: W });
    assert.equal(again.status, 409, `W5: the window is still reserved after a restart (${again.status})`);
    const loser = winner === 'ada' ? 'bea' : 'ada';
    const c5 = await call('POST', '/api/tending/claims', { window: NOW, seat: loser, receivedAt: new Date().toISOString(), reached: [] });
    if (NOW === hourOf(Date.now())) {
      assert.equal(c5.json?.granted, false, 'W5: the claim is still held after a restart');
      assert.equal(c5.json?.heldBy, winner, 'W5: by the same seat');
    }
  });
});

test('#1786 M1 — TWO MCP processes race whisper_claim for one window: exactly one is granted, across processes', T, async () => {
  await world(async ({ start, rest, tending, roster }) => {
    await start();
    const mk = () => startMcpServer({ restApiBase: rest().baseUrl, env: { SCRUM_TENDING_CONFIG_FILE: tending, SCRUM_ROSTER_FILE: roster } });
    const [m1, m2] = await Promise.all([mk(), mk()]);
    try {
      const [s1, s2] = await Promise.all([mcpSession(m1.mcpUrl), mcpSession(m2.mcpUrl)]);
      const names = ((await s1.listTools()).result?.tools ?? []).map((t) => t.name);
      assert.ok(names.includes('whisper_claim'), `PRECONDITION: the whisper surface is enabled (${names.length} tools)`);
      const NOW = await currentWindow();
      const parse = (r) => { const t = r?.result?.content?.[0]?.text ?? ''; try { return JSON.parse(t); } catch { return { raw: t, error: r?.error }; } };
      const [r1, r2] = (await Promise.all([s1.callTool('whisper_claim', { seat: 'ada', window: NOW }), s2.callTool('whisper_claim', { seat: 'bea', window: NOW })])).map(parse);
      const granted = [r1, r2].filter((r) => r.granted === true);
      assert.equal(granted.length, 1, `M1: exactly one of two processes is granted (${JSON.stringify([r1, r2])})`);
      const loser = r1.granted ? r2 : r1, winner = r1.granted ? 'ada' : 'bea';
      assert.equal(loser.reason, 'already-whispered-this-window', 'M1: the other process is told someone got there first');
      assert.equal(loser.heldBy, winner, 'M1: and who, across processes');
    } finally { await m1.stop(); await m2.stop(); }
  });
});
