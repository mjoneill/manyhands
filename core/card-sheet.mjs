/**
 * core/card-sheet.mjs — #758: open any card reference WITHOUT leaving the page.
 *
 * "I stopped clicking on card links in the chat because it was too expensive
 * to give up my current context." The loss was never the navigation; it was
 * the place. A #NNN in the commons, or a raised-hand entry, opens THIS —
 * an overlay on top of the page you are reading — and closing it leaves the
 * page exactly where it was: same scroll, same draft in the box.
 *
 * What the sheet holds (the card's "done" list):
 *   · the ask, stated — the card's raised hands and its THREAD, rendered
 *     through the shared conversation-view (#1368's grooming thread: the PO's
 *     answers badged, ⚖ Ruling on any comment) — so there is somewhere to
 *     add a comment TO, which the old popup never had (Finding C);
 *   · add a comment — the same composer, same drafts (#1366);
 *   · ✎ Edit on the board — a NEW TAB to index.html?card=N, where #1365's
 *     editor lives. The board's edit form is not portable here yet; a new tab
 *     keeps the context, which is the property that matters;
 *   · links out to the wiki page;
 *   · a #NNN inside the sheet's own text opens THAT card in the same sheet.
 *
 * One sheet per document; opening another card replaces the content. Esc,
 * ✕ and the backdrop close it (three exits, none a trap — #510's lesson).
 * Browser-only; no node imports.
 */
import { mountConversationView } from './conversation-view.mjs';
import { resolveRoleHolder } from './roles.mjs';

const CARD_REF_RE = /(?<![\w&;])#(\d+)/g;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** The board's own description rendering: escaped text, #NNN as links. */
export function renderDescription(text) {
  return escapeHtml(text || '').replace(CARD_REF_RE, (_, n) => `<a class="cardref" data-shortid="${n}" href="index.html?card=${n}">#${n}</a>`);
}

/**
 * #1391 — THE CARD'S HEAD, one renderer with two homes: the sheet (an overlay
 * on any page) and the grooming page itself (commons.html?node=<card>), where
 * the owner found himself "writing about a card you cannot see". Eyebrow,
 * title, meta chips, the doors out, open raised hands (the ASK), and the
 * description with its #NNN refs live. Built from text nodes and one
 * escape-first innerHTML (renderDescription), so it is XSS-safe by
 * construction wherever it is mounted.
 */
export function renderCardHead(card, { doc = document, baseUrl = '', titleId = null } = {}) {
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const head = el('div', 'card-head');
  head.dataset.cardId = card.id; head.dataset.shortId = String(card.shortId);
  const eyebrow = el('div', 'card-head-eyebrow card-sheet-eyebrow', `${card.type || 'card'} · #${card.shortId}${card.column ? ' · ' + card.column : ''}`);
  const title = el('h2', 'card-head-title card-sheet-title', card.title || '(untitled)');
  if (titleId) title.id = titleId;
  const meta = el('div', 'card-head-meta card-sheet-meta');
  if (card.priority) meta.appendChild(el('span', 'card-sheet-chip', String(card.priority).toUpperCase()));
  for (const a of (card.assignees || [])) meta.appendChild(el('span', 'card-sheet-chip', a));
  for (const l of (card.labels || [])) meta.appendChild(el('span', 'card-sheet-chip label', l));
  // Links OUT — they stop being the only option, they do not disappear.
  const links = el('div', 'card-head-links card-sheet-links');
  const edit = el('a', 'card-head-link card-sheet-link edit', '✎ Edit on the board');
  edit.href = `${baseUrl}/index.html?card=${encodeURIComponent(card.shortId)}`; edit.target = '_blank'; edit.rel = 'noopener';
  edit.title = 'Opens the board in a new tab with this card big and editable (#1365) — this page keeps its place';
  const wiki = el('a', 'card-head-link card-sheet-link', '📄 Wiki page');
  wiki.href = `${baseUrl}/wiki.html?node=${encodeURIComponent(card.id)}`; wiki.target = '_blank'; wiki.rel = 'noopener';
  links.append(edit, wiki);
  head.append(eyebrow, title, meta, links);
  // The ASK, stated: raised hands on this card (structured blockers), if any.
  const asks = (Array.isArray(card.blockers) ? card.blockers : []).filter((b) => b && (b.status || 'open') !== 'cleared');
  if (asks.length) {
    const askEl = el('div', 'card-head-asks card-sheet-asks');
    for (const b of asks) {
      const who = b.anyHuman ? 'any human' : (b.person || (b.card != null ? `card #${b.card}` : 'someone'));
      askEl.appendChild(el('div', 'card-sheet-ask', `🚧 waiting on ${who}: ${b.note || '(no detail given)'}`));
    }
    head.appendChild(askEl);
  }
  const body = el('div', 'card-head-body card-sheet-body prose');
  if (typeof card.description === 'string' && card.description) body.innerHTML = renderDescription(card.description);   // escaped first; only #NNN anchors are added
  else { body.classList.add('empty'); body.textContent = 'No description.'; }
  head.appendChild(body);
  return head;
}

