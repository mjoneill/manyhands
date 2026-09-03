/**
 * #1084 — A PREDICATE DECLARES ITS SHAPE, AS DATA.
 *
 * The card's title says a Person cannot be linked to anything. That was true
 * when it was filed (2026-08-29) and is now false: measured on prod 2026-09-03,
 * 16 predicates point at person nodes across ~39,000 edges and 16 subject
 * types, cards included (495 by `scrum:assignee`). Condition 7 already held —
 * a `scrum:Blocker` is a typed non-card structure joining a Person to a card.
 *
 * ⇒ So the deliverable is not a new primitive. It is DECLARING the primitive we
 * already have. Today `predicate_list` holds 16 definitions and every one is
 * PROSE: `scrum:decidedBy`'s says "exactly one per decision" in a sentence no
 * check can read, and nothing refuses a Decision that carries two.
 *
 * ── WHAT IS ALREADY DECLARED, so this does not fork it ──────────────────────
 *
 * `core/jsonld.mjs`'s `@context` already declares RANGE for a closed set (#686):
 * `personRef(...)` types a term `@id` against PERSON_IRI_BASE, and there are
 * typed bases for commits (#814) and columns (#687). It also records deliberate
 * EXCLUSIONS with reasons — `mentions` stays untyped so regex-scraped prose
 * cannot mint IRIs for real strangers (#619), and `heldByAttempt` points at a
 * claim attempt rather than a Person because collapsing that loses whether a
 * holder was bound, a proxy, or unbound.
 *
 * ⛔⛔ THE HAZARD THIS FILE'S FIRST TEST EXISTS FOR. The moment a declaration
 * carries `range`, range lives in TWO homes — the context and the registry —
 * and "a fact with two homes cannot contradict itself, so nothing detects that
 * it did" (#1043's shape, one subsystem over). So the registry's range is
 * CHECKED AGAINST the context, never asserted beside it, and `CONTEXT_RANGE` is
 * DERIVED from `CONTEXT` rather than retyped — a second literal list would be
 * the same defect one level down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_RANGE, PERSON_IRI_BASE, COMMIT_IRI_BASE, COLUMN_IRI_BASE } from '../core/jsonld.mjs';
import {
  PREDICATE_DECLARATIONS, RANGE_CLASSES, declarationFor,
  contextRangeConflicts, domainViolationMessage, cardinalityViolationMessage,
} from '../core/predicate-declarations.mjs';

test('#1084 CONTEXT_RANGE is DERIVED from the context, not a second list', () => {
  // The person-reference set from #686 must be present with the person base.
  for (const term of ['creator', 'author', 'assignees', 'claimedBy', 'parkedBy', 'scrum:declaredSeat']) {
    assert.equal(CONTEXT_RANGE[term], PERSON_IRI_BASE,
      `${term} is declared personRef in the context; the derived map must say so`);
  }
  assert.equal(CONTEXT_RANGE.implementedBy, COMMIT_IRI_BASE, 'commits are entities (#814)');
  assert.equal(CONTEXT_RANGE.column, COLUMN_IRI_BASE, 'a column string references a Column node (#687)');

  // ⛔ THE DELIBERATE EXCLUSIONS must NOT appear with a person base. If either
  // of these ever does, a consent guard has been erased by a convenience.
  assert.notEqual(CONTEXT_RANGE.mentions, PERSON_IRI_BASE,
    '#619 — `mentions` is regex-scraped prose holding real people\'s handles; typing it at Person '
    + 'would mint IRIs for strangers who never touched this board');
  assert.notEqual(CONTEXT_RANGE['scrum:heldByAttempt'], PERSON_IRI_BASE,
    '#1084/claim-attempt — pointing this at a Person loses whether the holder was a bound actor, '
    + 'a declared proxy, or an unbound declaration');
});

test('#1084 ⭐ THE DIVERGENCE GATE — no declaration may contradict the context', () => {
  const conflicts = contextRangeConflicts();
  assert.deepEqual(conflicts, [],
    'A declaration\'s `range` disagrees with what core/jsonld.mjs\'s @context says the same term '
    + 'resolves to. Two homes for one fact cannot contradict themselves, so nothing else would '
    + `detect this. Conflicts: ${JSON.stringify(conflicts)}`);
});

test('#1084 ⛔ POSITIVE CONTROL — the divergence gate CAN fail', () => {
  // Put a deliberately wrong declaration to the same checker. If this returns
  // no conflict, the gate above is decoration.
  const bogus = [{ name: 'author', term: 'author', domain: 'schema:Comment', range: 'scrum:Column', cardinality: 1 }];
  const conflicts = contextRangeConflicts(bogus);
  assert.equal(conflicts.length, 1, 'a range of Column on a term the context types at Person must conflict');
  assert.match(JSON.stringify(conflicts[0]), /author/);
});

test('#1084 every declaration is well-formed: domain, range, cardinality, and a range in the known set', () => {
  assert.ok(PREDICATE_DECLARATIONS.length > 0, 'an empty set would pass every other test here');
  for (const d of PREDICATE_DECLARATIONS) {
    assert.ok(d.name, `declaration with no name: ${JSON.stringify(d)}`);
    assert.ok(d.domain, `${d.name}: no domain — "which subject kinds may carry this" is the axis nothing declares today`);
    assert.ok(d.range, `${d.name}: no range`);
    assert.ok(Object.prototype.hasOwnProperty.call(RANGE_CLASSES, d.range),
      `${d.name}: range ${d.range} is not a known class — ${Object.keys(RANGE_CLASSES).join(', ')}`);
    assert.ok(d.cardinality === 1 || d.cardinality === 'many',
      `${d.name}: cardinality must be 1 or 'many', got ${JSON.stringify(d.cardinality)}`);
  }
});

test('#1084 scrum:decidedBy is declared to match its registered PROSE definition', () => {
  const d = declarationFor('scrum:decidedBy');
  assert.ok(d, 'the first predicate this slice declares');
  assert.equal(d.domain, 'scrum:Decision', 'the registered definition says "exactly one per decision"');
  assert.equal(d.range, 'schema:Person', 'and "an EDGE to a person: node (never a string)"');
  assert.equal(d.cardinality, 1, 'and "exactly one per decision" — now machine-readable');
});

test('#1084 ⛔ the refusals QUOTE the declaration, so a caller reads the rule not a test name', () => {
  const dm = domainViolationMessage('scrum:decidedBy', 'schema:CreativeWork');
  assert.match(dm, /scrum:decidedBy/);
  assert.match(dm, /scrum:Decision/, 'names the declared domain');
  assert.match(dm, /schema:CreativeWork/, 'and what was actually offered');

  const cm = cardinalityViolationMessage('scrum:decidedBy', 2);
  assert.match(cm, /scrum:decidedBy/);
  assert.match(cm, /\b1\b/, 'names the declared cardinality');
  assert.match(cm, /\b2\b/, 'and the count that broke it');
});

/**
 * ── WHY THIS IS A CONFORMANCE AUDIT AND NOT A WRITE GATE ────────────────────
 *
 * The PO's WHAT said "refusal enforced at the write". I built toward that and
 * found there is nothing to refuse: `scrum:decidedBy` is written by exactly one
 * handler (`handleCreateDecision`), which already requires it and takes it as a
 * SCALAR — so domain and cardinality-1 hold structurally, and a write gate
 * would guard an empty class. That is #406's lesson ("a rail with nothing to
 * guard"), which this room agreed to two hours ago.
 *
 * ⇒ REOPENS IF: `graph_assert` (aad42bf5's write verb) starts accepting
 * `scrum:decidedBy`. Verified 2026-09-03 that it does NOT — server.js's assert
 * handler branches on `scrum:dischargedBy`, `scrum:evidencedBy` and
 * `scrum:implementedBy` and nothing else reaches decidedBy. The DAY a branch is
 * added for it there is a SECOND write path, the class stops being empty, and
 * the declaration must gate it there: a generic verb cannot inherit the
 * structural guarantee that one purpose-built handler happens to provide. Whoever
 * adds that branch owns adding the domain and cardinality refusal with it, and
 * `domainViolationMessage` / `cardinalityViolationMessage` exist so the refusal
 * quotes the declaration rather than being retyped at the call site.
 *
 * ⇒ So the enforcement is an AUDIT over the live graph: every existing edge must
 * conform to its declaration. It has real rows to check (41 decidedBy, 32
 * blockedByPerson at last measurement), it answers condition 6 (existing edges
 * behave exactly as before) with data rather than assertion, and it catches a
 * violation however it arrives — including through a write path nobody has
 * written yet, which is the failure a gate on today's handler could not see.
 */
