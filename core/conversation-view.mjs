/**
 * #226 — the promotable conversation view.
 *
 * A conversation display is a *projection over messages*: scope (the floating
 * commons, or a node's thread) × scale (a side panel, or a full page). This
 * module is the single render path for that projection on every NEW surface
 * (commons.html full-page, the wiki commons panel, a wiki page's homed thread).
 * The board's own mature panel (#208/#210 pagination + attachment upload) is
 * left as-is; unifying it onto this component is a follow-up.
 *
 * Browser-safe ESM, mirroring core/render.mjs: no node imports, and `document`
 * is only touched inside mountConversationView (called from a browser), so this
 * file imports cleanly under node for the pure-helper tests.
 *
 * Security: message bodies and author names render via textContent (never
 * innerHTML) — XSS-safe by construction. Attachments reuse the server's
 * safe-serve policy (only known image mimes inline; everything else a download
 * link). This view renders attachments read-side; uploading is the board panel's
 * job for now (a follow-up brings it here).
 */

import { renderChatMarkdown } from './render.mjs';
import { identityOf, roster } from './identity.mjs';

// ── pure helpers (node-testable) ───────────────────────────────────────────

/**
 * Build the REST URL for a conversation fetch.
 * - attachedTo: a node id scopes to that thread; absent/blank ⇒ all messages
 *   (board-parity "commons" — the whole feed, homed and floating alike).
 * - since/before/limit: the #210 pagination + poll cursors, passed through.
 */
export function conversationsUrl({ baseUrl = '', attachedTo, since, before, limit } = {}) {
  const params = [];
  if (typeof attachedTo === 'string' && attachedTo) params.push('attachedTo=' + encodeURIComponent(attachedTo));
  if (typeof since === 'string' && since) params.push('since=' + encodeURIComponent(since));
  if (typeof before === 'string' && before) params.push('before=' + encodeURIComponent(before));
  if (limit != null) params.push('limit=' + encodeURIComponent(limit));
  return baseUrl + '/api/conversations' + (params.length ? '?' + params.join('&') : '');
}

/**
 * Merge incoming messages into existing: dedupe by id (existing wins on
 * collision — the poll's `since=` cursor is inclusive, so the cursor message
 * comes back), drop falsy / id-less entries, sort chronologically (newest last).
 * The spine of both initial load and incremental poll.
 */
