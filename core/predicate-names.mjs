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
  // ── #945 slice 1 — the predicate registry itself ──────────────────────────
  'scrum:PredicateDefinition': null,        // the type; minted by the projection
  'scrum:definition': 'scrum:definition',
  // ── #1214 — the KIND registry: what CLASSES of thing live here ───────────
  'scrum:KindDefinition': null,             // the type; minted by the projection
  'scrum:createdByVerb': 'scrum:createdByVerb', // the verb that makes one
  'scrum:eventKind': 'scrum:eventKind',     // the entity.kind the event log writes
  // ── #1206 — research: procedures, their versions, and the runs that use them
  'scrum:Procedure': null,                  // the type; minted by the projection
  'scrum:ProcedureVersion': null,           // the type; minted by the projection
  'scrum:ofProcedure': 'scrum:ofProcedure', // version → procedure (the of<Thing> house shape)
  'scrum:body': 'scrum:body',               // a procedure version's text
  'scrum:performedUsing': 'scrum:performedUsing', // run → the VERSION it followed
  'scrum:contentHash': 'scrum:contentHash', // artifact integrity; pointer + hash, never payload
  'schema:contentUrl': 'schema:contentUrl', // where the artifact bytes live
  'schema:encodingFormat': 'schema:encodingFormat',
  'prov:generated': 'prov:generated',       // run → artifact. ⚠️ NOT emitted by projectActivities.
  // ── #1118 — obligations (what a seat promised), born in the graph ────────
  'scrum:Obligation': null,                 // the type; minted by the projection
  'scrum:owedBy': 'scrum:owedBy',           // → person: IRI
  'scrum:obligationKind': 'scrum:kind',     // steward | review | promise | tripwire
  'scrum:dischargedBy': 'scrum:dischargedBy',   // → person: IRI
  'scrum:dischargedAt': 'scrum:dischargedAt',
  'scrum:Wake': null,                       // #1118 — the type; minted by the projection
  'scrum:wokeSeat': 'scrum:wokeSeat',       // → person: IRI
  'scrum:wokeAt': 'scrum:wokeAt',
  // #1202 — scrum:ModelCall, the provenance ledger row (store key modelCalls[])
  'scrum:ModelCall': null,          // rdf:type value
  'scrum:agent': 'scrum:agent',     // → person: IRI
  'scrum:model': 'scrum:model',
  'scrum:provider': 'scrum:provider',
  'scrum:protocol': 'scrum:protocol',
  'scrum:promptVersion': 'scrum:promptVersion',
  'scrum:tokensIn': 'scrum:tokensIn',
  'scrum:tokensOut': 'scrum:tokensOut',
  'scrum:cost': 'scrum:cost',
  'scrum:stopReason': 'scrum:stopReason',
  'scrum:latencyMs': 'scrum:latencyMs',
  'scrum:contextHandedTo': 'scrum:contextHandedTo',   // → entity: IRIs
  'scrum:producedPost': 'scrum:producedPost',         // → entity: IRI
  'scrum:calledAt': 'scrum:calledAt',
  'scrum:ok': 'scrum:ok',
  'scrum:memoryWritten': 'scrum:memoryWritten',   // #1254 → literals: memory ids, or a stringified failure
  // #1199 — scrum:Agent (store key agents[]) and its prompt (agentPrompts[])
  'scrum:Agent': null, 'scrum:AgentPrompt': null, 'scrum:AgentPromptVersion': null,   // rdf:type values
  'scrum:seatKey': 'scrum:seatKey',
  'scrum:emoji': 'scrum:emoji',
  'scrum:contextPolicy': 'scrum:contextPolicy',
  'scrum:toolGrant': 'scrum:toolGrant',
  'scrum:promptGrantConflict': 'scrum:promptGrantConflict', 'scrum:promptGrantConflictReason': 'scrum:promptGrantConflictReason', 'scrum:promptGrantConflictSince': 'scrum:promptGrantConflictSince', // #1242
  'scrum:wakeOn': 'scrum:wakeOn', 'scrum:everyMinutes': 'scrum:everyMinutes', // #1226
  'scrum:seed': 'scrum:sampling', 'scrum:temperature': 'scrum:sampling', 'scrum:maxTokens': 'scrum:sampling', // #1203 finding: from the sampling object
  'scrum:wakeKind': 'scrum:wakeKind', 'scrum:memoryHanded': 'scrum:memoryHanded',
  // #1196 — the tool record
  'scrum:toolGranted': 'scrum:toolGranted', 'scrum:toolCalled': 'scrum:toolCalled',
  'scrum:toolHops': 'scrum:toolHops', 'scrum:toolRowsReturned': 'scrum:toolRowsReturned',
  'scrum:unbackedLookupClaims': 'scrum:unbackedLookupClaims', 'scrum:claimedLookup': 'scrum:claimedLookup',
  'scrum:narrationRetryOutcome': 'scrum:narrationRetryOutcome',
  'scrum:modelCalls': 'scrum:modelCalls', 'scrum:stoppedBecause': 'scrum:stoppedBecause',
  'scrum:budgetPerDay': 'scrum:budgetPerDay',
  'scrum:residency': 'scrum:residency',
  'scrum:state': 'scrum:state',
  'scrum:currentPrompt': 'scrum:currentPrompt',   // → the AgentPromptVersion IRI
  'scrum:ofAgent': 'scrum:ofAgent',               // → the Agent IRI
  // These two predate #1199 (the tending prompt/version shape, #1189) but were
  // only ever emitted through the generic projector, so the source census never
  // saw them until an explicit projector spelled them out.
  'scrum:ofPrompt': 'scrum:ofPrompt',             // → the prompt identity IRI (tending and agent prompts)
  'scrum:importedAt': 'scrum:importedAt',
  'scrum:version': 'scrum:version',               // the version NUMBER on a prompt/memory version node
  // #1197 — scrum:Model (store key models[])
  'scrum:Model': null,
  'scrum:baseUrl': 'scrum:baseUrl', 'scrum:contextWindow': 'scrum:contextWindow', 'scrum:numCtx': 'scrum:numCtx',
  'scrum:thinking': 'scrum:thinking', 'scrum:maxOutputTokens': 'scrum:maxOutputTokens', 'scrum:timeoutMs': 'scrum:timeoutMs',
  'scrum:costIn': 'scrum:costIn', 'scrum:costOut': 'scrum:costOut', 'scrum:freeTier': 'scrum:freeTier',
  'scrum:capability': 'scrum:capability', 'scrum:apiKeyRef': 'scrum:apiKeyRef', 'scrum:deprecatesOn': 'scrum:deprecatesOn',
  'scrum:modelKey': 'scrum:modelKey', 'scrum:usesModel': 'scrum:usesModel',
  'scrum:lastProbeClass': 'scrum:lastProbeClass', 'scrum:lastProbeAt': 'scrum:lastProbeAt', 'scrum:lastProbeStatus': 'scrum:lastProbeStatus',
  // ── #1130 item 3 — an apex is a KIND. Both are derived from the card's own
  // `labels`: an entry `apex:<X>` mints the class and X is the apexLabel. There
  // is no store field spelled "apex"; grep `labels` for the prefix.
  'scrum:Apex': null,                       // the type; minted by the projection from an `apex:` label
  'scrum:apexLabel': 'labels',              // the `apex:<X>` entry, prefix stripped
  // ── #1112 item 3 — work ledger transitions (Decision 3956b66b; source is the
  // SCRUM_WORK_STORE jsonl, not the board document). ────────────────────────
  'schema:Action': null,                    // the type; minted by the projection
  'scrum:WorkObject': null,                 // the type; minted by the projection
  'schema:agent': 'transition.by',
  'scrum:transitionType': 'transition.type',
  'scrum:ofWork': null,                     // minted edge: transition → its work object
  'scrum:declaredBy': 'declaredBy',
  'scrum:required': 'required',             // seat-shaped entries → person edges
  'scrum:requiredRaw': 'required',          // non-seat entries kept as literals
  'scrum:replyBy': 'replyBy',
  'scrum:to': 'transition.to',
  'scrum:closureReason': 'transition.closureReason',
  'scrum:effectiveAt': 'transition.effectiveAt',
  // ── #1110 — seat declarations, projected from seat-state EVENTS (the log is
  // the source; the document keeps one row per seat and loses history). ──────
  'scrum:SeatDeclaration': null,            // the type; minted by the projection
  'scrum:declaredSeat': 'seat',             // → person: IRI (also used by TendingClaimAttempt)
  'scrum:mode': 'mode',
  'scrum:acceptsRoutineWork': 'acceptsRoutineWork',
  'scrum:declaredAt': 'declaredAt',
  'scrum:expiresAt': 'expiresAt',
  'scrum:constraint': 'constraints',        // plural field → one triple per value
  'scrum:endedAt': null,                    // minted: the SUCCESSOR event's time ends the interval
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
  // #1041 — the card→card edge itself, and (new) the SAME predicate emitted from
  // a ReleaseCondition subject when a blocker is scoped to ONE acceptance
  // condition rather than to the whole card.
  //
  // ⚠️ IT WAS EMITTED ALL ALONG AND NEVER DECLARED. The card-level edge is
  // minted dynamically through predIri(), which the #875 scanner cannot see, so
  // the gap was invisible until #1041 emitted the same predicate literally. The
  // registry caught it on the first run — a pre-existing hole surfaced by an
  // unrelated change, which is the argument for a scanner that reads the source
  // rather than a list somebody maintains.
  'scrum:blockedBy': 'relationships.blockedBy',
  // #881 — the person whose own pending action IS the block. Deliberately a
  // DIFFERENT predicate from scrum:owner: owner is who chases the blocking
  // CARD, blockedByPerson is the person who is themselves the blocker. They
  // are opposite states and a query for "waiting on me" must return only this one.
  'scrum:blockedByPerson': 'blockers',
  // #966 — "any human will do", naming nobody. A BOOLEAN predicate rather
  // than a sentinel identity or a nullable `person`: both of those would put
  // two meanings in one slot ("nobody recorded who" vs "anyone will do"), and
  // keeping those apart is the entire point. A named-person query cannot match
  // it BY CONSTRUCTION rather than by filtering.
  'scrum:blockedByAnyHuman': 'blockers',
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
  // #1217 — a REFUSED activity's own two fields. Both come from the event log,
  // never from a card: no store field holds them, because the write they
  // describe never reached the store. `scrum:reason` is shared with the refusal
  // text a caller saw; `scrum:httpStatus` is the status that carried it.
  'scrum:reason': null,
  'scrum:httpStatus': null,
  'prov:Activity': null,        // #725 — the event log projected as PROV
  'prov:used': null,
  'prov:wasAssociatedWith': null,
  'prov:startedAtTime': null,
  'schema:CreativeWork': null,  // rdf:type values, not properties
  // #962 — the guessable alias, emitted BESIDE schema:CreativeWork so the query
  // a reasonable person writes stops returning a silent zero. PROJECTION ONLY:
  // no store field corresponds, which is what the `null` says.
  'scrum:Card': null,
  'schema:Comment': null,
  'schema:Person': null,
  'schema:DefinedTerm': null,
  'scrum:Column': null,
  'scrum:Commit': null,         // ⚠️ minted from a bare sha STRING in the store (#814/#858)
  'scrum:Check': null,
  'scrum:Blocker': null,
  'scrum:ReleaseCondition': null,
  'scrum:UnresolvedReference': null,   // #818 — a relationship member naming no card
  'scrum:Decision': null,              // #918 — rdf:type, minted by the projection

  // ── #918 — DECISION predicates. A decision is a CONSTRAINT ON FUTURE WORK,
  // and every field here answers a question prose could not: who ruled, what
  // it binds, and — the one that matters — what would overturn it.
  'scrum:statement': 'statement',       // the ruling itself, one sentence
  'scrum:decidedBy': 'decidedBy',       // an EDGE to a person — "what has X ruled" is a traversal
  'scrum:constrains': 'constrains',     // repeatable TOPIC; the retrieval key, one triple per topic
  'scrum:reopensIf': 'reopensIf',       // ⭐ what evidence would overturn this. Required at the write path.
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
