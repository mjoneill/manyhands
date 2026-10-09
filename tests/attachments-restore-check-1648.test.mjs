/**
 * #1648, THE ATTACHMENT SLICE OF THE RESTORE DRILL: the test author's rows, written BEFORE the checker exists (2026-10-09). The drill's SET is the reviewer's, named on the card:
 * the executor snapshot + the ENTIRE attachments directory + a SHA-256/size MANIFEST captured from the source DURING that backup, with attachment writes and deletions FENCED across
 * the paired snapshot. Restored bytes are compared against that manifest, NOT against the live files, because the source may have changed and recovery must stay verifiable after
 * losing it. This file pins the CHECKER; it does not pin how the backup copies anything (that is the build's), and it does not cover the rest of #1648's record set.
 *
 * WHAT A REFERENCE IS, from source (server.js, read 2026-10-09): bytes live at `attachments/<id>`; the graph holds per reference `identifier` (the id), `name`, `encodingFormat`, `contentSize`.
 * THERE IS NO DIGEST IN A REFERENCE, so "the hashes match" can only mean the MANIFEST's. TWO of the 105 live references record contentSize 0 for non-empty files, so 0 means UNKNOWN.
 *
 * INTERFACE PINNED HERE (the builder implements scripts/attachments-restore-check.mjs against this file):
 *   export function checkRestore({ manifest, restoredDir, refs }) -> { ok, failures: [{code, id, detail}], orphans: [name], counts: { references, manifestFiles, restoredFiles, sizeUnknown, orphans } }
 *     manifest = { schema: 1, capturedAt: ISO, files: [{name, size, sha256}], fence: { before: {count, newestMtimeMs}, after: {count, newestMtimeMs} } }
 *     refs     = [{ id, size }]        (size = the reference's contentSize; 0 = unknown)
 *     It reads ONLY restoredDir and its arguments: never the live directory, never the network. It never throws on bad input: a bad manifest is a failure.
 *   CODES: manifest-invalid · manifest-fence-missing · manifest-fence-moved · no-references · manifest-empty · file-missing · size-mismatch · hash-mismatch · ref-unresolved · ref-size-mismatch · unexpected-file
 *   CLI:  node scripts/attachments-restore-check.mjs --manifest FILE --restored DIR --refs-json FILE        (the build also accepts --store DIR --python PY to read the references itself; not pinned here)
 *         exit 0 = ok · 1 = failures · 2 = usage; the LAST stdout line is the result as one JSON object.
 *
 *   A0  CONTROL: a perfect restore with an unreferenced file in it: ok, orphans reported as a NUMBER and a list, not a failure, zero-size metadata counted.
 *   A1  a missing file fails naming its id.            A2  a truncated file fails (size-mismatch).
 *   A3  a one-byte flip of the SAME size fails on the hash alone (hash-mismatch, no size-mismatch): the case a size check cannot see.
 *   A4  a reference whose id is not in the manifest fails (ref-unresolved).
 *   A5  a reference with contentSize 0 is UNKNOWN, never a failure, and is counted; a nonzero contentSize that differs from the manifest fails (ref-size-mismatch).
 *   A6  a file in the restored directory that the manifest does not list fails (unexpected-file): a dirty restore target is not a restore. (The test author's call; named.)
 *   A7  a manifest that is missing, not JSON, or the wrong schema is a failure (manifest-invalid), never a crash or a pass.
 *   A8  the FENCE: a manifest with no fence evidence, or whose fence moved between the before and the after reading (a write or delete during capture), fails; an equal fence passes.
 *   A9  VACUITY: no references, or a manifest with no files, fails; a pass over nothing is not a restore.
 *   A10 it compares against the MANIFEST, never the live bytes: the live directory named in the manifest does not exist and the check still works.
 *   A11 the CLI: exit 0 / 1 / 2 and a last stdout line that parses, carrying the codes.
 *   A12 several defects at once are ALL reported (no stop at the first), each naming its own id.
 *   A13 EVERY MANIFEST ENTRY IS VERIFIED, ORPHANS INCLUDED (reviewer, 10:01Z): a missing, truncated or one-byte-flipped file that NO reference points at fails exactly as a referenced one does.
 *
 * NOT COVERED, by name: how the backup job copies the directory or takes the manifest (the fence is checked only as evidence in the manifest, not as a property of the job); reading the references
 * from a restored executor store (needs pyoxigraph; a separate row once the build has it); the event log, the work ledger and the rest of #1648's record set; restore time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'attachments-restore-check.mjs');
const mod = await import(pathToFileURL(SCRIPT).href).catch((e) => ({ __error: e }));
const checkRestore = mod.checkRestore;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** a scratch restore: files {name: Buffer}, a manifest that matches them, refs for the named ids */
function world({ files = { 'a1.png': Buffer.from('alpha-bytes'), 'b2.jpg': Buffer.from('bravo-bytes-longer'), 'c3.png': Buffer.from('charlie') }, refIds = ['a1.png', 'b2.jpg'], fence = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1648-'));
  const restored = path.join(dir, 'restored'); fs.mkdirSync(restored);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(restored, n), b);
  const manifest = { schema: 1, capturedAt: '2026-10-09T10:00:00Z', sourceDir: '/does/not/exist/anymore', files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })),
    ...(fence ? { fence: { before: { count: Object.keys(files).length, newestMtimeMs: 1000 }, after: { count: Object.keys(files).length, newestMtimeMs: 1000 } } } : {}) };
  const refs = refIds.map((id) => ({ id, size: files[id]?.length ?? 0 }));
  return { dir, restored, manifest, refs, files };
}
const run = (w, over = {}) => checkRestore({ manifest: w.manifest, restoredDir: w.restored, refs: w.refs, ...over });
const codes = (r) => r.failures.map((f) => f.code).sort();
const has = (r, code, id) => r.failures.some((f) => f.code === code && (id === undefined || f.id === id));

