/**
 * core/graph-neighbors.mjs — #1484: "what's near me?" as one call, no SPARQL.
 *
 * Takes a node a seat can NAME (a card shortId, a full uuid, `person:<key>`,
 * `decision:<uuid>`) and returns its edges grouped by predicate AND direction,
 * every neighbour labelled, every cut confessed.
 *
 * Pure over an oxigraph store (ADR-002 D1): no I/O, no sync. The caller hands in
 * a warm store, the same one graph_query reads.
 *
 * Decisions, recorded on #1484 at 13:00Z:
 *   - IRI objects are `edges`; literal objects are `properties` (by default only
 *     name and identifier, so a card's body is never its first "neighbour").
 *   - `prov:*` is write history, not topology: collapsed into `history` unless
 *     `includeHistory` is set.
 *   - Digits mean a CARD and nothing else. No prefix matching of any kind, so a
 *     shortId can never be mistaken for the hex prefix of a decision uuid.
 *   - `rdf:type` becomes `kinds`.
 *   - 10 members per group by default (max 100), always with `total` and
 *     `truncated`, because a result whose size equals the limit is a cut.
 */
import oxigraph from 'oxigraph';
import { IRI } from './graph-replica.mjs';

export const DEFAULT_GROUP_LIMIT = 10;
export const MAX_GROUP_LIMIT = 100;
const DECISION_BASE = 'https://scrumboard.local/decision/';   // matches projectDecision
const RDF_TYPE = IRI.rdf + 'type';
const DEFAULT_PROPERTIES = new Set([IRI.schema + 'name', IRI.schema + 'identifier']);

