/**
 * core/leaving-guard.mjs — #1366: leaving with unsaved text asks first.
 *
 * "The pain of mistakenly clicking off the conversation board somewhere else
 * and losing a half-written comment." The drafts themselves are kept by
 * composer-watch (per surface, per target) — so a misclick now costs a
 * restore, not the text. This is the second half: the page ASKS before it
 * leaves, and the ask NAMES the surface ("you have an unsent comment on
 * #1321"), because a generic "changes may not be saved" tells the operator
 * nothing about which box.
 *
 * One registry per window. A composer registers its watch handle plus a
 * describe(); the guard is installed once and reads every registered handle's
 * isDirty() at the moment of leaving:
 *
 *   beforeunload   — tab close, reload, typed URL, and links the click guard
 *                    did not cover. The browser shows its own generic dialog
 *                    (custom text has been ignored by every browser for years);
 *                    we set returnValue and preventDefault, which is the whole
 *                    contract.
 *   click, capture — a same-origin link that would unload THIS page. Here we
 *                    can say which surface, so we do, through `ask` (defaults
 *                    to window.confirm; injectable for tests). Hash links, new
 *                    tabs, modifier-clicks, downloads and external links are
 *                    let through: none of them loses the page.
 *
 * ⛔ The guard must never be the reason navigation breaks: every read of a
 *    handle is wrapped, and a handle that throws counts as clean.
 */

const REGISTRY = new WeakMap(); // window → { handles: Set, installed: bool }

function stateFor(win) {
  let st = REGISTRY.get(win);
  if (!st) { st = { handles: new Set(), installed: false }; REGISTRY.set(win, st); }
  return st;
}

/** Register a composer-watch handle (anything with isDirty()) and how to name it. */
export function registerComposer(handle, { describe = () => 'unsaved text', win = globalThis.window } = {}) {
  if (!handle || typeof handle.isDirty !== 'function' || !win) return () => {};
  const st = stateFor(win);
  const entry = { handle, describe };
  st.handles.add(entry);
  return () => st.handles.delete(entry);
}

/** The dirty composers' descriptions, in registration order. Empty ⇒ nothing to lose. */
export function dirtyDescriptions(win = globalThis.window) {
  const st = REGISTRY.get(win);
  if (!st) return [];
  const out = [];
  for (const { handle, describe } of st.handles) {
    let dirty = false;
    try { dirty = !!handle.isDirty(); } catch { dirty = false; }
    if (dirty) { try { out.push(String(describe())); } catch { out.push('unsaved text'); } }
  }
  return out;
}

function leaveMessage(descs) {
  return `You have ${descs.join(' and ')}. Leave anyway? It stays saved as a draft here, but you were still writing it.`;
}

/** Would following this anchor unload the current page? */
function unloadsPage(a, ev, win) {
  if (!a || ev.defaultPrevented) return false;
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return false;
  if (a.target && a.target !== '_self') return false;
  if (a.hasAttribute('download')) return false;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
  let url;
  try { url = new win.URL(a.href, win.location.href); } catch { return false; }
  if (url.origin !== win.location.origin) return false; // the browser's beforeunload covers it
  // same document, only the fragment differs ⇒ no unload
  if (url.pathname === win.location.pathname && url.search === win.location.search && url.hash !== '') return false;
  return true;
}

/**
 * Install once per window. `ask(message) → boolean` decides an in-app leave;
 * defaults to window.confirm.
 */
export function installLeavingGuard(win = globalThis.window, { ask = null } = {}) {
  if (!win) return null;
  const st = stateFor(win);
  if (st.installed) return st;
  st.installed = true;
  const confirmLeave = ask || ((msg) => win.confirm(msg));

  win.addEventListener('beforeunload', (e) => {
    const descs = dirtyDescriptions(win);
    if (!descs.length) return;
    e.preventDefault();
    e.returnValue = leaveMessage(descs); // the legacy contract; the browser shows its own text
  });

  win.document.addEventListener('click', (e) => {
    const a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a[href]') : null;
    if (!unloadsPage(a, e, win)) return;
    const descs = dirtyDescriptions(win);
    if (!descs.length) return;
    let ok = false;
    try { ok = !!confirmLeave(leaveMessage(descs)); } catch { ok = true; } // an ask that throws must not trap the operator
    if (!ok) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  return st;
}

/** Tests only: forget every registration on every window this module has seen. */
export function _resetForTests() {
  // WeakMap cannot be iterated; tests create a fresh JSDOM window per case, so
  // a new window IS a reset. Kept as an explicit seam so the intent is visible.
}
