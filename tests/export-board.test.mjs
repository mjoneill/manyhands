/**
 * #465 slice — export-board.mjs: the whole room on disk, losslessly.
 *
 * The property that matters is not formatting, it's **nothing goes missing**.
 * An export is trusted precisely because nobody re-reads 8,000 messages to
 * check it; that trust has to be earned by the tool, not by the reader.
 *
 * The failure this suite exists to catch is the one that nearly shipped:
 * `GET /api/conversations?limit=100000` returns 200 messages, capped
 * server-side, with nothing in the response saying so. An export built on it
 * looks complete and is 2.5% of the room. So the end-to-end test seeds MORE
 * than that cap and asserts every message reaches the files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { packRecords, renderMessage, renderCard, stamp } from '../export-board.mjs';

const EXPORTER = path.join(PROJECT_DIR, 'export-board.mjs');

// ── pure helpers ───────────────────────────────────────────────────────────

test('#465 timestamps render as UTC, and a bad one degrades instead of throwing', () => {
  assert.equal(stamp('2026-05-19T01:40:03.000Z'), '2026-05-19 01:40:03 UTC');
  assert.equal(stamp(''), 'unknown time');
  assert.equal(stamp('not a date'), 'not a date');
});

test('#465 packing never splits a record, and counts the separator it will write', () => {
  const rec = (n, text) => ({ section: 'COMMONS', text });
  const records = Array.from({ length: 20 }, (_, i) => rec(i, 'x'.repeat(100)));
  const parts = packRecords(records, 450);

  // every record lands exactly once, in order, whole
  const flat = parts.flatMap((p) => p.records);
  assert.equal(flat.length, records.length, 'records were lost or duplicated by packing');
  assert.deepEqual(flat.map((r) => r.text), records.map((r) => r.text), 'packing reordered records');

  // the join('\n') byte is counted, so a part's real written size fits
  for (const p of parts) {
    const written = Buffer.byteLength(p.records.map((r) => r.text).join('\n'), 'utf8');
    assert.ok(written <= 450, `a part packs to ${written} bytes against a 450 budget — the separator is uncounted`);
  }
});

test('#465 a record larger than the ceiling gets its own part and is flagged, never truncated', () => {
  const parts = packRecords([
    { section: 'COMMONS', text: 'a'.repeat(50) },
    { section: 'COMMONS', text: 'B'.repeat(5000) },
    { section: 'COMMONS', text: 'c'.repeat(50) },
  ], 1000);
  const huge = parts.find((p) => p.records.some((r) => r.text.startsWith('B')));
  assert.ok(huge, 'the oversized record vanished');
  assert.equal(huge.oversized, true, 'an oversized record must be flagged so the index can disclose it');
  assert.equal(huge.records.map((r) => r.text).join('').includes('B'.repeat(5000)), true,
    'the oversized record was truncated — losing the tail of a long card is the loss nobody notices');
});

test('#465 sections do not share a part', () => {
  const parts = packRecords([
    { section: 'COMMONS', text: 'a' },
    { section: 'CARDS + WIKI', text: 'b' },
  ], 1_000_000);
  assert.equal(parts.length, 2, 'a commons record and a card record were packed into one part');
});

test('#465 a message renders with its author, UTC time and body; a card carries its metadata', () => {
  const m = renderMessage({ author: 'sage', createdAt: '2026-05-19T01:40:03.000Z', body: 'first message' });
  assert.match(m, /\*\*\[2026-05-19 01:40:03 UTC\] sage:\*\*/);
  assert.match(m, /first message/);

  const c = renderCard({
    shortId: 42, title: 'A card', description: 'The body.', type: 'task', column: 'done',
    priority: 'p1', assignees: ['sage'], labels: ['infra'],
    createdAt: '2026-05-19T01:40:03.000Z', updatedAt: '2026-05-20T01:40:03.000Z',
  }, [{ author: 'alex', createdAt: '2026-05-19T02:00:00.000Z', body: 'a homed reply' }]);
  assert.match(c, /## #42 — A card/);
  assert.match(c, /\*\*Column:\*\* done/);
  assert.match(c, /infra/);
  assert.match(c, /### Thread \(1\)/);
  assert.match(c, /a homed reply/, "a card's thread is where the reasoning lives — it must be in the export");
});

// ── end to end: the truncation trap ────────────────────────────────────────

test('#465 every message reaches the files — including past the API\'s 200-message cap', async () => {
  const COUNT = 450;                       // deliberately > the /api/conversations cap of 200
  const board = makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 'Anchor', description: 'Body.', type: 'task',
      assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
      relationships: { relatedTo: [], blockedBy: [] },
    }],
    conversations: [
      // shuffled on purpose: the export must impose the room's order, not trust input order
      ...Array.from({ length: COUNT }, (_, i) => ({
        id: `m${i}`,
        body: `Message number ${i}`,
        author: i % 2 ? 'sage' : 'alex',
        attachedTo: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      })).reverse(),
      { id: 'homed', body: 'homed on the card', author: 'sage', attachedTo: 'c1', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'orph', body: 'attached to a card that is gone', author: 'sage', attachedTo: 'missing-card', createdAt: '2026-03-01T00:00:00.000Z' },
    ],
    nextShortId: 2,
  });

  const server = await startRestServer({ board, staticDir: PROJECT_DIR });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-board-'));
  try {
    // The cap is real and this is the proof it would have bitten.
    const capped = await (await fetch(`${server.baseUrl}/api/conversations?limit=100000`)).json();
    assert.ok(capped.length < COUNT,
      `the API returned ${capped.length} of ${COUNT + 2} — if this ever stops truncating, this test's premise is stale`);

    execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl, '--max-bytes', '60000'],
      { encoding: 'utf8' });

    const files = fs.readdirSync(outDir).filter((f) => f.startsWith('part-'));
    assert.ok(files.length > 1, 'the fixture should have produced several parts');
    const all = files.map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');

    // 1. nothing missing
    for (let i = 0; i < COUNT; i++) {
      assert.ok(all.includes(`Message number ${i}`), `message ${i} of ${COUNT} is not in the export`);
    }
    assert.ok(all.includes('homed on the card'), 'a card-homed message is missing');
    assert.ok(all.includes('attached to a card that is gone'),
      'an orphaned message was dropped — it points at a missing card, which is a reason to surface it, not to lose it');

    // 2. the room's order, oldest first, regardless of input order
    const positions = [0, 1, 2, 100, 300, COUNT - 1].map((i) => all.indexOf(`Message number ${i}`));
    const sorted = [...positions].sort((a, b) => a - b);
    assert.deepEqual(positions, sorted, 'the export is not in chronological order — it must read in the room\'s order');

    // 3. the index tells the truth about what it wrote
    const index = fs.readFileSync(path.join(outDir, '00-INDEX.md'), 'utf8');
    assert.match(index, new RegExp(`Total messages on the board:\\*\\* ${COUNT + 2}\\b`),
      'the index must state the full denominator it received');
    assert.match(index, /node export-board\.mjs/, 'the index must carry the command that reproduces it');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    await server.stop();
  }
});
