/**
 * #1598 K1–K7, CARDS IN THE GRAPH: THE DIFFERENTIAL AND THE TARGETED ROWS. Written by the separate test author BEFORE the build, from the contract on the card (the builder's v1, 2026-10-06 21:50Z) and the card routes as they stand. Same template as the K13
 * rows: REST with a REAL executor behind a proxy, a unit-off server as the oracle, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass.
 *
 * ⚠️ THE SWITCH IS A GUESS. The card says "one flag" and does not name it; `UNIT_ENV` below is `SCRUM_GRAPH_UNIT_CARDS` (the family of the other unit flags), and the rows also set the conversations unit, which a card's claim announcement needs. If the
 * build names another, change that one constant. ⚠️ `requestId` (K5) is NOT sent by the parity script: if the build makes it REQUIRED with the unit on (as #1582's steps did), say so and the unit-on server gets one added; the "missing requestId is a 400"
 * answer is then its own row, not a silent difference in the parity.
 *
 * Why a differential and not a unit test: the document gives a card write everything for free (`withWriteLock`: read, check, write, one critical section; versions that cannot skip; a shortId counter that cannot repeat; a claim and its announcement in
 * one write). A lockless guarded executor update has to EARN each of those, so each gets a row that fails if it did not.
 *
 *   C0  CONTROL (green today): with the unit OFF every step of the card script answers as listed below and the concurrency facts hold (the lock makes them true).
 *   C1  PARITY OF ANSWERS AND REFUSALS (K1, K2, K3): the same script on a unit-on server answers the same statuses and the same masked wire (uuids and times masked; versions are NOT masked: they are part of the contract), and the lists agree.
 *   C2  THE GRAPH HOLDS IT, THE FILE DOES NOT (K3): a card created and edited through the unit-on server is in the executor's store and NOT in the board file.
 *   C3  ONE GUARDED UPDATE PER WRITE (K2): two PATCHes with the SAME ifVersion race: exactly one 200 and one 409 (and the version moved by exactly one); six concurrent `descriptionAppend`s with NO ifVersion ALL land (as today: the lock
 *       serialises them, so a writer with no precondition is never refused), and the version moved by exactly six.
 *   C4  A CLAIM AND ITS ANNOUNCEMENT ARE ONE WRITE (K4): two seats claim at once: exactly one 200 and one 409 naming the holder; exactly ONE announcement exists, naming the winner, and the loser's is nowhere; release by a non-holder is 409.
 *   C5  A RETRY IS NOT A SECOND CARD (K5): the same create sent twice with the same `requestId` answers the same card and there is one card with that title; a NEW requestId with the same title is a second card. (Unit on only. It is GREEN today: the document
 *       already answers a replayed create by `requestId` (#1583), so this row says the unit must KEEP that, not that it is new.)
 *   C6  shortId ALLOCATION (K6): six concurrent creates get six DISTINCT, CONSECUTIVE shortIds; and a create refused with the executor away does not burn a number (the next create is the next number).
 *   C7  READS AND WRITES FAIL LOUD (K7): with the executor away, create, edit, claim and delete answer 503 and the card list, a card by id, `/api/board/status` and search answer 503, never a 200 with an empty or short board; back, all of them work
 *       and the cards created before are there.
 *
 * SCRIPT: create (201), no title (400), an unknown column (400); get by id, by shortId, unknown (404); PATCH title, `descriptionAppend`, `descriptionPrepend`, column `planned`, labels, an unknown column (400), `checks` without ifVersion (400, #1132),
 * `checks` with ifVersion (200), a stale ifVersion (409), an unknown card (404); claim (200), a second claimer (409), release by a non-holder (409), release by the holder (200); delete (204) then get (404); lists and the `column` filter.
 *
 * NOT COVERED, by name: K8 (the migration, `card.import`: rows when the script exists; its read-back compares file cards to graph cards by id and content); K9–K12 (what retires; `/api/changes` over a card feed); the relationship, blocker, acceptance
 * and `implementedBy` write routes beyond the one `checks` array (their arrays share the #1132 rule, which the script pins once); the move-fence and `makeRoom` routes (their own #1584 rows); MCP above REST; the board PAGE (K11's rows); the order of a plain list;
 * `graph_query` over card triples (the compiler-level rows, which belong to the build's own unit tests); a card whose body is large.
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
const ROSTER_FILE = path.join(os.tmpdir(), `c1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const maskDeep = (v) => { if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<time>'); if (Array.isArray(v)) return v.map(maskDeep); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])); return v; };
const asSet = (v) => (Array.isArray(v) ? [...v].map((x) => JSON.stringify(maskDeep(x))).sort() : maskDeep(v));
const record = (out) => (label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' ? (Array.isArray(r.body) ? asSet(r.body) : maskDeep(r.body)) : null]);

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
async function unitOn(body, dsid = 'c1k-test') {
  const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const newCard = (base, title, extra = {}) => api(base, 'POST', '/api/cards', { title, description: 'body', createdBy: 'ada', ...extra });
const CHECKS = [{ claim: 'c1k synthetic', ask: 'ASK { ?x a <https://schema.org/CreativeWork> }', expect: true }];

async function cardScript(base, tag) {
  const out = []; const rec = record(out);
  const c = await newCard(base, `${tag} first`, { labels: ['l1'], description: `body ${tag}-descmark` }); rec('create', c);
  rec('create no title', await api(base, 'POST', '/api/cards', { description: 'x', createdBy: 'ada' }));
  rec('create unknown column', await newCard(base, `${tag} nowhere`, { column: 'no-such-column' }));
  const id = c.body?.id; const sid = c.body?.shortId;
  rec('get by id', await api(base, 'GET', `/api/cards/${id}`)); rec('get by shortId', await api(base, 'GET', `/api/cards/${sid}`)); rec('get unknown', await api(base, 'GET', '/api/cards/999999'));
  const p = (b) => api(base, 'PATCH', `/api/cards/${id}`, { by: 'ada', ...b });
  rec('patch title', await p({ title: `${tag} renamed` })); rec('patch append', await p({ descriptionAppend: `\nappended ${tag}-appendmark` })); rec('patch prepend', await p({ descriptionPrepend: 'prepended\n' }));
  rec('patch column', await p({ column: 'planned' })); rec('patch labels', await p({ labels: ['a', 'b'] })); rec('patch unknown column', await p({ column: 'no-such-column' }));
  rec('patch checks no ifVersion', await p({ checks: CHECKS }));
  const v = (await api(base, 'GET', `/api/cards/${id}`)).body.version;
  rec('patch checks with ifVersion', await p({ checks: CHECKS, ifVersion: v }));
  rec('patch stale ifVersion', await p({ title: `${tag} stale`, ifVersion: v }));
  rec('patch unknown card', await api(base, 'PATCH', '/api/cards/999999', { by: 'ada', title: 'x' }));
  rec('claim', await api(base, 'POST', `/api/cards/${id}/claim`, { by: 'ada' }));
  rec('claim by another', await api(base, 'POST', `/api/cards/${id}/claim`, { by: 'gizmo' }));
  rec('release by non-holder', await api(base, 'DELETE', `/api/cards/${id}/claim`, { by: 'gizmo' }));
  rec('release by holder', await api(base, 'DELETE', `/api/cards/${id}/claim`, { by: 'ada' }));
  const d = await newCard(base, `${tag} to delete`); rec('create to delete', d);
  rec('delete', await api(base, 'DELETE', `/api/cards/${d.body?.id}`)); rec('get deleted', await api(base, 'GET', `/api/cards/${d.body?.id}`));
  rec('list', await api(base, 'GET', '/api/cards?limit=200')); rec('list column planned', await api(base, 'GET', '/api/cards?column=planned&limit=200'));
  return out;
}
const announcements = async (base, sid) => ((await api(base, 'GET', '/api/conversations?limit=300')).body ?? []).filter((x) => String(x.body ?? '').includes(`claimed #${sid}`));
async function facts(base, tag) {
  const f = {};
  const c = (await newCard(base, `${tag} race`)).body; const v0 = c.version;
  const two = await Promise.all([1, 2].map((n) => api(base, 'PATCH', `/api/cards/${c.id}`, { by: n === 1 ? 'ada' : 'gizmo', title: `${tag} race ${n}`, ifVersion: v0 })));
  f.ifVersionStatuses = two.map((r) => r.status).sort(); f.versionAfterTwo = (await api(base, 'GET', `/api/cards/${c.id}`)).body.version - v0;
  const v1 = (await api(base, 'GET', `/api/cards/${c.id}`)).body.version;
  const six = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => api(base, 'PATCH', `/api/cards/${c.id}`, { by: 'ada', descriptionAppend: `\n${tag}-append-${n}` })));
  f.appendStatuses = six.map((r) => r.status); const after = (await api(base, 'GET', `/api/cards/${c.id}`)).body;
  f.appendsLanded = [1, 2, 3, 4, 5, 6].filter((n) => String(after.description).includes(`${tag}-append-${n}`)).length; f.versionAfterSix = after.version - v1;
  const k = (await newCard(base, `${tag} claim race`)).body;
  const cl = await Promise.all(['ada', 'gizmo'].map((by) => api(base, 'POST', `/api/cards/${k.id}/claim`, { by }).then((r) => ({ by, ...r }))));
  f.claimStatuses = cl.map((r) => r.status).sort(); const winner = cl.find((r) => r.status === 200)?.by; const loser = cl.find((r) => r.status !== 200);
  f.holder = (await api(base, 'GET', `/api/cards/${k.id}`)).body.claimedBy; f.winner = winner; f.loserNamesHolder = !!loser && JSON.stringify(loser.body).includes(winner ?? '\u0000');
  f.announcements = (await announcements(base, k.shortId)).map((x) => String(x.body)); f.winnerAnnounced = f.announcements.filter((b) => winner && b.includes(winner)).length;
  f.releaseByOther = (await api(base, 'DELETE', `/api/cards/${k.id}/claim`, { by: winner === 'ada' ? 'gizmo' : 'ada' })).status;
  const sixCreates = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => newCard(base, `${tag} sid ${n}`)));
  f.createStatuses = sixCreates.map((r) => r.status); f.shortIds = sixCreates.map((r) => r.body?.shortId).sort((a, b) => a - b);
  return f;
}
const expectFacts = (f) => {
  assert.deepEqual(f.ifVersionStatuses, [200, 409], 'two PATCHes with the same ifVersion: exactly one 200 and one 409'); assert.equal(f.versionAfterTwo, 1, 'and the version moved by exactly one');
  assert.deepEqual(f.appendStatuses, [200, 200, 200, 200, 200, 200], 'six concurrent appends with no ifVersion are ALL accepted (a writer with no precondition is never refused)'); assert.equal(f.appendsLanded, 6, 'and all six texts are in the description (no lost update)'); assert.equal(f.versionAfterSix, 6, 'and the version moved by exactly six');
  assert.deepEqual(f.claimStatuses, [200, 409], 'two seats claim at once: one 200 and one 409'); assert.equal(f.holder, f.winner, 'the holder is the 200'); assert.ok(f.loserNamesHolder, 'and the 409 names the holder');
  assert.equal(f.announcements.length, 1, `exactly ONE announcement exists: ${JSON.stringify(f.announcements)}`); assert.equal(f.winnerAnnounced, 1, 'and it names the winner'); assert.equal(f.releaseByOther, 409, 'release by a non-holder is 409');
  assert.deepEqual(f.createStatuses, [201, 201, 201, 201, 201, 201], 'six concurrent creates are all accepted');
  assert.equal(new Set(f.shortIds).size, 6, 'with six DISTINCT shortIds'); assert.equal(f.shortIds[5] - f.shortIds[0], 5, `and CONSECUTIVE ones (${JSON.stringify(f.shortIds)})`);
};

test('C0 CONTROL: with the unit OFF every step of the card script answers as listed and the concurrency facts hold', { timeout: 240000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const s = Object.fromEntries((await cardScript(rest.baseUrl, tag)).map(([l, c]) => [l, c]));
    const want = { create: 201, 'create no title': 400, 'create unknown column': 400, 'get by id': 200, 'get by shortId': 200, 'get unknown': 404, 'patch title': 200, 'patch append': 200, 'patch prepend': 200, 'patch column': 200, 'patch labels': 200, 'patch unknown column': 400, 'patch checks no ifVersion': 400, 'patch checks with ifVersion': 200, 'patch stale ifVersion': 409, 'patch unknown card': 404, claim: 200, 'claim by another': 409, 'release by non-holder': 409, 'release by holder': 200, 'create to delete': 201, delete: 204, 'get deleted': 404, list: 200, 'list column planned': 200 };
    assert.deepEqual(s, want);
    expectFacts(await facts(rest.baseUrl, ALNUM()));
  } finally { await rest.stop(); }
});

test('C1 PARITY OF ANSWERS AND REFUSALS: the card script on a unit-on server answers the same statuses and masked wire (versions included)', { skip: SKIP, timeout: 400000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const expected = await cardScript(off.baseUrl, tag);
    await unitOn(async ({ base }) => { assert.deepEqual(await cardScript(base, tag), expected, 'every answer equals the unit-off answer'); });
  } finally { await off.stop(); }
});

test('C2 THE GRAPH HOLDS IT, THE FILE DOES NOT: a card created and edited through the unit-on server is in the executor and not in the board file', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = ALNUM(); await cardScript(base, tag);
    const file = JSON.stringify(rest.readBoardFile());
    // the needles are in the card's BODY only: the title appears in the claim's announcement post, which the executor holds anyway, so a title would pass for the wrong reason
    for (const needle of [`${tag}-descmark`, `${tag}-appendmark`]) { assert.ok(await holders(exec.baseUrl, needle) >= 1, `the executor holds "${needle}"`); assert.ok(!file.includes(needle), `and the board file does not hold "${needle}"`); }
  });
});

test('C3 + C4 + C6 THE DOCUMENT\'S FREE GUARANTEES, EARNED: ifVersion races, no lost appends, claim and announcement as one, consecutive shortIds (unit ON)', { skip: SKIP, timeout: 400000 }, async () => {
  await unitOn(async ({ base }) => { expectFacts(await facts(base, ALNUM())); });
});

test('C5 A RETRY IS NOT A SECOND CARD: the same create with the same requestId is one card; a new requestId is a second', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => {
    const tag = ALNUM(); const rid = `c1k-${tag}-r1`.slice(0, 40);
    const a = await newCard(base, `${tag} once`, { requestId: rid }); const b = await newCard(base, `${tag} once`, { requestId: rid });
    assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status), `both answer success (${a.status} ${b.status}: ${a.text.slice(0, 100)} | ${b.text.slice(0, 100)})`);
    assert.equal(b.body?.id, a.body?.id, 'the retry answers the SAME card');
    const titled = (await api(base, 'GET', '/api/cards?limit=200')).body.cards?.filter?.((c) => c.title === `${tag} once`) ?? ((await api(base, 'GET', '/api/cards?limit=200')).body ?? []).filter((c) => c.title === `${tag} once`);
    assert.equal(titled.length, 1, `there is ONE card with that title (${titled.length})`);
    const c = await newCard(base, `${tag} once`, { requestId: `c1k-${tag}-r2`.slice(0, 40) });
    assert.notEqual(c.body?.id, a.body?.id, 'a NEW requestId is a new intent: a second card');
  });
});

test('C6b A CREATE REFUSED WITH THE EXECUTOR AWAY BURNS NO shortId', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const a = await newCard(base, `${tag} a`); assert.equal(a.status, 201);
    await proxy.down(); const refused = await newCard(base, `${tag} refused`); await sleep(400); await proxy.up();
    assert.equal(refused.status, 503, `a create with the executor away is a 503 (${refused.status})`);
    const b = await newCard(base, `${tag} b`); assert.equal(b.status, 201, 'back: a create lands');
    assert.equal(b.body.shortId, a.body.shortId + 1, `the refused create burned no number: ${a.body.shortId} then ${b.body.shortId}`);
  });
});

test('C7 READS AND WRITES FAIL LOUD: executor away: writes 503, card list / card by id / board status / search 503, never a short board; back: all work', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const c = (await newCard(base, `${tag} before`)).body; assert.ok(c?.id, 'CONTROL: a card is created while the executor is up');
    await proxy.down();
    const attempts = [['create', await newCard(base, `${tag} during`)], ['edit', await api(base, 'PATCH', `/api/cards/${c.id}`, { by: 'ada', title: 'edited during' })], ['claim', await api(base, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' })], ['delete', await api(base, 'DELETE', `/api/cards/${c.id}`)],
      ['card list', await api(base, 'GET', '/api/cards?limit=50')], ['card by id', await api(base, 'GET', `/api/cards/${c.id}`)], ['board status', await api(base, 'GET', '/api/board/status')], ['search', await api(base, 'POST', '/api/search', { q: `${tag} before` })]];
    for (const [label, r] of attempts) assert.equal(r.status, 503, `${label} with the executor away is a 503, never a 200 (${r.status} ${r.text.slice(0, 100)})`);
    await sleep(500); await proxy.up();
    assert.equal((await api(base, 'GET', `/api/cards/${c.id}`)).status, 200, 'back: the card read works'); assert.equal((await api(base, 'GET', `/api/cards/${c.id}`)).body.title, `${tag} before`, 'and the refused edit changed nothing');
    assert.equal((await newCard(base, `${tag} after`)).status, 201, 'and a create lands');
  });
});
