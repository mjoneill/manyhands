/**
 * #1648 — ROWS THE FIRST MUTANT SERIES SHOWED WERE MISSING from tests/attachments-fence-1648.test.mjs (F1 to F7). TEST AUTHOR's.
 *
 * Mutating the first build (798a26b) of core/attachment-fence.mjs, seven of thirteen mutants survived F1 to F7. These rows pin the
 * properties that header promised and the rows did not check. They PASS on the first build (its code is right on these points) and are each
 * killed by the mutant that survived. They are rows about the CONTRACT in F1 to F7's header, not new requirements:
 *
 *   G1  the busy refusal NAMES THE HOLDER ("whose message names the holder")                       kills: message without the holder
 *   G2  a start time `ps` cannot report keeps the lock held ("fail closed")                        kills: unreadable start time counted as dead
 *   G3  a release removes only ITS OWN lock: if the lock was recovered and re-taken meanwhile, it stays   kills: release removes whoever holds it
 *   G4  a lock whose OWN RECORD says it is a day old is still held while its owner lives (F3b ages only mtimes)   kills: age read from the record steals
 *   G5  the DEFAULT wait is about 3 s (no env override): a held upload answers 503 in 2.5 to 5.5 s     kills: a ten-minute default
 *   G7  a recovery leaves NOTHING beside the attachments directory: no moved-aside copy, no temp directory, no lock           kills: a reaped lock left aside
 *   G8  a refused contender leaves nothing either: only the live holder's lock sits there                                      kills: a failed take leaving its temp directory
 *   G9  a capture that fails at ANY step leaves its output directory EMPTY, not just without a COMPLETE marker                   kills: a failed capture leaving its outputs
 *   G10 a capture notices the attachments directory changing under it (a file added or removed while the fence is held) and fails    kills: a moved directory not noticed
 *   G11 the maintenance removal refuses anything that is not an attachment file name, and removes nothing outside the directory      kills: any name accepted as an id
 *   G12 an upload that fails for a reason that is NOT a capture hold (an unwritable directory) is not answered as a retryable 503     kills: every upload error becoming a 503
 *   G6  a recovery guard whose owner is DEAD is NEVER auto-reaped: with the main lock stale too, nobody gets in and nothing is moved   RED on 798a26b
 *
 * G6 comes from the fix the builder proposed on the card (43080) after the reviewer's finding that recovery could admit two holders: recovery
 * "reads the owner record AT the lock path ... the recovery guard itself is NEVER auto-reaped; if its owner is dead, recovery fails closed with an
 * error that names the path, and uploads get the existing retryable 503". I could NOT reproduce the two-holder race black-box (48 trials with a
 * fault-injecting preload, up to 8 contenders, a dead guard, delayed reads of moved-aside records: maximum one holder every time), so there is NO row
 * claiming to catch that race itself. G6 pins the design that removes it. ITS COST, for the people deciding: a crash during a recovery leaves the guard
 * behind, and uploads then stay at the retryable 503 until someone removes the named path by hand.
 *
 * NOT covered, by name: that the lock is taken atomically WITH its owner record (a window with a lock and no record is observable only by a racing
 * reader and does not break exclusion; no row here claims it); and the recovery interleaving that admitted two holders (its own row, written from
 * the reviewer's reproduction, not from a guess).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRestServer } from './helpers/harness.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FENCE = path.join(REPO, 'core', 'attachment-fence.mjs');
const CAPTURE = path.join(REPO, 'core', 'attachment-capture.mjs');
const CHILD = path.join(REPO, 'tests', 'helpers', 'attachment-capture-child-1648.mjs');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const temps = []; const children = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of temps) { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(`${d}.fence`, { recursive: true, force: true }); fs.rmSync(`${path.join(d, 'attachments')}.fence`, { recursive: true, force: true }); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function need(file) { assert.ok(fs.existsSync(file), `${path.relative(REPO, file)} must exist`); return import(file); }
const lockDir = (attachmentsDir) => `${attachmentsDir}.fence`;
function mkAttachments() {
  const dir = path.join(mk('attgap1648-'), 'attachments'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${crypto.randomUUID()}.png`), 'attachment bytes');
  return { dir };
}
function startChild(att) {
  const marker = path.join(mk('markgap1648-'), 'held');
  const c = spawn(process.execPath, [CHILD, att.dir, mk('outgap1648-'), marker], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return { c, marker, err: () => err, exited: new Promise((r) => c.once('exit', r)) };
}
async function held(att) {
  const child = startChild(att); const t0 = Date.now();
  while (!fs.existsSync(child.marker)) { if (Date.now() - t0 > 15000) assert.fail(`the capturing child never reached its hold: ${child.err()}`); await sleep(50); }
  return { ...child, pid: Number(fs.readFileSync(child.marker, 'utf8')) };
}
const psStart = (pid) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();

/** Run `withAttachmentFence` in a CHILD process (so a changed PATH or a cached start time cannot leak into this one) and return its outcome. */
function contend(att, { waitMs = 600, env = {} } = {}) {
  const script = `
    const { withAttachmentFence } = await import(${JSON.stringify(FENCE)});
    try { const got = await withAttachmentFence(async () => 'got-in', { attachmentsDir: ${JSON.stringify(att.dir)}, waitMs: ${waitMs}, owner: 'contender' });
      console.log(JSON.stringify({ outcome: got })); }
    catch (e) { console.log(JSON.stringify({ code: e.code, retryable: e.retryable, message: e.message })); }`;
  const r = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  return JSON.parse(r.trim().split('\n').pop());
}

