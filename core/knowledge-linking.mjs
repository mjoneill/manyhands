import crypto from 'node:crypto';
/**
 * #1851 (#1848 slice 2) — which of our cards does an extracted claim bear on.
 *
 * The unit is ONE CLAIM bearing on ONE CARD, not a source on a card: slice 3 (#1852) has to hand a seat the quoted claim that
 * matters, and a source-level link cannot say which one. A source's view is its claims' links grouped.
 *
 * Every link starts PROPOSED, by machine, with its score and the query that found it. A seat confirms or dismisses it; a pair
 * that has a link in ANY status is never proposed again, so a dismissal sticks and a re-run never doubles a link.
 *
 * Nothing here calls a model: `search` is the board's own card search (POST /api/search, the dense index search_all uses),
 * injected so the rows run without an embedder. A run that could not search every claim proposes NOTHING: "no link" must
 * never be able to mean "never searched".
 */

/** The text a claim is searched by: its gist, or its verbatim span when the model gave no gist. */
export function queryOf(assertion) {
  const g = typeof assertion?.gist === 'string' ? assertion.gist.trim() : '';
  return g || String(assertion?.span ?? '').trim();
}

export const linkKey = (assertion, card) => `${assertion}|${card}`;
/**
 * The key that survives re-extraction (review 52706 point 3): every run mints fresh assertion IRIs, so a dismissal keyed only
 * by IRI comes back on a re-run. The span is verbatim source text, so the same claim re-extracted carries the same span.
 * Case and whitespace are folded; a REWORDED claim is a different key and is proposed again (the documented limit).
 */
export const spanKey = (span, card) => `span:${crypto.createHash('sha256').update(String(span ?? '').trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex')}|${card}`;

export async function proposeLinks({ assertions, search, existing = [], minScore, perAssertion } = {}) {
  if (!Array.isArray(assertions)) throw new Error('proposeLinks needs the assertions');
  if (typeof search !== 'function') throw new Error('proposeLinks needs a search function');
  if (!Number.isFinite(minScore)) throw new Error('proposeLinks needs minScore: the threshold is config, never a hidden default');
  if (!Number.isInteger(perAssertion) || perAssertion < 1) throw new Error('proposeLinks needs perAssertion >= 1');
  const have = new Set(existing);
  const proposals = [];
  let skipped = 0;
  for (const a of assertions) {
    const query = queryOf(a);
    if (!query) continue;
    const r = await search(query);
    if (!r?.ok) return { ok: false, reason: `search unavailable for ${a.iri}: ${r?.reason ?? 'no answer'}`, proposals: [], skipped: 0 };
    const hits = (r.hits ?? [])
      .filter((h) => h && h.kind !== 'source' && typeof h.id === 'string' && Number.isFinite(h.score) && h.score >= minScore)
      .sort((x, y) => y.score - x.score);
    let taken = 0;
    for (const h of hits) {
      if (taken >= perAssertion) break;
      const sk = spanKey(a.span, h.id);
      if (have.has(linkKey(a.iri, h.id)) || have.has(sk)) { skipped += 1; continue; }
      proposals.push({ assertion: a.iri, card: h.id, shortId: h.shortId ?? null, score: h.score, query, spanKey: sk });
      have.add(linkKey(a.iri, h.id)); have.add(sk);
      taken += 1;
    }
  }
  return { ok: true, proposals, skipped };
}

const ENTITY = 'https://scrumboard.local/';
/** The link's IRI, derived from its span key: the same claim re-extracted names the same node (review 52706 point 3). */
export const linkIri = (key) => `${ENTITY}link/${crypto.createHash('sha256').update(String(key)).digest('hex')}`;

