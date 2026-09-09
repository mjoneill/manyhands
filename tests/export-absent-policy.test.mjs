/**
 * #1331 acceptance 6-8 — the two "absent config" states, and the control for
 * the one that fails QUIETLY.
 *
 * `defaultConfigPath()` splits on SCRUM_BOARD_FILE, and the two branches have
 * opposite signs:
 *
 *   SET   → the data root. A missing config there used to die(), loudly, and
 *           the only door it offered was `--raw`. A fresh install has never
 *           created that file, so the first Export a new operator ran failed
 *           and pointed them at the UNSCRUBBED path.
 *
 *   UNSET → the checkout. `export-wiki.mjs:43-46` argues this is correct, and
 *           it is: for a standalone install the checkout IS the data root. But
 *           the file sitting there is a TEMPLATE of EXAMPLE rules whose own
 *           README says it protects nothing — so the export runs, scrubs
 *           against the wrong list, and reports PASS.
 *
 * ⛔ THE SECOND IS THE DANGEROUS ONE AND IT IS WHY THIS FILE EXISTS. A PASS is
 * the EXPECTED result there — the question is never "did it succeed" but
 * "does the artifact say WHICH RULESET produced it". A control that only
 * asserted success would confirm the bug.
 *
 * The fix under test is not a new resolution rule. It is that (a) an absent
 * policy falls back to shipped GENERIC defaults that REPAIR rather than only
 * detect, and (b) every artifact declares its ruleset's source, counts and
 * digest, in the index AND in every part.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { GENERIC_TRANSFORMS } from '../core/export-transforms.mjs';

const EXPORTER = path.join(PROJECT_DIR, 'export-board.mjs');

// ⚠️ Sourced from the module, never written here — the #837 guard forbids a
// home-path shape in tests/, and the specimen belongs beside the pattern it
// exercises anyway.
const HOME_PATH_SPECIMEN = GENERIC_TRANSFORMS.forbidden[0].specimen;

const oneMessage = () => makeBoardFixture({
  conversations: [{
    id: 'm1',
    body: 'an ordinary message with nothing forbidden in it',
    author: 'sage',
    attachedTo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }],
});

// ⭐ A board carrying the exact thing the generic defaults exist for. Found by
// SABOTAGE: emptying GENERIC_TRANSFORMS.rules — restoring the real defect, a
// detector with no repair — left the state-A test GREEN, because its fixture
// had nothing to repair. A fresh-install test whose data contains no home path
// proves the export runs, not that the defaults WORK.
const boardWithHomePath = () => makeBoardFixture({
  conversations: [{
    id: 'm1',
    body: `see ${HOME_PATH_SPECIMEN} for the notes`,
    author: 'sage',
    attachedTo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }],
});

/** Run the exporter with an explicit environment and return the index text. */
function runExport(server, outDir, env, extraArgs = []) {
  execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    index: fs.readFileSync(path.join(outDir, '00-INDEX.md'), 'utf8'),
    parts: fs.readdirSync(outDir).filter((f) => f.startsWith('part-'))
      .map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')),
  };
}

// ── STATE A · a data root with no policy — the fresh-install case ───────────

