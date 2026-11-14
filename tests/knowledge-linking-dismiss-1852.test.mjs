/**
 * #1852 — A DISMISS IS ONE SEAT'S; TWO DISTINCT SEATS RETIRE A LINK. Over REST with the log-born unit in observe mode with
 * real seat credentials (production's shape), plus the pure rules that decide which case a dismiss is.
 *
 * WHY: link_decide is about to be held by every agent on the board. Until now ONE seat's dismiss set the link's status to
 * "dismissed" for everyone, for good, in a place nobody looks. Now a dismiss hides the link from the seat that gave it, and
 * the link is retired only when a second, different seat's standing verdict is also a dismiss. The compiler's guard for the
 * retiring write is pinned in knowledge-linking-decide-1851 (D7-D13); here is what a seat sees.
 *
 * INTERFACE PINNED HERE:
 *   standingVerdicts(decisions)        decisions: [{ decision, by, verdict, at }] → Map(by → her LATEST decision)
 *   retiringDecision(decisions, actor) → the decision IRI of ANOTHER seat's standing dismissal, or null
 *   dismissalCount(decisions)          → how many seats' standing verdict is dismissed
 *   POST /api/links/:id/decide { verdict: 'dismissed' } → 200 { …, hidden: 'for you' | 'for everyone' }
 *   GET  /api/links rows carry `dismissals`; `status` stays the stored status
 *
 *   V1  a seat's standing verdict is her latest decision
 *   V2  the retiring decision is another seat's standing dismissal: never the writer's own, never one its seat replaced
 *   V3  dismissals counts seats, not decisions
 *   P1  a first dismiss: hidden "for you", the stored status untouched, the list shows it proposed with dismissals 1
 *   P2  it is hidden from that seat's delivery only: another seat is still handed it
 *   P3  a second, different seat's dismiss: hidden "for everyone", status dismissed, nobody is handed it
 *   P4  the same seat dismissing twice retires nothing
 *   P5  a confirm after one dismiss: status confirmed; the seat that dismissed is still not handed it, another seat is
 *   P6  a link already dismissed under the old rule (one seat, status dismissed) stays out for everyone, and is not reinterpreted
 *   P7  a seat that dismissed and then confirmed is handed the link again: her standing verdict is the confirm
 *   P8  a confirm's answer carries no `hidden`
 *   P9  the list's `means` states the two-seat rule
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { linkIri, spanKey, standingVerdicts, retiringDecision, dismissalCount } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';
import { seatActor } from '../core/graph-auth.mjs';

const A = 'urn:ex:seat/seat-a'; const B = 'urn:ex:seat/seat-b';
const dec = (n, by, verdict, at) => ({ decision: `https://scrumboard.local/link/x/decision/${n}`, by, verdict, at });

test('V1 a seat\'s standing verdict is her latest decision', () => {
  const got = standingVerdicts([dec(1, A, 'dismissed', '2026-11-14T10:00:00.000Z'), dec(2, A, 'confirmed', '2026-11-14T11:00:00.000Z'), dec(3, B, 'dismissed', '2026-11-14T09:00:00.000Z')]);
  assert.deepEqual([got.get(A).verdict, got.get(B).verdict], ['confirmed', 'dismissed']);
  const tie = standingVerdicts([dec(2, A, 'confirmed', '2026-11-14T10:00:00.000Z'), dec(1, A, 'dismissed', '2026-11-14T10:00:00.000Z')]);
  assert.equal(tie.get(A).decision.endsWith('/2'), true, 'the same instant is ordered by the decision IRI, whatever order the rows came in');
});

test('V2 the retiring decision is another seat\'s standing dismissal: never the writer\'s own, never one its seat replaced', () => {
  const theirs = dec(1, B, 'dismissed', '2026-11-14T10:00:00.000Z');
  assert.equal(retiringDecision([theirs], A), theirs.decision);
  assert.equal(retiringDecision([theirs], B), null, 'her own dismissal retires nothing');
  assert.equal(retiringDecision([theirs, dec(2, B, 'confirmed', '2026-11-14T11:00:00.000Z')], A), null, 'a dismissal its seat replaced is not standing');
  assert.equal(retiringDecision([], A), null);
});

test('V3 dismissals counts seats, not decisions', () => {
  assert.equal(dismissalCount([dec(1, A, 'dismissed', '2026-11-14T10:00:00.000Z'), dec(2, A, 'dismissed', '2026-11-14T11:00:00.000Z')]), 1);
  assert.equal(dismissalCount([dec(1, A, 'dismissed', '2026-11-14T10:00:00.000Z'), dec(2, B, 'dismissed', '2026-11-14T11:00:00.000Z')]), 2);
  assert.equal(dismissalCount([dec(1, A, 'dismissed', '2026-11-14T10:00:00.000Z'), dec(2, A, 'confirmed', '2026-11-14T11:00:00.000Z')]), 0);
});

// ── over REST ────────────────────────────────────────────────────────────────────────────────────────────────────────
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const SEATS = ['seat-a', 'seat-b', 'seat-c'];

const ROSTER = path.join(os.tmpdir(), `kd1852d-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ...Object.fromEntries(SEATS.map((s) => [s, { name: s, glyph: s.at(-1), color: '#7cc4a0' }])), board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = Object.fromEntries(SEATS.map((s) => [s, mintToken()]));
const TOKENS = path.join(os.tmpdir(), `kd1852d-tokens-${process.pid}.json`);
{
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(TOKENS, JSON.stringify({ seats: Object.fromEntries(SEATS.map((s) => [s, { credentials: [{ tokenHash: hashToken(TOK[s]), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }])) }));
}
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });

let w, gc;
before(async () => {
  if (SKIP) return;
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' } });   // observe: production's mode
  gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kd1852d' });
});
after(async () => { if (w) await w.stop(); });

const call = async (seat, method, route, payload) => {
  const headers = { ...(seat ? { authorization: `Bearer ${TOK[seat]}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const x = await fetch(`${w.rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
};
const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, r.reason); return r.rows; };
async function raw(body) {
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
}
async function newCard() {
  const r = await call('seat-a', 'POST', '/api/cards', { title: `a card ${crypto.randomUUID()}`, by: 'seat-a' });
  assert.ok(r.status === 200 || r.status === 201, `PRECONDITION: the card was created (${r.status} ${r.text.slice(0, 200)})`);
  return { id: r.json.id, shortId: r.json.shortId };
}
/** A claim proposed as bearing on `card`, written raw: the linker is not under test. `extra` is more triples for the fixture. */
async function seedLink(card, { status = 'proposed', extra = () => '' } = {}) {
  const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  const span = `a verbatim span ${assertion}`;
  const link = linkIri(spanKey(span, card.id));
  await raw(`INSERT DATA { <${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} ; <${RS}gist> "the gist" .
    <${link}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${assertion}> ; <${RS}bearsOnCard> <${cardIriOf(card.id)}> ; <${RS}score> "0.7" ; <${RS}status> "${status}" . ${extra(link)} }`);
  return { link, id: link.split('/').pop() };
}
const statusOf = async (link) => (await q(`SELECT ?s WHERE { <${link}> <${RS}status> ?s }`)).map((r) => r.s.value);
const decide = (seat, s, verdict, workingOn) => call(seat, 'POST', `/api/links/${s.id}/decide`, { verdict, ...(workingOn ? { workingOn } : {}), by: seat });
/** What a seat is handed with the card: claim it, read the block, release it. A claim shows the card's set every time. */
async function handed(seat, card) {
  const r = await call(seat, 'POST', `/api/cards/${card.shortId}/claim`, { by: seat });
  assert.equal(r.status, 200, `PRECONDITION: ${seat} claimed the card (${r.text})`);
  const rel = await call(seat, 'DELETE', `/api/cards/${card.shortId}/claim`, { by: seat });
  assert.equal(rel.status, 200, rel.text);
  assert.equal(r.json.roomHasRead?.unavailable, undefined, `PRECONDITION: the delivery was read (${r.text})`);
  return (r.json.roomHasRead?.items ?? []).map((i) => i.link);
}
const listed = async (card, s) => {
  const r = await call('seat-a', 'GET', `/api/links?card=${card.shortId}`);
  assert.equal(r.status, 200, r.text);
  return r.json.links.find((l) => l.id === s.id);
};

