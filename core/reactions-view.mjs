/**
 * #449 — the reaction chips under a post, Slack-style: one chip per emoji with its count, your own reaction marked,
 * hover or keyboard focus shows who reacted, a click toggles YOUR reaction, and a ☺+ button opens the palette.
 *
 * Browser-safe ESM like core/conversation-view.mjs: no node imports, and `document` is touched only through the `doc`
 * a caller hands in, so the pure helpers are node-testable. Names render through textContent and attributes only,
 * never innerHTML.
 *
 * Seeing who reacted and reacting are kept SEPARATE on purpose (#449, the 11-15 design note): hover/focus shows names,
 * a click toggles your own reaction.
 */
import { REACTION_PALETTE, REACTION_BATCH_MAX } from './reaction-palette.mjs';

export { REACTION_PALETTE };

/** The batch-read URLs for these post ids, split so no one read names more than the server accepts. */
export function reactionsUrls(baseUrl = '', ids = []) {
  const uniq = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  const out = [];
  for (let k = 0; k < uniq.length; k += REACTION_BATCH_MAX) {
    out.push(`${baseUrl}/api/reactions?posts=${uniq.slice(k, k + REACTION_BATCH_MAX).map(encodeURIComponent).join(',')}`);
  }
  return out;
}

/** "Ada", "Ada and Gizmo", "Ada, Gizmo and Board". */
export function namesPhrase(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The chips of one post as the page shows them. `chips` is the server's [{emoji, by}]; `me` is the viewer's key (or null);
 * `nameOf(key)` is a display name. A reactor who is `me` is named "You" and listed first, as Slack does.
 */
export function chipsView(chips, me, nameOf = (k) => k) {
  return (Array.isArray(chips) ? chips : []).filter((c) => c && typeof c.emoji === 'string' && Array.isArray(c.by) && c.by.length)
    .map((c) => {
      const mine = !!me && c.by.includes(me);
      const names = [...(mine ? ['You'] : []), ...c.by.filter((k) => k !== me).map((k) => nameOf(k) || k)];
      return { emoji: c.emoji, count: c.by.length, mine, label: `${namesPhrase(names)} reacted with ${c.emoji}` };
    });
}

/**
 * The row under one post. `opts`: { postId, chips, me, nameOf, enabled, onToggle(emoji, on) }. With `enabled` false
 * (the server has no reaction store) the row still SHOWS any chips but offers no way to react; with no chips and not
 * enabled it is empty. Without a `me` (no composer identity) chips read but do not toggle.
 */
export function renderReactionRow(doc, opts) {
  const { postId, chips, me, nameOf, enabled, onToggle } = opts;
  const row = doc.createElement('div');
  row.className = 'cv-reactions';
  row.dataset.post = postId;
  const canReact = !!enabled && !!me && typeof onToggle === 'function';
  for (const c of chipsView(chips, me, nameOf)) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'cv-reaction' + (c.mine ? ' cv-reaction-mine' : '');
    b.dataset.emoji = c.emoji;
    b.dataset.names = c.label;
    b.title = c.label;
    b.setAttribute('aria-label', `${c.label}${canReact ? (c.mine ? '. Click to remove yours.' : '. Click to add yours.') : ''}`);
    b.setAttribute('aria-pressed', c.mine ? 'true' : 'false');
    const e = doc.createElement('span'); e.className = 'cv-reaction-emoji'; e.textContent = c.emoji;
    const n = doc.createElement('span'); n.className = 'cv-reaction-count'; n.textContent = String(c.count);
    b.append(e, n);
    if (canReact) b.addEventListener('click', (ev) => { ev.stopPropagation(); onToggle(c.emoji, !c.mine); });
    else b.disabled = !enabled;
    row.appendChild(b);
  }
  if (canReact) {
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'cv-reaction-add';
    add.textContent = '☺+';
    add.title = 'Add a reaction';
    add.setAttribute('aria-label', 'Add a reaction');
    add.setAttribute('aria-expanded', 'false');
    const picker = doc.createElement('div');
    picker.className = 'cv-reaction-picker';
    picker.hidden = true;
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Choose a reaction');
    const mineSet = new Set(chipsView(chips, me, nameOf).filter((c) => c.mine).map((c) => c.emoji));
    for (const emoji of REACTION_PALETTE) {
      const p = doc.createElement('button');
      p.type = 'button';
      p.className = 'cv-reaction-pick';
      p.textContent = emoji;
      p.dataset.emoji = emoji;
      p.title = mineSet.has(emoji) ? `Remove your ${emoji}` : `React with ${emoji}`;
      p.addEventListener('click', (ev) => { ev.stopPropagation(); picker.hidden = true; add.setAttribute('aria-expanded', 'false'); onToggle(emoji, !mineSet.has(emoji)); });
      picker.appendChild(p);
    }
    add.addEventListener('click', (ev) => {
      ev.stopPropagation();
      picker.hidden = !picker.hidden;
      add.setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
      if (!picker.hidden) picker.querySelector('button')?.focus();
    });
    picker.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { picker.hidden = true; add.setAttribute('aria-expanded', 'false'); add.focus(); } });
    row.append(add, picker);
  }
  return row;
}
