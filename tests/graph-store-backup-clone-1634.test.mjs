/**
 * #1634 — THE GRAPH-STORE BACKUP WITH APFS CLONES: hourly copies that share unchanged immutable SSTs with the previous verified copy of the SAME UTC day, a daily chain reset,
 * corruption that cannot propagate, and a budget measured in PHYSICAL bytes. Rows written by the separate test author BEFORE the change, so they exist, RED, before any code is touched.
 *
 * THE OBSERVABLE CONTRACT THESE ROWS PIN (proposed by the author of the rows from the card's design, the owner's six rows and the reviewer's conditions of 14:36Z-14:39Z;
 * the reviewer may revise any line, as with #1637 and #1799). Names marked (proposed) are the author's choice.
 *
 *   C1  CLONE SOURCE. scripts/graph-store-backup.mjs `backupStore` clones a checkpoint file only when the SAME-UTC-DAY previous VERIFIED copy in `dest` holds a file of the SAME NAME whose
 *       recorded sha256 equals this checkpoint file's. Such a file is recorded in the new manifest as `{name, size, sha256, clonedFrom: <that copy's directory name>}`; a byte copy has no
 *       `clonedFrom`. The source is never the checkpoint, never the live store, never an -UNVERIFIED / .partial / incomplete copy. `backupStore`'s result carries `clones` (count). (proposed)
 *   C2  CHAIN RESET. The first copy of each UTC day clones NOTHING (a full byte copy), even with a verified copy from the day before; a later copy that day clones from that day's chain only.
 *   C3  CORRUPTION DOES NOT PROPAGATE. A previous copy that no longer matches its own manifest is NEVER a clone source (not for the file that rotted, not for any other file), the tick still
 *       publishes a verified copy from the checkpoint, and the result names the bad source in `suspectSources` (proposed). RESOLVED by the owner at 14:42Z (48077): the two texts
 *       described two moments. BEFORE cloning, a source that fails its manifest is not cloned from (K6) and the tick byte-copies; AFTER producing a copy, a copy that itself fails verify is never
 *       published (it stays -UNVERIFIED, exit 1: #1559 step 5 unchanged, asserted in K3). SETTLED by the reviewer at 14:43Z (commons 48078): reject the ENTIRE corrupt source (one rotted file taints the whole source copy, the strict reading K6 asserts), report it by name, then byte-copy from the checkpoint; publish only if the new copy independently verifies. That settles this contract point only, not acceptance of the draft.
 *   C4  SCRUB. `scrubBackups({dest, python})` (proposed) re-reads EVERY retained verified copy against its manifest and returns `{checked: [names], bad: [{name, problems}]}`, changing nothing;
 *       `graph-store-backup.mjs --scrub DEST` (proposed) prints that as JSON and exits 1 when `bad` is non-empty, else 0.
 *   C5  #1559 INVARIANTS HOLD on a cloned copy: verify (b) still demands nlink 1 on every file and fails a file hard-linked to another copy; a clone is a SEPARATE inode; deleting the clone source
 *       directory leaves the clone copy verifying.
 *   C6  THE BUDGET IS PHYSICAL BYTES. `uniqueBytes(paths)` (proposed, scripts/graph-store-backup-space.mjs) returns `{bytes, exact}`: the bytes physically allocated by the set, each shared extent
 *       counted ONCE, grouped by APFS clone family and NEVER by sha256 (identical content is not shared blocks). `exact` is true only when every file in the set is a whole-file clone or
 *       wholly private; a partially rewritten clone makes it false and the number is then CONSERVATIVE (counted as unshared, never below the truth).
 *   C7  THE ALARM USES IT. The monitor's `capacity({dest, copies, budgetBytes})` returns `uniqueBytes`, `logicalBytes` (what `du` would say) and `overBudget`, and its line says "unique". A set that
 *       is over budget only by LOGICAL size is not over budget. The ENTRY POINTS carry it: `monitor({dest, budgetBytes})` and the CLI's `--budget-bytes N` (proposed) report the same figure
 *       and say OVER BUDGET only above it (K13m), so a helper that turns async cannot pass K13 while the operator's line goes wrong.
 *   C8  PRUNE FREES ONLY LAST-REFERENCE BYTES. `pruneDest` returns `freedBytes` = uniqueBytes(dest) before minus after. Deleting a copy whose files another retained copy clones frees only its
 *       private bytes, never its allocated size. ⚠️ freedBytes is the RETAINED SET's allocation, NOT VOLUME FREE SPACE: a Time Machine local snapshot, or any reference outside dest, keeps
 *       the blocks allocated after freedBytes counts them freed. It must never be reported as disk reclaimed (review 48878, the accounting boundary).
 *
 * CLONE EVIDENCE IS PHYSICAL (review 48878, finding 1). A manifest label, a separate inode, nlink 1 and a matching sha256 are all true of a byte copy labelled as a clone, and of a clone taken from
 * the checkpoint and labelled with the previous copy; both passed K0-K2 at b726c5b. K0-K2 now also read the BLOCKS through a test-side oracle (F_LOG2PHYS_EXT, validated by K1o): a clone maps to
 * its named source's blocks (K1), and no copy maps to the live store's or the checkpoint's (K0, K2).
 *
 * NOT COVERED (and why): the DONE-WHEN restore from Time Machine into scratch (needs a person with Time Machine access; it is a procedure, not a row); the owner's isolated-volume `df` cross-check of the
 * budget (a separate row of theirs: these rows take their truth from the CONSTRUCTION of the files instead, which no other volume activity can disturb); the retention NUMBERS (24 h hourly, 7 daily,
 * 14 GB budget are proposals; K13b pins only that a pruned hourly never takes a day's chain root with it); APPROVAL OF THE ACCOUNTING ALGORITHM (K10-K12 are controls on constructed
 * files: equal-content independent families and the conservative partial-rewrite case. They do not validate any particular CLONEID/private-size method, which needs the isolated-volume check);
 * a non-APFS volume (the clone rows say UNAVAILABLE and skip, which the suite watch reads as INCOMPLETE).
 * Executor-backed rows need GRAPH_EXECUTOR_PYTHON (pyoxigraph), as tests/graph-store-backup-1559.test.mjs does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import * as BK from '../scripts/graph-store-backup.mjs';
import { planPrune, scanDest, pruneDest, stampOf } from '../scripts/graph-store-backup-schedule.mjs';
import * as MON from '../scripts/graph-store-backup-monitor.mjs';
import { uniqueBytesSync } from '../scripts/graph-store-backup-space.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = path.join(ROOT, 'scripts', 'graph-store-backup.mjs');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP_PY = !HAVE_PY ? `UNAVAILABLE: no python with pyoxigraph at ${PY}` : false;
const MiB = 1 << 20;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bk1634-'));
let N = 0; const fresh = (label) => { const d = path.join(TMP, `${label}-${++N}`); fs.mkdirSync(d, { recursive: true }); return d; };

// an APFS clone must work under TMP, or every clone row is UNAVAILABLE (never a pass)
const APFS = (() => { const a = path.join(TMP, 'probe-a'); fs.writeFileSync(a, 'x'.repeat(8192)); return spawnSync('cp', ['-c', a, path.join(TMP, 'probe-b')]).status === 0; })();
const NO_APFS = `UNAVAILABLE: cp -c (APFS clone) does not work under ${TMP}`;

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, BK.MANIFEST), 'utf8'));
const copyNames = (dest) => fs.readdirSync(dest).filter((n) => /^graph-store-\d{8}T\d{6}Z$/.test(n)).sort();
const ssts = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.sst'));
const largestSst = (dir) => ssts(dir).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const treeHash = (dir) => crypto.createHash('sha256').update(fs.readdirSync(dir, { recursive: true }).sort().map((f) => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? `${f}:${sha(p)}` : f; }).join('\n')).digest('hex');
const cloneFile = (src, dst) => { const r = spawnSync('cp', ['-c', src, dst]); assert.equal(r.status, 0, `cp -c ${src}: ${r.stderr}`); };
const rnd = (n) => crypto.randomBytes(n);

// ---------- THE PHYSICAL ORACLE (test-side, independent of the code under test) ------------------------------------------------------------------------------------------------
// A manifest's clonedFrom, a separate inode, nlink 1 and a matching sha256 are all true of a BYTE COPY labelled as a clone, and of a clone taken from the WRONG source (review 48878, two
// mutants that passed K0-K2). What only a real clone of the named source has is its BLOCKS: an APFS clone maps to the same device offsets as its source until either is written; a byte copy
// maps to fresh ones. fcntl(F_LOG2PHYS_EXT) reports the device offset of a file offset. This uses neither the production accounting helper nor getattrlist's clone id (the mechanism the
// proposed helper uses), so the helper is never its own oracle. Validated by K1o before any row leans on it.
const L2P = `
import fcntl, os, struct, sys, json
out = {}
for p in json.load(sys.stdin):
    sz = os.stat(p).st_size
    offs = sorted({0, (sz // 2) // 4096 * 4096, max(0, (sz - 1) // 4096 * 4096)}) if sz else []
    fd = os.open(p, os.O_RDONLY)
    try:
        devs = []
        for off in offs:
            _f, _c, dev = struct.unpack('<Iqq', fcntl.fcntl(fd, 65, struct.pack('<Iqq', 0, 4096, off)))   # 65 = F_LOG2PHYS_EXT
            devs.append(dev)
        out[p] = devs
    finally:
        os.close(fd)
print(json.dumps(out))
`;
/** path -> device offsets sampled at the first, middle and last 4 KiB block (empty for an empty file). */
const physOf = (files) => {
  const r = spawnSync(PY, ['-I', '-c', L2P], { input: JSON.stringify(files), encoding: 'utf8' });
  assert.equal(r.status, 0, `the physical oracle failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const sameBlocks = (a, b) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
const sharesAny = (a, b) => a.some((x) => b.includes(x));
/** the live store's files (and the tick's checkpoint, if it was kept) by name, for the "never shares blocks with the live store" checks */
const storeFiles = (fx, r) => [fx.store, r.checkpoint?.kept ? r.checkpoint.path : null].filter((d) => d && fs.existsSync(d))
  .flatMap((d) => fs.readdirSync(d).map((n) => path.join(d, n))).filter((p) => fs.lstatSync(p).isFile() && fs.statSync(p).size > 0);

// ---------- the executor-backed fixture: ONE store, many ticks into per-row dests -------------------------------------------------------------------------------------------
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/bk1634-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/bk1634-${n}` } });
let fixture;
async function getFixture() {
  if (fixture) return fixture;
  const store = path.join(TMP, 'store'); fs.mkdirSync(store);
  const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', 'bk1634', '--create']);
  const e = { p: x.proc, base: x.baseUrl };
  const c = createGraphClient({ baseUrl: e.base });
  for (let i = 0; i < 40; i++) assert.equal((await c.update(rule(i))).outcome, 'APPLIED');
  fixture = { store, e, c };
  return fixture;
}
const tick = (fx, dest, iso, extra = {}) => BK.backupStore({ url: fx.e.base, dest, python: PY, now: () => new Date(iso), ...extra });
// Teardown (review 48878, finding 3): the executor is AWAITED to exit before the scratch root it writes into is removed, and the root goes even when a row failed or the kill threw.
test.after(async () => {
  try {
    const p = fixture?.e.p;
    if (p && p.exitCode === null && p.signalCode === null) { const gone = new Promise((res) => p.once('exit', res)); p.kill('SIGKILL'); await gone; }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ---------- executor-backed rows -----------------------------------------------------------------------------------------------------------------------------------------
test('K1o ORACLE CONTROL (green today): the physical oracle says a cp -c clone has its source\'s blocks, and a byte copy and a rewritten clone do not', { skip: SKIP_PY || (!APFS && NO_APFS) }, () => {
  const d = fresh('k1o'); const a = path.join(d, 'a'), b = path.join(d, 'b'), c = path.join(d, 'c'), w = path.join(d, 'w');
  fs.writeFileSync(a, rnd(2 * MiB)); cloneFile(a, b); fs.writeFileSync(c, fs.readFileSync(a)); cloneFile(a, w); fs.writeFileSync(w, rnd(2 * MiB));
  assert.equal(sha(a), sha(c), 'CONTROL: the byte copy holds the same bytes, so only the blocks can tell them apart');
  const p = physOf([a, b, c, w]);
  assert.ok(sameBlocks(p[a], p[b]), `a clone maps to its source's blocks: ${JSON.stringify([p[a], p[b]])}`);
  assert.ok(!sharesAny(p[c], p[a]), `a byte copy shares no sampled block with its source: ${JSON.stringify([p[a], p[c]])}`);
  assert.ok(!sharesAny(p[w], p[a]), 'a clone rewritten in full no longer shares blocks with its source');
});

test('K0 CONTROL (green today): the FIRST tick into an empty dest verifies, byte-copies every file (no clonedFrom anywhere, and no block shared with the live store or the checkpoint), and the store has SSTs for the rows below to bite on', { skip: SKIP_PY }, async () => {
  const fx = await getFixture(); const dest = fresh('k0');
  const r = await tick(fx, dest, '2026-10-28T10:00:00Z');
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.ok(ssts(r.path).length >= 1, 'CONTROL: the fixture store has at least one SST, or no clone row below can mean anything');
  assert.ok(readManifest(r.path).files.every((f) => f.clonedFrom == null), 'an empty dest has nothing to clone from');
  if (!APFS) return;   // the physical half needs APFS; the label half above still runs
  // the chain root is a FULL BYTE COPY (C2): a copy cloned from the checkpoint (whose SSTs are hard links to the live store) would share the live store's blocks, and so would every later clone of it
  const live = storeFiles(fx, r); const mine = readManifest(r.path).files.filter((f) => f.size > 0).map((f) => path.join(r.path, f.name));
  assert.ok(live.some((p) => p.endsWith('.sst')) && mine.some((p) => p.endsWith('.sst')), 'CONTROL: SSTs on both sides, or the comparison below proves nothing');
  const p = physOf([...live, ...mine]); const liveBlocks = live.flatMap((f) => p[f]);
  for (const f of mine) assert.ok(!sharesAny(p[f], liveBlocks), `${path.basename(f)} shares blocks with the live store or checkpoint: the first copy of a day must be a byte copy`);
});

test('K1 CLONE: a second tick the SAME UTC day clones the unchanged files from the first copy (clonedFrom = that copy, and PHYSICALLY its blocks), each a separate inode, nlink 1, bytes equal to the recorded sha', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const dest = fresh('k1');
  const r1 = await tick(fx, dest, '2026-10-28T10:00:00Z'); assert.equal(r1.ok, true);
  const r2 = await tick(fx, dest, '2026-10-28T11:00:00Z'); assert.equal(r2.ok, true, JSON.stringify(r2.checks));
  const m1 = readManifest(r1.path), m2 = readManifest(r2.path);
  const cloned = m2.files.filter((f) => f.clonedFrom);
  assert.ok(cloned.length >= 1, `at least one file is cloned (a fix that never clones is not this card): ${JSON.stringify(m2.files.map((f) => [f.name, f.clonedFrom ?? null]))}`);
  for (const f of cloned) {
    assert.equal(f.clonedFrom, path.basename(r1.path), `${f.name} is cloned from the previous copy`);
    const prev = m1.files.find((p) => p.name === f.name);
    assert.ok(prev && prev.sha256 === f.sha256, `${f.name}: same name AND same recorded sha256 as the source`);
    const a = fs.statSync(path.join(r1.path, f.name)), b = fs.statSync(path.join(r2.path, f.name));
    assert.notEqual(b.ino, a.ino, `${f.name} is a SEPARATE inode from its source`); assert.equal(b.nlink, 1, `${f.name} nlink`);
    assert.equal(sha(path.join(r2.path, f.name)), f.sha256, `${f.name}: the clone's bytes equal the recorded sha256`);
  }
  // the label is not the evidence: a byte copy carrying clonedFrom passes every line above (review 48878, mutant 1). A real clone of the named copy maps to that copy's blocks.
  const pairs = cloned.filter((f) => f.size > 0).map((f) => [path.join(r1.path, f.name), path.join(r2.path, f.name)]);
  assert.ok(pairs.length >= 1, 'CONTROL: at least one non-empty cloned file to compare');
  const p = physOf(pairs.flat());
  for (const [src, cl] of pairs) assert.ok(sameBlocks(p[src], p[cl]), `${path.basename(cl)} is labelled clonedFrom ${path.basename(r1.path)} but does not map to its blocks: ${JSON.stringify([p[src], p[cl]])}`);
  assert.equal(r2.clones, cloned.length, 'the result reports how many files were cloned');
});

// The title used to add "or with a copy it does not name"; the body never checked it, and it is not true of a correct chain (copy 3 clones copy 2, which holds copy 1's blocks). Dropped, not asserted.
test('K2 SOURCE RULE: every clonedFrom names a PUBLISHED VERIFIED copy in dest, never the checkpoint; nothing in the new copy shares an inode OR A BLOCK with the live store or the checkpoint', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const dest = fresh('k2');
  await tick(fx, dest, '2026-10-28T10:00:00Z');
  const r2 = await tick(fx, dest, '2026-10-28T11:00:00Z'); assert.equal(r2.ok, true);
  const m2 = readManifest(r2.path); const published = new Set(copyNames(dest));
  const cloned = m2.files.filter((f) => f.clonedFrom); assert.ok(cloned.length >= 1, 'CONTROL: something was cloned');
  for (const f of cloned) {
    assert.ok(published.has(f.clonedFrom), `${f.name}: clonedFrom ${f.clonedFrom} is a published copy in dest`);
    assert.notEqual(path.resolve(f.clonedFrom), path.resolve(m2.checkpoint), 'and is not the checkpoint');
  }
  const live = new Set(fs.readdirSync(fx.store).map((f) => fs.statSync(path.join(fx.store, f)).ino));
  for (const f of fs.readdirSync(r2.path)) assert.ok(!live.has(fs.statSync(path.join(r2.path, f)).ino), `${f} shares an inode with the live store`);
  // a clone taken FROM THE CHECKPOINT and labelled with the previous copy passes everything above (review 48878, mutant 2): checkpoint SSTs are hard links to the live store, so that
  // clone holds the live store's blocks. A clone of a published byte copy holds none of them.
  const storeSide = storeFiles(fx, r2); const mine = m2.files.filter((f) => f.size > 0).map((f) => path.join(r2.path, f.name));
  assert.ok(storeSide.some((p) => p.endsWith('.sst')), 'CONTROL: the live store has SSTs to compare against');
  const p = physOf([...storeSide, ...mine]); const liveBlocks = storeSide.flatMap((f) => p[f]);
  for (const f of mine) assert.ok(!sharesAny(p[f], liveBlocks), `${path.basename(f)} shares blocks with the live store or checkpoint: a corrupt live SST would reach this copy`);
});

test('K3 SHA GATE: a checkpoint file with the SAME NAME but DIFFERENT bytes than the previous copy is byte-copied, never cloned', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture();
  // POSITIVE CONTROL, in a dest of its own: an unsabotaged second tick DOES clone. Without it this row passes on any implementation that never clones (it asserts an absence).
  const ctl = fresh('k3c'); await tick(fx, ctl, '2026-10-28T10:00:00Z'); const rc = await tick(fx, ctl, '2026-10-28T11:00:00Z');
  assert.ok(readManifest(rc.path).files.some((f) => f.clonedFrom), 'CONTROL: an unsabotaged same-day second tick clones at least one file (else the absence asserted below proves nothing)');
  const dest = fresh('k3');
  const r1 = await tick(fx, dest, '2026-10-28T10:00:00Z'); assert.equal(r1.ok, true);
  const X = path.basename(largestSst(r1.path));
  // the second tick's checkpoint is made to hold a DIFFERENT file under X's name. The checkpoint's files are hard links to the live store, so the name is unlinked FIRST and a fresh file written:
  // the live store's own bytes are never touched.
  const sabotaged = async (u, o) => {
    const res = await fetch(u, o); const body = await res.clone().json();
    if (res.status === 200) { const f = path.join(body.path, X); const b = fs.readFileSync(f); fs.unlinkSync(f); b[b.length >> 1] ^= 0xff; fs.writeFileSync(f, b); }
    return res;
  };
  const r2 = await tick(fx, dest, '2026-10-28T11:00:00Z', { fetchImpl: sabotaged });   // may be -UNVERIFIED (the store cannot open the altered SST); the manifest is what is read
  const m1 = readManifest(r1.path), m2 = readManifest(r2.path);
  assert.notEqual(m2.files.find((f) => f.name === X).sha256, m1.files.find((f) => f.name === X).sha256, 'CONTROL: the checkpoint really held different bytes under that name');
  assert.equal(m2.files.find((f) => f.name === X).clonedFrom ?? null, null, `${X}: same name, different sha256 -> a byte copy`);
  if (!r2.ok) assert.ok(r2.path.endsWith('-UNVERIFIED'), `a copy that fails verify is never published under its final name: ${r2.path}`);
});

