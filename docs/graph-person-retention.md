# Person canonicalization & retention — first-unit graph migration

Pure helper that decides which Person identities ride a first-unit graph
operation. **Planner, not a store writer.** the first-unit builder owns the
guarded operation, attaches the planner's output to it, and binds it into the
intent digest and the compiler digest / `staticCheck` `DOMAIN`. Nothing here
writes the graph, emits a D2 receipt, or claims atomicity.

## Module

`core/graph-people.mjs` exports `planPersonRetention`, plus
`PERSON_NODE_FIELDS` (the supported whitelist).

```js
planPersonRetention({
  domain,              // legacy domain for ensurePeople
  roster,              // roster for ensurePeople
  canonicalPeople,     // already-canonical graph Person nodes — array, defaults to []
  prior,               // pending persisted Person nodes carried by an import
  occupied,            // existing target IRIs whose types must be respected
})
  -> { people, create, retained, unresolvedReferences }
```

| return                 | meaning                                                                                                                              |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `people`               | Deterministic union (retained ∪ create), sorted by identifier. Each node is cloned through the supported whitelist.                  |
| `create`               | Identities absent from `canonicalPeople`: source-derived AND prior-import candidates. An importer writing `create` cannot lose them. |
| `retained`             | Canonical graph nodes that ride as-is. Historical identity survives source/roster departure; there is no deletion list.               |
| `unresolvedReferences` | First-unit owner / decider / seat references whose target is NOT in the union. Reported, not minted, not stripped.                     |

## What it is not

- Not a store writer. No `saveDomain`, no `appendEvent`, no replica sync.
- Not a widener of #619. `ensurePeople` is the closed-source authority
  (card assignees, card creators, conversation authors, plus roster
  alias/exclusion). Roster listing alone, claimedBy, prose mentions, a memory
  owner, a decision decider or seat declaration alone MUST NOT mint an identity.
- Not Person-as-membership. No permissions, grants, or consent.
- Not a closed cutover. The builder wires `create` into the intent digest and
  the `staticCheck` `DOMAIN` shape downstream; integration is named below.

## Supported Person-node whitelist

The planner clones every output node through this exact whitelist. Any field
outside the list on a canonical / prior node is dropped. The whitelist is
exported as `PERSON_NODE_FIELDS`:

- `@type`           — always `'Person'`
- `@id`             — the canonical Person IRI
- `identifier`      — the person key
- `name`            — display name (string)
- `scrum:glyph`     — emoji or null (string-or-null)
- `scrum:resolved`  — boolean (false for unknown identities)
- `scrum:aliases`   — array of strings

Computed activity arrays (`assigned`, `authored`, `claiming`, `created`),
custom privileges, and any private decoration are NOT carried into output.

## Priority rules

On duplicate identifier:

1. **Canonical** wins — full stop. Prior and fresh derivation cannot overwrite
   canonical metadata.
2. **Prior** persisted records (import candidates) ride unless canonical dominates.
3. **Fresh** derivation from the closed source list fills anything still
   absent.

`create` covers EVERY output identity absent from `canonicalPeople`, including
prior carry-forwards. Departed identities with no current source mention ride as
write candidates. `retained` is exactly the canonical nodes.

## Determinism

- No clock, no randomness. The plan is a function of the inputs only.
- Output is sorted by identifier. Re-ordering `canonicalPeople` does not change
  the plan.
- Re-planning with the same inputs is a fixed point.
- Inputs are not mutated. Output nodes are cloned — mutating a plan field
  downstream does not bleed into the next plan.
- `canonicalPeople` defaults to `[]`; an explicitly supplied non-array refuses rather than silently becoming empty.

## Identity & IRI rules

- IRIs: `https://scrumboard.local/person/<key>`. URN-style `urn:ex:seat/<key>`
  keys are not minted.
- Identifier is the key; `@id` is `${PERSON_IRI_BASE}${identifier}`.
  Disagreement is an integrity error.
- Canonical metadata (name, glyph, aliases) survives a doc save verbatim — the
  planner does not overwrite from a roster or closed-source mint.

## Closed source set, restated

`ensurePeople` is the single authority for the closed source list
(`PERSON_SOURCE_FIELDS`: `assignees`, `author`, `createdBy`). These are NOT
sources and never produce a Person:

- roster listing alone
- `claimedBy` (custody lease)
- prose `mentions` (regex-scraped)
- `for` (beneficiary prose)
- a memory owner (`scrum:owner` or `author` on a MemoryVersion)
- a decision decider alone (`scrum:decidedBy`)
- a `scrum:declaredSeat` or `scrum:actor` alone — first-unit references but not
  identity sources; they ride the domain verbatim and are REPORTED if unresolved.

## First-unit references (diagnostics)

The replica projects these predicates as PERSON EDGES (see
`MEMORY_PREDICATES`, `TENDING_PREDICATES`, `projectDecision`, and the
`scrum:SeatDeclaration` projection in `core/graph-replica.mjs`):

- `scrum:MemoryVersion` — `scrum:owner`, `author`
- `scrum:Memory` — `scrum:owner`
- `scrum:Decision` — `scrum:decidedBy`
- `scrum:SeatDeclaration` — `scrum:declaredSeat`
- `scrum:TendingPromptVersion` — `author`, `scrum:influencedBy`
- `scrum:TendingPrompt` — `author`, `scrum:influencedBy`
- `scrum:TendingControlEvent` — `scrum:actor`
- `scrum:TendingClaimAttempt` — `scrum:declaredSeat`
- `scrum:TendingMint` — `scrum:seatNamesWithOpenStreamsAtSend`

