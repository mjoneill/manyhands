/**
 * core/cross-search.mjs — #1485: "have we said anything about X, anywhere?"
 *
 * The lexical half of the one search across cards, posts and decisions. Cards
 * keep their dense index (core/semantic-search.mjs); posts and decisions are
 * ranked here with BM25, because embedding ~30k posts measured at ~1.1 s each
 * on this machine (the card's design, 2026-09-25) — about nine hours of
 * embedder time on a host that already stalls under load.
 *
 * ⛔ Scores are NEVER fused across surfaces. Cosine and BM25 are not on one
 * scale, and a merged rank would be a number nobody could defend. Each surface
 * ranks itself; the caller sees all three and the method each one used.
 *
 * Pure: no I/O. The server hands in the domain's messages and decisions.
 */

const STOP = new Set((
  'a an and are as at be but by did do does for from had has have i if in into is it its '
  + 'me my no not of on or our so than that the their them then there these they this to '
  + 'too us was we were what when which who why will with you your'
).split(' '));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Words, plus the tokens this room actually searches by, kept WHOLE: `#NNN`
 * card refs, uuids, hex shas, ISO dates. A dated range like `2026-09-17→09-24`
 * also yields `09-17`, because that is how a seat writes it back.
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  const uuids = s.match(UUID) || [];
  out.push(...uuids);
  const rest = uuids.length ? s.replace(UUID, ' ') : s;
  for (const m of rest.matchAll(/#\d+|[a-z0-9][a-z0-9'_-]*/g)) {
    let w = m[0].replace(/['_-]+$/, '');
    if (w.length < 2 || STOP.has(w)) continue;
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
    if (date) { out.push(w, `${date[2]}-${date[3]}`); continue; }
    out.push(w);
    // "sprint-2026" style compounds: index the parts too, so either spelling finds it.
    if (w.includes('-') && !/^[0-9a-f-]+$/.test(w)) for (const part of w.split('-')) if (part.length > 1 && !STOP.has(part)) out.push(part);
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;

// Both shapes a post arrives in: the domain's Comment and the board's legacy
// conversation (core/mapping.mjs maps one onto the other).
const textOf = (m) => (m ? (m.text ?? m.body) : null);
const idOf = (m) => m['@id'] ?? m.id;
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * BM25 by SCAN: every call reads the posts it is handed, so there is no index
 * to hold, sync or let go stale.
 *
 * ⚠️ WHY NOT AN INDEX, measured 2026-09-25 on the live board (30.5k posts):
 *   - an incremental index cost +458 MB of heap (Maps per post and per term),
 *     then +151 MB compacted to integer arrays, on a REST process that already
 *     runs ~850 MB, and ~220 ms per call just to re-sync it;
 *   - a scan costs 61–74 ms per query and 0 MB, and is current by construction.
 * So the design read's "index incrementally past a high-water mark" was the
 * right worry (don't rebuild per write) with a cheaper answer (don't hold one).
 *
 * Matching is case-insensitive SUBSTRING per query term, so `09-17` finds
 * `2026-09-17` and `retro` finds `retrospective` — but not the reverse. Length
 * normalisation is by characters, not tokens.
 */
export function scanRank(items, q, { k = 10 } = {}) {
  const terms = [...new Set(tokenize(q))];
  // Talk posts are searched like any other: a talk is room-visible by design,
  // a filter for the human's scrolling, not a wall (the owner, 2026-09-26, #1491).
  const docs = (items || []).filter((m) => typeof textOf(m) === 'string' && idOf(m));
  const N = docs.length;
  if (!terms.length || !N) return { hits: [], searched: N };
  const res = terms.map((t) => new RegExp(escape(t), 'gi'));
  const df = new Array(terms.length).fill(0);
  let totalLen = 0;
  const cand = [];
  for (const m of docs) {
    const text = textOf(m);
    totalLen += text.length;
    let tfs = null;
    for (let i = 0; i < res.length; i += 1) {
      const hits = text.match(res[i]);
      if (hits) { df[i] += 1; (tfs ||= new Array(res.length).fill(0))[i] = hits.length; }
    }
    if (tfs) cand.push([m, tfs]);
  }
  const avg = totalLen / N || 1;
  const hits = cand.map(([m, tfs]) => {
    const len = textOf(m).length;
    let s = 0;
    for (let i = 0; i < tfs.length; i += 1) {
      if (!tfs[i]) continue;
      const idf = Math.log(1 + (N - df[i] + 0.5) / (df[i] + 0.5));
      s += idf * (tfs[i] * (K1 + 1)) / (tfs[i] + K1 * (1 - B + (B * len) / avg));
    }
    return { id: idOf(m), score: Math.round(s * 100) / 100, item: m };
  })
    .sort((a, b) => b.score - a.score || (String(a.id) < String(b.id) ? -1 : 1))
    .slice(0, k);
  return { hits, searched: N };
}

/** Decisions: the same scan over their statement. */
export function rankDecisions(decisions, q, k = 10) {
  const items = (decisions || []).map((d) => ({ id: d.id, text: String(d.statement ?? ''), decision: d }));
  return scanRank(items, q, { k }).hits.map((h) => ({ id: h.id, score: h.score, decision: h.item.decision }));
}

/** A readable excerpt around the first query term, for a hit's `snippet`. */
export function snippet(text, q, width = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const terms = tokenize(q);
  const low = s.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0 || s.length <= width) return s.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? '…' : ''}${s.slice(start, start + width)}${start + width < s.length ? '…' : ''}`;
}
