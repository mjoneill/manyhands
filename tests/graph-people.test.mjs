/**
 * #1561 — first-unit Person canonicalization/retention planner.
 *
 * Pure helper. In-memory, no I/O, no graph writes, no D2 receipts, no
 * atomicity claims — those are downstream integration items. The planner's
 * output rides into the intent digest and the compiler digest/`staticCheck`
 * DOMAIN via the first-unit builder.
 *
 * Why a planner and not a writer: the builder owns the guarded operation and
 * binds the planner's `create` into the digest downstream. The planner's job is
 * to decide WHICH Person identities ride, given the legacy domain (for
 * `ensurePeople`), the canonical graph Person identity nodes (must not be
 * clobbered by a doc save), and the prior Person nodes the importer brings
 * forward (historical identity survives source/roster departure).
 *
 * Consent guard (#619, restated): the source of a Person identity is the
 * closed list `ensurePeople` already enforces (card assignees, card creators,
 * conversation authors, plus roster alias/exclusion). Roster listing alone,
 * claimedBy, prose mentions, a memory owner, a decision decider or seat
 * declaration alone MUST NOT mint an identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPersonRetention } from '../core/graph-people.mjs';
import { PERSON_IRI_BASE } from '../core/jsonld.mjs';

/**
 * Legacy domain shape expected by `ensurePeople` — a domainToBoard-shaped object
 * with `nodes` (cards as CreativeWork), `messages` (posts as Comment), and the
 * passthrough meta (columns, nextShortId, lastUpdated).
 */
const legacyDomain = (overrides = {}) => ({
  nodes: [],
  messages: [],
  columns: [],
  nextShortId: 1,
  lastUpdated: null,
  ...overrides,
});

const ROSTER = { seats: {
  ada: { name: 'Ada', glyph: '🅰️', color: '#4488cc', aliases: ['adalovelace'] },
  bex: { name: 'Bex', glyph: '🅱️', color: '#cc8844' },
  board: { name: 'Board', glyph: '🤖', color: '#888888' },
  wiki: { name: 'wiki', glyph: '📄', color: '#999999' },
} };

/** A canonical Person node — the same shape ensurePeople emits. */
function personNode({ identifier, glyph = null, aliases = [], resolved = true, name = identifier } = {}) {
  return {
    '@type': 'Person',
    '@id': `${PERSON_IRI_BASE}${identifier}`,
    identifier,
    name,
    'scrum:glyph': glyph,
    'scrum:resolved': resolved,
    'scrum:aliases': aliases,
  };
}

// ── 1 · Eligible source + alias/exclusion ───────────────────────────────────

test('eligible source: card assignees + card creator + conversation author; aliases resolve; exclusions dropped', () => {
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't1', text: 'b',
        additionalType: 'scrum:task', creator: 'ada',
        board: { assignees: ['bex', 'adalovelace'], column: 'backlog', order: 0, labels: [] } },
      { '@type': 'CreativeWork', '@id': 'c2', identifier: 2, name: 't2', text: 'b',
        additionalType: 'scrum:task',
        board: { assignees: ['unassigned', 'board'], column: 'backlog', order: 1, labels: [] } },
    ],
    messages: [
      { '@type': 'Comment', '@id': 'm1', text: 'hi', author: 'Ghost', about: null,
        dateCreated: '2026-08-05T00:00:00Z', mentions: [] },
      { '@type': 'Comment', '@id': 'm2', text: 'sys', author: 'wiki', about: null,
        dateCreated: '2026-08-05T00:00:60Z', mentions: [] },
    ],
  });

  const plan = planPersonRetention({ domain, roster: ROSTER });

  const keys = plan.people.map((p) => p.identifier).sort();
  assert.deepEqual(keys, ['Ghost', 'ada', 'bex'],
    'closed source set + alias resolves to its seat; exclusions absent');

  const createKeys = plan.create.map((p) => p.identifier).sort();
  assert.deepEqual(createKeys, ['Ghost', 'ada', 'bex'],
    '`create` is exactly the identities absent from canonicalPeople');

  assert.deepEqual(plan.retained.map((p) => p.identifier), [],
    'nothing was retained — no canonical graph pre-existed');

  assert.deepEqual(plan.unresolvedReferences, [],
    'no first-unit reference was passed; nothing to report');

  for (const p of plan.create) {
    assert.equal(p['@type'], 'Person');
    assert.ok(p['@id']?.startsWith(PERSON_IRI_BASE),
      `@id lives in the person IRI space: ${p['@id']}`);
    assert.equal(typeof p.identifier, 'string');
    assert.equal(p['scrum:resolved'], p.identifier === 'Ghost' ? false : true,
      'unknown identity stays marked, never guessed');
  }
});

