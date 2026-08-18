/**
 * core/predicate-names.mjs — WHAT THE GRAPH CALLS THE THING YOU STORED (#875).
 *
 * ⚰️ WHY THIS FILE EXISTS. The replica renames store fields as it projects them,
 * and every rename is a good local decision — `scrum:hasCheck` reads better in
 * SPARQL than `checks`, `scrum:assignee` is singular because each value gets its
 * own triple. The cost lands on a reader who greps one surface for the other
 * surface's name and gets zero rows.
 *
 * ⛔ MEASURED, not imagined. Three instances in one day, by all three seats:
 *
 *   grepped SOURCE for `isPartOf`        ⇒ "the capability is UNAVAILABLE"   wrong
 *   grepped STORE  for `parent`          ⇒ "the capability is UNUSED"        wrong
 *   queried `schema:additionalType`      ⇒ 0 rows from a field 795 cards carry
 *
 * ⇒ ⭐⭐⭐ A ZERO-ROW ANSWER TO THE WRONG PREDICATE IS INDISTINGUISHABLE FROM A
 * ZERO-ROW ANSWER TO THE RIGHT ONE. Both look like "the graph does not have
 * this", which is this board's characteristic defect — capability that exists
 * and is concluded missing — with a specific, fixable cause.
 *
 * ── WHAT THIS DOES AND DOES NOT DO ────────────────────────────────────────
 *
 * ⛔ It does NOT rename anything, and it does not forbid renaming. Renames are
 * legitimate; the store's shape and a query vocabulary have different jobs.
 *
 * ✅ It makes a rename DECLARED. `tests/predicate-names-declared.test.mjs`
 * refuses any predicate the replica emits that is absent from this table, so a
 * future rename cannot be invisible — the next reader looks here instead of
 * grepping and drawing a conclusion from silence.
 *
 * ⚠️ The registry is enforced by a TEST rather than consumed at runtime, on
 * purpose: its job is discoverability and refusal, not behaviour. Wiring it
 * into the projection would give the projection a second copy of names it
 * already holds — which is the drift shape this whole card is about.
 */

/**
 * Replica predicate → the key it comes from on the STORE side.
 *
 * `null` means the predicate is minted by the projection and has no store key
 * at all (a derived edge, a type, or a fact assembled from several fields).
 * Same-named entries are listed rather than omitted, so this table answers
 * "what does the graph call X?" for every X, not only the surprising ones.
 */
