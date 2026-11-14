/**
 * #1852 (#1848 slice 3) — A CLAIMED CARD, AND A SEAT'S FIRST READ OF A CARD, CARRY THE CLAIMS THE ROOM HAS READ. Over REST
 * with the log-born unit, in OBSERVE mode with a real seat credential: the shape production runs (no SCRUM_AUTH, a bearer).
 * REST talks to the executor through a proxy that counts its queries and can fail or slow the delivery read alone, so the
 * rows about cost and failure do not rest on timing guesses.
 *
 * INTERFACE PINNED HERE:
 *   POST /api/cards/:id/claim (200 only) and GET /api/cards/:id[?outline=1] (a seat only) may carry
 *     roomHasRead: { means, items: [{ link, status, gist, quote, quoteTruncated?, source: { title, url }, score,
 *                    answer: { confirm, dismiss } }], recorded?: false }
 *                | { unavailable: <reason> }
 *   absent when there is nothing to deliver. A seat is the request's own credential (LOGBORN.actorFor), never the body's `by`.
 *   Each first showing is one scrum:LinkShowing (kind link.show), written after the answer.
 *
 *   C1  a successful claim carries the card's links, and each first showing is recorded as the AUTHENTICATED seat's, via "claim"
 *   C2  the rules through REST: no dismissed link, one per source, at most two, confirmed first
 *   C3  a card with no links: the claim's answer is exactly what it was, with no field
 *   C4  a refused claim (409 held, 404, 400) carries no field and records nothing
 *   C5  a second claim delivers the same set again, and the graph still holds ONE showing per link
 *   C6  a claim with no bearer: the block arrives with recorded:false, and nothing is written
 *   C7  the bearer is another seat's than the body's `by`: the showing is the bearer's
 *   G1  a read with no bearer carries no field, byte for byte what a card with no links answers, and records nothing
 *   G2  a seat's first read carries the block (full and outline); it is recorded via "get"; the next read carries no field
 *   G3  a seat that was shown a link at claim is not shown it again on a read
 *   G4  a link that joins the card's two later is shown on the next read, alone
 *   G5  another seat's read is its own first showing
 *   G6  a read-scope key is not a seat that can be recorded: no field
 *   U1  the delivery read fails: the claim still answers 200 with roomHasRead.unavailable; so does a seat's read
 *   U2  the delivery read is slow: the answer goes out at the deadline saying unavailable, and nothing is recorded
 *   U3  without the log-born unit: a claim says unavailable; a read carries no field
 *   R1  with auth REQUIRED the same holds: the claim carries the block and the showing is the key's seat's
 *   K1  link_counts: a delivery raises `shown` and `delivered`, never `used`, and does not make the seat a decider
 *   K2  a delivered link the seat then confirms is ONE shown link, delivered 1, used 1
 *   K3  since: a window after the delivery counts nothing
 *   L1  cost: a seat's read of a card with no links asks the executor ONE more query than a read with no bearer; latency reported
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { linkIri, spanKey } from '../core/knowledge-linking.mjs';
import { showIri, DELIVERY_DEADLINE_MS, DELIVERY_MEANS } from '../core/knowledge-delivery.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';
import { seatActor } from '../core/graph-auth.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const SEATS = { 'seat-a': 'admin', 'seat-b': 'admin', 'seat-c': 'admin', 'seat-r': 'read' };

const ROSTER = path.join(os.tmpdir(), `kd1852-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ...Object.fromEntries(Object.keys(SEATS).map((s) => [s, { name: s, glyph: s.at(-1), color: '#7cc4a0' }])), board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = Object.fromEntries(Object.keys(SEATS).map((s) => [s, mintToken()]));
const TOKENS = path.join(os.tmpdir(), `kd1852-tokens-${process.pid}.json`);
{
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(TOKENS, JSON.stringify({ seats: Object.fromEntries(Object.entries(SEATS).map(([s, scope]) => [s, { credentials: [{ tokenHash: hashToken(TOK[s]), scope, issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }])) }));
}
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });
const ENV = { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' };   // observe: production's mode

/** The delivery read is the one query that starts from a card's links and leaves the dismissed ones out. */
const isDeliveryRead = (body) => body.includes(`${RS}bearsOnCard`) && body.includes('"dismissed"');
/** A proxy in front of the executor: counts every /query, and can fail (`mode='fail'`) or hold (`mode='slow'`) the delivery read alone. */
function executorProxy() {
  const state = { queries: 0, deliveryReads: 0, mode: 'pass', holdMs: 0, server: null };
  const start = (execUrl) => new Promise((resolve) => {
    state.server = http.createServer((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
        try {
          const isQuery = req.method === 'POST' && req.url.startsWith('/query');
          if (isQuery) state.queries += 1;
          if (isQuery && isDeliveryRead(body.toString())) {
            state.deliveryReads += 1;
            if (state.mode === 'fail') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('injected fault'); }
            if (state.mode === 'slow') await new Promise((r) => setTimeout(r, state.holdMs));
          }
          const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
          const t = await f.text();
          res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
        } catch { try { req.socket.destroy(); } catch { /* gone */ } }
      });
    });
    state.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${state.server.address().port}`));
  });
  return { state, start, stop: () => new Promise((r) => (state.server ? state.server.close(() => r()) : r())) };
}

let w, gc, proxy;
before(async () => {
  if (SKIP) return;
  proxy = executorProxy();
  w = await wholeBoardWorld({ logborn: true, env: ENV, front: proxy.start });
  gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kd1852' });
});
after(async () => { if (w) await w.stop(); if (proxy) await proxy.stop(); });

const callAt = async (base, seat, method, route, payload) => {
  const headers = { ...(seat ? { authorization: `Bearer ${TOK[seat]}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const x = await fetch(`${base}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
};
const call = (seat, method, route, payload) => callAt(w.rest.baseUrl, seat, method, route, payload);
const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, r.reason); return r.rows; };
async function raw(execUrl, body) {
  const ep = (await (await fetch(`${execUrl}/health`)).json()).epoch;
  const res = await fetch(`${execUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
}
/** A fresh card on the board, made through REST so the document and the graph both hold it. */
async function newCard(base = w.rest.baseUrl) {
  const r = await callAt(base, 'seat-a', 'POST', '/api/cards', { title: `a card ${crypto.randomUUID()}`, by: 'seat-a' });
  assert.ok(r.status === 200 || r.status === 201, `PRECONDITION: the card was created (${r.status} ${r.text.slice(0, 200)})`);
  return { id: r.json.id, shortId: r.json.shortId };
}
/** A described source, and a claim from one of its blocks proposed as bearing on `card`: written raw, the linker is not under test. */
async function seedSource(execUrl = w.exec.baseUrl) {
  const iri = `https://scrumboard.local/source/${crypto.randomUUID()}`;
  const title = `A source ${iri.slice(-6)}`; const url = `https://example.org/${iri.slice(-6)}`;
  await raw(execUrl, `INSERT DATA { <${iri}> <${RDF}type> <${RS}SourceVersion> ; <${SC}name> ${JSON.stringify(title)} ; <${SC}url> ${JSON.stringify(url)} . }`);
  return { iri, title, url };
}
async function seedLink(card, { source = null, score = 0.7, status = 'proposed', gist = 'the gist', span = null, execUrl = w.exec.baseUrl } = {}) {
  const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  span ??= `a verbatim span ${assertion}`;
  const link = linkIri(spanKey(span, card.id));
  await raw(execUrl, `INSERT DATA { <${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)}${gist ? ` ; <${RS}gist> ${JSON.stringify(gist)}` : ''}${source ? ` ; <${RS}expressedIn> <${source.iri}/block/3>` : ''} .
    <${link}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${assertion}> ; <${RS}bearsOnCard> <${cardIriOf(card.id)}> ; <${RS}score> "${score}" ; <${RS}status> "${status}" . }`);
  return { link, id: link.split('/').pop(), span, gist };
}
const showingsOf = (link) => q(`SELECT ?n ?to ?on ?via WHERE { ?n <${RDF}type> <${RS}LinkShowing> ; <${RS}ofLink> <${link}> ; <${RS}shownTo> ?to ; <${RS}shownOn> ?on ; <${RS}shownVia> ?via }`);
/** The showing is written AFTER the answer: wait for it, bounded. */
async function untilShown(link, n = 1) {
  const end = Date.now() + 10000;
  for (;;) {
    const rows = await showingsOf(link);
    if (rows.length >= n) return rows;
    if (Date.now() > end) assert.fail(`the showing of ${link} was not recorded within 10 s (found ${rows.length}, wanted ${n})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 400));   // long enough for a write that WOULD have happened to land
const claim = (seat, card, by = seat) => call(seat, 'POST', `/api/cards/${card.shortId}/claim`, { by });
const release = (seat, card) => call(seat, 'DELETE', `/api/cards/${card.shortId}/claim`, { by: seat });

test('C1 a successful claim carries the card\'s links, and each first showing is recorded as the authenticated seat\'s', T, async () => {
  const card = await newCard(); const src = await seedSource();
  const s = await seedLink(card, { source: src, score: 0.681 });
  const r = await claim('seat-a', card);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.claimed, true);
  assert.deepEqual(r.json.roomHasRead, {
    means: DELIVERY_MEANS,
    items: [{
      link: s.id, status: 'proposed', gist: 'the gist', quote: s.span, source: { title: src.title, url: src.url }, score: 0.681,
      answer: {
        confirm: { tool: 'link_decide', args: { link: s.id, verdict: 'confirmed', workingOn: card.shortId } },
        dismiss: { tool: 'link_decide', args: { link: s.id, verdict: 'dismissed' } },
      },
    }],
  });
  console.log(`# C1 roomHasRead: ${JSON.stringify(r.json.roomHasRead)}`);
  const rows = await untilShown(s.link);
  assert.equal(rows.length, 1);
  assert.deepEqual({ n: rows[0].n.value, to: rows[0].to.value, on: rows[0].on.value, via: rows[0].via.value },
    { n: showIri(s.link, seatActor('seat-a')), to: seatActor('seat-a'), on: cardIriOf(card.id), via: 'claim' });
});

test('C2 the rules through REST: no dismissed link, one per source, at most two, confirmed first', T, async () => {
  const card = await newCard(); const [one, two, three] = [await seedSource(), await seedSource(), await seedSource()];
  await seedLink(card, { source: one, score: 0.99, status: 'dismissed' });
  const best = await seedLink(card, { source: one, score: 0.9 });
  await seedLink(card, { source: one, score: 0.8 });
  const confirmed = await seedLink(card, { source: two, score: 0.5, status: 'confirmed' });
  await seedLink(card, { source: three, score: 0.6 });
  const r = await claim('seat-a', card);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.roomHasRead.items.map((i) => [i.link, i.status]), [[confirmed.id, 'confirmed'], [best.id, 'proposed']]);
});

test('C3 a card with no links: the claim\'s answer is exactly what it was', T, async () => {
  const card = await newCard();
  const r = await claim('seat-a', card);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ['claimed', 'holder', 'claimedAt'], 'no roomHasRead key at all, not an empty one');
});

