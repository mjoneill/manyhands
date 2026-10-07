/**
 * #1598 K2 and K7, SECOND FILE: THE TWO BOUNDARIES THE REVIEW NAMED. `cards-graph-c1.test.mjs` still defines C0–C7; this file adds two rows the review of the build design (the reviewer, 05:56Z) made necessary, as
 * a NEW file so the first stays byte-identical to what the build is written against. Same template: REST with a REAL executor behind a fault-injecting proxy, a unit-off server as the control, synthetic content. Without a python with
 * pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. The switch is `SCRUM_GRAPH_UNIT_CARDS` (adopted on #1598).
 *
 *   C8  A WRITE WHOSE OUTCOME IS UNKNOWN IS NEVER SERVED AS A STALE CARD (the cache rule: "update only after confirmed commits, invalidate after UNKNOWN outcomes"). The proxy lets the executor APPLY one card write and drops the reply, so the server
 *       cannot know whether it committed. Whatever the server answers (a reconciled success or a refusal that says the outcome is unknown), the card it serves AFTER must be what the EXECUTOR holds: new title in both, or old title in both, never
 *       the new one in one and the old one in the other; and the version moved at most once. Then the opposite fault (the request is dropped before the executor, so it was never applied): the card is unchanged, and sending the same write
 *       again with the same `requestId` applies it exactly once. The fault must actually have fired, or the row says so and fails (a row that never injected its fault proves nothing).
 *   C9  A MULTI-CARD WRITE IS ONE WRITE ("one conjunctive guard across all parts: any stale version means nothing lands"). A move with `makeRoom` shifts the cards after it in the same column. While it is in flight, another seat edits the title of a
 *       card it shifts, with no ifVersion. After both settle, over eight rounds: no card is lost, the column's `order` numbers are distinct, the column reads either the moved order (the move landed) or the original order (it was refused), never
 *       half of a shift, and the neighbour's title edit LANDED (a shift must not write back the neighbour's old title). Unit off is the control: the document's lock makes it true today.
 *
 * NOT COVERED, by name: which of "200" and "409" the move answers when it loses (both are allowed; the invariants are what is pinned); `requestId` on the move beyond what C8 uses; a move across columns; the move-fence routes (the #1584 rows); a
 * claim or a delete as the unknown write (C8 uses a title edit: the cache rule is the same for all, and C4 owns claims); more than one neighbour edited at once.
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
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_CARDS';
const ROSTER_FILE = path.join(os.tmpdir(), `c2k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const newCard = (base, title, extra = {}) => api(base, 'POST', '/api/cards', { title, description: 'body', createdBy: 'ada', ...extra });

/** a proxy that forwards everything except ONE armed `/update`: `drop-reply` (applied, answer lost) or `drop-request` (never applied) */
async function startFaultProxy(execUrl) {
  const state = { armed: null, log: [] };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const fault = req.url === '/update' ? state.armed : null; if (fault) state.armed = null;
      if (req.url === '/update') state.log.push({ op: req.headers['x-op-id'] ?? null, fault });
      if (fault === 'drop-request') { req.socket.destroy(); return; }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      try {
        const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
        const t = await f.text();
        if (fault === 'drop-reply') { req.socket.destroy(); return; }
        res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
      } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
async function unitOn(body, dsid = 'c2k-test') {
  const exec = await startExecutor({ store: tmpStore('c2k-store-'), datasetId: dsid, create: true });
  const proxy = await startFaultProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); proxy.close(); await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}