test('K4 NOT A SOURCE: a previous copy that is -UNVERIFIED, .partial or incomplete is never cloned from (the second tick clones nothing)', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture();
  // POSITIVE CONTROL, in a dest of its own: with an intact published same-day source the second tick DOES clone, so "clones nothing" below is about the demotion, not about a missing feature.
  const ctl = fresh('k4c'); await tick(fx, ctl, '2026-10-28T10:00:00Z'); const rc = await tick(fx, ctl, '2026-10-28T11:00:00Z');
  assert.ok(readManifest(rc.path).files.some((f) => f.clonedFrom), 'CONTROL: with an intact published same-day source, the second tick clones (else the absence asserted below proves nothing)');
  const dest = fresh('k4');
  const r1 = await tick(fx, dest, '2026-10-28T10:00:00Z'); assert.equal(r1.ok, true);
  // the only earlier copy is demoted to -UNVERIFIED; a same-day .partial and an incomplete copy (manifest lists a file that is gone) sit beside it
  fs.renameSync(r1.path, `${r1.path}-UNVERIFIED`);
  const partial = path.join(dest, 'graph-store-20261028T103000Z.partial'); fs.mkdirSync(partial); fs.cpSync(`${r1.path}-UNVERIFIED`, partial, { recursive: true });
  const inc = path.join(dest, 'graph-store-20261028T104500Z'); fs.mkdirSync(inc); fs.cpSync(`${r1.path}-UNVERIFIED`, inc, { recursive: true }); fs.rmSync(path.join(inc, ssts(inc)[0]));
  const r2 = await tick(fx, dest, '2026-10-28T11:00:00Z'); assert.equal(r2.ok, true, JSON.stringify(r2.checks));
  assert.deepEqual(readManifest(r2.path).files.filter((f) => f.clonedFrom), [], 'no verified same-day source exists, so nothing is cloned');
});