test('C4 a refused claim carries no field and records nothing', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  assert.equal((await claim('seat-b', card)).status, 200, 'PRECONDITION: seat-b holds the card');
  await untilShown(s.link);
  const held = await claim('seat-a', card);
  assert.equal(held.status, 409, held.text);
  assert.equal('roomHasRead' in held.json, false);
  const missing = await call('seat-a', 'POST', '/api/cards/999999/claim', { by: 'seat-a' });
  assert.equal(missing.status, 404);
  assert.equal('roomHasRead' in missing.json, false);
  const bad = await call('seat-a', 'POST', `/api/cards/${card.shortId}/claim`, { by: 'not a seat key!' });
  assert.equal(bad.status, 400);
  assert.equal('roomHasRead' in bad.json, false);
  await settle();
  assert.deepEqual((await showingsOf(s.link)).map((x) => x.to.value), [seatActor('seat-b')], 'only the seat whose claim succeeded was shown it');
});

test('C5 a second claim delivers the same set again, and the graph still holds one showing per link', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const first = await claim('seat-a', card);
  assert.equal(first.status, 200, first.text);
  await untilShown(s.link);
  assert.equal((await release('seat-a', card)).status, 200);
  const second = await claim('seat-a', card);
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.json.roomHasRead, first.json.roomHasRead, 'a claim shows the current set every time');
  await settle();
  assert.equal((await showingsOf(s.link)).length, 1, 'the second showing made no second node');
});

