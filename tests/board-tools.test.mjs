/**
 * #1196 slice B — WHAT A COLLEAGUE MAY REACH.
 *
 * Two things are settled here, and the second is the one that was broken.
 *
 * 1. The surface is READ-ONLY and small on purpose: read a card, search the
 *    board, query the graph. A colleague that can look things up is the whole
 *    point of the epic; a colleague that can delete things is a different card
 *    with a different conversation in front of it.
 *
 * 2. A GRANT IS REAL. Before this, an agent's toolGrants list changed one
 *    sentence of its prompt and nothing else — an agent granted everything and
 *    an agent granted nothing differed by a line of English. Grants now decide what is
 *    offered to the model at all, so an ungranted tool is not merely discouraged,
 *    it is absent from the request and refused by the loop if asked for anyway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TOOLS, toolsFor, makeExecutor } from '../core/board-tools.mjs';

test('#1196B the surface is read-only, and every tool is named and described', () => {
  const names = BOARD_TOOLS.map((t) => t.function.name).sort();
  assert.deepEqual(names, ['board_search', 'card_get', 'graph_query']);
  for (const t of BOARD_TOOLS) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.description && t.function.description.length > 20, `${t.function.name} needs a description a model can act on`);
    assert.equal(t.function.parameters.type, 'object');
    // ⛔ nothing that writes, ever, on this surface
    assert.doesNotMatch(t.function.name, /create|update|delete|post|claim|assert|write|move/);
  }
});

test('#1196B toolsFor: a grant decides what is OFFERED, not merely what is encouraged', () => {
  assert.deepEqual(toolsFor({ toolGrants: ['card_get'] }).map((t) => t.function.name), ['card_get']);
  assert.deepEqual(toolsFor({ toolGrants: ['card_get', 'graph_query'] }).map((t) => t.function.name).sort(), ['card_get', 'graph_query']);
  // No grants is NO TOOLS — not "all of them", which is the failure mode a
  // permissive default would ship quietly.
  assert.deepEqual(toolsFor({}), []);
  assert.deepEqual(toolsFor({ toolGrants: [] }), []);
  // An unknown grant name is ignored rather than inventing a tool.
  assert.deepEqual(toolsFor({ toolGrants: ['card_delete', 'card_get'] }).map((t) => t.function.name), ['card_get']);
  // A grant this surface does not serve (a write verb the board has elsewhere)
  // must not leak in through the same list.
  assert.deepEqual(toolsFor({ toolGrants: ['card_claim'] }), []);
});

test('#1196B the executor hits the board through the front door, carries the actor, and reports rows', async () => {
  // ⚠️ These path strings were WRONG for an hour and this file stayed green,
  // because the fakes answer whatever they are asked. The paths are pinned
  // against a real server in board-tools-seam.test.mjs; what is checked HERE
  // is the shape a caller must send, including the actor.
  const gets = []; const posts = [];
  const get = async (path) => { gets.push(path); return { shortId: 650, title: 'the research record', description: 'body' }; };
  const post = async (path, body) => {
    posts.push({ path, body });
    if (path === '/api/search') return { results: [{ shortId: 1 }, { shortId: 2 }], coverage: { indexed: 10, total: 10 } };
    return { bindings: [{ s: 'x' }] };
  };
  const exec = makeExecutor({ get, post, by: 'ada' });

  const card = await exec('card_get', { shortId: 650 });
  assert.match(gets[0], /^\/api\/cards\/650$/);
  assert.equal(card.title, 'the research record');

  const found = await exec('board_search', { q: 'vocabulary gap', k: 2 });
  assert.equal(posts[0].path, '/api/search');
  assert.equal(posts[0].body.q, 'vocabulary gap');
  assert.equal(posts[0].body.k, 2);
  assert.equal(posts[0].body.by, 'ada', 'the actor travels: a search logged against nobody cannot answer who asked');
  assert.equal(found.results.length, 2);

  await exec('graph_query', { query: 'SELECT ?s WHERE { ?s ?p ?o }' });
  assert.equal(posts[1].path, '/api/graph');
  assert.equal(posts[1].body.by, 'ada');
});

test('#1196B a query that returns nothing says SO, and never resembles an error', async () => {
  const exec = makeExecutor({ get: async () => ({ results: [], coverage: { indexed: 0, total: 0 } }), post: async () => ({ bindings: [] }) });
  const out = await exec('board_search', { q: 'nothing matches this' });
  assert.deepEqual(out.results, []);
  assert.ok('note' in out, 'zero rows carries a note: a colleague told nothing at all will fill the silence itself, which is the defect this epic exists for');
  assert.match(out.note, /no .*(match|result)/i);
});

test('#1196B the executor refuses an unknown tool by name rather than guessing', async () => {
  const exec = makeExecutor({ get: async () => ({}), post: async () => ({}) });
  await assert.rejects(() => exec('card_delete', {}), /card_delete/);
});

test('#1196B card_get requires a shortId and says which argument was missing', async () => {
  const exec = makeExecutor({ get: async () => ({}), post: async () => ({}) });
  await assert.rejects(() => exec('card_get', {}), /shortId/);
});
