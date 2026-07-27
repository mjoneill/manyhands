/**
 * #516 — a page styles what it OWNS.
 *
 * The defect: `settings.html` styled the bare element `button { … margin-top:22px }`
 * — a form-submit convention — which reached every button on the page including
 * ones the page did not author. #497's shared commons control mounted into the
 * header and landed 22px lower on that surface than on the board and the wiki.
 *
 * The fix there was the component defending itself (`.commons-toggle { margin: 0 }`),
 * and that is the part worth testing against, because **a component defending
 * itself only ever defends one component.** The next shared thing mounted into
 * that header inherits the same rule and its author spends the same half hour.
 * Three local undos had already accreted inside settings.html to fight the same
 * rule before anyone named it.
 *
 * ── How this is asserted, and why not the obvious way ─────────────────────
 * The obvious test is "no bare element selectors in the style block" — a grep.
 * It would pass the moment someone writes `input { … }` instead, and it tests
 * the shape of the source rather than what happens to a component. So the bar
 * here INJECTS a plain, unstyled element into each surface's shared header and
 * asserts the surfaces agree about it. That is the actual property: an element
 * this page did not author receives nothing from this page.
 *
 * The grep survives too, as a cheap supporting check that names the class of
 * mistake — but it is not the assertion that matters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const SURFACES = ['/', '/wiki.html', '/settings.html', '/commons.html'];

/**
 * Properties a page-local element rule would leak into a foreign component.
 *
 * `padding` is deliberately NOT here, and the omission is a finding rather than
 * a convenience: the probe showed index.html carries a universal reset
 * (`*, ::before, ::after { margin:0; padding:0 }`) that the other three surfaces
 * do not, so the four disagree about the padding of an element none of them
 * styles. That is a real divergence — the #496 disease one layer down — but it
 * is the INVERSE of #516's defect (removing browser opinion, not imposing a
 * page convention), and fixing it changes the computed layout of every unstyled
 * element on three live surfaces at once. Filed as #524 with its own
 * beneficiary walk.
 *
 * When #524 lands, put 'padding' back in this list and delete this comment. The
 * test is shaped to receive the fix.
 */
const LEAKY = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'fontWeight'];

test('#516 a foreign element dropped into the shared header inherits nothing page-local', async () => {
  const server = await startRestServer({ board: makeBoardFixture(), staticDir: PROJECT_DIR });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const seen = {};
    for (const surface of SURFACES) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1442, height: 900 });
      await page.goto(`${server.baseUrl}${surface}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.shell-head', { timeout: 5000 });

      seen[surface] = await page.evaluate((props) => {
        // A stranger's element: no class, no id, nothing this page knows about.
        const probe = document.createElement('button');
        probe.textContent = 'probe';
        document.querySelector('.shell-head').appendChild(probe);
        const cs = getComputedStyle(probe);
        const out = {};
        for (const p of props) out[p] = cs[p];
        probe.remove();
        return out;
      }, LEAKY);
      await page.close();
    }

    const [first, ...rest] = SURFACES;
    for (const surface of rest) {
      assert.deepEqual(
        seen[surface], seen[first],
        `${surface} styles elements it did not author — a plain <button> in the shared header computes differently there than on ${first}:\n`
        + `  ${first}: ${JSON.stringify(seen[first])}\n  ${surface}: ${JSON.stringify(seen[surface])}\n`
        + '  A component can defend itself, but only itself; the next one mounted here inherits this.',
      );
    }
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('#516 mechanical: no surface styles a bare interactive element in its inline stylesheet', () => {
  // Supporting check, not the load-bearing one — it names the class of mistake
  // so a reviewer recognises it, while the probe test above is what proves the
  // property. Scoped to interactive//form elements, which are the ones shared
  // components are actually built from; `h1`/`code`/`legend` are page furniture
  // and a shared component has no business inheriting from them either, but
  // they have never caused this and a rule nobody breaks is noise.
  const BARE = /^\s*(button|input|select|textarea|label|form)\s*[,{:]/;
  const offenders = [];
  for (const f of ['index.html', 'wiki.html', 'commons.html', 'settings.html']) {
    const src = fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8');
    const styles = src.match(/<style>[\s\S]*?<\/style>/g) || [];
    for (const block of styles) {
      block.split('\n').forEach((line) => {
        if (BARE.test(line) && !/^\s*\/\*/.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
      });
    }
  }
  assert.deepEqual(offenders, [],
    `a page styles a bare interactive element — anything mounted there inherits it:\n${offenders.join('\n')}`);
});