// ── 2 · Retained author after source/roster departure ──────────────────────

test('retained author survives the source set and the roster going away', () => {
  const domain = legacyDomain();
  const emptyRoster = { seats: {} };

  const ada = personNode({ identifier: 'ada', glyph: '🅰️', aliases: ['adalovelace'] });
  const bex = personNode({ identifier: 'bex', glyph: '🅱️' });

  const plan = planPersonRetention({
    domain, roster: emptyRoster, canonicalPeople: [ada, bex],
  });

  assert.deepEqual(plan.retained.map((p) => p.identifier).sort(), ['ada', 'bex'],
    'historical identities are NOT dropped when source/roster go away');

  assert.deepEqual(plan.create.map((p) => p.identifier), [],
    'a source-less domain mints nothing — closed list is closed');

  assert.deepEqual(plan.people.map((p) => p.identifier).sort(), ['ada', 'bex'],
    'the deterministic union is exactly the canonical set');

  const retainedAda = plan.retained.find((p) => p.identifier === 'ada');
  assert.deepEqual(retainedAda, ada,
    'canonical metadata survives — the planner does not re-derive from a gone roster');
});

// ── 3 · Existing canonical metadata survives conflicting doc metadata ──────

test('canonical name survives conflicting doc/roster derivation on duplicate key', () => {
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task', creator: 'ada',
        board: { assignees: [], column: 'backlog', order: 0, labels: [] } },
    ],
  });
  const adaCanonical = personNode({ identifier: 'ada', glyph: '★' });
  adaCanonical.name = 'Augusta Ada King-Noel, Countess of Lovelace';

  const plan = planPersonRetention({
    domain, roster: ROSTER, canonicalPeople: [adaCanonical],
  });

  const adaInUnion = plan.people.find((p) => p.identifier === 'ada');
  assert.deepEqual(adaInUnion, adaCanonical,
    'the union node IS the canonical node — byte-for-byte, no overwrite from the doc/roster');

  assert.equal(plan.create.length, 0, '`ada` was already a canonical identity — nothing to create');
  assert.equal(plan.people.length, 1, 'no phantom duplicates on duplicate key');
});

// ── 4 · Prose / owner / custody not minting, even with a legitimate twin ────

test('non-source appearances (memory owner) never widen the closed source list', () => {
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task',
        board: { assignees: ['ada'], column: 'backlog', order: 0, labels: [] } },
    ],
    messages: [
      { '@type': 'Comment', '@id': 'm1', text: 'thanks @ada', author: 'bex',
        about: null, dateCreated: '2026-08-05T00:00:00Z', mentions: ['ada'] },
    ],
    memories: [
      { '@type': 'scrum:MemoryVersion', '@id': 'memV1',
        text: 'a memory', author: 'ada', dateCreated: '2026-08-05T00:00:00Z',
        'scrum:owner': 'ada' },
      { '@type': 'scrum:MemoryVersion', '@id': 'memV2',
        text: 'another memory', author: 'ghost_owner',
        dateCreated: '2026-08-05T00:00:00Z',
        'scrum:owner': 'ghost_owner' },
    ],
  });

  const plan = planPersonRetention({ domain, roster: ROSTER });

  const keys = plan.people.map((p) => p.identifier).sort();
  assert.deepEqual(keys, ['ada', 'bex'],
    'closed-source mint only: card assignees + conversation author; memory '
    + 'owner is NOT a source — `ghost_owner` is NOT minted');
  assert.equal(keys.includes('ghost_owner'), false,
    'memory owner alone must NEVER mint an identity (do not widen #619)');
});

