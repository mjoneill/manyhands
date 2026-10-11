/**
 * core/graph-neighbors.mjs — #1484: "what's near me?" as one call, no SPARQL.
 *
 * Takes a node a seat can NAME (a card shortId, a full uuid, `person:<key>`,
 * `decision:<uuid>`) and returns its edges grouped by predicate AND direction,
 * every neighbour labelled, every cut confessed.
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
 *
 * #1642 — ONE algorithm, TWO stores. The computation is a generator that YIELDS the reads it needs (a card by its
 * identifier, does a node exist, a node's out-edges, its in-edges, the label facts of a set of nodes) and a driver
 * answers them: `graphNeighbors(store, opts)` answers from a warm in-process oxigraph store, synchronously, exactly as
 * before; `graphNeighborsFromExecutor(url, opts)` answers the same reads with a handful of SPARQL queries against the
 * executor's PUBLIC dataset (bookkeeping is not reachable there, #1638). Because both legs run the same code over the
 * same facts, a difference between them is a difference in the DATA, never in the rules.
 *
 * Ordering (PO ruling on #1642, 2026-10-10): groups are out before in; within a direction by total DESCENDING, ties by
 * the compact predicate name ASCENDING; `kinds` sorted lexically. Members within a group are sorted by id.
 */
import oxigraph from 'oxigraph';
import { IRI } from './graph-replica.mjs';

export const DEFAULT_GROUP_LIMIT = 10;
export const MAX_GROUP_LIMIT = 100;
const DECISION_BASE = 'https://scrumboard.local/decision/';   // matches projectDecision
const RDF_TYPE = IRI.rdf + 'type';
const DEFAULT_PROPERTIES = new Set([IRI.schema + 'name', IRI.schema + 'identifier']);
const S = IRI.schema, SC = IRI.scrum;
const HISTORY_TIMES = [IRI.prov + 'startedAtTime', IRI.prov + 'endedAtTime', S + 'dateCreated'];
/** Every predicate a label is read from: one `facts` read fetches all of them for a set of nodes (the SHOWN members only). */
const FACT_PREDICATES = [RDF_TYPE, S + 'identifier', S + 'name', S + 'author', S + 'text', SC + 'note', SC + 'status', SC + 'statement'];