const nn = (v) => oxigraph.namedNode(v);
const shorten = (v) => {
  if (v.startsWith(DECISION_BASE)) return `decision:${v.slice(DECISION_BASE.length)}`;
  for (const [p, iri] of Object.entries(IRI)) if (v.startsWith(iri)) return `${p}:${v.slice(iri.length)}`;
  return v;
};
const tail = (v) => v.replace(/^.*[/#:]/, '');

function unknown(node, tried) {
  return Object.assign(
    new Error(`no node answers to "${node}". Tried: ${tried.map(shorten).join(', ') || '(nothing — the id matches no accepted form)'}. `
      + 'Accepted: a card shortId (digits only), a full uuid (optionally entity:), person:<key>, decision:<full uuid>. '
      + 'No prefixes are matched.'),
    { code: 'UNKNOWN_NODE', tried: tried.map(shorten) },
  );
}

const mentioned = (store, iri) =>
  store.match(nn(iri), null, null).length > 0 || store.match(null, null, nn(iri)).length > 0;

/** The node-id grammar #1485 emits verbatim. Returns the node IRI or throws UNKNOWN_NODE. */
export function resolveNode(store, node) {
  const raw = String(node ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const hits = store.match(null, nn(IRI.schema + 'identifier'), oxigraph.literal(raw))
      .map((q) => q.subject.value)
      .filter((s) => store.match(nn(s), nn(RDF_TYPE), nn(IRI.schema + 'CreativeWork')).length > 0);
    if (hits.length === 1) return hits[0];
    throw unknown(raw, [`card #${raw}`]);
  }
  const tried = [];
  const m = /^(person|decision|entity):(.+)$/.exec(raw);
  if (m) {
    const iri = (m[1] === 'decision' ? DECISION_BASE : IRI[m[1]]) + m[2];
    tried.push(iri);
    if (mentioned(store, iri)) return iri;
    throw unknown(raw, tried);
  }
  if (/^[\w-]+$/.test(raw) && !/^\d+$/.test(raw)) {
    for (const base of [IRI.entity, DECISION_BASE]) {
      tried.push(base + raw);
      if (mentioned(store, base + raw)) return base + raw;
    }
  }
  throw unknown(raw, tried);
}

function firstLiteral(store, iri, preds) {
  for (const p of preds) {
    const q = store.match(nn(iri), nn(p), null).find((x) => x.object.termType === 'Literal');
    if (q) return q.object.value;
  }
  return null;
}

/** The label rule from #1484 decision 4. */
export function labelFor(store, iri) {
  const S = IRI.schema, SC = IRI.scrum;
  const types = store.match(nn(iri), nn(RDF_TYPE), null).map((q) => q.object.value);
  if (types.includes(S + 'CreativeWork')) {
    const id = firstLiteral(store, iri, [S + 'identifier']);
    const name = firstLiteral(store, iri, [S + 'name']) ?? '';
    return id ? `#${id} ${name}`.trim() : name || tail(iri);
  }
  if (types.includes(S + 'Comment')) {
    const author = store.match(nn(iri), nn(S + 'author'), null)[0]?.object.value;
    const text = (firstLiteral(store, iri, [S + 'text']) ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return `${author ? tail(author) : '?'}: ${text}`;
  }
  if (types.includes(S + 'Person')) {
    return firstLiteral(store, iri, [S + 'name', S + 'identifier']) ?? tail(iri);
  }
  if (types.length) {
    const key = firstLiteral(store, iri, [S + 'name', S + 'identifier', SC + 'note', SC + 'status', SC + 'statement']);
    return `${tail(types[0])}: ${key ? key.replace(/\s+/g, ' ').slice(0, 80) : tail(iri)}`;
  }
  return tail(iri);
}

/**
 * @param {object} store  a warm oxigraph store
 * @param {object} opts   { node, direction='both', predicates, limit=10, properties='default'|'all', includeHistory=false }
 */
export function graphNeighbors(store, opts = {}) {
  const { node, direction = 'both', predicates = null, properties = 'default', includeHistory = false } = opts;
  if (!['in', 'out', 'both'].includes(direction)) {
    throw Object.assign(new Error(`direction must be in|out|both, got ${JSON.stringify(direction)}`), { code: 'BAD_DIRECTION' });
  }
  const limit = Math.max(1, Math.min(MAX_GROUP_LIMIT, Number.isFinite(+opts.limit) && +opts.limit > 0 ? Math.floor(+opts.limit) : DEFAULT_GROUP_LIMIT));
  const iri = resolveNode(store, node);
  const wantPred = predicates && predicates.length ? new Set(predicates.map(String)) : null;
  const isHistory = (p) => p.startsWith(IRI.prov);

  const groups = new Map();   // `${dir} ${pred}` -> { direction, predicate, iris:Set }
  const history = { count: 0, latest: null };
  const props = {};
  const kinds = [];
  const push = (dir, pred, other) => {
    const short = shorten(pred);
    if (wantPred && !wantPred.has(short)) return;
    if (!includeHistory && isHistory(pred)) {
      history.count += 1;
      return;
    }
    const k = `${dir} ${short}`;
    if (!groups.has(k)) groups.set(k, { direction: dir, predicate: short, iris: new Set() });
    groups.get(k).iris.add(other);
  };

  if (direction !== 'in') {
    for (const q of store.match(nn(iri), null, null)) {
      const p = q.predicate.value;
      if (p === RDF_TYPE) { kinds.push(shorten(q.object.value)); continue; }
      if (q.object.termType === 'Literal') {
        if (properties === 'all' || DEFAULT_PROPERTIES.has(p)) props[shorten(p)] = q.object.value;
        continue;
      }
      push('out', p, q.object.value);
    }
  }
  if (direction !== 'out') {
    for (const q of store.match(null, null, nn(iri))) push('in', q.predicate.value, q.subject.value);
  }
  if (!includeHistory && history.count) {
    // latest = the history-bearing neighbour with the greatest prov:atTime / dateCreated literal
    let best = null;
    for (const q of store.match(null, null, nn(iri))) {
      if (!isHistory(q.predicate.value)) continue;
      const t = firstLiteral(store, q.subject.value, [IRI.prov + 'startedAtTime', IRI.prov + 'endedAtTime', IRI.schema + 'dateCreated']);
      if (t && (!best || t > best.at)) best = { node: shorten(q.subject.value), at: t };
    }
    history.latest = best;
  }

  const edges = [...groups.values()]
    .map((g) => {
      // Sorted by id so a truncated group shows the SAME first members every
      // call (store iteration order is not a contract), and only the members
      // SHOWN are labelled: labelling all 277 of an apex's children to show 10
      // cost 940 ms on the live board.
      const all = [...g.iris].sort();
      const members = all.slice(0, limit).map((o) => ({ id: shorten(o), label: labelFor(store, o) }));
      return { direction: g.direction, predicate: g.predicate, total: all.length, truncated: all.length > limit, members };
    })
    .sort((a, b) => (a.direction === b.direction ? b.total - a.total : a.direction === 'out' ? -1 : 1));

  return {
    node: { id: shorten(iri), label: labelFor(store, iri) },
    exists: true,
    kinds,
    properties: props,
    edges,
    ...(includeHistory ? {} : { history }),
    limitPerGroup: limit,
  };
}
