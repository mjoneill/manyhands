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