test('C6 a claim with no bearer: the block arrives with recorded:false, and nothing is written', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const r = await claim(null, card, 'seat-a');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.roomHasRead.items.map((i) => i.link), [s.id]);
  assert.equal(r.json.roomHasRead.recorded, false);
  await settle();
  assert.equal((await showingsOf(s.link)).length, 0, 'an unauthenticated showing is nobody\'s to count');
});

test('C7 the bearer is another seat\'s than the body\'s `by`: the showing is the bearer\'s', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const r = await claim('seat-b', card, 'seat-a');
  assert.equal(r.status, 200, r.text);
  assert.equal('recorded' in r.json.roomHasRead, false);
  assert.deepEqual((await untilShown(s.link)).map((x) => x.to.value), [seatActor('seat-b')]);
});

test('G1 a read with no bearer carries no field, byte for byte, and records nothing', T, async () => {
  const card = await newCard(); const bare = await newCard();
  const s = await seedLink(card, { source: await seedSource() });
  const r = await call(null, 'GET', `/api/cards/${card.shortId}`);
  assert.equal(r.status, 200, r.text);
  assert.equal('roomHasRead' in r.json, false);
  // the same bytes a card with no links answers, card for card: the keys, in order, are the stored card's and `comments`
  const plain = await call(null, 'GET', `/api/cards/${bare.shortId}`);
  assert.deepEqual(Object.keys(r.json), Object.keys(plain.json));
  assert.equal(r.text, JSON.stringify(r.json), 'and nothing rides outside the JSON');
  const outline = await call(null, 'GET', `/api/cards/${card.shortId}?outline=1`);
  assert.equal('roomHasRead' in outline.json, false);
  await settle();
  assert.equal((await showingsOf(s.link)).length, 0);
  const seat = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.deepEqual(seat.json.roomHasRead.items.map((i) => i.link), [s.id], 'CONTROL: the same card DOES carry the block for a seat');
  const { roomHasRead, ...rest } = seat.json;
  assert.equal(JSON.stringify(rest), r.text, 'and apart from the block the two answers are the same bytes');
});

