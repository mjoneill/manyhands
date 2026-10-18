/**
 * #1709 — rows for the wiki read API (GET /api/nodes, GET /api/nodes/:id) on a board whose cards live in the executor.
 * TEST AUTHOR's, written before any build; the builder is someone else.
 *
 * Measured on prod 2026-10-18T03:53Z: /api/nodes answered {"nodes":[],"tree":[]} and /api/nodes/1645 was 404 while
 * /api/cards/1645 was version 41, and wiki.html rendered "No pages match.". handleListNodes / handleGetNode read
 * loadDomain(BOARD_DATA_FILE).nodes, and with the cards unit on the document holds no cards.
 *
 *   N0  CONTROL, passes today: cards unit OFF (the document is the store) — /api/nodes lists the fixture's cards.
 *   N1  cards unit ON (prod flags, whole-board fixture): /api/nodes lists every card /api/cards lists, by identifier,
 *       including one created AFTER the migration. RED today (an empty list).
 *   N2  cards unit ON: /api/nodes/<shortId> of that new card is 200 and names it; an unknown id is still 404. RED today.
 *   N3  CONTROL (must keep passing): the node SHAPE the wiki reads — each node carries @id, identifier and name, and
 *       `tree` has roots. It passes today only because the fixture's document still holds a FROZEN copy of cards 1-3.
 *   N4  STALENESS, not only absence: a card renamed through the unit after the migration shows its NEW name at
 *       /api/nodes/<shortId>. RED today (the frozen document copy answers with the old name).
 *
 * NOT covered, by name: PATCH and POST /api/nodes (#597, #841 — DONE WHEN 4 asks the builder to check them); what
 * wiki.html renders (the 03:54Z screen check is the beneficiary reading, not a row); export-wiki.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };

async function api(base, method, route, body) {
  const r = await fetch(`${base}${route}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* reported by the caller */ }
  return { status: r.status, json, text };
}
const ids = (nodes) => nodes.map((n) => String(n.identifier)).sort();

async function unitWorld(fn) {
  const w = await wholeBoardWorld({ env: PROD });
  try {
    const made = await api(w.rest.baseUrl, 'POST', '/api/cards', { title: 'born after the migration (#1709)', createdBy: 'ada' });
    assert.equal(made.status, 201, `PRECONDITION: a card is created through the unit (${made.status}: ${made.text.slice(0, 160)})`);
    await fn(w.rest.baseUrl, made.json);
  } finally { await w.stop(); }
}

test('#1709 (N0 CONTROL) with the cards unit OFF the document is the store, and /api/nodes lists its cards', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture() });
  try {
    const made = await api(rest.baseUrl, 'POST', '/api/cards', { title: 'a document-board card (#1709 N0)', createdBy: 'ada' });
    assert.equal(made.status, 201, `PRECONDITION: a card is created (${made.status}: ${made.text.slice(0, 160)})`);
    const cards = (await api(rest.baseUrl, 'GET', '/api/cards?limit=500')).json;
    const list = Array.isArray(cards) ? cards : cards.cards;
    assert.ok(list.length > 0, 'PRECONDITION: the fixture has cards');
    const n = await api(rest.baseUrl, 'GET', '/api/nodes');
    assert.equal(n.status, 200, n.text.slice(0, 160));
    for (const c of list) assert.ok(ids(n.json.nodes).includes(String(c.shortId)), `node for card #${c.shortId}`);
  } finally { await rest.stop(); }
});

test('#1709 (N1) cards unit ON: /api/nodes lists every card the unit serves, including one created after the migration', { skip: SKIP, timeout: 300000 }, async () => {
  await unitWorld(async (base, made) => {
    const cards = (await api(base, 'GET', '/api/cards?limit=500')).json;
    const list = Array.isArray(cards) ? cards : cards.cards;
    assert.ok(list.some((c) => c.shortId === made.shortId), 'PRECONDITION: /api/cards serves the new card');
    const n = await api(base, 'GET', '/api/nodes');
    assert.equal(n.status, 200, n.text.slice(0, 160));
    assert.ok(n.json.nodes.length > 0, `the wiki list must not be empty while /api/cards serves ${list.length} cards`);
    for (const c of list) assert.ok(ids(n.json.nodes).includes(String(c.shortId)), `node for card #${c.shortId} (have ${ids(n.json.nodes).join(',')})`);
  });
});

test('#1709 (N2) cards unit ON: /api/nodes/<shortId> of the new card is 200 and names it; an unknown id is still 404', { skip: SKIP, timeout: 300000 }, async () => {
  await unitWorld(async (base, made) => {
    const one = await api(base, 'GET', `/api/nodes/${made.shortId}`);
    assert.equal(one.status, 200, `the new card's page must resolve (got ${one.status}: ${one.text.slice(0, 160)})`);
    assert.equal(String((one.json.node ?? one.json).identifier), String(made.shortId));
    assert.equal((await api(base, 'GET', '/api/nodes/99999')).status, 404, 'CONTROL: an id no card has is still 404, never a made-up page');
  });
});

test('#1709 (N3 CONTROL) cards unit ON: the node shape the wiki reads is kept (@id, identifier, name; a tree root per parentless card)', { skip: SKIP, timeout: 300000 }, async () => {
  await unitWorld(async (base) => {
    const n = (await api(base, 'GET', '/api/nodes')).json;
    assert.ok(n.nodes.length > 0, 'PRECONDITION for the shape row: there are nodes');
    for (const node of n.nodes) {
      assert.equal(typeof node['@id'], 'string', 'each node has an @id');
      assert.ok(node.identifier != null, 'and an identifier');
      assert.equal(typeof node.name, 'string', 'and a name');
    }
    assert.ok(Array.isArray(n.tree) && n.tree.length > 0, 'and the tree has roots');
  });
});

test('#1709 (N4) cards unit ON: a card renamed after the migration shows its NEW name in the wiki API, not the frozen one', { skip: SKIP, timeout: 300000 }, async () => {
  await unitWorld(async (base) => {
    const before = (await api(base, 'GET', '/api/cards/1')).json;
    const renamed = `renamed after the migration ${Math.random().toString(16).slice(2, 8)}`;
    const p = await api(base, 'PATCH', '/api/cards/1', { by: 'ada', title: renamed, ifVersion: before.version });
    assert.equal(p.status, 200, `PRECONDITION: the rename applies (${p.status}: ${p.text.slice(0, 160)})`);
    assert.equal((await api(base, 'GET', '/api/cards/1')).json.title, renamed, 'PRECONDITION: /api/cards serves the new name');
    const one = await api(base, 'GET', '/api/nodes/1');
    assert.equal(one.status, 200, one.text.slice(0, 160));
    assert.equal((one.json.node ?? one.json).name, renamed, 'the wiki page must show the current title, not the document\'s frozen copy');
  });
});