test('C8 AN UNKNOWN WRITE IS NEVER SERVED AS A STALE CARD: the served card is what the executor holds; a never-applied write is applied exactly once on replay', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy, exec }) => {
    const tag = ALNUM();
    const c = (await newCard(base, `${tag} original`)).body; assert.ok(c?.id, 'CONTROL: a card is created through the proxy');
    // ── applied, reply lost ──
    const n0 = proxy.state.log.length; proxy.state.armed = 'drop-reply';
    const w = await api(base, 'PATCH', `/api/cards/${c.id}`, { by: 'ada', title: `${tag} renamed-unknown` });
    assert.ok(proxy.state.log.slice(n0).some((x) => x.fault === 'drop-reply'), 'THE FAULT FIRED: a card write reached the executor and its reply was dropped (a row that never injected its fault proves nothing)');
    const served = (await api(base, 'GET', `/api/cards/${c.id}`)).body;
    const heldNew = await holders(exec.baseUrl, `${tag} renamed-unknown`) >= 1;
    assert.equal(served.title, heldNew ? `${tag} renamed-unknown` : `${tag} original`, `the card served after an UNKNOWN write is what the executor holds (executor holds the new title: ${heldNew}; served: "${served.title}"; the write answered ${w.status})`);
    assert.ok(served.version - c.version <= 1, `the version moved at most once (${c.version} to ${served.version})`);
    if (w.status === 200) assert.equal(served.title, `${tag} renamed-unknown`, 'an answer of 200 means the new title is what is served');
    // ── never applied, request lost ──
    const rid = `c2k-${tag}-r1`.slice(0, 40); const d = (await newCard(base, `${tag} second`)).body;
    const n1 = proxy.state.log.length; proxy.state.armed = 'drop-request';
    const first = await api(base, 'PATCH', `/api/cards/${d.id}`, { by: 'ada', title: `${tag} second-renamed`, requestId: rid });
    assert.ok(proxy.state.log.slice(n1).some((x) => x.fault === 'drop-request'), 'THE SECOND FAULT FIRED');
    const mid = (await api(base, 'GET', `/api/cards/${d.id}`)).body; const heldMid = await holders(exec.baseUrl, `${tag} second-renamed`) >= 1;
    assert.equal(mid.title, heldMid ? `${tag} second-renamed` : `${tag} second`, `served matches held after a lost request too (held new: ${heldMid}; served "${mid.title}"; the write answered ${first.status})`);
    const replay = await api(base, 'PATCH', `/api/cards/${d.id}`, { by: 'ada', title: `${tag} second-renamed`, requestId: rid });
    assert.ok(replay.status < 300, `the same write with the same requestId is accepted (${replay.status} ${replay.text.slice(0, 120)})`);
    const end = (await api(base, 'GET', `/api/cards/${d.id}`)).body;
    assert.equal(end.title, `${tag} second-renamed`, 'and the card has the new title'); assert.ok(end.version - d.version <= 1, `applied EXACTLY once: the version moved by at most one (${d.version} to ${end.version})`);
  });
});

async function moveRounds(base, tag, rounds) {
  const violations = [];
  for (let r = 0; r < rounds; r++) {
    const col = 'planned'; const mk = async (n, order) => (await newCard(base, `${tag} r${r} ${n}`, { column: col, order })).body;
    const base0 = 1000 + r * 10;   // an order range of its own, so rounds do not interfere
    const A = await mk('A', base0 + 1); const B = await mk('B', base0 + 2); const C = await mk('C', base0 + 3); const D = await mk('D', base0 + 4);
    for (const x of [A, B, C, D]) if (!x?.id) { violations.push(`round ${r}: a card was not created`); }
    const [move, edit] = await Promise.all([
      api(base, 'PATCH', `/api/cards/${D.id}`, { by: 'ada', column: col, order: base0 + 2, makeRoom: true, after: A.id, ifVersion: D.version }),
      api(base, 'PATCH', `/api/cards/${B.id}`, { by: 'gizmo', title: `${tag} r${r} B-edited` }),
    ]);
    const all = ((await api(base, 'GET', '/api/cards?limit=500')).body); const list = Array.isArray(all) ? all : (all.cards ?? []);
    const mine = list.filter((c) => String(c.title).startsWith(`${tag} r${r} `)).sort((a, b) => a.order - b.order);
    if (mine.length !== 4) violations.push(`round ${r}: ${mine.length} of 4 cards are in the list`);
    if (new Set(mine.map((c) => c.order)).size !== mine.length) violations.push(`round ${r}: duplicate order numbers ${JSON.stringify(mine.map((c) => c.order))}`);
    const letters = mine.map((c) => String(c.title).split(' ')[2][0]).join('');   // the first character of the third word: "B-edited" is still B
    if (!['ABCD', 'ADBC'].includes(letters)) violations.push(`round ${r}: the column reads ${letters} (a landed move is ADBC, a refused one ABCD; anything else is half a shift)`);
    if (letters === 'ADBC' && move.status !== 200) violations.push(`round ${r}: the column shows the move but it answered ${move.status}`);
    if (letters === 'ABCD' && move.status === 200) violations.push(`round ${r}: the move answered 200 but the column is unchanged`);
    const b = mine.find((c) => String(c.title).split(' ')[2][0] === 'B');
    if (edit.status === 200 && !(b && String(b.title).endsWith('B-edited'))) violations.push(`round ${r}: the neighbour's edit answered 200 but its title is "${b?.title}" (a shift wrote back the old title)`);
  }
  return violations;
}
test('C9 A MULTI-CARD WRITE IS ONE WRITE, unit OFF is the control: eight rounds of a makeRoom move racing a neighbour edit, no half shift and no lost edit', { timeout: 300000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { assert.deepEqual(await moveRounds(rest.baseUrl, ALNUM(), 8), [], 'no violation in eight rounds'); } finally { await rest.stop(); }
});
test('C9b A MULTI-CARD WRITE IS ONE WRITE (unit ON): the same eight rounds through the graph', { skip: SKIP, timeout: 400000 }, async () => {
  await unitOn(async ({ base }) => { assert.deepEqual(await moveRounds(base, ALNUM(), 8), [], 'no violation in eight rounds'); });
});
