/**
 * #509 — every interactive target on a card (except the condemned
 * `.desc-toggle`) meets WCAG 2.5.8's 24×24 CSS-pixel minimum. RED-first,
 * non-author bar (Wren), from the card's pre-registered acceptance.
 *
 * Card work items, enumerated per checklist item 10, and where each lives:
 *   1. sweep other interactive targets vs 24×24, count with command → THIS
 *      FILE (the sweep is the test; the count is in the offense output)
 *   2. each reads as a control to a stranger → beneficiary tier, Michael's —
 *      not automatable, recorded on the card
 *   3. both states → the two tests below (populated / fresh clone creating
 *      its cards)
 *   4. pair-level bar with #510 (one affordance, rg desc-toggle → 0) → runs
 *      at PAIR close, Wren's verification, not this RED
 *
 * `.desc-toggle` is EXCLUDED by steward ruling 21:22 — condemned, #510
 * deletes it; nobody enlarges a control whose death warrant is signed.
 *
 * Vacuity guard: the sweep must FIND the known controls (edit, page,
 * move-left, move-right) — a selector drift that finds nothing must fail
 * loudly, not pass an empty list (#499's lesson, the empty-sweep variant).
 *
 * ⚠️ GEOMETRY-MEASUREMENT TRAP (Indigo's retraction, 2026-07-27): a HIDDEN
 * tab freezes the document animation timeline, so a page with a transform
 * entrance animation (cardAppear: scale .97) reads every box ~3% small,
 * permanently, and it looks exactly like real data — her live sweep reported
 * 23×23 for controls that are 24.0. This suite defends both directions: it
 * runs in headless pages that report visible, AND it awaits animation-idle
 * before measuring, so neither a frozen nor an in-flight animation can
 * corrupt the numbers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const MIN = 24; // WCAG 2.5.8 minimum target size, CSS px

function syntheticRosterFile() {
  const p = path.join(os.tmpdir(), `roster-509-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({
    seats: { zephyr: { name: 'Zephyr', glyph: '◇', color: '#7cc4a0' } },
  }));
  return p;
}

function populatedBoard() {
  return makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 'Anchor',
      description: 'A description long enough that every card control renders, with several sentences of ordinary prose so nothing is collapsed away for want of content in the fixture.',
      type: 'task', assignees: ['zephyr'], labels: ['infra'], for: '', priority: 'p1',
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }, {
      id: 'c2', shortId: 2, title: 'Second', description: 'short', type: 'task',
      assignees: ['zephyr'], labels: [], for: '', priority: null, column: 'planned',
      order: 0, createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
    }],
    nextShortId: 3,
  });
}

/**
 * Sweep: every interactive element inside .card — buttons, links, and
 * data-action carriers — except the condemned .desc-toggle. Hover each card
 * first so hover-revealed controls are measured in their interactive state.
 * Command of record (the human-runnable form): open a card in devtools and
 * measure each button/a/[data-action] bounding box against 24×24.
 */