const nn = (v) => oxigraph.namedNode(v);
const shorten = (v) => {
  if (v.startsWith(DECISION_BASE)) return `decision:${v.slice(DECISION_BASE.length)}`;
  for (const [p, iri] of Object.entries(IRI)) if (v.startsWith(iri)) return `${p}:${v.slice(iri.length)}`;
  return v;
};
const tail = (v) => v.replace(/^.*[/#:]/, '');
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function unknown(node, tried) {
  return Object.assign(
    new Error(`no node answers to "${node}". Tried: ${tried.map(shorten).join(', ') || '(nothing — the id matches no accepted form)'}. `
      + 'Accepted: a card shortId (digits only), a full uuid (optionally entity:), person:<key>, decision:<full uuid>. '
      + 'No prefixes are matched.'),
    { code: 'UNKNOWN_NODE', tried: tried.map(shorten) },
  );
}

// ---------- the reads, as requests a driver answers ----------
// { op: 'cards', id }       -> [iri]   subjects typed schema:CreativeWork with schema:identifier "<id>"
// { op: 'exists', iri }     -> bool    the iri is the subject or the object of any triple
// { op: 'out', iri }        -> [{ p, o, t }]   t: 'NamedNode' | 'BlankNode' | 'Literal'
// { op: 'in', iri }         -> [{ s, p }]
// { op: 'facts', iris }     -> Map(iri -> Map(pred -> [{ v, t }]))   FACT_PREDICATES only
// { op: 'historyTimes', iri } -> Map(s -> Map(pred -> [{ v, t }]))   HISTORY_TIMES of every subject with a prov:* edge INTO iri
//   (#1642 apex: a seat has ~13k of these; they must cost ONE read, never a facts batch per 200, and never the label predicates)

function* resolveNodeG(node) {
  const raw = String(node ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const hits = yield { op: 'cards', id: raw };
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw Object.assign(
        new Error(`card #${raw} is AMBIGUOUS: ${hits.length} cards carry that identifier (${hits.map(shorten).join(', ')}). Ask by full uuid.`),
        { code: 'AMBIGUOUS_NODE', candidates: hits.map(shorten) },
      );
    }
    throw unknown(raw, [`card #${raw}`]);
  }
  const tried = [];
  const m = /^(person|decision|entity):(.+)$/.exec(raw);
  if (m) {
    const iri = (m[1] === 'decision' ? DECISION_BASE : IRI[m[1]]) + m[2];
    tried.push(iri);
    if (yield { op: 'exists', iri }) return iri;
    throw unknown(raw, tried);
  }
  if (/^[\w-]+$/.test(raw)) {
    for (const base of [IRI.entity, DECISION_BASE]) {
      tried.push(base + raw);
      if (yield { op: 'exists', iri: base + raw }) return base + raw;
    }
  }
  throw unknown(raw, tried);
}

const firstLiteral = (f, preds) => {
  for (const p of preds) {
    const hit = (f?.get(p) ?? []).find((x) => x.t === 'Literal');
    if (hit) return hit.v;
  }
  return null;
};

/** The label rule from #1484 decision 4, over a node's gathered facts. */
function labelFromFacts(iri, f) {
  const types = (f?.get(RDF_TYPE) ?? []).map((x) => x.v);
  if (types.includes(S + 'CreativeWork')) {
    const id = firstLiteral(f, [S + 'identifier']);
    const name = firstLiteral(f, [S + 'name']) ?? '';
    return id ? `#${id} ${name}`.trim() : name || tail(iri);
  }
  if (types.includes(S + 'Comment')) {
    const author = (f?.get(S + 'author') ?? [])[0]?.v;
    const text = (firstLiteral(f, [S + 'text']) ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return `${author ? tail(author) : '?'}: ${text}`;
  }
  if (types.includes(S + 'Person')) {
    return firstLiteral(f, [S + 'name', S + 'identifier']) ?? tail(iri);
  }
  if (types.length) {
    const key = firstLiteral(f, [S + 'name', S + 'identifier', SC + 'note', SC + 'status', SC + 'statement']);
    return `${tail(types[0])}: ${key ? key.replace(/\s+/g, ' ').slice(0, 80) : tail(iri)}`;
  }
  return tail(iri);
}

function* neighborsG(opts) {
  const { node, direction = 'both', predicates = null, properties = 'default', includeHistory = false } = opts;
  if (!['in', 'out', 'both'].includes(direction)) {
    throw Object.assign(new Error(`direction must be in|out|both, got ${JSON.stringify(direction)}`), { code: 'BAD_DIRECTION' });
  }
  const limit = Math.max(1, Math.min(MAX_GROUP_LIMIT, Number.isFinite(+opts.limit) && +opts.limit > 0 ? Math.floor(+opts.limit) : DEFAULT_GROUP_LIMIT));
  const iri = yield* resolveNodeG(node);
  const wantPred = predicates && predicates.length ? new Set(predicates.map(String)) : null;
  const isHistory = (p) => p.startsWith(IRI.prov);

  const groups = new Map();   // `${dir} ${pred}` -> { direction, predicate, iris:Set }
  const history = { count: 0, latest: null };
  const props = {};
  const kinds = [];
  const push = (dir, pred, other) => {
    const short = shorten(pred);
    if (wantPred && !wantPred.has(short)) return;
    // An explicit prov:* filter is a request to SEE those edges: honour it rather
    // than answer a named predicate with an empty edge list and a count.
    if (!includeHistory && isHistory(pred) && !(wantPred && wantPred.has(short))) {
      history.count += 1;
      return;
    }
    const k = `${dir} ${short}`;
    if (!groups.has(k)) groups.set(k, { direction: dir, predicate: short, iris: new Set() });
    groups.get(k).iris.add(other);
  };

  if (direction !== 'in') {
    for (const { p, o, t } of yield { op: 'out', iri }) {
      if (p === RDF_TYPE) { kinds.push(shorten(o)); continue; }
      if (t === 'Literal') {
        if (properties === 'all' || DEFAULT_PROPERTIES.has(p)) props[shorten(p)] = o;
        continue;
      }
      push('out', p, o);
    }
  }
  // The in-edges are read for the in-groups and, whenever history is collapsed, for the history's latest entry
  // (which the #1484 code always scanned among the in-edges, whatever the direction asked for).
  const inEdges = direction !== 'out' || !includeHistory ? yield { op: 'in', iri } : [];
  if (direction !== 'out') for (const { s, p } of inEdges) push('in', p, s);

  const historySubjects = !includeHistory && history.count
    ? [...new Set(inEdges.filter((e) => isHistory(e.p)).map((e) => e.s))]
    : [];
  const times = historySubjects.length ? yield { op: 'historyTimes', iri } : new Map();

  // Sorted by id so a truncated group shows the SAME first members every call (store iteration order is not a
  // contract), and only the members SHOWN are labelled: labelling all 277 of an apex's children to show 10 cost 940 ms.
  const cut = [...groups.values()].map((g) => {
    const all = [...g.iris].sort(byString);
    return { g, all, shown: all.slice(0, limit) };
  });
  const facts = yield { op: 'facts', iris: [...new Set([iri, ...cut.flatMap((c) => c.shown)])] };

  if (historySubjects.length) {
    // latest = the history-bearing neighbour with the greatest prov:startedAtTime / endedAtTime / dateCreated literal
    let best = null;
    for (const s of historySubjects) {
      const t = firstLiteral(times.get(s), HISTORY_TIMES);
      if (t && (!best || t > best.at)) best = { node: shorten(s), at: t };
    }
    history.latest = best;
  }

  const edges = cut
    .map(({ g, all, shown }) => ({
      direction: g.direction, predicate: g.predicate, total: all.length, truncated: all.length > limit,
      members: shown.map((o) => ({ id: shorten(o), label: labelFromFacts(o, facts.get(o)) })),
    }))
    .sort((a, b) => (a.direction !== b.direction ? (a.direction === 'out' ? -1 : 1) : (b.total - a.total) || byString(a.predicate, b.predicate)));

  return {
    node: { id: shorten(iri), label: labelFromFacts(iri, facts.get(iri)) },
    exists: true,
    kinds: kinds.sort(byString),
    properties: props,
    edges,
    ...(includeHistory ? {} : { history }),
    limitPerGroup: limit,
  };
}

// ---------- driver 1: a warm in-process oxigraph store (synchronous, as before) ----------

const termTypeOf = (term) => (term.termType === 'NamedNode' ? 'NamedNode' : term.termType === 'BlankNode' ? 'BlankNode' : 'Literal');

function storeAnswer(store, req) {
  switch (req.op) {
    case 'cards':
      return store.match(null, nn(S + 'identifier'), oxigraph.literal(req.id))
        .map((q) => q.subject.value)
        .filter((s) => store.match(nn(s), nn(RDF_TYPE), nn(S + 'CreativeWork')).length > 0);
    case 'exists':
      return store.match(nn(req.iri), null, null).length > 0 || store.match(null, null, nn(req.iri)).length > 0;
    case 'out':
      return store.match(nn(req.iri), null, null).map((q) => ({ p: q.predicate.value, o: q.object.value, t: termTypeOf(q.object) }));
    case 'in':
      return store.match(null, null, nn(req.iri)).map((q) => ({ s: q.subject.value, p: q.predicate.value }));
    case 'facts': {
      const out = new Map();
      for (const i of req.iris) {
        const f = new Map();
        for (const p of FACT_PREDICATES) {
          const vals = store.match(nn(i), nn(p), null).map((q) => ({ v: q.object.value, t: termTypeOf(q.object) }));
          if (vals.length) f.set(p, vals);
        }
        out.set(i, f);
      }
      return out;
    }
    case 'historyTimes': {
      // the #1484 cost: only the three time predicates, only for subjects whose prov:* edge points at the node
      const out = new Map();
      for (const q of store.match(null, null, nn(req.iri))) {
        if (!q.predicate.value.startsWith(IRI.prov) || out.has(q.subject.value)) continue;
        // #1484's firstLiteral: STOP at the first predicate that holds a literal (nearly always startedAtTime), so one
        // match per history subject, not three
        const f = new Map();
        for (const p of HISTORY_TIMES) {
          const vals = store.match(q.subject, nn(p), null).map((x) => ({ v: x.object.value, t: termTypeOf(x.object) }));
          if (vals.length) f.set(p, vals);
          if (vals.some((x) => x.t === 'Literal')) break;
        }
        out.set(q.subject.value, f);
      }
      return out;
    }
    default: throw new Error(`graph-neighbors: unknown read ${req.op}`);
  }
}

function runSync(gen, answer) {
  let step = gen.next();
  while (!step.done) step = gen.next(answer(step.value));
  return step.value;
}

/**
 * @param {object} store  a warm oxigraph store
 * @param {object} opts   { node, direction='both', predicates, limit=10, properties='default'|'all', includeHistory=false }
 */
export function graphNeighbors(store, opts = {}) {
  return runSync(neighborsG(opts), (req) => storeAnswer(store, req));
}

/** Kept for callers of the #1484 API: resolve a node name to its IRI against a warm store. */
export function resolveNode(store, node) {
  return runSync(resolveNodeG(node), (req) => storeAnswer(store, req));
}

/** Kept for callers of the #1484 API: one node's label against a warm store. */
export function labelFor(store, iri) {
  return labelFromFacts(iri, storeAnswer(store, { op: 'facts', iris: [iri] }).get(iri));
}

// ---------- driver 2: the executor's public dataset over HTTP ----------

/** A name that cannot be an IRI cannot be in the store: the read answers "nothing" rather than sending broken SPARQL. */
const sparqlIri = (v) => (/[\s<>"{}|^`\\]/.test(v) ? null : `<${v}>`);

async function executorRead(url, sparql, { timeoutMs, fetchImpl }) {
  let res; let raw;
  try {
    res = await fetchImpl(`${url}/query?dataset=public`, { method: 'POST', body: sparql, signal: AbortSignal.timeout(timeoutMs) });
    raw = await res.text();
  } catch (e) {
    throw Object.assign(new Error(`the executor could not be reached: ${e?.cause?.code || e?.name || e?.message}`), { code: 'GRAPH_UNAVAILABLE' });
  }
  let j = null; try { j = JSON.parse(raw); } catch { /* reported below */ }
  if (res.status !== 200 || !j) {
    throw Object.assign(new Error(`the executor did not answer: HTTP ${res.status} ${String(j?.error ?? raw).slice(0, 200)}`), { code: 'GRAPH_UNAVAILABLE' });
  }
  if (typeof j.boolean === 'boolean') return j.boolean;
  if (!Array.isArray(j?.results?.bindings)) {
    throw Object.assign(new Error('the executor answered 200 without a result set'), { code: 'GRAPH_UNAVAILABLE' });
  }
  return j.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, x]) => [k, {
    v: x.value, t: x.type === 'uri' ? 'NamedNode' : x.type === 'bnode' ? 'BlankNode' : 'Literal',
  }])));
}

