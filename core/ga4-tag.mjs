/**
 * #2004 — an instance owner's own GA4 tag, off unless they set one.
 *
 * SCRUM_GA4_MEASUREMENT_ID=G-XXXXXXXXXX makes every HTML page this server serves load Google's tag for THAT
 * property: the owner's own analytics, sent to the owner's own GA account. Unset (the default, and what a fresh clone
 * does) the pages are served exactly as before and the browser makes no request to Google at all.
 *
 * What the tag is handed, and why that is all:
 *   - page_title is the page's FIXED name ("board", "commons", "wiki"), never document.title: the board's titles
 *     carry card and talk titles (index/commons/retreat/reading set them), which are workspace content.
 *   - page_location is origin + path, with the query and hash removed: the board puts card ids, wiki node ids and
 *     search terms in the query (?card=, ?node=, ?q=).
 *   - page_referrer is empty: an in-board referrer would carry the previous page's query.
 *   - The same values are set again whenever the page changes its URL (pushState/replaceState/popstate), because
 *     GA4's enhanced measurement can send a page_view on those changes.
 * Enhanced measurement itself is configured in GA, not here; the README tells the owner which switches to turn off.
 *
 * Only humans in a browser are counted. Seats work through MCP and REST and never load a page.
 */

const ID_RE = /^G-[A-Z0-9]{4,20}$/;

/** { id, error }: id is the normalised ID or null; error says why a non-empty value was refused (never echoes it). */
export function parseGa4Id(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { id: null, error: null };
  const v = String(raw).trim().toUpperCase();
  if (!ID_RE.test(v)) {
    return { id: null, error: 'SCRUM_GA4_MEASUREMENT_ID is set but is not a GA4 measurement ID (G- followed by letters and digits); no analytics tag will be added' };
  }
  return { id: v, error: null };
}

/** The fixed name a page reports under: its file name, or "board" for the main page. Never its content. */
export function ga4PageName(urlPath) {
  const base = String(urlPath || '').split('/').pop().replace(/\.html?$/i, '');
  if (base === '' || base === 'index') return 'board';
  return /^[a-z0-9-]{1,40}$/.test(base) ? base : 'page';
}

/** The tag for one page. Throws on an unvalidated ID: an ID is code once it is inside a <script>. */
export function ga4Snippet(id, pageName) {
  if (!ID_RE.test(id || '')) throw new Error('ga4Snippet needs a validated GA4 measurement ID');
  const name = /^[a-z0-9-]{1,40}$/.test(pageName) ? pageName : 'page';
  const fixed = `{page_title: ${JSON.stringify(name)}, page_location: location.origin + location.pathname, page_referrer: ''}`;
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`
    + '<script>(function () {'
    + 'window.dataLayer = window.dataLayer || [];'
    + 'function gtag() { window.dataLayer.push(arguments); }'
    + `function fixed() { return ${fixed}; }`
    + "gtag('js', new Date());"
    + "gtag('set', fixed());"
    + `gtag('config', ${JSON.stringify(id)}, fixed());`
    + "function again() { gtag('set', fixed()); }"
    + "['pushState', 'replaceState'].forEach(function (k) { var o = history[k]; history[k] = function () { var r = o.apply(this, arguments); again(); return r; }; });"
    + "window.addEventListener('popstate', again);"
    + '})();</script>';
}
