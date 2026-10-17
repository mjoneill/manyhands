/**
 * #1648 (the rest) — RESTORE A RECORD-FILES SET INTO AN INDEPENDENT WRITABLE COPY. TEST AUTHOR's, written before the build (RED until
 * scripts/record-files-restore.mjs exists). The reviewer's owed coverage (43219: "the independent writable restore/write probe"), the interface
 * the PO fixed (43255):
 *   node scripts/record-files-restore.mjs --set DIR --to EMPTY_DIR [--python PY]
 *   copies (never links) into --to: executor-store/, attachments/, board-data-events/ (segments and cursors.json), work-store/, config/;
 *   verifies each restored file against the set manifest; checks that no restored file shares an inode with ANY file under the set's backup root;
 *   prints ONE JSON {ok, set, to, files:[{name, role, bytes, sha256}], layout:{executorStore, attachments, eventLog, workStore, config}, next};
 *   exit 0 exactly when ok; exit 2 for a refusal (a missing flag, a non-empty --to, an -UNVERIFIED or .partial set, a set whose verify fails),
 *   with nothing written. It does NOT start an executor; `next` is the start line, with --promote-epoch.
 *
 *   R0  refusals: a missing flag, a non-empty --to (left untouched), an -UNVERIFIED set, a .partial set, a set that fails verification: exit 2,
 *       and nothing written into --to
 *   R1  a clean paired set restores into the layout: every file copied, each at its manifest's size and sha256, WRITABLE, and no inode shared
 *       with any file under the backup root (every retained set, not only this one); `next` starts an executor on layout.executorStore with
 *       --promote-epoch
 *   R2  the restore-and-write probe: two paired sets (so the sets share inodes through dedupe), the newest restored, an executor started on the
 *       copy with --promote-epoch, a write landed and read back; afterwards every file of every retained set is byte-unchanged and each set
 *       still verifies on its own
 *
 * NOT covered, by name: restoring onto a live board (the operator's step, not this command's); a restore that runs out of disk part-way; the
 * board document (excluded by name from these sets).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { Q_POSITION } from '../core/logborn-unit.mjs';
import { freePort } from './helpers/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB = path.join(ROOT, 'scripts/record-files-backup.mjs');
const VERIFY = path.join(ROOT, 'scripts/record-files-verify.mjs');
const RESTORE = path.join(ROOT, 'scripts/record-files-restore.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const BK = 'urn:scrum:bookkeeping:executor';
const ID = '12121212-3434-4567-8989-121212121212.txt';

const temps = [];
after(() => { for (const d of temps) { spawnSync('chmod', ['-R', 'u+rwx', d]); fs.rmSync(d, { recursive: true, force: true }); } });
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const parse = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()); } catch { return null; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (seq) => JSON.stringify({ seq, op: 'upsert', entity: `e${seq}`, actor: 'ada', occurred_at: '2026-10-15T00:00:00.000Z', recorded_at: '2026-10-15T00:00:00.000Z', state: { n: seq } });
const walkFiles = (d) => fs.readdirSync(d, { recursive: true }).map((n) => path.join(d, n)).filter((p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } });
const pre = () => assert.ok(fs.existsSync(RESTORE), 'PRECONDITION: scripts/record-files-restore.mjs exists (RED until it is built)');

function world() {
  const root = mk('rfr1648-'); const live = path.join(root, 'live'); const events = path.join(live, 'board-data-events'); const dest = path.join(root, 'dest');
  fs.mkdirSync(events, { recursive: true }); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(events, 'events-2026-10-15.jsonl'), `${ev(1)}\n${ev(2)}\n`);
  fs.writeFileSync(path.join(events, 'cursors.json'), `${JSON.stringify({ version: 1, seats: { ada: { acked: 1, served: 2 } } })}\n`);
  const ledger = path.join(live, 'work-objects.jsonl'); fs.writeFileSync(ledger, '{"id":"w1"}\n');
  const cfg = path.join(live, 'roster.json'); fs.writeFileSync(cfg, JSON.stringify({ seats: {} }));
  const att = path.join(root, 'attachments'); fs.mkdirSync(att); fs.writeFileSync(path.join(att, ID), 'abc');
  return { root, live, events, dest, ledger, cfg, att, args: ['--dest', dest, '--event-log-dir', events, '--work-store', ledger, '--config', cfg, '--min-free-bytes', '1'] };
}
async function seeded(tag) {
  const store = tmpStore(`rfr1648-${tag}-`); fs.rmSync(store, { recursive: true }); temps.push(store, `${store}.checkpoints`);
  const ex = await startExecutor({ store, datasetId: `rfr-${tag}`, create: true });
  const cardJson = JSON.stringify({ '@id': `card-${tag}`, '@type': 'Card', title: 'holds a file', attachments: [{ id: ID, name: 'f.txt', mime: 'text/plain', size: 3 }] });
  const r = await fetch(`${ex.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:op:rfr-1648-seed-${tag}` }, body: `INSERT DATA {
    <https://scrumboard.local/entity/post-${tag}-att-0> <https://scrumboard.local/ns#attachmentOf> <https://scrumboard.local/entity/post-${tag}> ;
      <https://schema.org/identifier> "${ID}" ; <https://schema.org/contentSize> "3" .
    GRAPH <${BK}> { <https://scrumboard.local/entity/card-${tag}> <https://scrumboard.local/ns#entityJson> ${JSON.stringify(cardJson)} } }` });
  assert.equal(r.status, 200, `PRECONDITION: the seed landed: ${await r.text()}`);
  return ex;
}
const backup = (w, ex) => { const r = spawnSync(process.execPath, [JOB, ...w.args, '--source-attachments', w.att, '--source-executor', ex.baseUrl, '--python', PY], { cwd: w.root, encoding: 'utf8', timeout: 180000 }); return { ...r, rep: parse(r.stdout) }; };
const restore = (...args) => { const r = spawnSync(process.execPath, [RESTORE, ...args], { encoding: 'utf8', timeout: 180000 }); return { ...r, rep: parse(r.stdout) }; };
const verify = (w, set) => spawnSync(process.execPath, [VERIFY, '--set', set, '--live-root', w.live, '--live-root', w.att, '--python', PY], { encoding: 'utf8', timeout: 180000 });
const allSetFiles = (dest) => fs.readdirSync(dest).filter((n) => /^records-/.test(n)).flatMap((n) => walkFiles(path.join(dest, n)));

test('#1648 (R0) refusals: a missing flag, a non-empty --to, an UNVERIFIED or partial set, a set that fails verification: exit 2, nothing written', { skip: SKIP, timeout: 400000 }, async () => {
  pre(); const w = world(); const ex = await seeded('r0');
  try {
    const a = backup(w, ex); assert.equal(a.status, 0, `PRECONDITION: a clean paired set (${(a.stdout + a.stderr).slice(0, 200)})`);
    const set = a.rep.setDir;
    for (const args of [['--to', mk('rfr1648-to-')], ['--set', set]]) {
      const to = args[0] === '--to' ? args[1] : null;
      const r = restore(...args, '--python', PY);
      assert.equal(r.status, 2, `missing ${args[0] === '--to' ? '--set' : '--to'}: exit 2 (got ${r.status})`);
      if (to) assert.deepEqual(fs.readdirSync(to), [], 'and nothing written');
    }
    const busy = mk('rfr1648-busy-'); fs.writeFileSync(path.join(busy, 'precious.txt'), 'keep');
    const r1 = restore('--set', set, '--to', busy, '--python', PY);
    assert.equal(r1.status, 2, `a non-empty --to: exit 2 (got ${r1.status})`);
    assert.deepEqual(fs.readdirSync(busy), ['precious.txt'], 'and it is left exactly as it was'); assert.equal(fs.readFileSync(path.join(busy, 'precious.txt'), 'utf8'), 'keep');
    // a --port out of range (43266: 1024 to 65535, otherwise exit 2)
    for (const bad of ['80', '70000', 'x']) {
      const to = mk('rfr1648-to-'); const r = restore('--set', set, '--to', to, '--python', PY, '--port', bad);
      assert.equal(r.status, 2, `--port ${bad}: exit 2 (got ${r.status})`); assert.deepEqual(fs.readdirSync(to), [], 'and nothing written');
      // what refused must be the RANGE, not "unknown argument" (the B0 lesson: a build without --port refuses every one of these too)
      assert.match(r.stdout + r.stderr, /1024|65535|range/i, `--port ${bad}: the refusal names the allowed range (got ${(r.stdout + r.stderr).slice(0, 200)})`);
    }
    // a --to INSIDE the backup root (the builder's refusal, 630e63c; its mutant VR7 survived every other row): a restore is an independent copy
    const inside = path.join(w.dest, 'restore-here'); fs.mkdirSync(inside);
    const r3 = restore('--set', set, '--to', inside, '--python', PY);
    assert.equal(r3.status, 2, `a --to inside the backup root: exit 2 (got ${r3.status})`); assert.deepEqual(fs.readdirSync(inside), [], 'and nothing written');
    fs.rmdirSync(inside);
    for (const suffix of ['-UNVERIFIED', '.partial']) {
      const copy = `${set}${suffix}`; spawnSync('cp', ['-Rp', set, copy]);
      const to = mk('rfr1648-to-'); const r = restore('--set', copy, '--to', to, '--python', PY);
      assert.equal(r.status, 2, `a ${suffix} set: exit 2 (got ${r.status})`); assert.deepEqual(fs.readdirSync(to), [], 'and nothing written');
    }
    // a set that fails verification: a byte flipped in a copy of the set (the published one is left alone). The copy keeps the PUBLISHED name,
    // in another directory, so it can only be refused by verifying it, never by its name (the B0 lesson: assert WHAT refused)
    const otherDest = mk('rfr1648-otherdest-'); const bad = path.join(otherDest, path.basename(set)); spawnSync('cp', ['-Rp', set, bad]); spawnSync('chmod', ['-R', 'u+w', bad]);
    const seg = path.join(bad, 'events-2026-10-15.jsonl'); const b = fs.readFileSync(seg); b[3] ^= 1; fs.writeFileSync(seg, b);
    spawnSync('chmod', ['-R', 'a-w', bad]);   // read-only like a published set, BEFORE the restore: only the byte flip separates it from a good one
    const to = mk('rfr1648-to-'); const r2 = restore('--set', bad, '--to', to, '--python', PY);
    assert.equal(r2.status, 2, `a set that fails verification: exit 2 (got ${r2.status})`); assert.deepEqual(fs.readdirSync(to), [], 'and nothing written');
    assert.ok((r2.stdout + r2.stderr).includes('events-2026-10-15.jsonl'), `and it names the file that failed (output ${(r2.stdout + r2.stderr).slice(0, 300)})`);
  } finally { await killExecutor(ex); }
});

test('#1648 (R1) a clean paired set restores into the layout: copied, verified, writable, sharing no inode with any retained set; `next` promotes', { skip: SKIP, timeout: 400000 }, async () => {
  pre(); const w = world(); const ex = await seeded('r1');
  try {
    const a = backup(w, ex); assert.equal(a.status, 0, 'PRECONDITION: set 1');
    await pause(1100);
    const b = backup(w, ex); assert.equal(b.status, 0, 'PRECONDITION: set 2 (it dedupes from set 1, so the two sets share inodes)');
    const to = mk('rfr1648-to-');
    const r = restore('--set', b.rep.setDir, '--to', to, '--python', PY);
    assert.equal(r.status, 0, `exit 0 (got ${r.status}): ${(r.stdout + r.stderr).slice(0, 300)}`);
    assert.equal(r.rep?.ok, true, 'ok:true');
    const L = r.rep.layout;
    for (const [k, rel] of [['executorStore', 'executor-store'], ['attachments', 'attachments'], ['eventLog', 'board-data-events'], ['workStore', 'work-store'], ['config', 'config']]) {
      assert.equal(path.resolve(L[k]), path.resolve(to, rel), `layout.${k} is --to/${rel}`); assert.ok(fs.statSync(L[k]).isDirectory(), `and it exists`);
    }
    assert.equal(fs.readFileSync(path.join(L.attachments, ID), 'utf8'), 'abc', 'the attachment is restored with its bytes');
    assert.ok(fs.existsSync(path.join(L.eventLog, 'events-2026-10-15.jsonl')) && fs.existsSync(path.join(L.eventLog, 'cursors.json')), 'the segment and cursors.json are restored');
    assert.ok(fs.existsSync(path.join(L.workStore, 'work-objects.jsonl')) && fs.existsSync(path.join(L.config, 'roster.json')), 'the ledger and the config are restored');
    const restored = walkFiles(to);
    assert.ok(restored.length >= (r.rep.files || []).length && r.rep.files.length > 0, `every listed file is restored (${restored.length} on disk, ${r.rep.files.length} listed)`);
    for (const f of r.rep.files) {
      const p = restored.find((x) => x.endsWith(`/${path.basename(f.name)}`) && fs.statSync(x).size === f.bytes);
      assert.ok(p, `${f.name} is on disk under --to`); assert.equal(sha(p), f.sha256, `${f.name}: the restored bytes match`);
    }
    const setInodes = new Set(allSetFiles(w.dest).map((p) => `${fs.statSync(p).dev}:${fs.statSync(p).ino}`));
    for (const p of restored) {
      assert.equal(setInodes.has(`${fs.statSync(p).dev}:${fs.statSync(p).ino}`), false, `${path.relative(to, p)} shares no inode with ANY retained set`);
      assert.ok(fs.statSync(p).mode & 0o200, `${path.relative(to, p)} is writable`);
    }
    // without --port (43266): `next` is null, never a template presented as a command; nextTemplate carries the placeholder form
    assert.equal(r.rep.next, null, `with no --port, next is null (got ${JSON.stringify(r.rep.next)})`);
    assert.ok(String(r.rep.nextTemplate).includes('--promote-epoch') && String(r.rep.nextTemplate).includes(L.executorStore), `and nextTemplate starts an executor on the restored store with --promote-epoch (got ${JSON.stringify(r.rep.nextTemplate)})`);
  } finally { await killExecutor(ex); }
});

test('#1648 (R2) the restore-and-write probe: an executor on the restored copy takes a write, and every retained set is byte-unchanged and still verifies', { skip: SKIP, timeout: 500000 }, async () => {
  pre(); const w = world(); const ex = await seeded('r2');
  let ex2 = null;
  try {
    const a = backup(w, ex); assert.equal(a.status, 0, 'PRECONDITION: set 1');
    await pause(1100);
    const b = backup(w, ex); assert.equal(b.status, 0, 'PRECONDITION: set 2');
    const before = new Map(allSetFiles(w.dest).map((p) => [p, sha(p)]));
    assert.ok(before.size > 0, 'PRECONDITION: the retained sets hold files');
    const to = mk('rfr1648-to-');
    const port = await freePort();
    const r = restore('--set', b.rep.setDir, '--to', to, '--python', PY, '--port', String(port)); assert.equal(r.status, 0, `PRECONDITION: the restore (${(r.stdout + r.stderr).slice(0, 200)})`);
    assert.ok(!/PORT|DATASET_ID/.test(String(r.rep.next)), `with --port, next has no placeholder left (got ${JSON.stringify(r.rep.next)})`);
    // the executor is started by running `next` EXACTLY as the restore printed it (the reviewer's P2, 43265: a `next` that cannot run is no
    // recovery line). Through `sh -c 'exec …'` so the executor replaces the shell and the pid is the executor's.
    assert.ok(typeof r.rep.next === 'string' && r.rep.next.length > 0, 'PRECONDITION: the restore printed a `next` line');
    ex2 = await new Promise((resolve, reject) => {
      const p = spawn('/bin/sh', ['-c', `exec ${r.rep.next}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`\`next\` printed no ready line within 20 s: ${err.slice(0, 300)}`)); }, 20000);
      p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(t); try { const j = JSON.parse(out.split('\n')[0]); if (j.port !== port) throw new Error(`the executor came up on ${j.port}, not the --port ${port} the restore was given`); resolve({ proc: p, baseUrl: `http://127.0.0.1:${j.port}` }); } catch (e) { p.kill('SIGKILL'); reject(e); } } });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => { clearTimeout(t); reject(new Error(`running \`next\` exactly as printed exited ${code} before a ready line: ${err.slice(0, 300)}`)); });
    });
    // and it serves the RESTORED data: the seeded attachment reference is there
    const has = await fetch(`${ex2.baseUrl}/query`, { method: 'POST', body: `ASK { ?a <https://schema.org/identifier> "${ID}" }` });
    assert.ok(/"boolean"\s*:\s*true/.test(await has.text()), 'the executor started from `next` serves the restored dataset (the seeded reference is present)');
    // a promoted store refuses a caller that states no epoch (or the old one); a real caller reads the position first, so the probe does too
    const pos = await fetch(`${ex2.baseUrl}/query`, { method: 'POST', body: Q_POSITION });
    const epoch = JSON.parse(await pos.text())?.results?.bindings?.[0]?.e?.value;
    assert.match(String(epoch), /^\d+$/, `PRECONDITION: the restored, promoted store states its epoch (got ${JSON.stringify(epoch)})`);
    const wr = await fetch(`${ex2.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:op:rfr-1648-probe', 'x-epoch': epoch }, body: 'INSERT DATA { <urn:ex:probe> <urn:ex:wrote> "after restore" . }' });
    assert.equal(wr.status, 200, `a write lands on the restored copy: ${await wr.text()}`);
    const q = await fetch(`${ex2.baseUrl}/query`, { method: 'POST', body: 'SELECT ?o WHERE { <urn:ex:probe> <urn:ex:wrote> ?o }' });
    assert.ok((await q.text()).includes('after restore'), 'and reads back');
    await killExecutor(ex2); ex2 = null;
    for (const [p, h] of before) assert.equal(sha(p), h, `${path.relative(w.dest, p)} is byte-unchanged after the restored executor wrote`);
    assert.deepEqual(new Set(allSetFiles(w.dest)), new Set(before.keys()), 'and no file was added to or removed from any retained set');
    for (const s of [a, b]) assert.equal(verify(w, s.rep.setDir).status, 0, `${path.basename(s.rep.setDir)} still verifies on its own`);
  } finally { if (ex2) await killExecutor(ex2); await killExecutor(ex); }
});