// ── 5 · Incompatible occupied IRI refuses — compatible twin reuses ────────

test('incompatible occupied IRI refuses with an integrity error; compatible twin reuses canonical', () => {
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task',
        board: { assignees: ['ada'], column: 'backlog', order: 0, labels: [] } },
    ],
  });
  const adaCanonical = personNode({ identifier: 'ada', glyph: '🅰️' });

  const compatible = planPersonRetention({
    domain, roster: ROSTER, canonicalPeople: [adaCanonical],
    occupied: [{ '@id': `${PERSON_IRI_BASE}ada`, '@type': 'Person' }],
  });
  assert.equal(compatible.people.length, 1, 'compatible twin reuses canonical — no reclassification');
  assert.deepEqual(compatible.people[0], adaCanonical, 'and the canonical node wins');

  assert.throws(
    () => planPersonRetention({
      domain, roster: ROSTER, canonicalPeople: [adaCanonical],
      occupied: [{ '@id': `${PERSON_IRI_BASE}ada`, '@type': 'scrum:Column' }],
    }),
    /incompatible occupied @id/,
    'incompatible type is an integrity error — never silently converted',
  );

  const nonPerson = planPersonRetention({
    domain, roster: ROSTER, canonicalPeople: [adaCanonical],
    occupied: [{ '@id': 'https://scrumboard.local/column/backlog', '@type': 'scrum:Column' }],
  });
  assert.equal(nonPerson.people.length, 1, 'a column-NS occupied entry is out of scope');
});

// ── 6 · Invalid identity structure ─────────────────────────────────────────

test('invalid canonical / prior / ensured shape throws — never silently rewritten', () => {
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task',
        board: { assignees: ['ada'], column: 'backlog', order: 0, labels: [] } },
    ],
  });

  // Bad canonical: missing @type.
  assert.throws(
    () => planPersonRetention({
      domain, roster: ROSTER,
      canonicalPeople: [{ '@id': `${PERSON_IRI_BASE}ada`, identifier: 'ada' }],
    }),
    /invalid canonical Person/,
    'canonical without @type refuses',
  );

  // Bad canonical: identifier disagrees with @id suffix.
  assert.throws(
    () => planPersonRetention({
      domain, roster: ROSTER,
      canonicalPeople: [{ '@type': 'Person', '@id': `${PERSON_IRI_BASE}bex`, identifier: 'ada' }],
    }),
    /invalid canonical Person/,
    'canonical with mismatched identifier/@id refuses',
  );

  // Conflicting duplicate canonical identifier — refuse, never choose.
  assert.throws(
    () => planPersonRetention({
      domain, roster: ROSTER,
      canonicalPeople: [
        personNode({ identifier: 'ada' }),
        personNode({ identifier: 'ada', glyph: '★' }),
      ],
    }),
    /conflicting duplicate canonical Person/,
    'conflicting duplicate canonical identifier refuses — the planner does not pick a winner',
  );

  // Bad prior node — refuses.
  assert.throws(
    () => planPersonRetention({
      domain,
      roster: ROSTER,
      prior: [{ '@type': 'Person', '@id': `${PERSON_IRI_BASE}bex` }],
    }),
    /invalid prior Person/,
    'malformed prior refuses — import does not silently fix it',
  );

  // Conflicting duplicate prior — refuses.
  assert.throws(
    () => planPersonRetention({
      domain, roster: ROSTER,
      prior: [
        personNode({ identifier: 'bex' }),
        personNode({ identifier: 'bex', glyph: '★' }),
      ],
    }),
    /conflicting duplicate prior Person/,
    'conflicting duplicate prior refuses — the planner does not pick a winner',
  );

  // canonicalPeople must be an ARRAY. A non-array refuses rather than
  // silently being treated as empty (malformed data must throw).
  assert.throws(
    () => planPersonRetention({ domain, roster: ROSTER, canonicalPeople: 'oops' }),
    /canonicalPeople must be an array/,
    'non-array canonicalPeople refuses — malformed data must throw',
  );

  // Byte-identical duplicate prior — tolerated (same node passed twice).
  const okPlan = planPersonRetention({
    domain, roster: ROSTER,
    prior: [personNode({ identifier: 'bex' }), personNode({ identifier: 'bex' })],
  });
  assert.deepEqual(okPlan.create.map((p) => p.identifier).sort(), ['ada', 'bex'],
    'identical prior duplicates dedupe');
});

