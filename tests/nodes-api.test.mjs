/**
 * #219 — node-shaped read endpoints (the wiki's read API), built on the proven
 * foundation (domain + tree + links). Behavior tests via the isolated harness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const card = (id, shortId, title, extra = {}) => ({
  id, shortId, title, description: '', type: 'task', assignees: ['sage'],
  labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});

const board = {
  cards: [
    card('p', 1, 'Parent'),
    card('c', 2, 'Child', { parent: 'p' }),
    card('l', 3, 'Linker', { description: 'see [[Parent]] for details' }),
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 4,
};

function apiTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer({ board });
    try { await fn(server); } finally { await server.stop(); }
  });
}

apiTest('GET /api/nodes returns the schema.org node projection + derived tree', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/nodes`);
  assert.equal(res.status, 200);
  const { nodes, tree } = await res.json();
  assert.equal(nodes.length, 3);
  assert.ok(nodes.every((n) => n['@type'] === 'CreativeWork'), 'schema.org-shaped');
  const roots = tree.map((t) => t.id).sort();
  assert.deepEqual(roots, ['l', 'p'], 'Parent + Linker are roots; Child nests');
  const parent = tree.find((t) => t.id === 'p');
  assert.equal(parent.children[0].id, 'c', 'Child nests under Parent');
});

apiTest('GET /api/nodes/:id returns the page view — node + children + backlinks', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/nodes/p`);
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.node.name, 'Parent');
  assert.deepEqual(view.children.map((c) => c.name), ['Child']);
  assert.deepEqual(view.backlinks.map((b) => b.name), ['Linker'], 'Linker [[Parent]] backlinks here');
});

apiTest('GET /api/nodes/:id resolves by shortId too, and 404s on a miss', async ({ baseUrl }) => {
  const byShort = await fetch(`${baseUrl}/api/nodes/1`);
  assert.equal(byShort.status, 200);
  assert.equal((await byShort.json()).node.name, 'Parent');
  const miss = await fetch(`${baseUrl}/api/nodes/nope`);
  assert.equal(miss.status, 404);
});

// ── write path (editing) ──────────────────────────────────────────────────

const j = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

apiTest('POST /api/nodes creates a node (node-shaped in + out) and persists it', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/nodes`, j('POST', { title: 'New Page', body: 'hello [[Parent]]', parent: 'p' }));
  assert.equal(res.status, 201);
  const node = await res.json();
  assert.equal(node['@type'], 'CreativeWork');
  assert.equal(node.name, 'New Page');
  assert.equal(node.text, 'hello [[Parent]]');
  assert.equal(node.isPartOf, 'p');
  assert.ok(node['@id'], 'server-assigned id');
  assert.equal((await fetch(`${baseUrl}/api/nodes/${node['@id']}`)).status, 200, 'persisted + retrievable');
});

apiTest('POST /api/nodes without a title is rejected 400', async ({ baseUrl }) => {
  assert.equal((await fetch(`${baseUrl}/api/nodes`, j('POST', { body: 'no title' }))).status, 400);
});

apiTest('PATCH /api/nodes/:id edits title + body, and can clear the parent', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/nodes/c`, j('PATCH', { title: 'Renamed', body: 'new body', parent: null }));
  assert.equal(res.status, 200);
  const node = await res.json();
  assert.equal(node.name, 'Renamed');
  assert.equal(node.text, 'new body');
  const { tree } = await (await fetch(`${baseUrl}/api/nodes`)).json();
  assert.ok(tree.some((t) => t.id === 'c'), 'cleared parent → c is now a root');
});

// #220 — reparent (drag-drop) must not create a cycle: a node can't become a
// descendant of itself, or the node would vanish from the tree (no root path).
apiTest('PATCH /api/nodes/:id rejects a reparent that would create a cycle', async ({ baseUrl }) => {
  // Board has p → c. Try to make p a child of its own child c: cycle.
  const res = await fetch(`${baseUrl}/api/nodes/p`, j('PATCH', { parent: 'c' }));
  assert.equal(res.status, 409, 'cycle-creating reparent rejected');
  // p stays a root, c stays under p — nothing corrupted.
  const { tree } = await (await fetch(`${baseUrl}/api/nodes`)).json();
  assert.ok(tree.some((t) => t.id === 'p' && t.children.some((k) => k.id === 'c')),
    'tree intact: p root, c child');
});

apiTest('PATCH /api/nodes/:id rejects making a node its own parent', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/nodes/p`, j('PATCH', { parent: 'p' }));
  assert.equal(res.status, 409, 'self-parent rejected');
});

apiTest('PATCH /api/nodes/:id allows a legitimate reparent', async ({ baseUrl }) => {
  // Move the linker under p — no cycle, should succeed.
  const res = await fetch(`${baseUrl}/api/nodes/l`, j('PATCH', { parent: 'p' }));
  assert.equal(res.status, 200);
  const { tree } = await (await fetch(`${baseUrl}/api/nodes`)).json();
  assert.ok(tree.some((t) => t.id === 'p' && t.children.some((k) => k.id === 'l')), 'l moved under p');
});

// #223 — a page create / content-edit posts a compact commons notice (events→
// subscribers). A parent-only reparent does NOT (that'd be drag-reorg noise).
const convs = async (baseUrl) => (await fetch(`${baseUrl}/api/conversations`)).json();

apiTest('#223 creating a page posts a "page created" commons notice', async ({ baseUrl }) => {
  const before = (await convs(baseUrl)).length;
  await fetch(`${baseUrl}/api/nodes`, j('POST', { title: 'Fresh Page', body: 'hi' }));
  const after = await convs(baseUrl);
  assert.equal(after.length, before + 1, 'one notice posted');
  const notice = after[after.length - 1];
  assert.match(notice.body, /created/i, 'says created: ' + notice.body);
  assert.match(notice.body, /Fresh Page/, 'names the page');
});

apiTest('#223 editing a page\'s content posts a "page updated" notice', async ({ baseUrl }) => {
  const before = (await convs(baseUrl)).length;
  await fetch(`${baseUrl}/api/nodes/p`, j('PATCH', { body: 'edited body' }));
  const after = await convs(baseUrl);
  assert.equal(after.length, before + 1, 'one notice posted');
  assert.match(after[after.length - 1].body, /updated/i);
});

apiTest('#223 a parent-only reparent posts NO commons notice (no drag noise)', async ({ baseUrl }) => {
  const before = (await convs(baseUrl)).length;
  await fetch(`${baseUrl}/api/nodes/c`, j('PATCH', { parent: null })); // reparent only
  const after = await convs(baseUrl);
  assert.equal(after.length, before, 'reparent-only is silent');
});

// #222 — page attachments: a node carries attachments (sanitized), first-class,
// surviving create → GET and the JSON-LD round-trip.
const att = (id, name, mime) => ({ id, name, mime, size: 100 });

apiTest('#222 POST /api/nodes stores sanitized attachments; GET returns them', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/nodes`, j('POST', {
    title: 'With Media', body: '',
    attachments: [att('aaa.png', 'shot.png', 'image/png'), { id: '../../etc/passwd', name: 'evil' }],
  }));
  assert.equal(res.status, 201);
  const node = await res.json();
  assert.equal(node.attachments.length, 1, 'the traversal-y id was dropped by sanitize');
  assert.equal(node.attachments[0].id, 'aaa.png');
  // survives a re-read (JSON-LD round-trip through the store)
  const reread = await (await fetch(`${baseUrl}/api/nodes/${node.identifier}`)).json();
  assert.equal(reread.node.attachments[0].id, 'aaa.png', 'attachment persisted through the domain');
});

apiTest('#222 PATCH /api/nodes/:id can set + clear attachments', async ({ baseUrl }) => {
  await fetch(`${baseUrl}/api/nodes/p`, j('PATCH', { attachments: [att('b.jpg', 'pic.jpg', 'image/jpeg')] }));
  let node = (await (await fetch(`${baseUrl}/api/nodes/p`)).json()).node;
  assert.equal(node.attachments[0].id, 'b.jpg', 'attachment set on the page');
  await fetch(`${baseUrl}/api/nodes/p`, j('PATCH', { attachments: [] }));
  node = (await (await fetch(`${baseUrl}/api/nodes/p`)).json()).node;
  assert.deepEqual(node.attachments, [], 'attachments cleared');
});
