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

test('#465 the index states the variance spec AND the outcome, so "fine" is checkable', async () => {
  const board = makeBoardFixture({
    conversations: Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, body: `Message ${i} `.repeat(40), author: 'sage', attachedTo: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    })),
  });
  const server = await startRestServer({ board, staticDir: PROJECT_DIR });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-tol-'));
  try {
    execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl,
      '--spaces', 'commons', '--max-bytes', '60000', '--tolerance', '5'], { encoding: 'utf8' });
    const index = fs.readFileSync(path.join(outDir, '00-INDEX.md'), 'utf8');

    assert.match(index, /target \*\*0\.06 MB ±5%\*\*/, 'the index must state the target and its tolerance');
    assert.match(index, /ceiling 0\.06 MB/, 'the index must state the derived ceiling');
    assert.match(index, /largest written/, 'the index must state what it actually produced');
    assert.match(index, /all within tolerance/, 'a normal run must say so, not leave the reader to compare numbers');
    assert.match(index, /--tolerance 5/, 'the reproduce command must carry the variance spec');

    // and the claim is true of the bytes on disk
    const ceiling = Math.round(60000 * 1.05);
    for (const f of fs.readdirSync(outDir).filter((n) => n.startsWith('part-'))) {
      const bytes = fs.statSync(path.join(outDir, f)).size;
      assert.ok(bytes <= ceiling, `${f} is ${bytes} bytes, past the ${ceiling} ceiling the index claims`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    await server.stop();
  }
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

// ---------------------------------------------------------------------------
// #523 — the export boundary.
//
// The first version of this tool had no scrub at all, while its sibling
// export-wiki.mjs (#459) refuses to emit a single page on residue. The tool
// with the largest blast radius had the weakest control, and the reason is the
// finding worth keeping: the severance gate watches `git push`, this path never
// goes near git, and nobody asked what guards it.
//
// Default safe, deliberate unsafe. The in-room archive is a real and frequent
// need — it must stay possible, and it must be asked for by name.
// ---------------------------------------------------------------------------

/**
 * A transforms config with one forbidden term and one rewrite rule.
 *
 * NB the two lists use different field names — rules are `{find, replace}`,
 * forbidden entries are `{pattern}`. Writing `{pattern, replacement}` for a
 * rule fails silently: `toRegExp(undefined)` compiles to /undefined/, matches
 * nothing, and the export reports a clean pass having transformed nothing at
 * all. This fixture got that wrong on the first run and the test caught it,
 * which is the only reason the asymmetry is written down here.
 */
function synthTransforms(dir) {
  const p = path.join(dir, 'EXPORT_TRANSFORMS.json');
  fs.writeFileSync(p, JSON.stringify({
    rules: [{ find: 'innerthing', flags: 'gi', replace: 'the component' }],
    forbidden: [{ pattern: 'secretseat', note: 'an in-room seat name' }],
  }, null, 2));
  return p;
}

function boardWithResidue() {
  return makeBoardFixture({
    conversations: [
      { id: 'm1', body: 'a message about innerthing, which the rules rewrite', author: 'sage', attachedTo: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', body: 'a message naming secretseat, which nothing rewrites', author: 'sage', attachedTo: null, createdAt: '2026-01-01T00:00:01.000Z' },
    ],
  });
}

test('#523 default mode REFUSES on residue, names the term, and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-scrub-'));
  const config = synthTransforms(dir);
  const outDir = path.join(dir, 'out');
  const server = await startRestServer({ board: boardWithResidue(), staticDir: PROJECT_DIR });
  try {
    let failed = false, stderr = '';
    try {
      execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl, '--config', config],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { failed = true; stderr = String(err.stderr || ''); }

    assert.equal(failed, true, 'an export carrying a forbidden term must refuse, not warn');
    assert.match(stderr, /secretseat/, 'the refusal must name the surviving term');
    assert.match(stderr, /--raw/, 'the refusal must name the in-room archive escape, or the operator will reach for something worse');
    assert.equal(fs.existsSync(outDir), false,
      'a refused export wrote files anyway — a partial scrub on disk is the artifact this is meant to prevent');
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#523 default mode SCRUBS what the rules cover, and says so in the index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-clean-'));
  const config = synthTransforms(dir);
  const outDir = path.join(dir, 'out');
  // same board, minus the un-rewritable term
  const board = makeBoardFixture({
    conversations: [{ id: 'm1', body: 'a message about innerthing', author: 'sage', attachedTo: null, createdAt: '2026-01-01T00:00:00.000Z' }],
  });
  const server = await startRestServer({ board, staticDir: PROJECT_DIR });
  try {
    execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl, '--config', config], { encoding: 'utf8' });
    const all = fs.readdirSync(outDir).filter((f) => f.startsWith('part-'))
      .map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');
    assert.match(all, /the component/, 'the transform did not run');
    assert.ok(!/innerthing/.test(all), 'the pre-transform term survived into the output');
    assert.match(fs.readFileSync(path.join(outDir, '00-INDEX.md'), 'utf8'), /\*\*Scrub:\*\* Scrubbed via/,
      'the index must record that this export went through the boundary');
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#523 --raw writes the room verbatim and the index says plainly that it did not scrub', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-raw-'));
  const outDir = path.join(dir, 'out');
  const server = await startRestServer({ board: boardWithResidue(), staticDir: PROJECT_DIR });
  try {
    execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl, '--raw'], { encoding: 'utf8' });
    const all = fs.readdirSync(outDir).filter((f) => f.startsWith('part-'))
      .map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');
    assert.match(all, /secretseat/, '--raw must preserve the room verbatim — that is what it is for');
    assert.match(all, /innerthing/, '--raw must not transform either');

    const index = fs.readFileSync(path.join(outDir, '00-INDEX.md'), 'utf8');
    assert.match(index, /NOT SCRUBBED/,
      'a raw archive found on disk months later must say what it is — "I think that one was scrubbed" is not actionable');
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
