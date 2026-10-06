/**
 * #1617 — A DELIVERY'S STATE CHANGES ARE WRITTEN IN BATCHES. Every delivery state change is a full-document write today, one request per delivery: the runner's claim loop, its turn-started loop and its
 * outcome loop each POST once per delivery, so a digest turn over N posts costs 3N writes of a 143 MB document (the builder's count of today's event log: offered, claimed, turn-started, outcome per delivery;
 * the stale sweep wrote nothing). The first cut on the card: `POST /api/deliveries/events` applies a list of entries under ONE write lock with ONE `writeBoard`, per-entry guards unchanged, and the runner's three
 * loops each make one request. Written by the separate test author BEFORE the build, black-box through REST, plus the REAL runner (`scripts/guest-once.mjs`) behind a recording proxy for the loop rows. The
 * document-write count is the builder's `documentWrites` field on `GET /api/health` (it exists from the 1b build). Synthetic content. No executor is needed (the unit is off).
 *
 * THE WIRE SHAPE THIS FILE ASSUMES, in ONE place (`batchCall` below), because the card says only "taking [{id, state, …}]": the body is a JSON ARRAY of entries, each the single route's body plus the delivery `id`
 * (`{id, by, state, source?, reason?, note?, traceId?, modelCall?}`); the answer is 200 `{results: [{id, status, body}]}` in request order, where `status` and `body` are exactly what the single route would have
 * answered for that entry. If the build chose another shape, that one function changes and nothing else.
 *
 *   D0  CONTROL (green today): the single route is unchanged: claim, turn-started, published in order answer 201; a claim after published answers 409 naming the state.
 *   D1  ONE WRITE: a batch of 6 claims is applied with exactly one document write (documentWrites rises by 1), and all six deliveries read `claimed`.
 *   D2  PER-ENTRY RESULTS EQUAL SINGLE CALLS: the same 7 entries (claim a; turn-started a; claim b; claim b again; claim of an unknown id; a bad state; published a) sent as a batch to one board and as 7 single calls
 *       to a twin board give the same status and the same state per entry, in order, and the same final state of every delivery: an entry may depend on an earlier entry in the same batch, and one entry's
 *       409, 404 or 400 does not fail the others.
 *   D4  EMPTY AND ALL-REFUSED BATCHES WRITE NOTHING: an empty list answers 400; a batch in which every entry is refused (a 404, a 409, a 400) leaves documentWrites where it was.
 *   D7  PER-ENTRY GUARDS: an entry naming a `modelCall` the board does not hold is refused for that entry only, with nothing appended for it, and the others in the batch are applied.
 *   D8  ATOMIC UNDER CONCURRENCY: two batches racing to claim the same delivery give exactly one 201 for it and one 409; the delivery has exactly one claim event.
 *   D3  THE RUNNER: an open digest of 4 deliveries is handled with ONE request for the claim loop, ONE for the turn-started loop and ONE for the outcome loop (3 delivery writes in all, none through the per-id
 *       route), and every delivery ends settled.
 *
 * NOT COVERED, by name: the structural fix (deliveries off the document, #1582); the live three-tab / digest-turn validation ("a digest turn costs at most 3 document writes and no seat reads 503", measured with a
 * `stat` count on the live board); a batch above any size limit the build sets (it has not named one); `offered`/`queued` entries from the fanout (the fanout's own create loop is not part of the first cut); the
 * stale sweep (it writes nothing today).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';

const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROSTER_FILE = path.join(os.tmpdir(), `dlv-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const iso = (ageMin) => new Date(Date.now() - ageMin * 60000).toISOString();
const post = (id, seq) => ({ id, body: `delivered post ${id}`, author: 'ada', attachedTo: null, attachments: [], mentions: ['gizmo'], postSeq: seq, createdAt: iso(5) });
const posts = (n) => Array.from({ length: n }, (_, i) => post(`p${i + 1}`, i + 1));
const board = (n) => makeBoardFixture({ conversations: posts(n), postSeqEpoch: EPOCH_DOC, nextPostSeq: n + 1 });
const writes = async (base) => { const h = await api(base, 'GET', '/api/health'); assert.equal(h.status, 200, h.text.slice(0, 200)); assert.ok(Number.isSafeInteger(h.body.documentWrites), `/api/health carries a numeric documentWrites (${JSON.stringify(h.body.documentWrites)})`); return h.body.documentWrites; };
async function withBoard(n, body) {
  const rest = await startRestServer({ board: board(n), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const ids = [];
    for (let i = 1; i <= n; i++) { const d = await api(rest.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: `p${i}`, source: 'fanout', by: 'board' }); assert.equal(d.status, 201, d.text.slice(0, 200)); ids.push(d.body.id ?? d.body['@id']); }
    return await body({ base: rest.baseUrl, ids });
  } finally { await rest.stop(); }
}
/** THE WIRE SHAPE, in one place. */
const batchCall = (base, entries) => api(base, 'POST', '/api/deliveries/events', entries);
const single = (base, e) => { const { id, ...rest } = e; return api(base, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, rest); };
const E = (id, state, extra = {}) => ({ id, by: 'gizmo', state, ...extra });
const stateOf = (b) => b?.state ?? b?.deliveryState ?? b?.events?.at?.(-1)?.state ?? null;
const finalStates = async (base, ids) => Object.fromEntries(await Promise.all(ids.map(async (id, i) => { const l = await api(base, 'GET', '/api/deliveries?to=gizmo'); const d = (l.body.deliveries ?? []).find((x) => (x.id ?? x['@id']) === id); return [i, d ? stateOf(d) : null]; })));

