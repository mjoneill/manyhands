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