test('P1 a first dismiss: hidden "for you", the stored status untouched, the list shows it proposed with dismissals 1', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  assert.equal((await listed(card, s)).dismissals, 0, 'PRECONDITION: nobody has dismissed it');
  const r = await decide('seat-a', s, 'dismissed');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.hidden, 'for you');
  assert.deepEqual(await statusOf(s.link), ['proposed']);
  const row = await listed(card, s);
  assert.deepEqual({ status: row.status, dismissals: row.dismissals }, { status: 'proposed', dismissals: 1 });
});

test('P2 it is hidden from that seat\'s delivery only: another seat is still handed it', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  assert.deepEqual(await handed('seat-a', card), [s.id], 'PRECONDITION: before her dismiss she is handed it');
  assert.equal((await decide('seat-a', s, 'dismissed')).status, 200);
  assert.deepEqual(await handed('seat-a', card), [], 'the seat that dismissed it is not handed it again');
  assert.deepEqual(await handed('seat-b', card), [s.id], 'another seat still is');
  const read = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.equal('roomHasRead' in read.json, false, 'and her read of the card carries no block');
});

test('P3 a second, different seat\'s dismiss: hidden "for everyone", status dismissed, nobody is handed it', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  assert.equal((await decide('seat-a', s, 'dismissed')).json.hidden, 'for you');
  const second = await decide('seat-b', s, 'dismissed');
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.hidden, 'for everyone');
  assert.deepEqual(await statusOf(s.link), ['dismissed']);
  assert.deepEqual(await handed('seat-c', card), [], 'a seat that never saw it is not handed a retired link');
  const row = await listed(card, s);
  assert.deepEqual({ status: row.status, dismissals: row.dismissals }, { status: 'dismissed', dismissals: 2 });
});

