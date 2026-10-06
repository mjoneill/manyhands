/**
 * #1582 (unit 3: deliveries move into the graph as the store of record), THE REST LAYER OF C1, C2'' AND C3'. Written by the separate test author BEFORE the build, black-box through REST with a REAL
 * executor behind a proxy that can fail or go down. Synthetic content. Without a python with pyoxigraph the rows are SKIPPED, and a skip is NOT a pass. The companion file `executor-batch-atomicity-x1.test.mjs`
 * owns the executor layer (all-or-nothing on an engine fault, per-entry guards inside one update), already green.
 *
 * WHAT THIS FILE TAKES FROM THE CARD, in ONE place (the constants and `step`/`batch` below) so a different choice changes one line:
 *   - THE FLAG: `SCRUM_GRAPH_UNIT_DELIVERIES=1`, by the family of `SCRUM_GRAPH_UNIT_LOGBORN` and `SCRUM_GRAPH_UNIT_CONVERSATIONS`. THE CARD DOES NOT NAME IT. If the build names another, change `UNIT_ENV`.
 *   - THE WIRE: unchanged for readers. A step's body is today's (`{by, state, ...}`) plus `requestId`, 8-64 `[A-Za-z0-9-]`, REQUIRED with the unit on (400 `REQUEST_ID_REQUIRED`); in a batch each entry carries
 *     its delivery `id` and its own `requestId`. A batch answers 200 `{results:[{id,status,body}]}` in request order (#1617), or, on an executor error, a WHOLE-BATCH 503 and no `results`.
 *   - THE IDENTITY (C1): a delivery's id is DERIVED from `(deliveredTo, ofConversation)`, so the same pair has the same id on two independent boards; a retried create answers the existing node.
 *   - THE ORDER (C3'): steps come back in the order they were applied, including two for one delivery inside one batch.
 *
 *   Y0  CONTROL (green today): with the unit OFF a step needs no requestId: a claim answers 201.
 *   Y1  requestId IS REQUIRED AND CHECKED (unit on): a step with none answers 400 `REQUEST_ID_REQUIRED`; with 7 characters, 65, or an illegal character, 400; none of them applies. A valid one applies (201).
 *   Y2  IDENTITY IS DERIVED: two independent boards, the same `(to, conversation)`, give the SAME delivery id; a second create of the pair on one board answers 200 with that same id and leaves one delivery.
 *   Y3  TWO RACING CLAIMERS: two identical claims with DIFFERENT requestIds, sent together: exactly one 201 and one 409 naming `claimed`; the delivery has exactly one `claimed` step.
 *   Y4  A LOST-RESPONSE RETRY IS NOT A CONFLICT: the same claim with the SAME requestId sent again answers success (200 or 201), never 409, and the delivery still has exactly one `claimed` step.
 *   Y5  A NEW REQUEST AFTER SUCCESS IS A NEW INTENT: the same claim with a NEW requestId after the first applied answers 409 naming `claimed`. (Y4 and Y5 together tell "my retry" from "someone else's conflict".)
 *   Y6  A BATCH GIVES PER-ENTRY RESULTS AS TODAY: [claim a, claim a again with another requestId, claim of an unknown id, claim b] answers 200 with statuses [201, 409, 404, 201] in order, and a and b read `claimed`.
 *   Y7  AN EXECUTOR ERROR ON ONE ENTRY IS A 503 FOR THAT ENTRY (the build is PER-ENTRY, builder 19:42Z; the one-update batch with a whole-batch 503 is deferred to the per-entry-receipts card): the proxy answers ONE
 *       `/update` with a 500: that entry is a 503 with nothing applied for it, the other entries apply (201), and sending that entry again with the SAME requestId applies it.
 *   Y8  ORDER INSIDE A BATCH: [claim, turn-started] for one delivery in ONE request, for 8 deliveries, read back claim then turn-started every time.
 *   Y10 A 503 AFTER THE COMMIT, RETRIED WITH THE SAME requestIds (card C2'' correction, 19:35Z, per entry): the proxy lets ONE entry's `/update` COMMIT and drops the response: that entry is a 503 (UNKNOWN), the
 *       others 201; the same batch resent with the SAME requestIds answers every entry a success (200 or 201), never a 409, and no delivery has a second claimed step.
 *   Y11 A 503 AFTER THE COMMIT, RETRIED WITH A NEW requestId: the same drop; resending that entry with a NEW requestId answers 409 naming `claimed`, and there is still exactly one claimed step per delivery.
 *   Y12 EVERY opId REST SENDS PARSES AS AN IRI (C2'' / #1622): for a create, a step and a batch, each `x-op-id` the executor receives on `/update` is an absolute IRI (`urn:ex:op/...` in the form announcements use).
 *   Y9  EXECUTOR DOWN IS A 503, NEVER "NOT FOUND": with the executor unreachable a step answers 503 (not 404, not 409, not 201) and a create answers 503; with it back, the same step (same requestId) applies.
 *
 * NOT COVERED, by name: the model-call half (C4+); per-entry RECEIPTS' exact shape (the contract says each entry writes its own outcome; the rows see only the results the wire already carries); the attempt cap
 * (proposed server-side, not agreed); lease and owner checks (client-side, out of this unit); `source` on a second create (the card leaves 200-unchanged versus refused open); `core/ask-shape.mjs`, redaction of
 * `postedText`, `/api/changes`; the migration of existing deliveries and its volume; the runner (`guest-once.mjs`) end to end against the graph form (the #1617 D3 row still owns the runner's batching); a crash during
 * an update.
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
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_DELIVERIES';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROSTER_FILE = path.join(os.tmpdir(), `y1-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const iso = (ageMin) => new Date(Date.now() - ageMin * 60000).toISOString();
const post = (id, seq) => ({ id, body: `delivered post ${id}`, author: 'ada', attachedTo: null, attachments: [], mentions: ['gizmo'], postSeq: seq, createdAt: iso(5) });
const board = (n) => makeBoardFixture({ conversations: Array.from({ length: n }, (_, i) => post(`p${i + 1}`, i + 1)), postSeqEpoch: EPOCH_DOC, nextPostSeq: n + 1 });
let rq = 0; const RID = (tag) => `y1-${tag}-${process.pid}-${Date.now().toString(36)}-${++rq}`.slice(0, 64);
const idOf = (b) => b?.id ?? b?.['@id'];
const stateOf = (b) => b?.state ?? b?.deliveryState ?? b?.events?.at?.(-1)?.state ?? null;
/** THE WIRE, in one place. */
const step = (base, id, state, requestId, extra = {}) => api(base, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { by: 'gizmo', state, ...(requestId === undefined ? {} : { requestId }), ...extra });
const batch = (base, entries) => api(base, 'POST', '/api/deliveries/events', entries);
const entry = (id, state, requestId, extra = {}) => ({ id, by: 'gizmo', state, ...(requestId === undefined ? {} : { requestId }), ...extra });
const create = (base, conv) => api(base, 'POST', '/api/deliveries', { to: 'gizmo', conversation: conv, source: 'fanout', by: 'board' });
const listed = async (base) => (await api(base, 'GET', '/api/deliveries?to=gizmo')).body?.deliveries ?? [];
const eventsOf = async (base, id) => { const d = (await listed(base)).find((x) => idOf(x) === id); return (d?.events ?? []).map((e) => e.state); };

