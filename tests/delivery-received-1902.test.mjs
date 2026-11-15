/**
 * #1902 Half 1 — THE SEAT'S OWN RECEIPT: `POST /api/deliveries/:id/events {state: 'received'}`, written by the side of the seat
 * the row is for (its connector), once its runtime holds the post. Against a real scratch executor, observe auth with real seat
 * credentials (the shape production runs: conversations, deliveries and log-born units on).
 *
 * INTERFACE PINNED HERE:
 *   - `received` is a FACT BESIDE THE STEPS, like the read mark: the row's wire gains `received: { by, at }`. It is never in
 *     `events`, never changes `state`, and never bumps the row's version, so a runner's claimed → turn-started cannot be
 *     refused DELIVERY_CHANGED because a receipt landed in between.
 *   - WHO: the request's own credential, judged as a graph write is (LOGBORN.actorFor), never the body's `by`. Only the row's
 *     own seat (`to`): another seat is 403 SEAT_NOT_SELF; no key is 401 GRAPH_WRITE_UNAUTHENTICATED.
 *   - ONCE PER ROW, idempotent by requestId: the same requestId reads its outcome back (200); a new requestId on a row that
 *     already holds a receipt answers 200 with the first receipt unchanged.
 *
 *   R1  the row's seat writes `received`: 201, `received.by` is the seat, state and events unchanged; the same requestId again is
 *       200 with the same `at`; a new requestId is 200 with the same `at`
 *   R2  another seat's `received` is 403 SEAT_NOT_SELF and an anonymous one is 401; neither records anything
 *   R3  the resident runner's sequence (claimed, turn-started, published) runs as before, also when `received` lands between
 *       claimed and turn-started; the receipt leaves the row's version where it was
 *   R4  the connector's order (received, claimed, turn-started, published) is accepted, source presence-bridge
 *   R5  a redacted post's row keeps no content: not in the row's triples, its steps, its receipt, or its wire
 *   R6  the edges: an unknown delivery is 404, a missing requestId 400, and with the deliveries unit off `received` is refused
 *       with nothing written
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { BK } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const RS = 'https://scrumboard.local/ns#';
const DSID = 'rcv-1902';
// invented seats: ada writes posts, gizmo is the row's seat, kit is another seat with a key
const KEYED = ['ada', 'gizmo', 'kit'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rcv-1902-'));
const DATA = path.join(TMP, 'data'); fs.mkdirSync(DATA);
const ROSTER = path.join(TMP, 'roster.json');
fs.writeFileSync(ROSTER, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, kit: { name: 'Kit', glyph: 'k', color: '#a07cc4' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' },
} }));
const TOK = Object.fromEntries(KEYED.map((s) => [s, mintToken()]));
const TOKENS = path.join(TMP, 'seat-tokens.json');
{
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(TOKENS, JSON.stringify({ seats: Object.fromEntries(KEYED.map((s) => [s, { credentials: [{ tokenHash: hashToken(TOK[s]), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }])) }));
}

let exec, rest, gc;
const EXEC_STORE = SKIP ? null : tmpStore('rcv-1902-store-');
before(async () => {
  if (SKIP) return;
  exec = await startExecutor({ store: EXEC_STORE, datasetId: DSID, create: true });
  gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'rcv-1902-test' });
  rest = await startRestServer({ board: makeBoardFixture(), env: {
    SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '', SCRUM_DATA_DIR: DATA,
    SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl,
    SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1',
  } });
});
after(async () => {
  if (rest) await rest.stop();
  if (exec) await killExecutor(exec);
  for (const d of [TMP, EXEC_STORE]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (method, route, payload, seat = null, base = rest.baseUrl) => {
  const headers = { ...(seat ? { authorization: `Bearer ${TOK[seat]}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(`${base}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
};
const RID = () => `r-${crypto.randomUUID()}`;
const say = async (body) => { const r = await call('POST', '/api/conversations', { author: 'ada', body }, 'ada'); assert.equal(r.status, 201, r.text); return r.json; };
/** A post and gizmo's row for it, offered the way the fanout offers one. */
async function rowFor(body = `@gizmo ${crypto.randomUUID()}`) {
  const p = await say(body);
  const d = await call('POST', '/api/deliveries', { to: 'gizmo', conversation: p.id, source: 'fanout', by: 'board' });
  assert.equal(d.status, 201, `CONTROL setup: the offer answers 201 (${d.text.slice(0, 200)})`);
  return { post: p, id: d.json.id };
}
const rowOf = async (id, postId) => (await call('GET', `/api/deliveries?conversation=${encodeURIComponent(postId)}`)).json.deliveries.find((d) => d.id === id);
/** The connector's receipt: its seat's own key; `by` is sent as the connector sends it, and is not what decides. */
const received = (id, seat, requestId = RID(), extra = {}) => call('POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { by: seat ?? 'gizmo', state: 'received', source: 'presence-bridge', requestId, ...extra }, seat);
/** The resident runner's steps, as guest-once sends them: the batch route, no receipt. */
const runner = async (id, state, extra = {}) => (await call('POST', '/api/deliveries/events', [{ id, by: 'gizmo', state, source: 'guest-runner', requestId: RID(), ...extra }])).json.results[0];
const verOf = async (iri) => {
  const r = await gc.query(`SELECT ?v WHERE { GRAPH ${BK} { <${iri}> <urn:ex:ver> ?v } }`);
  assert.ok(r.ok, r.reason); return r.rows.length ? Number(r.rows[0].v.value) : null;
};

test('R1 the row\'s seat writes received: 201 with received.by; same requestId 200, same at; a new requestId 200, the first receipt stands', T, async () => {
  const { post, id } = await rowFor();
  const rid = RID();
  const r = await received(id, 'gizmo', rid);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.received?.by, 'gizmo', 'the receipt names the credential\'s seat');
  assert.ok(Date.parse(r.json.received.at) > 0, 'and when the board was told');
  assert.equal(r.json.state, 'offered', 'the receipt is not a step: the state is the steps\'');
  assert.deepEqual(r.json.events.map((e) => e.state), ['offered'], 'and it is not in events');
  const again = await received(id, 'gizmo', rid);
  assert.equal(again.status, 200, `the same requestId reads its outcome back (${again.text.slice(0, 200)})`);
  assert.equal(again.json.received?.at, r.json.received.at);
  const second = await received(id, 'gizmo');
  assert.equal(second.status, 200, `a second receipt on the row is not a conflict (${second.text.slice(0, 200)})`);
  assert.equal(second.json.received?.at, r.json.received.at, 'the first receipt stands');
  const listed = await rowOf(id, post.id);
  assert.deepEqual(listed.received, r.json.received, 'GET /api/deliveries carries the receipt');
  assert.deepEqual(listed.events.map((e) => e.state), ['offered']);
});