/** The write for one linking run: ONE `link.propose` update carrying every proposal, guarded by the compiler. */
export function linkIntention({ proposals, minScore, model, at, actor, opId = `urn:ex:op/${crypto.randomUUID()}` } = {}) {
  return {
    kind: 'link.propose', opId, actor,
    links: (proposals ?? []).map((p) => ({ iri: linkIri(p.spanKey), assertion: p.assertion, card: `${ENTITY}entity/${p.card}`,
      score: p.score, minScore, query: p.query, spanKey: p.spanKey, model })),
    at,
  };
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RS = 'https://scrumboard.local/ns#';

/**
 * One linking run over one extraction Run: read its published claims, read EVERY existing link's span key (no status filter,
 * so a dismissed pair stays out), search, and write what is new as ONE link.propose. Nothing new ⇒ no update is sent.
 * Search or graph unavailable ⇒ ok:false and nothing written: a run that could not look never reports "no links".
 */
export async function linkRun({ graphClient, search, run, minScore, perAssertion, model, actor, at = new Date().toISOString(), dryRun = false } = {}) {
  if (!graphClient || typeof run !== 'string' || !run) throw new Error('linkRun needs a graphClient and the run IRI');
  const claims = await graphClient.query(`SELECT ?a ?span ?gist WHERE { ?a <${RDF_TYPE}> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; `
    + `<${RS}anchorText> ?span OPTIONAL { ?a <${RS}gist> ?gist } } ORDER BY ?a`);
  if (!claims.ok) return { ok: false, reason: `the run's claims could not be read: ${claims.reason}`, proposed: 0 };
  const assertions = claims.rows.map((r) => ({ iri: r.a.value, span: r.span.value, ...(r.gist ? { gist: r.gist.value } : {}) }));
  const have = await graphClient.query(`SELECT ?k WHERE { ?l <${RDF_TYPE}> <${RS}BearsOn> ; <${RS}spanKey> ?k }`);
  if (!have.ok) return { ok: false, reason: `the existing links could not be read: ${have.reason}`, proposed: 0 };
  const p = await proposeLinks({ assertions, search, existing: have.rows.map((r) => r.k.value), minScore, perAssertion });
  if (!p.ok) return { ok: false, reason: p.reason, proposed: 0 };
  if (p.proposals.length === 0) return { ok: true, assertions: assertions.length, proposed: 0, skipped: p.skipped, outcome: 'nothing-to-write' };
  if (dryRun) return { ok: true, assertions: assertions.length, proposed: p.proposals.length, skipped: p.skipped, outcome: 'dry-run', links: p.proposals };
  const m = typeof model === 'function' ? model() : model;   // the live search learns the model from its first answer
  const w = await graphClient.update(linkIntention({ proposals: p.proposals, minScore, model: m, at, actor }));
  if (w.outcome !== 'APPLIED') return { ok: false, reason: `the links were not written: ${w.outcome} ${w.reason ?? ''}`.trim(), proposed: 0 };
  return { ok: true, assertions: assertions.length, proposed: p.proposals.length, skipped: p.skipped, outcome: w.outcome, links: p.proposals };
}

/** A seat's verdict on one proposed link: ONE `link.decide`, appending a LinkDecision under the link. */
export function decideIntention({ link, verdict, workingOn = null, actor, at = new Date().toISOString(), opId = `urn:ex:op/${crypto.randomUUID()}` } = {}) {
  return {
    kind: 'link.decide', opId, actor, link, verdict, decision: `${link}/decision/${crypto.randomUUID()}`,
    workingOn: workingOn == null ? null : `${ENTITY}entity/${workingOn}`, at,
  };
}

/**
 * The live `search(q)`: the board's own POST /api/search (the dense index search_all uses). Every answer that did not search
 * EVERYTHING is refused (available:false, partial:true, a non-200, a transport error), because the linker writes nothing from
 * a refused search and "no link" must never mean "never searched". The verdict (answer/ask/abstain) is not read: the linker
 * thresholds the scores itself.
 */
export function createRestSearch({ base, token, by, k = 8, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  let model = null;
  const search = async (q) => {
    let res;
    try {
      res = await fetchImpl(`${String(base).replace(/\/$/, '')}/api/search`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ q, k, by }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { return { ok: false, reason: `search transport: ${e?.message ?? e}` }; }
    if (res.status !== 200) return { ok: false, reason: `search answered ${res.status}` };
    let j; try { j = await res.json(); } catch { return { ok: false, reason: 'search answer is not JSON' }; }
    if (j?.available !== true) return { ok: false, reason: `search unavailable: ${j?.reason ?? 'no reason given'}` };
    if (j.partial === true) return { ok: false, reason: `search was partial (${JSON.stringify(j.coverage ?? {})}): it could not search everything` };
    if (typeof j.model === 'string' && j.model) model = j.model;
    const hits = (j.results ?? []).map((r) => ({ id: r.id, shortId: r.shortId ?? null, score: r.score, kind: r.kind === 'source' ? 'source' : 'card' }));
    return { ok: true, hits };
  };
  /** The embed model the board answered with: read from its answer, never assumed (null until a search succeeded). */
  search.model = () => model;
  return search;
}
