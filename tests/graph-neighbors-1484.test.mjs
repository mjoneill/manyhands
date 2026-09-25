/**
 * #1484 — graph_neighbors: "what's near me?" as ONE call, no SPARQL.
 *
 * The graph answered only seats who could write SPARQL correctly (#1104's clean
 * zeros, #1244's spent hop budget, #698's missing DIRECTION). This verb takes a
 * node a seat can NAME and returns its edges grouped by predicate and direction,
 * each neighbour labelled, with every cut confessed.
 *
 * Decisions (on the card, 13:00Z): edges vs properties split; prov:* collapsed to
 * `history`; digits mean a card and nothing else, no prefixes of any kind;
 * rdf:type becomes `kinds`; 10 members per group by default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, projectActivities } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { graphNeighbors } from '../core/graph-neighbors.mjs';

const card = (id, shortId, name, text, rel = {}) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name, text,
  additionalType: 'scrum:task', board: { column: 'backlog', relationships: { relatedTo: [], ...rel } },
});
const post = (id, text, about) => ({
  '@type': 'Comment', '@id': id, author: 'ada', dateCreated: '2026-09-25T10:00:00.000Z', text,
  ...(about ? { about } : {}),
});

const store = () => buildGraphStore(domainToJsonLd({
  nodes: [
    card('u-a', 1, 'alpha', 'see #2 for the measurement', { relatedTo: [2] }),
    card('u-b', 2, 'beta', 'the measurement', { relatedTo: [1] }),
    card('u-c', 3, 'gamma', 'nobody names me'),
    ...Array.from({ length: 14 }, (_, i) => card(`u-x${i}`, 10 + i, `cites alpha ${i}`, 'follows #1')),
  ],
  messages: [post('m-1', 'a thought about alpha', 'u-a')],
  people: [], columns: [],
}));
const group = (r, dir, pred) => r.edges.find((g) => g.direction === dir && g.predicate === pred);

test('#1484 a card answers in ONE call: out and in edges, grouped by predicate AND direction, labelled', () => {
  const r = graphNeighbors(store(), { node: '1' });
  assert.equal(r.node.label, '#1 alpha');
  const outRel = group(r, 'out', 'scrum:relatedTo');
  assert.ok(outRel, `out relatedTo group: ${JSON.stringify(r.edges.map((g) => [g.direction, g.predicate]))}`);
  assert.deepEqual(outRel.members.map((m) => m.label), ['#2 beta']);
  const inAbout = group(r, 'in', 'schema:about');
  assert.ok(inAbout, 'the post attached to #1 arrives as an IN edge');
  assert.match(inAbout.members[0].label, /^ada: a thought about alpha/);
});

test('#1484 DIRECTION is never merged: the same predicate in and out stays two groups', () => {
  const r = graphNeighbors(store(), { node: '1' });
  const out = group(r, 'out', 'scrum:mentionsCard');
  const inn = group(r, 'in', 'scrum:mentionsCard');
  assert.ok(out && inn, 'alpha both mentions #2 and is mentioned by 14 cards');
  assert.deepEqual(out.members.map((m) => m.label), ['#2 beta']);
  assert.equal(inn.total, 14);
  assert.ok(!inn.members.some((m) => m.label === '#2 beta'), 'an out edge leaking into the in group would read as a backlink that does not exist');
});

test('#1484 the default group limit is 10 members, and the total still counts everything', () => {
  const inn = group(graphNeighbors(store(), { node: '1' }), 'in', 'scrum:mentionsCard');
  assert.equal(inn.members.length, 10);
  assert.equal(inn.total, 14);
});

test('#1484 truncation is CONFESSED: a cut group says so, a group that fits does not', () => {
  const r = graphNeighbors(store(), { node: '1' });
  assert.equal(group(r, 'in', 'scrum:mentionsCard').truncated, true);
  assert.equal(group(r, 'out', 'scrum:relatedTo').truncated, false, 'a group that fits must not claim a cut');
});

test('#1484 literals are properties, not neighbours; the body is never an edge; rdf:type is kinds', () => {
  const r = graphNeighbors(store(), { node: '1' });
  assert.ok(!r.edges.some((g) => g.predicate === 'schema:text'), 'the body text is not a neighbour');
  assert.ok(!r.edges.some((g) => g.predicate === 'rdf:type'), 'rdf:type is kinds, not a group');
  assert.ok(r.kinds.includes('schema:CreativeWork'), JSON.stringify(r.kinds));
  assert.equal(r.properties['schema:name'], 'alpha');
  assert.equal(r.properties['schema:text'], undefined, 'default properties are name and identifier only');
  assert.equal(graphNeighbors(store(), { node: '1', properties: 'all' }).properties['schema:text'], 'see #2 for the measurement');
});

test('#1484 a real node with no edges says it EXISTS; an unknown node REFUSES by name, never a clean zero', () => {
  const lonely = graphNeighbors(store(), { node: '3' });
  assert.equal(lonely.exists, true);
  assert.ok(Array.isArray(lonely.edges));
  assert.throws(() => graphNeighbors(store(), { node: '999' }), (e) => e.code === 'UNKNOWN_NODE' && /999/.test(e.message));
  assert.throws(() => graphNeighbors(store(), { node: 'not-an-id' }), (e) => e.code === 'UNKNOWN_NODE');
});

test('#1484 digits mean a CARD and nothing else: no prefix matching of any kind', () => {
  // "1" is also a valid hex prefix of a decision uuid; a prefix-matching resolver
  // could silently prefer the wrong node. Digits resolve to the card or refuse.
  assert.throws(() => graphNeighbors(store(), { node: '12a' }), (e) => e.code === 'UNKNOWN_NODE');
  assert.equal(graphNeighbors(store(), { node: '2' }).node.label, '#2 beta');
});

test('#1484 a post and a card are both reachable by full uuid, with or without entity:', () => {
  assert.match(graphNeighbors(store(), { node: 'm-1' }).node.label, /^ada:/);
  assert.equal(graphNeighbors(store(), { node: 'entity:u-b' }).node.label, '#2 beta');
});

test('#1484 direction and predicates filters narrow the answer and nothing else', () => {
  const out = graphNeighbors(store(), { node: '1', direction: 'out' });
  assert.ok(out.edges.length > 0 && out.edges.every((g) => g.direction === 'out'));
  const only = graphNeighbors(store(), { node: '1', predicates: ['scrum:relatedTo'] });
  assert.ok(only.edges.length > 0 && only.edges.every((g) => g.predicate === 'scrum:relatedTo'));
});

test('#1484 write history (prov:*) is COLLAPSED by default, and opt-in returns it as groups', () => {
  const s = store();
  const ev = (seq, at) => ({
    seq, recorded_at: at, occurred_at: at, actor: 'ada', op: 'update',
    entity: { kind: 'card', id: 'u-a' }, state: { id: 'u-a' },
  });
  projectActivities(s, [ev(1, '2026-09-25T10:00:00.000Z'), ev(2, '2026-09-25T11:00:00.000Z')]);
  const r = graphNeighbors(s, { node: '1' });
  assert.ok(!r.edges.some((g) => g.predicate.startsWith('prov:')), `a busy card must not read as a list of writes: ${JSON.stringify(r.edges.map((g) => g.predicate))}`);
  assert.equal(r.history.count, 2, JSON.stringify(r.history));
  assert.ok(r.history.latest, 'the latest write is named');
  const withHist = graphNeighbors(s, { node: '1', includeHistory: true });
  assert.ok(withHist.edges.some((g) => g.predicate.startsWith('prov:') && g.direction === 'in'), 'opt-in returns the writes as an in-group');
});

test('#1484 PINNED: digits that match no card NEVER resolve to a decision whose uuid starts with them', () => {
  // The review's mutation (13:25Z): a digits fall-through to decision-prefix matching
  // survived all 11 tests. This is the collision point 3 exists to prevent.
  const s = buildGraphStore(domainToJsonLd({
    nodes: [card('u-a', 1, 'alpha', '')],
    messages: [], people: [], columns: [],
    decisions: [{ '@type': 'scrum:Decision', '@id': 'https://scrumboard.local/decision/4567abcd-0000-4000-8000-000000000001',
      identifier: '4567abcd-0000-4000-8000-000000000001', 'scrum:statement': 'a ruling', 'scrum:decidedBy': 'ada' }],
  }));
  assert.ok(graphNeighbors(s, { node: 'decision:4567abcd-0000-4000-8000-000000000001' }).exists, 'control: the decision IS reachable by its full id');
  assert.throws(() => graphNeighbors(s, { node: '4567' }), (e) => e.code === 'UNKNOWN_NODE', 'digits must mean a card or refuse');
});

test('#1484 two cards sharing a shortId are reported AMBIGUOUS, naming both, not "no node answers"', () => {
  const s = buildGraphStore(domainToJsonLd({ nodes: [card('u-a', 5, 'one', ''), card('u-b', 5, 'two', '')], messages: [], people: [], columns: [] }));
  assert.throws(() => graphNeighbors(s, { node: '5' }), (e) => e.code === 'AMBIGUOUS_NODE' && e.candidates.length === 2);
});

test('#1484 an explicit prov:* predicate filter returns those edges instead of silently collapsing them', () => {
  const s = store();
  projectActivities(s, [{ seq: 1, recorded_at: '2026-09-25T10:00:00.000Z', occurred_at: '2026-09-25T10:00:00.000Z', actor: 'ada', op: 'update', entity: { kind: 'card', id: 'u-a' }, state: { id: 'u-a' } }]);
  const r = graphNeighbors(s, { node: '1', predicates: ['prov:used'] });
  assert.ok(r.edges.some((g) => g.predicate === 'prov:used'), `asked for prov:used by name: ${JSON.stringify(r.edges)}`);
});

// ── the seam: called the way a seat calls it, through MCP → REST → replica ──
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const seamBoard = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'first', description: 'see #2', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: { relatedTo: [2] } },
    { id: 'u-2', shortId: 2, title: 'second', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: { relatedTo: [1] } },
  ],
  nextShortId: 3,
});

test('#1484 SEAM: a seat calls graph_neighbors over MCP and gets labelled groups; an unknown id refuses by name', { timeout: 30000 }, async () => {
  const rest = await startRestServer({ board: seamBoard() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const tools = await session.listTools();
    assert.ok(JSON.stringify(tools).includes('"graph_neighbors"'), 'the tool is registered where a seat looks');
    const r = await session.callTool('graph_neighbors', { node: '1' });
    const text = r.result?.content?.[0]?.text ?? '';
    const body = JSON.parse(text);
    assert.equal(body.node.label, '#1 first');
    const out = body.edges.find((g) => g.direction === 'out' && g.predicate === 'scrum:relatedTo');
    assert.deepEqual(out?.members.map((m) => m.label), ['#2 second'], text.slice(0, 400));
    const bad = await session.callTool('graph_neighbors', { node: '999' });
    const badText = JSON.stringify(bad);
    assert.match(badText, /UNKNOWN_NODE|no node answers/, `a clean zero here is #1104's trap: ${badText.slice(0, 300)}`);
  } finally { await mcp.stop(); await rest.stop(); }
});
