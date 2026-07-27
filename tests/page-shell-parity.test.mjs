/**
 * #496 — page-shell parity suite. RED-first, written from the card's
 * pre-registered acceptance BEFORE the first build commit (lane adopted
 * 2026-07-26: Wren authors the bar, Indigo builds to green).
 *
 * The disease this suite exists to catch: four surfaces drifting from each
 * other — four headers, four width strategies, four type sizes — while a test
 * named "parity" stays green because it asserts membership, not equality
 * (see the card's ⭐ section on tests/nav-e2e.test.mjs).
 *
 * The design decision it encodes (card #496, "THE WIDTH/TYPE DECISION",
 * settled 2026-07-26 21:45Z — the suite parameterizes the CHOICE, it does not
 * presuppose a shape):
 *   1. page container fluid, no cap — width tracks the viewport on every
 *      surface, zero per-page max-width
 *   2. rem-anchored bounded fluid type — body font-size grows with the
 *      viewport AND with the browser's default-font-size preference
 *   3. prose measure 65ch on the text class, running text only
 *   4. prose line-height 1.6
 *   5. prose contrast ≥ WCAG AA in both themes
 *
 * CONTRACT SELECTORS (the suite's interface with the builder — change the
 * constants, not the assertions, if the shell ships different names):
 *   [data-page-shell]  the one shared shell element, mounted on all four
 *                      surfaces, owning header + nav + width
 *   .prose             the running-text class from theme.css (wiki body,
 *                      commons message bodies, card descriptions)
 *
 * Probe scope note: the card names two anchor probes — 200% browser zoom and
 * 200% default-font-size preference. This suite ships the PREFERENCE probe
 * (the stricter of the two: a px type scale passes zoom and fails preference).
 * The zoom probe runs in Wren's live-Chrome path-walk with screenshot
 * receipts, because headless CDP has no true browser-zoom lever.
 *
 * "A recommendation is a direction; an assertion is a contract." — MiniMo,
 * 2026-07-26. The assertions below are the contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const SHELL = '[data-page-shell]';
const PROSE = '.prose';

const VIEWPORTS = [480, 768, 1024, 1442]; // the #499 set
const SURFACES = ['/', '/wiki.html', '/commons.html', '/settings.html'];
const EXPECTED_NAV = ['▦ Board', '📖 Wiki', '💬 Commons', '⚙️ Settings'];

const ts = '2026-05-01T00:00:00.000Z';

/** Populated state: enough content that prose actually renders. */
function populatedBoard() {
  return makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 'Anchor card',
      description: 'A long enough description that running text exists somewhere on the board surface, with several sentences of ordinary prose to give the measure something to measure.',
      type: 'reference', assignees: ['sage'], labels: [], for: '', priority: null,
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }],
    conversations: [{
      id: 'm1',
      body: 'A commons message with enough ordinary prose in it that the running-text class has real text to lay out. The eye needs a return sweep; the measure gives it one. This sentence exists to make the paragraph wrap at least once at every viewport in the set.',
      author: 'sage', attachedTo: null, createdAt: ts,
    }],
    nextShortId: 2,
  });
}

/** Empty state: the fresh-clone experience — makeBoardFixture() untouched. */
function emptyBoard() {
  return makeBoardFixture();
}

