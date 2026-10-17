/**
 * #1648 (the rest) — THE RECORD AND CONFIG FILES BACKUP. TEST AUTHOR's, written before the build (RED until scripts/record-files-backup.mjs exists).
 *
 * Interface FIXED on the card thread (proposed 43180, fixed 43181):
 *   node scripts/record-files-backup.mjs --dest DIR --event-log-dir D --work-store F --config F [--config F ...] --min-free-bytes N
 *        [--keep-hourly N --keep-daily D] [--source-attachments DIR --source-executor URL --python PY]
 *   One JSON report on stdout: {stage, published, setDir, files:[{name, bytes, sha256, linkedFrom|null, cutoff?, capturedBeforeCutoffs?}],
 *   cursorsCapturedAt, budget:{copiedBytes, linkedBytes, setBytes, peakPartialBytes, freeBefore, freeAfter}, pruned, notCovered, ok}.
 *   Exit 0 exactly when ok; exit 2 for a refusal (a missing flag, free space below the floor) with nothing written.
 *   Published sets at DIR/records-<stamp>/; an unverified set at DIR/records-<stamp>-UNVERIFIED/.
 *   node scripts/record-files-verify.mjs --set DIR --live-root R [--live-root R ...]
 * Contract (43172 design; 43173 and 43174 the three pins; 43175/43176/43177/43178/43179 consistency, budget, verifier):
 *   - the event log is cut at the last newline at or before each segment's length when measured; the cut is recorded per segment
 *   - cursors.json (inside the event-log dir) is captured BEFORE any cutoff is measured, and its seq bounds are checked against the captured log
 *   - the work ledger is cut at its last newline; configs are parsed and written as parsed bytes; a config that does not parse FAILS (after one retry)
 *   - every hash is of the bytes written to the backup; published sets are read-only; a dedupe link is to a published, verified set ONLY, never to a
 *     live file, and dedupe is decided by sha
 *   - the verifier keeps checkpoint identity, position and read-only-open checks; it allows links within the backup tree and none to a live file
 *
 *   B0  refusals: each required flag missing, or free space below the floor -> exit 2, names it, and nothing is written into --dest
 *   B1  a clean run: published, read-only, every source present, every sha256 is the backup file's own, attachments named as not captured
 *   B2  the cut: today's segment and the ledger stop at their last newline (a half-written last line is not in the set) and the cut is recorded
 *   B3  cursors first: cursors.json is captured before every cutoff is measured
 *   B4  no live inode: no backup file shares an inode with a live source; appending to the live segment and rewriting a config leaves the set unchanged
 *   B5  dedupe: a second run links the unchanged closed segments FROM THE FIRST SET (same inode) and copies what changed
 *   B6  sha decides: a "closed" segment whose bytes changed is copied again, never linked; the run is RED (ok:false, exit 1, a finding
 *       closed-history-changed naming it) but the set is published and verifies; the next run is green and dedupes from it (43186)
 *   B7  an UNVERIFIED or partial set is never a dedupe source
 *   B8  cursors beyond the captured log fail by name (a restored cursor must not point past restored history)
 *   B9  a config that does not parse fails by name, and the set is not published
 *   B10 the verifier on its own: a flipped byte, and a file swapped for a hard link to a live file, each fail by name; the untouched set passes
 *   B11 retention: without the flags nothing is pruned and the report says "not requested"
 *
 * NOT covered, by name: the paired attachment-and-executor capture (executor-backed rows to follow); retention semantics beyond "not requested"
 * (hour and day bucketing); the launchd job and the path resolver (their own rows); real disk-budget numbers (a measurement, not a row); the
 * checkpoint identity checks the verifier keeps from graph-store-backup (they belong to the paired capture).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB = path.join(ROOT, 'scripts/record-files-backup.mjs');
const VERIFY = path.join(ROOT, 'scripts/record-files-verify.mjs');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ev = (seq, extra = {}) => JSON.stringify({ seq, op: 'upsert', entity: `e${seq}`, actor: 'ada', occurred_at: '2026-10-15T00:00:00.000Z', recorded_at: '2026-10-15T00:00:00.000Z', state: { n: seq }, ...extra });

/** A live tree: two closed segments, today's with a half-written last line, cursors.json, a ledger with a half-written last line, two configs. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfb1648-'));
  const live = path.join(root, 'live'); const events = path.join(live, 'board-data-events'); const dest = path.join(root, 'dest');
  fs.mkdirSync(events, { recursive: true }); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(events, 'events-2026-10-15.jsonl'), `${ev(1)}\n${ev(2)}\n`);
  fs.writeFileSync(path.join(events, 'events-2026-10-16.jsonl'), `${ev(3)}\n${ev(4)}\n`);
  fs.writeFileSync(path.join(events, 'events-2026-10-17.jsonl'), `${ev(5)}\n${ev(6)}\n{"seq":7,"op":"ups`);   // a writer mid-append
  fs.writeFileSync(path.join(events, 'cursors.json'), `${JSON.stringify({ version: 1, seats: { ada: { acked: 5, served: 6 } } }, null, 2)}\n`);
  const ledger = path.join(live, 'work-objects.jsonl'); fs.writeFileSync(ledger, '{"id":"w1","kind":"bid"}\n{"id":"w2","kind":"grant"}\n{"id":"w3","ki');
  const cfgA = path.join(live, 'roster.json'); fs.writeFileSync(cfgA, JSON.stringify({ seats: { ada: { name: 'Ada' } } }));
  const cfgB = path.join(live, 'tending-config.json'); fs.writeFileSync(cfgB, JSON.stringify({ enabled: true, every: 60 }));
  const args = ['--dest', dest, '--event-log-dir', events, '--work-store', ledger, '--config', cfgA, '--config', cfgB, '--min-free-bytes', '1'];
  return { root, live, events, dest, ledger, cfgA, cfgB, args };
}
const run = (w, args = w.args) => {
  const r = spawnSync(process.execPath, [JOB, ...args], { cwd: w.root, encoding: 'utf8', timeout: 60000 });
  let rep = null; try { rep = JSON.parse(r.stdout); } catch { /* reported by the caller */ }
  return { ...r, rep };
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (rep, name) => (rep?.files || []).find((f) => f.name === name || path.basename(f.name) === name);
const setFile = (rep, name) => { const f = byName(rep, name); assert.ok(f, `the report lists ${name}`); return path.join(rep.setDir, f.name); };
const clean = (w) => { try { fs.chmodSync(w.root, 0o755); } catch { /* */ } spawnSync('chmod', ['-R', 'u+w', w.root]); fs.rmSync(w.root, { recursive: true, force: true }); };
const listing = (d) => fs.readdirSync(d, { recursive: true }).sort();
const pre = () => assert.ok(fs.existsSync(JOB), 'PRECONDITION: scripts/record-files-backup.mjs exists (RED until it is built)');

