/**
 * #1561 — Person canonicalization/retention planner.
 *
 * Pure helper. Decides which Person identities ride a first-unit graph
 * operation, given the legacy domain (for `ensurePeople`), the canonical graph
 * Person identity nodes already present (must NOT be clobbered by a doc save),
 * and the in-flight pending persisted Person nodes (`prior`) the importer brought
 * forward — these survive source/roster departures as part of an import.
 *
 * The first-unit builder (who owns `core/graph-compiler.mjs` and routing)
 * attaches the planner's output to the same guarded operation and binds it
 * into the intent digest and the compiler digest/`staticCheck` DOMAIN. That
 * integration is downstream and is NOT done here.
 *
 * What this module is NOT:
 *   - not a store writer. No graph writes, no D2 receipts, no atomicity claims.
 *   - not a widener of #619. `ensurePeople` is the single authority for the
 *     closed source list (card assignees, card creators, conversation authors,
 *     plus roster alias/exclusion). Roster listing alone, claimedBy, prose
 *     mentions, a memory owner, a decision decider or seat declaration alone
 *     MUST NOT mint an identity.
 *   - not a claim about Person-as-membership, permissions, grant, or consent.
 *
 * Determinism: no timestamps, no random state. The plan is a function of the
 * inputs only, in the order given.
 */

import { ensurePeople, EXCLUDED_IDENTITIES } from './people.mjs';
import { PERSON_IRI_BASE } from './jsonld.mjs';

/**
 * The exact set of Person-node fields the planner carries into output.
 *
 * Any field outside this list on a canonical / prior Person node is dropped
 * (the planner does NOT copy computed activity arrays, custom privileges, or
 * private decoration into identity output). Adding a field here is a deliberate
 * act — it widens the planner's contract.
 */
export const PERSON_NODE_FIELDS = Object.freeze([
  '@type', '@id', 'identifier', 'name',
  'scrum:glyph', 'scrum:resolved', 'scrum:aliases',
]);

/**
 * First-unit person-reference predicates — declared in the @context as @id-typed
 * against PERSON_IRI_BASE, and now projected as PERSON EDGES by the replica
 * (see `MEMORY_PREDICATES`, `TENDING_PREDICATES`, `projectDecision`, and the
 * `scrum:SeatDeclaration` projection). These are the owner / decider / seat
 * references the migration cannot drop and cannot silently widen into a Person
 * mint.
 *
 * Source of truth: the CONTEXT declaration in `core/jsonld.mjs` and the
 * per-kind predicate tables in `core/graph-replica.mjs`. Kept here as a frozen
 * constant for the planner's scan.
 */
const FIRST_UNIT_PERSON_PREDICATES = Object.freeze({
  'scrum:MemoryVersion':       ['scrum:owner', 'author'],
  'scrum:Memory':               ['scrum:owner'],
  'scrum:Decision':             ['scrum:decidedBy'],
  'scrum:SeatDeclaration':      ['scrum:declaredSeat'],
  'scrum:TendingPromptVersion': ['author', 'scrum:influencedBy'],
  'scrum:TendingPrompt':        ['author', 'scrum:influencedBy'],
  'scrum:TendingControlEvent':  ['scrum:actor'],
  'scrum:TendingClaimAttempt':  ['scrum:declaredSeat'],
  'scrum:TendingMint':          ['scrum:seatNamesWithOpenStreamsAtSend'],
});

/** The collections the planner scans for first-unit references. */
const REFERENCE_BEARING_COLLECTIONS = Object.freeze([
  'memories',           // MemoryVersion + Memory
  'memoryVersions',     // log-born MemoryVersion that ride a separate array
  'decisions',          // scrum:Decision
  'seatStates',         // scrum:SeatDeclaration (legacy + log)
  'tending',            // tending prompts, control events, claim attempts, mints
  // `firstUnitEntities` is an opt-in escape hatch for currently event-born
  // records that have not yet been promoted into a typed collection — the
  // planner scans the same predicates against its entries.
  'firstUnitEntities',
]);

/**
 * Normalize a Person reference value to the IRI the replica would write.
 * A value that already starts with `http` is kept verbatim; otherwise it's
 * prefixed with PERSON_IRI_BASE. Returns null for non-strings (the planner
 * reports only IRI-shaped references, matching the projector contract).
 */
function valueToIri(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.startsWith('http') ? value : `${PERSON_IRI_BASE}${value}`;
}

