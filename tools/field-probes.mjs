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
  { name: 'assignee', wellFormed: 'ada', malformed: 'both', storedAs: 'assignees',
    note: 'singular alias; normalized into assignees. `both` is the retired #508 sentinel' },
  { name: 'implementedBy', wellFormed: ['a'.repeat(40)], malformed: ['a75a247'],
    note: '#814 — full 40-char shas only; a short sha is an aliasing bug' },
  { name: 'relationships', wellFormed: { relatedTo: [] }, malformed: { relatedTo: 'nope' },
    note: '#614 — validateRelationships' },
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
  { name: 'createdBy', wellFormed: 'ada', malformed: null, noRule: true,
    note: 'REQUIRED by the MCP schema (#631) but unvalidated at the REST layer' },
  // ⛔ WAS MARKED noRule AND THAT WAS WRONG. The self-certification guard in
  // auditCreateField refuted it: a non-string parkedReason returns 400
  // "parkedReason must be a string". The bad marking had suppressed a third
  // VALIDATED_THEN_DISCARDED — the audit committing its own failure class.
  { name: 'parkedReason', wellFormed: 'because', malformed: 12345,
    with: { parkedBy: 'ada', parkedUntil: '2026-12-01T00:00:00.000Z' } },

  // ── fields found by RC0b's falsifying direction, NOT by anyone's memory ──
  { name: 'parent', wellFormed: '11111111-2222-3333-4444-555555555555', malformed: null, noRule: true,
    note: 'STORED on 7 live cards and PATCHABLE, but absent from both MCP card schemas. '
        + 'The consumed-but-undeclared mirror shape. Surfaced only by the consumer→schema direction.' },
  { name: 'attachments', wellFormed: [], malformed: null, noRule: true,
    note: 'present on 1 live card; not in either MCP card schema' },

  // ── the control: a typo, consistently absent everywhere ──
  { name: 'titel', wellFormed: 'misspelled', malformed: null, noRule: true,
    note: 'not a real field — the AGREE_ABSENT control' },
];

export const PROBED_FIELDS = new Set(CARD_CREATE_PROBES.map((p) => p.name));