async function startProxy(execUrl) {
  const p = { failNext: false, failed: 0, dropAfterForwardNext: false, dropped: 0, ops: [] };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === 'POST' && req.url === '/update' && req.headers['x-op-id']) p.ops.push(String(req.headers['x-op-id']));
    if (p.failNext && req.method === 'POST' && req.url === '/update') { p.failNext = false; p.failed++; res.statusCode = 500; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: 'injected engine error' })); }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text();
      // the COMMIT happened; the caller never hears about it (a lost response, a timeout after the write)
      if (p.dropAfterForwardNext && req.method === 'POST' && req.url === '/update') { p.dropAfterForwardNext = false; p.dropped++; try { req.socket.destroy(); } catch { /* gone */ } return; }
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function unitOn(n, body, { dsid = 'y1-test' } = {}) {
  const exec = await startExecutor({ store: tmpStore('y1-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: board(n), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try {
    const ids = [];
    for (let i = 1; i <= n; i++) { const d = await create(rest.baseUrl, `p${i}`); assert.equal(d.status, 201, `CONTROL setup: the create answers 201 (${d.status} ${d.text.slice(0, 160)})`); ids.push(idOf(d.body)); }
    return await body({ base: rest.baseUrl, ids, proxy });
  } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}

test('Y0 CONTROL: with the unit OFF a step needs no requestId and a claim answers 201', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: board(1), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const d = await create(rest.baseUrl, 'p1'); assert.equal(d.status, 201);
    const r = await step(rest.baseUrl, idOf(d.body), 'claimed');
    assert.equal(r.status, 201, `${r.status} ${r.text.slice(0, 200)}`); assert.equal(stateOf(r.body), 'claimed');
  } finally { await rest.stop(); }
});