/**
 * Extract an identifier (the person key) from a person IRI. Returns null for
 * non-IRI values, so a bare person key (e.g. `"ada"`) is normalized through
 * `valueToIri` first.
 */
function identifierFromIri(value) {
  const iri = valueToIri(value);
  if (!iri || !iri.startsWith(PERSON_IRI_BASE)) return null;
  const key = iri.slice(PERSON_IRI_BASE.length);
  return key.length > 0 ? key : null;
}

/**
 * Project one entity to its @id, the way the projector would — for diagnostics
 * the planner uses the entity's own @id if present, otherwise nothing.
 */
function entitySourceId(entity) {
  return typeof entity?.['@id'] === 'string' ? entity['@id'] : null;
}

/**
 * Walk the domain's first-unit reference-bearing collections and report any
 * reference whose target identifier is NOT in the union.
 *
 * The reference itself rides the input entity verbatim — the planner does not
 * modify the domain. Diagnostics are sorted by `(source, predicate, identifier)`
 * so plans are comparable byte-for-byte.
 */
function unresolvedFirstUnitReferences(domain, unionByIdentifier) {
  const reported = [];
  for (const collection of REFERENCE_BEARING_COLLECTIONS) {
    const list = Array.isArray(domain?.[collection]) ? domain[collection] : [];
    for (const entity of list) {
      if (!entity || typeof entity !== 'object') continue;
      const type = typeof entity['@type'] === 'string' ? entity['@type'] : null;
      const predicates = type ? FIRST_UNIT_PERSON_PREDICATES[type] : null;
      if (!predicates) continue;
      const source = entitySourceId(entity);
      for (const predicate of predicates) {
        const raw = entity[predicate];
        if (raw === undefined || raw === null) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        for (const value of values) {
          // Convert through the SAME projector rule the replica uses: full
          // http IRIs are kept verbatim, otherwise PERSON_IRI_BASE + key. The
          // planner does NOT mint.
          const projected = valueToIri(value);
          if (!projected) continue;
          const identifier = identifierFromIri(projected);
          if (!identifier) continue;
          if (unionByIdentifier.has(identifier)) continue;
          reported.push({ source, predicate, identifier, value: projected });
        }
      }
    }
  }
  reported.sort((a, b) => {
    if (a.source !== b.source) return String(a.source).localeCompare(String(b.source));
    if (a.predicate !== b.predicate) return a.predicate.localeCompare(b.predicate);
    return a.identifier.localeCompare(b.identifier);
  });
  return reported;
}

/**
 * Build the deterministic union of { retained, create }, sorted by identifier.
 * `retained` wins on duplicate key (canonical > prior > fresh).
 */
function unionByKey(retained, create) {
  const byKey = new Map();
  for (const p of retained) byKey.set(p.identifier, p);
  for (const p of create) byKey.set(p.identifier, p);
  return [...byKey.values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
}

/** True iff the entity carries the expected Person shape. */
function isValidPersonShape(entity) {
  if (!entity || typeof entity !== 'object') return false;
  if (entity['@type'] !== 'Person') return false;
  if (typeof entity['@id'] !== 'string') return false;
  if (!entity['@id'].startsWith(PERSON_IRI_BASE)) return false;
  if (typeof entity.identifier !== 'string' || entity.identifier.length === 0) return false;
  if (entity['@id'] !== `${PERSON_IRI_BASE}${entity.identifier}`) return false;
  return true;
}

/**
 * Project a Person node to the planner's supported whitelist. Returns a fresh
 * object so the output is not aliased to a mutable input.
 *
 * Supported: `@type`, `@id`, `identifier`, `name`, `scrum:glyph`,
 * `scrum:resolved`, `scrum:aliases`. Any other field is dropped — computed
 * activity arrays, custom privileges, or private decoration do NOT ride into
 * identity output.
 *
 * Each supported field is type-validated: `@id` and `identifier` must be
 * non-empty strings; `scrum:glyph` must be a string-or-null; `scrum:resolved`
 * must be a boolean; `scrum:aliases` must be an array of strings.
 */
function projectPersonNode(input) {
  if (!isValidPersonShape(input)) return null;
  const out = {
    '@type': 'Person',
    '@id': input['@id'],
    identifier: input.identifier,
  };
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') {
      throw new TypeError(
        `planPersonRetention: Person identifier=${input.identifier} has non-string name: `
        + `${typeof input.name}`,
      );
    }
    out.name = input.name;
  }
  if ('scrum:glyph' in input) {
    const g = input['scrum:glyph'];
    if (g !== null && typeof g !== 'string') {
      throw new TypeError(
        `planPersonRetention: Person identifier=${input.identifier} has non-string scrum:glyph: `
        + `${typeof g}`,
      );
    }
    out['scrum:glyph'] = g;
  }
  if ('scrum:resolved' in input) {
    if (typeof input['scrum:resolved'] !== 'boolean') {
      throw new TypeError(
        `planPersonRetention: Person identifier=${input.identifier} has non-boolean scrum:resolved: `
        + `${typeof input['scrum:resolved']}`,
      );
    }
    out['scrum:resolved'] = input['scrum:resolved'];
  }
  if ('scrum:aliases' in input) {
    const a = input['scrum:aliases'];
    if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) {
      throw new TypeError(
        `planPersonRetention: Person identifier=${input.identifier} has non-string[] scrum:aliases`,
      );
    }
    out['scrum:aliases'] = [...a];
  }
  return out;
}

