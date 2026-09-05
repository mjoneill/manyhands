/**
 * #1214 — THE KIND REGISTRY.
 *
 * The board owner asked, in #1214, how an agent is supposed to identify what
 * entities exist in a graph, and whether a registry existed. The measured
 * answer on 2026-09-05 was: there is no registry. There were three
 * disagreeing partial lists — `ENTITY_KINDS` in the event log (12), the types
 * the replica happens to emit (29 live), and the `@context` (24 terms, zero
 * class declarations) — and the only way to learn a kind existed was a CENSUS
 * of what had already been instantiated.
 *
 * ⛔ THE BLIND SPOT THAT MOTIVATES THIS FILE: a census answers "what IS
 * instantiated", never "what CAN exist". A kind with zero instances is
 * invisible to it. Before #1118 wrote the first obligation, nothing in the
 * graph could have told a seat that `scrum:Obligation` was a thing. A seat
 * found `scrum:WorkObject` by census and then had to READ ITS TRIPLES to learn
 * it is a bid/reply object, because no definition existed anywhere. This file
 * is what replaces that read.
 *
 * ── WHY A MODULE AND NOT ONLY GRAPH ROWS ────────────────────────────────────
 *
 * The card proposed deriving `ENTITY_KINDS` from the registry so that "deleting
 * a code list entry is impossible — there is no list". That is the right
 * intent, and the naive form of it is unsafe: `validateEvent` runs on the write
 * path, and making it read board state would make the event log's ability to
 * REFUSE depend on a data read succeeding. That is exactly the failure coupling
 * that Decision 7b80418f (#1113, gate 1) now forbids — a graph-read failure
 * must have a named degraded behaviour, and "silently accept any entity kind"
 * is the worst possible one.
 *
 * ⇒ So the derivation is a PURE IMPORT, not a query. This module is the single
 * source; `ENTITY_KINDS` and the replica's projected types are both derived
 * from `KIND_DECLARATIONS` below. There is still no second list to fall out of
 * sync, and validation still works with the board unreadable.
 *
 * ⚠️ TWO SURFACES, ONE FACT — the hazard this comment exists to name. Kinds
 * also live in the graph as `scrum:KindDefinition` rows, so that seats can
 * discover and define them at runtime the way `predicate_list` already works.
 * Those rows are a PROJECTION of this module, never a second authority. A kind
 * registered in the graph that is absent here is a REAL and VISIBLE state — it
 * means someone declared a thing the runtime does not yet accept — and it is
 * reported by `divergence()` rather than silently reconciled. #1215's emitter
 * is what announces it.
 */

/**
 * Every kind this board knows about, declared rather than discovered.
 *
 * - `name`        the projected rdf:type, or null for an event-only kind
 * - `eventKind`   the `entity.kind` the event log accepts, or null if the kind
 *                 is projected but never written as its own event
 * - `collection`  which board collection it replays into (null = not replayed
 *                 as its own collection; it rides inside another entity)
 * - `createdBy`   the verb that makes one — "how do I make one of these",
 *                 answered in the registry instead of by reading source
 * - `definition`  one paragraph: what it IS, and where useful what it is NOT
 */
