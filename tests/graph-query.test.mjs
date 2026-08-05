/**
 * #694 — graph_query: the traversal engine's contract.
 * Read-only by refusal AND by construction · bounded with confessed cuts ·
 * fresh after writes (the wire test) · prefixed short forms for token economy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, syncGraphStore, updateEntity } from '../core/graph-replica.mjs';
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

    // the experiment's instrument leaves a receipt: every query logged with its seat
    const fsm = await import('node:fs');
    const pm = await import('node:path');
    const logFile = pm.join(pm.dirname(srv.boardFile), 'graph-query-log.jsonl');
    const entries = fsm.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(entries.length >= 2, 'both queries logged');
    assert.equal(entries[0].by, 'ada', 'the declared seat rides the log');

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

// ── the replica must not lie: parity + completeness invariants ─────────────
// The graph is now an INSTRUMENT other seats verify with. A projection bug
// (a dropped predicate, a missed entity class) would serve confidently wrong
// answers — a lying instrument is worse than none. These pin agreement with
// the document it projects.

test('PARITY: entity counts and spot fields agree between the document and the replica', () => {
  const d = doc();
  const store = buildGraphStore(d);
  const count = (type) => queryGraph(store, `SELECT (COUNT(?s) AS ?n) WHERE { ?s a ${type} . }`).rows[0].n;
  assert.equal(Number(count('schema:CreativeWork')), d['@graph'].filter((e) => e['@type'] === 'CreativeWork').length);
  assert.equal(Number(count('schema:Comment')), d['@graph'].filter((e) => e['@type'] === 'Comment').length);
  assert.equal(Number(count('schema:Person')), d['@graph'].filter((e) => e['@type'] === 'Person').length);
  assert.equal(Number(count('scrum:Column')), d['@graph'].filter((e) => e['@type'] === 'scrum:Column').length);
  // spot fields: every card's title round-trips into the graph
  const titles = queryGraph(store, `SELECT ?t WHERE { ?c a schema:CreativeWork ; schema:name ?t . }`).rows.map((r) => r.t).sort();
  assert.deepEqual(titles, ['alpha', 'beta', 'gamma']);
  // every relationship edge in the doc exists as a triple
  const edges = queryGraph(store, `SELECT ?s ?o WHERE { ?s scrum:relatedTo ?o . }`).rows.length;
  assert.equal(edges, 2, 'both relatedTo edges projected');
});

test('COMPLETENESS: no entity class in the document goes silently unprojected', () => {
  const d = doc();
  d['@graph'].push({ '@type': 'scrum:FutureThing', '@id': 'ft-1', name: 'unmodelled' });
  const store = buildGraphStore(d);
  // every @graph entity must be a subject in the store, even if only minimally —
  // an entity class the projection doesn't know may NOT simply vanish.
  const subjects = new Set(queryGraph(store, `SELECT DISTINCT ?s WHERE { ?s ?p ?o . }`, { limit: 1000 }).rows.map((r) => r.s));
  assert.ok([...subjects].some((s) => s.endsWith('ft-1')),
    'an unknown entity class must still surface as a typed subject, not vanish');
});

// ── #714 — incremental replica maintenance ────────────────────────────────
// The full rebuild is correct by construction: throw the store away, re-project,
// it cannot drift. Incremental maintenance gives that up for speed, so the whole
// bet rests on ONE guard — after N incremental updates the store must be
// triple-for-triple what a full rebuild would have produced. Without that, this
// makes the replica quietly WRONG instead of merely slow.

const dumpSorted = (store) => store.dump({ format: 'application/n-quads' }).split('\n').filter(Boolean).sort().join('\n');

test('#714 PARITY: a store maintained incrementally is triple-for-triple identical to a full rebuild', () => {
  const doc = {
    '@graph': [
      { '@id': 'a1', '@type': 'CreativeWork', identifier: 1, name: 'first', creator: 'ada', relatedTo: ['b2'] },
      { '@id': 'b2', '@type': 'CreativeWork', identifier: 2, name: 'second', 'scrum:priority': 'p2' },
      { '@id': 'https://scrumboard.local/person/ada', '@type': 'Person', identifier: 'ada', name: 'Ada' },
      { '@id': 'm1', '@type': 'Comment', author: 'ada', about: 'a1', text: 'hello' },
    ],
  };
  const inc = buildGraphStore({ '@graph': [] });
  let { hashes } = syncGraphStore(inc, doc, null);

  // a sequence of realistic mutations, applied incrementally
  doc['@graph'][0].name = 'first EDITED';                       // field change
  doc['@graph'][1]['scrum:priority'] = 'p0';                    // another field
  doc['@graph'][0].relatedTo = ['b2', 'm1'];                    // edge added
  doc['@graph'].push({ '@id': 'c3', '@type': 'CreativeWork', identifier: 3, name: 'third' });  // new entity
  ({ hashes } = syncGraphStore(inc, doc, hashes));

  doc['@graph'] = doc['@graph'].filter((e) => e['@id'] !== 'm1');  // entity removed
  const stats = syncGraphStore(inc, doc, hashes);
  assert.equal(stats.removed, 1, 'the dropped entity was detected and its triples removed');

  const full = buildGraphStore(doc);
  assert.equal(dumpSorted(inc), dumpSorted(full),
    'incremental store must equal a full rebuild exactly — otherwise this trades slow for wrong');
});

test('#714 an update touches only its own subject — arrows INTO an entity survive re-indexing it', () => {
  const doc = { '@graph': [
    { '@id': 'a1', '@type': 'CreativeWork', identifier: 1, name: 'a', relatedTo: ['b2'] },
    { '@id': 'b2', '@type': 'CreativeWork', identifier: 2, name: 'b' },
  ] };
  const store = buildGraphStore({ '@graph': [] });
  syncGraphStore(store, doc, null);
  const before = store.match(null, null, null).length;

  // re-index b2 — the target of a1's arrow. a1's triples must not move.
  doc['@graph'][1].name = 'b EDITED';
  updateEntity(store, doc['@graph'][1]);

  assert.equal(store.match(null, null, null).length, before, 'no triples leaked or duplicated');
  const edge = store.match(null, null, null).filter((q) => q.object.value.endsWith('/b2') && q.predicate.value.endsWith('relatedTo'));
  assert.equal(edge.length, 1, 'the arrow a1→b2 survived re-indexing b2 — deletion is subject-scoped');
});

test('#714 a cold sync equals a full rebuild — the incremental path has no separate cold case', () => {
  const doc = { '@graph': [
    { '@id': 'x', '@type': 'CreativeWork', identifier: 9, name: 'x', labels: ['one', 'two'] },
    { '@id': 'https://scrumboard.local/column/backlog', '@type': 'scrum:Column', identifier: 'backlog', name: 'Backlog', 'scrum:order': 0 },
  ] };
  const inc = buildGraphStore({ '@graph': [] });
  syncGraphStore(inc, doc, null);
  assert.equal(dumpSorted(inc), dumpSorted(buildGraphStore(doc)));
});
