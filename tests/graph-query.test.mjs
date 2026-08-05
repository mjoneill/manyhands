/**
 * #694 — graph_query: the traversal engine's contract.
 * Read-only by refusal AND by construction · bounded with confessed cuts ·
 * fresh after writes (the wire test) · prefixed short forms for token economy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

const doc = () => domainToJsonLd({
  nodes: [
    { '@type': 'CreativeWork', '@id': 'u-a', identifier: 1, name: 'alpha', text: '',
      additionalType: 'scrum:task',
      board: { column: 'backlog', order: 0, assignees: ['ada'], labels: ['x'], for: '',
               priority: 'p1',
               relationships: { relatedTo: ['u-b'], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] } } },
    { '@type': 'CreativeWork', '@id': 'u-b', identifier: 2, name: 'beta', text: '',
      additionalType: 'scrum:idea',
      board: { column: 'done', order: 0, assignees: [], labels: [], for: '', priority: null,
               relationships: { relatedTo: ['u-c'], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] } } },
    { '@type': 'CreativeWork', '@id': 'u-c', identifier: 3, name: 'gamma', text: '',
      additionalType: 'scrum:task',
      board: { column: 'done', order: 1, assignees: [], labels: [], for: '', priority: null } },
  ],
  messages: [
    { '@type': 'Comment', '@id': 'm-1', text: 'about alpha', author: 'bex', about: 'u-a',
      dateCreated: '2026-08-05T00:00:00Z', mentions: [] },
  ],
  people: [
    { '@type': 'Person', '@id': 'https://scrumboard.local/person/ada', identifier: 'ada',
      name: 'Ada', 'scrum:glyph': null, 'scrum:resolved': true, 'scrum:aliases': [] },
  ],
  columns: [
    { id: 'backlog', name: 'Backlog', order: 0 }, { id: 'done', name: 'Done', order: 1 },
  ],
  nextShortId: 4, lastUpdated: null,
});

test('a transitive traversal answers in one query — the thing no other surface can do', () => {
  const store = buildGraphStore(doc());
  const r = queryGraph(store, `
    SELECT DISTINCT ?n ?title WHERE {
      ?start schema:identifier "1" .
      ?start (scrum:relatedTo)+ ?n .
      ?n schema:name ?title .
    }`);
  assert.deepEqual(r.rows.map((x) => x.title).sort(), ['beta', 'gamma'],
    'both hops reached: 1→2→3');
  assert.equal(r.truncated, false);
  assert.ok(r.ms < 1000);
});

test('IRIs come back in prefixed short form — token economy is a feature', () => {
  const store = buildGraphStore(doc());
  const r = queryGraph(store, `SELECT ?col WHERE { ?c schema:identifier "1" ; scrum:column ?col . }`);
  assert.equal(r.rows[0].col, 'column:backlog', 'not a 40-char IRI');
});

test('bounded by default with a confessed cut; declared LIMIT capped at the ceiling', () => {
  const store = buildGraphStore(doc());
  const all = queryGraph(store, `SELECT ?s ?p ?o WHERE { ?s ?p ?o . }`, { limit: 5 });
  assert.equal(all.returned, 5);
  assert.equal(all.truncated, true, 'the cut is confessed, not silent');
  const capped = queryGraph(store, `SELECT ?s WHERE { ?s ?p ?o . } LIMIT 999999`);
  assert.ok(capped.limit <= 1000, 'no caller reopens the firehose');
});

test('writes refuse loudly — the engine is a READ surface', () => {
  const store = buildGraphStore(doc());
  assert.throws(
    () => queryGraph(store, `INSERT DATA { <http://x> <http://y> <http://z> }`),
    (e) => e.code === 'READ_ONLY' && /board API/.test(e.message),
    'the refusal names where writes actually go');
});

test('ASK works and cross-entity joins answer (who talks about whose work)', () => {
  const store = buildGraphStore(doc());
  const ask = queryGraph(store, `ASK { ?m schema:author person:bex . }`);
  assert.equal(ask.ask, true);
  const r = queryGraph(store, `
    SELECT ?commenter ?assignee WHERE {
      ?m schema:about ?card ; schema:author ?commenter .
      ?card scrum:assignee ?assignee .
    }`);
  assert.deepEqual(r.rows[0], { commenter: 'person:bex', assignee: 'person:ada' });
});

// ── the wire: /api/graph is fresh after a write ────────────────────────────
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

test('POST /api/graph serves the replica and reflects a write made moments before', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const q = (query) => fetch(`${srv.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, by: 'ada' }),
    }).then((r) => r.json());

    const before = await q(`SELECT ?c WHERE { ?c a schema:CreativeWork ; schema:name "fresh card" . }`);
    assert.equal(before.returned, 0);

    await fetch(`${srv.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'fresh card', description: 'x', createdBy: 'ada' }),
    });

    const after = await q(`SELECT ?c ?who WHERE { ?c a schema:CreativeWork ; schema:name "fresh card" ; schema:creator ?who . }`);
    assert.equal(after.returned, 1, 'the replica rebuilt after the write');
    assert.equal(after.rows[0].who, 'person:ada');

    const refused = await fetch(`${srv.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'DELETE WHERE { ?s ?p ?o }' }),
    });
    assert.equal(refused.status, 400, 'writes refuse over the wire too');
  } finally {
    await srv.stop();
  }
});

// ── the MCP tool rides the same surface ────────────────────────────────────
import { startMcpServer, mcpSession } from './helpers/harness.mjs';

test('MCP graph_query round-trips a traversal with prefixed results', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    await fetch(`${rest.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'via mcp', description: '', createdBy: 'ada' }),
    });
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('graph_query', {
      query: 'SELECT ?who WHERE { ?c schema:name "via mcp" ; schema:creator ?who . }', by: 'ada',
    });
    const payload = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(payload.rows[0].who, 'person:ada');
    assert.equal(payload.truncated, false);
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
