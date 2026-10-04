/**
 * #1577 copy guard, a reviewer's T3 Step B v2.9 C0 FAIL (2026-10-04T16:08Z): a refused start of an
 * UNPROMOTED copy was refused before any DATA write, but its BYTES changed (LOCK, LOG, IDENTITY,
 * a new WAL/MANIFEST/OPTIONS, CURRENT rewritten): the executor opened the store read-write
 * before the guard decided. Started on a published backup directory itself, the refusal would
 * leave a backup that no longer verifies against its own manifest.
 * Now: identity and home are read through a READ-ONLY open; read-write only once the start is
 * permitted. Twin: the same copy promoted serves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function run(store, extra = []) {
  return new Promise((resolve) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'cgb', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { p.kill('SIGTERM'); } });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => finish({ served: out.includes('\n'), code, err }));
  });
}
/** name → sha256 of every file in the directory (names included, so an added or removed file counts). */
function fingerprint(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[f] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

test('#1577 a REFUSED start of an unpromoted copy changes NOT ONE BYTE of it; the same copy promoted serves (twin)', { skip: SKIP }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-home-'));
  const created = await run(home, ['--create']);
  assert.ok(created.served, created.err);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-copy-'));
  fs.cpSync(home, copy, { recursive: true });
  const before = fingerprint(copy);

  const refused = await run(copy);
  assert.equal(refused.served, false, 'an unpromoted copy is refused');
  assert.match(refused.err, /REFUSED: this store was copied from/);
  assert.deepEqual(fingerprint(copy), before, 'the refused start left every file byte-identical (no LOCK, LOG, WAL, MANIFEST, OPTIONS or CURRENT change)');

  const sameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-same-'));
  fs.cpSync(home, sameDir, { recursive: true });
  const moved = home + '.aside';
  fs.renameSync(home, moved);
  fs.renameSync(sameDir, home);   // a backup copied into the original path (a different directory there)
  const before2 = fingerprint(home);
  const refused2 = await run(home);
  assert.equal(refused2.served, false, 'a copy placed at the home path is refused');
  assert.match(refused2.err, /copied from .* into the same path/);
  assert.deepEqual(fingerprint(home), before2, 'that refusal, too, changed no byte');

  const promoted = await run(copy, ['--promote-epoch']);
  assert.ok(promoted.served, 'twin: the same copy, promoted, serves: ' + promoted.err);
});
