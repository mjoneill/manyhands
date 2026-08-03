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
const BOARD_KEYS = new Set(['column', 'order', 'assignees', 'priority', 'labels', 'for', 'relationships', 'claimedBy', 'claimedAt']);
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
  const domain = {
    nodes: (board.cards || []).map(cardToNode),
    messages: (board.conversations || []).map(conversationToMessage),
  };
  for (const [k, v] of Object.entries(board)) {
    if (k === 'cards' || k === 'conversations') continue;
    domain[k] = v;                           // columns, nextShortId, lastUpdated, _README
  }
  return domain;
}

/** domain → board-data.json object. Exact inverse of boardToDomain. */
export function domainToBoard(domain) {
  const board = {};
  for (const [k, v] of Object.entries(domain)) {
    if (k === 'nodes') board.cards = v.map(nodeToCard);
    else if (k === 'messages') board.conversations = v.map(messageToConversation);
    else board[k] = v;
  }
  return board;
}
