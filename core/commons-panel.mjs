/**
 * core/commons-panel.mjs — #497. ONE way into the room, from anywhere.
 *
 * Before this, one piece of content (the commons) had three entrances:
 *   board     a header button labelled "💬 Conversations", opening a panel
 *             titled "💬 Commons" — two names for one thing, on one screen
 *   wiki      a floating bubble, bottom-right — the placement the card's own
 *             options table rejected ("reads as a customer-support widget —
 *             wrong connotation for a room of peers")
 *   settings  nothing at all
 *
 * This module owns the entrance and the panel shell on every surface. What
 * goes INSIDE the panel stays the caller's: the board has a mature panel body
 * (#208/#210 pagination, #113 attachment upload) that core/conversation-view.mjs
 * deliberately does not replace yet, so the board passes its own element and
 * its own load/poll hooks. Wiki and settings get the default body, a
 * mountConversationView. One entrance, one shell, two bodies — the residual is
 * named on the card rather than papered over.
 *
 * ── Why the icon is not 💬 ────────────────────────────────────────────────
 * The card says "icon vs label, so it can't be misread as navigation", which
 * reads as "use the 💬". But the destinations group already carries
 * "💬 Commons" as a link, in the same header row. The same glyph twice in one
 * row, meaning two different things, is the card's own problem 1 in icon form.
 * So the glyph says what the CONTROL does (opens a side panel) and the
 * accessible name says what it OPENS (Commons). A label labels; an icon
 * demonstrates; neither does double duty. Deviation recorded on #497.
 *
 * Browser-safe ESM, mirroring core/header.mjs: the pure helpers below import
 * cleanly under node, and `document` is only touched inside mount*().
 */

/** The one written-down exception: the Commons page IS the room. */
export const ENTRANCE_ABSENT_ON = 'commons';

/** localStorage key for the "what had I already seen" cursor. */
export const SEEN_KEY = 'manyhands:commons:lastSeenAt';
/**
 * #1574 R3 T2 — the badge's state when the server serves the commit-ordered feed (the conversations unit ON):
 * `{cursor, unread: [post ids]}`. A post's `createdAt` is fixed when it is RESERVED but it becomes visible when it
 * COMMITS, so a slow post can carry an older time than one the reader has already passed. Counting by time misses it;
 * counting the posts DELIVERED by the commit-ordered feed, and not yet seen, cannot. The legacy `SEEN_KEY` is kept for
 * the document path (unit OFF) and read once as the starting point of a migration.
 */
export const UNREAD_KEY = 'manyhands:commons:unread.v2';

/** Refresh cadence for the unread count while the panel is closed. Slow on
 *  purpose — this drives a badge, not a feed. The open panel polls faster
 *  through its own body. */
export const UNREAD_POLL_MS = 15000;

// ── pure helpers (node-testable) ───────────────────────────────────────────

/** Rubric 4 — present everywhere except the surface that is already the room. */
export function shouldMountEntrance(activeId) {
  return activeId !== ENTRANCE_ABSENT_ON;
}

/**
 * How many of `messages` arrived after `lastSeenAt`.
 *
 * Strictly-after, because the REST `since=` cursor is inclusive — the cursor
 * message comes back on every poll and must not be counted as new. A blank
 * cursor means "no idea what you've seen", which counts as zero rather than as
 * everything: a badge reading "248" at someone opening the board for the first
 * time is noise, not information.
 */
export function unreadSince(messages, lastSeenAt) {
  if (!lastSeenAt) return 0;
  let n = 0;
  for (const m of messages || []) {
    if (m && typeof m.createdAt === 'string' && m.createdAt > lastSeenAt) n += 1;
  }
  return n;
}

/** The newest createdAt in a batch, or `fallback` if the batch is empty. */
export function newestAt(messages, fallback = '') {
  let out = fallback;
  for (const m of messages || []) {
    if (m && typeof m.createdAt === 'string' && m.createdAt > out) out = m.createdAt;
  }
  return out;
}

/** Badge text. Past 99 the exact number stops being information. */
export function formatUnread(n) {
  return n > 99 ? '99+' : String(n);
}

// ── markup ─────────────────────────────────────────────────────────────────

/**
 * The entrance. A side-panel glyph, right-anchored past a divider, carrying
 * its state in aria-expanded and its news in a badge. Static markup — no user
 * input reaches it, so the string build is XSS-safe by definition.
 */