test('#1648 (B0) refusals: a missing flag, or free space below the floor, exits 2, names it, and writes nothing into --dest', () => {
  pre();
  for (const flag of ['--dest', '--event-log-dir', '--work-store', '--config', '--min-free-bytes']) {
    const w = world();
    try {
      const args = []; for (let i = 0; i < w.args.length; i += 2) if (w.args[i] !== flag) args.push(w.args[i], w.args[i + 1]);
      const r = run(w, args);
      assert.equal(r.status, 2, `${flag} missing: exit 2 (got ${r.status}): ${r.stderr.slice(0, 200)}`);
      assert.ok((r.stdout + r.stderr).includes(flag), `and the output names ${flag}`);
      assert.deepEqual(listing(w.dest), [], `${flag} missing: nothing written into --dest`);
    } finally { clean(w); }
  }
  const w = world();
  try {
    const args = w.args.map((a, i) => (w.args[i - 1] === '--min-free-bytes' ? String(10 ** 18) : a));
    const r = run(w, args);
    assert.equal(r.status, 2, `free space below the floor: exit 2 (got ${r.status})`);
    assert.match(r.stdout + r.stderr, /free|floor|space/i, 'and it says why');
    assert.deepEqual(listing(w.dest), [], 'and nothing is written');
  } finally { clean(w); }
});

