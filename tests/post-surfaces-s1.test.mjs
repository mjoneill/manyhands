/**
 * THE DOCUMENT-READING SURFACES (#1574, rubric #1602): WITH THE CONVERSATIONS UNIT ON, THE ROUTES THAT SHOW POSTS SHOW THE GRAPH'S POSTS AND NEVER A REDACTED
 * ONE. Pre-registered by the separate test author BEFORE the build; shape agreed with the builder and the contract owner at 20:32Z ("one shared `postsView`, one
 * focused row per projection, one unavailable-graph control"). Copy unchanged into tests/. REAL executor, REAL REST server; without a python with pyoxigraph
 * every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 *
 * WHY (everyday correctness first, redaction second): with the unit on an ordinary post lives only in the graph, and these routes read the DOCUMENT's posts, so a
 * new post attached to a card does not show on the card, search does not find it, the status counts and the author's list miss it, and a seat's mention
 * backlog never sees it. And a post imported into the graph and redacted there is still in the document in plain text, so the same routes would show its text.
 * Both halves are silent. The fix as proposed is one helper that all of them read through (the document with the unit off; the R1 merge with it on: graph wins by
 * identity, tombstones omitted; an unreadable graph is a 503 from the route, never a document-only answer).
 *
 * THE SCENARIO (one, run twice: the unit ON, and the unit OFF as the control). Posts: V (visible, written by `bea`, attached to a card, mentions the resident),
 * W (visible, by `ada`, board level), and R (by `bea`, attached to the same card, mentions the resident). With the unit ON: R is written first with the unit OFF
 * (so the DOCUMENT holds its text), imported into the graph, and REDACTED there; V and W are then written through the API and so live only in the graph. With the
 * unit OFF: V and W only, all in the document. The same facts are then read from each surface and must be IDENTICAL in both worlds and exactly these:
 *   S1 SEARCH   `POST /api/search/all`: V is found by its words; R's words find nothing and appear nowhere in that answer.
 *   S2 STATUS   `GET /api/board/status`: `conversationsTotal` is 2; the recent list carries V and W and no word of R.
 *   S3 CARD     `GET /api/cards/:id`: `comments.total` is 1 (V; R is not counted) and its recent stubs name V and carry no word of R.
 *   S4 LOAD     `GET /api/load?conversations=1` (the whole-board read the export reads): the conversations are V and W, with no word of R anywhere in the answer.
 *   S5 PEOPLE   `GET /api/people/bea` AND the list `GET /api/people` (bea's entry): `authoredTotal` is 1 and `authored` is [V]. (R is bea's too, and is redacted.)
 *   S6 503      with the unit ON and the executor DOWN, `GET /api/cards/:id` and `GET /api/board/status` answer 503, never a document-only 200 and never a hung
 *               request (these two handlers are synchronous today; becoming async, an unhandled throw would be an unhandled rejection, not a response).
 *
 * NOT COVERED, by name: `GET /api/insights` (an ADVISORY shadow that applies nothing; it lists a seat only when that seat has model-call ledger rows, so the mention
 * backlog it computes from the document's posts is unreachable without building a ledger, and it decides nothing; the builder may route it through the same
 * helper, this file does not pin it; a probe showed the resident absent from its answer in BOTH worlds); the export itself (it reads `/api/load?conversations=1`, pinned by S4, and spawns a child; its archive is not rendered here); the echo
 * guard on card writes (`isEchoOfStored`: a miss costs one duplicate comment, a two-way door; the builder projects it with the same helper); the announcement
 * publisher's legacy scan (excluded by the builder: it reserves through the graph when the unit is on); attachments and talk-tagged posts on these routes;
 * pagination parameters of search, people and card reads; the cost of the extra reads on these routes (observed on the rehearsal copy, not asserted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'srf-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V_TXT = 'surfv-visible-graph post @gizmo alpha';
const W_TXT = 'surfw-plain-graph post beta';
const R_TXT = 'surfr-redacted-secret post @gizmo gamma';

const ROSTER_FILE = path.join(os.tmpdir(), `srf-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });

/** Boots the scenario. Returns the handles, the ids, and a `stop`. */
async function boot({ unit }) {
  let exec = null, boardFile = null, offServer = null, rId = null, cardId = null, card = null;
  if (unit) {
    // R is written with the unit OFF, so the document holds its text; the server is killed leaving its data
    offServer = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    const c = await api(offServer.baseUrl, 'POST', '/api/cards', { title: 'surface card', description: 'x', createdBy: 'ada' }); assert.ok(c.status === 200 || c.status === 201, c.text);
    card = c.body; cardId = card.id;
    const r = await api(offServer.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: R_TXT, attachedTo: cardId }); assert.equal(r.status, 201, r.text);
    rId = r.body.id;
    boardFile = offServer.boardFile;
    offServer.kill(); await sleep(400);
    exec = await startExecutor({ store: tmpStore('srf-store-'), datasetId: DSID, create: true });
    const imp = await client(exec).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${rId}`, actor: `${PERSON}board`, post: { id: rId, body: R_TXT, author: 'bea', createdAt: r.body.createdAt, attachedTo: cardId, mentions: ['gizmo'], postSeq: r.body.postSeq } });
    assert.equal(imp.outcome, 'APPLIED', JSON.stringify(imp));
    const red = await client(exec).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${rId}`, actor: `${PERSON}ada`, post: { id: rId }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() });
    assert.equal(red.outcome, 'APPLIED', JSON.stringify(red));
  }
  const rest = await startRestServer({ ...(unit ? { boardFile } : { board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }) }),
    env: { SCRUM_ROSTER_FILE: ROSTER_FILE, ...(unit ? { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) } });
  const h = { rest, exec, base: rest.baseUrl, rId, stop: async () => { await rest.stop(); if (h.exec) await killExecutor(h.exec); } };
  try {
    if (!unit) { const c = await api(h.base, 'POST', '/api/cards', { title: 'surface card', description: 'x', createdBy: 'ada' }); assert.ok(c.status === 200 || c.status === 201, c.text); card = c.body; cardId = card.id; }
    const v = await api(h.base, 'POST', '/api/conversations', { author: 'bea', body: V_TXT, attachedTo: cardId }); assert.equal(v.status, 201, v.text); await sleep(15);
    const w = await api(h.base, 'POST', '/api/conversations', { author: 'ada', body: W_TXT }); assert.equal(w.status, 201, w.text);
    Object.assign(h, { vId: v.body.id, wId: w.body.id, cardId, cardShort: card.shortId });
    if (unit) assert.ok(!JSON.stringify(rest.readBoardFile()).includes(V_TXT), 'CONTROL: V is graph-only (its text is not in the document)');
    if (unit) assert.ok(JSON.stringify(rest.readBoardFile()).includes(R_TXT), 'CONTROL: R\'s text IS still in the document (the stale copy the routes must not serve)');
    return h;
  } catch (e) { await h.stop(); throw e; }
}

