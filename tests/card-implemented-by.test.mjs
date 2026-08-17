/**
 * implementedBy — the commit that implements a card, as an EDGE.
 *
 * #814's first named gap, verbatim: "There is no first-class place for 'the
 * commit that implements this card'… Commits are already referenced as
 * `git:<sha>` literals elsewhere. A LITERAL IS NOT A NODE."
 *
 * The graph agreed with itself about this in a code comment — graph-replica
 * on tending evidence: "a source ref like `git:2a6f4d0` … names no node and
 * stays a literal rather than minting an entity that does not exist."
 *
 * ⇒ Measured need, 2026-08-16: four commits shipped against four cards in one
 *   evening, and nothing in the graph connects any of them. "What implements
 *   #818?" is answerable only by reading prose. That is #814's Banana Test
 *   failing on the day's own work.
 *
 * ── WHY NOT `evidencedBy` ──────────────────────────────────────────────────
 * `scrum:evidencedBy` exists in the tending vocabulary and points at durable
 * sources. #814 asks whether it generalises and calls that "a real design
 * question, not an obvious yes." It is a different relation: a commit
 * IMPLEMENTS a card; a test run EVIDENCES that a condition was discharged.
 * Collapsing them would lose exactly the distinction #814 wants to make.
 *
 * ── WHY FULL 40-CHAR SHAS ONLY ─────────────────────────────────────────────
 * ⚠️ A short sha is an ABBREVIATION whose expansion requires the repository.
 * The graph cannot resolve it, so accepting `9f2d054` and `9f2d054…full` would
 * mint two nodes for one commit and the graph could never reconcile them. That
 * is an aliasing bug shipped as a convenience. Refuse instead — `git rev-parse`
 * is one command, and "never invent the target" is this vocabulary's own rule.
 *
 * ── WHAT THE COMMIT NODE DOES NOT CARRY ────────────────────────────────────
 * The sha, and nothing else. Subject, author and date live in git; the board
 * cannot verify them and must not assert them. The graph states the LINK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardToNode, nodeToCard } from '../core/mapping.mjs';
import { domainToJsonLd, jsonLdToDomain } from '../core/jsonld.mjs';
import { buildGraphStore, queryGraph, SPARQL_PREFIXES } from '../core/graph-replica.mjs';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const SHA_818 = '9f2d054c1a3b7e6f8d2a4b5c6d7e8f9a0b1c2d3e';
const SHA_816 = '31df3f5a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e';

const card = (shortId, name, extra = {}) => ({
  '@id': `c${shortId}`, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

const domain = () => ({
  nodes: [
    card(818, 'the graph drops dangling edges', { column: 'done', implementedBy: [SHA_818] }),
    card(816, 'the queue reports connected cards', { column: 'done', implementedBy: [SHA_816, SHA_818] }),
    card(500, 'unimplemented', { column: 'backlog' }),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));
const ask = (store, q) => queryGraph(store, `${SPARQL_PREFIXES}\n${q}`).rows;

test('implementedBy: THE BANANA — one query answers "what implements #818"', () => {
  const rows = ask(storeFor(),
    `SELECT ?sha WHERE { ?c a schema:CreativeWork ; schema:identifier "818" ; ` +
    `scrum:implementedBy ?commit . ?commit a scrum:Commit ; schema:identifier ?sha }`);
  assert.deepEqual(rows.map((r) => r.sha), [SHA_818],
    'no prose parsed, no comment regexed — a join on modelled nodes');
});

test('implementedBy: the INVERSE is free — what did this commit implement', () => {
  const rows = ask(storeFor(),
    `SELECT ?id WHERE { ?commit a scrum:Commit ; schema:identifier "${SHA_818}" . ` +
    `?c scrum:implementedBy ?commit ; schema:identifier ?id }`);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['816', '818'],
    'one commit spanning two cards is a real shape and the graph answers it in one hop');
});

test('implementedBy: a commit is ONE node however many cards cite it', () => {
  const rows = ask(storeFor(), `SELECT DISTINCT ?commit WHERE { ?commit a scrum:Commit }`);
  assert.equal(rows.length, 2, 'two distinct shas across three citations');
});

test('implementedBy: the commit node carries the sha and NOTHING the board cannot verify', () => {
  const rows = ask(storeFor(),
    `SELECT ?p WHERE { ?commit a scrum:Commit ; schema:identifier "${SHA_818}" ; ?p ?o }`);
  assert.deepEqual([...new Set(rows.map((r) => r.p))].sort(), ['rdf:type', 'schema:identifier'],
    'subject, author and date live in git; asserting them here would be inventing');
});

test('implementedBy: an unimplemented card mints nothing', () => {
  const rows = ask(storeFor(), `SELECT ?o WHERE { ?c schema:identifier "500" ; scrum:implementedBy ?o }`);
  assert.deepEqual(rows, []);
});

test('implementedBy: survives the mapping and document round trip', () => {
  const original = {
    id: 'x1', shortId: 818, title: 'c', description: '', type: 'bug',
    assignees: [], labels: [], for: '', priority: 'p1', column: 'done', order: 0,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', createdBy: 'ada',
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
    claimedBy: null, claimedAt: null, implementedBy: [SHA_818],
  };
  assert.deepEqual(nodeToCard(cardToNode(original)).implementedBy, [SHA_818]);
  const back = jsonLdToDomain(domainToJsonLd({ nodes: [cardToNode(original)], messages: [], people: [], columns: [] }));
  assert.deepEqual(back.nodes[0].board.implementedBy, [SHA_818],
    'a field landing in _extra is a silent demotion out of the model');
});

// ── the write path, over the wire ───────────────────────────────────────────
// Proven end-to-end, not by inspection: two separate layers silently discarded
// a valid field earlier tonight — the server's PATCHABLE allowlist (200, no
// error) and the MCP tool's zod schema (strips unknown keys by default, 29
// schemas, zero .strict()). A link that silently doesn't happen is worse than
// one that refuses.

const bare = (shortId) => ({
  id: `uuid-${shortId}`, shortId, title: `card ${shortId}`, description: '', type: 'task',
  assignees: [], labels: [], for: '', priority: 'p1', column: 'backlog', order: 0,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
  claimedBy: null, claimedAt: null,
});

test('implementedBy over the wire: the link PERSISTS through REST', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [bare(818)], nextShortId: 819, conversations: [] }) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards/818`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ implementedBy: [SHA_818] }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).implementedBy, [SHA_818], 'not stripped by the PATCHABLE allowlist');
  } finally { await srv.stop(); }
});

test('implementedBy over the wire: a SHORT sha is refused, not aliased', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [bare(818)], nextShortId: 819, conversations: [] }) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards/818`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ implementedBy: ['9f2d054'] }),
    });
    assert.equal(r.status, 400, 'the graph cannot expand an abbreviation, so two forms would be two nodes');
    assert.match((await r.json()).error, /40|full/i);
  } finally { await srv.stop(); }
});

test('implementedBy over the wire: the MCP schema carries it (zod strips what it omits)', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [bare(818)], nextShortId: 819, conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    await session.callTool('card_update', { id: '818', implementedBy: [SHA_818] });
    const after = await (await fetch(`${rest.baseUrl}/api/cards/818`)).json();
    assert.deepEqual(after.implementedBy, [SHA_818],
      'null here means the MCP schema omitted the field and zod discarded it with a 200');
  } finally { await mcp.stop(); await rest.stop(); }
});
