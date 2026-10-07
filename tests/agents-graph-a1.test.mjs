/**
 * #1624 K13, AGENTS AND AGENT PROMPTS. The family with the most guards, and one that cannot be moved the way the others can: the rest/retire write RELEASES THE CARDS THE SEAT HOLDS and raises one announcement, in the same locked write, and
 * the cards are still in the DOCUMENT (they move with #1598). With the agent in the graph that write spans two stores, and nothing makes two stores atomic for free. Same template as the other K13 rows: REST with a REAL executor behind a
 * proxy, type-agnostic, written by the separate test author BEFORE the build, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. `UNIT_ENV` is the one switch the build names.
 *
 *   A0  CONTROL (green today): with the unit OFF every step of the script answers as listed below, and a rest releases the seat's claims.
 *   A1  PARITY OF ANSWERS AND REFUSALS: the same script on a unit-on server answers the same statuses and masked wire (uuids and times masked, the list compared as a set).
 *   A2  REST RELEASES THE CLAIMS, ONCE: a seat holding two cards is set to resting: the answer names both, both cards are unclaimed afterwards, ONE announcement names them; resting it again releases nothing and posts nothing. Unit off is the
 *       control; unit on must be identical.
 *   A3  NO PARTIAL EFFECT, WITH THE EXECUTOR AWAY: the same rest while the executor is away answers 503 (never 200), and afterwards the cards are STILL CLAIMED and NO announcement was posted (a refused write changed nothing: the
 *       cross-store atomicity); with the executor back, the same rest works and releases both.
 *   A4  CONCURRENCY KEEPS THE IDENTITY: six concurrent prompt versions answer versions 2..7, each number ONCE, and the agent ends with seven versions and the CURRENT prompt is the highest (never an older one over a newer); two concurrent
 *       creates of one seat key are exactly [201, 409] and one agent. (Unit off is the control: the document's lock makes it true today.)
 *   A5  THE GRAPH HOLDS IT, THE DOCUMENT DOES NOT: after the script the executor's store holds the prompt text and the revised prompt text and the board file holds neither.
 *   A6  FAIL LOUD: executor away: create agent, prompt version and patch answer 503, the list 503 (never empty), a malformed request still 400; back: the create lands once.
 *
 * SCRIPT: a model is registered; an agent is created by `modelKey` (201), a twin seat key (409), a bad seat key, no prompt, no model, a model spec carrying a key-shaped field, a bad contextPolicy, residency, deliveryMode, a negative
 * budget, an unregistered modelKey (all 400); an agent with an inline model (201); a prompt version (201), on an unknown seat (404), with no body, no `by` (400); PATCH with an unknown field, with `prompt`, with a non-boolean `thinking`,
 * `maxHops` 0, a bad state, an unknown tool grant, an unknown sampling knob, a negative `memoryBudgetBytes`, an unregistered modelKey (all 400), on an unknown seat (404), and a legal patch of name, emoji, colour, tool grant and sampling (200); lists.
 *
 * NOT COVERED, by name: the prompt/grant conflict warning (#1242); `GET /api/agents/:seat/constraints`; the seat-declaration and wake side effects of a state change; a card claimed by the seat between the rest's read and its write (a race:
 * the atomicity row A3 is its deterministic cousin); migration of the existing 2 agents and 2 prompts (its read-back compares them by id and field); the order of the list.
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
const ROSTER_FILE = path.join(os.tmpdir(), `a1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const maskDeep = (v) => {
  if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<time>');
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
};
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
async function unitOn(body, dsid = 'a1k-test') {
  const exec = await startExecutor({ store: tmpStore('a1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const seatOf = (tag, n = '') => `a1s${tag.slice(-10)}${n}`;

async function agentsScript(base, tag) {
  const out = []; const rec = record(out);
  const modelKey = `a1m${tag.slice(-10)}`;
  rec('model create', await api(base, 'POST', '/api/models', { by: 'ada', key: modelKey, model: `${tag}-m:1b`, protocol: 'ollama-native' }));
  const seat = seatOf(tag); const good = { by: 'ada', seatKey: seat, prompt: `${tag} you are a synthetic test seat`, modelKey, name: `${tag} seat`, toolGrants: [], wakeOn: ['mention'] };
  rec('create', await api(base, 'POST', '/api/agents', good));
  rec('create twin', await api(base, 'POST', '/api/agents', { ...good, prompt: 'a twin' }));
  rec('create bad seat key', await api(base, 'POST', '/api/agents', { ...good, seatKey: 'X' }));
  rec('create no prompt', await api(base, 'POST', '/api/agents', { ...good, seatKey: seatOf(tag, 'b'), prompt: '' }));
  rec('create no model', await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seatOf(tag, 'c'), prompt: 'p' }));
  rec('create model spec with a secret', await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seatOf(tag, 'd'), prompt: 'p', model: { model: 'm', protocol: 'ollama-native', apiToken: 'sk-synthetic-not-real' } }));
  rec('create bad contextPolicy', await api(base, 'POST', '/api/agents', { ...good, seatKey: seatOf(tag, 'e'), contextPolicy: 'everything' }));
  rec('create bad residency', await api(base, 'POST', '/api/agents', { ...good, seatKey: seatOf(tag, 'f'), residency: 'nomad' }));
  rec('create bad deliveryMode', await api(base, 'POST', '/api/agents', { ...good, seatKey: seatOf(tag, 'g'), deliveryMode: 'telepathy' }));
  rec('create negative budget', await api(base, 'POST', '/api/agents', { ...good, seatKey: seatOf(tag, 'h'), budgetPerDay: -5 }));
  rec('create unregistered modelKey', await api(base, 'POST', '/api/agents', { ...good, seatKey: seatOf(tag, 'i'), modelKey: 'no-such-model' }));
  rec('create inline model', await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seatOf(tag, 'j'), prompt: `${tag} inline prompt`, model: { model: 'm:1b', protocol: 'ollama-native' } }));
  rec('prompt version', await api(base, 'POST', `/api/agents/${seat}/prompt`, { by: 'gizmo', body: `${tag} revised prompt, version two` }));
  rec('prompt version unknown seat', await api(base, 'POST', '/api/agents/no-such-seat/prompt', { by: 'ada', body: 'b' }));
  rec('prompt version no body', await api(base, 'POST', `/api/agents/${seat}/prompt`, { by: 'ada' }));
  rec('prompt version no by', await api(base, 'POST', `/api/agents/${seat}/prompt`, { body: 'b' }));
  const patch = (b) => api(base, 'PATCH', `/api/agents/${seat}`, { by: 'ada', ...b });
  rec('patch unknown field', await patch({ colour: 'red' }));
  rec('patch prompt', await patch({ prompt: 'overwrite' }));
  rec('patch thinking not boolean', await patch({ thinking: 'yes' }));
  rec('patch maxHops 0', await patch({ maxHops: 0 }));
  rec('patch bad state', await patch({ state: 'asleep' }));
  rec('patch unknown grant', await patch({ toolGrants: ['no_such_tool'] }));
  rec('patch unknown sampling knob', await patch({ sampling: { banana: 1 } }));
  rec('patch negative memoryBudgetBytes', await patch({ memoryBudgetBytes: -1 }));
  rec('patch unregistered modelKey', await patch({ modelKey: 'no-such-model' }));
  rec('patch unknown seat', await api(base, 'PATCH', '/api/agents/no-such-seat', { by: 'ada', name: 'x' }));
  rec('patch legal', await patch({ name: `${tag} seat, renamed`, emoji: 'T', color: '#112233', toolGrants: ['card_claim'], sampling: { temperature: 0.2 } }));
  rec('list', await api(base, 'GET', '/api/agents'));
  rec('list seat', await api(base, 'GET', `/api/agents?seat=${seat}`));
  return out;
}

test('A0 CONTROL: with the unit OFF every step of the script answers as listed in the header', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const s = Object.fromEntries((await agentsScript(rest.baseUrl, tag)).map(([l, c]) => [l, c]));
    const want = { 'model create': 201, create: 201, 'create twin': 409, 'create bad seat key': 400, 'create no prompt': 400, 'create no model': 400, 'create model spec with a secret': 400, 'create bad contextPolicy': 400, 'create bad residency': 400, 'create bad deliveryMode': 400, 'create negative budget': 400, 'create unregistered modelKey': 400, 'create inline model': 201, 'prompt version': 201, 'prompt version unknown seat': 404, 'prompt version no body': 400, 'prompt version no by': 400, 'patch unknown field': 400, 'patch prompt': 400, 'patch thinking not boolean': 400, 'patch maxHops 0': 400, 'patch bad state': 400, 'patch unknown grant': 400, 'patch unknown sampling knob': 400, 'patch negative memoryBudgetBytes': 400, 'patch unregistered modelKey': 400, 'patch unknown seat': 404, 'patch legal': 200, list: 200, 'list seat': 200 };
    assert.deepEqual(s, want);
  } finally { await rest.stop(); }
});

test('A1 PARITY OF ANSWERS AND REFUSALS: the script on a unit-on server answers the same statuses and masked wire', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const expected = await agentsScript(off.baseUrl, tag);
    await unitOn(async ({ base }) => { assert.deepEqual(await agentsScript(base, tag), expected, 'every answer equals the unit-off answer'); });
  } finally { await off.stop(); }
});

/** a seat that holds two cards, then is rested; returns what a reader sees */
async function restScenario(base, tag, { expectDown = null } = {}) {
  const seat = seatOf(tag, 'r');
  const made = await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seat, prompt: `${tag} resting seat`, model: { model: 'm:1b', protocol: 'ollama-native' } });
  assert.equal(made.status, 201, `precondition: the agent is created (${made.status} ${made.text.slice(0, 120)})`);
  const cards = []; for (const n of [1, 2]) { const c = (await api(base, 'POST', '/api/cards', { title: `${tag} held card ${n}`, description: 'x', createdBy: 'ada' })).body; const cl = await api(base, 'POST', `/api/cards/${c.id}/claim`, { by: seat }); assert.equal(cl.status, 200, `precondition: ${seat} claims card ${n} (${cl.status} ${cl.text.slice(0, 120)})`); cards.push(c); }
  return { seat, cards };
}
const holderOf = async (base, id) => (await api(base, 'GET', `/api/cards/${id}`)).body?.claimedBy ?? null;
const announcements = async (base, seat) => ((await api(base, 'GET', '/api/conversations?limit=200')).body ?? []).filter((c) => String(c.body ?? '').includes(`${seat} is resting`));