test('G2 a seat\'s first read carries the block; it is recorded via "get"; the next read carries no field', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const first = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.roomHasRead.items.map((i) => i.link), [s.id]);
  assert.deepEqual(first.json.roomHasRead.items[0].answer.confirm.args, { link: s.id, verdict: 'confirmed', workingOn: card.shortId });
  const rows = await untilShown(s.link);
  assert.deepEqual({ to: rows[0].to.value, via: rows[0].via.value }, { to: seatActor('seat-a'), via: 'get' });
  const again = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.equal('roomHasRead' in again.json, false, 'a re-read is not shown the same block');
  assert.equal('roomHasRead' in (await call('seat-a', 'GET', `/api/cards/${card.shortId}?outline=1`)).json, false);
  // the outline answer delivers too, to a seat that has not been shown it
  const other = await newCard(); const o = await seedLink(other, { source: await seedSource() });
  const outline = await call('seat-a', 'GET', `/api/cards/${other.shortId}?outline=1`);
  assert.ok(outline.json.outline, 'PRECONDITION: this is the outline answer');
  assert.deepEqual(outline.json.roomHasRead.items.map((i) => i.link), [o.id]);
  assert.equal((await untilShown(o.link))[0].via.value, 'get');
});

test('G3 a seat that was shown a link at claim is not shown it again on a read', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  assert.equal((await claim('seat-a', card)).status, 200);
  await untilShown(s.link);
  const r = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.equal('roomHasRead' in r.json, false);
});