export function renderEntrance(panelId = 'commons-panel') {
  return (
    '<div class="commons-utility">' +
      `<button type="button" class="commons-toggle" data-commons-toggle aria-expanded="false" aria-controls="${panelId}"` +
      ' aria-label="Commons" title="Commons — see the room without leaving this page">' +
        '<svg class="commons-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
          '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
          '<path d="M9.9 2.6 v10.8" stroke="currentColor" stroke-width="1.3"/>' +
          '<path d="M11 6.2 h2.1 M11 8 h2.1 M11 9.8 h1.3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' +
        '</svg>' +
        '<span class="commons-unread" data-commons-unread hidden aria-live="polite"></span>' +
      '</button>' +
    '</div>'
  );
}

/** The panel shell. `[data-commons-mount]` is where a body goes. */
export function renderPanelShell(panelId = 'commons-panel') {
  return (
    `<aside id="${panelId}" class="commons-panel" data-commons-panel aria-label="Commons" aria-hidden="true">` +
      '<div class="commons-panel-head">' +
        '<span class="commons-panel-title" data-commons-panel-title>💬 Commons</span>' +
        '<span class="commons-panel-actions">' +
          '<a class="commons-promote" href="/commons.html" title="Open the Commons as a full page">⤢ Full page</a>' +
          '<button type="button" class="commons-panel-close" data-commons-close aria-label="Close the Commons panel">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="commons-panel-body" data-commons-mount></div>' +
    '</aside>'
  );
}

// ── mount (browser) ────────────────────────────────────────────────────────

/**
 * Mount the entrance (and, unless the caller supplies one, the panel shell).
 *
 * opts:
 *   activeId    which surface this is — 'commons' mounts nothing
 *   panel       an existing panel element to drive (the board's). Omit to have
 *               the shell created for you.
 *   head        the element the entrance is appended to (default .shell-head)
 *   onOpen(bodyEl)   called when the panel opens
 *   onClose()        called when it closes
 *   baseUrl, pollMs  overridable for tests
 *
 * Returns null when the entrance does not belong on this surface, otherwise
 * `{ open, close, toggle, refreshUnread, destroy }`.
 */