test('K5 CHAIN RESET: the first copy of a UTC day clones NOTHING even with a verified copy from the day before; later copies clone from THAT day\'s chain only', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const dest = fresh('k5');
  const d1a = await tick(fx, dest, '2026-10-28T10:00:00Z'), d1b = await tick(fx, dest, '2026-10-28T11:00:00Z');
  const d2a = await tick(fx, dest, '2026-10-29T00:00:00Z'), d2b = await tick(fx, dest, '2026-10-29T01:00:00Z');
  for (const r of [d1a, d1b, d2a, d2b]) assert.equal(r.ok, true, JSON.stringify(r.checks));
  const from = (r) => [...new Set(readManifest(r.path).files.filter((f) => f.clonedFrom).map((f) => f.clonedFrom))];
  assert.deepEqual(from(d1a), [], 'day 1 first copy: a full byte copy');
  assert.deepEqual(from(d1b), [path.basename(d1a.path)], 'day 1 second copy clones from day 1 first');
  assert.deepEqual(from(d2a), [], 'day 2 FIRST copy clones nothing, although two verified day-1 copies exist: the chain resets');
  assert.deepEqual(from(d2b), [path.basename(d2a.path)], 'day 2 second copy clones from day 2 first, never from a day-1 copy');
});

test('K6 CORRUPTION DOES NOT PROPAGATE: a previous copy with one rotted byte is never a clone source; the tick still publishes a VERIFIED copy, byte-identical to the original content, and names the bad source', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const dest = fresh('k6');
  const r1 = await tick(fx, dest, '2026-10-28T10:00:00Z'); assert.equal(r1.ok, true);
  const m1 = readManifest(r1.path); const bad = largestSst(r1.path); const X = path.basename(bad);
  const b = fs.readFileSync(bad); b[b.length >> 1] ^= 0xff; fs.writeFileSync(bad, b);              // r1 is an independent copy (nlink 1): the live store is untouched
  assert.equal(BK.verifyBackup(r1.path, { python: PY }).ok, false, 'CONTROL: the rotted copy fails its own verify');
  const r2 = await tick(fx, dest, '2026-10-28T11:00:00Z');
  assert.equal(r2.ok, true, `the tick self-heals: ${JSON.stringify(r2.checks)}`);
  const m2 = readManifest(r2.path);
  assert.equal(m2.files.find((f) => f.name === X).sha256, m1.files.find((f) => f.name === X).sha256, `${X}: the new copy holds the ORIGINAL content, not the rotted bytes`);
  assert.deepEqual(m2.files.filter((f) => f.clonedFrom === path.basename(r1.path)), [], 'NOTHING is cloned from a copy that fails its own manifest (the strict reading: one rotted file taints the whole copy)');
  assert.deepEqual(r2.suspectSources, [path.basename(r1.path)], 'and the result names the bad source');
  assert.equal(BK.verifyBackup(r1.path, { python: PY }).ok, false, 'the bad copy is left as found, for a human');
});