async function executorAnswer(url, req, o) {
  switch (req.op) {
    case 'cards': {
      const rows = await executorRead(url, `SELECT DISTINCT ?s WHERE { ?s <${S}identifier> ${JSON.stringify(req.id)} ; <${RDF_TYPE}> <${S}CreativeWork> . }`, o);
      return rows.map((r) => r.s.v);
    }
    case 'exists': {
      const i = sparqlIri(req.iri);
      return i ? executorRead(url, `ASK { { ${i} ?p ?o } UNION { ?s ?p ${i} } }`, o) : false;
    }
    case 'out': {
      const rows = await executorRead(url, `SELECT ?p ?o WHERE { ${sparqlIri(req.iri)} ?p ?o }`, o);
      return rows.map((r) => ({ p: r.p.v, o: r.o.v, t: r.o.t }));
    }
    case 'in': {
      const rows = await executorRead(url, `SELECT ?s ?p WHERE { ?s ?p ${sparqlIri(req.iri)} }`, o);
      return rows.map((r) => ({ s: r.s.v, p: r.p.v }));
    }
    case 'facts': {
      const out = new Map(req.iris.map((i) => [i, new Map()]));
      const named = req.iris.map(sparqlIri).filter(Boolean);   // a blank node has no facts we can ask for by name
      const preds = FACT_PREDICATES.map((p) => `<${p}>`).join(' ');
      for (let k = 0; k < named.length; k += 200) {
        const rows = await executorRead(url, `SELECT ?s ?p ?o WHERE { VALUES ?s { ${named.slice(k, k + 200).join(' ')} } VALUES ?p { ${preds} } ?s ?p ?o }`, o);
        for (const r of rows) {
          const f = out.get(r.s.v); if (!f) continue;
          if (!f.has(r.p.v)) f.set(r.p.v, []);
          f.get(r.p.v).push({ v: r.o.v, t: r.o.t });
        }
      }
      return out;
    }
    case 'historyTimes': {
      // ONE read keyed on the node, however many history subjects it has
      const rows = await executorRead(url, `SELECT ?s ?q ?o WHERE { ?s ?p ${sparqlIri(req.iri)} . FILTER(STRSTARTS(STR(?p), ${JSON.stringify(IRI.prov)})) `
        + `VALUES ?q { ${HISTORY_TIMES.map((p) => `<${p}>`).join(' ')} } ?s ?q ?o }`, o);
      const out = new Map();
      for (const r of rows) {
        if (!out.has(r.s.v)) out.set(r.s.v, new Map());
        const f = out.get(r.s.v);
        if (!f.has(r.q.v)) f.set(r.q.v, []);
        if (!f.get(r.q.v).some((x) => x.v === r.o.v)) f.get(r.q.v).push({ v: r.o.v, t: r.o.t });   // one ?p per prov edge: dedupe repeats
      }
      return out;
    }
    default: throw new Error(`graph-neighbors: unknown read ${req.op}`);
  }
}

/**
 * #1642 — the same answer, read from the executor's public dataset. An executor that cannot answer throws
 * GRAPH_UNAVAILABLE from whichever read failed: never a 404 for a node it could not look up, never a partial 200.
 */
export async function graphNeighborsFromExecutor(executorUrl, opts = {}, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const gen = neighborsG(opts);
  let step = gen.next();
  while (!step.done) step = gen.next(await executorAnswer(executorUrl, step.value, { timeoutMs, fetchImpl }));
  return step.value;
}