export const KIND_DECLARATIONS = Object.freeze([
  // ── the core board families ───────────────────────────────────────────────
  {
    name: 'scrum:Card', eventKind: 'card', collection: 'cards',
    createdBy: 'card_create / POST /api/cards',
    definition: 'A unit of work with a permanent short id, a column, and a lifecycle. '
      + 'The short id is IDENTITY and never changes; `order` is disposable display position (#923) '
      + 'and carries no dependency — a build dependency is a `blockedBy` edge, not a position. '
      + 'Cards are the board\'s most-read entity and the last collection scheduled to migrate under '
      + 'Decision 7b80418f, gated on the incremental-projection floor.',
  },
  {
    name: 'schema:Comment', eventKind: 'conversation', collection: 'conversations',
    createdBy: 'conversation_post / POST /api/conversations',
    definition: 'One message in the commons or on a card thread. Board-level when `attachedTo` is '
      + 'null, card-attached otherwise. The most numerous entity on the board by an order of '
      + 'magnitude, which is why catch-up reads are bounded by default rather than returning history.',
  },
  {
    name: 'scrum:Column', eventKind: 'column', collection: 'columns',
    createdBy: 'column_update / POST /api/columns',
    definition: 'A lane cards move through. Column membership is the board\'s public claim about '
      + 'what is happening: a claimed card sitting in the wrong column makes the board lie about '
      + 'its own state, which is a flow defect and not a cosmetic one.',
  },
  {
    name: null, eventKind: 'wiki', collection: null,
    createdBy: 'PATCH /api/nodes/:id with `body`',
    definition: 'A wiki node — long-form prose addressed by node id rather than card number. '
      + 'NOT projected as an rdf:type today, and deliberately still carrying the replay gap named '
      + 'in the event log: a wiki edit is logged but has no collection mapping, so it does not '
      + 'rebuild from the log the way cards and memories do. Declared here so the gap is visible '
      + 'rather than discovered.',
  },
  // ── memory ────────────────────────────────────────────────────────────────
  {
    name: 'scrum:Memory', eventKind: 'memory', collection: 'memories',
    createdBy: 'memory_create / POST /api/memories',
    definition: 'A durable note owned by a seat but readable by the whole room — the board\'s '
      + 'shared memory store, distinct from any seat\'s private files. Versioned: an update writes '
      + 'a new MemoryVersion rather than overwriting, so a bad append is recoverable.',
  },
  {
    name: 'scrum:MemoryVersion', eventKind: null, collection: null,
    createdBy: 'implicitly, by memory_update',
    definition: 'One historical revision of a Memory, carrying the bytes as they stood. This is '
      + 'what makes a memory edit non-destructive: a version is written on every update, so a '
      + 'clobbered body can be restored to an earlier byte-exact state.',
  },
  // ── decisions and their scaffolding ───────────────────────────────────────
  {
    name: 'scrum:Decision', eventKind: 'decision', collection: null,
    createdBy: 'decision_create',
    definition: 'A ruling with a `reopensIf`. Retrievable by TOPIC (`constrains`) rather than by '
      + 'the card that produced it, so a reader who never heard of the card can still find what '
      + 'governs a subject. A decision with no reopensIf can only be violated, never retired, '
      + 'which is why the falsifier is required at creation rather than optional.',
  },
  {
    name: 'scrum:ReleaseCondition', eventKind: null, collection: null,
    createdBy: 'card acceptance fields (POST/PATCH /api/cards)',
    definition: 'A named condition a card must satisfy before it is done, carrying a `schema:name` '
      + 'claim, an optional `scrum:note`, and `scrum:evidencedBy` pointing at what discharged it. '
      + 'Prose, evaluated by a reader — the executable form is a Check.',
  },
  {
    name: 'scrum:Check', eventKind: null, collection: null,
    createdBy: 'card `checks` field',
    definition: 'An executable acceptance condition: a SPARQL ASK in `scrum:ask` plus the expected '
      + 'boolean in `scrum:expect` and a prose `scrum:claim`. Unlike a ReleaseCondition it can '
      + 'fail on its own, which is the whole point — a gate that cannot refuse is a virtue, not a rail.',
  },
  // ── coordination ──────────────────────────────────────────────────────────
  {
    name: 'scrum:Blocker', eventKind: null, collection: null,
    createdBy: 'card `blockers` field',
    definition: 'A typed structure joining a card to what holds it up, including a Person when the '
      + 'blocker is a human decision. Distinct from a `blockedBy` card edge: a Blocker names an '
      + 'obstacle that is not itself a card.',
  },
  {
    name: 'scrum:Obligation', eventKind: 'obligation', collection: 'obligations',
    createdBy: 'obligation_create',
    definition: 'Something a seat owes, tracked as an entity so it outlives the conversation that '
      + 'created it. The first kind whose existence proved the census blind spot: before #1118 '
      + 'wrote one, nothing in the graph could have told a seat this kind was available.',
  },
  {
    name: 'scrum:Wake', eventKind: 'wake', collection: 'wakes',
    createdBy: 'seat_wake',
    definition: 'A request that a seat be brought back to attention, recorded as an entity rather '
      + 'than delivered and forgotten. Durable because delivery is not guaranteed: a seat whose '
      + 'transport dropped is indistinguishable from an idle one, so the record is the evidence.',
  },
  {
    name: 'scrum:WorkObject', eventKind: null, collection: null,
    createdBy: 'work_declare / work_bid / work_grant',
    definition: 'A bid-and-reply object for coordinating who takes a piece of work: it carries '
      + '`scrum:declaredBy`, one or more `scrum:required` people, a `scrum:replyBy` deadline and a '
      + 'shortId of the card it concerns. NOT a claim — a claim is first-write-wins on the card '
      + 'itself; a WorkObject is the negotiation that may precede one.',
  },
  {
    name: 'scrum:SeatDeclaration', eventKind: 'seat-state', collection: 'seatStates',
    createdBy: 'seat_declare',
    definition: 'A seat stating its own availability and intent. Read by the scheduler, which is '
      + 'why it must rebuild from the log: a dropped replay would silently restore a resting seat '
      + 'to eligible.',
  },
  {
    name: null, eventKind: 'request', collection: null,
    createdBy: 'a refused write, automatically (#1217)',
    definition: 'The kind a REFUSAL takes when the route it came from maps to no entity kind. It '
      + 'never names a stored thing, because nothing was stored — which is exactly why it cannot '
      + 'collide with a real kind, and why it keeps "a write was refused and we kept the body" '
      + 'sayable for routes this vocabulary has not learned about yet. Added by #1217; '
      + 'declared here rather than as a literal because this is where kinds live now.',
  },

  // ── vocabulary ────────────────────────────────────────────────────────────
  {
    name: 'scrum:PredicateDefinition', eventKind: 'predicate', collection: null,
    createdBy: 'predicate_register / POST /api/predicates',
    definition: 'What a predicate MEANS, in prose, registered before use. The registry this file '
      + 'is modelled on, and the one that works: 16 live definitions, used daily, gated by '
      + 'graph_assert. A re-register is a revision of one entity, never a second row.',
  },
  {
    name: 'scrum:KindDefinition', eventKind: 'kind', collection: null,
    createdBy: 'kind_register / POST /api/kinds',
    definition: 'What an ENTITY KIND is — this registry\'s own entry. Mirrors PredicateDefinition '
      + 'deliberately: a kind is declared with a definition, the verb that creates it, and the '
      + 'event kind and rdf:type it projects as. Declaring a kind does NOT make the runtime accept '
      + 'it; `KIND_DECLARATIONS` in core/kind-registry.mjs does. A graph row with no module entry '
      + 'is a real, reported divergence rather than an error.',
  },
  {
    name: 'schema:DefinedTerm', eventKind: 'label', collection: 'labelAliases',
    createdBy: 'label alias writes',
    definition: 'A label or concept used as a tag, plus declared synonyms. A vocabulary of TAGS, '
      + 'not of kinds — the distinction that made this registry necessary: 470 DefinedTerms could '
      + 'not answer "what kinds of thing live here".',
  },
  // ── apex and provenance ───────────────────────────────────────────────────
  {
    name: 'scrum:Apex', eventKind: null, collection: null,
    createdBy: 'applying an `apex:<label>` label to a card',
    definition: 'A top-level vision card that other work belongs to, identified by an `apex:` '
      + 'label rather than by a type field. Containment is asserted with `schema:isPartOf` and read '
      + 'as transitive by this board, by choice.',
  },
  {
    name: 'scrum:Commit', eventKind: null, collection: null,
    createdBy: 'projected from git history',
    definition: 'A git commit, keyed by full sha, linked to the cards it implements. Provenance '
      + 'projected INTO the graph from outside it — the board does not create these, it observes them.',
  },
  {
    name: 'scrum:UnresolvedReference', eventKind: null, collection: null,
    createdBy: 'projected when prose cites a card number that does not exist',
    definition: 'A dangling card citation: prose said "#1125" and no such card is present. Kept as '
      + 'an entity rather than dropped so that a broken reference is queryable instead of silent.',
  },
  {
    name: 'prov:Activity', eventKind: null, collection: null,
    createdBy: 'every write, automatically',
    definition: 'A recorded write: who did what and when, via prov:used and prov:wasAssociatedWith. '
      + '⛔ WRITES ONLY — the activity log is blind to readers, so absence of an Activity proves '
      + 'nobody wrote, never that nobody looked. `prov:generated` is not projected.',
  },
  // ── tending ───────────────────────────────────────────────────────────────
  {
    name: 'scrum:Tending', eventKind: 'tending', collection: 'tending',
    createdBy: 'the tending scheduler',
    definition: 'The tending family\'s root record — the board\'s own ambient voice, which posts '
      + 'when the room goes quiet. Rides the same replay door as every other family by ruling, '
      + 'with no tending-specific bypass.',
  },
  {
    name: 'scrum:TendingState', eventKind: null, collection: null,
    createdBy: 'the tending scheduler',
    definition: 'Current scheduler state for tending: what has fired, when the room was last '
      + 'active, and what the quiet window is.',
  },
  {
    name: 'scrum:TendingMint', eventKind: null, collection: null,
    createdBy: 'the tending scheduler, on each firing',
    definition: 'One firing of a tending prompt, recorded with who was reachable at that moment. '
      + 'This is what makes a seat\'s absence noticed rather than invisible: the mint says who was '
      + 'deaf when it fired, so they can be told on return.',
  },
  {
    name: 'scrum:TendingClaimAttempt', eventKind: null, collection: null,
    createdBy: 'whisper_claim',
    definition: 'A seat\'s attempt to take a minted whisper, carrying the declared seat, the bound '
      + 'identity, and the outcome (granted or not). Records attempts rather than only successes, '
      + 'because a success-only history cannot show contention.',
  },
  {
    name: 'scrum:TendingPrompt', eventKind: null, collection: null,
    createdBy: 'the tending editor (Settings)',
    definition: 'The text of one tending voice, editable by the board owner. Identity is stable; '
      + 'the wording is versioned beside it.',
  },
  {
    name: 'scrum:TendingPromptVersion', eventKind: null, collection: null,
    createdBy: 'implicitly, on editing a prompt',
    definition: 'One revision of a TendingPrompt\'s text — the identity/version pattern (#1189), so '
      + 'a firing can name the exact wording that fired rather than whatever the prompt says now.',
  },
  {
    name: 'scrum:TendingPlaylist', eventKind: null, collection: null,
    createdBy: 'the tending editor (Settings)',
    definition: 'An ordered set of tending prompts the scheduler draws from when the room goes '
      + 'quiet. The playlist is the identity; which prompts it holds is versioned beside it, so '
      + 'changing the rotation does not rewrite what past firings drew from.',
  },
  {
    name: 'scrum:TendingPlaylistVersion', eventKind: null, collection: null,
    createdBy: 'implicitly, on editing a playlist',
    definition: 'One revision of a playlist\'s contents, carrying the prompt set as it stood. A '
      + 'past firing resolves against the version that was live at the time rather than against '
      + 'the current rotation, which is what keeps the tending history readable after an edit.',
  },
  // ── people and works ──────────────────────────────────────────────────────
  {
    name: 'schema:Person', eventKind: null, collection: null,
    createdBy: 'roster configuration',
    definition: 'A seat or human, addressed by a person IRI. Attribution here is DECLARED, not '
      + 'authenticated: the board records who a write said it was, and a bound session is the only '
      + 'thing that makes that more than a claim.',
  },
  {
    name: 'schema:CreativeWork', eventKind: null, collection: null,
    createdBy: 'projected alongside each card',
    definition: 'The schema.org face of a card, carried so that standard consumers can read the '
      + 'board without knowing the scrum vocabulary. One per card, not an independent entity.',
  },
  {
    name: 'schema:Action', eventKind: null, collection: null,
    createdBy: 'projected from board actions',
    definition: 'The schema.org face of a recorded action, projected beside the prov:Activity for '
      + 'the same reason CreativeWork is projected beside a card.',
  },
]);

