/**
 * core/header.mjs — #303-2. ONE cross-surface nav, mounted on all four surfaces
 * (board, wiki, commons, settings) so the links can't drift apart again. Before
 * this, four hand-rolled navs disagreed: wiki + commons lacked Settings, and
 * settings only linked back to the board (the "I can't see Settings from
 * the commons" finding).
 *
 * Pure + browser-safe (no node imports, `document` only touched in mountTopNav),
 * so the label/markup logic is node-testable. Labels are static constants — no
 * user input reaches the markup, so the string build is XSS-safe by definition.
 */

export const NAV_ITEMS = [
  { id: 'board', href: '/', label: '▦ Board' },
  { id: 'wiki', href: '/wiki.html', label: '📖 Wiki' },
  { id: 'commons', href: '/commons.html', label: '💬 Commons' },
  { id: 'settings', href: '/settings.html', label: '⚙️ Settings' },
];

/** The nav markup with `activeId` marked (a non-link <span>, aria-current). */
export function renderTopNav(activeId) {
  const links = NAV_ITEMS.map((it) =>
    it.id === activeId
      ? `<span class="navlink active" aria-current="page">${it.label}</span>`
      : `<a class="navlink" href="${it.href}">${it.label}</a>`,
  ).join('');
  return `<nav class="topnav">${links}</nav>`;
}

/** Render the nav into #<mountId> (default "app-nav"). Returns the mount el. */
export function mountTopNav(doc, activeId, mountId = 'app-nav') {
  const el = doc.getElementById(mountId);
  if (el) el.innerHTML = renderTopNav(activeId);
  return el;
}
