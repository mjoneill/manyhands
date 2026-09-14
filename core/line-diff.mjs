/**
 * core/line-diff.mjs — #1365: a line diff for the edit-conflict view.
 *
 * When a save is refused because the card moved under the editor, "someone
 * changed this while you were editing" is only useful with the CHANGE beside
 * it. This is the smallest diff that answers "what did they change?": lines,
 * longest common subsequence, no heuristics. O(n·m) on line counts, which for
 * a description (hundreds of lines, not thousands) is instant; the test pins
 * 2,000 lines under a second so a pathological card cannot freeze the page.
 *
 * No node imports — runs in the browser (isomorphic core, ADR-002).
 */

/**
 * The cap. The table is (n+1)·(m+1)·4 bytes: 2,000 lines a side is 16 MB and
 * instant; 10,000 a side is 400 MB and a frozen tab — while the page is
 * explaining a conflict, which is the worst moment. A description may legally
 * be that long (the server takes 10 MB bodies), so the cap is a guard, not a
 * limit on descriptions: past it the caller gets `tooLarge` and shows the two
 * doors without the picture. (A reviewer's finding on 68c0463 — the test had
 * timed a friendly fixture and proved nothing about the unfriendly one.)
 */
export const MAX_DIFF_LINES = 2000;

/** True when a diff of these two texts would exceed the cap. Counts lines, allocates nothing. */
export function diffTooLarge(oldText, newText, max = MAX_DIFF_LINES) {
  const count = (t) => (t === '' || t == null ? 0 : String(t).split('\n').length);
  return count(oldText) > max || count(newText) > max;
}

/**
 * [{op: '=' | '-' | '+', text}] — `-` is the OLD side, `+` the NEW side.
 * Throws RangeError past MAX_DIFF_LINES: check `diffTooLarge` first, or catch.
 */
export function lineDiff(oldText, newText) {
  if (diffTooLarge(oldText, newText)) throw new RangeError(`line diff refused: more than ${MAX_DIFF_LINES} lines a side`);
  const a = oldText === '' ? [] : String(oldText ?? '').split('\n');
  const b = newText === '' ? [] : String(newText ?? '').split('\n');
  const n = a.length, m = b.length;
  // LCS table, row-major, (n+1)×(m+1); Uint32 keeps 2,000×2,000 at 16 MB.
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: '=', text: a[i] }); i++; j++; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { out.push({ op: '-', text: a[i] }); i++; }
    else { out.push({ op: '+', text: b[j] }); j++; }
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Escape-FIRST HTML: one <div class="diff-line …"> per line. Past the cap it
 * renders a single line saying so — the conflict view keeps its two doors,
 * it just has no picture to show.
 */
export function renderLineDiff(oldText, newText) {
  if (diffTooLarge(oldText, newText)) {
    return `<div class="diff-line too-large">Diff not shown: more than ${MAX_DIFF_LINES} lines a side. Choose “Use theirs” or “Save mine anyway”, or compare the texts elsewhere.</div>`;
  }
  const cls = { '=': 'same', '-': 'del', '+': 'add' };
  const mark = { '=': ' ', '-': '−', '+': '+' };
  return lineDiff(oldText, newText)
    .map((l) => `<div class="diff-line ${cls[l.op]}"><span class="diff-mark">${mark[l.op]}</span>${escapeHtml(l.text) || '&nbsp;'}</div>`)
    .join('');
}