export function mountCommonsPanel(doc, opts = {}) {
  const {
    activeId,
    panel: providedPanel = null,
    head: providedHead = null,
    onOpen = null,
    onClose = null,
    baseUrl = '',
    pollMs = UNREAD_POLL_MS,
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
  } = opts;

  if (!shouldMountEntrance(activeId)) return null;

  const head = providedHead || doc.querySelector('[data-page-shell] > .shell-head') || doc.querySelector('.shell-head');
  if (!head) return null;

  let panel = providedPanel;
  if (!panel) {
    const holder = doc.createElement('div');
    holder.innerHTML = renderPanelShell();
    panel = holder.firstElementChild;
    doc.body.appendChild(panel);
  }
  const panelId = panel.id || 'commons-panel';

  const slot = doc.createElement('div');
  slot.innerHTML = renderEntrance(panelId);
  const utility = slot.firstElementChild;
  head.appendChild(utility);

  const toggleEl = utility.querySelector('[data-commons-toggle]');
  const badgeEl = utility.querySelector('[data-commons-unread]');
  const bodyEl = panel.querySelector('[data-commons-mount]') || panel;

  // ── unread bookkeeping ───────────────────────────────────────────────────
  const readCursor = () => {
    try { return (storage && storage.getItem(SEEN_KEY)) || ''; } catch { return ''; }
  };
  const writeCursor = (v) => {
    try { if (storage) storage.setItem(SEEN_KEY, v); } catch { /* private mode; badge degrades to always-fresh */ }
  };

  let latestAt = readCursor();

  function paintBadge(n) {
    if (n > 0) {
      badgeEl.textContent = formatUnread(n);
      badgeEl.removeAttribute('hidden');
      toggleEl.setAttribute('title', `Commons — ${n} new`);
    } else {
      badgeEl.textContent = '';
      badgeEl.setAttribute('hidden', '');
      toggleEl.setAttribute('title', 'Commons — see the room without leaving this page');
    }
  }

  // ── the commit-ordered badge (unit ON) ──────────────────────────────────
  // State: {cursor, unread: [post ids], known: string}. `unread` has NO cap and is matched by post IDENTITY. `known` is
  // what this reader has been delivered: line n-1 holds the EXACT id of the post at postSeq n (a UUID packed into 22
  // base64 characters, any other id verbatim), so a rebuilt store that puts a DIFFERENT post at a number already seen
  // is always told apart from the post that was seen (B7b). No fingerprint: a collision would silently mark a post seen.
  // Held in memory for the session; storage is best effort (a failing write is ignored).
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const pack = (id) => {
    const t = String(id);
    if (!UUID.test(t)) return t.includes('\n') ? JSON.stringify(t) : `=${t}`;   // '=' marks a verbatim id (never a packed one)
    const hex = t.replace(/-/g, ''); let bits = ''; for (const ch of hex) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
    bits += '0000'; let out = ''; for (let i = 0; i < bits.length; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
    return out;   // 132 bits → 22 characters, exact and reversible
  };
  const knownAt = (known, ps) => (Number.isSafeInteger(ps) && ps > 0 ? (known[ps - 1] ?? '') : '');
  const setKnown = (known, ps, id) => { if (Number.isSafeInteger(ps) && ps > 0) { while (known.length < ps) known.push(''); known[ps - 1] = pack(id); } return known; };
  let mem;   // undefined = not loaded yet; null = no state
  const readState = () => {
    if (mem !== undefined) return mem;
    try { const v = storage && storage.getItem(UNREAD_KEY); const o = v ? JSON.parse(v) : null; mem = o && typeof o.cursor === 'string' && Array.isArray(o.unread) ? { cursor: o.cursor, unread: new Set(o.unread), known: typeof o.known === 'string' && o.known ? o.known.split('\n') : [] } : null; } catch { mem = null; }
    return mem;
  };
  const writeState = (st) => {
    mem = st;
    try { if (storage) storage.setItem(UNREAD_KEY, JSON.stringify({ cursor: st.cursor, unread: [...st.unread], known: st.known.join('\n') })); } catch { /* private mode, quota: the session keeps counting */ }
  };
  const gone = (c) => c && (c.redacted === true || c.op === 'redact');   // hidden from counts (decision dd472a5f)
  const GRACE_MS = 15 * 60 * 1000;   // decision edf8f91c: the once-per-browser migration window
  /** One pass over the feed from `from`. */
  async function walk(from, onItem) {
    let tok = from;
    for (let guard = 0; guard < 100000; guard++) {
      let res, page;
      try { res = await fetch(`${baseUrl}/api/conversations?afterCommit=${encodeURIComponent(tok)}&limit=200`); page = await res.json(); } catch { return { failed: true }; }
      if (res.status === 400 && page && page.code === 'GRAPH_DISCOVERY_OFF') return { off: true };
      if (res.status === 409) return { resync: true };
      if (res.status === 503) return { failed: true };   // the feed exists but cannot be read right now: keep the badge as it is
      if (!res.ok || !page || Array.isArray(page) || !Array.isArray(page.conversations) || typeof page.nextAfterCommit !== 'string') return { off: true };
      for (const c of page.conversations) onItem(c);
      tok = page.nextAfterCommit;
      if (page.phase === 'live' && page.conversations.length === 0) return { cursor: tok };
    }
    return { failed: true };
  }
  /** true when the commit feed answered (the badge is painted from it); false when it is not served here. */
  async function refreshFromCommits() {
    let st = readState();
    if (!st) {
      // First use of the commit feed on this browser: walk it once from the start. A legacy time cursor keeps what was
      // unread then, with the owner's 15-minute grace (edf8f91c); no legacy cursor is a first visit, and counts nothing.
      const legacy = readCursor();
      const since = legacy && Number.isFinite(Date.parse(legacy)) ? new Date(Date.parse(legacy) - GRACE_MS).toISOString() : null;
      const unread = new Set(); const known = [];
      const r = await walk('start', (c) => {
        setKnown(known, c.postSeq, c.id);
        if (gone(c)) unread.delete(c.id);
        else if (since && typeof c.createdAt === 'string' && c.createdAt > since) unread.add(c.id);
      });
      if (r.off) return false;
      if (!r.cursor) return true;
      st = { cursor: r.cursor, unread, known };
    } else {
      const unread = new Set(st.unread); const known = [...st.known];
      const r = await walk(st.cursor, (c) => { setKnown(known, c.postSeq, c.id); if (gone(c)) unread.delete(c.id); else unread.add(c.id); });
      if (r.off) return false;
      if (r.resync) {
        // A NEW STORE (another incarnation): its positions mean nothing to the old cursor, so walk it from the start and
        // reconcile by identity. A post still held that was unread stays unread; one no longer held, or redacted, is
        // dropped; a post this reader was never delivered (an id the fingerprint at its number does not match) is new.
        const old = st.unread, oldKnown = st.known; const next = new Set(); const known2 = [];
        const r2 = await walk('start', (c) => {
          setKnown(known2, c.postSeq, c.id);
          if (gone(c)) { next.delete(c.id); return; }
          if (old.has(c.id) || knownAt(oldKnown, c.postSeq) !== pack(c.id)) next.add(c.id);
        });
        if (r2.off) return false;
        if (!r2.cursor) return true;
        st = { cursor: r2.cursor, unread: next, known: known2 };
      } else {
        if (!r.cursor) return true;
        st = { cursor: r.cursor, unread, known };
      }
    }
    writeState(st);
    paintBadge(st.unread.size);
    return true;
  }

  /** The time-cursor badge (the document path). Returns true when the server says it serves the commit feed instead. */
  async function refreshFromTimes() {
    const cursor = readCursor();
    const url = `${baseUrl}/api/conversations?limit=100${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}`;
    let msgs;
    try {
      const res = await fetch(url);
      if (res.headers && typeof res.headers.get === 'function' && res.headers.get('X-Commit-Feed') === '1') return true;
      if (!res.ok) return;
      msgs = await res.json();
    } catch { return; }
    if (!Array.isArray(msgs)) return;

    latestAt = newestAt(msgs, cursor);
    if (!cursor) {
      // First visit on this browser: adopt the room's current end as the
      // cursor rather than counting history as unread.
      writeCursor(latestAt);
      paintBadge(0);
      return;
    }
    paintBadge(unreadSince(msgs, cursor));
  }

  // Refreshes run ONE AT A TIME, in order: the mount, the timer and a wake can all ask at once, and two walks of the
  // same cursor would race to write it.
  // The commit feed is used once the server has SAID it serves it (the X-Commit-Feed header on the list request the badge
  // makes anyway), never by probing: a board without it would answer a probe with a 400, logged by the browser as an error.
  let commitFeed = false;
  let queue = Promise.resolve();
  function refreshUnread() {
    const run = queue.then(async () => {
      if (commitFeed || await refreshFromTimes()) {
        commitFeed = true;
        if (!(await refreshFromCommits())) { commitFeed = false; await refreshFromTimes(); }
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  function markSeen() {
    const st = readState();
    if (st) writeState({ cursor: st.cursor, unread: new Set(), known: st.known });
    if (latestAt) writeCursor(latestAt);
    paintBadge(0);
  }

  // ── geometry ─────────────────────────────────────────────────────────────
  /**
   * The panel opens BELOW the header row, not over it.
   *
   * Found by the bar, not by reasoning: a full-height panel covers the utility
   * slot, because the slot is right-anchored and the panel comes in from the
   * right. The toggle was then unreachable while open — the test's second
   * click landed on the panel's own "⤢ Full page" link and navigated away.
   * Two things break at once: a toggle you cannot toggle off, and a pressed
   * state (rubric item 3) that nothing can see. Leaving the header clear also
   * keeps the destinations usable while the room is open, which is the whole
   * point of "let me see the room while I'm somewhere else".
   *
   * Measured rather than hard-coded: the header's height depends on the nav,
   * which wraps at narrow widths. Recomputed on resize, and on scroll while
   * open — once the header has scrolled away there is nothing to clear.
   */
  function syncPanelTop() {
    const bottom = head.getBoundingClientRect().bottom;
    panel.style.top = `${Math.max(0, Math.round(bottom))}px`;
  }

  // ── #517: carry the reader's place through to the full page ──────────────
  /**
   * "Escapes to the full page WITHOUT LOSING POSITION" — the half of #497's
   * rubric 5 that shipped unmet. You hit ⤢ because you want more room to read
   * the thing you are reading; landing at the feed's default is the one
   * outcome that makes the control useless for its actual purpose.
   *
   * Anchored to a message id, never a scroll offset: the whole reason someone
   * promotes is that the panel is too narrow, so the destination reflows and
   * an offset means something different there.
   *
   * Resolved at click time rather than tracked on scroll — no listener, no
   * bookkeeping, and it cannot go stale.
   */
  function panelScroller() {
    if (panel.scrollHeight > panel.clientHeight + 4) return panel;
    return [...panel.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4) || null;
  }

  function readerIsOn() {
    const scroller = panelScroller();
    if (!scroller) return null;
    const top = scroller.getBoundingClientRect().top;
    // The first message still showing below the scroller's top edge — what the
    // reader's eye is on, not what happens to be first in the DOM.
    for (const m of scroller.querySelectorAll('.cv-msg[data-id], .conv-msg[data-id]')) {
      if (m.getBoundingClientRect().bottom > top + 4) return m.dataset.id;
    }
    return null;
  }

  /** Stamp `?at=<id>` on the promote link just before the browser follows it. */
  function carryPlaceThrough(link) {
    const id = readerIsOn();
    if (!id) return;                       // empty feed, or nothing resolvable — plain link is correct
    const href = link.getAttribute('href') || '/commons.html';
    const base = (doc.defaultView && doc.defaultView.location.href) || 'http://localhost/';
    const u = new URL(href, base);
    u.searchParams.set('at', id);
    link.setAttribute('href', u.pathname + u.search + u.hash);
  }

  // ── open / close ─────────────────────────────────────────────────────────
  const isOpen = () => panel.classList.contains('visible');

  function open() {
    if (isOpen()) return;
    syncPanelTop();
    panel.classList.add('visible');
    panel.setAttribute('aria-hidden', 'false');
    toggleEl.setAttribute('aria-expanded', 'true');
    markSeen();
    if (onOpen) onOpen(bodyEl);
  }

  function close() {
    if (!isOpen()) return;
    panel.classList.remove('visible');
    panel.setAttribute('aria-hidden', 'true');
    toggleEl.setAttribute('aria-expanded', 'false');
    markSeen();
    if (onClose) onClose();
    toggleEl.focus();
  }

  const toggle = () => (isOpen() ? close() : open());

  // ── wiring ───────────────────────────────────────────────────────────────
  const onToggleClick = () => toggle();
  const onPanelClick = (e) => {
    if (e.target.closest('[data-commons-close]')) { close(); return; }
    // #517 — stamp the reader's place on the promote link before the browser
    // follows it. A click handler on the panel runs before default navigation,
    // so rewriting href here is enough; no preventDefault, no manual navigate.
    const promote = e.target.closest('a[href*="commons.html"]');
    if (promote) carryPlaceThrough(promote);
  };
  const onKeydown = (e) => { if (e.key === 'Escape' && isOpen()) close(); };
  // Coming back to the tab is when a stale badge is most visible, and it is a
  // real user action — not a test hook. The interval is the floor, not the
  // only trigger.
  const onWake = () => { if (!isOpen() && doc.visibilityState !== 'hidden') refreshUnread(); };

  const onReflow = () => { if (isOpen()) syncPanelTop(); };

  toggleEl.addEventListener('click', onToggleClick);
  panel.addEventListener('click', onPanelClick);
  doc.addEventListener('keydown', onKeydown);
  doc.addEventListener('visibilitychange', onWake);
  const win = doc.defaultView;
  if (win) {
    win.addEventListener('focus', onWake);
    win.addEventListener('resize', onReflow);
    win.addEventListener('scroll', onReflow, { passive: true });
  }

  const timer = setInterval(() => { if (!isOpen()) refreshUnread(); }, pollMs);
  syncPanelTop();
  refreshUnread();

  return {
    open,
    close,
    toggle,
    refreshUnread,
    element: toggleEl,
    panel,
    destroy() {
      clearInterval(timer);
      toggleEl.removeEventListener('click', onToggleClick);
      panel.removeEventListener('click', onPanelClick);
      doc.removeEventListener('keydown', onKeydown);
      doc.removeEventListener('visibilitychange', onWake);
      if (win) {
        win.removeEventListener('focus', onWake);
        win.removeEventListener('resize', onReflow);
        win.removeEventListener('scroll', onReflow);
      }
      utility.remove();
    },
  };
}