/** The facts each surface shows, as plain values, so the two worlds can be compared. */
async function collect(h) {
  const search = await api(h.base, 'POST', '/api/search/all', { q: 'surfv-visible-graph', k: 8 });
  const searchR = await api(h.base, 'POST', '/api/search/all', { q: 'surfr-redacted-secret', k: 8 });
  const status = await api(h.base, 'GET', '/api/board/status');
  const card = await api(h.base, 'GET', `/api/cards/${h.cardId}`);
  const load = await api(h.base, 'GET', '/api/load?conversations=1');
  const people = await api(h.base, 'GET', '/api/people/bea');
  const peopleList = await api(h.base, 'GET', '/api/people');
  const hasR = (x) => /surfr-redacted-secret/.test(typeof x === 'string' ? x : JSON.stringify(x));
  // search echoes the caller's own query (`q`), and S1 asks with R's words: the echo is the question, not a leak, so it is not scanned
  const withoutQuery = (b) => { const { q: _q, ...rest } = b || {}; return JSON.stringify(rest); };
  const hits = (search.body?.posts?.hits || []);
  return {
    statuses: { search: search.status, searchR: searchR.status, status: status.status, card: card.status, load: load.status, people: people.status, peopleList: peopleList.status },
    S1: { vFound: hits.some((x) => String(x.snippet || '').includes('surfv-visible-graph') || x.id === `entity:${h.vId}`), rHits: (searchR.body?.posts?.hits || []).length, rAnywhere: hasR(withoutQuery(searchR.body)) || hasR(withoutQuery(search.body)) },
    S2: { total: status.body?.conversationsTotal, recent: (status.body?.recentConversations || []).map((c) => c.body).sort(), rAnywhere: hasR(status.text) },
    S3: { total: card.body?.comments?.total, recentIds: (card.body?.comments?.recent || []).map((c) => c.id), rAnywhere: hasR(card.text) },
    S4: { bodies: (load.body?.conversations || []).map((c) => c.body).sort(), rAnywhere: hasR(load.text) },
    S5: { authoredTotal: people.body?.authoredTotal, authored: people.body?.authored, list: (() => { const b = (peopleList.body?.people || []).find((x) => x.key === 'bea'); return { authoredTotal: b?.authoredTotal, authored: b?.authored }; })() },
  };
}
let memoOn = null, memoOff = null;
const answers = (unit) => {
  const run = async () => { const h = await boot({ unit }); try { return { h: { vId: h.vId, wId: h.wId, cardId: h.cardId }, a: await collect(h) }; } finally { await h.stop(); } };
  return unit ? (memoOn ||= run()) : (memoOff ||= run());
};
const both = async () => { const [on, off] = await Promise.all([answers(true), answers(false)]); return { on, off }; };
const want = async (pick) => { const { on, off } = await both(); return { on: pick(on), off: pick(off), ids: { on: on.h, off: off.h } }; };

