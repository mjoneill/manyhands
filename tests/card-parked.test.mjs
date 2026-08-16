/**
 * PARKED — an authored, expiring "not yet" that the graph can state.
 *
 * THE GAP, measured 2026-08-16: card #429 carries, in its DESCRIPTION, an
 * instruction from the customer that it be retained for a later discussion,
 * ending "NO IMPLEMENTATION, REPAIR, ACTIVATION, PERSISTENCE, OR DELETION IS
 * AUTHORIZED NOW."
 *
 * `board_ready` ranked it FIRST of 451. Not blocked, not claimed, not done —
 * so by the queue's rules it was the single most available work on the board,
 * and it is the one card with a human's "don't" written across the top.
 *
 * ⇒ The instruction EXISTS. The graph has nowhere to put it. So it lives in
 *   prose, invisible to the tool that recommends the card. Of the four gaps
 *   the queue exposed by being used, three were consumer gaps — the fact was
 *   there and unread. THIS ONE the room cannot state at all.
 *
 * ── WHY EXPIRY IS REQUIRED, NOT OPTIONAL ───────────────────────────────────
 * A park with no end date is a cancellation wearing a kinder word, and it
 * becomes permanent by forgetting — which is exactly how #429 sat at rank 1
 * for a month. `parkedUntil` is mandatory. Wanting something gone forever is a
 * different act (supersede, or delete) and should look different.
 *
 * ── WHY IT IS NOT A CLAIM ──────────────────────────────────────────────────
 * A claim says "I am working on this." A park says "NOBODY should, yet." The
 * claim rail is a mutex; this is a disposition. They can coexist on one card
 * and mean different things, so parked is its own field set rather than a
 * flavour of claimedBy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardToNode, nodeToCard } from '../core/mapping.mjs';
import { domainToJsonLd, jsonLdToDomain } from '../core/jsonld.mjs';
import { buildGraphStore, queryGraph, SPARQL_PREFIXES } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady, READY_EXPLAIN } from '../core/ready-query.mjs';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

const card = (shortId, name, extra = {}) => ({
  '@id': `c${shortId}`, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

const domain = (parkedUntil = FUTURE) => ({
  nodes: [
    card(429, 'Enforce safe agent-hosted local servers', {
      column: 'backlog', 'scrum:priority': 'p0',
      parkedBy: 'ada', 'scrum:parkedAt': '2026-07-16T20:00:00.000Z',
      'scrum:parkedUntil': parkedUntil,
      'scrum:parkedReason': 'retained for a later discussion when the team has breathing room',
    }),
    card(500, 'ordinary available work', { column: 'backlog', 'scrum:priority': 'p1' }),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d) => buildGraphStore(domainToJsonLd(d));

// ── the queue ──────────────────────────────────────────────────────────────

test('PARKED: a parked card is EXCLUDED, naming who parked it and until when', () => {
  const { ready, excluded } = pageReady(readyFromStore(storeFor(domain())));

  assert.equal(ready.some((c) => c.shortId === 429), false,
    'the parked card is p0 and would otherwise lead the queue — a ruleset ignoring parks fails at position 1');
  assert.equal(excluded.find((c) => c.shortId === 429)?.reason, `parked-by:ada-until:${FUTURE}`);
  assert.deepEqual(ready.map((c) => c.shortId), [500]);
});

test('PARKED: an EXPIRED park does not exclude — this is the whole point of requiring an end', () => {
  const { ready, excluded } = pageReady(readyFromStore(storeFor(domain(PAST))));
  assert.equal(ready[0].shortId, 429,
    'the park lapsed, so the card returns to the queue on its own — nobody has to remember');
  assert.equal(excluded.some((c) => c.shortId === 429), false);
});

test('PARKED: explain answers for a parked card', () => {
  const v = READY_EXPLAIN(readyFromStore(storeFor(domain())), 429);
  assert.equal(v.ready, false);
  assert.match(v.reason, /^parked-by:ada-until:/);
});

test('PARKED: precedence — done > claimed > parked > superseded > blocker', () => {
  // A parked AND claimed card reports the claim: someone is actively holding
  // it, which is a stronger statement about right now than a deferral.
  const d = domain();
  d.nodes[0].claimedBy = 'ada';
  assert.equal(pageReady(readyFromStore(storeFor(d))).excluded.find((c) => c.shortId === 429)?.reason,
    'claimed-by:ada');
});

// ── the graph ──────────────────────────────────────────────────────────────

test('PARKED: the disposition is QUERYABLE — who parked what, until when, and why', () => {
  const rows = queryGraph(storeFor(domain()), `${SPARQL_PREFIXES}
    SELECT ?id ?who ?until ?why WHERE {
      ?c a schema:CreativeWork ; schema:identifier ?id ;
         scrum:parkedBy ?who ; scrum:parkedUntil ?until .
      OPTIONAL { ?c scrum:parkedReason ?why } }`).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '429');
  assert.equal(rows[0].who, 'person:ada', 'the parker is an EDGE to a Person, not a string');
  assert.equal(rows[0].until, FUTURE);
  assert.match(rows[0].why, /breathing room/);
});

// ── the round trip ─────────────────────────────────────────────────────────

test('PARKED: survives card → node → document → domain → card, losslessly', () => {
  const original = {
    id: 'x1', shortId: 429, title: 'parked card', description: '', type: 'task',
    assignees: [], labels: [], for: '', priority: 'p0', column: 'backlog', order: 0,
    createdAt: PAST, updatedAt: PAST, createdBy: 'ada',
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
    claimedBy: null, claimedAt: null,
    parkedBy: 'ada', parkedAt: PAST, parkedUntil: FUTURE, parkedReason: 'later',
  };
  const back = nodeToCard(cardToNode(original));
  for (const k of ['parkedBy', 'parkedAt', 'parkedUntil', 'parkedReason']) {
    assert.equal(back[k], original[k], `${k} must survive the mapping round trip`);
  }
  // and through the JSON-LD document too
  const doc = domainToJsonLd({ nodes: [cardToNode(original)], messages: [], people: [], columns: [] });
  const domainBack = jsonLdToDomain(doc);
  assert.equal(domainBack.nodes[0].board.parkedUntil, FUTURE,
    'the facet must re-nest — a parked field landing in _extra is a silent demotion');
});

test('PARKED: an unparked card carries no parked fields and no phantom nodes', () => {
  const rows = queryGraph(storeFor({ nodes: [card(500, 'plain', { column: 'backlog' })], messages: [], people: [], columns: [] }),
    `${SPARQL_PREFIXES}\nSELECT ?s WHERE { ?s scrum:parkedBy ?o }`).rows;
  assert.deepEqual(rows, [], 'nothing is minted for a board with no parks');
});

// ── the write path, over the wire ───────────────────────────────────────────
// ⚠️ Proven end-to-end rather than by inspection, because of a defect measured
// the same day: every MCP tool schema in this server is a plain z.object(), and
// zod STRIPS unknown keys silently. A field the schema omits vanishes with a
// 200 and no error — the caller cannot tell a stripped write from a persisted
// one. A park that silently doesn't happen is worse than a park that refuses.

import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const bare = (shortId, title) => ({
  id: `uuid-${shortId}`, shortId, title, description: '', type: 'task',
  assignees: [], labels: [], for: '', priority: 'p0', column: 'backlog', order: 0,
  createdAt: PAST, updatedAt: PAST, createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
  claimedBy: null, claimedAt: null,
});

test('PARKED over the wire: parking removes the card from the queue', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [bare(429, 'park me'), bare(500, 'other')], nextShortId: 501, conversations: [] }) });
  try {
    const before = await (await fetch(`${srv.baseUrl}/api/ready`)).json();
    assert.equal(before.ready[0].shortId, 429, 'precondition: p0 and leading');

    const r = await fetch(`${srv.baseUrl}/api/cards/429`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parkedBy: 'ada', parkedUntil: FUTURE, parkedReason: 'later' }),
    });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.parkedBy, 'ada', 'the field PERSISTED — not stripped, not swallowed');
    assert.equal(saved.parkedUntil, FUTURE);

    const after = await (await fetch(`${srv.baseUrl}/api/ready`)).json();
    assert.equal(after.ready.some((c) => c.shortId === 429), false);
    assert.equal(after.excluded.find((c) => c.shortId === 429)?.reason, `parked-by:ada-until:${FUTURE}`);
  } finally { await srv.stop(); }
});

test('PARKED over the wire: an author without an end date is REFUSED, not accepted', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [bare(429, 'park me')], nextShortId: 430, conversations: [] }) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards/429`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parkedBy: 'ada' }),
    });
    assert.equal(r.status, 400, 'a park with no expiry is permanent-by-forgetting and must refuse');
    assert.match((await r.json()).error, /end date|parkedUntil/i);
  } finally { await srv.stop(); }
});

test('PARKED over the wire: the MCP tool schema CARRIES the fields (zod strips what it omits)', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [bare(429, 'park me')], nextShortId: 430, conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    await session.callTool('card_update', { id: '429', parkedBy: 'ada', parkedUntil: FUTURE });
    const after = await (await fetch(`${rest.baseUrl}/api/cards/429`)).json();
    assert.equal(after.parkedBy, 'ada',
      'if this is null the MCP schema omitted the field and zod discarded it with a 200');
    assert.equal(after.parkedUntil, FUTURE);
  } finally { await mcp.stop(); await rest.stop(); }
});

test('PARKED over the wire: an end date with NO author is refused too', async () => {
  // ⚠️ ADDED BECAUSE A MUTANT SURVIVED. Deleting the paired-field check still
  // refused parkedBy-without-parkedUntil — a later type check happened to
  // catch it — so the test suite could not tell the pairing rule existed. The
  // OTHER direction was the uncovered one: an expiry with nobody behind it is
  // a deferral no one authored, which is the half this rule exists for.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [bare(429, 'park me')], nextShortId: 430, conversations: [] }) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards/429`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parkedUntil: FUTURE }),
    });
    assert.equal(r.status, 400, 'a park with no author is a rule from nowhere');
    assert.match((await r.json()).error, /author|parkedBy/i);
  } finally { await srv.stop(); }
});
