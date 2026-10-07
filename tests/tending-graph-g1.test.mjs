/**
 * #1624 K13, TENDING: the whispers (prompts and their versions), the playlist, the shuffle state, and the mints. The last small family, and the one with the most moving parts: eight kinds in one collection, authored by PURE operations (create, edit, enable,
 * remove, reorder, shuffle) that read EVERY tending entity, compute the next set, and write the difference, all under the document's write lock. A lockless graph write has to earn what that gives for free: a create appends to the CURRENT playlist, so two racing creates
 * can each build from the same playlist and one prompt falls out of it; two racing edits of one prompt can each pick the same next version number. Same template as the other K13 rows: REST with a REAL executor behind a proxy, type-agnostic (the prompt is found by a marker
 * in its body), a unit-off server as the oracle, written by the separate test author BEFORE the build, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. Switch: `SCRUM_GRAPH_UNIT_SMALLKINDS` (the one the build names).
 *
 *   T0  CONTROL (green today): with the unit OFF the script below answers as listed, concurrent creates all land in the playlist, and concurrent edits of one prompt all keep their text.
 *   T1  PARITY OF ANSWERS AND REFUSALS: the same script on a unit-on server answers the same statuses and the same masked wire (the pool, the shuffle flag, the refusal messages), at every step.
 *   T2  THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: after the script the executor holds a prompt body, an edited body and a mint's window, and the board file holds none.
 *   T3  THE LOCK'S FREE GUARANTEES, EARNED (unit on): four concurrent creates of four different prompts are ALL in the pool afterwards (none dropped from the playlist); three concurrent edits of one prompt are all accepted and ALL THREE bodies are kept as versions; a mint posted twice with the same window and time is ONE mint.
 *   T4  FAIL LOUD AND ALL-OR-NOTHING (unit on): with the executor away every authoring op and a mint answer 503 (never 200 or 201), the pool read answers 503 (never an empty pool), and a malformed request is still a 400; back, the pool is exactly what it was before (a refused op changed nothing) and the same ops land once.
 *
 * SCRIPT: GET the pool; create two prompts; a duplicate slug (400), an invalid slug (400), a blank body (400); edit one (200: the new body is the one served); edit an unknown slug (400); disable and enable; reorder (200); a reorder that omits a prompt (400, "must list every current whisper"); a reorder naming an unknown slug (400);
 * remove one (200); remove an unknown slug (400); shuffle on and off; a mint (201); a mint with no window (400).
 *
 * NOT COVERED, by name: the immutability of a version that already exists (a re-write with different content for the same id is refused: it is not reachable through REST, which always mints a new version number; the compiler-level rows belong to the build's unit tests); the create-stamped `importedAt` surviving a re-import (the boot migration's); the config route
 * (`/api/tending-config`, a file, not a graph kind); the scheduler that fires mints; migration of the existing 24 prompts, 38 prompt versions, 27 playlist versions and 389 mints (its read-back compares them by id and field); the order of the shuffle bag.
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
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_SMALLKINDS';
const ROSTER_FILE = path.join(os.tmpdir(), `g1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g; const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const maskDeep = (v) => { if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<time>'); if (Array.isArray(v)) return v.map(maskDeep); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])); return v; };
/** the pool without the shuffle bag (a bag may be dealt at random; only the whispers and the flag are compared) */
const view = (b) => (b && typeof b === 'object' ? maskDeep({ whispers: b.whispers, shuffle: b.shuffle }) : maskDeep(b));
const record = (out) => (label, r) => out.push([label, r.status, r.status === 200 && r.body && 'whispers' in r.body ? view(r.body) : (r.body && typeof r.body === 'object' ? maskDeep(r.body) : null)]);

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function unitOn(body, dsid = 'g1k-test') {
  const exec = await startExecutor({ store: tmpStore('g1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const pool = async (base) => (await api(base, 'GET', '/api/tending/whispers'));
const slugsOf = (r) => (r.body?.whispers ?? []).map((w) => w.slug ?? w.id ?? JSON.stringify(w)).sort();

async function tendingScript(base, tag) {
  const out = []; const rec = record(out); const s1 = `${tag}-one`; const s2 = `${tag}-two`;
  rec('pool', await pool(base));
  rec('create one', await api(base, 'POST', '/api/tending/whispers', { slug: s1, body: `${tag} first whisper body`, by: 'ada' }));
  rec('create two', await api(base, 'POST', '/api/tending/whispers', { slug: s2, body: `${tag} second whisper body`, by: 'gizmo' }));
  rec('create duplicate', await api(base, 'POST', '/api/tending/whispers', { slug: s1, body: 'again', by: 'ada' }));
  rec('create invalid slug', await api(base, 'POST', '/api/tending/whispers', { slug: 'not a slug!', body: 'x', by: 'ada' }));
  rec('create blank body', await api(base, 'POST', '/api/tending/whispers', { slug: `${tag}-blank`, body: '   ', by: 'ada' }));
  rec('edit one', await api(base, 'PATCH', `/api/tending/whispers/${s1}`, { body: `${tag} first whisper body, edited`, by: 'gizmo' }));
  rec('edit unknown', await api(base, 'PATCH', '/api/tending/whispers/no-such-whisper', { body: 'x', by: 'ada' }));
  rec('disable one', await api(base, 'PATCH', `/api/tending/whispers/${s1}`, { enabled: false }));
  rec('enable one', await api(base, 'PATCH', `/api/tending/whispers/${s1}`, { enabled: true }));
  rec('reorder', await api(base, 'POST', '/api/tending/order', { slugs: [s2, s1] }));
  rec('reorder omitting one', await api(base, 'POST', '/api/tending/order', { slugs: [s2] }));
  rec('reorder unknown slug', await api(base, 'POST', '/api/tending/order', { slugs: [s2, s1, 'no-such-whisper'] }));
  rec('remove two', await api(base, 'DELETE', `/api/tending/whispers/${s2}`));
  rec('remove unknown', await api(base, 'DELETE', '/api/tending/whispers/no-such-whisper'));
  rec('shuffle on', await api(base, 'POST', '/api/tending/shuffle', { shuffle: true }));
  rec('shuffle off', await api(base, 'POST', '/api/tending/shuffle', { shuffle: false }));
  rec('mint', await api(base, 'POST', '/api/tending/mints', { window: `${tag}-window`, mintedAt: '2026-10-07T01:00:00.000Z', by: 'board' }));
  rec('mint no window', await api(base, 'POST', '/api/tending/mints', { mintedAt: '2026-10-07T01:00:00.000Z' }));
  rec('final pool', await pool(base));
  return out;
}

test('T0 CONTROL: with the unit OFF the tending script answers as listed; concurrent creates all land; concurrent edits all keep their text', { timeout: 240000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const s = Object.fromEntries((await tendingScript(rest.baseUrl, tag)).map(([l, c]) => [l, c]));
    assert.deepEqual([s.pool, s['create one'], s['create two'], s['create duplicate'], s['create invalid slug'], s['create blank body'], s['edit one'], s['edit unknown'], s['disable one'], s['enable one'], s.reorder, s['reorder omitting one'], s['reorder unknown slug'], s['remove two'], s['remove unknown'], s['shuffle on'], s['shuffle off'], s.mint, s['mint no window'], s['final pool']],
      [200, 200, 200, 400, 400, 400, 200, 400, 200, 200, 200, 400, 400, 200, 400, 200, 200, 201, 400, 200]);
    const t2 = ALNUM(); const made = await Promise.all([1, 2, 3, 4].map((n) => api(rest.baseUrl, 'POST', '/api/tending/whispers', { slug: `${t2}-c${n}`, body: `${t2} concurrent ${n}`, by: 'ada' })));
    assert.deepEqual(made.map((r) => r.status), [200, 200, 200, 200]); const slugs = slugsOf(await pool(rest.baseUrl));
    for (const n of [1, 2, 3, 4]) assert.ok(slugs.some((x) => x.includes(`${t2}-c${n}`)), `concurrent create ${n} is in the pool (${JSON.stringify(slugs)})`);
    const edits = await Promise.all([1, 2, 3].map((n) => api(rest.baseUrl, 'PATCH', `/api/tending/whispers/${t2}-c1`, { body: `${t2} concurrent edit ${n}`, by: 'ada' })));
    assert.deepEqual(edits.map((r) => r.status), [200, 200, 200]); const file = JSON.stringify(rest.readBoardFile());
    for (const n of [1, 2, 3]) assert.ok(file.includes(`${t2} concurrent edit ${n}`), `edit ${n}'s body is kept as a version`);
    const m1 = await api(rest.baseUrl, 'POST', '/api/tending/mints', { window: `${t2}-w`, mintedAt: '2026-10-07T02:00:00.000Z' }); const m2 = await api(rest.baseUrl, 'POST', '/api/tending/mints', { window: `${t2}-w`, mintedAt: '2026-10-07T02:00:00.000Z' });
    assert.deepEqual([m1.status, m2.status], [201, 201]); assert.equal(m1.body.id, m2.body.id, 'the same window and time is the same mint id');
  } finally { await rest.stop(); }
});

test('T1 PARITY OF ANSWERS AND REFUSALS: the tending script on a unit-on server answers the same statuses and masked wire as the unit-off server', { skip: SKIP, timeout: 400000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { const tag = ALNUM(); const expected = await tendingScript(off.baseUrl, tag); await unitOn(async ({ base }) => { assert.deepEqual(await tendingScript(base, tag), expected, 'every answer equals the unit-off answer'); }); } finally { await off.stop(); }
});

test('T2 THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: a prompt body, an edited body and a mint are in the executor and not in the board file', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = ALNUM(); await tendingScript(base, tag); const file = JSON.stringify(rest.readBoardFile());
    for (const [what, needle] of [['a prompt body', `${tag} second whisper body`], ['an edited body', `${tag} first whisper body, edited`], ['a mint\'s window', `${tag}-window`]]) {
      assert.ok(await holders(exec.baseUrl, needle) >= 1, `${what}: the executor holds it`); assert.ok(!file.includes(needle), `${what}: and the board file does not`);
    }
  });
});