test('K7 SCRUB: scrubBackups re-reads every retained verified copy against its manifest, names the bad one, changes nothing; the CLI exits 1 on a bad copy and 0 on a clean dest', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const clean = fresh('k7c'), dirty = fresh('k7d');
  for (const d of [clean, dirty]) { await tick(fx, d, '2026-10-28T10:00:00Z'); await tick(fx, d, '2026-10-28T11:00:00Z'); }
  assert.equal(typeof BK.scrubBackups, 'function', 'scripts/graph-store-backup.mjs exports scrubBackups({dest, python}) (proposed name)');
  const [first] = copyNames(dirty); const bad = largestSst(path.join(dirty, first)); const b = fs.readFileSync(bad); b[b.length >> 1] ^= 0xff; fs.writeFileSync(bad, b);
  const before = treeHash(dirty);
  const s = await BK.scrubBackups({ dest: dirty, python: PY });
  assert.deepEqual(s.checked.slice().sort(), copyNames(dirty), 'every retained verified copy was checked');
  assert.deepEqual(s.bad.map((x) => x.name), [first], 'only the rotted copy is reported, by name');
  assert.ok(s.bad[0].problems.length >= 1 && String(s.bad[0].problems.join(' ')).includes(path.basename(bad)), 'with the file it found');
  assert.equal(treeHash(dirty), before, 'a scrub changes nothing');
  const cliBad = spawnSync(process.execPath, [BACKUP, '--scrub', dirty, '--python', PY], { encoding: 'utf8' });
  assert.equal(cliBad.status, 1, cliBad.stdout + cliBad.stderr); assert.ok(cliBad.stdout.includes(first), 'the CLI names the bad copy');
  const cliOk = spawnSync(process.execPath, [BACKUP, '--scrub', clean, '--python', PY], { encoding: 'utf8' });
  assert.equal(cliOk.status, 0, cliOk.stdout + cliOk.stderr);
});