test('#1648 (G1) the busy refusal names the holder: its pid and what it is doing', { timeout: 60000 }, async () => {
  await need(FENCE);
  const att = mkAttachments(); const owner = await held(att);
  const r = contend(att, { waitMs: 500 });
  assert.equal(r.code, 'ATTACHMENT_FENCE_BUSY', JSON.stringify(r));
  assert.equal(r.retryable, true);
  assert.match(r.message, new RegExp(`\\b${owner.pid}\\b`), `the message carries the holder's pid ${owner.pid}: ${r.message}`);
  assert.match(r.message, /capture/i, `and says what the holder is doing: ${r.message}`);
});

test('#1648 (G2) when `ps` cannot report the owner\'s start time the lock STAYS held (fail closed): an unknown is never read as dead', { timeout: 60000 }, async () => {
  await need(FENCE);
  const att = mkAttachments(); const owner = await held(att);
  const shim = mk('psshim1648-'); fs.writeFileSync(path.join(shim, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // CONTROL: the shim bites. A `ps` that does answer would make the row prove nothing.
  let bit = false; try { execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, stdio: 'ignore' }); } catch { bit = true; }
  assert.equal(bit, true, 'CONTROL: with the shim first on PATH, `ps` fails');
  const r = contend(att, { waitMs: 700, env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(r.code, 'ATTACHMENT_FENCE_BUSY', `a live owner whose start time cannot be read still holds the fence (got ${JSON.stringify(r)})`);
  assert.equal(owner.c.exitCode, null, 'and the owner is still running');
});

test('#1648 (G3) a release removes only its OWN lock: a lock that was recovered and re-taken by another owner meanwhile is left standing', { timeout: 60000 }, async () => {
  const { withAttachmentFence } = await need(FENCE);
  const att = mkAttachments(); const lock = lockDir(att.dir);
  // Whether the releaser then resolves or REJECTS loudly (the builder's later design throws an invariant error here) is not this row's business:
  // the property is that the other owner's lock is left standing and untouched.
  let outcome = 'resolved';
  try {
    await withAttachmentFence(async () => {
      // simulate: our lock was judged stale and recovered, and another live owner took the path before we finished
      fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ owner: 'someone-else', pid: process.pid, startedAt: psStart(process.pid), nonce: 'the-other-owners-nonce', acquiredAt: new Date().toISOString() }));
    }, { attachmentsDir: att.dir, waitMs: 1000, owner: 'releaser' });
  } catch (e) { outcome = `rejected (${e.code || e.name})`; }
  assert.ok(fs.existsSync(lock), `the other owner's lock is still there after our release (the releaser ${outcome})`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).nonce, 'the-other-owners-nonce', 'and it is theirs, untouched');
});