test('D0 CONTROL: the single route is unchanged: claim, turn-started, published in order answer 201, and a claim after published answers 409 naming the state', { timeout: 120000 }, async () => {
  await withBoard(1, async ({ base, ids }) => {
    for (const st of ['claimed', 'turn-started', 'published']) { const r = await single(base, E(ids[0], st)); assert.equal(r.status, 201, `${st}: ${r.status} ${r.text.slice(0, 200)}`); assert.equal(stateOf(r.body), st); }
    const again = await single(base, E(ids[0], 'claimed'));
    assert.equal(again.status, 409, `a published delivery accepts no second claim (only offered, queued or failed can be claimed): ${again.status} ${again.text.slice(0, 200)}`);
    assert.equal(again.body?.state, 'published', 'and the refusal names the state');
  });
});

test('D1 ONE WRITE: a batch of 6 claims is applied with exactly one document write, and all six deliveries read claimed', { timeout: 120000 }, async () => {
  await withBoard(6, async ({ base, ids }) => {
    const w0 = await writes(base);
    const r = await batchCall(base, ids.map((id) => E(id, 'claimed')));
    assert.equal(r.status, 200, `the batch route answers: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(r.body?.results?.length, 6, 'one result per entry');
    assert.ok(r.body.results.every((x) => x.status === 201), `every claim was applied: ${JSON.stringify(r.body.results.map((x) => x.status))}`);
    const w1 = await writes(base);
    assert.equal(w1 - w0, 1, `exactly ONE document write for the whole batch (${w1 - w0})`);
    assert.deepEqual(Object.values(await finalStates(base, ids)), Array(6).fill('claimed'), 'all six read claimed');
  });
});

test('D2 PER-ENTRY RESULTS EQUAL SINGLE CALLS: 7 mixed entries as a batch and as single calls on a twin board give the same status and state per entry and the same final states', { timeout: 180000 }, async () => {
  const plan = (ids) => [E(ids[0], 'claimed'), E(ids[0], 'turn-started'), E(ids[1], 'claimed'), E(ids[1], 'claimed'), E('no-such-delivery', 'claimed'), E(ids[1], 'not-a-state'), E(ids[0], 'published')];
  let singles = null; let singleFinal = null;
  await withBoard(2, async ({ base, ids }) => {
    singles = []; for (const e of plan(ids)) { const r = await single(base, e); singles.push({ status: r.status, state: stateOf(r.body) ?? r.body?.state ?? null }); }
    singleFinal = await finalStates(base, ids);
  });
  await withBoard(2, async ({ base, ids }) => {
    const r = await batchCall(base, plan(ids));
    assert.equal(r.status, 200, `the batch answers 200 even when some entries are refused: ${r.status} ${r.text.slice(0, 300)}`);
    const got = (r.body?.results ?? []).map((x) => ({ status: x.status, state: stateOf(x.body) ?? x.body?.state ?? null }));
    assert.deepEqual(got, singles, `the batch's per-entry results equal the single calls' (batch ${JSON.stringify(got)} vs singles ${JSON.stringify(singles)})`);
    assert.deepEqual(await finalStates(base, ids), singleFinal, 'and the final states of the deliveries are the same');
    assert.deepEqual(singles.map((x) => x.status), [201, 201, 201, 409, 404, 400, 201], 'CONTROL: the singles themselves answer as the state machine says');
  });
});

test('D4 EMPTY AND ALL-REFUSED BATCHES WRITE NOTHING: an empty list is a 400, and a batch in which every entry is refused leaves documentWrites unchanged', { timeout: 120000 }, async () => {
  await withBoard(2, async ({ base, ids }) => {
    const w0 = await writes(base);
    const empty = await batchCall(base, []);
    assert.equal(empty.status, 400, `an empty list is refused: ${empty.status} ${empty.text.slice(0, 200)}`);
    assert.equal(await writes(base), w0, 'and writes nothing');
    assert.equal((await single(base, E(ids[0], 'claimed'))).status, 201);
    const w1 = await writes(base);
    const refused = await batchCall(base, [E(ids[0], 'claimed'), E('no-such-delivery', 'claimed'), E(ids[1], 'bogus')]);
    assert.equal(refused.status, 200, refused.text.slice(0, 200));
    assert.deepEqual(refused.body.results.map((x) => x.status), [409, 404, 400], 'every entry is refused, each for its own reason');
    assert.equal(await writes(base), w1, 'and a batch that changes nothing writes nothing');
  });
});

test('D7 PER-ENTRY GUARDS: an entry naming a modelCall the board does not hold is refused for that entry only, nothing is appended for it, and the others are applied', { timeout: 120000 }, async () => {
  await withBoard(3, async ({ base, ids }) => {
    const r = await batchCall(base, [E(ids[0], 'claimed'), E(ids[1], 'claimed', { modelCall: 'no-such-model-call' }), E(ids[2], 'claimed')]);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.body.results.map((x) => x.status), [201, 400, 201], `only the bad entry is refused: ${JSON.stringify(r.body.results.map((x) => x.status))}`);
    const fs2 = await finalStates(base, ids);
    assert.equal(fs2[0], 'claimed'); assert.equal(fs2[2], 'claimed');
    assert.equal(fs2[1], 'offered', 'and the refused entry left its delivery untouched');
  });
});

test('D8 ATOMIC UNDER CONCURRENCY: two batches racing to claim the same delivery give exactly one 201 and one 409, and exactly one claim event', { timeout: 120000 }, async () => {
  await withBoard(3, async ({ base, ids }) => {
    const [a, b] = await Promise.all([batchCall(base, ids.map((id) => E(id, 'claimed'))), batchCall(base, ids.map((id) => E(id, 'claimed')))]);
    assert.equal(a.status, 200, a.text.slice(0, 200)); assert.equal(b.status, 200, b.text.slice(0, 200));
    for (let i = 0; i < 3; i++) {
      const pair = [a.body.results[i].status, b.body.results[i].status].sort();
      assert.deepEqual(pair, [201, 409], `delivery ${i}: exactly one claim won (${pair})`);
    }
    const l = await api(base, 'GET', '/api/deliveries?to=gizmo');
    for (const d of l.body.deliveries) { const claims = (d.events ?? d.hasEvent ?? []).filter((e) => (e.state ?? e['scrum:state']) === 'claimed').length; assert.equal(claims, 1, 'one claim event per delivery'); }
  });
});

// ───────────── the runner ─────────────
function fakeOllama() {
  const o = { calls: 0 }; const conns = new Set();
  const srv = http.createServer((req, res) => { conns.add(req.socket); let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { o.calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: 'REPLY: Gizmo here.' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => { o.baseUrl = `http://127.0.0.1:${srv.address().port}`; o.stop = () => new Promise((r) => { for (const s of conns) { try { s.destroy(); } catch { /* gone */ } } srv.close(() => r()); }); resolve(o); }));
}
function recordingProxy(target) {
  const reqs = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    reqs.push({ method: req.method, url: req.url });
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    try {
      const f = await fetch(`${target}${req.url}`, { method: req.method, headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) });
      const buf = Buffer.from(await f.arrayBuffer());
      const out = Object.fromEntries([...f.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)));
      res.writeHead(f.status, out); res.end(buf);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ reqs, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) })));
}

