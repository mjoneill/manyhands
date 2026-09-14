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

/** [{op: '=' | '-' | '+', text}] — `-` is the OLD side, `+` the NEW side. */
export function lineDiff(oldText, newText) {
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

/** Escape-FIRST HTML: one <div class="diff-line …"> per line. */
export function renderLineDiff(oldText, newText) {
  const cls = { '=': 'same', '-': 'del', '+': 'add' };
  const mark = { '=': ' ', '-': '−', '+': '+' };
  return lineDiff(oldText, newText)
    .map((l) => `<div class="diff-line ${cls[l.op]}"><span class="diff-mark">${mark[l.op]}</span>${escapeHtml(l.text) || '&nbsp;'}</div>`)
    .join('');
}
