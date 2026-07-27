/**
 * #508 — the legacy 'both' assignee sentinel must never mint example seats.
 * RED-first, non-author bar (Wren), written from the card's acceptance before
 * the builder touches anything; Indigo builds to green.
 *
 * The disease (#504's 5th instance): `both` is a pre-#51 sentinel meaning "the
 * two people working on this," and shipped code expands it to the two
 * HARDCODED example seats — so on any configured board a legacy card resolves
 * to two people who do not exist, and on a stranger's board to two people they
 * never named.
 *
 * The card's acceptance, verbatim:
 *   1. "a board configured with a roster that contains neither example seat
 *      must never produce those keys from any input, including legacy 'both'"
 *   2. the mirror — "whatever legacy cards existed still resolve to something
 *      meaningful, not silently emptied"
 * Adopted disposition for the one legacy-reader site (card, 2026-07-26):
 * `both` → `['unassigned']` PLUS a console warning naming the card's shortId —
 * the only option that neither fabricates (minting roster keys) nor hides
 * (silent emptiness).
 *
 * Every seat below is synthetic (zephyr/quill); the fixture roster contains
 * neither example seat, which is the acceptance's stated premise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const EXAMPLE_SEATS = ['alex', 'robin'];

function syntheticRosterFile() {
  const p = path.join(os.tmpdir(), `roster-508-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({
    seats: {
      zephyr: { name: 'Zephyr', glyph: '◇', color: '#7cc4a0' },
      quill: { name: 'Quill', glyph: '✒', color: '#c48ab0' },
    },
  }));
  return p;
}

// ---------------------------------------------------------------------------
// Tooth 1 — API input path (server.js). A legacy `assignee: 'both'` arriving
// over the wire must not mint example seats AND must not survive as a literal
// 'both' assignee. A refusal (4xx) also satisfies the bar — the card's
// disposition deletes the validation exemption, making 'both' invalid input.
// ---------------------------------------------------------------------------
test('#508 API: assignee "both" on a synthetic-roster board mints no example seats and no literal both', async () => {
  const rosterFile = syntheticRosterFile();
  const server = await startRestServer({
    board: makeBoardFixture(),
    env: { SCRUM_ROSTER_FILE: rosterFile },
  });
  try {
    const res = await fetch(`${server.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'legacy input', assignee: 'both', column: 'backlog', type: 'task' }),
    });

    if (res.ok) {
      // Accepted: then the stored result must be meaningful and roster-honest.
      const cards = (await (await fetch(`${server.baseUrl}/api/cards`)).json());
      const created = (Array.isArray(cards) ? cards : cards.cards).find((c) => c.title === 'legacy input');
      assert.ok(created, 'created card must be retrievable');
      const bad = created.assignees.filter((a) => EXAMPLE_SEATS.includes(a) || a === 'both');
      assert.deepEqual(bad, [],
        `stored assignees ${JSON.stringify(created.assignees)} mint example seats or keep the sentinel`);
      assert.ok(created.assignees.length > 0, 'assignees must not be silently emptied');
    } else {
      // Refused: fine — 'both' became invalid input. Must be a clean 4xx.
      assert.ok(res.status >= 400 && res.status < 500,
        `refusal must be a 4xx, got ${res.status}`);
    }
  } finally {
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Tooth 2 — the legacy-data READER (index.html migrateAssigneesIfNeeded), the
// one site that must NOT simply be deleted. A restored pre-#51 backup carries
// `assignee: 'both'`; the mirror clause says it resolves to something
// meaningful, not silently emptied, and the adopted disposition says the
// conversion is LOUD: a console warning naming the card's shortId.
// ---------------------------------------------------------------------------
test('#508 legacy reader: a restored board carrying assignee "both" converts loudly, not to example seats', async () => {
  const rosterFile = syntheticRosterFile();
  const ts = '2026-05-01T00:00:00.000Z';
  // Legacy shape on purpose: singular `assignee`, no `assignees` array.
  const legacyBoard = makeBoardFixture({
    cards: [{
      id: 'legacy1', shortId: 7, title: 'Pre-51 card', description: 'carried both',
      type: 'task', assignee: 'both', labels: [], for: '', priority: null,
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }],
    nextShortId: 8,
  });
  const server = await startRestServer({
    board: legacyBoard,
    env: { SCRUM_ROSTER_FILE: rosterFile },
  });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    const consoleMessages = [];
    page.on('console', (msg) => consoleMessages.push(msg.text()));

    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card-title, .card', { timeout: 5000 });

    // What the migrated card actually renders. Plain selector on purpose: a
    // first draft walked the DOM with a clever fallback and matched the wrong
    // container, passing vacuously while the page showed "alex robin" plain as
    // day (watched, 2026-07-26 — the probe's convenience feature was the
    // defect, same shape as Indigo's #main fallback the same afternoon).
    const cardText = await page.$eval('.card', (el) => el.textContent.replace(/\s+/g, ' '));
    assert.ok(cardText.includes('Pre-51 card'), `probe grabbed the wrong card: ${cardText.slice(0, 120)}`);

    // Must not resolve to the example seats the roster does not contain —
    // neither as keys nor as their rendered raw-grey names.
    assert.ok(!/\balex\b/i.test(cardText) && !/\brobin\b/i.test(cardText),
      `legacy 'both' card renders example seats on a zephyr/quill board: ${cardText.slice(0, 200)}`);

    // The loud half of the mirror: a console warning naming shortId 7.
    const warned = consoleMessages.some((m) => /both/i.test(m) && /\b7\b|#7/.test(m));
    assert.ok(warned,
      `no console warning names the converted card (shortId 7); console saw: ${consoleMessages.slice(0, 10).join(' | ') || '(nothing)'}`);
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Tooth 3 — mechanical. The three expansion sites share one fingerprint.
// Command of record: rg -n "\['alex', ?'robin'\]" server.js index.html → 0
// (The dead roster filter at index.html:1926 and the validation exemption at
// server.js:437 are covered behaviorally by teeth 1–2: keeping the exemption
// while deleting the expansion stores a literal 'both', which tooth 1 refuses.)
// ---------------------------------------------------------------------------
test('#508 mechanical: no ["alex","robin"] expansion literal survives in shipped code', () => {
  const offenders = [];
  const FINGERPRINT = /\[\s*'alex'\s*,\s*'robin'\s*\]/;
  for (const f of ['server.js', 'index.html']) {
    const lines = fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (FINGERPRINT.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `expansion literals survive (rg -n "\\['alex', ?'robin'\\]" server.js index.html should be empty):\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Tooth 4 — THE READ PATH. Added by #520, 2026-07-27, after this suite's own
// blind spot shipped a regression.
//
// The three teeth above all test the WRITE path: what the API accepts, what a
// legacy board converts to, what literals survive in source. Every one passed.
// Meanwhile #508's fix removed the picker filter — on a comment asserting
// `both` "is not a roster key and never was", which this file's own subject
// disproves — and `both` became a selectable option in the live "Post as"
// author picker. A human could post to the commons as a seat that does not
// exist: exactly the #504 defect, on the surface #504 called correct.
//
// Retiring a sentinel means it stops being OFFERED as well as stops being
// ACCEPTED. A bar that only checks acceptance certifies half a retirement.
//
// Asserted against the RENDERED DOM on purpose: reading `assignableSeats()` is
// how the wrong conclusion was reached the first time.
// ---------------------------------------------------------------------------
test('#520/#508 read path: no picker OFFERS the retired sentinel, on a synthetic roster', async () => {
  const rosterFile = syntheticRosterFile();
  const server = await startRestServer({
    board: makeBoardFixture(),
    env: { SCRUM_ROSTER_FILE: rosterFile },
  });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(server.baseUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#convs-author option', { timeout: 5000 });

    const offered = await page.evaluate(() => ({
      author: [...(document.getElementById('convs-author')?.options || [])].map((o) => o.value),
      assignees: [...document.querySelectorAll('#card-assignees-group input[type=checkbox]')].map((i) => i.value),
    }));

    assert.ok(offered.author.length, 'the author picker rendered empty — the probe is broken, not the product');
    assert.ok(!offered.author.includes('both'),
      `"Post as" offers the retired sentinel: ${offered.author.join(', ')} — a human can author a commons post as a seat that does not exist`);
    assert.ok(!offered.assignees.includes('both'),
      `the assignee picker offers the retired sentinel: ${offered.assignees.join(', ')} — the API refuses it with 400, so the control is dead and the error is undeserved`);

    // …and the real seats DID arrive, so this can't pass by rendering nothing.
    assert.deepEqual(offered.author.slice().sort(), ['quill', 'zephyr'],
      'the author picker should offer exactly the configured roster');
    assert.ok(offered.assignees.includes('unassigned'),
      'unassigned is a pseudo-seat the pickers DO need — over-filtering is its own bug');
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});