test('A0 CONTROL: a perfect restore with one unreferenced file is ok; the orphan is a number and a list, not a failure', () => {
  assert.equal(typeof checkRestore, 'function', `scripts/attachments-restore-check.mjs must export checkRestore (${mod.__error?.message ?? 'ok'})`);
  const w = world(); const r = run(w);
  assert.equal(r.ok, true, JSON.stringify(r.failures)); assert.deepEqual(r.failures, []);
  assert.deepEqual(r.orphans, ['c3.png']); assert.equal(r.counts.orphans, 1);
  assert.equal(r.counts.references, 2); assert.equal(r.counts.manifestFiles, 3); assert.equal(r.counts.restoredFiles, 3); assert.equal(r.counts.sizeUnknown, 0);
});

test('A1 a missing restored file fails naming its id', () => {
  const w = world(); fs.rmSync(path.join(w.restored, 'b2.jpg'));
  const r = run(w); assert.equal(r.ok, false); assert.ok(has(r, 'file-missing', 'b2.jpg'), JSON.stringify(r.failures));
});

test('A2 a truncated file fails as a size-mismatch', () => {
  const w = world(); fs.writeFileSync(path.join(w.restored, 'b2.jpg'), w.files['b2.jpg'].subarray(0, 5));
  const r = run(w); assert.equal(r.ok, false); assert.ok(has(r, 'size-mismatch', 'b2.jpg'), JSON.stringify(r.failures));
});

test('A3 a one-byte flip of the SAME size fails on the hash alone: the failure a size check cannot see', () => {
  const w = world(); const b = Buffer.from(w.files['a1.png']); b[2] ^= 0xff; fs.writeFileSync(path.join(w.restored, 'a1.png'), b);
  assert.equal(b.length, w.files['a1.png'].length, 'precondition: same size');
  const r = run(w); assert.equal(r.ok, false);
  assert.ok(has(r, 'hash-mismatch', 'a1.png'), JSON.stringify(r.failures)); assert.ok(!has(r, 'size-mismatch', 'a1.png'), 'and it is NOT reported as a size problem');
});

test('A4 a reference whose id is not in the manifest fails (ref-unresolved)', () => {
  const w = world(); w.refs.push({ id: 'ghost.png', size: 10 });
  const r = run(w); assert.equal(r.ok, false); assert.ok(has(r, 'ref-unresolved', 'ghost.png'), JSON.stringify(r.failures));
});

test('A5 contentSize 0 is UNKNOWN (counted, not a failure); a nonzero contentSize that differs from the manifest fails', () => {
  const w = world(); w.refs[0].size = 0;
  const unknown = run(w); assert.equal(unknown.ok, true, JSON.stringify(unknown.failures)); assert.equal(unknown.counts.sizeUnknown, 1);
  const w2 = world(); w2.refs[1].size = w2.files['b2.jpg'].length + 7;
  const lie = run(w2); assert.equal(lie.ok, false); assert.ok(has(lie, 'ref-size-mismatch', 'b2.jpg'), JSON.stringify(lie.failures));
});

test('A6 a file in the restored directory that the manifest does not list fails (unexpected-file)', () => {
  const w = world(); fs.writeFileSync(path.join(w.restored, 'stray.png'), 'x');
  const r = run(w); assert.equal(r.ok, false); assert.ok(has(r, 'unexpected-file', 'stray.png'), JSON.stringify(r.failures));
});

test('A7 a missing, non-JSON or wrong-schema manifest is a failure and never a crash or a pass', () => {
  const w = world();
  for (const manifest of [undefined, null, 'not json', { schema: 2, files: [] }, { files: 'nope' }, []]) {
    let r; assert.doesNotThrow(() => { r = run(w, { manifest }); }, `manifest ${JSON.stringify(manifest)}`);
    assert.equal(r.ok, false); assert.ok(has(r, 'manifest-invalid'), `${JSON.stringify(manifest)}: ${JSON.stringify(r.failures)}`);
  }
});