test('G4 a link that joins the card\'s two later is shown on the next read, alone', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource(), score: 0.6 });
  assert.deepEqual((await call('seat-a', 'GET', `/api/cards/${card.shortId}`)).json.roomHasRead.items.map((i) => i.link), [s.id]);
  await untilShown(s.link);
  const later = await seedLink(card, { source: await seedSource(), score: 0.9 });
  const r = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.deepEqual(r.json.roomHasRead.items.map((i) => i.link), [later.id]);
});

test('G5 another seat\'s read is its own first showing', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  await untilShown(s.link);
  const r = await call('seat-b', 'GET', `/api/cards/${card.shortId}`);
  assert.deepEqual(r.json.roomHasRead.items.map((i) => i.link), [s.id]);
  assert.deepEqual((await untilShown(s.link, 2)).map((x) => x.to.value).sort(), [seatActor('seat-a'), seatActor('seat-b')]);
});

test('G6 a read-scope key is not a seat that can be recorded: no field', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const r = await call('seat-r', 'GET', `/api/cards/${card.shortId}`);
  assert.equal(r.status, 200, r.text);
  assert.equal('roomHasRead' in r.json, false);
  await settle();
  assert.equal((await showingsOf(s.link)).length, 0);
  const acting = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.deepEqual(acting.json.roomHasRead.items.map((i) => i.link), [s.id], 'CONTROL: the same read with a key that may act carries the block');
});

test('U1 the delivery read fails: the claim still answers 200 saying unavailable; so does a seat\'s read', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const before = proxy.state.deliveryReads;
  proxy.state.mode = 'fail';
  try {
    const got = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
    assert.equal(got.status, 200, got.text);
    assert.deepEqual(Object.keys(got.json.roomHasRead), ['unavailable']);
    assert.match(got.json.roomHasRead.unavailable, /could not be read/);
    assert.equal(got.json.id, card.id, 'the card itself is whole');
    const r = await claim('seat-a', card);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.claimed, true);
    assert.deepEqual(Object.keys(r.json.roomHasRead), ['unavailable']);
    assert.ok(proxy.state.deliveryReads >= before + 2, 'PRECONDITION: the fault reached both delivery reads');
  } finally { proxy.state.mode = 'pass'; }
  await settle();
  assert.equal((await showingsOf(s.link)).length, 0, 'a link nobody was shown is not recorded as shown');
  const after = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  assert.deepEqual(after.json.roomHasRead.items.map((i) => i.link), [s.id], 'CONTROL: with the fault gone the same read delivers');
});