// ---------------------------------------------------------------------------
// Mechanical criterion — REFINED from the card's original wording after a
// watched run. `rg -n 'max-width' *.html → 0` over-condemns: 18 hits today,
// but ~11 are legitimate component widths (attachment chips, image bounds,
// slide-in panels, toasts) that SHOULD survive the shell. The disease is the
// PAGE-CONTAINER width strategies: 760px (wiki), 860px (commons ×4), 640px
// (settings). Command of record: rg -n 'max-width:\s*(640|760|860)px' *.html → 0
// Drift to a NEW container value slips this net by design — the computed
// cross-surface width equality below is the assertion that catches it.
// ---------------------------------------------------------------------------
test('#496 mechanical: the per-page container width strategies (640/760/860px) are gone from *.html', () => {
  const offenders = [];
  const CONTAINER_WIDTH = /max-width:\s*(640|760|860)px/;
  for (const f of SURFACES.map((s) => (s === '/' ? 'index.html' : s.slice(1)))) {
    const file = path.join(PROJECT_DIR, f);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (CONTAINER_WIDTH.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    `per-page container width strategies survive (rg -n 'max-width:\\s*(640|760|860)px' *.html should be empty):\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Browser-measured parity, both states × all viewports.
// ---------------------------------------------------------------------------
async function collectSurfaceMetrics(page, baseUrl, surfacePath, viewport) {
  await page.setViewport({ width: viewport, height: 900 });
  const pageErrors = [];
  const onErr = (e) => pageErrors.push(`pageerror: ${e.message}`);
  const onCon = (msg) => { if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`); };
  page.on('pageerror', onErr);
  page.on('console', onCon);
  try {
    await page.goto(`${baseUrl}${surfacePath}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.topnav .navlink', { timeout: 5000 });
    const metrics = await page.evaluate((SHELL_SEL) => {
      const nav = document.querySelector('.topnav');
      const navRect = nav ? nav.getBoundingClientRect() : null;
      const header = nav ? nav.parentElement : null;
      const headerRect = header ? header.getBoundingClientRect() : null;
      const shell = document.querySelector(SHELL_SEL);
      const firstLink = document.querySelector('.topnav .navlink');
      const linkStyle = firstLink ? getComputedStyle(firstLink) : null;
      return {
        navLabels: [...document.querySelectorAll('.topnav .navlink')].map((e) => e.textContent.trim()),
        // Third divergence axis (Indigo's measured baseline, 2026-07-26):
        // the board ships fat links (padding 8px 14px, flex:0 0 auto) while
        // the other three ship thin ones (8px 0, flex:1 1 0%). A shell can
        // standardize position and width and still leave this.
        navLinkStyle: linkStyle ? `${linkStyle.padding} | ${linkStyle.flex}` : null,
        // Alignment signature: where the nav sits inside its header row,
        // normalized so it compares across viewports. left≈0 → left-aligned,
        // right≈0 → right-aligned, both large and equal → centered.
        navAlign: navRect && headerRect ? {
          leftGap: +(navRect.left - headerRect.left).toFixed(0),
          rightGap: +(headerRect.right - navRect.right).toFixed(0),
        } : null,
        shellPresent: !!shell,
        shellWidth: shell ? +shell.getBoundingClientRect().width.toFixed(1) : null,
        bodyFontPx: parseFloat(getComputedStyle(document.body).fontSize),
        innerWidth: window.innerWidth,
      };
    }, SHELL);
    assert.deepEqual(pageErrors, [], `${surfacePath} @${viewport}px page errors: ${pageErrors.join(' | ')}`);
    return metrics;
  } finally {
    page.off('pageerror', onErr);
    page.off('console', onCon);
  }
}

for (const [stateName, makeBoard] of [['populated', populatedBoard], ['empty', emptyBoard]]) {
  test(`#496 parity (${stateName} state): shell, nav order, alignment, width, and type agree on all four surfaces at every viewport`, async () => {
    const server = await startRestServer({ board: makeBoard() });
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
      const page = await browser.newPage();
      const byViewport = new Map();
      // One run reports the WHOLE punch list, not just the first miss —
      // failures collect here and a single deepEqual([]) closes the test.
      const offenses = [];

      for (const vw of VIEWPORTS) {
        const perSurface = new Map();
        for (const s of SURFACES) {
          perSurface.set(s, await collectSurfaceMetrics(page, server.baseUrl, s, vw));
        }
        byViewport.set(vw, perSurface);

        const ref = perSurface.get('/');
        for (const s of SURFACES) {
          const m = perSurface.get(s);

          // Nav items: exact order equality. NOTE (watched run, 2026-07-26):
          // this is GREEN today — core/header.mjs already renders one shared
          // four-item nav on all four pages, and the board's fifth control is
          // an adjacent button, not a nav entry (Indigo's read of the four
          // surfaces, confirmed by this suite's first run). It stays as the
          // regression guard the old membership test failed to be; it is not
          // one of the RED teeth.
          if (JSON.stringify(m.navLabels) !== JSON.stringify(EXPECTED_NAV)) {
            offenses.push(`${s} @${vw}px nav must be exactly [${EXPECTED_NAV.join(', ')}], saw [${m.navLabels.join(', ')}]`);
          }

          // Alignment: same signature as the board surface, within 8px.
          if (!(m.navAlign && ref.navAlign
            && Math.abs(m.navAlign.leftGap - ref.navAlign.leftGap) <= 8
            && Math.abs(m.navAlign.rightGap - ref.navAlign.rightGap) <= 8)) {
            offenses.push(`${s} @${vw}px nav alignment ${JSON.stringify(m.navAlign)} differs from board ${JSON.stringify(ref.navAlign)}`);
          }

          // Nav link chrome: same computed padding + flex on every surface.
          if (m.navLinkStyle !== ref.navLinkStyle) {
            offenses.push(`${s} @${vw}px navlink style "${m.navLinkStyle}" differs from board "${ref.navLinkStyle}"`);
          }

          // Shell: the one shared component, present everywhere.
          if (!m.shellPresent) {
            offenses.push(`${s} @${vw}px has no ${SHELL} — the shared shell is not mounted`);
          }

          // Width: equal across surfaces at this viewport, within 1px.
          if (!(m.shellWidth !== null && ref.shellWidth !== null
            && Math.abs(m.shellWidth - ref.shellWidth) <= 1)) {
            offenses.push(`${s} @${vw}px shell width ${m.shellWidth} differs from board ${ref.shellWidth}`);
          }

          // Type: same computed body font-size across surfaces, within 0.1px.
          if (Math.abs(m.bodyFontPx - ref.bodyFontPx) > 0.1) {
            offenses.push(`${s} @${vw}px body font-size ${m.bodyFontPx}px differs from board ${ref.bodyFontPx}px`);
          }
        }
      }

      // Fluidity across viewports (decision parts 1 & 2):
      const w480 = byViewport.get(480).get('/');
      const w1442 = byViewport.get(1442).get('/');
      // Page container tracks the viewport — no cap anywhere in the set.
      if (!(w1442.shellWidth > w480.shellWidth * 1.5)) {
        offenses.push(`shell width must track the viewport (fluid, no cap): ${w480.shellWidth}px @480 → ${w1442.shellWidth}px @1442`);
      }
      // Fluid type: strictly larger at 1442 than at 480.
      if (!(w1442.bodyFontPx > w480.bodyFontPx)) {
        offenses.push(`body font-size must grow with the viewport (fluid type): ${w480.bodyFontPx}px @480 → ${w1442.bodyFontPx}px @1442`);
      }

      assert.deepEqual(offenses, [],
        `${stateName} state parity offenses (${offenses.length}):\n${offenses.join('\n')}`);
    } finally {
      await browser.close();
      await server.stop();
    }
  });
}