/**
 * Plan the Person retention for one first-unit operation.
 *
 * @param {object} args
 * @param {object} args.domain             Legacy domain expected by `ensurePeople`.
 * @param {object} [args.roster]           Roster used by `ensurePeople`.
 * @param {Array}  args.canonicalPeople    Already-canonical graph Person nodes.
 *                                         MUST be an array — a non-array is an
 *                                         integrity error, not an empty list.
 * @param {Array}  [args.prior]            Pending persisted Person nodes carried
 *                                         forward by the importer (e.g. a doc
 *                                         save bringing forward identity nodes
 *                                         the previous domain held). These ride
 *                                         unless a canonical node dominates.
 * @param {Array}  [args.occupied]         Target IRIs at which the planner must
 *                                         respect existing types.
 *
 * Priority (on duplicate key): canonical > prior > fresh derivation.
 *
 *   people             — the union { retained ∪ create }, deterministic by identifier.
 *   create             — identities ABSENT from canonicalPeople. Includes both
 *                        source-derived AND prior import candidates: a prior
 *                        Person node whose identifier is not yet on the graph
 *                        rides as a write candidate. An importer writing
 *                        `create` cannot lose them.
 *   retained           — canonical graph nodes that ride as-is (historical
 *                        identity survives source/roster departure; "no deletion
 *                        list" — canonical is the floor).
 *   unresolvedReferences — first-unit owner / decider / seat references whose
 *                        target is absent from the union. Reported, not minted,
 *                        not stripped. Diagnostics, not a domain effect.
 *
 * No graph writes. No D2 receipts. No atomicity claims. Integration is downstream.
 */