test('A2 REST RELEASES THE CLAIMS, ONCE: both cards freed, named in the answer, ONE announcement; resting again releases nothing (unit off, then unit on, identical)', { skip: SKIP, timeout: 300000 }, async () => {
  const observe = async (base, tag) => {
    const { seat, cards } = await restScenario(base, tag);
    const r1 = await api(base, 'PATCH', `/api/agents/${seat}`, { by: 'ada', state: 'resting' });
    assert.equal(r1.status, 200, `the rest is accepted (${r1.status} ${r1.text.slice(0, 120)})`);
    const holders1 = [await holderOf(base, cards[0].id), await holderOf(base, cards[1].id)];
    const posts1 = (await announcements(base, seat)).length;
    const r2 = await api(base, 'PATCH', `/api/agents/${seat}`, { by: 'ada', state: 'resting' });
    return { released1: [...(r1.body.released ?? [])].sort(), holders1, posts1, state: r1.body.state, released2: r2.body.released ?? [], posts2: (await announcements(base, seat)).length, shortIds: cards.map((c) => String(c.shortId)).sort() };
  };
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  let expected;
  try {
    expected = await observe(off.baseUrl, ALNUM());
    assert.deepEqual(expected.released1.map(String), expected.shortIds, 'CONTROL (unit off): the answer names both cards');
    assert.deepEqual(expected.holders1, [null, null], 'CONTROL: both cards are unclaimed'); assert.equal(expected.posts1, 1, 'CONTROL: one announcement'); assert.deepEqual([expected.released2, expected.posts2], [[], 1], 'CONTROL: resting again releases nothing and posts nothing');
  } finally { await off.stop(); }
  await unitOn(async ({ base }) => {
    const got = await observe(base, ALNUM());
    assert.deepEqual(got.released1.map(String), got.shortIds, 'unit on: the answer names both cards');
    assert.deepEqual(got.holders1, [null, null], 'unit on: both cards are unclaimed (the cards are in the document, the agent in the graph)');
    assert.equal(got.posts1, 1, 'unit on: exactly ONE announcement'); assert.equal(got.state, 'resting');
    assert.deepEqual([got.released2, got.posts2], [[], 1], 'unit on: resting again releases nothing and posts nothing');
  });
});