test('R2 another seat\'s received is 403 SEAT_NOT_SELF; an anonymous one is 401; neither records anything', T, async () => {
  const { post, id } = await rowFor();
  const other = await received(id, 'kit');
  assert.equal(other.status, 403, other.text);
  assert.equal(other.json?.code, 'SEAT_NOT_SELF');
  const claimsToBe = await received(id, 'kit', RID(), { by: 'gizmo' });
  assert.equal(claimsToBe.status, 403, `the body's by does not decide (${claimsToBe.text.slice(0, 200)})`);
  const anon = await call('POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { by: 'gizmo', state: 'received', source: 'presence-bridge', requestId: RID() });
  assert.equal(anon.status, 401, anon.text);
  assert.equal(anon.json?.code, 'GRAPH_WRITE_UNAUTHENTICATED');
  const row = await rowOf(id, post.id);
  assert.equal(row.received, undefined, 'nothing was recorded');
  assert.deepEqual(row.events.map((e) => e.state), ['offered']);
});

test('R3 the runner\'s claimed, turn-started, published run as before, also with received between claimed and turn-started', T, async () => {
  for (const withReceipt of [false, true]) {
    const { post, id } = await rowFor();
    assert.equal((await runner(id, 'runner-claimed')).status, 201);
    const verAtClaim = await verOf(id);
    if (withReceipt) {
      assert.equal((await received(id, 'gizmo')).status, 201);
      assert.equal(await verOf(id), verAtClaim, 'the receipt leaves the row\'s version where the claim put it');
    }
    const ts = await runner(id, 'turn-started');
    assert.equal(ts.status, 201, `turn-started follows claimed (receipt: ${withReceipt}): ${JSON.stringify(ts.body).slice(0, 200)}`);
    assert.equal((await runner(id, 'published')).status, 201);
    const row = await rowOf(id, post.id);
    assert.deepEqual(row.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'published'], 'the steps are the runner\'s, exactly');
    assert.equal(row.state, 'published');
    assert.equal(row.received?.by, withReceipt ? 'gizmo' : undefined);
  }
});