test('U2 the delivery read is slow: the answer goes out at the deadline saying unavailable, and nothing is recorded', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  proxy.state.mode = 'slow'; proxy.state.holdMs = DELIVERY_DEADLINE_MS + 1500;
  try {
    const t0 = Date.now();
    const got = await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
    const ms = Date.now() - t0;
    assert.equal(got.status, 200, got.text);
    assert.deepEqual(Object.keys(got.json.roomHasRead), ['unavailable']);
    assert.match(got.json.roomHasRead.unavailable, new RegExp(`${DELIVERY_DEADLINE_MS} ms`));
    assert.ok(ms >= DELIVERY_DEADLINE_MS - 50 && ms < proxy.state.holdMs, `the read answered at the deadline, not when the executor did (${ms} ms)`);
  } finally { proxy.state.mode = 'pass'; }
  await new Promise((r) => setTimeout(r, 2000));   // past the held read's own return
  assert.equal((await showingsOf(s.link)).length, 0, 'the late answer was never shown, so it is not recorded');
});

test('U3 without the log-born unit: a claim says unavailable; a read carries no field', T, async () => {
  const o = await wholeBoardWorld({ env: ENV });
  try {
    const card = await newCard(o.rest.baseUrl);
    const got = await callAt(o.rest.baseUrl, 'seat-a', 'GET', `/api/cards/${card.shortId}`);
    assert.equal(got.status, 200, got.text);
    assert.equal('roomHasRead' in got.json, false);
    const r = await callAt(o.rest.baseUrl, 'seat-a', 'POST', `/api/cards/${card.shortId}/claim`, { by: 'seat-a' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.roomHasRead), ['unavailable']);
    assert.match(r.json.roomHasRead.unavailable, /log-born unit/);
  } finally { await o.stop(); }
});