test('A3 NO PARTIAL EFFECT WITH THE EXECUTOR AWAY: the rest answers 503, the cards stay CLAIMED, nothing is announced; back, the same rest works', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const { seat, cards } = await restScenario(base, tag);
    await proxy.down();
    const r = await api(base, 'PATCH', `/api/agents/${seat}`, { by: 'ada', state: 'resting' });
    await sleep(300); await proxy.up();
    assert.equal(r.status, 503, `a rest the graph cannot record is a 503, never a 200 (${r.status} ${r.text.slice(0, 160)})`);
    assert.deepEqual([await holderOf(base, cards[0].id), await holderOf(base, cards[1].id)], [seat, seat], 'the refused write changed NOTHING: both cards are still claimed by the seat');
    assert.equal((await announcements(base, seat)).length, 0, 'and no announcement was posted');
    const again = await api(base, 'PATCH', `/api/agents/${seat}`, { by: 'ada', state: 'resting' });
    assert.equal(again.status, 200, `with the executor back the same rest works (${again.status} ${again.text.slice(0, 120)})`);
    assert.deepEqual([await holderOf(base, cards[0].id), await holderOf(base, cards[1].id)], [null, null], 'and releases both');
    assert.equal((await announcements(base, seat)).length, 1, 'with exactly one announcement');
  });
});

