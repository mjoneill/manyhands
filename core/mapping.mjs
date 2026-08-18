/**
 * core/mapping.mjs — lossless mapping between the legacy board-data.json shape
 * and the unified, schema.org-shaped node domain (ADR-001 #214, ADR-002 #216).
 *
 * A card becomes a Node: a schema.org CreativeWork (the content) carrying a
 * `board` facet (the kanban mechanics). The mapping is LOSSLESS and
 * PRESENCE-PRESERVING — only fields actually present on a card are emitted, and
 * any field not explicitly modelled (the legacy singular `assignee`, or future
 * unknowns) rides through `board._extra` untouched. Losslessness is the slice-1
 * keystone: it proves the unified model can hold everything we have, including
 * sparse and legacy records, before anything migrates.
 *
 * Pure functions, no I/O — the functional core (ADR-002 D1).
 */

// Card content field ↔ schema.org Node property (top-level). `type` is handled
// specially (additionalType = "scrum:<type>"); `id` → @id.
const CONTENT_TO_NODE = {
  id: '@id',
  shortId: 'identifier',     // D3: identifier = shortId
  title: 'name',             // D3: name = title
  description: 'text',        // D3: text = body
  createdAt: 'dateCreated',
  updatedAt: 'dateModified',
  // #631 — who wrote it, beside when it was written.
  //
  // `creator` rather than `author`: schema.org treats them as distinct relations,
  // and creator accepts a Person OR an Organization — which is exactly the
  // customer's point that the writer of a card is not always a person (a
  // scheduler filing cards is Organization-shaped). Conversations already map their own `author`
  // for a different record type; overloading the word across both would assert a
  // sameness nobody has established.
  //
  // ⚠️ PROVISIONAL, and cheap to change: #632 researches which schema.org actor
  // relation this really is. The mapping is one line here and the inverse is
  // derived, so revisiting costs a line — which is why it was safe to pick one
  // rather than leave the field sitting in `_extra` labelled "legacy/unknown"
  // on the wiki surface.
  createdBy: 'creator',
  parent: 'isPartOf',        // hierarchy — schema.org part-whole (the parent's @id)
};
const NODE_TO_CONTENT = Object.fromEntries(
  Object.entries(CONTENT_TO_NODE).map(([card, node]) => [node, card]),
);

// Kanban-mechanic fields live in the `board` facet under their own names.
// #348 — claimedBy/claimedAt are the coordination-rail (first-write-wins) claim
// fields; they're board mechanics, not content, so they ride the board facet
// alongside priority/column/for (first-class, not the legacy `_extra` bag).
// parked* is an AUTHORED, EXPIRING disposition: "nobody should work on this
// yet", said by someone, with an end date. It is not a claim — a claim says
// "I am working on this" and is a mutex; a park says "not yet" and is a
// deferral. They can coexist on one card and mean different things.
const BOARD_KEYS = new Set(['column', 'order', 'assignees', 'priority', 'labels', 'for', 'relationships', 'claimedBy', 'claimedAt',
  'parkedBy', 'parkedAt', 'parkedUntil', 'parkedReason',
  // #814 — the commit that implements this card. A literal is not a node.
  'implementedBy',
  // #792/#857 §VI — falsifier tripwires. First-class rather than riding
  // `_extra`, which is the bag for fields this mapping does NOT model: checks
  // have a validator (validateChecks), an API surface, an MCP schema entry and
  // a runner. Leaving a modelled field in the unmodelled bucket is the #593/#845
  // lying-container shape, and it kept them out of the graph projection, which
  // is what §VI needs them in.
  //
  // ⚠️ Round-trip safe both ways: an existing document carrying them under
  // `scrum:extra` still loads (the `_extra` spread puts them back on the card),
  // and the next save moves them to their own key. Self-healing, no migration.
  'checks']);
