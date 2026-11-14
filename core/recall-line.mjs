/**
 * #1689 — ambient recall, the browser side. A room post that touches something the room has read may carry
 * `recall: { items: [...] }` (at most two) or `recall: { unavailable: reason }`. This module turns that field into
 * ONE quiet aside under the post, and holds the small rules the Reading page shares with it.
 *
 * Browser-safe ESM with no node imports, like core/render.mjs: the pure helpers are tested under node, and the DOM
 * builder takes the document it should build in, so importing this file never touches `document`.
 *
 * Every string inside `recall` came from a web page through a model. It is untrusted: it is only ever set with
 * textContent, and the one href this module builds is rebuilt from the run id a strict pattern matched. A source's
 * own url is never made a link here (the reading page decides that, with its own check).
 */

/** A run id: `run-` and a lowercase uuid. Mirrors isRunId in core/knowledge-reading.mjs, which this file cannot import. */
export const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The one address a recall item may link to: the reading page of one run, and nothing after it.
const READING_PAGE_RE = /^\/reading\.html\?run=(run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The run id inside a well-formed readingPage, or null. */
export function runOfReadingPage(readingPage) {
  if (typeof readingPage !== 'string') return null;
  const m = READING_PAGE_RE.exec(readingPage);
  return m ? m[1] : null;
}

/**
 * The link a recall row carries: the run's reading page, marked as opened from a recall on this post, so the page can
 * report the open. Rebuilt from the matched run id, never from the raw string. null when readingPage is malformed.
 */
export function recallHref(readingPage, postId) {
  const run = runOfReadingPage(readingPage);
  if (!run) return null;
  const post = typeof postId === 'string' || typeof postId === 'number' ? String(postId) : '';
  return '/reading.html?run=' + run + '&from=recall' + (post ? '&post=' + encodeURIComponent(post) : '');
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The items a post's recall shows in the room: at most two, each with something to say. `unavailable` shows nothing
 * here (an outage must not litter every post; the Reading tab says it instead), and so does anything malformed.
 */
export function recallItems(post) {
  const r = post && post.recall;
  if (!r || typeof r !== 'object' || r.unavailable != null || !Array.isArray(r.items)) return [];
  return r.items
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      const source = it.source && typeof it.source === 'object' ? it.source : {};
      const why = it.why && typeof it.why === 'object' ? it.why : {};
      return { title: str(source.title), readingPage: it.readingPage, readAt: it.readAt, gist: str(why.gist), quote: str(why.quote) };
    })
    .filter((it) => it.title || it.gist || it.quote)
    .slice(0, 2);
}

/** "Nov 14" for the day a source was read, in the reader's locale; null for a missing or broken date. */
export function recallDateLabel(iso, locale) {
  const t = Date.parse(typeof iso === 'string' ? iso : '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * The aside under a post, or null when the post carries nothing to show (so a post without recall gets no node at
 * all and keeps today's DOM). One row per item: the head line, the matching sentence, then the source's own words.
 * The row is one link when its readingPage is well formed, otherwise plain text.
 */
export function recallBlock(doc, post) {
  const items = recallItems(post);
  if (!items.length) return null;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const box = el('aside', 'cv-recall');
  box.setAttribute('aria-label', items.length === 1 ? 'Something the room has read that touches this post' : 'Things the room has read that touch this post');
  for (const it of items) {
    const href = recallHref(it.readingPage, post.id);
    const row = el(href ? 'a' : 'div', 'cv-recall-item');
    if (href) row.href = href;
    const head = el('span', 'cv-recall-head');
    head.append(el('span', 'cv-recall-mark', '📚 the room has read · '));
    head.append(el('cite', 'cv-recall-title', it.title || 'a source with no title'));
    const day = recallDateLabel(it.readAt);
    if (day) head.append(el('span', 'cv-recall-date', ` (${day})`));
    row.append(head);
    if (it.gist) row.append(el('span', 'cv-recall-gist', it.gist));
    if (it.quote) {
      const q = el('span', 'cv-recall-quote', it.quote);
      // The quote is clamped to one line here; the whole of it is on the reading page, and in the tooltip.
      q.title = it.quote;
      row.append(q);
    }
    box.append(row);
  }
  return box;
}