test('T3 THE LOCK\'S FREE GUARANTEES, EARNED (unit ON): four concurrent creates are all in the pool, three concurrent edits keep all three bodies, a mint posted twice is one mint', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, exec }) => {
    const t2 = ALNUM(); const made = await Promise.all([1, 2, 3, 4].map((n) => api(base, 'POST', '/api/tending/whispers', { slug: `${t2}-c${n}`, body: `${t2} concurrent ${n}`, by: 'ada' })));
    assert.deepEqual(made.map((r) => r.status), [200, 200, 200, 200], `all four creates are accepted (${JSON.stringify(made.map((r) => r.status))})`); const slugs = slugsOf(await pool(base));
    for (const n of [1, 2, 3, 4]) assert.ok(slugs.some((x) => x.includes(`${t2}-c${n}`)), `concurrent create ${n} is in the pool: a prompt that fell out of the playlist is lost to every reader (${JSON.stringify(slugs)})`);
    const edits = await Promise.all([1, 2, 3].map((n) => api(base, 'PATCH', `/api/tending/whispers/${t2}-c1`, { body: `${t2} concurrent edit ${n}`, by: 'ada' })));
    assert.deepEqual(edits.map((r) => r.status), [200, 200, 200], `all three edits are accepted (${JSON.stringify(edits.map((r) => r.status))})`);
    for (const n of [1, 2, 3]) assert.ok(await holders(exec.baseUrl, `${t2} concurrent edit ${n}`) >= 1, `edit ${n}'s body is kept as a version in the store`);
    const m1 = await api(base, 'POST', '/api/tending/mints', { window: `${t2}-w`, mintedAt: '2026-10-07T02:00:00.000Z' }); const m2 = await api(base, 'POST', '/api/tending/mints', { window: `${t2}-w`, mintedAt: '2026-10-07T02:00:00.000Z' });
    assert.deepEqual([m1.status, m2.status], [201, 201], 'a replayed mint is accepted'); assert.equal(m1.body.id, m2.body.id, 'with the same id');
    const mintNodes = (await (await fetch(`${exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(`${t2}-w`)})) }` })).json()).results.bindings[0].n.value;
    assert.equal(Number(mintNodes), 1, `the executor holds ONE node carrying that window (${mintNodes})`);
  });
});