// #222 — page attachments ride verbatim as a first-class node field (so the wiki
// reads node.attachments directly, not from board._extra). schema.org would model
// each as an associatedMedia ImageObject/MediaObject; that transform is deferred.
const CARD_KEEP = new Set(['attachments']);

/** Card (legacy board-data shape) → Node (schema.org + board facet). Lossless. */
export function cardToNode(card) {
  const node = { '@type': 'CreativeWork' };
  const board = {};
  const extra = {};
  for (const [k, v] of Object.entries(card)) {
    if (k === 'type') node.additionalType = 'scrum:' + v;
    else if (k in CONTENT_TO_NODE) node[CONTENT_TO_NODE[k]] = v;
    else if (CARD_KEEP.has(k)) node[k] = v;   // #222 — attachments, verbatim, first-class
    else if (BOARD_KEYS.has(k)) board[k] = v;
    else extra[k] = v;                       // legacy/unknown (e.g. `assignee`)
  }
  if (Object.keys(extra).length > 0) board._extra = extra;
  node.board = board;
  return node;
}

/** Node → Card (legacy board-data shape). Exact inverse of cardToNode. */
export function nodeToCard(node) {
  const card = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '@type') continue;
    else if (k === 'additionalType') card.type = String(v).replace(/^scrum:/, '');
    else if (CARD_KEEP.has(k)) card[k] = v;   // #222 — attachments, verbatim
    else if (k === 'board') {
      for (const [bk, bv] of Object.entries(v)) {
        if (bk === '_extra') Object.assign(card, bv);
        else card[bk] = bv;
      }
    } else if (k in NODE_TO_CONTENT) card[NODE_TO_CONTENT[k]] = v;
  }
  return card;
}

// ── conversations ↔ messages (schema.org Comment) ─────────────────────────
// A conversation becomes a Message (Comment). `attachedTo` → `about` (the node
// it belongs to; null = commons, D3). `mentions` and `attachments` ride verbatim
// — the attachments → ImageObject/MediaObject transform (D3) is DEFERRED to when
// attachment rendering needs it; slice 1 only owes losslessness.
const MSG_CONTENT_TO_NODE = {
  id: '@id',
  body: 'text',
  author: 'author',
  createdAt: 'dateCreated',
  attachedTo: 'about',
};
const MSG_NODE_TO_CONTENT = Object.fromEntries(
  Object.entries(MSG_CONTENT_TO_NODE).map(([conv, node]) => [node, conv]),
);
const MSG_KEEP = new Set(['mentions', 'attachments']);

/** Conversation (legacy) → Message (schema.org Comment). Lossless. */
export function conversationToMessage(conv) {
  const msg = { '@type': 'Comment' };
  const extra = {};
  for (const [k, v] of Object.entries(conv)) {
    if (k in MSG_CONTENT_TO_NODE) msg[MSG_CONTENT_TO_NODE[k]] = v;
    else if (MSG_KEEP.has(k)) msg[k] = v;
    else extra[k] = v;                       // legacy/unknown (e.g. `_recovered`)
  }
  if (Object.keys(extra).length > 0) msg._extra = extra;
  return msg;
}

/** Message → Conversation (legacy). Exact inverse of conversationToMessage. */
export function messageToConversation(msg) {
  const conv = {};
  for (const [k, v] of Object.entries(msg)) {
    if (k === '@type') continue;
    else if (k === '_extra') Object.assign(conv, v);
    else if (k in MSG_NODE_TO_CONTENT) conv[MSG_NODE_TO_CONTENT[k]] = v;
    else conv[k] = v;                        // mentions, attachments — verbatim
  }
  return conv;
}

// ── whole board ↔ domain ──────────────────────────────────────────────────
// The board-data.json object as a whole becomes the domain projection:
// cards → nodes, conversations → messages, everything else (columns,
// nextShortId, lastUpdated, _README) passes through untouched. Pure; lossless.