// ── 7 · Output is cloned (no input aliasing); supported whitelist enforced ─────

test('output is cloned through the supported whitelist; mutating returned nodes does not bleed back', () => {
  const adaCanonical = personNode({ identifier: 'ada', glyph: '🅰️', aliases: ['adalovelace'] });
  // Computed activity arrays and private decoration DO NOT ride into output.
  adaCanonical.assigned = ['c1', 'c2'];
  adaCanonical.authored = ['m1'];
  adaCanonical.claiming = ['c3'];
  adaCanonical.privateNote = 'should not ride';

  const bexCanonical = personNode({ identifier: 'bex' });

  const plan = planPersonRetention({
    domain: legacyDomain(),
    roster: ROSTER,
    canonicalPeople: [adaCanonical, bexCanonical],
  });

  // Capture the bytes BEFORE we touch anything downstream — every subsequent
  // mutation must leave these untouched.
  const capturedRetained = JSON.parse(JSON.stringify(plan.retained));
  const capturedCreate = JSON.parse(JSON.stringify(plan.create));
  const capturedUnion = JSON.parse(JSON.stringify(plan.people));
  const capturedInput = {
    ada: JSON.parse(JSON.stringify(adaCanonical)),
    bex: JSON.parse(JSON.stringify(bexCanonical)),
  };

  // The whitelist strips computed activity arrays + private decoration.
  for (const node of plan.retained) {
    assert.equal(node.assigned, undefined, 'assigned (computed activity) is stripped');
    assert.equal(node.authored, undefined, 'authored (computed activity) is stripped');
    assert.equal(node.claiming, undefined, 'claiming (computed activity) is stripped');
    assert.equal(node.privateNote, undefined, 'private decoration is stripped');
    assert.deepEqual(
      Object.keys(node).sort(),
      ['@id', '@type', 'identifier', 'name', 'scrum:aliases', 'scrum:glyph', 'scrum:resolved'].sort(),
      'output nodes carry only the planner-supported whitelist',
    );
  }
  // `scrum:aliases` must be CLONED, not aliased to the caller's array.
  const retainedAda = plan.retained.find((p) => p.identifier === 'ada');
  retainedAda['scrum:aliases'].push('MUTATED_ALIAS');
  retainedAda['scrum:glyph'] = 'MUTATED_GLYPH';
  retainedAda.name = 'MUTATED_NAME';

  // Inputs untouched.
  assert.deepEqual(adaCanonical, capturedInput.ada,
    'canonical input is not mutated by downstream output mutation');
  assert.deepEqual(bexCanonical, capturedInput.bex,
    'canonical input is not mutated by downstream output mutation');

  // Captured-before-mutation values are stable — they reflect what the planner
  // returned BEFORE we mutated downstream. Mutating the returned nodes does
  // NOT change the captured snapshot.
  assert.deepEqual(capturedRetained[0], personNode({ identifier: 'ada', glyph: '🅰️', aliases: ['adalovelace'] }),
    'captured snapshot (before mutation) reflects the planner’s contract — output is not aliased to mutable inputs');
  assert.deepEqual(capturedCreate, [], 'no create when canonical covers the graph');
  assert.deepEqual(capturedUnion.map((p) => p.identifier).sort(), ['ada', 'bex'],
    'captured union is the deterministic contract');

  // Re-planning with the same inputs produces a plan equal to the captured
  // BEFORE-MUTATION snapshot — the mutation we performed on `plan.retained`
  // does NOT bleed into a fresh plan.
  const planAgain = planPersonRetention({
    domain: legacyDomain(),
    roster: ROSTER,
    canonicalPeople: [adaCanonical, bexCanonical],
  });
  assert.deepEqual(planAgain.retained, capturedRetained,
    're-planning produces a plan equal to the captured-before-mutation snapshot — no alias leakage');
});