async function concurrency(base, tag) {
  const out = {};
  const seat = seatOf(tag, 'c');
  assert.equal((await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seat, prompt: 'v1 text', model: { model: 'm:1b', protocol: 'ollama-native' } })).status, 201);
  const vs = await Promise.all([2, 3, 4, 5, 6, 7].map((n) => api(base, 'POST', `/api/agents/${seat}/prompt`, { by: 'ada', body: `${tag} concurrent prompt ${n}` })));
  out.statuses = vs.map((r) => r.status); out.versions = vs.map((r) => r.body?.prompt?.version).sort((a, b) => a - b);
  const now = ((await api(base, 'GET', `/api/agents?seat=${seat}`)).body ?? [])[0];
  out.promptVersions = now?.promptVersions; out.currentVersion = now?.prompt?.version;
  const twin = seatOf(tag, 'd');
  const cs = await Promise.all([1, 2].map((n) => api(base, 'POST', '/api/agents', { by: n === 1 ? 'ada' : 'gizmo', seatKey: twin, prompt: `${tag} racing ${n}`, model: { model: 'm:1b', protocol: 'ollama-native' } })));
  out.createStatuses = cs.map((r) => r.status).sort();
  out.twinCount = ((await api(base, 'GET', `/api/agents?seat=${twin}`)).body ?? []).length;
  return out;
}
const expectConcurrent = (c) => {
  assert.deepEqual(c.statuses, [201, 201, 201, 201, 201, 201], 'all six concurrent prompt versions are accepted');
  assert.deepEqual(c.versions, [2, 3, 4, 5, 6, 7], 'they are versions 2..7, each number ONCE (never two v2, never one lost)');
  assert.equal(c.promptVersions, 7, 'the agent ends with seven versions'); assert.equal(c.currentVersion, 7, 'and the CURRENT prompt is the highest, never an older one over a newer');
  assert.deepEqual(c.createStatuses, [201, 409], 'two concurrent creates of one seat key are one 201 and one 409'); assert.equal(c.twinCount, 1, 'and there is ONE agent');
};
test('A4 CONCURRENCY KEEPS THE IDENTITY (unit OFF is the control): versions 2..7 once each, current is the highest, one agent per seat key', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { expectConcurrent(await concurrency(rest.baseUrl, ALNUM())); } finally { await rest.stop(); }
});
test('A4b CONCURRENCY KEEPS THE IDENTITY (unit ON): the same, through the graph', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => { expectConcurrent(await concurrency(base, ALNUM())); });
});

