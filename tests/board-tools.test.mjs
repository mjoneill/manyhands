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
  assert.deepEqual(names, ['board_search', 'card_get', 'graph_query', 'kind_list']);
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

/**
 * ⛔ THE NOTE MUST NOT CONTRADICT THE ROWS. The zero-row note was keyed on
 * `bindings` — a name /api/graph has never answered with — so it fired on every
 * successful query: the model received rows AND a sentence saying the query
 * matched nothing. Silent, and worse than an error, because a colleague told
 * "nothing matched" beside real rows learns not to believe its own tools.
 */
test('#1196B graph_query reads the name the route answers with, so a full result is never labelled empty', async () => {
  const full = { rows: [{ s: 'entity:1' }, { s: 'entity:2' }], returned: 2 };
  const exec = makeExecutor({ get: async () => ({}), post: async () => full });
  const out = await exec('graph_query', { query: 'SELECT ?s WHERE { ?s ?p ?o }' });
  assert.equal(out.rows.length, 2);
  assert.ok(!('note' in out), 'two rows came back: nothing may tell the model the query matched nothing');

  const empty = makeExecutor({ get: async () => ({}), post: async () => ({ rows: [], returned: 0 }) });
  const none = await empty('graph_query', { query: 'SELECT ?s WHERE { ?s a scrum:Nothing }' });
  assert.deepEqual(none.rows, []);
  assert.match(none.note, /matched nothing/i);
  // and an empty result points at the orientation tool, because guessing at
  // names is what produces empty results in the first place
  assert.match(none.note, /kind_list/);
});

const KINDS = [
  { name: 'scrum:Card', createdBy: 'card_create / POST /api/cards', definition: 'A unit of work with a permanent short id. The short id is IDENTITY and never changes, and much more prose follows here.' },
  { name: 'scrum:Decision', createdBy: 'decision_create', definition: 'A ruling the board has made and can be held to.' },
];

test('#1196B kind_list answers what KINDS of thing live here, summarised, with the verb that creates each', async () => {
  const paths = [];
  const exec = makeExecutor({ get: async (p) => { paths.push(p); return KINDS; }, post: async () => ({}) });
  const out = await exec('kind_list', {});
  assert.match(paths[0], /^\/api\/kinds/);
  assert.equal(out.kinds.length, 2);
  assert.equal(out.kinds[0].name, 'scrum:Card');
  assert.equal(out.kinds[0].createdBy, 'card_create / POST /api/cards');
  // ONE sentence, not the register: the full text is ~18 KB and a small model
  // spends its entire budget reading it instead of answering.
  assert.equal(out.kinds[0].definition, 'A unit of work with a permanent short id.');
  assert.doesNotMatch(out.kinds[0].definition, /IDENTITY/);
});

test('#1196B kind_list by name returns that kind WHOLE, and an unregistered name is an ANSWER naming what is registered', async () => {
  const exec = makeExecutor({ get: async () => KINDS, post: async () => ({}) });
  const one = await exec('kind_list', { name: 'scrum:Decision' });
  assert.equal(one.name, 'scrum:Decision');
  assert.match(one.definition, /held to/, 'asked for one kind, the model gets the FULL definition, not the summary');

  const missing = await exec('kind_list', { name: 'scrum:Sprocket' });
  assert.equal(missing.found, false);
  assert.match(missing.note, /does not record/i);
  assert.match(missing.note, /scrum:Card/, 'a miss names what IS registered — otherwise the model guesses again');
});
