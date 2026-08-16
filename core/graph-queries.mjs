/**
 * core/graph-queries.mjs — the room's EXECUTABLE query library.
 *
 * Ruled 2026-08-15 (commons e2a80939): the authoritative library is versioned
 * code with tests; wiki pages may DOCUMENT it and must not become a second,
 * untested source of snippets. This file exists because two seats failed to
 * write a correct query cold on the same day, and the failure shape was the
 * dangerous one — SPARQL punishes inexpertise with a FALSE NEGATIVE wearing a
 * discovery's clothes: a wrong query and an absent thing both return 0 rows.
 *
 * ── THE THREE-QUERY TAX THIS RETIRES (measured, 2026-08-15 20:56Z) ─────────
 *   Q1  full-IRI PREFIX declarations        → 0 rows (store binds its own
 *       prefixes; redeclaring them differently silently matches nothing)
 *   Q2  schema:identifier 804 as a NUMBER   → 0 rows (identifiers are STRINGS)
 *   Q3  name-contains scan                  → rows, revealing Q2's datatype
 *   Q4  FILTER(?id IN ("804"))              → correct
 *
 * ── HOW TO TRUST AN ABSENCE (ruled, same thread) ───────────────────────────
 * A 0-rows answer is a finding ONLY beside a KNOWN-POSITIVE WITNESS that uses
 * the SAME predicates and datatypes as the target query. A generic liveness
 * count (740 CreativeWorks exist) proves the endpoint is alive — it does NOT
 * prove your predicates are right; that mistake was made in the same session
 * this file answers. Every query here therefore ships with a witness partner,
 * and the tests mutate the fixture to prove the absent case actually reads 0.
 */

/**
 * Count entities per @type. The coarse liveness control: proves the store is
 * populated and the query path works. ⚠️ NOT a witness for any specific
 * predicate — see the header.
 */
export const typedEntityCount = () =>
  `SELECT ?t (COUNT(?s) AS ?n) WHERE { ?s a ?t } GROUP BY ?t ORDER BY DESC(?n)`;

/**
 * Find a card by its shortId. ⚠️ identifiers are STRING literals — the number
 * form matches nothing, silently.
 */
export const cardByShortId = (shortId) =>
  `SELECT ?card ?title WHERE { ?card a schema:CreativeWork ; ` +
  `schema:identifier "${String(shortId).replace(/"/g, '')}" ; schema:name ?title }`;

/**
 * The witness partner for cardByShortId: same predicates, same datatype, any
 * card. If THIS returns rows and cardByShortId(X) returns none, "card X is
 * absent" is a measurement. If this returns none too, your predicates are
 * wrong and the absence claim is void.
 */
export const anyCardWitness = () =>
  `SELECT ?card ?id ?title WHERE { ?card a schema:CreativeWork ; ` +
  `schema:identifier ?id ; schema:name ?title } LIMIT 1`;

/** Fallback discovery when the exact key is unknown: substring on the title. */
export const cardsByNameContains = (needle) =>
  `SELECT ?card ?id ?title WHERE { ?card a schema:CreativeWork ; ` +
  `schema:identifier ?id ; schema:name ?title . ` +
  `FILTER(CONTAINS(LCASE(STR(?title)), LCASE("${String(needle).replace(/"/g, '')}"))) }`;

/**
 * Count tending entities BY TYPE — the deploy-hold instrument, typed form.
 * The string-grep form of this check was retired the day it was written: it
 * counted the room DISCUSSING tending (a monotonically rising counter of its
 * own subject matter) and read 0→1→2 across a single afternoon of talking
 * about it while the true entity count stayed 0.
 */
export const tendingEntityCount = () =>
  // ⚠️ STR(?t) yields the FULL IRI — a prefixed-form prefix test matches
  // nothing, silently (measured: read 0 with a TendingPromptVersion present).
  `SELECT (COUNT(?s) AS ?n) WHERE { ?s a ?t . FILTER(STRSTARTS(STR(?t), "https://scrumboard.local/ns#Tending")) }`;

/** Witness partner for tendingEntityCount — same type-predicate shape. */
export const anyTypedEntityWitness = () =>
  `SELECT ?s ?t WHERE { ?s a ?t } LIMIT 1`;

/** A card's outgoing coordination edges — where recorded (not narrated) coordination lives. */
export const cardEdges = (shortId) =>
  `SELECT ?p ?o WHERE { ?card a schema:CreativeWork ; ` +
  `schema:identifier "${String(shortId).replace(/"/g, '')}" ; ?p ?o . ` +
  `FILTER(?p IN (scrum:blockedBy, scrum:relatedTo, scrum:derivedFrom, scrum:supersedes)) }`;

/**
 * cardEdges with targets resolved to shortIds — via OPTIONAL, so a DANGLING
 * edge appears as a row with ?tid UNBOUND instead of vanishing.
 *
 * ⚠️ The first cut used an inner join and was called "strictly better"
 * evidence. Review correction (commons 387248ca): the inner join silently
 * DROPS dangling edges — the absence trap in a new coat. It was conclusive
 * that day only because the expected edge set was enumerated beforehand and
 * every row matched. The library's job is to EXPOSE broken edges, not erase
 * them: a resolved row proves edge+target; an unbound-?tid row IS the
 * finding.
 */
export const cardEdgesResolved = (shortId) =>
  `SELECT ?p ?o ?tid WHERE { ?card a schema:CreativeWork ; ` +
  `schema:identifier "${String(shortId).replace(/"/g, '')}" ; ?p ?o . ` +
  `OPTIONAL { ?o schema:identifier ?tid } ` +
  `FILTER(?p IN (scrum:blockedBy, scrum:relatedTo, scrum:derivedFrom, scrum:supersedes)) }`;