// ── 8 · Prior imports ride as `create`, canonical still dominates ─────────

test('prior imports ride as write candidates; canonical still dominates on duplicate key', () => {
  // ada is source-derived; bex is NOT in source but is carried as a prior
  // import identity; ghost is NOT in source but is carried as a prior
  // identity with no current source-set mention. All three must ride.
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task', creator: 'ada',
        board: { assignees: ['ada'], column: 'backlog', order: 0, labels: [] } },
    ],
  });
  const adaCanonical = personNode({
    identifier: 'ada', glyph: '★', name: 'Augusta Ada King-Noel, Countess of Lovelace',
  });

  // One prior identity shares the canonical key (ada) — canonical wins on
  // duplicate, prior metadata is NOT clobbered into canonical.
  const priorAda = personNode({ identifier: 'ada', glyph: '🅰️' });
  const priorBex = personNode({ identifier: 'bex', glyph: '🅱️' });
  const priorGhost = personNode({ identifier: 'ghost' });

  const plan = planPersonRetention({
    domain, roster: ROSTER,
    canonicalPeople: [adaCanonical],
    prior: [priorAda, priorBex, priorGhost],
  });

  // Canonical dominates: the union's `ada` carries the canonical metadata.
  const adaInUnion = plan.people.find((p) => p.identifier === 'ada');
  assert.deepEqual(adaInUnion, adaCanonical,
    'canonical dominates prior on duplicate key — prior metadata is not clobbered into canonical');

  // `retained` carries the canonical nodes only.
  assert.deepEqual(plan.retained.map((p) => p.identifier).sort(), ['ada'],
    'retained is exactly the canonical set');

  // `create` carries EVERY absent-from-canonical identity: source-derived
  // (none beyond ada here) AND prior-essentials. bex and ghost are absent
  // from canonical — they ride as write candidates.
  assert.deepEqual(plan.create.map((p) => p.identifier).sort(), ['bex', 'ghost'],
    'create covers every absent-from-canonical identity — including prior import candidates');

  // The union is the closed union of retained + create, sorted by identifier.
  assert.deepEqual(plan.people.map((p) => p.identifier).sort(), ['ada', 'bex', 'ghost'],
    'the union is canonical ∪ create');

  // A duplicated prior/source pair (the same key appearing in BOTH source
  // AND prior, with prior metadata carrying different bytes) — canonical
  // still dominates because the source-derived copy is not in canonical here,
  // so `bex` rides via prior (source did not produce a bex). Source did not
  // produce `bex` either, so bex rides solely from prior.
  assert.deepEqual(plan.create.find((p) => p.identifier === 'bex'), priorBex,
    'prior identity absent canonical/source rides as a write candidate');

  // A prior identity with no current source mention (ghost) still rides.
  assert.deepEqual(plan.create.find((p) => p.identifier === 'ghost'), priorGhost,
    'a departed identity carried as prior is a write candidate even with no current source');
});

// ── 9 · Unresolved first-unit references reported; real projector shapes ──