export function mergeMessages(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const c of [...(existing || []), ...(incoming || [])]) {
    if (!c || typeof c.id !== 'string' || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return out;
}

// #291 — clickable #NNN card references. A message body is a plain string; the
// only recognized markup we add is a link on a card reference. `#NNN` is a ref
// only at a word boundary (so `abc#5` and URL fragments aren't captured) and
// only when numeric (so `#foo` stays prose). The tokenizer is intentionally
// card-list-agnostic: it recognizes the *shape*, the board resolves the target
// (an unknown id just no-ops in scrollToCardByShortId — no dead-link error).
const CARD_REF_RE = /(?<!\w)#(\d+)/g;

/**
 * Split a body string into text / ref tokens:
 *   [{ type:'text', value }, { type:'ref', shortId, raw }, …]
 * Pure + node-testable. The DOM layer turns text tokens into text-nodes and ref
 * tokens into <a> elements — never innerHTML, so HTML metacharacters in the body
 * ride through as data, XSS-safe by construction.
 */
export function tokenizeCardRefs(text) {
  const src = text == null ? '' : String(text);
  const tokens = [];
  let last = 0;
  CARD_REF_RE.lastIndex = 0;
  let m;
  while ((m = CARD_REF_RE.exec(src)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: src.slice(last, m.index) });
    tokens.push({ type: 'ref', shortId: Number(m[1]), raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push({ type: 'text', value: src.slice(last) });
  return tokens;
}

/** Board deep-link for a card reference; resolved on load by scrollToCardByShortId. */
export function cardRefHref(shortId, boardPath = 'index.html') {
  return boardPath + '?card=' + encodeURIComponent(shortId);
}

// ── safe-serve policy (mirrors index.html #113) ─────────────────────────────

const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/**
 * Who the author picker offers when the caller doesn't name them explicitly.
 *
 * DERIVED from the roster, never a literal. It used to be a hardcoded list of
 * the shipped example seats, which is a bug with an unusually good disguise:
 * every page that forgot to pass `actors` silently offered five people who do
 * not exist, and the picker then WROTE one of those names into the record as
 * the author of a real message. Not a rendering fault — manufactured history.
 *
 * It hid because the fallback used to be right. While a deployment hardcoded
 * its own seats as the default, a path that never consulted the roster looked
 * identical to one that did. A fallback that happens to be correct is
 * indistinguishable from a lookup that works, and stays that way until someone
 * configures a roster and finds strangers in their own room.
 *
 * Computed per call, not once at module load, so a roster configured after this
 * module is imported is still honoured. `wiki` is excluded: it is the app's own
 * voice, not a person, and nobody should be able to post as it.
 */
function defaultActors() {
  return roster().map((m) => m.key).filter((k) => k !== 'wiki');
}

// ── DOM component ───────────────────────────────────────────────────────────

/**
 * Mount a conversation display into `opts.mount`.
 *
 * opts:
 *   mount       (required) element to render into
 *   attachedTo  node id ⇒ that thread; omit ⇒ the commons (all messages)
 *   baseUrl     REST origin prefix (default same-origin '')
 *   actors      author <select> options (default the five known agents)
 *   author      preselected author
 *   placeholder textarea placeholder
 *   limit       initial fetch window (default 50)
 *   poll        boolean — keep the feed live (full-page scale)
 *   pollMs      poll interval (default 5000)
 *   fetchImpl   injectable fetch (tests)
 *
 * Returns { el, refresh, destroy }.
 */
export function mountConversationView(opts = {}) {
  const {
    mount,
    attachedTo,
    baseUrl = '',
    actors = defaultActors(),
    author,
    placeholder = 'Say something to the room…',
    limit = 50,
    poll = false,
    pollMs = 5000,
    fetchImpl,
    attachedPointer,   // #294 — (msg) => {label, href, preview} | null; collapse card-attached posts to a pointer
    onMessages,        // presence — called with the full message list after each load/poll (constellation feed)
    onSolo,            // presence — called with the soloed author key (or null) whenever it changes
  } = opts;
  if (!mount) throw new Error('mountConversationView: opts.mount is required');

  const doc = mount.ownerDocument || document;
  const f = fetchImpl || ((...a) => fetch(...a));

  let messages = [];
  let lastTs = null;
  let timer = null;
  let pending = [];   // #238 — uploaded-but-not-yet-sent attachments
  let query = '';     // #303-6 — client-side search filter over loaded messages
  let authorSolo = null; // presence — "listen to one mind": solo an author's voice
  let exhaustedOlder = false; // #303-6 — no more history behind the oldest loaded
  const renderedIds = new Set();

  // #303-6 — structure: <div.cv-root> <div.cv-toolbar> <div.cv-feed> <form> </div>
  const root = doc.createElement('div');
  root.className = 'cv-root';

  // Toolbar: search box + a "load older" button (only shown on a full-page,
  // paginating mount — search is always useful; load-older needs `limit`).
  const toolbar = doc.createElement('div');
  toolbar.className = 'cv-toolbar';
  const search = doc.createElement('input');
  search.className = 'cv-search';
  search.type = 'search';
  search.placeholder = 'Search the commons…';
  search.setAttribute('aria-label', 'Search the commons');
  const olderBtn = doc.createElement('button');
  olderBtn.type = 'button';
  olderBtn.className = 'cv-load-older';
  olderBtn.textContent = '↑ Load older';
  toolbar.append(search, olderBtn);

  const feed = doc.createElement('div');
  feed.className = 'cv-feed';
  feed.setAttribute('aria-live', 'polite');
  const form = buildForm();
  root.append(toolbar, feed, form);

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderAll(); });
  olderBtn.addEventListener('click', () => loadOlder());
  mount.innerHTML = '';
  mount.appendChild(root);

  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // #303-1 — message body rendered chat-minimal markdown (bold/italic/lists +
  // clickable #NNN card refs), via renderChatMarkdown. That renderer is
  // escape-FIRST (everything user-supplied is HTML-escaped before any markup is
  // added), so assigning its output with innerHTML is XSS-safe by construction —
  // the same guarantee the wiki relies on (core/render.mjs). #NNN links carry
  // href=index.html?card=NNN, which the board deep-links to on load.
  function cardBody(text) {
    // #496: `prose` is the shared running-text class (core/theme.css) — it
    // carries the 65ch measure and 1.6 leading. A message body is running text
    // wherever this view is mounted, so the measure travels with the component
    // rather than being re-declared by each host page.
    const div = el('div', 'cv-msg-body prose');
    div.innerHTML = renderChatMarkdown(text || '');
    return div;
  }

  function attachmentNode(a) {
    const url = baseUrl + '/api/attachments/' + encodeURIComponent(a.id);
    if (INLINE_IMAGE_MIMES.has(a.mime)) {
      const img = doc.createElement('img');
      img.className = 'cv-attach-img';
      img.loading = 'lazy';
      img.src = url;
      img.alt = a.name || 'image';   // property assignment — no XSS
      img.title = a.name || '';
      img.addEventListener('click', () => doc.defaultView.open(url, '_blank'));
      return img;
    }
    const link = doc.createElement('a');
    link.className = 'cv-attach-link';
    link.href = url;
    link.download = a.name || 'file';
    link.textContent = '📎 ' + (a.name || 'attachment');   // textContent — no XSS
    return link;
  }

  function messageNode(c) {
    // #294 — a card-attached post in an UNSCOPED feed renders as a compact
    // pointer to that card's thread, not a full message (keeps parallel
    // card-topics from braiding into the main room). Only when attachedPointer
    // is provided AND this message is attached to something.
    if (attachedPointer && c.attachedTo) {
      const info = attachedPointer(c);
      if (info) return pointerNode(c, info);
    }
    const msg = el('div', 'cv-msg cv-msg-lit');
    msg.dataset.id = c.id;
    // each mind carries its signature light (core/identity.mjs): the author name
    // is tinted, a colour dot leads it, and a faint left-rail marks the message.
    const who = identityOf(c.author);
    msg.style.setProperty('--mind', who.color);
    const meta = el('div', 'cv-msg-meta');
    meta.append(el('span', 'cv-msg-dot'));
    const author = el('span', 'cv-msg-author', (who.glyph ? who.glyph + ' ' : '') + (who.name || c.author || 'unknown'));
    meta.append(author);
    if (c.createdAt) {
      const ts = el('span', 'cv-msg-ts', formatTs(c.createdAt));
      ts.title = c.createdAt;
      meta.append(ts);
    }
    msg.append(meta, cardBody(c.body || ''));   // #291 — body via text-nodes + #NNN links
    if (Array.isArray(c.attachments) && c.attachments.length) {
      const wrap = el('div', 'cv-msg-attachments');
      c.attachments.forEach((a) => { if (a && typeof a.id === 'string') wrap.appendChild(attachmentNode(a)); });
      msg.appendChild(wrap);
    }
    return msg;
  }

  // #294 — one compact line: "💬 <label> — <author>: <preview> →" linking to
  // the card's thread. Built from text-nodes + one <a> (no innerHTML → XSS-safe).
  function pointerNode(c, info) {
    const row = el('div', 'cv-pointer');
    row.dataset.id = c.id;
    const link = doc.createElement('a');
    link.className = 'cv-pointer-link';
    link.href = info.href || '#';
    link.textContent = '💬 ' + (info.label || 'conversation');
    row.appendChild(link);
    const rest = ' — ' + (c.author || 'someone') + ': ' + oneLine(info.preview ?? c.body ?? '');
    row.appendChild(doc.createTextNode(rest));   // text-node — no XSS
    return row;
  }
  function oneLine(s) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > 90 ? t.slice(0, 90) + '…' : t;
  }

  function formatTs(iso) {
    // best-effort local wall-clock; raw ISO stays on the title attr (#204/#128)
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) { return iso; }
  }

  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  }

  // #303-6 — messages matching the search query (body or author). Empty query
  // matches everything.
  function visibleMessages() {
    let out = messages;
    // presence — soloing a mind filters the room to that author's voice.
    if (authorSolo) out = out.filter((c) => identityOf(c.author).key === authorSolo);
    if (query) out = out.filter((c) =>
      (typeof c.body === 'string' && c.body.toLowerCase().includes(query)) ||
      (typeof c.author === 'string' && c.author.toLowerCase().includes(query)));
    return out;
  }

  function renderAll() {
    feed.innerHTML = '';
    renderedIds.clear();
    // presence — a "listening to one mind" banner with a clear-back-to-the-room.
    if (authorSolo) {
      const who = identityOf(authorSolo);
      const banner = el('div', 'cv-solo-banner');
      banner.style.setProperty('--mind', who.color);
      banner.append(doc.createTextNode('🔦 listening to ' + (who.glyph ? who.glyph + ' ' : '') + (who.name || authorSolo)));
      const clear = el('button', 'cv-solo-clear', 'show the whole room');
      clear.type = 'button';
      clear.addEventListener('click', () => solo(null));
      banner.append(clear);
      feed.appendChild(banner);
    }
    const vis = visibleMessages();
    if (!vis.length) {
      feed.appendChild(el('div', 'cv-empty', authorSolo ? 'Nothing from them yet.' : (query ? 'No messages match your search.' : 'No messages yet. Be the first.')));
    } else {
      for (const c of vis) { feed.appendChild(messageNode(c)); renderedIds.add(c.id); }
    }
    // Stick to the newest only when unfiltered (a search/solo wants to stay put).
    if (!query && !authorSolo) feed.scrollTop = feed.scrollHeight;
    updateOlderBtn();
  }

  // presence — solo a mind's voice (null clears). Announces via onSolo so the
  // constellation can mark the active light.
  function solo(key) {
    authorSolo = key || null;
    renderAll();
    if (onSolo) try { onSolo(authorSolo); } catch (_) { /* best-effort */ }
  }

  function updateOlderBtn() {
    // Load-older only makes sense on a paginating mount (finite `limit`) and
    // while there's still history to fetch and no active search.
    const show = typeof limit === 'number' && !query && !authorSolo && !exhaustedOlder;
    olderBtn.style.display = show ? '' : 'none';
  }

  function appendNew(fresh) {
    // #303-6 — while searching, a new post must respect the filter; re-render
    // through the query path rather than blindly appending.
    if (query) { renderAll(); return; }
    const empty = feed.querySelector('.cv-empty');
    if (empty) empty.remove();
    const stick = atBottom();
    for (const c of fresh) {
      if (renderedIds.has(c.id)) continue;
      feed.appendChild(messageNode(c));
      renderedIds.add(c.id);
    }
    if (stick) feed.scrollTop = feed.scrollHeight;
  }

  // #238 — read a file as base64 (strip the data: URL prefix), mirroring the board.
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); const c = s.indexOf(','); resolve(c >= 0 ? s.slice(c + 1) : s); };
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });
  }

  // #238 — upload a file to /api/attachments and queue it as a pending attachment.
  async function uploadFile(file, chipsEl) {
    if (!file) return;
    try {
      const data = await fileToBase64(file);
      const res = await f(baseUrl + '/api/attachments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name || 'pasted', mime: file.type || 'application/octet-stream', data }),
      });
      if (!res.ok) {
        let msg = res.status; try { msg = (await res.json()).error || msg; } catch (_) { /* keep status */ }
        if (doc.defaultView) doc.defaultView.alert('Attachment rejected: ' + msg);
        return;
      }
      pending.push(await res.json());
      renderPending(chipsEl);
    } catch (e) {
      if (doc.defaultView) doc.defaultView.alert('Upload failed: ' + (e && e.message ? e.message : e));
    }
  }

  function renderPending(chipsEl) {
    chipsEl.innerHTML = '';
    pending.forEach((a, i) => {
      const chip = el('span', 'cv-attach-chip');
      chip.appendChild(el('span', '', a.name || 'file'));   // textContent — no XSS
      const rm = el('button', 'cv-attach-rm', '×'); rm.type = 'button'; rm.title = 'Remove';
      rm.addEventListener('click', () => { pending.splice(i, 1); renderPending(chipsEl); });
      chip.appendChild(rm);
      chipsEl.appendChild(chip);
    });
  }

  function buildForm() {
    const fm = doc.createElement('form');
    fm.className = 'cv-form';
    const ta = doc.createElement('textarea');
    ta.className = 'cv-input';
    ta.placeholder = placeholder;
    ta.rows = 2;
    const chips = el('div', 'cv-attach-chips');
    const row = el('div', 'cv-form-row');
    const who = doc.createElement('select');
    who.className = 'cv-who';
    for (const a of actors) {
      const o = el('option', '', a); o.value = a;
      if (a === author) o.selected = true;
      who.appendChild(o);
    }
    const fileInput = doc.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    const attachBtn = el('button', 'cv-attach-btn', '📎');
    attachBtn.type = 'button';
    attachBtn.title = 'Attach files — or paste / drop into the box';
    const send = el('button', 'cv-send', 'Post');
    send.type = 'submit';
    row.append(who, attachBtn, send);
    fm.append(ta, chips, fileInput, row);

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const fl of Array.from(fileInput.files || [])) await uploadFile(fl, chips);
      fileInput.value = '';
    });
    ta.addEventListener('paste', async (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) { if (it.kind === 'file') { const fl = it.getAsFile(); if (fl) files.push(fl); } }
      if (files.length) { e.preventDefault(); for (const fl of files) await uploadFile(fl, chips); }
    });
    fm.addEventListener('dragover', (e) => { e.preventDefault(); fm.classList.add('cv-dragover'); });
    fm.addEventListener('dragleave', () => fm.classList.remove('cv-dragover'));
    fm.addEventListener('drop', async (e) => {
      e.preventDefault();
      fm.classList.remove('cv-dragover');
      for (const fl of Array.from((e.dataTransfer && e.dataTransfer.files) || [])) await uploadFile(fl, chips);
    });
    fm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body && pending.length === 0) return;   // body OR attachment required
      const ok = await post(body, who.value, pending);
      if (ok) { ta.value = ''; pending = []; renderPending(chips); }
    });
    return fm;
  }

  async function load() {
    let data = [];
    try {
      const res = await f(conversationsUrl({ baseUrl, attachedTo, limit }));
      if (res.ok) data = await res.json();
    } catch (_) { /* offline — show the empty/post UI anyway */ }
    messages = mergeMessages([], Array.isArray(data) ? data : []);
    lastTs = newestTs() || null;
    renderAll();
    if (onMessages) try { onMessages(messages); } catch (_) { /* presence is best-effort */ }
  }

  // #303-6 — fetch a window of messages OLDER than the oldest we hold and
  // prepend them, preserving the reader's scroll position (no jump). Uses the
  // #210 `before` cursor. When a fetch returns nothing new, history is exhausted.
  async function loadOlder() {
    const oldest = oldestTs();
    if (!oldest) return;
    olderBtn.disabled = true;
    let data = [];
    try {
      const res = await f(conversationsUrl({ baseUrl, attachedTo, before: oldest, limit }));
      if (res.ok) data = await res.json();
    } catch (_) { olderBtn.disabled = false; return; }
    const known = new Set(messages.map((m) => m.id));
    const older = (Array.isArray(data) ? data : []).filter((m) => m && !known.has(m.id));
    if (!older.length) { exhaustedOlder = true; olderBtn.disabled = false; updateOlderBtn(); return; }
    const prevH = feed.scrollHeight;
    const prevTop = feed.scrollTop;
    messages = mergeMessages(messages, data);
    renderAll();
    // Keep the same message under the viewport after prepending taller content.
    feed.scrollTop = prevTop + (feed.scrollHeight - prevH);
    olderBtn.disabled = false;
  }

  async function pollOnce() {
    const url = lastTs
      ? conversationsUrl({ baseUrl, attachedTo, since: lastTs })
      : conversationsUrl({ baseUrl, attachedTo, limit });
    let data = [];
    try {
      const res = await f(url);
      if (res.ok) data = await res.json();
    } catch (_) { return; }
    if (!Array.isArray(data) || !data.length) return;
    const before = new Set(messages.map((m) => m.id));
    messages = mergeMessages(messages, data);
    const fresh = messages.filter((m) => !before.has(m.id));
    if (!fresh.length) return;
    lastTs = newestTs() || lastTs;
    appendNew(fresh);
    if (onMessages) try { onMessages(messages); } catch (_) { /* presence is best-effort */ }
  }

  async function post(body, who, attachments) {
    const payload = { body, author: who };
    if (typeof attachedTo === 'string' && attachedTo) payload.attachedTo = attachedTo;
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    try {
      const res = await f(baseUrl + '/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return false;
      await load();
      return true;
    } catch (_) { return false; }
  }

  function newestTs() {
    return messages.reduce((m, c) => (c && typeof c.createdAt === 'string' && c.createdAt > m ? c.createdAt : m), '');
  }

  // #303-6 — the oldest loaded timestamp (the `before` cursor for load-older).
  function oldestTs() {
    return messages.reduce((m, c) =>
      (c && typeof c.createdAt === 'string' && (m === '' || c.createdAt < m) ? c.createdAt : m), '');
  }

  load().then(() => {
    if (poll && doc.defaultView) timer = doc.defaultView.setInterval(pollOnce, pollMs);
  });

  return {
    el: root,
    refresh: load,
    solo,                       // presence — solo a mind's voice (key | null)
    get soloed() { return authorSolo; },
    destroy() {
      if (timer != null && doc.defaultView) doc.defaultView.clearInterval(timer);
      timer = null;
      mount.innerHTML = '';
    },
  };
}