test('#1648 (B1) a clean run publishes a read-only set holding every source, each sha256 the backup file\'s own; attachments named as not captured', () => {
  pre(); const w = world();
  try {
    const r = run(w);
    assert.equal(r.status, 0, `exit 0 (got ${r.status}): ${r.stderr.slice(0, 300)}`);
    assert.ok(r.rep, `one JSON report on stdout (got ${JSON.stringify(r.stdout.slice(0, 200))})`);
    assert.equal(r.rep.ok, true); assert.equal(r.rep.published, true);
    assert.match(path.basename(r.rep.setDir), /^records-.+/, 'the set is records-<stamp>'); assert.doesNotMatch(r.rep.setDir, /UNVERIFIED|partial/);
    assert.equal(path.dirname(path.resolve(r.rep.setDir)), path.resolve(w.dest), 'directly under --dest');
    for (const n of ['events-2026-10-15.jsonl', 'events-2026-10-16.jsonl', 'events-2026-10-17.jsonl', 'cursors.json', 'work-objects.jsonl', 'roster.json', 'tending-config.json']) {
      const p = setFile(r.rep, n);
      assert.equal(byName(r.rep, n).sha256, sha(p), `${n}: the recorded sha256 is the backup file's own`);
      assert.equal(byName(r.rep, n).bytes, fs.statSync(p).size, `${n}: and so is its size`);
      assert.equal(fs.statSync(p).mode & 0o222, 0, `${n}: published read-only`);
    }
    assert.ok((r.rep.notCovered || []).some((s) => /attachments/i.test(s) && /not captured/i.test(s)), `notCovered says attachments were not captured (got ${JSON.stringify(r.rep.notCovered)})`);
    assert.equal(r.rep.pruned, 'not requested', 'B11 (no retention flags): nothing pruned, and it says so');
  } finally { clean(w); }
});

test('#1648 (B2) today\'s segment and the ledger stop at their last newline, and the cut is recorded', () => {
  pre(); const w = world();
  try {
    const r = run(w); assert.equal(r.status, 0, r.stderr.slice(0, 300));
    const seg = fs.readFileSync(setFile(r.rep, 'events-2026-10-17.jsonl'), 'utf8');
    assert.equal(seg, `${ev(5)}\n${ev(6)}\n`, 'the half-written seq 7 line is not in the set');
    assert.equal(fs.readFileSync(setFile(r.rep, 'work-objects.jsonl'), 'utf8'), '{"id":"w1","kind":"bid"}\n{"id":"w2","kind":"grant"}\n', 'nor the half-written ledger line');
    const c = byName(r.rep, 'events-2026-10-17.jsonl').cutoff;
    assert.ok(c && Number(c.bytes ?? c.offset ?? c) === Buffer.byteLength(seg), `the cut is recorded at the bytes kept (got ${JSON.stringify(c)})`);
    assert.equal(fs.readFileSync(setFile(r.rep, 'roster.json'), 'utf8'), JSON.stringify({ seats: { ada: { name: 'Ada' } } }), 'a config is its parsed bytes');
  } finally { clean(w); }
});

test('#1648 (B3) cursors.json is captured before every cutoff is measured', () => {
  pre(); const w = world();
  try {
    const r = run(w); assert.equal(r.status, 0, r.stderr.slice(0, 300));
    assert.equal(byName(r.rep, 'cursors.json')?.capturedBeforeCutoffs, true, 'the cursors entry says it was captured first');
    const at = Date.parse(r.rep.cursorsCapturedAt); assert.ok(!Number.isNaN(at), `cursorsCapturedAt is a time (got ${JSON.stringify(r.rep.cursorsCapturedAt)})`);
    const cuts = (r.rep.files || []).filter((f) => f.cutoff).map((f) => Date.parse(f.cutoff.measuredAt));
    assert.ok(cuts.length >= 3 && cuts.every((t) => !Number.isNaN(t)), `every segment's cutoff has a measuredAt (got ${JSON.stringify((r.rep.files || []).map((f) => f.cutoff))})`);
    assert.ok(cuts.every((t) => at <= t), 'and the cursors were captured no later than any of them');
  } finally { clean(w); }
});

test('#1648 (B4) no backup file shares an inode with a live source, and changing the live files afterwards leaves the set unchanged', () => {
  pre(); const w = world();
  try {
    const r = run(w); assert.equal(r.status, 0, r.stderr.slice(0, 300));
    const liveIno = new Set([...fs.readdirSync(w.events).map((n) => path.join(w.events, n)), w.ledger, w.cfgA, w.cfgB].map((p) => fs.statSync(p).ino));
    const setFiles = (r.rep.files || []).map((f) => path.join(r.rep.setDir, f.name));
    for (const p of setFiles) assert.equal(liveIno.has(fs.statSync(p).ino), false, `${path.basename(p)} does not share an inode with a live file`);
    const before = setFiles.map(sha);
    fs.appendFileSync(path.join(w.events, 'events-2026-10-17.jsonl'), 'ert"}\n');
    fs.appendFileSync(path.join(w.events, 'events-2026-10-15.jsonl'), `${ev(99)}\n`);
    fs.writeFileSync(w.cfgB, JSON.stringify({ enabled: false }));
    assert.deepEqual(setFiles.map(sha), before, 'the published set is byte-unchanged after the live files changed');
  } finally { clean(w); }
});

