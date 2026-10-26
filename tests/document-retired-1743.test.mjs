// #1743 — a RETIRED board document (`<file>.retired` beside it) is never written again: saveDomain and the one-off
// scripts that rewrite the file refuse, loudly, with nothing written. With no marker (every mode-on board, every other
// test) nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveDomain } from '../core/store.mjs';
import { retiredMarkerPath } from '../core/document-retired.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const world = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-1743-'));
  const file = path.join(dir, 'board-data.json');
  fs.writeFileSync(file, JSON.stringify({ cards: [], conversations: [{ id: 'p1', body: 'one' }], columns: [] }, null, 2));
  return { dir, file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const domain = { nodes: [], messages: [], columns: [], nextShortId: 1 };

test('#1743 R1 saveDomain refuses a retired document (DOCUMENT_RETIRED), and the file is byte-identical', (t) => {
  const w = world(); t.after(w.done);
  fs.writeFileSync(retiredMarkerPath(w.file), 'retired by the 10-26 cutover\n');
  const before = fs.readFileSync(w.file);
  assert.throws(() => saveDomain(w.file, domain), (e) => e.code === 'DOCUMENT_RETIRED' && /#1743 REFUSED/.test(e.message));
  assert.deepEqual(fs.readFileSync(w.file), before);
  assert.equal(fs.existsSync(`${w.file}.tmp`), false, 'not even a tmp file is left behind');
});

test('#1743 R2 CONTROL: with no marker, saveDomain writes as before', (t) => {
  const w = world(); t.after(w.done);
  const before = fs.readFileSync(w.file, 'utf8');
  saveDomain(w.file, domain, { now: '2026-10-26T00:00:00.000Z' });
  assert.notEqual(fs.readFileSync(w.file, 'utf8'), before);
});

test('#1743 R3 the post-seq migration script refuses a retired document: non-zero exit, the reason on stderr, the file byte-identical', (t) => {
  const w = world(); t.after(w.done);
  fs.writeFileSync(retiredMarkerPath(w.file), '');
  const before = fs.readFileSync(w.file);
  let err = null;
  try { execFileSync(process.execPath, ['scripts/migrate-post-seq-1592.mjs', '--board-file', w.file], { cwd: ROOT, stdio: 'pipe' }); } catch (e) { err = e; }
  assert.ok(err && err.status !== 0, 'the script must exit non-zero');
  assert.match(String(err.stderr), /#1743 REFUSED/);
  assert.deepEqual(fs.readFileSync(w.file), before);
});

test('#1743 R4 CONTROL: with no marker the same migration numbers the post', (t) => {
  const w = world(); t.after(w.done);
  execFileSync(process.execPath, ['scripts/migrate-post-seq-1592.mjs', '--board-file', w.file], { cwd: ROOT, stdio: 'pipe' });
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).conversations[0].postSeq, 1);
});

test('#1743 R5 (structural) every direct writer of the document checks the marker before it writes', () => {
  for (const f of ['scripts/migrate-post-seq-1592.mjs', 'scripts/retire-collections-1624.mjs', 'scripts/retire-unit3-collections-1582.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const guard = src.indexOf('assertDocumentNotRetired(');
    const write = src.search(/fs\.writeFileSync\(tmp/);
    assert.ok(guard > -1 && write > -1 && guard < write, `${f}: the guard must come before the write`);
  }
  // the scripts that write through saveDomain (redact, rollback-posts-1574, rollback-columns-1639) are covered by R1
  for (const f of ['scripts/redact.mjs', 'scripts/rollback-posts-1574.mjs', 'scripts/rollback-columns-1639.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /saveDomain\(/, `${f} writes through saveDomain`);
    assert.doesNotMatch(src, /fs\.writeFileSync\([^)]*(board|BOARD|file|FILE)\b/, `${f} has no direct write that bypasses saveDomain`);
  }
});