/** Kinds the EVENT LOG accepts, derived — not a second list. */
export const ENTITY_KINDS = new Set(
  KIND_DECLARATIONS.filter((k) => k.eventKind).map((k) => k.eventKind),
);

/** rdf:types the replica may project, derived — not a second list. */
export const PROJECTED_TYPES = new Set(
  KIND_DECLARATIONS.filter((k) => k.name).map((k) => k.name),
);

/** Which board collection an event kind replays into, derived. */
export const COLLECTION_OF = Object.freeze(Object.fromEntries(
  KIND_DECLARATIONS.filter((k) => k.eventKind && k.collection).map((k) => [k.eventKind, k.collection]),
));

const BY_NAME = new Map(KIND_DECLARATIONS.filter((k) => k.name).map((k) => [k.name, k]));
const BY_EVENT_KIND = new Map(KIND_DECLARATIONS.filter((k) => k.eventKind).map((k) => [k.eventKind, k]));

/** Look up a declaration by its projected rdf:type. */
export function kindByName(name) { return BY_NAME.get(name) ?? null; }

/** Look up a declaration by the event kind it is written as. */
export function kindByEventKind(k) { return BY_EVENT_KIND.get(k) ?? null; }

/**
 * Compare what the graph has been TOLD exists against what the runtime ACCEPTS.
 *
 * Neither direction is an error, and that is deliberate — refusing here would
 * make a seat lose a definition it took the trouble to write. Both directions
 * are REPORTED so #1215's emitter can announce them and a standing check can
 * hold them.
 *
 * @param {Array<{name:string}>} registeredRows KindDefinition rows from the board
 * @param {Iterable<string>} instantiatedTypes  rdf:types actually present (the census)
 */
export function divergence(registeredRows = [], instantiatedTypes = []) {
  const registered = new Set(registeredRows.map((r) => r.name).filter(Boolean));
  const instantiated = new Set(instantiatedTypes);
  return {
    // Declared in the graph, unknown to the runtime: someone registered a kind
    // this build cannot project. Visible, not silently reconciled.
    registeredNotDeclared: [...registered].filter((n) => !PROJECTED_TYPES.has(n)).sort(),
    // Known to the runtime but never registered: the backfill is incomplete.
    declaredNotRegistered: [...PROJECTED_TYPES].filter((n) => !registered.has(n)).sort(),
    // Present in the data but declared nowhere — the original defect: a kind
    // exists only because something instantiated it.
    instantiatedNotDeclared: [...instantiated].filter((n) => !PROJECTED_TYPES.has(n)).sort(),
    // ⭐ THE BLIND SPOT THIS CARD EXISTS FOR: declared and real, zero instances,
    // and therefore invisible to a census. Reporting this is the feature.
    declaredNotInstantiated: [...PROJECTED_TYPES].filter((n) => !instantiated.has(n)).sort(),
  };
}
