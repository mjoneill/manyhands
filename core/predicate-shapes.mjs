/**
 * #1244 — WHAT SHAPE IS A PREDICATE'S OBJECT, ANSWERED FROM THE DATA.
 *
 * The predicate registry says what a predicate MEANS. It has never said what
 * shape its object takes, and that is the fact that actually costs hops: a
 * colleague asked which cards sit in a column used the RIGHT predicate
 * (`scrum:column`) with a literal where the graph holds an IRI
 * (`column:backlog`), got a clean zero, and could not tell that apart from
 * "no such cards exist". A seat holding all 23 definitions would have failed
 * identically — measured, not assumed.
 *
 * ⛔ THE SHAPE IS NOT WRITTEN DOWN, IT IS SAMPLED. An annotated registry is 23
 * chances to be wrong and goes stale the first time a projection changes. This
 * reads the live store, so it cannot disagree with the data: it IS the data.
 *
 * ⭐ AND THE ENGINE CLASSIFIES, NOT A REGEX. `isIRI()` is asked inside SPARQL
 * because string inspection cannot tell an IRI from a literal that contains a
 * colon — "2026-09-06T09:00:07.001Z" and "column:backlog" are indistinguishable
 * to a heuristic and trivially different to the store.
 */

/**
 * One grouped query for every predicate at once: how many objects, how many of
 * them are IRIs, and one sample. Counting BOTH is what makes `mixed` sayable —
 * a majority vote would report a confident wrong shape, which is worse than
 * saying the shape varies.
 */
export const SHAPE_QUERY =
  'SELECT ?p (COUNT(?o) AS ?n) (SUM(IF(isIRI(?o),1,0)) AS ?iris) (SAMPLE(?o) AS ?obj) '
  + 'WHERE { ?s ?p ?o } GROUP BY ?p';

/**
 * `none` is NOT "literal". A predicate that is registered and never used has no
 * shape to report, and reporting one would be inventing a fact about data that
 * does not exist — the failure this whole card is about, one layer up.
 */
export function shapeOf({ n, iris } = {}) {
  const total = Number(n);
  const iriCount = Number(iris);
  if (!Number.isFinite(total) || total <= 0) return 'none';
  if (!Number.isFinite(iriCount)) return 'unknown';
  if (iriCount === total) return 'iri';
  if (iriCount === 0) return 'literal';
  return 'mixed';
}

/** The prefix a seat must actually type. Only meaningful for an IRI. */
export function prefixOf(sample, shape) {
  if (shape !== 'iri' || typeof sample !== 'string') return null;
  const i = sample.indexOf(':');
  return i > 0 ? sample.slice(0, i) : null;
}

/**
 * Join the registry (what it MEANS) to the sample (what shape it TAKES).
 * A registered predicate with no rows still appears, carrying `none` — absence
 * is an answer here and must not look like omission.
 */
export function withObjectShapes(registry = [], sampleRows = []) {
  const byPredicate = new Map();
  for (const r of sampleRows) {
    const name = r?.p;
    if (typeof name === 'string') byPredicate.set(name, r);
  }
  return registry.map((entry) => {
    const row = byPredicate.get(entry?.name);
    const shape = shapeOf(row ?? {});
    const sample = row?.obj ?? null;
    return {
      ...entry,
      objectShape: {
        shape,
        prefix: prefixOf(sample, shape),
        sample: shape === 'none' ? null : sample,
        observed: shape === 'none' ? 0 : Number(row?.n ?? 0),
        means: shape === 'mixed'
          ? 'objects of BOTH kinds occur for this predicate — check before filtering'
          : shape === 'none'
            ? 'registered but never used: no shape to report, which is not the same as a literal'
            : shape === 'iri'
              ? 'the object is an IRI: filter against the prefixed form, never a quoted string'
              : 'the object is a literal: filter against a quoted string',
      },
    };
  });
}