The planner walks `memories`, `memoryVersions`, `decisions`, `seatStates`,
`tending`, plus the opt-in `firstUnitEntities` (for currently event-born
records absent from any typed collection). Raw-key values are converted using
the SAME projector rule the replica uses: full http IRIs are kept verbatim,
otherwise `PERSON_IRI_BASE + key`. The planner does NOT mint — it REPORTS:

```js
{ source: '<@id of the entity carrying the reference>',
  predicate: 'scrum:declaredSeat',
  identifier: 'ghost_seat',
  value: 'https://scrumboard.local/person/ghost_seat' }
```

The reference rides the input domain verbatim. The migration does not fail
solely because a previously dangling reference remained dangling — diagnostics
are a log, not a domain effect (the builder does not need to hash them into
intent). Identity effects are semantic, and this gives the caller the WHAT to
fix in a later write.

## Incompatible occupied IRIs

A `occupied` entry whose `@id` is in the person namespace but whose `@type` is
not `Person` is an integrity error. A compatible case (same IRI, already
`Person`) reuses the canonical node. Non-person-namespace entries are out of
scope.

## Importing prior Person nodes

`ensurePeople` normally drops prior `domain.people`. The planner carries
forward an importer's prior Person nodes as `prior` and rides them as
`create` (canonical wins on duplicate key). Conflicting duplicate priors
refuse; identical duplicates dedupe. A malformed prior node refuses.

## Integration still required (named, not done)

1. **Compiler digest / `staticCheck` `DOMAIN`.** the first-unit builder
   extends the compiler digest and the `staticCheck` `DOMAIN` shape to carry
   the planner's output (`people`, `create`, `retained`,
   `unresolvedReferences`) as the structured Person payload. **Not done here.**
2. **Initial receipted import.** The first migration run produces a receipted
   write that materializes `create` and logs `unresolvedReferences` to an
   audit surface. **Not done here.**
3. **First-unit hook wiring.** The builder attaches the planner's output to
   the SAME guarded operation and binds it into the intent digest before
   `compile`. **Not done here.**
4. **No doc / replica overwrite.** A doc save that arrives WITHOUT going
   through the first-unit builder MUST NOT silently clobber canonical
   identity — the canonical-wins rule is enforced inside this module, but the
   doc save path must continue to call into the planner (or refuse) so it
   cannot bypass it. **Enforcement is downstream.**

The Person cutover gate is not closed by this helper alone. Reviewers should
hold the deployment until items 1–4 are visibly wired in their respective
surfaces.

## Concrete first-unit integration call

The importer MUST pass `prior: domain.people ?? []`. The planner does not
implicitly import `domain.people`: that distinguishes an explicit one-time
migration from a normal residual-document save.

Pass event-born records as typed entity nodes in `domain.firstUnitEntities`,
not unprojected event envelopes or wire-response wrappers. The planner scans
this array alongside the legacy collections. Example call:

```js
const plan = planPersonRetention({
  domain: { ...legacyDomain, firstUnitEntities: typedFirstUnitEntities },
  roster,
  canonicalPeople: graphIdentitySnapshot,
  prior: legacyDomain.people ?? [],
  occupied: existingPersonIriTypes,
});
```

Use `plan.create` as the canonical Person payload for the guarded write.
Bind those identity effects into the intention digest; `unresolvedReferences`
is diagnostic output, not an authority grant or a replacement identity set.
Never delete graph identities merely because a later JSON projection omits
them. Preserve the residual JSON projection in its own old replica only.

This commit supplies the planner. D2 receipt/static-check integration and the
real import/save/restart demonstration remain the first-unit builder's gate.

## Wiring status (branch `card/1561-person-wire`)

1. **Digest / staticCheck.** The Person-effects hook is gone. A record intention
   carries the planner's `plan.create` as `people` (exactly `PERSON_NODE_FIELDS`;
   anything else is REJECTED); it is canonicalized into `record.people`, which
   the digest binds, so a replay under one opId with different Person effects is
   an intent-collision. Each Person is created only where no typed node holds its
   IRI (precondition), as ok-guarded DOMAIN inserts; `staticCheck` is unchanged.
   `unresolvedReferences` is NOT in the digest (diagnostic, per this contract).
2. **Receipted import.** `scripts/migrate-logborn-1561.mjs` writes ONE
   `person.import` (opId = hash of its payload) before the records, with
   `prior: domain.people ?? []` and the event-born records as typed
   `firstUnitEntities`. Audit surface: the `audit` callback; the CLI writes it to
   `--audit <file>` (required with `--run`): opId, digest, counts and every
   unresolved reference. Verified both ways, triple for triple.
3. **First-unit writes.** `core/logborn-unit.mjs` runs the planner on every
   memory / decision / seat write against the graph's Person identities; under
   the #619 closed source set `plan.create` is empty for all of them (no unit
   write mints), and unresolved references go to the unit's audit sink (stderr
   `[#1561 person-audit]` lines by default).
4. **No overwrite.** Nothing on the residual JSON save path writes the executor;
   a card write (saveDomain) and an executor restart leave the graph's Person
   identities byte-identical (`tests/logborn-person-1561.test.mjs`).

Person IRIs (`https://scrumboard.local/person/<key>`) and the unit's writer
(`urn:ex:seat/<seat>`) are NOT bridged: the actor is an authentication fact on
the receipt, not an identity, and no triple relates the two.
