/**
 * core/predicate-declarations.mjs — #1084: a predicate declares its SHAPE, as data.
 *
 * `predicate_register` (#945) records what a term MEANS, in prose, and the
 * prose is good: `scrum:decidedBy`'s definition says "exactly one per decision"
 * and "an EDGE to a person: node (never a string)". But no check can read a
 * sentence, so a Decision carrying two `decidedBy` edges — or a CARD carrying
 * one — is accepted today, contradicting its own registered definition.
 *
 * ⇒ This is the machine-readable half: domain, range, cardinality, inverse,
 * declared as data, enforced at the write, with refusals that quote the
 * declaration so a caller reads the rule rather than a test name.
 *
 * ── WHAT THE CARD GOT WRONG, kept visible ───────────────────────────────────
 *
 * #1084's title says "a Person cannot be linked to anything, and every non-card
 * node is an island". Measured on prod 2026-09-03: 16 predicates point at
 * person nodes across ~39,000 edges and 16 subject types, cards included (495
 * by `scrum:assignee`, 452 by `schema:creator`). The card predates #1118 and
 * #1147. Its condition 7 — a real Person joined to a card through a typed
 * non-card structure — already held via `scrum:Blocker`. **The premise was
 * stale; the deliverable was not.**
 *
 * ── THE HAZARD THIS MODULE IS BUILT AROUND ──────────────────────────────────
 *
 * ⛔⛔ RANGE ALREADY HAS A HOME. `core/jsonld.mjs`'s `@context` types a closed
 * set of terms `@id` against an IRI base (#686 person set, #814 commits, #687
 * columns) — a range declaration in all but name. Declaring range again here
 * puts one fact in two places, and a fact with two homes cannot contradict
 * itself, so nothing would detect that it had (#1043's shape).
 *
 * ⇒ So `range` here is CHECKED AGAINST `CONTEXT_RANGE`, which is itself
 * DERIVED from the context rather than retyped. `contextRangeConflicts()` is
 * the gate, it runs in the server suite, and it has a positive control proving
 * it can fail.
 *
 * ⚠️ The context's two deliberate EXCLUSIONS are load-bearing and must survive:
 * `mentions` stays untyped so regex-scraped prose cannot mint IRIs for real
 * strangers who never touched this board (#619's consent guard at the
 * vocabulary level), and `scrum:heldByAttempt` points at the winning claim
 * attempt rather than a Person, because collapsing that loses whether a holder
 * was a bound actor, a declared proxy, or an unbound declaration.
 */

import { CONTEXT_RANGE, PERSON_IRI_BASE, COMMIT_IRI_BASE, COLUMN_IRI_BASE } from './jsonld.mjs';

/**
 * The classes a declared `range` may name, mapped to the IRI base the
 * `@context` uses for them. `null` means the class is real but the context
 * mints no namespace for it — a card's `@id` is an in-document identifier
 * (#685), so card-ranged edges have no base.
 */
export const RANGE_CLASSES = Object.freeze({
  'schema:Person': PERSON_IRI_BASE,
  'scrum:Commit': COMMIT_IRI_BASE,
  'scrum:Column': COLUMN_IRI_BASE,
  'schema:CreativeWork': null,
});

/**
 * Declared shapes. `term` is the key the `@context` uses, which is NOT always
 * the prefixed predicate name — the context keys the person set by its bare
 * JSON field (`author`, `assignees`) because that is what the document carries.
 * A declaration whose term the context does not mention is still legal: it
 * simply has no second home to contradict.
 *
 * ⚠️ Deliberately small. The mechanism is the deliverable; the second entry is
 * what proves it generalises, and nine conditions were never this week.
 */
export const PREDICATE_DECLARATIONS = Object.freeze([
  {
    name: 'scrum:decidedBy',
    term: 'scrum:decidedBy',
    domain: 'scrum:Decision',
    range: 'schema:Person',
    cardinality: 1,
    inverse: null,
    why: 'The person who stands behind a ruling (#1147). Exactly one per decision — a ruling with no '
      + 'decider cannot be weighed by whoever inherits it, and two would make "whose ruling is this" '
      + 'unanswerable. Declared, not authenticated.',
  },
  {
    name: 'scrum:blockedByPerson',
    term: 'scrum:blockedByPerson',
    domain: 'scrum:Blocker',
    range: 'schema:Person',
    cardinality: 1,
    inverse: null,
    why: 'The person whose own pending action IS the block (#965). One per blocker node, which is what '
      + 'makes a blocker-per-entry projection (#1043) the right shape: two people blocking one card are '
      + 'two blockers, not one blocker with two people. The SECOND declaration, present to prove the '
      + 'mechanism generalises past the predicate it was designed on.',
  },
]);

/** The declaration for a predicate name, or null. */
export function declarationFor(name) {
  return PREDICATE_DECLARATIONS.find((d) => d.name === name) || null;
}

/**
 * ⭐ THE DIVERGENCE GATE. Every declaration whose `term` the `@context` also
 * types must agree with it. Returns one entry per conflict, empty when clean.
 *
 * Takes the set as an argument so a positive control can put a deliberately
 * wrong declaration to the same code — a gate that has never been shown to
 * fail is a gate nobody has tested.
 */
export function contextRangeConflicts(declarations = PREDICATE_DECLARATIONS) {
  const out = [];
  for (const d of declarations) {
    const contextBase = CONTEXT_RANGE[d.term];
    // Absent from the context ⇒ no second home ⇒ nothing to contradict.
    if (contextBase === undefined) continue;
    const declaredBase = RANGE_CLASSES[d.range];
    if (declaredBase === undefined) {
      out.push({ name: d.name, term: d.term, problem: 'range is not a known class', range: d.range });
      continue;
    }
    if (contextBase !== declaredBase) {
      out.push({
        name: d.name,
        term: d.term,
        problem: 'declared range disagrees with the @context',
        declaredRange: d.range,
        declaredBase,
        contextBase,
      });
    }
  }
  return out;
}

/** A subject of the wrong kind, refused in the declaration's own words. */
export function domainViolationMessage(name, offeredType) {
  const d = declarationFor(name);
  return `${name} is declared with domain ${d ? d.domain : '(undeclared)'}, and was asserted on a `
    + `${offeredType}. ${d ? d.why : ''}\nIf ${offeredType} should legitimately carry ${name}, widen the `
    + 'declaration in core/predicate-declarations.mjs and say why — do not bypass the check at the call site.';
}

/** More edges than the declared cardinality allows. */
export function cardinalityViolationMessage(name, count) {
  const d = declarationFor(name);
  return `${name} is declared with cardinality ${d ? d.cardinality : '(undeclared)'}, and ${count} were `
    + `asserted. ${d ? d.why : ''}\nIf this predicate should hold many, change the declared cardinality `
    + 'to \'many\' in core/predicate-declarations.mjs — the declaration is the rule, not this call.';
}