test('Y1 requestId IS REQUIRED AND CHECKED (unit on): none -> 400 REQUEST_ID_REQUIRED; too short, too long, illegal -> 400; none applies; a valid one applies', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(1, async ({ base, ids }) => {
    const none = await step(base, ids[0], 'claimed');
    assert.equal(none.status, 400, `a step without a requestId is refused (${none.status} ${none.text.slice(0, 160)})`);
    assert.equal(none.body?.code, 'REQUEST_ID_REQUIRED', `and the refusal says why (${none.text.slice(0, 160)})`);
    for (const [why, v] of [['7 characters', 'abcdefg'], ['65 characters', 'a'.repeat(65)], ['an illegal character', 'abcd efgh!']]) {
      const r = await step(base, ids[0], 'claimed', v); assert.equal(r.status, 400, `${why}: ${r.status} ${r.text.slice(0, 160)}`);
    }
    assert.deepEqual(await eventsOf(base, ids[0]), ['offered'], 'none of the refused steps applied (the delivery is still just offered)');
    const ok = await step(base, ids[0], 'claimed', RID('ok'));
    assert.equal(ok.status, 201, `a valid requestId applies (${ok.status} ${ok.text.slice(0, 160)})`);
  });
});

test('Y2 IDENTITY IS DERIVED: two independent boards give the same id for the same (to, conversation); a second create answers 200 with that id', { skip: SKIP, timeout: 240000 }, async () => {
  const seen = [];
  for (const dsid of ['y1-id-a', 'y1-id-b']) await unitOn(1, async ({ base, ids }) => {
    seen.push(ids[0]);
    const again = await create(base, 'p1');
    assert.equal(again.status, 200, `a second create of the pair answers 200, unchanged (${again.status} ${again.text.slice(0, 160)})`);
    assert.equal(idOf(again.body), ids[0], 'with the same id');
    assert.equal((await listed(base)).length, 1, 'and there is one delivery for the pair');
  }, { dsid });
  assert.ok(seen[0] && seen[1], 'both boards created a delivery');
  assert.equal(seen[0], seen[1], `the id is derived from (deliveredTo, ofConversation), so independent boards agree (${seen[0]} vs ${seen[1]}): a random id would differ`);
});

test('Y3 TWO RACING CLAIMERS: identical claims with different requestIds, sent together: exactly one 201, one 409 naming claimed, and one claimed step', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(1, async ({ base, ids }) => {
    const [a, b] = await Promise.all([step(base, ids[0], 'claimed', RID('race-a')), step(base, ids[0], 'claimed', RID('race-b'))]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [201, 409], `one winner and one conflict (${a.status}, ${b.status}): ${a.text.slice(0, 100)} | ${b.text.slice(0, 100)}`);
    const loser = a.status === 409 ? a : b; assert.equal(loser.body?.state, 'claimed', 'the 409 names the state');
    assert.deepEqual((await eventsOf(base, ids[0])).filter((s) => s === 'claimed'), ['claimed'], 'exactly one claimed step');
  });
});

test('Y4/Y5 A LOST-RESPONSE RETRY IS NOT A CONFLICT, A NEW REQUEST AFTER SUCCESS IS: same requestId again -> success and one step; a new requestId -> 409 naming claimed', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(1, async ({ base, ids }) => {
    const R = RID('retry');
    const first = await step(base, ids[0], 'claimed', R); assert.equal(first.status, 201, `${first.status} ${first.text.slice(0, 160)}`);
    const retry = await step(base, ids[0], 'claimed', R);
    assert.ok(retry.status === 200 || retry.status === 201, `Y4: the same caller's retry gets its OWN outcome back, not a conflict (${retry.status} ${retry.text.slice(0, 160)})`);
    assert.equal(stateOf(retry.body), 'claimed', 'Y4: and it reads claimed');
    assert.deepEqual((await eventsOf(base, ids[0])).filter((s) => s === 'claimed'), ['claimed'], 'Y4: still exactly one claimed step');
    const other = await step(base, ids[0], 'claimed', RID('other'));
    assert.equal(other.status, 409, `Y5: a new requestId after success is a new intent and its guard fails (${other.status} ${other.text.slice(0, 160)})`);
    assert.equal(other.body?.state, 'claimed', 'Y5: and the 409 names the state');
  });
});

