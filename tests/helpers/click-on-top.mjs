/**
 * #1674 — click a button only when it is the element under its own centre, and make sure the click REACHED it.
 *
 * The old helper (copied in editor-served-1367 and granular-add-edit-1583) checked "on top", then clicked in a
 * SEPARATE step: puppeteer re-reads the box and dispatches mousemove → mousedown → mouseup at that point. If the
 * layout moves in between (the 20 KB Preview→Write regrow is the suspect), the click lands on whatever now sits
 * there — a <select>, the form, a shim — and the button never hears it. CI caught that five times (see #1674).
 *
 * The fix checks RECEIPT, not the page's visible signal. A late signal and a lost click look identical at any
 * timeout, so re-clicking on a missing signal double-submits a click that already landed (#1674 R3/R3t). Instead a
 * capture-phase listener on the document records whether a click event reached the target (or a descendant of
 * it). Click events are dispatched synchronously within the mouseup, so by the time page.click resolves the record
 * is final:
 *   reached  → done; never click again, however late the page's own signal is
 *   missed   → activate it ONCE with a geometry-free element.click(), which cannot miss
 *
 * Matching by selector at dispatch time (event.target.closest(selector)), not by the element node, so a re-render
 * that swaps the button for an identical one between the check and the click still counts as reached.
 *
 * `landed` (optional): a page-side boolean EXPRESSION (a string, as page.waitForFunction takes it) for the click's
 * visible effect. When given, the helper waits for it with a 30 s bound and names the state on a miss. It is a
 * wait, never a reason to click again.
 */
export async function clickWhenOnTop(page, selector, { landed, timeout = 5000 } = {}) {
  // On top, and its box unchanged for 10 animation frames (the #1583 copy's stability rule, kept).
  await page.evaluate(() => { window.__stableClick = { key: '', frames: 0 }; });
  await page.waitForFunction((sel) => {
    const b = document.querySelector(sel);
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    const key = `${r.x},${r.y},${r.width},${r.height}`;
    const onTop = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
    const s = (window.__stableClick ??= { key: '', frames: 0 });
    s.frames = onTop && key === s.key ? s.frames + 1 : 0;
    s.key = key;
    return s.frames >= 10;
  }, { timeout, polling: 'raf' }, selector);

  await page.evaluate((sel) => {
    window.__clickReceipt = { sel, reached: false, strayTargets: [] };
    window.__clickReceiptListener = (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && t.closest(sel)) window.__clickReceipt.reached = true;
      else window.__clickReceipt.strayTargets.push(t ? (t.id || t.tagName) : String(e.target));
    };
    document.addEventListener('click', window.__clickReceiptListener, true);
  }, selector);

  let clickError = null;
  try { await page.click(selector); } catch (e) { clickError = e.message; }

  const receipt = await page.evaluate(() => {
    document.removeEventListener('click', window.__clickReceiptListener, true);
    const r = window.__clickReceipt;
    delete window.__clickReceipt; delete window.__clickReceiptListener;
    return r;
  });

  if (!receipt.reached) {
    // The coordinate click went elsewhere (or threw). Activate the target itself, once.
    await page.$eval(selector, (b) => b.click());
  }

  if (landed) {
    try {
      await page.waitForFunction(landed, { timeout: 30_000 });
    } catch {
      throw new Error(`#1674 clickWhenOnTop(${selector}): the click's effect (${landed}) did not appear within 30 s; `
        + `coordinate click ${receipt.reached ? 'reached the target' : `missed (went to ${JSON.stringify(receipt.strayTargets)}${clickError ? `, error: ${clickError}` : ''}) and was re-activated once`}`);
    }
  }
  return { reached: receipt.reached, reactivated: !receipt.reached, strayTargets: receipt.strayTargets, clickError };
}