test('T4 FAIL LOUD AND ALL-OR-NOTHING (unit ON): executor away: authoring ops and a mint 503, the pool read 503, a malformed request 400; back: the pool is unchanged and the ops land once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); assert.equal((await api(base, 'POST', '/api/tending/whispers', { slug: `${tag}-before`, body: `${tag} before`, by: 'ada' })).status, 200, 'CONTROL: a prompt is created while the executor is up');
    const before = slugsOf(await pool(base));
    await proxy.down();
    const attempts = [['create', await api(base, 'POST', '/api/tending/whispers', { slug: `${tag}-during`, body: `${tag} during`, by: 'ada' })], ['edit', await api(base, 'PATCH', `/api/tending/whispers/${tag}-before`, { body: `${tag} edited during`, by: 'ada' })],
      ['reorder', await api(base, 'POST', '/api/tending/order', { slugs: [`${tag}-before`] })], ['remove', await api(base, 'DELETE', `/api/tending/whispers/${tag}-before`)], ['shuffle', await api(base, 'POST', '/api/tending/shuffle', { shuffle: true })], ['mint', await api(base, 'POST', '/api/tending/mints', { window: `${tag}-down`, mintedAt: '2026-10-07T03:00:00.000Z' })]];
    for (const [label, r] of attempts) assert.equal(r.status, 503, `${label} with the executor away is a 503, never a 200 or 201 (${r.status} ${r.text.slice(0, 100)})`);
    const read = await pool(base); assert.equal(read.status, 503, `the pool read with the executor away is a 503, never an empty pool (${read.status})`);
    assert.equal((await api(base, 'POST', '/api/tending/whispers', { slug: 'not a slug!', body: 'x', by: 'ada' })).status, 400, 'a malformed request is still a 400, on its own grounds');
    await sleep(500); await proxy.up();
    assert.deepEqual(slugsOf(await pool(base)), before, 'back: the pool is exactly what it was before (the refused ops changed nothing)');
    assert.equal((await api(base, 'POST', '/api/tending/whispers', { slug: `${tag}-after`, body: `${tag} after`, by: 'ada' })).status, 200, 'and the same create lands now');
  });
});