test('#1331 STATE A: a data root with no ruleset EXPORTS, and says the defaults were generic', async () => {
  // This used to die() and offer --raw as its only door. A new operator has
  // never created that file; nothing in install creates it. The safe default
  // was unreachable and the loud opt-out was the only working one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-stateA-'));
  const dataRoot = path.join(dir, 'data');
  fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(dataRoot, 'board-data.json'), '{}');   // no EXPORT_TRANSFORMS.json
  const outDir = path.join(dir, 'out');
  // The board carries the very shape the generic defaults exist to repair —
  // otherwise this passes against defaults that cannot repair anything.
  const server = await startRestServer({ board: boardWithHomePath(), staticDir: PROJECT_DIR });
  try {
    const { index, parts } = runExport(server, outDir, {
      SCRUM_BOARD_FILE: path.join(dataRoot, 'board-data.json'),
    });
    assert.ok(parts.length > 0, 'an absent policy must not prevent an export');
    const all = parts.join('\n');
    assert.ok(!all.includes(HOME_PATH_SPECIMEN),
      'the generic defaults must REPAIR the home path, not merely detect it — a detector with no repair refuses forever');
    assert.match(all, /for the notes/, 'and the surrounding text must survive the repair');
    assert.match(index, /Scrubbed via/, 'it still went through the boundary');
    assert.match(index, /GENERIC defaults/,
      'and the artifact must say the defaults were generic — "scrubbed" alone is the conflation this card removes');
    assert.match(index, /declared no rules of its own/,
      'a reader with no access to the config must be able to tell this from a room-policy export');
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── STATE B · the checkout template — the quiet one ─────────────────────────

test('#1331 STATE B CONTROL: unset SCRUM_BOARD_FILE resolves the CHECKOUT config, and the artifact NAMES it', async () => {
  // ⛔ THE POINT OF THIS CONTROL. Succeeding is expected — the resolution is
  // correct, and export-wiki.mjs:43-46 argues for it. What was missing is that
  // nothing distinguished this artifact from one scrubbed against a room's real
  // policy. Asserting "it exported" would confirm the defect; assert provenance.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-stateB-'));
  const outDir = path.join(dir, 'out');
  const server = await startRestServer({ board: oneMessage(), staticDir: PROJECT_DIR });
  try {
    const env = { ...process.env };
    delete env.SCRUM_BOARD_FILE;
    execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl], { encoding: 'utf8', env });
    const index = fs.readFileSync(path.join(outDir, '00-INDEX.md'), 'utf8');

    assert.match(index, /Scrubbed via/, 'state B does export — that is not the defect');
    // The discriminator, in three forms a later reader can use without the file:
    assert.match(index, /rule\(s\), \d+ check\(s\)/, 'counts make 2/2 vs 4/21 legible at a glance');
    assert.match(index, /sha256:[0-9a-f]{12}/, 'a digest makes the claim checkable rather than declared');
    assert.match(index, /EXPORT_TRANSFORMS\.json|GENERIC defaults/,
      'the artifact must name WHERE the ruleset came from');
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the provenance travels with the file a person actually opens ────────────

test('#1331 EVERY PART carries the scrub provenance, not only the index', async () => {
  // Indexes get separated from what they describe. The part is the file that
  // gets forwarded, attached, or dropped into a tool — a provenance claim that
  // lives only in a sibling file travels only by luck.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-partprov-'));
  const dataRoot = path.join(dir, 'data');
  fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(dataRoot, 'board-data.json'), '{}');
  const outDir = path.join(dir, 'out');
  const server = await startRestServer({ board: oneMessage(), staticDir: PROJECT_DIR });
  try {
    const { parts } = runExport(server, outDir, {
      SCRUM_BOARD_FILE: path.join(dataRoot, 'board-data.json'),
    });
    assert.ok(parts.length > 0);
    for (const [i, body] of parts.entries()) {
      assert.match(body, /\*\*Scrub:\*\*/, `part ${i + 1} must carry the scrub line`);
      assert.match(body, /sha256:[0-9a-f]{12}/, `part ${i + 1} must carry the digest`);
    }
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#1331 a RAW part says it is unscrubbed, in the part itself', async () => {
  // The same argument in the direction that matters most: a raw archive found
  // on disk later must say what it is, in the file someone opens.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-rawprov-'));
  const outDir = path.join(dir, 'out');
  const server = await startRestServer({ board: oneMessage(), staticDir: PROJECT_DIR });
  try {
    execFileSync('node', [EXPORTER, '--out', outDir, '--base', server.baseUrl, '--raw'], { encoding: 'utf8' });
    const parts = fs.readdirSync(outDir).filter((f) => f.startsWith('part-'))
      .map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'));
    assert.ok(parts.length > 0);
    for (const body of parts) assert.match(body, /NOT SCRUBBED/);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── provenance PARITY — the exporter whose artifact LEAVES the room ──────────

test('#1331 export-wiki carries the SAME provenance, in the artifact and not only the console', async () => {
  // ⭐ A review catch, and the asymmetry ran the wrong way: export-wiki
  // makes the artifact that LEAVES; export-board makes the archive that STAYS.
  // The provenance landed on the one that stays. This exporter hand-rolled its
  // counts and printed "scrub check PASS — 0 of N forbidden patterns present",
  // which reads identically whether 21 room rules ran or 5 shipped examples did.
  //
  // ⛔ NOTE WHAT THIS DOES NOT ASSERT: a fallback. export-wiki still die()s on a
  // missing ruleset, deliberately and under its own test — an artifact that
  // leaves the room answers "no policy found" differently from an archive that
  // stays in it. I briefly gave it export-board's fallback while implementing
  // this note, and that test caught it.
  const WIKI = path.join(PROJECT_DIR, 'export-wiki.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-wikiprov-'));
  const dataRoot = path.join(dir, 'data');
  fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(dataRoot, 'board-data.json'), '{}');
  // a REAL room ruleset, so the provenance has something specific to report
  fs.writeFileSync(path.join(dataRoot, 'EXPORT_TRANSFORMS.json'), JSON.stringify({
    rules: [{ find: 'zephyrblatt', replace: 'weather-widget', flags: 'g' }],
    forbidden: [{ pattern: 'zephyrblatt', flags: 'gi' }],
  }));
  const outFile = path.join(dir, 'page.html');

  const api = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      node: { identifier: 7, name: 'A page', text: 'the zephyrblatt runs here', dateModified: '2026-01-01T00:00:00.000Z' },
      children: [], backlinks: [],
    }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));

  try {
    // ⚠️ spawn, NOT execFileSync. The node server above lives in THIS process,
    // and execFileSync blocks the event loop — so the child's request can never
    // be accepted and the CLI reports "cannot reach the board API". A deadlock
    // that reads exactly like a server that isn't running.
    await new Promise((resolve, reject) => {
      const child = spawn('node', [WIKI, '7', '--out', outFile], {
        env: {
          ...process.env,
          SCRUM_API: `http://127.0.0.1:${api.address().port}`,
          SCRUM_BOARD_FILE: path.join(dataRoot, 'board-data.json'),
        },
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err}`))));
    });
    const html = fs.readFileSync(outFile, 'utf8');
    assert.match(html, /Scrubbed via/, 'the artifact that leaves must record that it went through the boundary');
    assert.match(html, /this board&#39;s own rules|this board's own rules/,
      'and WHICH ruleset — a room policy must be distinguishable from the shipped defaults');
    assert.match(html, /1 rule\(s\), 1 check\(s\)/, 'counts, so 1/1 vs 4/21 is legible without the file');
    assert.match(html, /sha256:[0-9a-f]{12}/, 'checkable rather than declared');
    assert.ok(!html.includes('zephyrblatt'), 'and the room rule actually ran');
  } finally {
    await new Promise((r) => api.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
