/**
 * #661 F1 — the coordination rail, visible to humans at last.
 *
 * `claimedBy`/`claimedAt` have been stored and API-served since #348, and
 * agents coordinate on them all day — but zero HTML pages rendered them, so
 * the humans this board belongs to could never see who holds what. The
 * measured cost: three stale claims sat unnoticed for weeks (#647), and the
 * audit (#661) named the invisibility as finding 1, marked DEBT.
 *
 * The chip also delivers step 1 of #455's staged plan verbatim: "surface
 * claim age in the UI; a claim older than a working session isn't stale,
 * it's a claim being used as an assignee — surfacing 'held 336h' invites
 * the right question on its own."
 *
 * Contract:
 *   - a claimed card renders a `.card-claim` chip naming the holder
 *   - the chip carries the age (compact: <1h, Nh, Nd) — the #455 observable
 *   - a claim older than 24h gets `.card-claim-stale` so the eye finds it
 *   - an unclaimed card renders NO chip
 *   - the holder string is escaped — claimedBy is caller-supplied (#249's
 *     trust boundary: id/type/priority/assignees are constrained at the API;
 *     claimedBy arrives via the claim endpoint and is not)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';

function rosterFile() {
  const p = path.join(os.tmpdir(), `roster-f1-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({
    seats: { zephyr: { name: 'Zephyr', glyph: '◇', color: '#7cc4a0' } },
  }));
  return p;
}

function card(shortId, extra = {}) {
  return {
    id: `c${shortId}`, shortId, title: `Card ${shortId}`, description: 'body',
    type: 'task', assignees: ['zephyr'], labels: [], for: '', priority: null,
    column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
    relationships: { relatedTo: [], blockedBy: [] },
    claimedBy: null, claimedAt: null,
    ...extra,
  };
}

test('claim chip: holder + age on claimed cards, stale styling past 24h, absent when unclaimed, escaped', async () => {
  const freshAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();      // 10 min
  const staleAt = new Date(Date.now() - 400 * 3600 * 1000).toISOString();   // ~16.7 days
  const server = await startRestServer({
    board: makeBoardFixture({
      cards: [
        card(1, { claimedBy: 'zephyr', claimedAt: freshAt }),
        card(2, { claimedBy: 'zephyr', claimedAt: staleAt }),
        card(3),
        card(4, { claimedBy: '<img src=x onerror=window.__pwned=1>', claimedAt: freshAt }),
      ],
      nextShortId: 5,
    }),
    env: { SCRUM_ROSTER_FILE: rosterFile() },
  });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });

    const chips = await page.evaluate(() => {
      const get = (id) => {
        const el = document.querySelector(`.card[data-id="${id}"] .card-claim`);
        return el ? { text: el.textContent, title: el.title, stale: el.classList.contains('card-claim-stale') } : null;
      };
      return { c1: get('c1'), c2: get('c2'), c3: get('c3'), c4: get('c4'), pwned: window.__pwned === 1 };
    });

    assert.ok(chips.c1, 'fresh claim renders a chip');
    assert.match(chips.c1.text, /zephyr/);
    assert.equal(chips.c1.stale, false, '10-minute claim is not stale');
    assert.match(chips.c1.text, /<1h|0h/, 'age is on the chip — the #455 observable');

    assert.ok(chips.c2, 'old claim renders a chip');
    assert.equal(chips.c2.stale, true, '16-day claim wears the stale style');
    assert.match(chips.c2.text, /16d|17d/, 'age in days for long holds');

    assert.equal(chips.c3, null, 'unclaimed card renders no chip');

    assert.ok(chips.c4, 'hostile holder still renders (as text)');
    assert.equal(chips.pwned, false, 'claimedBy is escaped — no markup execution');
  } finally {
    await browser.close();
    await server.stop();
  }
});