test('K8 #1559 INVARIANTS ON A CLONED COPY: it verifies (bytes, one link per file, read-only open); and a file replaced by a HARD LINK to another copy FAILS the independence check', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const dest = fresh('k8');
  const r1 = await tick(fx, dest, '2026-10-28T10:00:00Z'), r2 = await tick(fx, dest, '2026-10-28T11:00:00Z');
  const v = BK.verifyBackup(r2.path, { python: PY });
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  const X = readManifest(r2.path).files.find((f) => f.clonedFrom)?.name; assert.ok(X, 'CONTROL: a cloned file exists to tamper with');
  fs.rmSync(path.join(r2.path, X)); fs.linkSync(path.join(r1.path, X), path.join(r2.path, X));
  const w = BK.verifyBackup(r2.path, { python: PY });
  assert.equal(w.ok, false); assert.equal(w.checks.find((c) => c.name === 'independent').ok, false, 'a hard link to another copy is not independent');
});

test('K9 LAST REFERENCE: deleting the clone SOURCE copy leaves the cloned copy verifying (APFS keeps the shared blocks while any clone holds them)', { skip: SKIP_PY || (!APFS && NO_APFS) }, async () => {
  const fx = await getFixture(); const dest = fresh('k9');
  const r1 = await tick(fx, dest, '2026-10-28T10:00:00Z'), r2 = await tick(fx, dest, '2026-10-28T11:00:00Z');
  assert.ok(readManifest(r2.path).files.some((f) => f.clonedFrom), 'CONTROL: r2 holds clones');
  fs.rmSync(r1.path, { recursive: true, force: true });
  const v = BK.verifyBackup(r2.path, { python: PY });
  assert.equal(v.ok, true, JSON.stringify(v.checks));
});