test('A8 the fence: no fence evidence fails, a moved fence fails, an equal fence passes', () => {
  const none = world({ fence: false }); const rn = run(none); assert.equal(rn.ok, false); assert.ok(has(rn, 'manifest-fence-missing'), JSON.stringify(rn.failures));
  for (const move of [{ count: 99 }, { newestMtimeMs: 2000 }]) {
    const w = world(); w.manifest.fence.after = { ...w.manifest.fence.after, ...move };
    const r = run(w); assert.equal(r.ok, false, JSON.stringify(move)); assert.ok(has(r, 'manifest-fence-moved'), JSON.stringify(r.failures));
  }
  assert.equal(run(world()).ok, true, 'CONTROL: an equal fence passes');
});

test('A9 VACUITY: no references, or a manifest with no files, fails', () => {
  const w = world(); const r1 = run(w, { refs: [] }); assert.equal(r1.ok, false); assert.ok(has(r1, 'no-references'), JSON.stringify(r1.failures));
  const e = world({ files: {}, refIds: [] }); const r2 = run(e); assert.equal(r2.ok, false); assert.ok(has(r2, 'manifest-empty') || has(r2, 'no-references'), JSON.stringify(r2.failures));
});

test('A10 it compares against the MANIFEST, never the live bytes: the live directory the manifest names does not exist and the check still passes', () => {
  const w = world(); assert.equal(fs.existsSync(w.manifest.sourceDir), false, 'precondition: the source directory is gone');
  assert.equal(run(w).ok, true);
});

test('A11 the CLI: exit 0 on a clean restore, 1 on failures, 2 on usage; the last stdout line parses', () => {
  const w = world(); const mf = path.join(w.dir, 'manifest.json'); const rf = path.join(w.dir, 'refs.json');
  fs.writeFileSync(mf, JSON.stringify(w.manifest)); fs.writeFileSync(rf, JSON.stringify(w.refs));
  const go = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
  const ok = go(['--manifest', mf, '--restored', w.restored, '--refs-json', rf]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout); assert.equal(JSON.parse(ok.stdout.trim().split('\n').pop()).ok, true);
  fs.rmSync(path.join(w.restored, 'a1.png'));
  const bad = go(['--manifest', mf, '--restored', w.restored, '--refs-json', rf]);
  assert.equal(bad.status, 1, bad.stderr + bad.stdout);
  const last = JSON.parse(bad.stdout.trim().split('\n').pop()); assert.equal(last.ok, false); assert.ok(last.failures.some((f) => f.code === 'file-missing' && f.id === 'a1.png'));
  assert.equal(go(['--manifest', mf]).status, 2, 'a missing required flag is a usage error');
});

test('A12 several defects at once are ALL reported, each naming its own id', () => {
  const w = world(); fs.rmSync(path.join(w.restored, 'a1.png')); const b = Buffer.from(w.files['b2.jpg']); b[0] ^= 1; fs.writeFileSync(path.join(w.restored, 'b2.jpg'), b); w.refs.push({ id: 'ghost.png', size: 3 });
  const r = run(w); assert.equal(r.ok, false);
  assert.ok(has(r, 'file-missing', 'a1.png') && has(r, 'hash-mismatch', 'b2.jpg') && has(r, 'ref-unresolved', 'ghost.png'), JSON.stringify(codes(r)));
});

test('A13 an UNREFERENCED manifest entry is verified too: missing, truncated and same-size byte-flip each fail (a checker that only walks references passes every other row)', () => {
  const orphan = 'c3.png';
  const w1 = world(); fs.rmSync(path.join(w1.restored, orphan));
  const r1 = run(w1); assert.equal(r1.ok, false); assert.ok(has(r1, 'file-missing', orphan), JSON.stringify(r1.failures));
  const w2 = world(); fs.writeFileSync(path.join(w2.restored, orphan), w2.files[orphan].subarray(0, 3));
  const r2 = run(w2); assert.equal(r2.ok, false); assert.ok(has(r2, 'size-mismatch', orphan), JSON.stringify(r2.failures));
  const w3 = world(); const b = Buffer.from(w3.files[orphan]); b[1] ^= 0xff; fs.writeFileSync(path.join(w3.restored, orphan), b);
  const r3 = run(w3); assert.equal(r3.ok, false); assert.ok(has(r3, 'hash-mismatch', orphan), JSON.stringify(r3.failures)); assert.ok(!has(r3, 'size-mismatch', orphan));
  assert.deepEqual(run(world()).orphans, [orphan], 'CONTROL: the untouched orphan is still just reported as an orphan');
});