test('#1648 (G4) a lock whose own record says it is a day old is still held while its owner lives: no age, however read, steals it', { timeout: 60000 }, async () => {
  await need(FENCE);
  const att = mkAttachments(); const owner = await held(att); const lock = lockDir(att.dir);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let aged = 0;
  for (const f of fs.readdirSync(lock)) {
    const p = path.join(lock, f); const text = fs.readFileSync(p, 'utf8');
    const swapped = text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, () => { aged += 1; return dayAgo; });
    if (swapped !== text) fs.writeFileSync(p, swapped);
  }
  assert.ok(aged >= 1, `PRECONDITION: the owner record carries a timestamp, and it now says a day ago (${aged} field(s) aged)`);
  const r = contend(att, { waitMs: 700 });
  assert.equal(r.code, 'ATTACHMENT_FENCE_BUSY', `an old-looking record of a live owner is still held (got ${JSON.stringify(r)})`);
  assert.equal(owner.c.exitCode, null, 'and its owner is still running');
});

test('#1648 (G5) with no wait configured, a held upload answers 503 after about 3 s: not at once, not after minutes', { timeout: 90000 }, async () => {
  const { capture } = await need(CAPTURE);
  const before = process.env.SCRUM_ATTACHMENT_FENCE_WAIT_MS; delete process.env.SCRUM_ATTACHMENT_FENCE_WAIT_MS;
  let rest;
  try { rest = await startRestServer({}); } finally { if (before !== undefined) process.env.SCRUM_ATTACHMENT_FENCE_WAIT_MS = before; }
  try {
    fs.mkdirSync(rest.attachmentsDir, { recursive: true });
    let open; const gate = new Promise((r) => { open = r; }); let reached; const at = new Promise((r) => { reached = r; });
    const running = capture({ attachmentsDir: rest.attachmentsDir, outDir: mk('outg5-1648-'), executor: { async snapshot() { return { id: 's' }; }, async references() { return []; } }, waitMs: 5000,
      hooks: { async before(step) { if (step === 'copy') { reached(); await gate; } } } });
    running.catch(() => {});
    await Promise.race([at, running]);
    const t0 = Date.now();
    const r = await Promise.race([fetch(`${rest.baseUrl}/api/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'shot.png', mime: 'image/png', data: PNG_B64 }) }), sleep(9000).then(() => null)]);
    const ms = Date.now() - t0;
    assert.ok(r, `the held upload got an answer within 9 s (the default wait must be seconds, not minutes)`);
    assert.equal(r.status, 503);
    assert.ok(ms >= 2500 && ms <= 5500, `it waited about the stated 3 s default (${ms} ms)`);
    open(); await running;
  } finally { await rest.stop(); }
});

test('#1648 (G6) a recovery guard whose owner is DEAD is never auto-reaped: with the main lock stale too nobody gets in, nothing is moved, and the refusal names the guard', { timeout: 60000 }, async () => {
  await need(FENCE);
  const deadPid = () => Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const mkLock = (p, nonce) => { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify({ owner: 'crashed', pid: deadPid(), startedAt: 'Mon Jan  1 00:00:00 2001', nonce, acquiredAt: new Date().toISOString() })); };
  const snap = (p) => ({ names: fs.readdirSync(p).sort(), record: fs.readFileSync(path.join(p, 'owner.json'), 'utf8') });

  // CONTROL: a stale main lock alone IS recovered, so a fence that never recovers anything cannot pass the rest of this row
  const a = mkAttachments(); mkLock(lockDir(a.dir), 'stale-main');
  assert.equal(contend(a, { waitMs: 3000 }).outcome, 'got-in', 'CONTROL: a dead owner\'s lock, with no guard in the way, is recovered');

  // THE ROW: the recovery guard is stale too
  const att = mkAttachments(); const lock = lockDir(att.dir); const guard = `${lock}.recover`;
  mkLock(lock, 'stale-main'); mkLock(guard, 'stale-guard');
  const before = { lock: snap(lock), guard: snap(guard) };
  const results = [contend(att, { waitMs: 800 }), contend(att, { waitMs: 800 })];
  for (const r of results) {
    assert.equal(r.outcome, undefined, `nobody got in while the guard is stale and unowned (got ${JSON.stringify(r)})`);
    assert.equal(r.code, 'ATTACHMENT_FENCE_BUSY', 'the refusal is the retryable busy error');
    assert.equal(r.retryable, true);
  }
  assert.ok(results.some((r) => r.message.includes(guard)), `at least one refusal names the guard path ${guard}: ${results.map((r) => r.message).join(' | ')}`);
  assert.deepEqual({ lock: snap(lock), guard: snap(guard) }, before, 'the stale lock and the stale guard are exactly as they were: nothing reaped, moved or rewritten');
  assert.deepEqual(fs.readdirSync(path.dirname(att.dir)).filter((n) => n.includes('.reaped')), [], 'and no moved-aside leftovers');
  fs.rmSync(guard, { recursive: true, force: true }); fs.rmSync(lock, { recursive: true, force: true });
});

const fenceLeftovers = (att) => fs.readdirSync(path.dirname(att.dir)).filter((n) => n.startsWith(`${path.basename(att.dir)}.fence`)).sort();

test('#1648 (G7) a recovery leaves nothing beside the attachments directory: the dead owner\'s lock is gone, and so is every copy and temp directory made on the way', { timeout: 60000 }, async () => {
  await need(FENCE);
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const att = mkAttachments(); const lock = lockDir(att.dir);
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ owner: 'crashed', pid: deadPid, startedAt: 'Mon Jan  1 00:00:00 2001', nonce: 'stale', acquiredAt: new Date().toISOString() }));
  assert.deepEqual(fenceLeftovers(att), [path.basename(lock)], 'PRECONDITION: only the stale lock is there');
  assert.equal(contend(att, { waitMs: 3000 }).outcome, 'got-in', 'the stale lock is recovered and the contender runs');
  assert.deepEqual(fenceLeftovers(att), [], 'and afterwards nothing named for the fence is left beside the attachments directory');
});

test('#1648 (G8) a refused contender leaves nothing behind: only the live holder\'s lock is there while it holds, and nothing after', { timeout: 60000 }, async () => {
  await need(FENCE);
  const att = mkAttachments(); const owner = await held(att);
  for (let i = 0; i < 3; i++) assert.equal(contend(att, { waitMs: 300 }).code, 'ATTACHMENT_FENCE_BUSY', `contender ${i + 1} is refused`);
  assert.deepEqual(fenceLeftovers(att), [path.basename(lockDir(att.dir))], 'while the owner holds, the only fence entry is its lock: no temp directory from a take that failed');
  owner.c.kill('SIGKILL'); await owner.exited;
  assert.equal(contend(att, { waitMs: 3000 }).outcome, 'got-in');
  assert.deepEqual(fenceLeftovers(att), [], 'and nothing at all once it is recovered and released');
});

// ---- G9 and G10: the capture's own failure contract ----
function mkExecutor() { return { async snapshot() { return { id: 's' }; }, async references() { return []; } }; }

test('#1648 (G9) a capture that fails at any step leaves its output directory EMPTY: nothing written, nothing half-done, and the fence is free', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE); const { withAttachmentFence } = await need(FENCE);
  for (const step of ['snapshot', 'copy', 'manifest', 'refs']) {
    const att = mkAttachments(); const outDir = mk('outg9-1648-');
    await assert.rejects(() => capture({ attachmentsDir: att.dir, outDir, executor: mkExecutor(), waitMs: 2000, hooks: { async before(s) { if (s === step) throw new Error(`injected at ${step}`); } } }), new RegExp(`injected at ${step}`));
    assert.deepEqual(fs.readdirSync(outDir), [], `failing at ${step} leaves the output directory empty`);
    assert.equal(await withAttachmentFence(async () => 'free', { attachmentsDir: att.dir, waitMs: 500, owner: 'after' }), 'free', `and the fence is free after a failure at ${step}`);
  }
});

test('#1648 (G10) a capture notices the attachments directory changing while the fence is held (a file added, one removed, or one swapped for another) and fails, leaving nothing', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE);
  for (const [what, change] of [['a file added', (dir) => fs.writeFileSync(path.join(dir, `${crypto.randomUUID()}.png`), 'a stranger')], ['a file removed', (dir) => fs.rmSync(path.join(dir, fs.readdirSync(dir)[0]))], ['one file swapped for another (the count does not change)', (dir) => { fs.rmSync(path.join(dir, fs.readdirSync(dir)[0])); fs.writeFileSync(path.join(dir, `${crypto.randomUUID()}.png`), 'a swap'); }]]) {
    const att = mkAttachments(); fs.writeFileSync(path.join(att.dir, `${crypto.randomUUID()}.png`), 'second'); const outDir = mk('outg10-1648-');
    await assert.rejects(() => capture({ attachmentsDir: att.dir, outDir, executor: mkExecutor(), waitMs: 2000, hooks: { async before(s) { if (s === 'manifest') change(att.dir); } } }), /changed|moved|outside/i, `${what} during the hold fails the capture`);
    assert.deepEqual(fs.readdirSync(outDir), [], `${what}: and nothing is left in the output directory`);
  }
  // CONTROL: with no change the same capture succeeds, so the failures above are the change and not the fixture
  const ok = mkAttachments(); const out = mk('outg10c-1648-');
  assert.equal((await capture({ attachmentsDir: ok.dir, outDir: out, executor: mkExecutor(), waitMs: 2000 })).status, 'COMPLETE');
});

test('#1648 (G11) the maintenance removal refuses anything that is not an attachment file name, removes nothing outside the directory, and still removes a real one', { timeout: 60000 }, async () => {
  const { removeAttachment } = await need(path.join(REPO, 'core', 'attachment-maintenance.mjs'));
  const att = mkAttachments(); const parent = path.dirname(att.dir);
  fs.writeFileSync(path.join(parent, 'victim.txt'), 'outside the attachments directory'); fs.writeFileSync(path.join(att.dir, 'plain'), 'no extension');
  for (const bad of ['../victim.txt', 'a/b.png', '..', '.', '', 'plain', '.hidden', 'x.png/../../victim.txt', undefined, 42]) {
    await assert.rejects(() => removeAttachment(att.dir, bad, { waitMs: 300 }), `${JSON.stringify(bad)} is refused`);
  }
  assert.equal(fs.readFileSync(path.join(parent, 'victim.txt'), 'utf8'), 'outside the attachments directory', 'nothing outside the directory was removed');
  assert.ok(fs.existsSync(path.join(att.dir, 'plain')), 'and a name without an extension was not removed');
  const real = fs.readdirSync(att.dir).find((n) => n.endsWith('.png'));
  await removeAttachment(att.dir, real, { waitMs: 1000 });
  assert.ok(!fs.existsSync(path.join(att.dir, real)), 'CONTROL: a real attachment id is removed');
});

test('#1648 (G12) an upload that fails for a reason that is NOT a capture hold is not answered as a retryable 503 that blames a backup', { timeout: 60000 }, async () => {
  const rest = await startRestServer({});
  try {
    fs.mkdirSync(rest.attachmentsDir, { recursive: true }); fs.chmodSync(rest.attachmentsDir, 0o555);
    const r = await fetch(`${rest.baseUrl}/api/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'shot.png', mime: 'image/png', data: PNG_B64 }) });
    const text = await r.text();
    assert.ok(r.status >= 400, `PRECONDITION: the write fails (${r.status})`);
    assert.notEqual(r.status, 503, `a disk error is not a capture hold: ${text.slice(0, 160)}`);
    assert.equal(r.headers.get('retry-after'), null, 'and does not say to retry shortly');
    assert.ok(!/capture|backup/i.test(text), `and does not claim a backup is running: ${text.slice(0, 160)}`);
  } finally { try { fs.chmodSync(rest.attachmentsDir, 0o755); } catch { /* gone */ } await rest.stop(); }
});