test('#1648 (B5) a second run links the unchanged closed segments from the first set and copies what changed', async () => {
  pre(); const w = world();
  try {
    const a = run(w); assert.equal(a.status, 0, a.stderr.slice(0, 300));
    await pause(1100);
    fs.appendFileSync(path.join(w.events, 'events-2026-10-17.jsonl'), 'ert"}\n');   // today's segment grew
    const b = run(w); assert.equal(b.status, 0, b.stderr.slice(0, 300));
    assert.notEqual(path.resolve(b.rep.setDir), path.resolve(a.rep.setDir), 'a new set');
    for (const n of ['events-2026-10-15.jsonl', 'events-2026-10-16.jsonl']) {
      const f = byName(b.rep, n);
      assert.ok(f.linkedFrom && path.resolve(f.linkedFrom).startsWith(path.resolve(a.rep.setDir)), `${n} is linked from the first set (linkedFrom ${JSON.stringify(f.linkedFrom)})`);
      assert.equal(fs.statSync(setFile(b.rep, n)).ino, fs.statSync(setFile(a.rep, n)).ino, `${n}: the same inode as the first set's copy`);
    }
    const today = byName(b.rep, 'events-2026-10-17.jsonl');
    assert.equal(today.linkedFrom ?? null, null, 'today\'s segment changed, so it is copied, not linked');
    assert.equal(fs.readFileSync(setFile(b.rep, 'events-2026-10-17.jsonl'), 'utf8'), `${ev(5)}\n${ev(6)}\n{"seq":7,"op":"upsert"}\n`, 'and holds the completed line');
    assert.ok(b.rep.budget?.linkedBytes > 0 && b.rep.budget?.copiedBytes > 0, `the budget counts both (got ${JSON.stringify(b.rep.budget)})`);
  } finally { clean(w); }
});

test('#1648 (B6) a "closed" segment whose bytes changed is never linked, and the report names it', async () => {
  pre(); const w = world();
  try {
    const a = run(w); assert.equal(a.status, 0, a.stderr.slice(0, 300));
    await pause(1100);
    const p = path.join(w.events, 'events-2026-10-15.jsonl');
    const buf = fs.readFileSync(p); buf[10] = buf[10] === 0x41 ? 0x42 : 0x41; fs.writeFileSync(p, buf);   // same size, different bytes
    // settled (43186): COPIED AGAIN and RED, kept distinct. The set holds the true current bytes and is published; the run is ok:false, exit 1,
    // with a named finding. The next run dedupes from it, so the red fires once per change.
    const b = run(w);
    assert.equal(b.status, 1, `the run is red: exit 1 (got ${b.status})`);
    assert.equal(b.rep?.ok, false, 'ok: false');
    assert.ok(JSON.stringify(b.rep).includes('closed-history-changed') && JSON.stringify(b.rep).includes('events-2026-10-15.jsonl'), `a named finding closed-history-changed for that segment (report ${JSON.stringify(b.rep).slice(0, 300)})`);
    assert.equal(b.rep.published, true, 'and the set is still published, because its bytes are a true copy');
    const f = byName(b.rep, 'events-2026-10-15.jsonl');
    assert.ok(f && !f.linkedFrom, `the segment is copied, not linked (got ${JSON.stringify(f)})`);
    assert.notEqual(fs.statSync(setFile(b.rep, 'events-2026-10-15.jsonl')).ino, fs.statSync(setFile(a.rep, 'events-2026-10-15.jsonl')).ino, 'a different inode from the first set\'s copy');
    assert.deepEqual(fs.readFileSync(setFile(b.rep, 'events-2026-10-15.jsonl')), buf, 'holding the CURRENT bytes');
    if (fs.existsSync(VERIFY)) assert.equal(spawnSync(process.execPath, [VERIFY, '--set', b.rep.setDir, '--live-root', w.events, '--live-root', w.live], { encoding: 'utf8' }).status, 0, 'and the set verifies');
    await pause(1100);
    const c = run(w);
    assert.equal(c.status, 0, `the next run is green: the red fires once per change (exit ${c.status}): ${c.stdout.slice(0, 200)}`);
    assert.ok(path.resolve(byName(c.rep, 'events-2026-10-15.jsonl').linkedFrom || '').startsWith(path.resolve(b.rep.setDir)), 'and it dedupes the segment from the red run\'s set');
  } finally { clean(w); }
});