async function sweepCard(page, cardSel) {
  // NO hover before measuring. The bar is the size a pointer must ACQUIRE,
  // and you cannot hover a control you haven't reached — a hover-grown box
  // is the size of the target after you already hit it.
  // (Correction on the record, 2026-07-27: a mid-build green flip was first
  // blamed on hover-enlargement in an earlier draft of this comment. The
  // actual cause was the GRADER RUNNING AGAINST THE BUILDER'S UNCOMMITTED
  // WORK-IN-PROGRESS — builder and grader share one checkout, and the fix
  // had already landed in the working tree. Bar runs are only meaningful
  // against a pinned commit; a wrong mechanism nearly shipped in this very
  // comment, same shape as every other unqueried claim today.)
  // Let entrance/hover animations settle before reading geometry — a box
  // measured mid-flight is the same corrupt number as one measured frozen.
  // BOUNDED: an infinite animation (a pulse, a spinner) has a `finished`
  // promise that never resolves, and awaiting it unbounded hung this very
  // suite for 300s on first try (watched, 2026-07-27). The race caps the
  // wait; entrance transforms complete in well under a second.
  await page.evaluate(() => Promise.race([
    Promise.allSettled(document.getAnimations().map((a) => a.finished)),
    new Promise((r) => setTimeout(r, 1200)),
  ]));
  return page.evaluate(({ cardSel, MIN }) => {
    const card = document.querySelector(cardSel);
    const targets = [...card.querySelectorAll('button, a, [data-action], input, select')]
      .filter((el) => !el.classList.contains('desc-toggle'))
      // WCAG 2.5.8 inline exemption: targets "in a sentence or block of
      // text" (e.g. #NNN shortid links inside descriptions) are exempt —
      // 24px click boxes inside running prose would damage the reading
      // surface #496 fixed. Excluded WITH the reason, not quietly dropped
      // (Indigo's live-sweep categorization, 2026-07-27).
      .filter((el) => !el.closest('.card-description, .prose'))
      .filter((el) => el.offsetParent !== null);
    const cardRect = card.getBoundingClientRect();
    const boxes = targets.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        desc: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || '').trim().slice(0, 16)}"`,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        ok: r.width >= MIN && r.height >= MIN,
        // Anti-inflation guard (the degenerate solution Indigo named against
        // herself): a target padded past the card's own bounds is inflation,
        // not accessibility.
        inBounds: r.left >= cardRect.left - 2 && r.right <= cardRect.right + 2
          && r.top >= cardRect.top - 2 && r.bottom <= cardRect.bottom + 2,
      };
    });
    // Second inflation guard: no two targets on a card may overlap — passing
    // 24×24 by growing controls into each other is a mess, not a fix.
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].rect, b = boxes[j].rect;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) overlaps.push(`${boxes[i].desc} overlaps ${boxes[j].desc} (${ox.toFixed(0)}×${oy.toFixed(0)}px)`);
      }
    }
    return { boxes, overlaps };
  }, { cardSel, MIN });
}

async function runSweep(page, offenses, stateName) {
  const cardSels = await page.$$eval('.card', (els) => els.map((e) => `.card[data-id="${e.dataset.id}"]`));
  assert.ok(cardSels.length >= 1, 'need at least one rendered card');
  let found = 0;
  const seenKinds = new Set();
  for (const sel of cardSels) {
    const { boxes, overlaps } = await sweepCard(page, sel);
    found += boxes.length;
    for (const t of boxes) {
      seenKinds.add(t.desc.split(' ')[0]);
      if (!t.ok) offenses.push(`[${stateName}] ${sel} ${t.desc} is ${t.w}×${t.h} (< ${MIN}×${MIN})`);
      if (!t.inBounds) offenses.push(`[${stateName}] ${sel} ${t.desc} extends past the card's bounds — inflation, not accessibility`);
    }
    for (const o of overlaps) offenses.push(`[${stateName}] ${sel} ${o}`);
  }
  // Vacuity guard: the known controls must be in the sweep.
  const flat = [...seenKinds].join(' | ');
  for (const expected of ['card-edit-btn', 'card-move-left', 'card-move-right', 'card-page-btn']) {
    assert.ok(flat.includes(expected),
      `sweep failed to find ${expected} — selector drift would pass an empty list; saw: ${flat}`);
  }
  return found;
}

test('#509 populated: every interactive card target except .desc-toggle meets 24×24', async () => {
  const rosterFile = syntheticRosterFile();
  const server = await startRestServer({ board: populatedBoard(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });
    const offenses = [];
    const count = await runSweep(page, offenses, 'populated');
    assert.deepEqual(offenses, [],
      `hit-target offenses (${offenses.length} of ${count} targets swept):\n${offenses.join('\n')}`);
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});

test('#509 fresh clone: cards created via the API meet the same target minimum', async () => {
  const rosterFile = syntheticRosterFile();
  const server = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const r = await fetch(`${server.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fresh', assignee: 'zephyr', column: 'backlog', type: 'task', description: 'created by the fixture — an empty sweep verifies nothing' }),
    });
    assert.ok(r.ok, `fixture create failed: ${r.status}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });
    const offenses = [];
    const count = await runSweep(page, offenses, 'fresh-clone');
    assert.deepEqual(offenses, [],
      `hit-target offenses (${offenses.length} of ${count} targets swept):\n${offenses.join('\n')}`);
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});
