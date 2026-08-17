/**
 * Server-side tests for the node domain (ADR-001 #214, ADR-002 #216).
 *
 * Behavior tests — assert on observable mapping output and the lossless
 * round-trip contract, not on internal calls. Pure (no server, no I/O), so
 * they cannot touch the live board-data.json.
 *
 * Slice 1 (foundation keystone): prove the unified node model can represent
 * our real card/conversation data WITHOUT loss — including legacy stragglers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardToNode, nodeToCard,
  conversationToMessage, messageToConversation,
  boardToDomain, domainToBoard,
} from '../core/mapping.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

// A fully-populated canonical card — every standard field the server writes
// (see createCardFromPayload in server.js).
const canonicalCard = {
  id: '73fefa54-2a27-4b07-adc1-b9dd49885b21',
  shortId: 128,
  title: 'Display commons timestamps in a friendly timezone',
  description: 'Some **markdown** body.',
  type: 'task',
  assignees: ['sage'],
  labels: ['ui', 'commons'],
  for: '',
  priority: 'p2',
  column: 'done',
  order: 3,
  createdAt: '2026-05-22T20:43:42.713Z',
  updatedAt: '2026-05-28T14:14:28.887Z',
  relationships: { relatedTo: [112], blockedBy: [] },
};

// ── lossless round-trip ─────────────────────────────────────────────────

test('card → node → card round-trips a canonical card losslessly', () => {
  const back = nodeToCard(cardToNode(canonicalCard));
  assert.deepEqual(back, canonicalCard);
});

test('a legacy singular `assignee` straggler survives the round-trip', () => {
  const legacy = { ...canonicalCard, assignee: 'sage' };
  const back = nodeToCard(cardToNode(legacy));
  assert.deepEqual(back, legacy);
});

test('an unknown future field survives the round-trip (forward-compat)', () => {
  const weird = { ...canonicalCard, someFutureField: { nested: true } };
  const back = nodeToCard(cardToNode(weird));
  assert.deepEqual(back, weird);
});

// Real data is SPARSE: 26 cards lack shortId/for, 53 lack priority, 93 lack
// relationships. The mapper must PRESERVE PRESENCE — never inject a key that
// wasn't there (e.g. `relationships: undefined`), or the round-trip breaks.
test('a sparse card (missing shortId/for/priority/relationships) round-trips losslessly', () => {
  const sparse = {
    id: 'abc-123',
    title: 'Old card from before some fields existed',
    description: '',
    type: 'idea',
    assignees: ['unassigned'],
    labels: [],
    column: 'backlog',
    order: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    // NO shortId, for, priority, relationships — like dozens of real cards
  };
  const back = nodeToCard(cardToNode(sparse));
  assert.deepEqual(back, sparse);
});

test('priority: null round-trips as null — not dropped, not coerced to ""', () => {
  const withNull = { ...canonicalCard, priority: null };
  const back = nodeToCard(cardToNode(withNull));
  assert.ok('priority' in back, 'key present');
  assert.equal(back.priority, null);
});

test('card.parent maps to node.isPartOf (hierarchy) and round-trips', () => {
  const child = { ...canonicalCard, parent: '11111111-2222-3333-4444-555555555555' };
  const node = cardToNode(child);
  assert.equal(node.isPartOf, child.parent, 'parent → isPartOf (schema.org part-whole)');
  assert.deepEqual(nodeToCard(node), child);
});

// ── schema.org shape ────────────────────────────────────────────────────

test('the node is schema.org-shaped: CreativeWork content + board facet', () => {
  const node = cardToNode(canonicalCard);
  assert.equal(node['@type'], 'CreativeWork');
  assert.equal(node['@id'], canonicalCard.id);
  assert.equal(node.identifier, canonicalCard.shortId);   // D3: identifier = shortId
  assert.equal(node.name, canonicalCard.title);           // D3: name = title
  assert.equal(node.text, canonicalCard.description);      // D3: text = body
  assert.equal(node.additionalType, 'scrum:task');        // D3: type via additionalType
  assert.equal(node.dateCreated, canonicalCard.createdAt);
  assert.equal(node.dateModified, canonicalCard.updatedAt);
  assert.ok(node.board, 'carries a board facet');
  assert.equal(node.board.column, canonicalCard.column);
  assert.equal(node.board.order, canonicalCard.order);
  assert.deepEqual(node.board.assignees, canonicalCard.assignees);
});

// ── conversations ↔ messages (schema.org Comment) ─────────────────────────

const floatingConv = {
  id: 'conv-1',
  body: 'hello @sage',
  author: 'alex',
  attachedTo: null,           // commons (floats free)
  attachments: [],
  mentions: ['sage'],
  createdAt: '2026-06-01T12:00:00.000Z',
};

test('conversation → message → conversation round-trips a commons (floating) message', () => {
  const back = messageToConversation(conversationToMessage(floatingConv));
  assert.deepEqual(back, floatingConv);
});

test('the message is schema.org-shaped: Comment with about=null for commons', () => {
  const msg = conversationToMessage(floatingConv);
  assert.equal(msg['@type'], 'Comment');
  assert.equal(msg['@id'], floatingConv.id);
  assert.equal(msg.text, floatingConv.body);
  assert.equal(msg.author, floatingConv.author);
  assert.equal(msg.dateCreated, floatingConv.createdAt);
  assert.equal(msg.about, null, 'about === null means commons');
  assert.deepEqual(msg.mentions, ['sage']);
});

test('an attached message maps attachedTo → about (the node it belongs to)', () => {
  const attached = { ...floatingConv, attachedTo: 'card-uuid-xyz' };
  const msg = conversationToMessage(attached);
  assert.equal(msg.about, 'card-uuid-xyz');
  assert.deepEqual(messageToConversation(msg), attached);
});

test('attachments round-trip losslessly (ImageObject transform deferred)', () => {
  const withAtt = {
    ...floatingConv,
    attachments: [{ id: 'a1.png', name: 'pic.png', mime: 'image/png', size: 1234 }],
  };
  assert.deepEqual(messageToConversation(conversationToMessage(withAtt)), withAtt);
});

test('a legacy `_recovered` straggler survives the round-trip', () => {
  const legacy = { ...floatingConv, _recovered: true };
  assert.deepEqual(messageToConversation(conversationToMessage(legacy)), legacy);
});

// ── whole board ↔ domain ──────────────────────────────────────────────────

const sampleBoard = {
  _README: ['⚠️  do not edit directly'],
  cards: [
    canonicalCard,
    { id: 'x', title: 'sparse', description: '', type: 'idea', assignees: ['unassigned'],
      labels: [], column: 'backlog', order: 0,
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [floatingConv],
  nextShortId: 218,
  lastUpdated: '2026-06-15T01:03:48.625Z',
};

test('whole board → domain → board round-trips losslessly', () => {
  assert.deepEqual(domainToBoard(boardToDomain(sampleBoard)), sampleBoard);
});

test('boardToDomain exposes nodes + messages and passes meta through', () => {
  const domain = boardToDomain(sampleBoard);
  assert.equal(domain.nodes.length, 2);
  assert.equal(domain.messages.length, 1);
  assert.equal(domain.nodes[0]['@type'], 'CreativeWork');
  assert.equal(domain.messages[0]['@type'], 'Comment');
  assert.deepEqual(domain.columns, sampleBoard.columns);   // passthrough
  assert.equal(domain.nextShortId, 218);
  assert.equal(domain.cards, undefined, 'cards renamed to nodes');
});

// ── Non-card nodes (#530 graph work) ──────────────────────────────────────
// ADR-001: "every card is a wiki page; not every page is a card." A node with
// a `board` block is a card; a node without one is a page that isn't. Actor
// nodes are the first real instance of the second kind.
//
// ⚠️ These tests exist because there was NO test round-tripping a DOMAIN that
// carries a non-card node — every existing round-trip starts from a BOARD, so
// every node it produces came from `cards` and carries `board`. That direction
// is STRUCTURALLY INCAPABLE of catching what follows.
//
// ⛔ RED BY DESIGN when first written (2026-07-31), and parked on a branch for
// that reason — a red test on main breaks the suite for everyone. Rescued into
// the dev tree by #593 because the branch it was parked on lives in the
// PRODUCTION clone and was never pushed: correct discipline, applied to a tree
// that stopped being where work happens.
//
// Two distinct failure modes it pins:
//   1. no fix          the node survives CORRUPTED, not lost — @type collapses
//                      to CreativeWork, namespaced fields drop, and an empty
//                      `board` block is ADDED, which by ADR-001's own
//                      definition turns a page into a card.
//   2. naive filter    the node is DELETED entirely, because boardToDomain
//                      rebuilds nodes only from `cards`.
//
// Not a hypothetical window: index.html fires saveToJSONFile() from 11
// fire-and-forget call sites after ordinary board mutations, so it opens on
// the next card edit anyone makes in a browser — not on a deliberate save.

const actorNode = {
  '@type': ['Person', 'scrum:Actor'],
  '@id': 'scrum:actor/ada',
  name: 'Ada',
  identifier: 'ada',
  'scrum:substrate': 'human',
};

const domainWithActor = {
  nodes: [cardToNode(canonicalCard), actorNode],
  messages: [],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  nextShortId: 218,
};

// ⚠️ THIS ASSERTION WAS INVERTED, NOT RELAXED — and the distinction is the point.
//
// As written on 2026-07-31 it looked in `back.nodes`, asserting that a non-card
// node round-trips IN PLACE. The code stopped honouring that contract three
// weeks later: `boardToDomain` builds `nodes` exclusively from `board.cards`
// (core/mapping.mjs), so `nodes` means CARDS ONLY and non-cards are cohorted
// into `graphNodes`.
//
// ⛔ The tempting move was to edit until green. That is how a card gets closed
// without the property holding — and #593's precondition exists precisely to
// separate "we moved the files that differed" from "we moved the files that
// matter". The difference between editing a test until it passes and UPDATING A
// CONTRACT is entirely whether the change is legible afterward. So: the old
// expectation, the superseding mechanism, and the reason are all recorded here.
//
// The property under test is UNCHANGED and is still the one that matters: a
// non-card node must survive the save path intact — @type, namespaced fields,
// no `board` block grafted on. Only its ADDRESS moved.
//
// ⇒ Ratified by measurement, not preference: storage never partitions. The live
//   board-data.json holds one flat @graph (Person ×6, scrum:Column ×4 among
//   16,948 entities) with no `nodes`/`graphNodes` key at all. The cohort is a
//   pure function of @type, recomputed at load. See the guard test below.
test('a non-card node survives domain → board → domain (#530)', () => {
  // The save path is domainToBoard -> (disk) -> boardToDomain.
  const back = boardToDomain(domainToBoard(domainWithActor));
  const actor = (back.graphNodes || []).find((n) => n['@id'] === 'scrum:actor/ada');

  assert.ok(actor, 'actor node must survive the save round-trip, not vanish');
  assert.deepEqual(actor['@type'], ['Person', 'scrum:Actor'], '@type must survive');
  assert.equal(actor['scrum:substrate'], 'human', 'namespaced fields must survive');
  assert.equal(actor.board, undefined, 'and must NOT be grafted into a card');

  // The other half of the contract: `nodes` carries cards, and only cards.
  assert.ok(
    !(back.nodes || []).some((n) => n['@id'] === 'scrum:actor/ada'),
    '`nodes` means cards-only — a non-card must not appear there',
  );
});

test('the cohort is DERIVED, never stored — @graph carries no partition keys (#530)', () => {
  // ⭐ The condition attached to ratifying cohorting: it is safe ONLY because it
  // is a pure function of @type, recomputed at load, with @type remaining the
  // single source of truth. The moment anything PERSISTS the partition, the
  // objection it was ratified against becomes live — a fact held in two places
  // drifts, which is the three-list defect this suite exists to catch.
  //
  // This test is what stops a future "optimisation" from quietly converting a
  // projection into a storage shape.
  const doc = domainToJsonLd(boardToDomain(domainToBoard(domainWithActor)));
  for (const key of ['nodes', 'graphNodes', 'cards', 'graphOrder']) {
    assert.equal(doc[key], undefined, `stored document must not carry the partition key \`${key}\``);
  }
  assert.ok(Array.isArray(doc['@graph']), 'storage is one flat @graph');
});

test('a non-card node is not emitted as a card (#530)', () => {
  // The render path is domainToBoard. A node with no `board` block is not a
  // card and must not appear on the board — ADR-001's own definition.
  const board = domainToBoard(domainWithActor);
  const ids = board.cards.map((c) => c.id ?? c['@id']);
  assert.ok(
    !ids.includes('scrum:actor/ada'),
    'a node without a board block must not be emitted as a card',
  );
});