test('#1648 (B7) an UNVERIFIED or partial set is never a dedupe source', async () => {
  pre(); const w = world();
  try {
    // a REAL published set, renamed to look unverified and partial: everything a dedupe source could need is there except the right name
    const a = run(w); assert.equal(a.status, 0, `PRECONDITION: a first set (${a.stderr.slice(0, 200)})`);
    const realName = path.basename(a.rep.setDir);
    spawnSync('chmod', ['-R', 'u+w', a.rep.setDir]);
    spawnSync('cp', ['-Rp', a.rep.setDir, path.join(w.dest, `${realName}.partial`)]);
    fs.renameSync(a.rep.setDir, path.join(w.dest, `${realName}-UNVERIFIED`));
    await pause(1100);
    const r = run(w); assert.equal(r.status, 0, r.stderr.slice(0, 300));
    for (const f of r.rep.files || []) assert.ok(!f.linkedFrom || !/UNVERIFIED|partial/.test(f.linkedFrom), `${f.name} is not linked from an unverified or partial set (linkedFrom ${f.linkedFrom})`);
    for (const n of ['events-2026-10-15.jsonl', 'events-2026-10-16.jsonl']) assert.equal(fs.statSync(setFile(r.rep, n)).nlink, 1, `${n} has no other link`);
  } finally { clean(w); }
});

test('#1648 (B8) cursors beyond the captured log fail by name, and the set is not published', () => {
  pre(); const w = world();
  try {
    fs.writeFileSync(path.join(w.events, 'cursors.json'), `${JSON.stringify({ version: 1, seats: { ada: { acked: 5, served: 40 } } }, null, 2)}\n`);   // the log ends at seq 6
    const r = run(w);
    assert.notEqual(r.status, 0, 'not ok');
    assert.notEqual(r.rep?.ok, true);
    assert.ok((r.stdout + r.stderr).includes('cursors'), 'and it names the cursors');
    const published = fs.readdirSync(w.dest).filter((d) => /^records-/.test(d) && !/UNVERIFIED|partial/.test(d));
    assert.deepEqual(published, [], 'no published set');
  } finally { clean(w); }
});

test('#1648 (B9) a config that does not parse fails by name, and the set is not published', () => {
  pre(); const w = world();
  try {
    fs.writeFileSync(w.cfgB, '{"enabled": tru');
    const r = run(w);
    assert.notEqual(r.status, 0, 'not ok'); assert.notEqual(r.rep?.ok, true);
    assert.ok((r.stdout + r.stderr).includes('tending-config.json'), 'and it names the config');
    assert.deepEqual(fs.readdirSync(w.dest).filter((d) => /^records-/.test(d) && !/UNVERIFIED|partial/.test(d)), [], 'no published set');
  } finally { clean(w); }
});

test('#1648 (B10) the verifier on its own: a flipped byte and a link to a live file each fail by name; the untouched set passes', () => {
  pre(); assert.ok(fs.existsSync(VERIFY), 'PRECONDITION: scripts/record-files-verify.mjs exists');
  const w = world();
  try {
    const r = run(w); assert.equal(r.status, 0, r.stderr.slice(0, 300));
    const roots = ['--live-root', w.events, '--live-root', w.live];
    const verify = () => spawnSync(process.execPath, [VERIFY, '--set', r.rep.setDir, ...roots], { encoding: 'utf8', timeout: 60000 });
    const ok = verify(); assert.equal(ok.status, 0, `CONTROL: the untouched set verifies (exit ${ok.status}): ${(ok.stdout + ok.stderr).slice(0, 300)}`);
    const flip = setFile(r.rep, 'events-2026-10-16.jsonl');
    fs.chmodSync(flip, 0o644); const b = fs.readFileSync(flip); b[5] ^= 1; fs.writeFileSync(flip, b); fs.chmodSync(flip, 0o444);
    const v1 = verify(); assert.notEqual(v1.status, 0, 'a flipped byte fails'); assert.ok((v1.stdout + v1.stderr).includes('events-2026-10-16.jsonl'), 'by name');
    b[5] ^= 1; fs.chmodSync(flip, 0o644); fs.writeFileSync(flip, b); fs.chmodSync(flip, 0o444);
    assert.equal(verify().status, 0, 'restored, it verifies again');
    const swapped = setFile(r.rep, 'roster.json'); fs.chmodSync(r.rep.setDir, 0o755); fs.rmSync(swapped); fs.linkSync(w.cfgA, swapped);   // same bytes, but a live inode
    const v2 = verify(); assert.notEqual(v2.status, 0, 'a file that is a hard link to a live file fails, even with the right bytes'); assert.ok((v2.stdout + v2.stderr).includes('roster.json'), 'by name');
  } finally { clean(w); }
});