test('unresolved first-unit references use projector IRI rules; raw keys and full IRIs both reported', () => {
  // Real projector shapes from `MEMORY_PREDICATES`, `TENDING_PREDICATES`,
  // `projectDecision`, and the `scrum:SeatDeclaration` projection.
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task',
        board: { assignees: ['ada'], column: 'backlog', order: 0, labels: [] } },
    ],
    // MemoryVersion: `scrum:owner` AND `author` (raw keys) — neither is a
    // closed source, but the planner still walks them as first-unit refs.
    memories: [
      { '@type': 'scrum:MemoryVersion', '@id': 'memV1',
        text: 'a memory', author: 'ada', 'scrum:owner': `${PERSON_IRI_BASE}ada`,
        dateCreated: '2026-08-05T00:00:00Z' },
      { '@type': 'scrum:MemoryVersion', '@id': 'memV2',
        text: 'a memory', author: 'ghost_author', 'scrum:owner': 'ghost_owner',
        dateCreated: '2026-08-05T00:00:00Z' },
    ],
    // Decision: `scrum:decidedBy` as a raw key.
    decisions: [
      { '@type': 'scrum:Decision', '@id': 'd1',
        'scrum:statement': 'decided', 'scrum:decidedBy': 'ghost_decider',
        dateCreated: '2026-08-05T00:00:00Z' },
    ],
    // SeatDeclaration: `scrum:declaredSeat` as a raw key.
    seatStates: [
      { '@type': 'scrum:SeatDeclaration', '@id': 'sd1',
        'scrum:declaredSeat': `${PERSON_IRI_BASE}ghost_seat`,
        'scrum:mode': 'resting', 'scrum:declaredAt': '2026-08-05T00:00:00Z' },
    ],
    // Tending: `scrum:actor`, `scrum:declaredSeat`,
    // `scrum:seatNamesWithOpenStreamsAtSend`.
    tending: [
      { '@type': 'scrum:TendingClaimAttempt', '@id': 'claim-1',
        'scrum:declaredSeat': 'ghost_claim_seat' },
      { '@type': 'scrum:TendingControlEvent', '@id': 'pause-1',
        'scrum:actor': `${PERSON_IRI_BASE}ghost_pauser` },
      { '@type': 'scrum:TendingMint', '@id': 'mint-1',
        'scrum:seatNamesWithOpenStreamsAtSend': [
          `${PERSON_IRI_BASE}ghost_seat`,
          `${PERSON_IRI_BASE}ada`,
        ] },
    ],
  });

  // ada is in the union (closed-source); everything else named here is NOT.
  const beforeDomain = JSON.stringify(domain);

  const plan = planPersonRetention({ domain, roster: ROSTER });
  const afterDomain = JSON.stringify(domain);

  // Inputs untouched — diagnostics are a log, not a domain edit.
  assert.equal(afterDomain, beforeDomain,
    'the planner does not rewrite the domain — references ride verbatim');

  // No mint for any unresolved reference — first-unit appearance is not a
  // closed source field, so it cannot widen the source list.
  for (const ref of plan.unresolvedReferences) {
    assert.equal(plan.people.find((p) => p.identifier === ref.identifier), undefined,
      `${ref.identifier} is reported, not promoted into a Person`);
  }

  // Every unresolved reference is reported under its source @id + predicate.
  // `ada` is in the union (closed-source creator), so memV1's references to ada
  // are NOT reported; memV2's references to ghost_author / ghost_owner ARE.
  const reportedKeys = plan.unresolvedReferences.map((r) => `${r.source}::${r.predicate}::${r.identifier}`).sort();
  assert.ok(reportedKeys.every((k) => !k.includes('::ada::') && !k.endsWith('::ada')),
    'ada is in the union — its first-unit references do not appear as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('memV2::author::ghost_author')),
    'raw-key memory author reported as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('memV2::scrum:owner::ghost_owner')),
    'raw-key memory owner reported as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('d1::scrum:decidedBy::ghost_decider')),
    'decision decider reported as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('sd1::scrum:declaredSeat::ghost_seat')),
    'seat declaration reported as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('claim-1::scrum:declaredSeat::ghost_claim_seat')),
    'tending claim seat reported as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('pause-1::scrum:actor::ghost_pauser')),
    'tending actor reported as unresolved');
  assert.ok(reportedKeys.some((s) => s.includes('mint-1::scrum:seatNamesWithOpenStreamsAtSend::ghost_seat')),
    'multi-valued seatNames reported as unresolved');

  // The reported `value` carries the same projection the replica would emit:
  // full http IRIs kept verbatim, otherwise PERSON_IRI_BASE + key.
  const pause = plan.unresolvedReferences.find((r) => r.source === 'pause-1');
  assert.equal(pause.value, `${PERSON_IRI_BASE}ghost_pauser`,
    'full-IRI input is reported as the same IRI the projector would emit');
  const ownerMem2 = plan.unresolvedReferences.find((r) => r.source === 'memV2' && r.predicate === 'scrum:owner');
  assert.equal(ownerMem2.value, `${PERSON_IRI_BASE}ghost_owner`,
    'raw-key input is reported as the projector would render it');

  // A canonical target is NOT reported even when named by an external
  // reference: pass ada as canonical and the same-domain reference above
  // resolves (the canonical carries it under the closed-source-derived union).
  const withCanonicalAda = planPersonRetention({
    domain, roster: ROSTER,
    canonicalPeople: [personNode({ identifier: 'ada' })],
  });
  assert.equal(
    withCanonicalAda.unresolvedReferences.find((r) => r.identifier === 'ada'), undefined,
    'ada is in the union — its first-unit references do not appear as unresolved',
  );
});