export const PREDICATE_SOURCE = Object.freeze({
  // ── RENAMED. These are the ones that cost someone an hour. ──────────────
  'scrum:cardType': 'additionalType',       // and the `scrum:` prefix is stripped off the VALUE
  'scrum:mentionsName': 'mentions',         // person handles; deliberately literals (#619 consent guard)
  'scrum:assignee': 'assignees',            // plural field → one triple per value
  'scrum:label': 'labels',                  // plural field → one triple per value
  'scrum:hasCheck': 'checks',               // → a Check NODE, not a literal (#792/#857 §VI)
  'schema:isPartOf': 'parent',              // ⚠️ THREE names: API `parent`, store `isPartOf`, and
                                            //    the card-side write field is `parent` too
  'schema:keywords': 'labels',              // the same field ALSO mints DefinedTerm concepts (#687)

  // ── SAME NAME on both surfaces. Listed so absence means "not projected". ─
  'schema:identifier': 'identifier',
  'schema:name': 'name',
  'schema:text': 'text',
  'schema:dateCreated': 'dateCreated',
  'schema:dateModified': 'dateModified',
  'schema:creator': 'creator',
  'schema:author': 'author',
  'schema:about': 'about',
  'scrum:column': 'column',
  'scrum:priority': 'scrum:priority',
  'scrum:order': 'scrum:order',
  'scrum:for': 'scrum:for',
  'scrum:claimedBy': 'claimedBy',
  'scrum:claimedAt': 'scrum:claimedAt',
  'scrum:parkedBy': 'parkedBy',
  'scrum:parkedAt': 'scrum:parkedAt',
  'scrum:parkedUntil': 'scrum:parkedUntil',
  'scrum:parkedReason': 'scrum:parkedReason',
  'scrum:implementedBy': 'implementedBy',
  'scrum:mentionsCard': 'scrum:mentionsCard',   // derived at projection (#656), stored in the document
  'scrum:blocks': 'blockers',
  'scrum:blockedByCard': 'blockers',
  // #881 — the person whose own pending action IS the block. Deliberately a
  // DIFFERENT predicate from scrum:owner: owner is who chases the blocking
  // CARD, blockedByPerson is the person who is themselves the blocker. They
  // are opposite states and a query for "waiting on me" must return only this one.
  'scrum:blockedByPerson': 'blockers',
  'scrum:owner': 'blockers',
  'scrum:note': 'blockers',
  // #814 — acceptance evidence. `scrum:evidencedBy` is REUSED from the tending
  // vocabulary rather than duplicated: one relation, one name, so a query need
  // not know which subsystem it is standing in.
  'scrum:ofCard': 'acceptance',
  // ⚠️ SHARED BY TWO SUBSYSTEMS: the tending vocabulary emits it too. That is
  // the reuse working — one relation, one name — but it also means this row
  // answers for both, and a future reader tracing it will land in two places.
  'scrum:evidencedBy': 'acceptance',
  'scrum:status': 'blockers',
  'scrum:resolved': 'blockers',
  'schema:sameAs': 'labelAliases',              // declared synonyms (#857 §V)
  'scrum:claim': 'checks',                      // a Check node's own fields
  'scrum:ask': 'checks',
  'scrum:expect': 'checks',

  // ── MINTED BY THE PROJECTION. No store key exists. ─────────────────────
  'scrum:entityKind': null,     // from the event log's entity.kind (#725)
  // #891 — from the event log's entity.shortId. NOT derived from the card node:
  // the join through prov:used dies with the card, and 34 production activities
  // were already in that state when this was added.
  'scrum:shortId': null,
  'scrum:op': null,             // from the event log's op
  'prov:Activity': null,        // #725 — the event log projected as PROV
  'prov:used': null,
  'prov:wasAssociatedWith': null,
  'prov:startedAtTime': null,
  'schema:CreativeWork': null,  // rdf:type values, not properties
  'schema:Comment': null,
  'schema:Person': null,
  'schema:DefinedTerm': null,
  'scrum:Column': null,
  'scrum:Commit': null,         // ⚠️ minted from a bare sha STRING in the store (#814/#858)
  'scrum:Check': null,
  'scrum:Blocker': null,
  'scrum:ReleaseCondition': null,
  'scrum:UnresolvedReference': null,   // #818 — a relationship member naming no card
});

/**
 * ⛔ DECLARED, STORED, AND NOT PROJECTED — a measured gap, not an exemption.
 *
 * These are facts the STORE holds that the replica never emits, so no query can
 * reach them. Listed here rather than quietly dropped from the table above,
 * because "the graph does not have this" and "nobody projected this" are the
 * two answers this whole file exists to keep apart.
 *
 * ⚠️ Each entry carries the card that owns the gap. `tests/predicate-names-
 * declared.test.mjs` asserts the gap is REAL — that the store genuinely carries
 * the field and the graph genuinely lacks it — so this cannot rot into a list
 * of problems that were fixed years ago and never crossed off.
 */
export const STORED_NOT_PROJECTED = Object.freeze({
  // ✅ EMPTY, and that is a result rather than an oversight.
  //
  // It held exactly one entry for the length of one commit: `schema:isPartOf`,
  // #858's membership spine — nineteen edges in the store and none in any
  // query. The inverse guard found it, this list named it, and the same commit
  // projected it. The entry is crossed off rather than kept as history, because
  // an exemption list is the easiest place in a codebase to hide a problem that
  // stopped being one.
  //
  // ⚠️ The test that walks this object asserts every entry is STILL TRUE — the
  // store carries the field and the graph does not emit it — so a gap that gets
  // closed turns the suite red and demands its own removal. That is what
  // happened here, within minutes of the entry being written.
});

/** Predicates whose replica name differs from the store key they come from. */
export const RENAMED = Object.freeze(
  Object.entries(PREDICATE_SOURCE)
    .filter(([predicate, key]) => key !== null && predicate.split(':')[1] !== key.split(':').pop())
    .map(([predicate, key]) => ({ predicate, storeKey: key })),
);