// ---------- measurement rows (constructed files: the truth is the CONSTRUCTION, never a df delta) ---------------------------------------------------------------------------------------
const space = async () => { const m = await import('../scripts/graph-store-backup-space.mjs').catch((e) => ({ error: e })); assert.equal(typeof m.uniqueBytes, 'function', `scripts/graph-store-backup-space.mjs must export uniqueBytes(paths) -> {bytes, exact} (proposed): ${m.error?.message ?? 'no export'}`); return m.uniqueBytes; };
const near = (got, want, what, tol = MiB / 4) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${(got / MiB).toFixed(2)} MiB, want ${(want / MiB).toFixed(2)} MiB (+-${(tol / MiB).toFixed(2)})`);

test('K10 PHYSICAL BYTES through creation AND deletion: A (8 MiB), B = clone of A, C = independent byte copy of A. {A,B} = 8; {A,B,C} = 16; delete A -> 16; delete B -> 8; delete C -> 0. Every set exact.', { skip: !APFS && NO_APFS }, async () => {
  const uniqueBytes = await space();
  const dA = fresh('a'), dB = fresh('b'), dC = fresh('c'); const bytes = rnd(8 * MiB);
  fs.writeFileSync(path.join(dA, 'f.sst'), bytes); cloneFile(path.join(dA, 'f.sst'), path.join(dB, 'f.sst')); fs.writeFileSync(path.join(dC, 'f.sst'), fs.readFileSync(path.join(dA, 'f.sst')));
  const dirBytes = (ds) => ds.reduce((n, d) => n + fs.readdirSync(d).reduce((m, f) => m + fs.statSync(path.join(d, f)).size, 0), 0);
  assert.equal(dirBytes([dA, dB]), 16 * MiB, 'CONTROL: `du` would call {A,B} 16 MiB; the physical answer is 8');
  const ab = await uniqueBytes([dA, dB]); near(ab.bytes, 8 * MiB, '{A,B}'); assert.equal(ab.exact, true, '{A,B} is whole-file clones only');
  near((await uniqueBytes([dA, dB, dC])).bytes, 16 * MiB, '{A,B,C}: C shares nothing with A or B');
  fs.rmSync(dA, { recursive: true }); assert.equal(sha(path.join(dB, 'f.sst')), crypto.createHash('sha256').update(bytes).digest('hex'), 'CONTROL: deleting the source leaves the clone intact');
  near((await uniqueBytes([dB, dC])).bytes, 16 * MiB, 'delete A: B now owns its blocks alone');
  fs.rmSync(dB, { recursive: true }); near((await uniqueBytes([dC])).bytes, 8 * MiB, 'delete B');
  fs.rmSync(dC, { recursive: true }); near((await uniqueBytes([])).bytes, 0, 'delete C: nothing left');
});

test('K11 THE COUNTEREXAMPLE (reviewer, 14:37Z): two INDEPENDENT byte copies of the SAME content, each with a clone, are 16 MiB physically; one sha256 group would say 8', { skip: !APFS && NO_APFS }, async () => {
  const uniqueBytes = await space();
  const bytes = rnd(8 * MiB); const d1 = fresh('day1'), d1h = fresh('day1h'), d2 = fresh('day2'), d2h = fresh('day2h');
  fs.writeFileSync(path.join(d1, 'f.sst'), bytes); cloneFile(path.join(d1, 'f.sst'), path.join(d1h, 'f.sst'));
  fs.writeFileSync(path.join(d2, 'f.sst'), bytes); cloneFile(path.join(d2, 'f.sst'), path.join(d2h, 'f.sst'));
  const shas = new Set([d1, d1h, d2, d2h].map((d) => sha(path.join(d, 'f.sst')))); assert.equal(shas.size, 1, 'CONTROL: all four files carry ONE sha256, so any sha-grouped total is 8 MiB');
  const r = await uniqueBytes([d1, d1h, d2, d2h]);
  near(r.bytes, 16 * MiB, 'two physical extents, not one'); assert.equal(r.exact, true);
});

test('K12 THE STATED LIMIT: a clone partly REWRITTEN after cloning is labelled CONSERVATIVE (exact:false) and never counted below the truth (8 + 2 MiB), never above the unshared sum (16)', { skip: !APFS && NO_APFS }, async () => {
  const uniqueBytes = await space();
  const dA = fresh('pa'), dB = fresh('pb'); fs.writeFileSync(path.join(dA, 'f.sst'), rnd(8 * MiB)); cloneFile(path.join(dA, 'f.sst'), path.join(dB, 'f.sst'));
  const fd = fs.openSync(path.join(dB, 'f.sst'), 'r+'); fs.writeSync(fd, rnd(2 * MiB), 0, 2 * MiB, 0); fs.fsyncSync(fd); fs.closeSync(fd);
  const r = await uniqueBytes([dA, dB]);
  assert.equal(r.exact, false, 'a partially rewritten clone cannot be apportioned per file: the figure says so');
  assert.ok(r.bytes >= 10 * MiB - MiB / 4 && r.bytes <= 16 * MiB + MiB / 4, `conservative: ${(r.bytes / MiB).toFixed(2)} MiB must be in [10, 16]`);
});

// ---------- synthetic dest rows (a verified-looking copy needs only a manifest and files at their listed sizes) -----------------------------------------------------------------------
function synthCopy(dest, iso, files) {
  const dir = path.join(dest, `graph-store-${stampOf(Date.parse(iso))}`); fs.mkdirSync(dir, { recursive: true });
  const entries = files.map((f) => { const p = path.join(dir, f.name); if (f.cloneOf) cloneFile(f.cloneOf, p); else fs.writeFileSync(p, f.bytes); return { name: f.name, size: fs.statSync(p).size, sha256: sha(p) }; });
  fs.writeFileSync(path.join(dir, BK.MANIFEST), JSON.stringify({ takenAt: iso, files: entries }, null, 2));
  return dir;
}

test('K13 THE ALARM USES PHYSICAL BYTES: copy 2 clones copy 1\'s three 4 MiB files plus 1 MiB new. unique = 13, logical = 25. Budget 20 -> NOT over (a `du` alarm would fire); budget 12 -> over. The line says "unique".', { skip: !APFS && NO_APFS }, async () => {
  const dest = fresh('k13'); const b = [rnd(4 * MiB), rnd(4 * MiB), rnd(4 * MiB)];
  const c1 = synthCopy(dest, '2026-10-28T00:00:00Z', b.map((x, i) => ({ name: `${i}.sst`, bytes: x })));
  synthCopy(dest, '2026-10-28T01:00:00Z', [...b.map((_, i) => ({ name: `${i}.sst`, cloneOf: path.join(c1, `${i}.sst`) })), { name: '9.sst', bytes: rnd(MiB) }]);
  const copies = scanDest(dest); assert.equal(copies.filter((c) => c.state === 'verified').length, 2, 'CONTROL: both synthetic copies scan as verified');
  const ok = await MON.capacity({ dest, copies, budgetBytes: 20 * MiB });
  near(ok.uniqueBytes, 13 * MiB, 'unique', MiB / 2); near(ok.logicalBytes, 25 * MiB, 'logical (what du says)', MiB / 2);
  assert.equal(ok.overBudget, false, 'over 20 MiB only LOGICALLY: not over budget');
  const over = await MON.capacity({ dest, copies, budgetBytes: 12 * MiB });
  assert.equal(over.overBudget, true, 'unique 13 MiB > 12 MiB');
  assert.match(MON.capacityLine(over), /unique/i, 'the line labels the figure as unique (physical) bytes');
  assert.match(MON.capacityLine(over), /OVER BUDGET/, 'and says so when it is');
  assert.doesNotMatch(MON.capacityLine(ok), /OVER BUDGET/);
});

// review 48878, finding 2: K13 awaits the helpers it calls, but the alarm is monitor() and its CLI, and monitor() calls capacity() WITHOUT await today. An async capacity() would pass K13 while the
// real report carried a Promise. This row goes through the entry points the operator actually reads.
test('K13m THE ALARM, THROUGH ITS ENTRY POINTS: monitor({dest, budgetBytes}) and `graph-store-backup-monitor.mjs --budget-bytes N` report the same unique figure and say OVER BUDGET only when unique bytes exceed it', { skip: !APFS && NO_APFS }, () => {
  const dest = fresh('k13m'); const b = [rnd(4 * MiB), rnd(4 * MiB), rnd(4 * MiB)];
  const c1 = synthCopy(dest, '2026-10-28T00:00:00Z', b.map((x, i) => ({ name: `${i}.sst`, bytes: x })));
  synthCopy(dest, '2026-10-28T01:00:00Z', [...b.map((_, i) => ({ name: `${i}.sst`, cloneOf: path.join(c1, `${i}.sst`) })), { name: '9.sst', bytes: rnd(MiB) }]);
  const nowMs = Date.parse('2026-10-28T01:05:00Z');
  for (const [budget, over] of [[20 * MiB, false], [12 * MiB, true]]) {
    const r = MON.monitor({ dest, nowMs, budgetBytes: budget });
    assert.equal(typeof r.capacity?.uniqueBytes, 'number', `monitor() carries a NUMBER, not a Promise or nothing: ${String(r.capacity?.uniqueBytes)} (line: ${r.capacityLine})`);
    near(r.capacity.uniqueBytes, 13 * MiB, `monitor() unique at budget ${budget / MiB} MiB`, MiB / 2);
    assert.equal(r.capacity.overBudget, over, `monitor() overBudget at ${budget / MiB} MiB`);
    assert.doesNotMatch(r.capacityLine, /UNAVAILABLE|NaN|undefined|\[object/, 'the line the operator reads is a real figure');
    assert.match(r.capacityLine, /unique/i);
    (over ? assert.match : assert.doesNotMatch)(r.capacityLine, /OVER BUDGET/, `monitor() line at ${budget / MiB} MiB`);
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'graph-store-backup-monitor.mjs'), '--dest', dest, '--now', new Date(nowMs).toISOString(), '--budget-bytes', String(budget), '--json'], { encoding: 'utf8' });
    assert.notEqual(cli.status, 2, `the CLI accepts --budget-bytes (proposed): ${cli.stderr}`);   // the exit code otherwise reports FRESHNESS, which this row does not pin
    // the WORD "unique" is not the figure (delta re-read 48910: a CLI printing "Physical (unique) NaN undefined" passed). Both of the CLI's outputs must carry the constructed 13 MiB.
    const lines = cli.stdout.trim().split('\n'); let js; try { js = JSON.parse(lines.at(-1)); } catch { /* asserted below */ }
    assert.ok(js && typeof js === 'object', `--json ends with a JSON object (the CLI's existing structured line): ${lines.at(-1)}`);
    assert.ok(Number.isFinite(js.capacity?.uniqueBytes), `the CLI's JSON carries a finite capacity.uniqueBytes: ${JSON.stringify(js.capacity ?? null)}`);
    near(js.capacity.uniqueBytes, 13 * MiB, `CLI JSON unique at budget ${budget / MiB} MiB`, MiB / 2);
    assert.equal(js.capacity.overBudget, over, `CLI JSON overBudget at ${budget / MiB} MiB`);
    const human = lines.slice(0, -1).join('\n');
    assert.doesNotMatch(human, /UNAVAILABLE|NaN|undefined|\[object/, `the human lines carry real figures: ${human}`);
    const m = /unique\)?[^\n\d]{0,40}?(\d+(?:\.\d+)?)\s*(MiB|MB|GiB|GB)/i.exec(human);
    assert.ok(m, `the human line states the unique figure as a number with a unit: ${human}`);
    const UNIT = { MB: 1e6, MIB: MiB, GB: 1e9, GIB: 1 << 30 };
    near(Number(m[1]) * UNIT[m[2].toUpperCase()], 13 * MiB, `CLI human unique figure (${m[0]}) at budget ${budget / MiB} MiB`, MiB / 2);
    (over ? assert.match : assert.doesNotMatch)(human, /OVER BUDGET/, `CLI at ${budget / MiB} MiB: ${human}`);
  }
});