test('A5 THE GRAPH HOLDS IT, THE DOCUMENT DOES NOT: the prompt and the revised prompt are in the executor and not in the board file', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = ALNUM(); await agentsScript(base, tag);
    const file = JSON.stringify(rest.readBoardFile());
    for (const [what, needle] of [['prompt v1', `${tag} you are a synthetic test seat`], ['prompt v2', `${tag} revised prompt, version two`], ['inline-model agent prompt', `${tag} inline prompt`]]) {
      assert.ok(await holders(exec.baseUrl, needle) >= 1, `${what}: the executor store holds it`);
      assert.ok(!file.includes(needle), `${what}: and the board file does not`);
    }
  });
});

test('A6 FAIL LOUD: executor away: create, prompt version and patch 503, the list 503, a malformed request still 400; back: the create lands once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const seat = seatOf(tag, 'z');
    assert.equal((await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seat, prompt: 'before', model: { model: 'm:1b', protocol: 'ollama-native' } })).status, 201, 'CONTROL: an agent is created while the executor is up');
    await proxy.down();
    const attempts = [
      ['create', await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seatOf(tag, 'y'), prompt: 'during', model: { model: 'm:1b', protocol: 'ollama-native' } })],
      ['prompt version', await api(base, 'POST', `/api/agents/${seat}/prompt`, { by: 'ada', body: 'revised during' })],
      ['patch', await api(base, 'PATCH', `/api/agents/${seat}`, { by: 'ada', name: 'renamed during' })],
    ];
    for (const [label, r] of attempts) assert.equal(r.status, 503, `${label} with the executor away is a 503, never a 200/201 (${r.status} ${r.text.slice(0, 120)})`);
    const l = await api(base, 'GET', '/api/agents'); assert.equal(l.status, 503, `the list with the executor away is a 503, never an empty list (${l.status})`);
    assert.equal((await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: 'X', prompt: 'p' })).status, 400, 'a malformed request is still a 400, on its own grounds');
    await sleep(500); await proxy.up();
    assert.equal((await api(base, 'POST', '/api/agents', { by: 'ada', seatKey: seatOf(tag, 'x'), prompt: 'after', model: { model: 'm:1b', protocol: 'ollama-native' } })).status, 201, 'back: a create lands');
    const seats = ((await api(base, 'GET', '/api/agents')).body ?? []).map((a) => a.seatKey);
    assert.ok(seats.includes(seat) && seats.includes(seatOf(tag, 'x')), 'the list shows the earlier and the later agent');
    assert.ok(!seats.includes(seatOf(tag, 'y')), 'but not the one refused while the executor was away');
  });
});
