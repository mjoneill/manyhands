/**
 * #1559 — the graph-store backup: an INDEPENDENT copy (no inode shared with the live
 * store), verified by a SEPARATE read-only process against the checkpoint's own quad
 * count and commit marker. A damaged copy must FAIL verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';
import { backupStore, verifyBackup, MANIFEST } from '../scripts/graph-store-backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const BACKUP = path.join(ROOT, 'scripts', 'graph-store-backup.mjs');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = !HAVE_PY ? `UNAVAILABLE: no python with pyoxigraph at ${PY}` : false;

function start(store) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'bk', '--create'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/bk-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/bk-${n}` } });
const health = async (base) => (await fetch(`${base}/health`)).json();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// one store + one verified backup, shared by the damage tests (each damages its OWN copy)
let fixture;
async function getFixture() {
  if (fixture) return fixture;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const store = path.join(tmp, 'store');
  fs.mkdirSync(store);
  const e = await start(store);
  const c = createGraphClient({ baseUrl: e.base });
  for (let i = 0; i < 40; i++) assert.equal((await c.update(rule(i))).outcome, 'APPLIED');
  const h = await health(e.base);
  const r = await backupStore({ url: e.base, dest: path.join(tmp, 'backups'), python: PY });
  fixture = { tmp, store, e, c, h, r };
  return fixture;
}
function damagedCopy(name) {
  const dst = path.join(fixture.tmp, `copy-${name}`);
  fs.cpSync(fixture.r.path, dst, { recursive: true });
  return dst;
}
const largestSst = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.sst')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];

test.after(() => { if (fixture) fixture.e.p.kill('SIGKILL'); });

test('#1559 backup of an idle store VERIFIES: same quad count and commitSeq as the live store, every file an independent copy, checkpoint released', { skip: SKIP }, async () => {
  const { store, h, r, tmp } = await getFixture();
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.match(path.basename(r.path), /^graph-store-\d{8}T\d{6}Z$/, 'published under its final name, not .partial / -UNVERIFIED');
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['manifest', true], ['bytes', true], ['independent', true], ['open', true]]);
  assert.equal(String(r.checkpoint.commitSeq), String(h.commitSeq), 'the commit marker of the live store at backup time');
  assert.equal(String(h.commitSeq), '40', 'forty applied writes');
  // independence, measured against the live store's own inodes (not only nlink)
  const liveInodes = new Set(fs.readdirSync(store).map((f) => fs.statSync(path.join(store, f)).ino));
  for (const f of fs.readdirSync(r.path)) {
    const st = fs.statSync(path.join(r.path, f));
    assert.equal(st.nlink, 1, f);
    assert.ok(!liveInodes.has(st.ino), `${f} shares an inode with the live store`);
  }
  assert.deepEqual(fs.readdirSync(`${store}.checkpoints`), [], 'the hard-linked checkpoint is removed after the copy');
  // the CLI verify agrees, and a read-only open left the copy byte-identical
  const before = fs.readdirSync(r.path).map((f) => sha(path.join(r.path, f)));
  const cli = spawnSync(process.execPath, [BACKUP, '--verify', r.path, '--python', PY], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(fs.readdirSync(r.path).map((f) => sha(path.join(r.path, f))), before);
  assert.ok(fs.readdirSync(path.join(tmp, 'backups')).every((d) => !d.endsWith('.partial')));
});

test('#1559 the copy survives the live store being DESTROYED (it is a copy, not a second name for the same data)', { skip: SKIP }, async () => {
  const { tmp } = await getFixture();
  const store2 = path.join(tmp, 'store2'); fs.mkdirSync(store2);
  const e2 = await start(store2);
  let r2;
  try {
    assert.equal((await createGraphClient({ baseUrl: e2.base }).update(rule(900))).outcome, 'APPLIED');
    r2 = await backupStore({ url: e2.base, dest: path.join(tmp, 'backups2'), python: PY });
  } finally { e2.p.kill('SIGKILL'); await new Promise((res) => e2.p.on('exit', res)); }
  assert.equal(r2.ok, true);
  fs.rmSync(store2, { recursive: true, force: true });
  fs.rmSync(`${store2}.checkpoints`, { recursive: true, force: true });
  const v = verifyBackup(r2.path, { python: PY });
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  assert.equal(String(v.observed.commitSeq), '1');
});

test('#1559 a TRUNCATED copy FAILS verification (the bytes check AND the separate-process open both catch it)', { skip: SKIP }, async () => {
  await getFixture();
  const d = damagedCopy('trunc');
  const f = largestSst(d);
  fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2));
  const v = verifyBackup(d, { python: PY });
  assert.equal(v.ok, false);
  const by = Object.fromEntries(v.checks.map((c) => [c.name, c]));
  assert.equal(by.bytes.ok, false);
  assert.equal(by.open.ok, false);
  assert.match(by.open.detail, /Corruption|size mismatch/i);
  const cli = spawnSync(process.execPath, [BACKUP, '--verify', d, '--python', PY], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
});

test('#1559 the OPEN check stands on its own: a truncated copy whose manifest was rewritten to match still FAILS', { skip: SKIP }, async () => {
  await getFixture();
  const d = damagedCopy('consistent-lie');
  const f = largestSst(d);
  fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2));
  const m = JSON.parse(fs.readFileSync(path.join(d, MANIFEST), 'utf8'));
  for (const e of m.files) { const p = path.join(d, e.name); e.size = fs.statSync(p).size; e.sha256 = sha(p); }
  fs.writeFileSync(path.join(d, MANIFEST), JSON.stringify(m));
  const v = verifyBackup(d, { python: PY });
  const by = Object.fromEntries(v.checks.map((c) => [c.name, c]));
  assert.equal(by.bytes.ok, true, 'the bytes now match the (rewritten) manifest');
  assert.equal(by.open.ok, false, 'but a separate process cannot open it');
  assert.equal(v.ok, false);
});

test('#1559 the content comparison bites: a copy that opens fine but whose recorded commitSeq differs FAILS (twin: quads)', { skip: SKIP }, async () => {
  await getFixture();
  for (const [field, val] of [['commitSeq', '41'], ['quads', 1]]) {
    const d = damagedCopy(`marker-${field}`);
    const m = JSON.parse(fs.readFileSync(path.join(d, MANIFEST), 'utf8'));
    m[field] = val;
    fs.writeFileSync(path.join(d, MANIFEST), JSON.stringify(m));
    const v = verifyBackup(d, { python: PY });
    assert.equal(v.ok, false, field);
    assert.match(v.checks.find((c) => c.name === 'open').detail, new RegExp(`${field} \\S+ != ${val}`));
  }
});

test('#1559 a hard-linked file in the copy FAILS the independence check', { skip: SKIP }, async () => {
  await getFixture();
  const d = damagedCopy('linked');
  fs.linkSync(largestSst(d), path.join(fixture.tmp, 'a-second-name.sst'));
  const v = verifyBackup(d, { python: PY });
  assert.equal(v.checks.find((c) => c.name === 'independent').ok, false);
  assert.equal(v.ok, false);
});

test('#1559 a backup taken WHILE writes land still verifies: the checkpoint, count and marker come from inside the write lock', { skip: SKIP }, async () => {
  const { e, c, tmp } = await getFixture();
  const writes = Promise.all(Array.from({ length: 30 }, (_, i) => c.update(rule(100 + i))));
  const r = await backupStore({ url: e.base, dest: path.join(tmp, 'backups-busy'), python: PY });
  const outs = await writes;
  assert.ok(outs.every((o) => o.outcome === 'APPLIED'));
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  const seq = Number(r.checkpoint.commitSeq);
  assert.ok(seq >= 40 && seq <= 70, `a commitSeq from somewhere inside the burst: ${seq}`);
});

test('#1559 a DEGRADED executor refuses a checkpoint (503) and the backup fails loudly, leaving no partial copy', { skip: SKIP }, async () => {
  if (process.getuid?.() === 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-deg-'));
  const store = path.join(tmp, 'store'); fs.mkdirSync(store);
  const e = await start(store);
  try {
    fs.chmodSync(store, 0o555);
    await createGraphClient({ baseUrl: e.base }).update(rule(500));
    fs.chmodSync(store, 0o755);
    assert.equal((await health(e.base)).status, 'DEGRADED');
    await assert.rejects(backupStore({ url: e.base, dest: path.join(tmp, 'b'), python: PY }), /checkpoint refused \(503\)/);
    assert.equal(fs.existsSync(path.join(tmp, 'b')), false);
  } finally { try { fs.chmodSync(store, 0o755); } catch {} e.p.kill('SIGKILL'); }
});
