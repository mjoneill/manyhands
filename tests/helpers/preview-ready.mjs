/**
 * #1445 — open an editor's preview and WAIT FOR THE PAGE'S OWN SIGNAL, not a clock.
 *
 * Why not just wait longer: the editor's toggle handler is SYNCHRONOUS (core/editor.mjs showPreview: it sets `previewing`, unhides the preview and renders in the click
 * handler itself), and a CDP click resolves only after the page has dispatched the event. So when the observed failure state is `previewing:false, previewHidden:true,
 * previewLinks:0` five seconds after the click, the handler did not run at all: the click did not reach the button (the layout moved between the position being measured and
 * the mouse event being dispatched: the form slides open, the textarea re-grows on `resize`). A longer wait cannot change that. What changes it is a SECOND, geometry-free
 * activation (`button.click()` in the page), tried when the first one produced no signal within `retryAfterMs`.
 *
 * It still fails, explicitly, when the preview never opens: at `ceilingMs` it throws with the number of attempts and the editor's state.
 * Returns { attempts, ms } so a caller can print how often the first click was not enough: a retry is a measurement, not a silent pass.
 */
export async function openPreview(page, { buttonSelector, editorSelector, clickFirst, ceilingMs = 30_000, retryAfterMs = 1_500 }) {
  const t0 = Date.now();
  const ready = (sel) => {
    const ed = document.querySelector(sel);
    const pv = ed?.querySelector('.mh-editor-preview');
    return !!ed && ed.classList.contains('previewing') && !!pv && !pv.hidden;
  };
  const state = () => page.evaluate((sel, btn) => {
    const ed = document.querySelector(sel);
    const pv = ed?.querySelector('.mh-editor-preview');
    return {
      editors: document.querySelectorAll(sel).length,
      previewing: ed?.classList.contains('previewing') ?? null,
      previewHidden: pv?.hidden ?? null,
      previewLinks: pv?.querySelectorAll('a[data-shortid]').length ?? null,
      pressed: ed?.querySelector(btn)?.getAttribute('aria-pressed') ?? null,
    };
  }, editorSelector, buttonSelector);
  let attempts = 0;
  while (Date.now() - t0 < ceilingMs) {
    attempts += 1;
    try {
      if (attempts === 1) await clickFirst();   // the caller's coordinate click (it waits for the button to be on top)
      else await page.$eval(buttonSelector, (b) => b.click());   // geometry-free: no position to lose
    } catch { /* the button is not there yet or moved: the readiness wait below decides */ }
    const left = ceilingMs - (Date.now() - t0);
    try {
      await page.waitForFunction(ready, { timeout: Math.max(50, Math.min(retryAfterMs, left)), polling: 50 }, editorSelector);
      return { attempts, ms: Date.now() - t0 };
    } catch { /* no signal yet: activate again */ }
  }
  throw new Error(`preview never opened within ${ceilingMs} ms and ${attempts} activation(s) — state: ${JSON.stringify(await state())}`);
}
