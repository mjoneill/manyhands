/**
 * #831 — the probe table for the three-list audit.
 *
 * One entry per caller-settable field on the card write surfaces. Each needs a
 * WELL-FORMED value and a MALFORMED one, both written by hand, because the
 * malformed value is what proves a validator has a rule for the field at all.
 *
 * ⚠️ Writing a malformed value requires knowing what the field MEANS. That is
 * the review a static list-diff skips, and it is why this table is not derived.
 *
 * ⚠️ BUT a hand-written table is blind to fields nobody thought of — so
 * tests/field-triple-coverage.test.mjs (#831 RC0b) enumerates the field
 * universe from the MCP schemas and from keys actually present on stored
 * cards, and FAILS if anything in that universe is missing here. Do not add a
 * field to the exclusion list to make that test green without a reason.
 *
 * `noRule: true` marks a field with no validation rule by design — a free-form
 * string that cannot be malformed. Such a field can never produce a 400, so
 * `accepts` is false for it and that is CORRECT, not a finding. Marking it is
 * how the audit distinguishes "no rule exists" from "a rule exists and this
 * probe failed to trip it" — two states that look identical from the wire.
 */

/** @type {Array<{name:string, wellFormed:any, malformed:any, storedAs?:string, with?:object, noRule?:boolean, note?:string}>} */
export const CARD_CREATE_PROBES = [
  // ── fields with a real validation rule ──
  { name: 'type', wellFormed: 'bug', malformed: 'not-a-type',
    note: 'CARD_TYPES enum' },
  { name: 'priority', wellFormed: 'p1', malformed: 'p9',
    note: 'CARD_PRIORITIES enum' },
  { name: 'assignees', wellFormed: ['ada'], malformed: 'not-an-array',
    note: 'must be an array of valid assignee keys' },
  { name: 'assignee', wellFormed: 'ada', malformed: 'both', storedAs: 'assignees', expectStored: ['ada'],
    note: 'singular alias; normalized into assignees. `both` is the retired #508 sentinel' },
  { name: 'implementedBy', wellFormed: ['a'.repeat(40)], malformed: ['a75a247'],
    note: '#814 — full 40-char shas only; a short sha is an aliasing bug' },
  // #801/#792 — the falsifier tripwires. The malformed case is a SELECT rather
  // than obvious junk on purpose: a SELECT is valid SPARQL and would be accepted
  // by any "is this a query" check, but it returns rows instead of a boolean, so
  // `expect` could never be compared and the check could never fail. An
  // unfailable check is the defect this field exists to prevent, so refusing it
  // is the rule most worth probing.
  { name: 'checks',
    wellFormed: [{ claim: 'nothing is typed scrum:Sasquatch', ask: 'ASK { ?x a scrum:Sasquatch }', expect: false }],
    malformed: [{ claim: 'x', ask: 'SELECT ?s WHERE { ?s ?p ?o }', expect: false }],
    note: '#792 — {claim, ask, expect}; ASK only, because a SELECT has no boolean to compare' },
  // #814 — the malformed case names a card the fixture is NOT blocked by, because
  // that is the rule worth probing: ownership must describe an edge that exists,
  // or the record drifts free of the fact it describes.
  // #814 — the malformed case is PROSE, because that is the rule: evidence must
  // be a durable reference. A sentence is exactly what this field replaces, and
  // accepting one would relocate the narration instead of modelling the fact.
  { name: 'acceptance',
    wellFormed: [{ condition: 'RC1 — the guard refuses', evidence: ['c'.repeat(40)] }],
    malformed: [{ condition: 'RC1', evidence: ['the tests passed'] }],
    note: '#814 — evidence is a 40-char sha or an entity uuid; never prose' },
  { name: 'blockers',
    wellFormed: ({ targetShortId }) => [{ card: targetShortId, owner: 'ada', status: 'open' }],
    expectStored: ({ targetShortId }) => [{ card: targetShortId, owner: 'ada', status: 'open' }],
    malformed: [{ card: 999999, owner: 'ada', status: 'open' }],
    // Ownership describes an EDGE, so the edge must travel with it — a blocker
    // for a card this one is not blocked by is exactly what the malformed case
    // probes, and the well-formed case would otherwise trip the same rule.
    with: ({ targetShortId }) => ({ relationships: { blockedBy: [targetShortId] } }),
    note: '#814 — must name a card already in blockedBy; status is open|cleared' },
  // ⚠️ `{relatedTo: []}` is IDENTICAL to the default the server writes on every
  // card, so a probe using it cannot tell "my write landed" from "the default
  // was already there" — the presence-weakness in a new hat. Needs a real edge.
  { name: 'relationships',
    wellFormed: ({ targetShortId }) => ({ relatedTo: [targetShortId] }),
    expectStored: ({ targetShortId }) => ({
      relatedTo: [targetShortId], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [],
    }),
    malformed: { relatedTo: 'nope' },
    note: '#614 — validateRelationships. Stored form is NORMALIZED to carry every '
        + 'relationship type, so expectStored spells out the normalized shape.' },
  { name: 'parkedBy', wellFormed: 'ada', malformed: 'not a valid seat key!!',
    with: { parkedUntil: '2026-12-01T00:00:00.000Z' },
    note: 'a park needs BOTH halves or the pair refuses' },
  { name: 'parkedUntil', wellFormed: '2026-12-01T00:00:00.000Z', malformed: 'not-a-timestamp',
    with: { parkedBy: 'ada' } },
  { name: 'id', wellFormed: '11111111-2222-3333-4444-555555555555', malformed: 'not-a-uuid',
    note: 'UUID_RE' },

  // ── free-form fields with no rule by design ──
  { name: 'title', wellFormed: 'a title', malformed: null, noRule: true },
  { name: 'description', wellFormed: 'body text', malformed: null, noRule: true },
  { name: 'labels', wellFormed: ['x'], malformed: null, noRule: true },
  { name: 'for', wellFormed: 'someone', malformed: null, noRule: true },
  { name: 'column', wellFormed: 'backlog', malformed: null, noRule: true,
    note: 'unvalidated at create — a nonexistent column id is accepted' },
  { name: 'order', wellFormed: 3, malformed: null, noRule: true },
  // ⚠️ VALUE MUST DIFFER FROM WHAT CREATE WRITES. The probe helper creates every
  // card with createdBy:'ada', so a probe sending 'ada' cannot tell "the write
  // stored my value" from "it was already there" — which is exactly how the
  // PATCH surface first reported a clean AGREE for a field it silently discards.
  { name: 'createdBy', wellFormed: 'grace', malformed: null, noRule: true,
    note: 'REQUIRED by the MCP schema (#631), unvalidated at REST, and IMMUTABLE on '
        + 'PATCH (#631 — authorship is a fact about the past). Refusing it on PATCH is '
        + 'correct; refusing it SILENTLY is the #823 violation.' },
  // ⛔ WAS MARKED noRule AND THAT WAS WRONG. The self-certification guard in
  // auditCreateField refuted it: a non-string parkedReason returns 400
  // "parkedReason must be a string". The bad marking had suppressed a third
  // VALIDATED_THEN_DISCARDED — the audit committing its own failure class.
  { name: 'parkedReason', wellFormed: 'because', malformed: 12345,
    with: { parkedBy: 'ada', parkedUntil: '2026-12-01T00:00:00.000Z' } },

  // ── fields found by RC0b's falsifying direction, NOT by anyone's memory ──
  // #254 — WAS `noRule: true`, and the sweep refused to let that stand the moment
  // a rule existed: "a wrong exemption SUPPRESSES findings." The old note below
  // is kept because it is the record of why this field was found at all.
  //
  // ⚠️ `malformed` is a NUMBER, not null — `parent: null` is the LEGAL way to
  // make a card a root, so probing with null would test the happy path while
  // claiming to test refusal, and the exemption would look correct forever.
  // ⛔ WAS a bare uuid naming no card, and #917 made that MALFORMED: an
  // unresolvable parent is now refused rather than stored verbatim, so the
  // probe's "well-formed" value stopped being well-formed and the sweep
  // correctly reported the field UNMEASURED rather than passing it.
  //
  // ⚠️ A probe is a claim about what a valid input looks like. When the rule
  // changes, the probe is part of what has to change — and the sweep refusing
  // to score an unmeasurable field is what made that visible in one run.
  { name: 'parent',
    wellFormed: ({ targetShortId }) => String(targetShortId),
    expectStored: ({ targetId }) => targetId,
    malformed: 42,
    note: '#254 — now declared on both MCP card schemas and consumed on both REST surfaces, '
        + 'with the cycle guard shared with /api/nodes. WAS: "STORED on 7 live cards and '
        + 'PATCHABLE, but absent from both MCP card schemas — the consumed-but-undeclared '
        + 'mirror shape, surfaced only by the consumer→schema direction."' },
  { name: 'attachments', wellFormed: [], malformed: null, noRule: true,
    note: 'present on 1 live card; not in either MCP card schema' },

  // #864 — the byte-preserving append. A VERB, not a field: it is declared on
  // the PATCH schema, consumed as an operation on the stored value, and
  // deliberately never stored under its own key. So RC0b's "declared but never
  // stored" line naming it is CORRECT and not a finding — the same shape as
  // `by`, which is meta rather than content.
  //
  // ⚠️ The malformed case is a NUMBER rather than obvious junk, because the
  // failure it guards is coercion: `String(42)` would append "42" to a long
  // card, leave every original byte intact, and never trip anything downstream.
  // A silently-successful wrong edit is the exact defect this field exists to
  // remove, so refusing the coercion is the rule most worth probing.
  { name: 'descriptionAppend', wellFormed: ' appended', malformed: 42, storedAs: 'description',
    note: '#864 — an OPERATION on description, never stored under its own key. Not combinable '
        + 'with `description`: two different edits to one field have no correct order.' },

  // #906 — the mirror of the above, and it inherits every one of its rules.
  //
  // ⚠️ Registered here because #831's RC0b caught its absence within a minute of
  // the field existing: I added a caller-settable field and the probe registry
  // failed the build before the field ever reached a card. That rail worked
  // exactly as designed, on its author's own commit, which is the argument for
  // it — a probe registry that only covered the fields someone remembered to
  // add would be measuring its own memory.
  { name: 'descriptionPrepend', wellFormed: 'prepended ', malformed: 42, storedAs: 'description',
    note: '#906 — an OPERATION on description, never stored under its own key. Not combinable '
        + 'with `description` (no correct order); IS combinable with `descriptionAppend`, '
        + 'which touches the opposite end.' },

  // #1137 — the three array UPSERT verbs. Same shape as descriptionAppend: an
  // OPERATION on the array, consumed under the lock, never stored under its own
  // key, so `storedAs` names the array it composes. On a fresh card the array
  // is empty, so the composed value IS the entry sent. Malformed cases are the
  // whole-array validators' own rules, because the upsert reuses them: prose
  // evidence, a blocker naming a card not in blockedBy, a SELECT for a check.
  // RC0b caught these three missing within one run of the verbs existing.
  { name: 'acceptanceUpsert', storedAs: 'acceptance',
    wellFormed: [{ condition: 'RC1 — the guard refuses', evidence: ['c'.repeat(40)] }],
    malformed: [{ condition: 'RC1', evidence: ['the tests passed'] }],
    note: '#1137 — insert-or-replace by `condition`; validated as `acceptance` is; PATCH only' },
  { name: 'blockersUpsert', storedAs: 'blockers',
    wellFormed: ({ targetShortId }) => [{ card: targetShortId, owner: 'ada', status: 'open' }],
    expectStored: ({ targetShortId }) => [{ card: targetShortId, owner: 'ada', status: 'open' }],
    malformed: [{ card: 999999, owner: 'ada', status: 'open' }],
    with: ({ targetShortId }) => ({ relationships: { blockedBy: [targetShortId] } }),
    note: '#1137 — insert-or-replace by target (card | person | anyHuman); validated as `blockers` is; PATCH only' },
  { name: 'checksUpsert', storedAs: 'checks',
    // ⚠️ The class in these probes is deliberately NOT the card class: the
    // publication gate reads that literal in a non-test file as a board-data
    // signature (it is what an exported board carries), and this fixture
    // tripped it for every push after it landed. Any real class proves the
    // same thing — an ASK is accepted, a SELECT is refused — so use one the
    // gate does not watch. Never spell the string a consumer greps for.
    wellFormed: [{ claim: 'C1', ask: 'ASK { ?x a scrum:Wake }', expect: true }],
    malformed: [{ claim: 'C1', ask: 'SELECT * WHERE { ?x a scrum:Wake }', expect: true }],
    note: '#1137 — insert-or-replace by `claim`; ASK only, as `checks` is; PATCH only' },

  // #1066 — the two relationship verbs. Same shape as the #1137 upserts: an
  // OPERATION on `relationships`, composed under the lock, never stored under
  // its own key, so storedAs names the field it composes and expectStored is
  // the NORMALIZED shape (every type present) exactly as the `relationships`
  // probe spells it. Malformed cases are validateRelationships' own rules,
  // because the verbs reuse it. RC0b caught both missing within one run.
  { name: 'relationshipsAdd', storedAs: 'relationships',
    wellFormed: ({ targetShortId }) => ({ relatedTo: [targetShortId] }),
    expectStored: ({ targetShortId }) => ({
      relatedTo: [targetShortId], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [],
    }),
    malformed: { relatedTo: 'nope' },
    note: '#1066 — ADD targets to the named types; everything not sent survives; PATCH only' },
  { name: 'relationshipsRemove', storedAs: 'relationships',
    // ⚠️ A remove on a fresh card stores the same bytes as an IGNORED remove
    // (the normalized empty shape), so a bare probe read CONSUMED_UNDECLARED on
    // the create surface — the expectation was satisfiable by doing nothing.
    // The companion is an ADD on a different type, so the expected stored value
    // is reachable only through the verbs: on PATCH both apply and match; on
    // create both are ignored, the shape stays empty, and the mismatch is what
    // lets the audit see the ignore. (`with: relationships` would not do —
    // the verbs refuse to travel with a replace.)
    wellFormed: ({ targetShortId }) => ({ relatedTo: [targetShortId] }),
    with: ({ targetShortId }) => ({ relationshipsAdd: { blockedBy: [targetShortId] } }),
    expectStored: ({ targetShortId }) => ({
      relatedTo: [], blockedBy: [targetShortId], supersedes: [], derivedFrom: [], supersededBy: [],
    }),
    malformed: { relatedTo: 'nope' },
    note: '#1066 — REMOVE exactly the targets named from the named types; PATCH only' },

  // #534 — the compare-and-swap PRECONDITION. Same shape as `descriptionAppend`
  // and `by`: declared on the PATCH schema, CONSUMED before any field is
  // applied, and deliberately never stored under its own key. So RC0b's
  // "declared but never stored" line naming it is CORRECT and not a finding.
  //
  // ⚠️ The malformed case is a STRING THAT LOOKS LIKE A NUMBER, and that is the
  // exact mirror of descriptionAppend's reasoning. The failure this rule guards
  // is COERCION: `Number('1')` would make `ifVersion: '1'` compare equal and the
  // precondition would appear to work — while `Number('2abc')` is NaN, which
  // !== every current version and yields a 409 that can NEVER clear, quoting
  // back the value the caller just sent. Coercion fixes the example and not the
  // class, and silently accepts `null` as 0 and `true` as 1 on the way. So the
  // rule is a REFUSAL, and `'1'` is the value most worth probing because it is
  // the one a lenient implementation would wave through.
  { name: 'ifVersion', wellFormed: 1, malformed: '1',
    note: '#534/#466 — an OPTIONAL precondition, never stored under its own key. PATCH only: '
        + 'a card being created has no version to be stale against. Non-negative integer or '
        + '400 — and a 400 rather than a 409, because 409 means "re-read and retry" and a '
        + 'client may legitimately loop on it, while a malformed request can never clear.' },

  // #1032 — a RESPONSE-SHAPE parameter, consumed by the response writer and
  // never stored under its own key. So a "declared but never stored" line
  // naming it is CORRECT and not a finding, exactly as with ifVersion.
  //
  // ⚠️ The malformed case is a PLAUSIBLE-SOUNDING SHAPE NAME, chosen for the
  // same reason ifVersion probes `'1'`: it is the value a lenient
  // implementation waves through. The failure this guards is "accepts and
  // ignores" — a caller asking for a shape we do not support is trying to spend
  // LESS, and silently handing them the full body fails at the one thing they
  // asked for while looking like success. It is unobservable from outside, so
  // the rule is a REFUSAL, and it must refuse BEFORE the write so a rejected
  // response shape is a pure no-op rather than a half-applied edit.
  { name: 'return', wellFormed: 'id', malformed: 'summary',
    note: '#1032 — OPTIONAL response shape, never stored. `"id"` returns id, shortId, '
        + 'version, updatedAt and descriptionBytes instead of the whole card; omitting it is '
        + 'unchanged, because some callers legitimately use the echoed version and changing '
        + 'the DEFAULT would break them to save tokens. Unsupported value or 400.' },

  // ── the control: a typo, consistently absent everywhere ──
  { name: 'titel', wellFormed: 'misspelled', malformed: null, noRule: true,
    note: 'not a real field — the AGREE_ABSENT control' },
];

export const PROBED_FIELDS = new Set(CARD_CREATE_PROBES.map((p) => p.name));