test('K14 PRUNE FREES ONLY LAST-REFERENCE BYTES: deleting a copy whose files another retained copy clones frees its PRIVATE bytes (1 MiB), not its allocated size (13); deleting every holder frees all', { skip: !APFS && NO_APFS }, async () => {
  const H = 3600e3, D = 24 * H;
  const build = (label) => {
    const dest = fresh(label); const b = [rnd(4 * MiB), rnd(4 * MiB), rnd(4 * MiB)];
    const r = synthCopy(dest, '2026-10-28T00:00:00Z', b.map((x, i) => ({ name: `${i}.sst`, bytes: x })));
    synthCopy(dest, '2026-10-28T01:00:00Z', [...b.map((_, i) => ({ name: `${i}.sst`, cloneOf: path.join(r, `${i}.sst`) })), { name: '9.sst', bytes: rnd(MiB) }]);
    return dest;
  };
  // scenario 1: R (day root) and H1 (clones R + 1 MiB) and a newer independent N. H1 is pruned, R stays: H1's cloned files are still held by R.
  const d1 = build('k14a'); synthCopy(d1, '2026-10-29T05:00:00Z', [{ name: '0.sst', bytes: rnd(4 * MiB) }]);
  const now1 = Date.parse('2026-10-29T05:00:00Z'); const plan1 = planPrune({ copies: scanDest(d1), nowMs: now1 });
  assert.deepEqual(plan1.delete.map((x) => x.name), [`graph-store-${stampOf(Date.parse('2026-10-28T01:00:00Z'))}`], 'CONTROL: the rule deletes exactly H1 here');
  const r1 = await pruneDest({ dest: d1, nowMs: now1 });
  assert.equal(typeof r1.freedBytes, 'number', 'pruneDest returns freedBytes (proposed)');
  // freedBytes is the RETAINED SET's physical allocation, before minus after (C8). It is not volume free space: a Time Machine local snapshot or any reference outside dest keeps blocks
  // allocated after this says they were freed. These constructed files have no such reference, which is why the figure can be checked here and only here.
  near(r1.freedBytes, 1 * MiB, 'H1 frees only its private 1 MiB, the 12 MiB it clones stay held by R', MiB / 2);
  // scenario 2: R and H1 both pruned (the newest verified copy N is 20 days later and weekly retention is off): everything they hold is freed
  const d2 = build('k14b'); synthCopy(d2, '2026-11-17T00:00:00Z', [{ name: '0.sst', bytes: rnd(4 * MiB) }]);
  const policy = { recentMs: 4 * H, hourlyMaxMs: 24 * H, dailyMaxMs: 14 * D, weeklyMaxMs: 0 }; const now2 = Date.parse('2026-11-17T01:00:00Z');
  assert.equal(planPrune({ copies: scanDest(d2), nowMs: now2, policy }).delete.length, 2, 'CONTROL: R and H1 are both deleted');
  const r2 = await pruneDest({ dest: d2, nowMs: now2, policy });
  near(r2.freedBytes, 13 * MiB, 'deleting the last holders frees 13 MiB (12 shared, once, + 1 private), not 25', MiB / 2);
});

