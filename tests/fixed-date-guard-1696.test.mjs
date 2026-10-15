/**
 * #1696 — the standing guard: no test under tests/ feeds a fixed calendar date into a clock-compared field (scripts/windowed-fields-1696.json) on a path that reaches a real-clock
 * server or process, unless that site has been READ and accepted in scripts/accepted-fixed-dates-1696.json with a reason.
 *
 * WHY: a fixed date is harmless to a pure function and a time bomb to a real server (the instance: a fixed 2026-09-18 expiry crossed a 72 h window on 2026-10-15 and turned a served test red).
 * THE LIMITS (stated in every scan report): this is a lexical guard, not a proof. It does not see a date computed at run time or read from data, one defined in another file, one written as numbers,
 * a field set by assignment or under a computed key, or a field that is not on the list (uncovered, not safe). A green row here is NOT a clearance.
 *
 *   G1  the scan over tests/ with the committed field list and accepted list exits 0: nothing new is flagged, nothing accepted has changed, nothing accepted is stale
 *   G2  CONTROL (so G1 can fail): with one accepted entry removed the same scan exits 1 and names the site; with one accepted date changed it exits 1 and says CHANGED
 *
 * A new fixed-date site makes G1 fail. The fix is usually to make the date relative to now. If the site really is safe, READ it, then add an entry to scripts/accepted-fixed-dates-1696.json
 * (file, statement, field, consumer, dates and fingerprint as the scan prints them with --json, plus a reason that says what was read).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = path.join(ROOT, 'scripts', 'scan-fixed-dates-1696.mjs');
const FIELDS = path.join(ROOT, 'scripts', 'windowed-fields-1696.json');
const ACCEPTED = path.join(ROOT, 'scripts', 'accepted-fixed-dates-1696.json');
// Run from the repo root with a relative `tests` argument so the file names in the accepted list are repo-relative and the same on every machine.
const scan = (accepted, ...extra) => spawnSync(process.execPath, [SCAN, ...extra, '--fields', path.relative(ROOT, FIELDS), '--baseline', accepted, 'tests'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

test('#1696 (G1) no test feeds a fixed date into a clock-compared field on a path to a real-clock process, except the sites read and accepted', () => {
  const r = scan(path.relative(ROOT, ACCEPTED), '--json');
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
  assert.ok(j, `PRECONDITION: the scan printed JSON (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
  assert.equal(r.status, 0, `the scan found something it was not told is safe (exit ${r.status}). New sites: ${JSON.stringify(j.flagged.map((f) => `${f.file}:${f.line} ${f.field} ${f.dates.join(',')}`))}; changed since accepted: ${JSON.stringify(j.changed.map((c) => `${c.file} "${c.statement.slice(0, 50)}" (${c.differs.join(', ')})`))}; stale entries: ${JSON.stringify(j.staleBaseline.map((b) => `${b.file} "${b.statement.slice(0, 50)}"`))}. ${j.guard}`);
  const listed = JSON.parse(fs.readFileSync(ACCEPTED, 'utf8')).accepted.length;
  assert.ok(j.files > 0 && j.unreadable.length === 0, 'it read files and none was unreadable');
  assert.equal(j.accepted.length, listed, 'and every entry on the accepted list matched a site (none vacuous)');
});

test('#1696 (G2 CONTROL) the guard can fail: remove one accepted entry and the scan exits 1 naming the site; change one accepted date and it exits 1 saying CHANGED', () => {
  const doc = JSON.parse(fs.readFileSync(ACCEPTED, 'utf8')); assert.ok(doc.accepted.length >= 2, 'PRECONDITION: the accepted list has entries');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guard1696-'));
  try {
    const dropped = doc.accepted[0]; const p1 = path.join(d, 'dropped.json'); fs.writeFileSync(p1, JSON.stringify({ accepted: doc.accepted.slice(1) }));
    const a = scan(p1); assert.equal(a.status, 1, `with an entry removed: exit 1 (got ${a.status}): ${a.stderr.slice(0, 200)}`); assert.ok(a.stdout.includes(path.basename(dropped.file)), 'and the report names the site\'s file');
    const moved = { ...doc.accepted[1], dates: ['2031-01-01T00:00:00.000Z'] }; const p2 = path.join(d, 'moved.json'); fs.writeFileSync(p2, JSON.stringify({ accepted: [doc.accepted[0], moved, ...doc.accepted.slice(2)] }));
    const b = scan(p2); assert.equal(b.status, 1, `with a date changed: exit 1 (got ${b.status})`); assert.match(b.stdout, /CHANGED since accepted/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