// ── 10 · Determinism and input immutability ────────────────────────────────

test('inputs are immutable from the caller side; the union is deterministic and order-independent', () => {
  const domain = legacyDomain({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
        additionalType: 'scrum:task',
        board: { assignees: ['ada', 'bex'], column: 'backlog', order: 0, labels: [] } },
    ],
  });
  const canonical = [
    personNode({ identifier: 'bex', glyph: '🅱️' }),
    personNode({ identifier: 'ada', glyph: '🅰️', aliases: ['adalovelace'] }),
  ];

  const beforeDomain = JSON.stringify(domain);
  const beforeRoster = JSON.stringify(ROSTER);
  const beforeCanonical = JSON.stringify(canonical);

  const plan = planPersonRetention({ domain, roster: ROSTER, canonicalPeople: canonical });

  assert.equal(JSON.stringify(domain), beforeDomain, 'domain input untouched');
  assert.equal(JSON.stringify(ROSTER), beforeRoster, 'roster input untouched');
  assert.equal(JSON.stringify(canonical), beforeCanonical, 'canonical input untouched');

  assert.deepEqual(
    plan.people.map((p) => p.identifier),
    ['ada', 'bex'],
    'union sorted by identifier regardless of canonical input order',
  );

  const planReversed = planPersonRetention({
    domain, roster: ROSTER, canonicalPeople: [...canonical].reverse(),
  });
  assert.deepEqual(planReversed, plan,
    'same inputs in a different order produce a byte-same plan');

  const planAgain = planPersonRetention({ domain, roster: ROSTER, canonicalPeople: canonical });
  assert.deepEqual(planAgain, plan, 're-planning is a fixed point');

  // The output is not aliased onto the canonical input: capture the plan
  // BEFORE mutating, mutate, then verify the captured snapshot is stable and
  // the next plan is unchanged.
  const capturedRetained = JSON.parse(JSON.stringify(plan.retained));
  // retained[0] is `ada` (sorted by identifier). Find the matching canonical input.
  plan.retained[0].name = 'MUTATED';
  plan.retained[0]['scrum:aliases'] = ['MUTATED'];

  // The captured snapshot taken BEFORE the mutation is what the plan returned
  // to us — it is a stable record of the planner's contract, not a live alias.
  assert.deepEqual(capturedRetained[0], personNode({ identifier: 'ada', glyph: '🅰️', aliases: ['adalovelace'] }),
    'captured-before-mutation snapshot is stable — output is not aliased to mutable inputs');

  // Verify the canonical INPUT is untouched — input name and any nested aliases.
  const adaInput = canonical.find((p) => p.identifier === 'ada');
  assert.equal(adaInput.name, 'ada',
    'canonical input name is unchanged after mutating the returned node');
  assert.deepEqual(adaInput['scrum:aliases'], ['adalovelace'],
    'canonical input nested aliases are unchanged after mutating the returned node');

  // Verify the next plan is unaffected by the mutation we just made.
  const reread = planPersonRetention({ domain, roster: ROSTER, canonicalPeople: canonical });
  assert.deepEqual(reread.retained, planAgain.retained,
    'downstream mutation of a plan field does not bleed back into the next plan');
});