// K14p/K14q (review 50286, the isolated-volume check): before - after of two CONSERVATIVE figures is not a bound on what was freed. the review's specimen, on an isolated volume: a 64 MiB
// copy A, a newer copy B cloned from it with 4 MiB rewritten, A pruned. The volume gained ~4 MiB; pruneDest at 401050a reported 67,112,960 bytes freed with no caveat. Contract (50290):
// either read inexact -> freedBytes null, freedEstimateBytes a number, freedExact false, freedNote names partial sharing, no log line /^FREED \d/. Both exact -> freedExact true and
// freedBytes === freedEstimateBytes. A non-null freedBytes with a flag beside it still fails K14p: a figure with a flag is a figure someone will quote.
const partlySharedPair = (label) => {
  const dest = fresh(label);
  const a = synthCopy(dest, '2026-10-28T00:00:00Z', [{ name: '0.sst', bytes: rnd(64 * MiB) }]);
  const b = synthCopy(dest, '2026-10-28T01:00:00Z', [{ name: '0.sst', cloneOf: path.join(a, '0.sst') }]);
  const f = path.join(b, '0.sst'); const fd = fs.openSync(f, 'r+');
  try { fs.writeSync(fd, rnd(4 * MiB), 0, 4 * MiB, 8 * MiB); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.writeFileSync(path.join(b, BK.MANIFEST), JSON.stringify({ takenAt: '2026-10-28T01:00:00Z', files: [{ name: '0.sst', size: fs.statSync(f).size, sha256: sha(f) }] }, null, 2));
  return { dest, a, b };
};
const ZERO = { recentMs: 0, hourlyMaxMs: 0, dailyMaxMs: 0, weeklyMaxMs: 0 };
const NOW_P = Date.parse('2026-11-06T21:00:00Z');

test('K14p A PARTLY SHARED PRUNE REPORTS NO EXACT FREED FIGURE: A (64 MiB) pruned, B (A\'s clone, 4 MiB rewritten) kept -> freedBytes null, freedExact false, an estimate and a note, never a bare FREED line', { skip: !APFS && NO_APFS }, async () => {
  const { dest, a, b } = partlySharedPair('k14p');
  const pre = uniqueBytesSync([a, b]);
  assert.equal(pre.exact, false, `PRECONDITION: the specimen really is partly shared (exact:false), or this row tests nothing (${JSON.stringify(pre)})`);
  assert.deepEqual(planPrune({ copies: scanDest(dest), nowMs: NOW_P, policy: ZERO }).delete.map((x) => x.name), [path.basename(a)], 'CONTROL: the rule deletes exactly A and keeps B');
  const log = [];
  const r = await pruneDest({ dest, nowMs: NOW_P, policy: ZERO, log: (x) => log.push(x) });
  assert.ok(!fs.existsSync(a) && fs.existsSync(b), 'CONTROL: the prune itself ran (the accounting never gates it)');
  assert.equal(r.freedBytes, null, `freedBytes must be null when either read is inexact (got ${r.freedBytes}; ~4 MiB was really freed)`);
  assert.equal(r.freedExact, false, `freedExact is false (got ${r.freedExact})`);
  assert.equal(typeof r.freedEstimateBytes, 'number', `freedEstimateBytes keeps before - after as a number (got ${r.freedEstimateBytes})`);
  assert.match(String(r.freedNote), /partial/i, `freedNote names partial sharing (got ${r.freedNote})`);
  assert.deepEqual(log.filter((l) => /^FREED \d/.test(l)), [], 'no log line states a bare FREED figure');
  assert.ok(log.some((l) => /^FREED unknown/.test(l) && /not exact/.test(l)), `the log says FREED unknown with the estimate labelled "not exact" (log: ${JSON.stringify(log.filter((l) => /^FREED/.test(l)))})`);
});

test('K14q BOTH READS EXACT -> freedExact true and freedBytes === freedEstimateBytes (the K14 world, with the new fields)', { skip: !APFS && NO_APFS }, async () => {
  const dest = fresh('k14q');
  const a = synthCopy(dest, '2026-10-28T00:00:00Z', [{ name: '0.sst', bytes: rnd(4 * MiB) }]);
  synthCopy(dest, '2026-10-28T01:00:00Z', [{ name: '0.sst', cloneOf: path.join(a, '0.sst') }, { name: '9.sst', bytes: rnd(MiB) }]);
  const r = await pruneDest({ dest, nowMs: NOW_P, policy: ZERO });
  assert.equal(r.freedExact, true, `freedExact is true when both reads are exact (got ${r.freedExact})`);
  assert.equal(typeof r.freedBytes, 'number', 'freedBytes is a number');
  assert.equal(r.freedBytes, r.freedEstimateBytes, `freedBytes === freedEstimateBytes (got ${r.freedBytes} vs ${r.freedEstimateBytes})`);
});

test('K13b CONTROL (green today): the retention rule keeps the FIRST copy of each UTC day (the chain root) and prunes the later hourlies, so a pruned hourly never takes a day\'s full byte copy with it', () => {
  const H = 3600e3, D = 24 * H; const copies = [];
  for (let day = 0; day < 4; day++) for (let h = 0; h < 24; h += 6) { const at = Date.parse('2026-10-25T00:00:00Z') + day * D + h * H; copies.push({ name: `graph-store-${stampOf(at)}`, atMs: at, state: 'verified' }); }
  const nowMs = Date.parse('2026-10-29T12:00:00Z'); const policy = { recentMs: 24 * H, hourlyMaxMs: 24 * H, dailyMaxMs: 7 * D, weeklyMaxMs: 0 };   // the card's PROPOSED numbers, as parameters only
  const kept = new Set(planPrune({ copies, nowMs, policy }).keep.map((k) => k.name));
  for (const c of copies.filter((x) => nowMs - x.atMs >= 24 * H && kept.has(x.name))) {
    const day = new Date(c.atMs).toISOString().slice(0, 10); const first = copies.filter((x) => new Date(x.atMs).toISOString().slice(0, 10) === day).sort((a, b) => a.atMs - b.atMs)[0];
    assert.equal(c.name, first.name, `${c.name} is kept beyond 24 h, so it must be its day's FIRST copy`);
  }
  assert.ok(copies.filter((x) => nowMs - x.atMs >= 24 * H && kept.has(x.name)).length >= 3, 'CONTROL: older days are retained, so the loop above bit on something');
});