test('Y6 A BATCH GIVES PER-ENTRY RESULTS AS TODAY: [claim a, claim a again, claim unknown, claim b] -> [201, 409, 404, 201], a and b claimed', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(2, async ({ base, ids }) => {
    const r = await batch(base, [entry(ids[0], 'claimed', RID('b1')), entry(ids[0], 'claimed', RID('b2')), entry('https://scrumboard.local/delivery/no-such-delivery', 'claimed', RID('b3')), entry(ids[1], 'claimed', RID('b4'))]);
    assert.equal(r.status, 200, `${r.status} ${r.text.slice(0, 200)}`);
    assert.deepEqual((r.body?.results ?? []).map((x) => x.status), [201, 409, 404, 201], `statuses in request order (${JSON.stringify(r.body?.results?.map((x) => x.status))})`);
    assert.deepEqual([await eventsOf(base, ids[0]), await eventsOf(base, ids[1])], [['offered', 'claimed'], ['offered', 'claimed']], 'a and b are claimed, once each');
  });
});

test('Y7 AN EXECUTOR ERROR ON ONE ENTRY IS A 503 FOR THAT ENTRY: nothing applied for it, the others apply, and the same requestId applies it on a resend', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(3, async ({ base, ids, proxy }) => {
    const rids = ids.map((_, i) => RID(`f${i}`));
    proxy.failNext = true;
    const r = await batch(base, ids.map((id, i) => entry(id, 'claimed', rids[i])));
    assert.equal(proxy.failed, 1, 'CONTROL: the proxy failed exactly one /update (the entries went through the executor; a build that never uses it cannot pass this row)');
    assert.equal(r.status, 200, `the batch itself answers (${r.status} ${r.text.slice(0, 200)})`);
    const codes = (r.body?.results ?? []).map((x) => x.status);
    assert.equal(codes.filter((c) => c === 503).length, 1, `exactly one entry is a 503 (${JSON.stringify(codes)})`);
    assert.equal(codes.filter((c) => c === 201).length, 2, `and the other two applied (${JSON.stringify(codes)})`);
    const failedIdx = codes.indexOf(503);
    assert.deepEqual(await eventsOf(base, ids[failedIdx]), ['offered'], 'nothing applied for the failed entry');
    const again = await step(base, ids[failedIdx], 'claimed', rids[failedIdx]);
    assert.equal(again.status, 201, `sending that entry again with the SAME requestId applies it (${again.status} ${again.text.slice(0, 160)})`);
  });
});

test('Y8 ORDER INSIDE A BATCH: [claim, turn-started] for one delivery in one request reads back claim then turn-started, for 8 deliveries', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(8, async ({ base, ids }) => {
    const r = await batch(base, ids.flatMap((id, i) => [entry(id, 'claimed', RID(`o${i}c`)), entry(id, 'turn-started', RID(`o${i}t`))]));
    assert.equal(r.status, 200, `${r.status} ${r.text.slice(0, 200)}`);
    assert.deepEqual((r.body?.results ?? []).map((x) => x.status), Array(16).fill(201), 'every entry applied');
    for (const id of ids) assert.deepEqual(await eventsOf(base, id), ['offered', 'claimed', 'turn-started'], `in order for ${id}`);
  });
});

const lostResponseBatch = async (base, proxy, entries) => { proxy.dropAfterForwardNext = true; const r = await batch(base, entries); assert.equal(proxy.dropped, 1, 'CONTROL: the proxy let exactly one /update commit and dropped its response (a build that never uses the executor cannot pass)'); return r; };