test('P4 the same seat dismissing twice retires nothing', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  assert.equal((await decide('seat-a', s, 'dismissed')).json.hidden, 'for you');
  const again = await decide('seat-a', s, 'dismissed');
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.hidden, 'for you');
  assert.deepEqual(await statusOf(s.link), ['proposed']);
  assert.equal((await listed(card, s)).dismissals, 1, 'one seat, however often');
  assert.deepEqual(await handed('seat-b', card), [s.id]);
});

test('P5 a confirm after one dismiss: status confirmed; the seat that dismissed is still not handed it, another seat is', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  assert.equal((await decide('seat-a', s, 'dismissed')).status, 200);
  const c = await decide('seat-b', s, 'confirmed', card.shortId);
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(await statusOf(s.link), ['confirmed']);
  assert.deepEqual(await handed('seat-a', card), []);
  assert.deepEqual(await handed('seat-c', card), [s.id]);
  assert.deepEqual(await handed('seat-b', card), [s.id], 'a link a seat confirmed may still be handed to her at a claim');
});

test('P6 a link already dismissed under the old rule stays out for everyone, and is not reinterpreted', T, async () => {
  const card = await newCard();
  // the stored shape of the links dismissed before #1852: status dismissed, ONE seat's decision
  const s = await seedLink(card, { status: 'dismissed', extra: (link) => `<${link}/decision/${crypto.randomUUID()}> <${RDF}type> <${RS}LinkDecision> ; <${RS}ofLink> <${link}> ;
    <${RS}linkVerdict> "dismissed" ; <${RS}decidedBy> <${seatActor('seat-a')}> ; <${SC}dateCreated> "2026-11-12T20:00:00.000Z" .` });
  assert.deepEqual(await handed('seat-b', card), [], 'a seat that never dismissed it is not handed it');
  assert.deepEqual(await handed('seat-a', card), []);
  const row = await listed(card, s);
  assert.deepEqual({ status: row.status, dismissals: row.dismissals }, { status: 'dismissed', dismissals: 1 }, 'the list shows it as it is stored');
  const again = await decide('seat-a', s, 'dismissed');
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.hidden, 'for everyone', 'the answer says what is true of the link, not what this one write did');
  assert.deepEqual(await statusOf(s.link), ['dismissed']);
});

test('P7 a seat that dismissed and then confirmed is handed the link again: her standing verdict is the confirm', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  assert.equal((await decide('seat-a', s, 'dismissed')).status, 200);
  assert.deepEqual(await handed('seat-a', card), []);
  await new Promise((r) => setTimeout(r, 5));   // the two verdicts must not share a millisecond
  assert.equal((await decide('seat-a', s, 'confirmed', card.shortId)).status, 200);
  assert.deepEqual(await handed('seat-a', card), [s.id]);
  assert.equal((await listed(card, s)).dismissals, 0);
});

test('P8 a confirm\'s answer carries no `hidden`', T, async () => {
  const card = await newCard(); const s = await seedLink(card);
  const c = await decide('seat-a', s, 'confirmed', card.shortId);
  assert.equal(c.status, 200, c.text);
  assert.equal('hidden' in c.json, false);
});

test('P9 the list\'s `means` states the two-seat rule', T, async () => {
  const r = await call('seat-a', 'GET', '/api/links?limit=1');
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.means, /two (different |distinct )?seats/);
});