// ---------------------------------------------------------------------------
// REOPEN TEETH (2026-07-27, Michael's live walk — #496 reopened). Three
// certified tiers passed a card that didn't meet its own written scope: work
// item 2 reads `[ title ] [ destinations ] [ utility cluster ]` and the TITLE
// half was never built, never asserted, never cold-waked — a correlated blind
// spot, because every tier checked the same READING of the card instead of
// enumerating what the card wrote. These two teeth are the missing half.
// Contract selector: [data-product-mark] — the product title inside the
// shell head, same mark on every surface.
// ---------------------------------------------------------------------------
test('#496 reopen: every surface carries the same product mark in the shell head', async () => {
  const server = await startRestServer({ board: populatedBoard() });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });
    const marks = [];
    for (const s of SURFACES) {
      await page.goto(`${server.baseUrl}${s}`, { waitUntil: 'networkidle0' });
      marks.push(await page.evaluate((SHELL_SEL) => {
        const el = document.querySelector(`${SHELL_SEL} .shell-head [data-product-mark], ${SHELL_SEL} [data-product-mark]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: el.textContent.trim(), left: +r.left.toFixed(0), top: +r.top.toFixed(0) };
      }, SHELL));
    }
    const offenses = [];
    marks.forEach((m, i) => {
      if (!m) offenses.push(`${SURFACES[i]} has no [data-product-mark] in the shell — the title half of work item 2 is missing`);
    });
    const present = marks.filter(Boolean);
    if (present.length > 1) {
      const ref = present[0];
      marks.forEach((m, i) => {
        if (!m) return;
        if (m.text !== ref.text) offenses.push(`${SURFACES[i]} product mark "${m.text}" differs from "${ref.text}"`);
        if (Math.abs(m.left - ref.left) > 8 || Math.abs(m.top - ref.top) > 8) {
          offenses.push(`${SURFACES[i]} product mark position (${m.left},${m.top}) differs from (${ref.left},${ref.top})`);
        }
      });
    }
    assert.deepEqual(offenses, [], `product-mark offenses (${offenses.length}):\n${offenses.join('\n')}`);
  } finally {
    await browser.close();
    await server.stop();
  }
});

/**
 * The width claim fails on the board: at 1442 the board's columns overflow to
 * ~1728, the shell header stays viewport-sized, and a horizontal scroll drags
 * the header off-screen — "header area is fixed width but the page is however
 * many columns wide… jarring" (Michael). "One width rule, applied everywhere"
 * was underspecified for content wider than the window. Design-agnostic bar:
 * EITHER the document does not scroll horizontally (the board pans inside its
 * own container under a full-width header) OR, after scrolling the document
 * fully right, the shell head still spans the visible viewport. Both accepted
 * fixes pass; today's dangling header fails.
 */
test('#496 reopen: the shell head never detaches from the viewport on an overflowing board', async () => {
  // Eight columns force horizontal overflow at 1024 in ANY column layout.
  const wideBoard = makeBoardFixture({
    columns: Array.from({ length: 8 }, (_, i) => ({ id: `col${i}`, name: `Column ${i}`, order: i })),
    cards: [{
      id: 'w1', shortId: 1, title: 'Wide anchor', description: 'x', type: 'task',
      assignees: ['sage'], labels: [], for: '', priority: null, column: 'col0',
      order: 0, createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
    }],
    nextShortId: 2,
  });
  const server = await startRestServer({ board: wideBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });

    const probe = await page.evaluate(() => {
      const doc = document.scrollingElement;
      const docScrolls = doc.scrollWidth > window.innerWidth + 1;
      if (docScrolls) doc.scrollLeft = doc.scrollWidth; // far right
      const head = document.querySelector('[data-page-shell] .shell-head');
      const r = head ? head.getBoundingClientRect() : null;
      return {
        docScrolls,
        scrollWidth: doc.scrollWidth,
        innerWidth: window.innerWidth,
        headRect: r ? { left: +r.left.toFixed(0), right: +r.right.toFixed(0) } : null,
      };
    });

    assert.ok(probe.headRect, 'shell head must exist on the board');
    if (probe.docScrolls) {
      assert.ok(probe.headRect.left <= 0 && probe.headRect.right >= probe.innerWidth,
        `scrolled fully right (scrollWidth ${probe.scrollWidth}, viewport ${probe.innerWidth}), ` +
        `the shell head spans [${probe.headRect.left}, ${probe.headRect.right}] and has detached from the viewport`);
    }
    // If the document does not scroll horizontally, the board pans internally
    // under a full-width header — the other accepted design; nothing to assert.
  } finally {
    await browser.close();
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Prose contract (populated state only — empty state has no running text):
// 65ch measure, 1.6 leading, AA contrast in both themes.
// ---------------------------------------------------------------------------
test('#496 prose: .prose carries 65ch measure, 1.6 line-height, and AA contrast in both themes', async () => {
  const server = await startRestServer({ board: populatedBoard() });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });

    // WIKI FIRST — the surface where losing the measure hurts most. Its
    // current 760px article rule IS a prose measure in disguise (Indigo's
    // width-table correction, 2026-07-26): the fix RELOCATES it to the .prose
    // class in ch, it does not merely delete it. Without this assertion, the
    // mechanical zero-count could be satisfied by deletion — wiki text would
    // run ~150 characters at 1442px and the suite would smile. Guard: the
    // wiki article body must carry the prose class.
    await page.goto(`${server.baseUrl}/wiki.html?node=1`, { waitUntil: 'networkidle0' });
    const wikiProse = await page.$$eval(PROSE, (els) => els.length).catch(() => 0);
    assert.ok(wikiProse > 0,
      `no ${PROSE} element on the wiki article surface — the prose measure is missing exactly where losing it costs most`);
    // The wiki's own type must ride the shared scale. This is the tooth the
    // 2026-07-26 plant-probe proved missing: `article { font-size: 15.5px }`
    // passed the whole suite because every type assertion looked at body.
    const wikiFont = await page.evaluate((PROSE_SEL) => ({
      prose: parseFloat(getComputedStyle(document.querySelector(PROSE_SEL)).fontSize),
      body: parseFloat(getComputedStyle(document.body).fontSize),
    }), PROSE);
    assert.ok(Math.abs(wikiFont.prose - wikiFont.body) <= 0.1,
      `wiki ${PROSE} font-size ${wikiFont.prose}px diverges from body ${wikiFont.body}px — a local override is defeating the shared type scale`);

    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    const proseCount = await page.$$eval(PROSE, (els) => els.length).catch(() => 0);
    assert.ok(proseCount > 0,
      `no ${PROSE} element on commons with a message present — running text has no text class`);

    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      const p = await page.evaluate((PROSE_SEL) => {
        const el = document.querySelector(PROSE_SEL);
        const cs = getComputedStyle(el);
        const bodyFontPx = parseFloat(getComputedStyle(document.body).fontSize);
        // Measure 65ch in this element's own font, for the max-width check.
        const probe = document.createElement('span');
        probe.textContent = '0'.repeat(65);
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
        el.appendChild(probe);
        const chWidth = probe.getBoundingClientRect().width;
        probe.remove();

        // Effective solid background: walk up until a non-transparent bg.
        function bgOf(node) {
          while (node && node !== document.documentElement) {
            const c = getComputedStyle(node).backgroundColor;
            if (c && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent/.test(c)) return c;
            node = node.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
        }
        function lum(cssColor) {
          const m = cssColor.match(/\d+(\.\d+)?/g).map(Number);
          const [r, g, b] = m;
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        }
        const L1 = lum(cs.color);
        const L2 = lum(bgOf(el));
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);

        return {
          maxWidthPx: cs.maxWidth === 'none' ? null : parseFloat(cs.maxWidth),
          chWidth65: chWidth,
          fontPx: parseFloat(cs.fontSize),
          bodyFontPx,
          lineHeightPx: parseFloat(cs.lineHeight),
          contrast: +ratio.toFixed(2),
        };
      }, PROSE);

      // Element-level type overrides hide BELOW a body-only assertion — a
      // planted `article { font-size: 15.5px }` passed this whole suite on
      // 2026-07-26 (watched), which is exactly the hole the wiki carried in
      // production. Prose must ride the shared scale, not a local px.
      assert.ok(Math.abs(p.fontPx - p.bodyFontPx) <= 0.1,
        `[${scheme}] ${PROSE} font-size ${p.fontPx}px diverges from body ${p.bodyFontPx}px — a local override is defeating the shared type scale`);

      assert.ok(p.maxWidthPx !== null,
        `[${scheme}] ${PROSE} has no max-width — prose measure is missing`);
      assert.ok(Math.abs(p.maxWidthPx - p.chWidth65) <= p.chWidth65 * 0.05,
        `[${scheme}] ${PROSE} max-width ${p.maxWidthPx}px is not ≈65ch (${p.chWidth65.toFixed(0)}px in its own font)`);
      const leading = p.lineHeightPx / p.fontPx;
      assert.ok(Math.abs(leading - 1.6) <= 0.05,
        `[${scheme}] ${PROSE} line-height ratio ${leading.toFixed(2)} is not 1.6`);
      assert.ok(p.contrast >= 4.5,
        `[${scheme}] ${PROSE} contrast ${p.contrast}:1 is below WCAG AA (4.5:1)`);
    }
  } finally {
    await browser.close();
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// The anchor-is-real probe (decision part 2): raising the browser's DEFAULT
// FONT SIZE must grow the body text. This is the stricter of the card's two
// probes — a px type scale passes 200% zoom and fails this.
// ---------------------------------------------------------------------------
test('#496 rem anchor: body font-size grows when the browser default font-size preference doubles', async () => {
  const server = await startRestServer({ board: emptyBoard() });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    const cdp = await page.createCDPSession();

    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    const readFont = () => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));

    await cdp.send('Page.setFontSizes', { fontSizes: { standard: 16, fixed: 13 } });
    await page.reload({ waitUntil: 'networkidle0' });
    const at16 = await readFont();

    await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 13 } });
    await page.reload({ waitUntil: 'networkidle0' });
    const at32 = await readFont();

    assert.ok(at32 > at16 * 1.2,
      `body font-size must answer the user's default-font-size preference (rem anchor): ${at16}px at 16, ${at32}px at 32 — a px scale ignores the one lever tired eyes already use`);
  } finally {
    await browser.close();
    await server.stop();
  }
});