test('Y10 A 503 AFTER THE COMMIT, RETRIED WITH THE SAME requestIds: every entry then answers a success and no step is duplicated', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(3, async ({ base, ids, proxy }) => {
    const rids = ids.map((_, i) => RID(`l${i}`)); const entries = () => ids.map((id, i) => entry(id, 'claimed', rids[i]));
    const lost = await lostResponseBatch(base, proxy, entries());
    const first = (lost.body?.results ?? []).map((x) => x.status);
    assert.equal(first.filter((c) => c === 503).length, 1, `exactly one entry is a 503: the caller cannot know whether it applied (${JSON.stringify(first)} ${lost.text.slice(0, 160)})`);
    const again = await batch(base, entries());
    assert.equal(again.status, 200, `${again.status} ${again.text.slice(0, 200)}`);
    const codes = (again.body?.results ?? []).map((x) => x.status);
    assert.equal(codes.length, 3, `three results (${JSON.stringify(codes)})`);
    assert.ok(codes.every((c) => c === 200 || c === 201), `the retry with the SAME requestIds gets every ORIGINAL outcome back (the committed ones, the one whose response was lost, a success 200 or 201 as the build chooses), never a 409 (${JSON.stringify(codes)})`);
    for (const id of ids) assert.deepEqual((await eventsOf(base, id)).filter((s) => s === 'claimed'), ['claimed'], 'and no delivery has a second claimed step');
  });
});

test('Y11 A 503 AFTER THE COMMIT, RETRIED WITH A NEW requestId: 409 naming claimed, still one claimed step per delivery', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(3, async ({ base, ids, proxy }) => {
    const lost = await lostResponseBatch(base, proxy, ids.map((id, i) => entry(id, 'claimed', RID(`n${i}`))));
    const codes = (lost.body?.results ?? []).map((x) => x.status); const idx = codes.indexOf(503);
    assert.ok(idx >= 0, `one entry is a 503 (${JSON.stringify(codes)})`);
    const fresh = await step(base, ids[idx], 'claimed', RID('new'));
    assert.equal(fresh.status, 409, `a NEW requestId is a new intent and its guard fails against the committed claim (${fresh.status} ${fresh.text.slice(0, 160)})`);
    assert.equal(fresh.body?.state, 'claimed', 'and the 409 names the state');
    for (const id of ids) assert.deepEqual((await eventsOf(base, id)).filter((s) => s === 'claimed'), ['claimed'], 'still exactly one claimed step per delivery: a retry with a new id did not claim twice');
  });
});

test('Y12 EVERY opId REST SENDS PARSES AS AN IRI: a create, a step and a batch each reach the executor with an absolute IRI as x-op-id', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(3, async ({ base, ids, proxy }) => {
    const before = proxy.ops.length;
    assert.equal((await step(base, ids[0], 'claimed', RID('iri1'))).status, 201);
    assert.equal((await batch(base, [entry(ids[1], 'claimed', RID('iri2')), entry(ids[2], 'claimed', RID('iri3'))])).status, 200);
    const created = (await create(base, 'p1')); assert.ok(created.status === 200 || created.status === 201);
    const sent = proxy.ops.slice(before);
    assert.ok(sent.length >= 2, `CONTROL: the step, the batch and the create reached the executor (${sent.length} /update calls seen); a build that does not use it cannot pass`);
    for (const op of sent) {
      assert.ok(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(op), `x-op-id is an absolute IRI with no character a SPARQL <IRI> forbids: ${JSON.stringify(op)}`);
      assert.doesNotThrow(() => new URL(op), `and it parses: ${op}`);
    }
  });
});

test('Y9 EXECUTOR DOWN IS A 503, NEVER "NOT FOUND": a step and a create answer 503; with it back the same step applies', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(2, async ({ base, ids, proxy }) => {
    await proxy.down();
    const R = RID('down');
    const s = await step(base, ids[0], 'claimed', R);
    assert.equal(s.status, 503, `a step with the executor unreachable is a 503, not a 404/409/201 (${s.status} ${s.text.slice(0, 200)})`);
    const c = await create(base, 'p2');
    assert.equal(c.status, 503, `and a create is a 503 (${c.status} ${c.text.slice(0, 200)})`);
    await sleep(500); await proxy.up();
    const ok = await step(base, ids[0], 'claimed', R);
    assert.equal(ok.status, 201, `with it back, the same step (same requestId) applies: the 503 recorded nothing (${ok.status} ${ok.text.slice(0, 200)})`);
  });
});