test('R4 the connector\'s order: received, claimed, turn-started, published, all accepted', T, async () => {
  const { post, id } = await rowFor();
  const step = (state) => call('POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { by: 'gizmo', state, source: 'presence-bridge', requestId: RID() }, 'gizmo');
  const r = await received(id, 'gizmo');
  assert.equal(r.status, 201, r.text);
  for (const s of ['claimed', 'turn-started', 'published']) { const x = await step(s); assert.equal(x.status, 201, `${s}: ${x.text.slice(0, 200)}`); }
  const row = await rowOf(id, post.id);
  assert.deepEqual(row.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'published']);
  assert.equal(row.received.by, 'gizmo');
  assert.ok(row.received.at <= row.events[1].at, 'the receipt came before the claim');
});

test('R5 a redacted post\'s row keeps no content: not in its triples, its steps, its receipt or its wire', T, async () => {
  const SECRET = `zebra-${crypto.randomUUID().slice(0, 8)}`;
  const { post, id } = await rowFor(`@gizmo the word is ${SECRET}`);
  assert.equal((await received(id, 'gizmo', RID(), { note: `held ${SECRET}` })).status, 201);
  assert.equal((await runner(id, 'runner-claimed')).status, 201);
  const red = await gc.update({ kind: 'post.redact', opId: `urn:ex:op/redact-${crypto.randomUUID()}`, actor: 'https://scrumboard.local/person/board', post: { id: post.id }, authorityRef: 'test:1902', occurredAt: new Date().toISOString() });
  assert.equal(red.outcome, 'APPLIED', JSON.stringify(red));
  const triples = await gc.query(`SELECT ?s ?p ?o WHERE { { BIND(<${id}> AS ?s) <${id}> ?p ?o } UNION { ?s <${RS}stepOf> <${id}> ; ?p ?o } }`);
  assert.ok(triples.ok && triples.rows.some((x) => x.p.value === `${RS}receivedAt`), 'PRECONDITION: the row, its steps and its receipt were read');
  assert.equal(JSON.stringify(triples.rows).includes(SECRET), false, 'no triple of the row, its steps or its receipt carries the text');
  const row = await rowOf(id, post.id);
  assert.equal(row.received.by, 'gizmo');
  assert.equal(JSON.stringify(row).includes(SECRET), false);
});

test('R6 an unknown delivery is 404, a missing requestId 400; with the deliveries unit off received is refused and nothing is written', T, async () => {
  const unknown = await received('00000000-0000-4000-8000-000000000000', 'gizmo');
  assert.equal(unknown.status, 404, unknown.text);
  const { id } = await rowFor();
  const none = await call('POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { by: 'gizmo', state: 'received' }, 'gizmo');
  assert.equal(none.status, 400, none.text);
  assert.equal(none.json?.code, 'REQUEST_ID_REQUIRED');
  const doc = await startRestServer({ board: makeBoardFixture({ conversations: [{ id: 'p1', body: 'x', author: 'ada', attachedTo: null, attachments: [], mentions: ['gizmo'], postSeq: 1, createdAt: new Date().toISOString() }], nextPostSeq: 2 }), env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' } });
  try {
    const d = await call('POST', '/api/deliveries', { to: 'gizmo', conversation: 'p1', source: 'fanout', by: 'board' }, null, doc.baseUrl);
    assert.equal(d.status, 201, d.text);
    const r = await call('POST', `/api/deliveries/${encodeURIComponent(d.json.id)}/events`, { by: 'gizmo', state: 'received', requestId: RID() }, 'gizmo', doc.baseUrl);
    assert.equal(r.status, 400, r.text);
    assert.match(r.json?.error ?? '', /received/);
    const list = await call('GET', '/api/deliveries?to=gizmo', null, null, doc.baseUrl);
    assert.equal(list.json.deliveries[0].received, undefined);
    assert.deepEqual(list.json.deliveries[0].events.map((e) => e.state), ['offered']);
  } finally { await doc.stop(); }
});