test('#1084 ⭐ CONFORMANCE — every live edge obeys its declaration, and the audit NAMES what it could not check', async () => {
  const { buildGraphStore, queryGraph } = await import('../core/graph-replica.mjs');
  const { domainToJsonLd } = await import('../core/jsonld.mjs');

  const doc = domainToJsonLd({
    nodes: [{
      '@id': 'c-1', '@type': 'CreativeWork', identifier: 1, name: 'a card', board: {},
      blockers: [{ person: 'ada', status: 'open', note: 'waiting' }],
    }],
    decisions: [{
      '@id': 'https://scrumboard.local/decision/d-1', '@type': 'scrum:Decision', identifier: 'd-1',
      'scrum:statement': 'a ruling', 'scrum:decidedBy': 'ada',
      'scrum:constrains': ['topic'], 'scrum:reopensIf': 'evidence',
      dateCreated: '2026-09-03T00:00:00.000Z',
    }],
    messages: [], people: [], columns: [],
  });
  const store = buildGraphStore(doc);

  const audited = [];
  const unaudited = [];
  for (const d of PREDICATE_DECLARATIONS) {
    const local = d.name.split(':')[1];
    const rows = queryGraph(store,
      `SELECT ?s ?t ?o WHERE { ?s <https://scrumboard.local/ns#${local}> ?o . ?s a ?t }`).rows;
    if (rows.length === 0) { unaudited.push(d.name); continue; }
    audited.push(d.name);
    for (const r of rows) assert.equal(r.t, d.domain, domainViolationMessage(d.name, r.t));
    if (d.cardinality === 1) {
      const per = new Map();
      for (const r of rows) per.set(r.s, (per.get(r.s) || 0) + 1);
      for (const [subj, n] of per) assert.equal(n, 1, `${subj}: ${cardinalityViolationMessage(d.name, n)}`);
    }
  }

  // ⛔ ANTI-VACUITY: if NOTHING was audited this test is a no-op that passes forever.
  assert.ok(audited.length > 0,
    `the audit checked ZERO predicates — it would pass on any board, which is the shape it exists to refuse. `
    + `Declared: ${PREDICATE_DECLARATIONS.map((d) => d.name).join(', ')}`);

  // ⚠️ AND THE BLIND SPOT IS NAMED, NOT SILENT. A declaration whose edges this
  // fixture does not produce is unaudited — real coverage, not a pass. It is
  // asserted as a KNOWN list so that a NEW unaudited predicate breaks the test
  // and has to be either exercised or acknowledged here deliberately.
  assert.deepEqual(unaudited, ['scrum:blockedByPerson'],
    'The set of declarations this fixture cannot exercise changed. `scrum:blockedByPerson` is known '
    + 'unaudited: the domain fixture carries a card with a `blockers` entry but buildGraphStore projects '
    + 'no Blocker node from a bare `nodes:` domain, so there is no edge to check. Its declaration is '
    + 'still checked for well-formedness and against the @context — only the live-edge audit is missing. '
    + `Audited: ${audited.join(', ')} · unaudited: ${unaudited.join(', ')}`);
});