/** board-data.json object → domain { nodes, messages, ...passthrough }. */
export function boardToDomain(board) {
  // #530/#593 — non-card graph entities live in their own cohort. Without this,
  // `nodes` is rebuilt from `cards` alone, so anything that is not a card is
  // DELETED on the next save. See the round-trip tests in tests/domain.test.mjs.
  const graphNodes = Array.isArray(board.graphNodes) ? board.graphNodes : [];
  const graphOrder = Array.isArray(board.graphOrder) ? board.graphOrder : undefined;
  const domain = {
    nodes: (board.cards || []).map(cardToNode),
    messages: (board.conversations || []).map(conversationToMessage),
  };
  if (graphNodes.length > 0 || graphOrder !== undefined) domain.graphNodes = graphNodes;
  if (graphOrder !== undefined) domain.graphOrder = graphOrder;
  for (const [k, v] of Object.entries(board)) {
    if (k === 'cards' || k === 'conversations') continue;
    if (k === 'graphNodes' || k === 'graphOrder') continue;   // #530 — cohorted above
    domain[k] = v;                           // columns, nextShortId, lastUpdated, _README
  }
  return domain;
}

/**
 * domain → board-data.json object. Exact inverse of boardToDomain.
 *
 * #530/#593 — Contract: on a well-formed cohorted domain, cards live in `nodes`
 * and non-card graph entities in `graphNodes`. On a LEGACY MIXED domain — one
 * whose `nodes` still holds non-card entities alongside cards, as a
 * transitional store may carry — this NORMALIZES by splitting them:
 * CreativeWork → `cards`, everything else → `graphNodes`.
 *
 * ⚠️ Without the split, a non-card node is not lost but CORRUPTED: nodeToCard
 * collapses its `@type` to CreativeWork, drops namespaced fields, and ADDS an
 * empty `board` block — which by ADR-001's own definition turns a page into a
 * card. It then appears ON THE BOARD as a card. Silent type corruption is
 * worse than deletion because nothing looks wrong.
 *
 * ⚠️ KEY ORDER IS LOAD-BEARING (#685: the replay invariant compares bytes), so
 * `cards` is still emitted at the slot `nodes` occupied, and graphNodes/
 * graphOrder ride at the slot they occupied — never hoisted to the front.
 */
export function domainToBoard(domain) {
  const board = {};
  const sourceNodes = Array.isArray(domain.nodes) ? domain.nodes : [];
  const cards = sourceNodes.filter((n) => n && n['@type'] === 'CreativeWork');
  const mixedGraphNodes = sourceNodes.filter((n) => !n || n['@type'] !== 'CreativeWork');
  const declared = Array.isArray(domain.graphNodes) ? domain.graphNodes : [];
  const graphNodes = [...mixedGraphNodes, ...declared];
  const hasGraph = graphNodes.length > 0 || Array.isArray(domain.graphOrder);
  const graphOrder = Array.isArray(domain.graphOrder)
    ? domain.graphOrder
    : [...sourceNodes, ...(Array.isArray(domain.messages) ? domain.messages : []), ...declared]
      .map((e) => e && e['@id'])
      .filter((id) => id !== undefined);

  let emittedGraph = false;
  for (const [k, v] of Object.entries(domain)) {
    if (k === 'nodes') {
      board.cards = cards.map(nodeToCard);
      // a mixed domain has no `graphNodes` key of its own — emit here so the
      // split entities are not silently dropped.
      if (hasGraph && !('graphNodes' in domain)) {
        board.graphNodes = graphNodes;
        board.graphOrder = graphOrder;
        emittedGraph = true;
      }
    } else if (k === 'messages') board.conversations = v.map(messageToConversation);
    else if (k === 'graphNodes') {
      if (hasGraph) { board.graphNodes = graphNodes; board.graphOrder = graphOrder; emittedGraph = true; }
    } else if (k === 'graphOrder') continue;   // emitted alongside graphNodes
    else board[k] = v;
  }
  if (hasGraph && !emittedGraph) { board.graphNodes = graphNodes; board.graphOrder = graphOrder; }
  return board;
}