test('R1 with auth required the same holds: the claim carries the block and the showing is the key\'s seat\'s', T, async () => {
  const o = await wholeBoardWorld({ logborn: true, env: { ...ENV, SCRUM_AUTH: 'required' } });
  try {
    const card = await newCard(o.rest.baseUrl);
    const s = await seedLink(card, { execUrl: o.exec.baseUrl });
    const r = await callAt(o.rest.baseUrl, 'seat-a', 'POST', `/api/cards/${card.shortId}/claim`, { by: 'seat-a' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.roomHasRead.items.map((i) => i.link), [s.id]);
    assert.deepEqual(r.json.roomHasRead.items[0].source, { title: null, url: null }, 'this claim has no known source, and none is made up');
    const ogc = createGraphClient({ baseUrl: o.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kd1852-required' });
    const end = Date.now() + 10000;
    let rows = [];
    while (rows.length === 0 && Date.now() < end) {
      const got = await ogc.query(`SELECT ?to WHERE { ?n <${RDF}type> <${RS}LinkShowing> ; <${RS}ofLink> <${s.link}> ; <${RS}shownTo> ?to }`);
      assert.ok(got.ok, got.reason); rows = got.rows;
      if (rows.length === 0) await new Promise((x) => setTimeout(x, 25));
    }
    assert.deepEqual(rows.map((x) => x.to.value), [seatActor('seat-a')]);
    const read = await callAt(o.rest.baseUrl, 'seat-a', 'GET', `/api/cards/${card.shortId}`);
    assert.equal('roomHasRead' in read.json, false, 'and her read after the claim carries no block');
  } finally { await o.stop(); }
});

const counts = async (since = '2000-01-01T00:00:00.000Z') => {
  const r = await call('seat-a', 'GET', `/api/links/counts?since=${encodeURIComponent(since)}`);
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const of = (j, seat) => j.seats.find((x) => x.seat === seat) ?? { seat, shown: 0, delivered: 0, used: 0 };
const delta = (a, b, seat) => ({ shown: of(b, seat).shown - of(a, seat).shown, delivered: of(b, seat).delivered - of(a, seat).delivered, used: of(b, seat).used - of(a, seat).used });

test('K1 link_counts: a delivery raises shown and delivered, never used, and does not make the seat a decider', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const a = await counts();
  assert.equal(of(a, 'seat-c').shown, 0, 'PRECONDITION: seat-c has neither decided nor been delivered anything');
  await call('seat-c', 'GET', `/api/cards/${card.shortId}`);
  await untilShown(s.link);
  const b = await counts();
  assert.deepEqual(delta(a, b, 'seat-c'), { shown: 1, delivered: 1, used: 0 });
  assert.equal(b.deciders, a.deciders, 'being shown a link is not deciding it');
  assert.match(b.means, /delivered/);
});

test('K2 a delivered link the seat then confirms is one shown link, delivered 1, used 1', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  const a = await counts();
  assert.equal((await claim('seat-b', card)).status, 200);
  await untilShown(s.link);
  const d = await call('seat-b', 'POST', `/api/links/${s.id}/decide`, { verdict: 'confirmed', workingOn: card.shortId, by: 'seat-b' });
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(delta(a, await counts(), 'seat-b'), { shown: 1, delivered: 1, used: 1 });
});

test('K3 since: a window after the delivery counts nothing', T, async () => {
  const card = await newCard(); const s = await seedLink(card, { source: await seedSource() });
  await call('seat-a', 'GET', `/api/cards/${card.shortId}`);
  await untilShown(s.link);
  const later = await counts(new Date(Date.now() + 3600_000).toISOString());
  assert.deepEqual(later.seats, [], JSON.stringify(later));
  assert.ok(of(await counts(), 'seat-a').delivered >= 1, 'CONTROL: the same delivery is counted in a window that contains it');
});

const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timed(seat, route) { const t0 = performance.now(); const r = await call(seat, 'GET', route); assert.equal(r.status, 200); return { ms: performance.now() - t0, json: r.json }; }
test('L1 cost: a seat\'s read of a card with no links asks the executor one more query than a read with no bearer', T, async () => {
  const bare = await newCard();
  const queriesOf = async (seat, card) => { const n = proxy.state.queries; await call(seat, 'GET', `/api/cards/${card.shortId}`); return proxy.state.queries - n; };
  const anon = await queriesOf(null, bare);
  const seat = await queriesOf('seat-a', bare);
  assert.equal(seat, anon + 1, `a card with no links costs a seat one query more (no bearer ${anon}, seat ${seat})`);

  // latency, reported: the same card read 40 times each way, and 20 cards read once each for the first showing
  const N = 40;
  const linked = await newCard(); const src = [await seedSource(), await seedSource()];
  const l0 = await seedLink(linked, { source: src[0], score: 0.8 }); await seedLink(linked, { source: src[1], score: 0.7 });
  await call('seat-a', 'GET', `/api/cards/${linked.shortId}`); await untilShown(l0.link);
  const run = async (who, card) => { const xs = []; for (let i = 0; i < N; i++) xs.push((await timed(who, `/api/cards/${card.shortId}`)).ms); return p50(xs); };
  await run(null, bare);   // warm
  const base = await run(null, bare);
  const noLinks = await run('seat-a', bare);
  const shownAlready = await run('seat-a', linked);
  const firsts = [];
  for (let i = 0; i < 20; i++) {
    const c = await newCard(); await seedLink(c, { source: src[0], score: 0.8 }); await seedLink(c, { source: src[1], score: 0.7 });
    const t = await timed('seat-b', `/api/cards/${c.shortId}`);
    assert.equal(t.json.roomHasRead.items.length, 2, 'PRECONDITION: this read delivered');
    firsts.push(t.ms);
  }
  const f = (x) => x.toFixed(2);
  console.log(`# L1 GET /api/cards/:id p50 over ${N}: no bearer ${f(base)} ms · seat, card with no links ${f(noLinks)} ms (+${f(noLinks - base)}) · `
    + `seat, 2 links already shown ${f(shownAlready)} ms (+${f(shownAlready - base)}) · seat, first showing of 2 links (20 cards) ${f(p50(firsts))} ms (+${f(p50(firsts) - base)})`);
  // a wide bound, to catch a delivery that started scanning rather than a slow machine
  assert.ok(noLinks - base < 250, `the no-links read stayed cheap (+${f(noLinks - base)} ms at p50)`);
});