test('D3 THE RUNNER: an open digest of 4 deliveries is handled with one request for the claim loop, one for the turn-started loop and one for the outcome loop, none through the per-id route, and every delivery ends settled', { timeout: 180000 }, async () => {
  const ollama = await fakeOllama();
  const rest = await startRestServer({ board: board(4), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const proxy = await recordingProxy(rest.baseUrl);
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-')), 'gizmo.state.json');
  try {
    const made = await api(rest.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'resident', by: 'ada', deliveryMode: 'channel' });
    assert.ok([200, 201].includes(made.status), `the resident is created: ${made.text.slice(0, 200)}`);
    for (let i = 1; i <= 4; i++) assert.equal((await api(rest.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: `p${i}`, source: 'fanout', by: 'board' })).status, 201);
    proxy.reqs.length = 0;
    const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'guest-once.mjs'), '--seat', 'gizmo'], { env: { ...process.env, SCRUM_BOARD_URL: proxy.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, `the runner ends clean: ${err}${out}`.slice(0, 300));
    assert.ok(ollama.calls >= 1, 'CONTROL: the digest was handled (the model was called)');
    const dpost = proxy.reqs.filter((q) => q.method === 'POST' && q.url.startsWith('/api/deliveries'));
    const perId = dpost.filter((q) => /^\/api\/deliveries\/[^/]+\/events/.test(q.url));
    const batch = dpost.filter((q) => q.url === '/api/deliveries/events');
    assert.equal(perId.length, 0, `none of the runner's delivery steps goes through the per-id route (${perId.length}: ${perId.slice(0, 3).map((q) => q.url).join(' , ')})`);
    assert.equal(batch.length, 3, `claim, turn-started and outcome are one request each: ${dpost.length} delivery POSTs in all (${batch.length} batch, ${perId.length} per-id)`);
    const open = await api(rest.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1');
    assert.deepEqual(open.body.deliveries ?? [], [], 'and every delivery ends settled');
  } finally { await proxy.stop(); await rest.stop(); await ollama.stop(); }
});
