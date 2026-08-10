/**
 * #755 — the race-corpus detector must be runnable AND its sources must fire.
 *
 * ⚠️ THE BUG THIS LOCKS, which shipped and was caught by luck:
 * relationship edges in the board export are UUIDs (`@id`), not shortIds. The
 * first parser scraped trailing digits off the reference — turning
 * "b575995c-…-6aba6bda8602" into 8602, a shortId that exists nowhere. S1
 * therefore reported ZERO supersession-linked races across the entire board,
 * silently, and read as a fact about the data rather than a broken instrument.
 *
 * ⇒ It was caught only because the output printed a title saying
 *   "[superseded by #389]" while S1 claimed no supersession edges existed at
 *   all. An observed fact contradicted the instrument. Nothing about the code
 *   looked wrong.
 *
 * ⭐ So the test that matters is not "does the script run" — it is "does each
 *   source actually fire on a case where it must." A source that can only ever
 *   return zero passes every smoke test ever written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/race-corpus.mjs', import.meta.url));

const card = (id, uuid, name, dateCreated, extra = {}) => ({
  '@id': uuid,
  '@type': 'CreativeWork',
  identifier: id,
  name,
  dateCreated,
  ...extra,
});

function boardFile(cards) {
  const dir = mkdtempSync(join(tmpdir(), 'race-corpus-'));
  const path = join(dir, 'board-data.json');
  writeFileSync(path, JSON.stringify({ '@graph': cards }));
  return path;
}

function run(args, { expectFail = false } = {}) {
  try {
    return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (expectFail) return `${e.stdout || ''}${e.stderr || ''}__EXIT_${e.status}`;
    throw new Error(`script failed: ${e.stderr || e.message}`);
  }
}

test('#755-race ⭐⭐ S1 FIRES ON A UUID SUPERSESSION EDGE — the false-zero regression', () => {
  // Edges reference @id, never identifier. A parser that expects shortIds here
  // returns zero for every board that has ever existed.
  const board = boardFile([
    card(100, 'uuid-aaa', 'first card about the thing', '2026-08-01T00:00:00.000Z',
      { supersededBy: ['uuid-bbb'] }),
    card(101, 'uuid-bbb', 'wholly unrelated wording so only S1 can fire', '2026-08-01T00:00:10.000Z',
      { supersedes: ['uuid-aaa'] }),
  ]);
  const out = run(['--board', board]);
  assert.match(out, /S1:supersession\s+1/, 'S1 did not fire on a real supersession edge');
  assert.match(out, /#100 \+ #101/);
});

test('#755-race S3 fires on shared distinctive tokens and PRINTS them', () => {
  const board = boardFile([
    card(200, 'u1', 'lightning talk recording portfolio vault intake', '2026-08-01T00:00:00.000Z'),
    card(201, 'u2', 'lightning talk recording into portfolio and vault', '2026-08-01T00:00:20.000Z'),
  ]);
  const out = run(['--board', board]);
  assert.match(out, /S3:tokens\(/);
  assert.match(out, /shared: /, 'the shared tokens must be printed, not just counted');
});

test('#755-race ⛔ a pair OUTSIDE the window is not a candidate, however similar', () => {
  const board = boardFile([
    card(300, 'v1', 'identical wording here for certain matching', '2026-08-01T00:00:00.000Z'),
    card(301, 'v2', 'identical wording here for certain matching', '2026-08-01T00:10:00.000Z'), // 600s
  ]);
  // ⚠️ assert on the POSITIVE statement: /CANDIDATE PAIRS/ also matches
  // "NO CANDIDATE PAIRS", so the obvious negative assertion passes vacuously.
  assert.match(run(['--board', board]), /NO CANDIDATE PAIRS/);
});

test('#755-race ⚠️ TIME ALONE IS NOT A RACE — adjacent cards with unrelated titles are excluded', () => {
  // 220 pairs on the real board fall within 64s of each other. Bulk filing is
  // not a collision, and a purely temporal detector would report all of them.
  const board = boardFile([
    card(400, 'w1', 'question bank for the room catching questions', '2026-08-01T00:00:00.000Z'),
    card(401, 'w2', 'person graph blind to createdBy on filed cards', '2026-08-01T00:00:26.000Z'),
  ]);
  assert.match(run(['--board', board]), /NO CANDIDATE PAIRS/);
});

test('#755-race an empty result SAYS SO rather than printing nothing', () => {
  const board = boardFile([card(500, 'x1', 'a lone card with no neighbour', '2026-08-01T00:00:00.000Z')]);
  const out = run(['--board', board]);
  assert.match(out, /NO CANDIDATE PAIRS/);
  assert.match(out, /result, not an absence/);
});

test('#755-race ⛔ it REFUSES to guess where the board data lives', () => {
  // A hardcoded path is one machine's layout published into a public repo —
  // the same refusal scripts/sprint-review.mjs makes.
  const out = run([], { expectFail: true });
  assert.match(out, /--board is REQUIRED/);
  assert.match(out, /__EXIT_2/);
});

test('#755-race ⛔ a missing board file fails loudly instead of reporting zero races', () => {
  const out = run(['--board', '/nonexistent/board.json'], { expectFail: true });
  assert.match(out, /board file not found/);
  assert.match(out, /__EXIT_2/);
});

test('#755-race the report states its own window and threshold, so the rule is auditable', () => {
  const board = boardFile([card(600, 'y1', 'solo card', '2026-08-01T00:00:00.000Z')]);
  const out = run(['--board', board]);
  assert.match(out, /window: 300s/);
  assert.match(out, /min shared tokens: 3/);
  assert.match(out, /pre-registered on #755/);
});

test('#755-race ⭐ the run is REPRODUCIBLE — same board, byte-identical report', () => {
  const board = boardFile([
    card(700, 'z1', 'compare and swap patch card description', '2026-08-01T00:00:00.000Z'),
    card(701, 'z2', 'card patch compare and swap missing entirely', '2026-08-01T00:00:30.000Z'),
  ]);
  assert.ok(existsSync(SCRIPT));
  assert.equal(run(['--board', board]), run(['--board', board]));
});