export function planPersonRetention({
  domain,
  roster = {},
  canonicalPeople = [],
  prior = [],
  occupied = [],
} = {}) {
  if (!Array.isArray(canonicalPeople)) {
    throw new TypeError(
      `planPersonRetention: canonicalPeople must be an array, got ${typeof canonicalPeople}`,
    );
  }
  if (!Array.isArray(prior)) {
    throw new TypeError('planPersonRetention: prior must be an array');
  }
  if (!Array.isArray(occupied)) {
    throw new TypeError('planPersonRetention: occupied must be an array');
  }

  // ── 0 · Validate canonical input shape ─────────────────────────────────
  // A canonical node failing the Person-shape contract, OR a duplicate
  // identifier with conflicting metadata, is an integrity error.
  const canonical = [];
  const canonicalByKey = new Map();
  for (const p of canonicalPeople) {
    if (!isValidPersonShape(p)) {
      throw new TypeError(
        `planPersonRetention: invalid canonical Person identity node: ${JSON.stringify(p)}`,
      );
    }
    if (canonicalByKey.has(p.identifier)) {
      throw new Error(
        `planPersonRetention: conflicting duplicate canonical Person identifier ${p.identifier}`,
      );
    }
    canonicalByKey.set(p.identifier, p);
    canonical.push(p);
  }

  // ── 1 · Incompatible occupied IRI refuses ──────────────────────────────
  for (const occ of occupied) {
    if (!occ || typeof occ !== 'object') continue;
    if (typeof occ['@id'] !== 'string' || !occ['@id'].startsWith(PERSON_IRI_BASE)) continue;
    if (occ['@type'] !== 'Person') {
      throw new Error(
        `planPersonRetention: incompatible occupied @id ${occ['@id']} has @type ${occ['@type']}`,
      );
    }
  }

  // ── 2 · Derive fresh identities from the closed source set ──────────────
  // `ensurePeople` is the single authority for the closed source list.
  // `prior` rides OUTSIDE that derivation; this planner keeps them separate
  // so an import can carry historical identity forward.
  const ensured = ensurePeople(domain, roster);
  const fresh = [];
  const freshByKey = new Map();
  for (const p of ensured.people) {
    if (!isValidPersonShape(p)) {
      throw new TypeError(
        `planPersonRetention: ensurePeople produced an invalid Person node: ${JSON.stringify(p)}`,
      );
    }
    if (freshByKey.has(p.identifier)) {
      // ensurePeople already de-dupes by key; a duplicate here means the source
      // asserted the same identity twice. Refuse rather than silently order-pick.
      throw new Error(
        `planPersonRetention: ensurePeople produced duplicate Person identifier ${p.identifier}`,
      );
    }
    freshByKey.set(p.identifier, p);
    fresh.push(p);
  }

  // ── 3 · Validate prior ────────────────────────────────────────────────
  // `prior` are the Person nodes an importer carries forward (e.g. a save
  // attaching identity nodes the previous domain held). They ride as import
  // candidates unless a canonical node dominates the same identifier.
  // Conflicting duplicate prior nodes (same key, different metadata) REFUSE
  // rather than silently order-pick; identical duplicates dedupe.
  const priorByKey = new Map();
  for (const priorNode of prior) {
    if (!isValidPersonShape(priorNode)) {
      throw new TypeError(
        `planPersonRetention: invalid prior Person node: ${JSON.stringify(priorNode)}`,
      );
    }
    const existing = priorByKey.get(priorNode.identifier);
    if (existing) {
      // Byte-identical duplicates are tolerated (the same node passed twice).
      if (JSON.stringify(existing) !== JSON.stringify(priorNode)) {
        throw new Error(
          `planPersonRetention: conflicting duplicate prior Person identifier ${priorNode.identifier}`,
        );
      }
    } else {
      priorByKey.set(priorNode.identifier, priorNode);
    }
  }

  // ── 4 · retained = canonical (cloned to supported whitelist) ───────────
  // Canonical wins on duplicate key — full stop. Prior metadata and fresh
  // derivation cannot overwrite canonical identity. The retained set is
  // CLONED through the supported whitelist so the output does not alias
  // mutable input (an in-place edit downstream must not change what the
  // planner returned).
  const retained = canonical.map((p) => projectPersonNode(p));

  // ── 5 · create = prior ∪ fresh, minus canonical, projected ─────────────
  // Every output identity absent from canonicalPeople becomes a write
  // candidate — that includes prior import candidates (a departed identity
  // with no current source is preserved as a write candidate) and the
  // source-derived fresh identities. Canonical nodes do NOT appear here
  // (they were retained, not created). Each candidate is projected to the
  // supported whitelist so the output does not alias mutable input.
  const canonicalKeys = new Set(canonical.map((p) => p.identifier));
  const create = [];
  const createKeyset = new Set();
  // 5a. Prior first — so a prior identity rides even when the source set
  //     did not produce one for it. An importer writing `create` keeps its
  //     identities.
  for (const priorNode of prior) {
    if (canonicalKeys.has(priorNode.identifier)) continue;
    if (createKeyset.has(priorNode.identifier)) continue;
    createKeyset.add(priorNode.identifier);
    create.push(projectPersonNode(priorNode));
  }
  // 5b. Fresh derivation fills in any source-set identity not covered by
  //     canonical or prior.
  for (const freshNode of fresh) {
    if (canonicalKeys.has(freshNode.identifier)) continue;
    if (createKeyset.has(freshNode.identifier)) continue;
    createKeyset.add(freshNode.identifier);
    create.push(projectPersonNode(freshNode));
  }

  // ── 6 · Deterministic union ────────────────────────────────────────────
  const union = unionByKey(retained, create);
  create.sort((a, b) => a.identifier.localeCompare(b.identifier));
  retained.sort((a, b) => a.identifier.localeCompare(b.identifier));

  // ── 7 · Unresolved first-unit owner / decider / seat references ────────
  const unionByIdentifier = new Map(union.map((p) => [p.identifier, p]));
  const unresolvedReferences = unresolvedFirstUnitReferences(domain, unionByIdentifier);

  return { people: union, create, retained, unresolvedReferences };
}

export { EXCLUDED_IDENTITIES };