/**
 * #801 — THE RETRIEVAL MISS LOG, made durable and queryable.
 *
 * ⛔ THE CARD'S OWN PREMISE IS FALSE, AND MEASURING IT IS WHAT PRODUCED THIS.
 *
 * #801 states: "Automatic capture is NOT available. Nothing on the board can
 * observe a seat reaching for `grep`; only our own harnesses can." It therefore
 * built the cheapest voluntary thing — a card and comments — and named its own
 * falsification: "if this card has zero entries in a week, the voluntary
 * mechanism failed and THAT is the finding."
 *
 * Measured 2026-08-18:
 *
 *   #801 comments                12   ⇐ so it IS built, and §IV listed it NOT BUILT
 *   all of them dated            2026-08-13
 *   entries in the five days since  0
 *
 * ⇒ Not the zero it predicted. WORSE, and more informative: it fired once, on
 *   the day it was created while everyone was watching, and never again. A rail
 *   that fires on remembering, decaying exactly as that class does.
 *
 * ⭐ AND AUTOMATIC CAPTURE ALREADY EXISTED WHEN THE CARD DENIED IT. #656 step 2
 * shipped `[card-query] seat=… unsupported=… url=…` — a retrieval need recorded
 * at the moment it was felt, with the seat that felt it, requiring nobody to
 * remember anything. Fourteen captures sit in the live log right now, and the
 * real signal in them is sharp: `q` (free-text search) wanted FOUR times.
 *
 * ⭐ AND THAT SIGNAL WAS ACTED ON: #656 shipped `q` the same day, which is the
 * log doing its whole job — a need recorded at the moment it was felt, ranked by
 * demand, then built. The fixtures below moved to `sortBy` because `q` stopped
 * being a miss. A roadmap that never converges was never a roadmap.
 *
 * ⛔ SO WHY IT STILL NEEDED BUILDING: `console.warn` goes to a launchd stderr
 * file. It is not queryable, it is not in the graph, and it does not survive a
 * log rotation or a fresh deployment. The board's most honest signal about its
 * own retrieval gaps was being written to something nobody reads and nothing
 * keeps.
 *
 * ⚠️ WHAT THIS DOES NOT DO: it cannot see a seat reach for `grep`. #801's real
 * point stands for that population. This captures only misses that ARRIVE AT
 * THE DOOR — someone asked the board for something it could not give. That is a
 * strict subset, and the endpoint says so rather than implying coverage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** Where the server persists misses, derived the same way the server derives it. */
const missLogPathFor = (boardFile) => boardFile.replace(/\.json$/, '') + '-misses.jsonl';

async function misses(baseUrl) {
  const res = await fetch(`${baseUrl}/api/misses`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

test('#801 an unsupported filter is captured as a durable, queryable miss', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const before = await misses(s.baseUrl);
    assert.equal(before.total, 0, 'control: a fresh board has recorded no misses');

    // ⚠️ This test used `q` until #656 shipped free-text search, at which point
    // `q` became SUPPORTED and the fixture silently stopped exercising a miss.
    // ⭐ That is the loop working: the miss log named `q` as the top unmet need,
    // it got built, and the test that assumed it missing went red. A fixture
    // that assumes a capability is absent has a shelf life, and this one's
    // expiry was the feature landing.
    await fetch(`${s.baseUrl}/api/cards?sortBy=title&as=ada`);

    const after = await misses(s.baseUrl);
    assert.equal(after.total, 1, 'the miss was recorded');
    assert.equal(after.misses[0].param, 'sortBy');
    assert.equal(after.misses[0].seat, 'ada', 'WITH the seat who needed it — #801\'s requirement');
    assert.ok(after.misses[0].at, 'and when');
  } finally { await s.stop(); }
});

test('#801 misses are ranked by demand — the roadmap the comment already claimed', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    for (let i = 0; i < 3; i++) await fetch(`${s.baseUrl}/api/cards?sortBy=title&as=ada`);
    await fetch(`${s.baseUrl}/api/cards?groupBy=column&as=grace`);

    const m = await misses(s.baseUrl);
    assert.equal(m.total, 4);
    // ⭐ A LIST, NOT A NUMBER. A bare count is a number nobody can act on; the
    // ranked params, with who wanted each, are the actionable thing. The same
    // distinction shows up wherever a summary replaces its members: "0
    // vulnerabilities" versus the eight named ones, "45% isolated" versus the
    // 94 cards you could actually go and fix.
    assert.deepEqual(m.byParam, [
      { param: 'sortBy', count: 3, seats: ['ada'] },
      { param: 'groupBy', count: 1, seats: ['grace'] },
    ], 'ranked by real demand, naming who wanted each');
  } finally { await s.stop(); }
});

test('#801 a miss is written to DISK, so it outlives the process that saw it', async () => {
  // ⛔ THE LOAD-BEARING TEST. The capture already existed and went to stderr —
  // not queryable, and gone on the next deploy. If a miss lives only in the
  // server's memory this slice has changed nothing that mattered, and an
  // endpoint that answers correctly while the process is alive would hide that
  // completely.
  //
  // ⚠️ Asserted against the FILE rather than by restarting a second server: the
  // harness mints a fresh board file per server and deletes it on stop, so two
  // harness servers cannot share state by construction. Reading the artifact
  // after the process is killed proves the same property without pretending to
  // a restart the harness cannot actually perform.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const boardFile = s.boardFile;
  try {
    await fetch(`${s.baseUrl}/api/cards?sortBy=persisted&as=ada`);
    assert.equal((await misses(s.baseUrl)).total, 1, 'recorded while alive');
  } finally { await s.stop(); }

  const missFile = missLogPathFor(boardFile);
  assert.ok(fs.existsSync(missFile),
    `nothing was persisted — the miss existed only in memory (looked in ${missFile})`);
  const lines = fs.readFileSync(missFile, 'utf8').trim().split('\n').filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].param, 'sortBy');
  assert.equal(rows[0].seat, 'ada');
  fs.rmSync(missFile, { force: true });
});

test('#801 the endpoint states the population it CANNOT see', async () => {
  // ⚠️ #857 §IV and #866's shared lesson: a health signal blind to part of its
  // population must say so in the same place it reports. This log sees only
  // misses that reached the door. A seat reaching for grep is invisible to it,
  // and #801's entire argument was about that population.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const m = await misses(s.baseUrl);
    assert.match(m.covers, /arriv|door|reach/i,
      'the payload must name what it captures');
    assert.match(m.blindTo, /grep|elsewhere|outside|tool/i,
      'and must name what it cannot see — otherwise a low number reads as "few misses" '
      + 'when it means "few misses OF THE KIND WE CAN SEE"');
  } finally { await s.stop(); }
});

test('#801 a supported query records NOTHING — the paired control', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await fetch(`${s.baseUrl}/api/cards?column=backlog&as=ada`);
    await fetch(`${s.baseUrl}/api/cards?label=x&as=ada`);
    await fetch(`${s.baseUrl}/api/cards?q=now-supported&as=ada`);  // #656 — supported, must not record
    const m = await misses(s.baseUrl);
    assert.equal(m.total, 0,
      'a door that records a miss when it succeeded would make the roadmap noise');
  } finally { await s.stop(); }
});