test('S1 SEARCH: V is found by its words; R\'s words find nothing and appear nowhere in the answer; the same with the unit off', { skip: SKIP }, async () => {
  const { on, off } = await both();
  assert.deepEqual(Object.values(on.a.statuses).filter((s) => s !== 200), [], `every read answers 200 with the unit on: ${JSON.stringify(on.a.statuses)}`);
  for (const [w, x] of [['ON', on.a.S1], ['OFF', off.a.S1]]) assert.deepEqual(x, { vFound: true, rHits: 0, rAnywhere: false }, `${w}: ${JSON.stringify(x)}`);
});

test('S2 STATUS: conversationsTotal is 2 and the recent list carries V and W and no word of R; the same with the unit off', { skip: SKIP }, async () => {
  const { on, off } = await both();
  for (const [w, x] of [['ON', on.a.S2], ['OFF', off.a.S2]]) assert.deepEqual(x, { total: 2, recent: [V_TXT, W_TXT].sort(), rAnywhere: false }, `${w}: ${JSON.stringify(x)}`);
});

test('S3 CARD: comments.total is 1 (V, not R) and its recent stubs name V and carry no word of R; the same with the unit off', { skip: SKIP }, async () => {
  const { on, off } = await both();
  assert.deepEqual(on.a.S3, { total: 1, recentIds: [on.h.vId], rAnywhere: false }, `ON: ${JSON.stringify(on.a.S3)}`);
  assert.deepEqual(off.a.S3, { total: 1, recentIds: [off.h.vId], rAnywhere: false }, `OFF: ${JSON.stringify(off.a.S3)}`);
});

test('S4 LOAD (what the export reads): the conversations are V and W with no word of R anywhere in the answer; the same with the unit off', { skip: SKIP }, async () => {
  const { on, off } = await both();
  for (const [w, x] of [['ON', on.a.S4], ['OFF', off.a.S4]]) assert.deepEqual(x, { bodies: [V_TXT, W_TXT].sort(), rAnywhere: false }, `${w}: ${JSON.stringify(x)}`);
});

test('S5 PEOPLE: bea\'s authoredTotal is 1 and authored is [V] (R is hers and redacted); the same with the unit off', { skip: SKIP }, async () => {
  const { on, off } = await both();
  assert.deepEqual(on.a.S5, { authoredTotal: 1, authored: [on.h.vId], list: { authoredTotal: 1, authored: [on.h.vId] } }, `ON: ${JSON.stringify(on.a.S5)}`);
  assert.deepEqual(off.a.S5, { authoredTotal: 1, authored: [off.h.vId], list: { authoredTotal: 1, authored: [off.h.vId] } }, `OFF: ${JSON.stringify(off.a.S5)}`);
});

test('S6 AN UNREADABLE GRAPH IS A 503 ON THESE ROUTES: with the unit on and the executor down, the card read and the board status answer 503, never a document-only 200 and never a hang', { skip: SKIP }, async () => {
  const h = await boot({ unit: true });
  try {
    assert.equal((await api(h.base, 'GET', `/api/cards/${h.cardId}`)).status, 200, 'CONTROL: 200 while the executor is up');
    assert.equal((await api(h.base, 'GET', '/api/board/status')).status, 200, 'CONTROL: 200 while the executor is up');
    await killExecutor(h.exec);
    const card = await api(h.base, 'GET', `/api/cards/${h.cardId}`);
    const status = await api(h.base, 'GET', '/api/board/status');
    assert.equal(card.status, 503, `the card read: ${card.status} ${card.text.slice(0, 200)}`);
    assert.equal(status.status, 503, `the board status: ${status.status} ${status.text.slice(0, 200)}`);
  } finally { await h.stop(); }
});
