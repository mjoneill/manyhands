/**
 * #1674 — clickWhenOnTop checks that the button is the element under its own centre, then clicks in a SEPARATE step,
 * and the layout can change in between. These are the card's DONE WHEN rows (test author), written before the fix:
 *
 *   R1  a deterministic layout change BETWEEN the check and the click (a shim is inserted above the button on the
 *       click's own first mousemove, after puppeteer has computed the point): the button's handler must still run
 *       EXACTLY ONCE. RED on today's helper (the click lands on the shim).
 *   R2  CONTROL, the same page with no layout change: the handler runs exactly once. GREEN on today's helper.
 *   R3  EXACTLY-ONCE: the click lands, but the page's visible signal arrives late (2.5 s). A fallback must not
 *       click again. GREEN on today's helper (it has no fallback); it exists to hold the fix.
 *   R3t R3 HAS TEETH: a naive fallback (click, wait 1.5 s for the signal, then element.click()) is run through R3's
 *       page and must double-submit. If it does not, R3 could not fail and proves nothing.
 *
 * The helper under test: tests/helpers/click-on-top.mjs's `clickWhenOnTop` once the fix extracts it there; until then,
 * the function's own source, read from tests/editor-served-1367.test.mjs (never a copy that could drift).
 * Contract for the fix: clickWhenOnTop(page, selector, { landed }) where `landed` is a page-side boolean EXPRESSION
 * (a string, as page.waitForFunction takes it) that turns true once the click has done its job. Today's helper ignores the third argument.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowserServer } from './helpers/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function helperUnderTest() {
  const extracted = path.join(here, 'helpers', 'click-on-top.mjs');
  if (fs.existsSync(extracted)) return { from: 'tests/helpers/click-on-top.mjs', fn: (await import(extracted)).clickWhenOnTop };
  const src = fs.readFileSync(path.join(here, 'editor-served-1367.test.mjs'), 'utf8');
  const m = /^async function clickWhenOnTop\(page, selector\) \{\n[\s\S]*?\n\}\n/m.exec(src);
  assert.ok(m, 'clickWhenOnTop found in editor-served-1367.test.mjs');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${m[0].trim()});`)();
  return { from: 'editor-served-1367.test.mjs (today)', fn };
}

// A page with one button. Its handler counts; `signalAfterMs` delays the visible signal (data-done) after a click.
// `shiftOnMove`: on the FIRST mousemove anywhere, insert a 80px shim above the button, so the point puppeteer computed
// now lies on the shim. That is the race in its deterministic form: the check passed, the point was computed, then the
// layout moved before mousedown/mouseup.
const pageHtml = ({ shiftOnMove, signalAfterMs }) => `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<div id="col" style="padding:40px"><button id="go" style="width:160px;height:40px">Add card</button></div>
<script>
  window.__hits = 0; window.__targets = [];
  document.addEventListener('click', (e) => window.__targets.push(e.target.id || e.target.tagName), true);
  document.getElementById('go').addEventListener('click', () => {
    window.__hits += 1;
    setTimeout(() => document.getElementById('go').setAttribute('data-done', ''), ${signalAfterMs});
  });
  ${shiftOnMove ? `document.addEventListener('mousemove', function once() {
    document.removeEventListener('mousemove', once);
    const shim = document.createElement('div'); shim.id = 'shim'; shim.style.cssText = 'height:80px;background:#eee';
    document.getElementById('col').prepend(shim);
  });` : ''}
</script></body></html>`;

// A page-side EXPRESSION, not a function source: waitForFunction evaluates a string as an expression, and the source of an
// arrow function is itself a truthy value, so `'() => …'` would resolve at once (R3t caught exactly that in its first run).
const LANDED = 'document.getElementById("go").hasAttribute("data-done")';
const noServer = async () => ({ baseUrl: null, stop: async () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(fixture, click, settleMs) {
  let out;
  await withBrowserServer(async ({ browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.setContent(pageHtml(fixture));
    let error = null;
    try { await click(page); } catch (e) { error = e.message; }
    await sleep(settleMs);
    out = { ...(await page.evaluate(() => ({ hits: window.__hits, targets: window.__targets, done: document.getElementById('go').hasAttribute('data-done') }))), error };
  }, { _startServer: noServer });
  return out;
}

test('#1674 R1: the layout moves between the on-top check and the click → the button still runs exactly once', async () => {
  const h = await helperUnderTest();
  const r = await run({ shiftOnMove: true, signalAfterMs: 0 }, (p) => h.fn(p, '#go', { landed: LANDED }), 2500);
  assert.equal(r.hits, 1, `helper from ${h.from}: button handler ran ${r.hits} times; click targets ${JSON.stringify(r.targets)}; error ${r.error}`);
});

test('#1674 R2 CONTROL: no layout change → the button runs exactly once', async () => {
  const h = await helperUnderTest();
  const r = await run({ shiftOnMove: false, signalAfterMs: 0 }, (p) => h.fn(p, '#go', { landed: LANDED }), 500);
  assert.equal(r.hits, 1, `helper from ${h.from}: ran ${r.hits} times; targets ${JSON.stringify(r.targets)}; error ${r.error}`);
});

test('#1674 R3 EXACTLY-ONCE: the click lands but its signal is late (2.5 s) → no second click', async () => {
  const h = await helperUnderTest();
  const r = await run({ shiftOnMove: false, signalAfterMs: 2500 }, (p) => h.fn(p, '#go', { landed: LANDED }), 4000);
  assert.equal(r.hits, 1, `helper from ${h.from}: ran ${r.hits} times; targets ${JSON.stringify(r.targets)}; error ${r.error}`);
  assert.equal(r.done, true, 'the late signal did arrive');
});

test('#1674 R3t: R3 has teeth: a naive 1.5 s fallback double-submits on R3\'s page', async () => {
  const naive = async (page, selector) => {
    await page.click(selector);
    const ok = await page.waitForFunction(LANDED, { timeout: 1500 }).then(() => true, () => false);
    if (!ok) await page.$eval(selector, (b) => b.click());
  };
  const r = await run({ shiftOnMove: false, signalAfterMs: 2500 }, (p) => naive(p, '#go'), 4000);
  assert.equal(r.hits, 2, `the naive fallback was expected to double-submit; it ran ${r.hits} times`);
});
