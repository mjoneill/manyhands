/**
 * #1350 slice 2 — WHAT GOVERNS THIS AGENT, NOW, on the screen.
 *
 * Slice 1 put the inventory on `GET /api/agents/:seat/constraints`: every
 * governing value with the layer that won (agent record · model spec · ledger
 * · board · code default · unset) and `unseen[]` for the layers the board
 * cannot read. This module draws it — the same table on the Settings agent
 * row and behind a name in the commons — so "why did she go quiet" and "why
 * did he stop at 8" are read off the screen, not discovered by trace.
 *
 * Two rules carried from the endpoint, because a renderer can undo them:
 *   ⛔ the SOURCE is shown beside every value, never dropped for tidiness —
 *      a settings-page value overridden elsewhere is the lie #1336 told;
 *   ⛔ `unset` and `code default` are rendered as different things. A blank
 *      cell would collapse them, and "nobody set this" vs "the code applies
 *      4" is exactly the distinction a reader needs.
 *
 * Security: everything renders via textContent / createElement. Values are
 * user-controlled strings (prompt versions, grants, titles); no innerHTML.
 *
 * Ordering is the card's list, not the JSON's: the reader is looking for one
 * fact and should find it where the card put it.
 */

const ORDER = [
  ['model', 'model'], ['provider', 'provider'], ['protocol', 'protocol'], ['thinking', 'thinking'],
  ['budgetPerDay', 'budget / day'], ['spentToday', 'spent today'],
  ['promptVersion', 'prompt version'], ['participationClause', 'told when to speak'],
  ['wakeOn', 'wakes on'], ['everyMinutes', 'every (min)'], ['deliveryMode', 'delivery mode'],
  ['maxHops', 'hop ceiling'], ['toolGrants', 'tool grants'], ['contextPolicy', 'context'],
  ['residency', 'residency'], ['state', 'state'], ['holds', 'holds'], ['promptGrantConflict', 'prompt vs grants'],
];

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/** One value, as a human reads it. Never JSON for the common shapes. */
export function formatValue(key, rec) {
  const v = rec?.value;
  if (rec?.source === 'unset') return '—';
  if (v === null || v === undefined) return '—';
  if (key === 'spentToday') {
    const rem = rec.remaining == null ? '' : ` · ${rec.remaining} left`;
    return `${v} (${rec.calls ?? 0} call${rec.calls === 1 ? '' : 's'} since ${rec.since ? String(rec.since).slice(11, 16) + 'Z' : 'midnight'})${rem}`;
  }
  if (key === 'holds') return Array.isArray(v) && v.length ? v.map((h) => `#${h.card}`).join(', ') : 'nothing';
  if (key === 'promptGrantConflict') return v && v.phrase ? `⚠ "${v.phrase}"${v.reason ? ` — ${v.reason}` : ''}` : 'none';
  if (key === 'promptVersion') return `v${v}`;
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

/** The source label, with the two special layers spelled out. */
export function formatSource(rec) {
  const s = rec?.source ?? '?';
  if (s === 'unset') return 'unset — nothing at any layer';
  if (s === 'code default') return 'code default';
  return s;
}

/**
 * Draw the inventory into `container` (emptied first). `payload` is the
 * endpoint's 200 body, or its 404 body ({error, unseen}) for a seat with no
 * agent record — that case renders the error line and the unseen list, so a
 * bridged seat's reader learns WHY there is nothing here rather than seeing
 * nothing.
 */
export function renderConstraints(container, payload, { seat } = {}) {
  container.replaceChildren();
  const box = el('div', 'constraints');
  if (!payload || payload.error) {
    box.append(el('p', 'constraints-none', payload?.error || `no constraints could be read for ${seat ?? 'this seat'}`));
  } else {
    const table = el('table', 'constraints-table');
    const thead = el('thead'); const hr = el('tr');
    for (const h of ['constraint', 'in effect', 'from']) hr.append(el('th', null, h));
    thead.append(hr); table.append(thead);
    const tbody = el('tbody');
    const c = payload.constraints || {};
    for (const [key, label] of ORDER) {
      if (!(key in c)) continue;
      const tr = el('tr', `constraints-row source-${String(c[key].source || '').replace(/\s+/g, '-')}`);
      tr.dataset.constraint = key;
      tr.append(el('td', 'constraints-key', label));
      const val = el('td', 'constraints-value', formatValue(key, c[key]));
      if (key === 'promptVersion' && c[key].id) val.title = c[key].id;
      tr.append(val);
      tr.append(el('td', 'constraints-source', formatSource(c[key])));
      tbody.append(tr);
    }
    table.append(tbody);
    box.append(table);
  }
  const unseen = Array.isArray(payload?.unseen) ? payload.unseen : [];
  if (unseen.length) {
    box.append(el('h5', 'constraints-unseen-head', 'What the board cannot see'));
    const ul = el('ul', 'constraints-unseen');
    for (const u of unseen) {
      const li = el('li'); li.dataset.layer = u.layer;
      li.append(el('strong', null, `${u.layer}: `), el('span', null, `${u.what}`), el('div', 'constraints-why', u.why));
      ul.append(li);
    }
    box.append(ul);
  }
  container.append(box);
  return box;
}

/** Fetch + render. Resolves to the payload (200 or 404 body) so callers can assert on it. */
export async function loadConstraints(container, seat, { baseUrl = '' } = {}) {
  container.replaceChildren(el('p', 'constraints-loading', 'reading…'));
  let payload = null;
  try {
    const r = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(seat)}/constraints`);
    payload = await r.json();
  } catch (e) {
    payload = { error: `could not read constraints for ${seat}: ${e?.message || e}`, unseen: [] };
  }
  renderConstraints(container, payload, { seat });
  return payload;
}

/**
 * A popover anchored to a name. One at a time; Escape or a click outside closes
 * it. Used by the commons (and the board, slice 3) so a reader can go from a
 * name to what governs it without leaving the page.
 */
let openPopover = null;
export function openConstraintsPopover(anchor, seat, { baseUrl = '' } = {}) {
  closeConstraintsPopover();
  const pop = el('div', 'constraints-popover');
  pop.setAttribute('role', 'dialog');
  pop.dataset.seat = seat;
  const head = el('div', 'constraints-popover-head');
  head.append(el('strong', null, `what governs ${seat} now`));
  const close = el('button', 'constraints-popover-close', '×'); close.type = 'button'; close.title = 'close';
  close.addEventListener('click', closeConstraintsPopover);
  head.append(close);
  const body = el('div', 'constraints-popover-body');
  pop.append(head, body);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - pop.offsetWidth - 8))}px`;
  const onKey = (e) => { if (e.key === 'Escape') closeConstraintsPopover(); };
  const onClick = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeConstraintsPopover(); };
  document.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('click', onClick), 0);
  openPopover = { pop, onKey, onClick };
  return loadConstraints(body, seat, { baseUrl });
}

export function closeConstraintsPopover() {
  if (!openPopover) return;
  document.removeEventListener('keydown', openPopover.onKey);
  document.removeEventListener('click', openPopover.onClick);
  openPopover.pop.remove();
  openPopover = null;
}