let current = null;   // { root, view, restoreScroll }

export function closeCardSheet(doc = document) {
  if (!current) return;
  const { root, view, restoreScroll, onKey } = current;
  current = null;
  try { view?.destroy?.(); } catch { /* the view is going away regardless */ }
  if (onKey) doc.removeEventListener('keydown', onKey);
  root.remove();
  doc.body.classList.remove('card-sheet-open');
  try { restoreScroll(); } catch { /* nothing to restore */ }
}

/**
 * Open the sheet for a card. `key` is a shortId (number or numeric string)
 * or a card id. Returns the sheet element, or null if the card is not found
 * (the caller decides what to say — usually "no such card here").
 */
export async function openCardSheet(key, { doc = document, baseUrl = '', fetchImpl = (...a) => fetch(...a), onMissing = null, keepScroll = [] } = {}) {
  const win = doc.defaultView;
  let card = null;
  try { const r = await fetchImpl(`${baseUrl}/api/cards/${encodeURIComponent(String(key))}`); if (r.ok) card = await r.json(); } catch { card = null; }
  if (!card || card.id == null) { if (typeof onMissing === 'function') onMissing(key); return null; }

  // Remember the place BEFORE the overlay changes anything; restore it on close.
  // The page's own scroll, plus any scroll CONTAINER the host names (the
  // commons feed is one — the page itself never scrolls there).
  const scrollX = win.scrollX, scrollY = win.scrollY;
  const containers = [].concat(keepScroll || []).flatMap((sel) => [...doc.querySelectorAll(sel)]).map((el) => [el, el.scrollTop, el.scrollLeft]);
  const restoreScroll = () => { win.scrollTo(scrollX, scrollY); for (const [el, top, left] of containers) { if (el.isConnected) { el.scrollTop = top; el.scrollLeft = left; } } };
  if (current) closeCardSheet(doc);   // one sheet at a time; the old one's listeners go with it

  const back = doc.createElement('div');
  back.className = 'card-sheet-backdrop';
  back.id = 'card-sheet-backdrop';
  const sheet = doc.createElement('div');
  sheet.className = 'card-sheet';
  sheet.id = 'card-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-labelledby', 'card-sheet-title');
  sheet.dataset.cardId = card.id;
  sheet.dataset.shortId = String(card.shortId);

  const close = doc.createElement('button');
  close.className = 'card-sheet-close'; close.type = 'button'; close.title = 'Close (Esc)'; close.textContent = '✕';
  close.addEventListener('click', () => closeCardSheet(doc));

  const head = renderCardHead(card, { doc, baseUrl, titleId: 'card-sheet-title' });   // #1391 — one renderer, two homes
  const threadHead = doc.createElement('div'); threadHead.className = 'card-sheet-thread-head'; threadHead.textContent = '💬 On this card';
  const thread = doc.createElement('div'); thread.className = 'card-sheet-thread';

  sheet.append(close, head, threadHead, thread);
  back.appendChild(sheet);

  // exits: backdrop click (not the sheet), Esc
  back.addEventListener('click', (e) => { if (e.target === back) closeCardSheet(doc); });
  const onKey = (e) => { if (e.key === 'Escape') closeCardSheet(doc); };
  doc.addEventListener('keydown', onKey);
  // a #NNN inside the sheet opens that card here, never navigates
  sheet.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a.cardref[data-shortid]') : null;
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    openCardSheet(Number(a.dataset.shortid), { doc, baseUrl, fetchImpl, onMissing, keepScroll });
  });

  doc.body.appendChild(back);
  doc.body.classList.add('card-sheet-open');
  current = { root: back, view: null, restoreScroll, onKey };

  // The thread — the card's own conversation, the same composer everywhere.
  let poSeat = null;
  try { poSeat = await resolveRoleHolder('po', { baseUrl, fetchImpl }); } catch { poSeat = null; }
  if (current && current.root === back) {
    try {
      current.view = mountConversationView({ mount: thread, attachedTo: card.id, baseUrl, fetchImpl, poll: true, poSeat, card: { id: card.id, shortId: card.shortId }, placeholder: 'Add to this card…' });
    } catch (err) { thread.textContent = 'The thread could not be loaded: ' + (err && err.message ? err.message : err); }
  }
  return sheet;
}

/**
 * Delegate: any click on a `#NNN` ref inside `root` opens the sheet in place.
 * Modifier-clicks (new tab) are left to the browser.
 */
export function wireCardRefs(root, opts = {}) {
  root.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const a = e.target && e.target.closest ? e.target.closest('a.cardref[data-shortid], a[data-open-card]') : null;
    if (!a) return;
    const key = a.dataset.openCard || a.dataset.shortid;
    if (!key) return;
    e.preventDefault();
    openCardSheet(key, opts);
  });
}
