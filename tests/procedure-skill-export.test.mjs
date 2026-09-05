/**
 * #1209 — ONE TEXT, TWO HOMES, AND THE FILE IS DERIVED.
 *
 * A procedure is a ProcedureVersion in the graph AND a loadable skill on disk.
 * Writing it twice would be the defect this board keeps finding under other
 * names: a fact with two homes cannot contradict itself visibly, so nothing
 * detects that it did. The skill file is GENERATED from the text, never copied
 * by hand, and these tests hold that the generator copies rather than improves
 * and that its drift check can actually fail.
 *
 * ⚠️ EVERYTHING HERE RUNS AGAINST A TEMP DIRECTORY AND THE TRACKED TEXT.
 * `.claude/` is gitignored, so the real skill file is a seat-local artifact
 * that a fresh clone does not have. A test asserting that file exists would
 * pass here and fail on CI — the exact green-locally/red-in-CI trap this repo
 * sprang once today already. So the tracked inputs are what get tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'export-procedure-skill.mjs');
const TEXT = join(ROOT, 'tools', 'procedure-texts', 'research-video.md');
const NAME = 'research a YouTube video';

const gen = (outDir, extra = []) => execFileSync(
  'node', [TOOL, '--name', NAME, '--from-file', 'tools/procedure-texts/research-video.md',
    '--out-dir', outDir, ...extra],
  // A board URL that cannot answer, so the generator uses --from-file and the
  // test never depends on a running server.
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SCRUM_BOARD_URL: 'http://127.0.0.1:9' } },
);
const skillPath = (outDir) => join(outDir, 'research-a-youtube-video', 'SKILL.md');

test('#1209 the procedure text is a METHOD, and carries the lesson that cost the most', () => {
  assert.ok(existsSync(TEXT), 'the source text must be tracked so a clone can seed its own board');
  const body = readFileSync(TEXT, 'utf8');
  for (const step of ['IDENTIFY', 'CAPTURE', 'VERIFY', 'DISCUSS', 'NOTES', 'DURABILITY', 'RECORD']) {
    assert.match(body, new RegExp(`\\b${step}\\b`), `step ${step} is missing`);
  }
  // ⭐ Measured 2026-09-05 and expensive: a declared caption track returned
  // HTTP 200 with zero bytes, which is byte-identical to "no captions" unless
  // you ask for the track list first. If a rewrite drops this, the next seat
  // pays the ~40 minutes again.
  assert.match(body, /ZERO BYTES/);
  assert.match(body, /never that it is absent/);
  assert.match(body, /not an independent instrument/,
    'and that a second client on one address is not a second instrument');
});

test('#1209 the generated skill is loadable and says where the edit really goes', () => {
  const out = mkdtempSync(join(tmpdir(), 'skill-'));
  gen(out);
  const s = readFileSync(skillPath(out), 'utf8');
  assert.match(s, /^---\nname: research-a-youtube-video\n/, 'front matter names the skill');
  assert.match(s, /^description: .+/m, 'and describes it, or a seat cannot tell what it is for');
  assert.match(s, /GENERATED — DO NOT EDIT/);
  assert.match(s, /procedure_version_create/,
    'it must name the verb that changes the real thing, or the next reader edits the copy');
});

test('#1209 the generator COPIES — it does not improve its input', () => {
  const out = mkdtempSync(join(tmpdir(), 'skill-'));
  gen(out);
  const body = readFileSync(TEXT, 'utf8').trim();
  assert.ok(readFileSync(skillPath(out), 'utf8').includes(body),
    'the text must appear VERBATIM. A generator that rewrites its input is a second author, and '
    + 'then the graph and the file mean different things while both look right.');
});

test('#1209 ⭐ --check CAN FAIL — the drift guard is a guard, not a decoration', () => {
  const out = mkdtempSync(join(tmpdir(), 'skill-'));
  gen(out);

  // Clean: passes.
  assert.match(gen(out, ['--check']), /^ok —/);

  // Hand-edited: must go red, and must say WHAT is wrong rather than just exit 1.
  const p = skillPath(out);
  writeFileSync(p, readFileSync(p, 'utf8').replace('Research a video', 'Research a video (hand-edited)'));
  let failed = false;
  try {
    gen(out, ['--check']);
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /DRIFT/);
    assert.match(String(e.stderr), /Regenerate/, 'and must tell the reader how to fix it');
  }
  assert.ok(failed, 'a hand-edited skill MUST fail the check — otherwise the two homes disagree '
    + 'silently, which is the whole thing this design exists to prevent');
});

test('#1209 a missing skill file fails the check rather than passing vacuously', () => {
  const out = mkdtempSync(join(tmpdir(), 'skill-'));
  let failed = false;
  try {
    gen(out, ['--check']);   // nothing generated yet
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /MISSING/);
  }
  assert.ok(failed, 'absent must REFUSE, not pass — a check that is satisfied by nothing being '
    + 'there is the emptiest kind of green');
});
