/**
 * #1648 — THE ATTACHMENT FENCE AND THE PAIRED CAPTURE (F1 to F7), written before the build.
 *
 * WHAT THE PROMISE IS (steward-adopted wording, posted on the card 2026-10-09): while a paired capture holds the fence, no
 * attachment byte write made through THIS APP's code (the upload route today, plus the maintenance removal) begins or finishes
 * inside the capture window: it is held until release, or refused with a retryable error. It does NOT cover a direct filesystem
 * write by an operator, a script or another deployed process, and a manifest alone proves nothing about exclusion. The rows
 * below prove the property of the job (writers held, a dead capturer not wedging uploads, failure publishing nothing), not
 * something read from a manifest.
 *
 * WHAT A LEXICAL SCAN (F6) CAN AND CANNOT DO: it guards the known write patterns and catches a planted bypass. It cannot prove
 * that every writer is fenced or that no route can reach a function. Those claims stay bounded by the writer inventory
 * and the runtime exclusion rows, and the card says so.
 *
 * INTERFACES THESE ROWS PROPOSE (accepted by the builder on the thread; the rows follow any later rename). All paths are
 * constants below:
 *   core/attachment-fence.mjs         withAttachmentFence(fn, { attachmentsDir, waitMs, owner })
 *       takes a process-shared exclusive lock, a directory named `<attachmentsDir>.fence` beside the attachments dir, holding
 *       an owner record (JSON, with the owner's pid and start time). While another owner holds it, a caller waits up to waitMs
 *       and then rejects with an Error whose `code` is 'ATTACHMENT_FENCE_BUSY', `retryable` is true, and whose message names
 *       the holder. A lock whose owner cannot be PROVEN dead stays held (fail closed): no age-based stealing. A lock whose
 *       recorded owner process is gone, or whose pid is alive but with a different start time (pid reuse), is recoverable.
 *   core/attachment-capture.mjs       capture({ attachmentsDir, outDir, executor, hooks, waitMs })
 *       holds the fence across the steps `snapshot`, `copy`, `manifest`, `refs`, awaiting hooks.before(stepName) before each
 *       (the injectable hold: no sleeps in production code). executor = { snapshot(), references(snapshot) } (references are
 *       read ONLY from the snapshot, never from a later live read). On success outDir holds `attachments/` (the copy),
 *       `manifest.json` (the existing schema 1 {capturedAt, files:[{name,size,sha256}], fence:{before,after}} plus
 *       `dangling` (the exact id list of references with no file) and `status`), `refs.json` ([{id,size}] from the snapshot),
 *       and a `COMPLETE` marker written LAST. It resolves { status, manifest, refs }: status 'COMPLETE', or 'DEGRADED' when
 *       `dangling` is not empty. On any failure it rejects, releases the fence, and leaves no `COMPLETE` marker and no manifest.
 *   core/attachment-maintenance.mjs   removeAttachment(attachmentsDir, id, { waitMs })
 *       the one fenced delete writer. It is NOT reachable from any route or tool (F6c).
 *   server.js upload route            takes the fence around the byte write; the wait comes from SCRUM_ATTACHMENT_FENCE_WAIT_MS
 *       (ms); a refusal is HTTP 503 with a JSON body whose `error` names the capture and a `retry-after` header.
 * Without the build every row fails with "<module> must exist" or its own assertion; the scratch implementation that passes
 * them is not part of this commit.
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
const MAINT = path.join(REPO, 'core', 'attachment-maintenance.mjs');
const CHILD = path.join(REPO, 'tests', 'helpers', 'attachment-capture-child-1648.mjs');
const CHECKER = path.join(REPO, 'scripts', 'attachments-restore-check.mjs');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const temps = []; const children = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of temps) { try { fs.chmodSync(d, 0o755); } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(`${d}.fence`, { recursive: true, force: true }); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
/** true if the promise has NOT settled after ms (a held caller), false if it settled. */
const stillPending = async (p, ms = 400) => (await Promise.race([p.then(() => 'done', () => 'done'), sleep(ms).then(() => 'pending')])) === 'pending';
async function need(file) {
  assert.ok(fs.existsSync(file), `${path.relative(REPO, file)} must exist`);
  return import(file);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** An attachments dir with n distinct files named like real ones; returns their manifest-shaped entries. */
function mkAttachments(n = 3) {
  const dir = path.join(mk('att1648-'), 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const files = Array.from({ length: n }, (_, i) => {
    const name = `${crypto.randomUUID()}.png`;
    const bytes = Buffer.from(`attachment bytes number ${i} ${'x'.repeat(50 + i)}`);
    fs.writeFileSync(path.join(dir, name), bytes);
    return { name, size: bytes.length, sha256: sha(bytes) };
  });
  return { dir, files };
}
/** The executor stand-in: references are read from the snapshot taken, so a later change to `live` is invisible to them. */
function mkExecutor(initial) {
  const live = new Map(initial.map((r) => [r.id, r.size]));
  const snaps = new Map();
  return {
    live,
    async snapshot() { const s = { id: `snap-${snaps.size + 1}` }; snaps.set(s.id, [...live].map(([id, size]) => ({ id, size }))); return s; },
    async references(snap) { assert.ok(snaps.has(snap?.id), 'references() is given the snapshot that snapshot() returned'); return snaps.get(snap.id); },
  };
}
const refsOf = (files) => files.map((f) => ({ id: f.name, size: f.size }));
const lockDir = (attachmentsDir) => `${attachmentsDir}.fence`;

/** capture() paused inside its `copy` step while it holds the fence; returns the running promise and the way out. */
async function pausedCapture({ dir, files }, { executor, outDir = mk('out1648-'), waitMs = 5000 } = {}) {
  const { capture } = await need(CAPTURE);
  const g = gate(); const reached = gate();
  const running = capture({
    attachmentsDir: dir, outDir, executor: executor ?? mkExecutor(refsOf(files)), waitMs,
    hooks: { async before(step) { if (step === 'copy') { reached.open(); await g.p; } } },
  });
  running.catch(() => {});
  await Promise.race([reached.p, running]);
  return { running, release: g.open, outDir };
}
async function startRest(waitMs) {
  return startRestServer({ env: { SCRUM_ATTACHMENT_FENCE_WAIT_MS: String(waitMs) } });
}
const upload = (rest, name = 'shot.png') => fetch(`${rest.baseUrl}/api/attachments`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mime: 'image/png', data: PNG_B64 }),
});
const names = (dir) => fs.readdirSync(dir).sort();

// ------------------------------------------------------------------- F1: upload against capture

test('#1648 (F1a) an upload that arrives while a capture holds the fence is HELD, lands after release, and is not in the captured set', { timeout: 60000 }, async () => {
  const rest = await startRest(8000);
  try {
    const att = { dir: rest.attachmentsDir, files: [] };
    fs.mkdirSync(att.dir, { recursive: true });
    const bytes = Buffer.from('pre-existing bytes'); const pre = `${crypto.randomUUID()}.png`;
    fs.writeFileSync(path.join(att.dir, pre), bytes);
    att.files = [{ name: pre, size: bytes.length, sha256: sha(bytes) }];
    const cap = await pausedCapture(att);
    const up = upload(rest);
    assert.equal(await stillPending(up, 600), true, 'the upload is held while capture holds the fence');
    assert.deepEqual(names(att.dir), [pre], 'nothing was written into the attachments dir while it is held');
    cap.release();
    const result = await cap.running;
    const r = await up;
    assert.equal(r.status, 201, `after release the upload lands: ${await r.clone().text()}`);
    const id = (await r.json()).id;
    assert.ok(fs.existsSync(path.join(att.dir, id)), 'its bytes are on disk');
    const manifest = JSON.parse(fs.readFileSync(path.join(cap.outDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.map((f) => f.name), [pre], 'the capture holds exactly the files that existed when it took the fence');
    assert.ok(!fs.existsSync(path.join(cap.outDir, 'attachments', id)), 'the late upload is not in the copy');
    assert.equal(result.status, 'COMPLETE');
  } finally { await rest.stop(); }
});

test('#1648 (F1b) when the wait runs out the upload is REFUSED with a retryable error, writes nothing, and the same upload succeeds after the capture ends', { timeout: 60000 }, async () => {
  const rest = await startRest(300);
  try {
    const att = { dir: rest.attachmentsDir, files: [] };
    fs.mkdirSync(att.dir, { recursive: true });
    const cap = await pausedCapture(att);
    const r = await upload(rest);
    assert.equal(r.status, 503, await r.clone().text());
    const body = await r.json();
    assert.match(String(body.error), /capture/i, 'the refusal names the capture as the reason');
    assert.ok(r.headers.get('retry-after'), 'and says when to retry');
    assert.deepEqual(names(att.dir), [], 'nothing was written');
    cap.release(); await cap.running;
    const again = await upload(rest);
    assert.equal(again.status, 201, 'a retry after the capture succeeds');
  } finally { await rest.stop(); }
});

test('#1648 (F1c) a writer already inside the fence is WAITED FOR: capture takes the fence only after it releases, and nothing runs in between', { timeout: 60000 }, async () => {
  const { withAttachmentFence } = await need(FENCE);
  const { capture } = await need(CAPTURE);
  const att = mkAttachments(2);
  const events = [];
  const inFlight = gate(); const entered = gate();
  const writer = withAttachmentFence(async () => { events.push('writer-in'); entered.open(); await inFlight.p; events.push('writer-out'); }, { attachmentsDir: att.dir, waitMs: 5000, owner: 'in-flight-upload' });
  await entered.p;
  const running = capture({ attachmentsDir: att.dir, outDir: mk('out1648-'), executor: mkExecutor(refsOf(att.files)), waitMs: 5000, hooks: { async before(step) { events.push(`before:${step}`); } } });
  assert.equal(await stillPending(running, 600), true, 'capture has not finished');
  assert.deepEqual(events, ['writer-in'], 'capture has not started a single step while the writer holds the fence');
  inFlight.open(); await writer; await running;
  assert.deepEqual(events.slice(0, 2), ['writer-in', 'writer-out'], 'the writer finished first');
  assert.deepEqual(events.slice(2), ['before:snapshot', 'before:copy', 'before:manifest', 'before:refs'], 'then capture ran its four steps in order');
});

// ------------------------------------------------------------------- F2: the maintenance removal against capture

test('#1648 (F2) a removal through the named maintenance path is held out while capture holds the fence; the file stays, is captured, and goes only afterwards', { timeout: 60000 }, async () => {
  const { removeAttachment } = await need(MAINT);
  const att = mkAttachments(3);
  const victim = att.files[1].name;
  const cap = await pausedCapture(att);
  await assert.rejects(() => removeAttachment(att.dir, victim, { waitMs: 300 }), (e) => e.code === 'ATTACHMENT_FENCE_BUSY' && e.retryable === true, 'refused, retryably, while the fence is held');
  assert.ok(fs.existsSync(path.join(att.dir, victim)), 'the file is still there');
  cap.release(); await cap.running;
  const manifest = JSON.parse(fs.readFileSync(path.join(cap.outDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((f) => f.name === victim), 'the captured set still holds the file the removal tried to delete');
  await removeAttachment(att.dir, victim, { waitMs: 3000 });
  assert.ok(!fs.existsSync(path.join(att.dir, victim)), 'after the capture the removal goes through');
});

// ------------------------------------------------------------------- F3: a capturer that dies holding the fence

function startChild(att, outDir, marker) {
  const c = spawn(process.execPath, [CHILD, att.dir, outDir, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return { c, err: () => err, exited: new Promise((r) => c.once('exit', r)) };
}
async function waitFor(file, ms = 15000, child) {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > ms) assert.fail(`the capturing child never reached its hold: ${child?.err?.() ?? ''}`);
    await sleep(50);
  }
}

test('#1648 (F3a) a capturer KILLED while it holds the fence does not wedge uploads: they resume within a stated bound (3 s)', { timeout: 60000 }, async () => {
  const { withAttachmentFence } = await need(FENCE);
  const att = mkAttachments(2);
  const marker = path.join(mk('mark1648-'), 'held');
  const child = startChild(att, mk('out1648-'), marker);
  await waitFor(marker, 15000, child);
  await assert.rejects(() => withAttachmentFence(async () => 'x', { attachmentsDir: att.dir, waitMs: 400, owner: 'probe' }), (e) => e.code === 'ATTACHMENT_FENCE_BUSY', 'CONTROL: while the capturer is alive the fence is held');
  child.c.kill('SIGKILL'); await child.exited;
  const t0 = Date.now();
  const got = await withAttachmentFence(async () => 'resumed', { attachmentsDir: att.dir, waitMs: 3000, owner: 'after-the-kill' });
  assert.equal(got, 'resumed');
  assert.ok(Date.now() - t0 < 3500, `uploads resumed within the bound (${Date.now() - t0} ms)`);
});

test('#1648 (F3b) a lock held by a LIVE owner is never stolen, however old it looks', { timeout: 60000 }, async () => {
  const { withAttachmentFence } = await need(FENCE);
  const att = mkAttachments(2);
  const marker = path.join(mk('mark1648-'), 'held');
  const child = startChild(att, mk('out1648-'), marker);
  await waitFor(marker, 15000, child);
  const old = new Date(Date.now() - 24 * 3600 * 1000);
  for (const p of [lockDir(att.dir), ...fs.readdirSync(lockDir(att.dir)).map((f) => path.join(lockDir(att.dir), f))]) fs.utimesSync(p, old, old);
  await assert.rejects(() => withAttachmentFence(async () => 'stolen', { attachmentsDir: att.dir, waitMs: 700, owner: 'impatient' }), (e) => e.code === 'ATTACHMENT_FENCE_BUSY', 'the old-looking lock of a live owner is still held');
  assert.equal(child.c.exitCode, null, 'and its owner is still running');
});

test('#1648 (F3c) pid REUSE: a lock whose recorded pid is alive but is not the process that took it is recoverable', { timeout: 60000 }, async () => {
  const { withAttachmentFence } = await need(FENCE);
  const att = mkAttachments(2);
  const marker = path.join(mk('mark1648-'), 'held');
  const child = startChild(att, mk('out1648-'), marker);
  await waitFor(marker, 15000, child);
  const childPid = Number(fs.readFileSync(marker, 'utf8'));
  child.c.kill('SIGKILL'); await child.exited;
  // the dead owner's pid is now "reused" by a live process: rewrite every numeric field of the owner record equal to the dead pid
  let rewrote = 0;
  for (const f of fs.readdirSync(lockDir(att.dir))) {
    const p = path.join(lockDir(att.dir), f);
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const swapped = text.replace(new RegExp(`(?<![0-9.])${childPid}(?![0-9.])`, 'g'), () => { rewrote += 1; return String(process.pid); });
    if (swapped !== text) fs.writeFileSync(p, swapped);
  }
  assert.ok(rewrote >= 1, `PRECONDITION: the owner record carries the capturer's pid, and it now names a live process (${rewrote} field(s) rewritten)`);
  const got = await withAttachmentFence(async () => 'recovered', { attachmentsDir: att.dir, waitMs: 3000, owner: 'after-pid-reuse' });
  assert.equal(got, 'recovered', 'the start time no longer matches, so the old owner is proven gone');
});

// ------------------------------------------------------------------- F4: a held upload answers, it does not hang

test('#1648 (F4) a held upload answers within the bound: a 503 that says why, with a retry hint, not a socket left open for the whole capture', { timeout: 60000 }, async () => {
  const rest = await startRest(500);
  try {
    const att = { dir: rest.attachmentsDir, files: [] };
    fs.mkdirSync(att.dir, { recursive: true });
    const cap = await pausedCapture(att);
    const t0 = Date.now();
    const r = await Promise.race([upload(rest), sleep(6000).then(() => null)]);
    assert.ok(r, 'the held upload got an answer at all within 6 s, while the capture is still holding');
    const ms = Date.now() - t0;
    assert.equal(r.status, 503);
    assert.ok(ms >= 400 && ms < 4000, `it waited about the configured 500 ms, not the whole hold (${ms} ms)`);
    assert.ok((await r.json()).error, 'the body says why');
    cap.release(); await cap.running;
  } finally { await rest.stop(); }
});

// ------------------------------------------------------------------- F5: a failure releases the fence and publishes nothing

for (const step of ['snapshot', 'copy', 'manifest', 'refs']) {
  test(`#1648 (F5-${step}) a capture that fails at the ${step} step releases the fence at once and leaves NO set that looks complete`, { timeout: 60000 }, async () => {
    const { capture } = await need(CAPTURE);
    const { withAttachmentFence } = await need(FENCE);
    const att = mkAttachments(3);
    const outDir = mk('out1648-');
    await assert.rejects(() => capture({
      attachmentsDir: att.dir, outDir, executor: mkExecutor(refsOf(att.files)), waitMs: 3000,
      hooks: { async before(s) { if (s === step) throw new Error(`injected failure at ${step}`); } },
    }), new RegExp(`injected failure at ${step}`));
    assert.ok(!fs.existsSync(path.join(outDir, 'COMPLETE')), 'no COMPLETE marker');
    assert.ok(!fs.existsSync(path.join(outDir, 'manifest.json')), 'no manifest for anyone to mistake for a finished set');
    const t0 = Date.now();
    assert.equal(await withAttachmentFence(async () => 'free', { attachmentsDir: att.dir, waitMs: 1000, owner: 'after-failure' }), 'free');
    assert.ok(Date.now() - t0 < 900, 'the fence was already free');
  });
}

// ------------------------------------------------------------------- F6: the writer inventory, bounded

const WRITE_FN = /\bfs(?:\.promises)?\.(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|createWriteStream|truncateSync|truncate|mkdirSync|mkdir)\s*\(/g;
/** Write calls whose argument text names the attachments dir and that are NOT lexically inside a withAttachmentFence( ... ) call. */
function unfencedWrites(src) {
  const fenced = [];
  for (const m of src.matchAll(/withAttachmentFence\s*\(/g)) {
    let depth = 0; let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') { depth--; if (depth === 0) break; } }
    fenced.push([m.index, i]);
  }
  const out = [];
  for (const m of src.matchAll(WRITE_FN)) {
    let depth = 0; let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') { depth--; if (depth === 0) break; } }
    const call = src.slice(m.index, i + 1);
    if (!/ATTACHMENTS_DIR|attachmentsDir/.test(call)) continue;
    if (!fenced.some(([a, b]) => m.index > a && m.index < b)) out.push(call.slice(0, 80));
  }
  return out;
}

test('#1648 (F6a) the scan CAN fail: a planted unfenced write is reported, a fenced one is not', () => {
  assert.deepEqual(unfencedWrites("await withAttachmentFence(async () => { fs.writeFileSync(path.join(ATTACHMENTS_DIR, id), bytes); }, o);"), []);
  assert.equal(unfencedWrites("fs.writeFileSync(path.join(ATTACHMENTS_DIR, id), bytes);").length, 1);
  assert.equal(unfencedWrites("withAttachmentFence(async () => {}, o); fs.rmSync(path.join(attachmentsDir, id));").length, 1);
  assert.deepEqual(unfencedWrites("fs.writeFileSync(path.join(otherDir, id), bytes);"), []);
});

test('#1648 (F6b) in the app source, every write into the attachments dir is inside withAttachmentFence(...)', () => {
  const files = [path.join(REPO, 'server.js'), path.join(REPO, 'mcp-server.mjs'), ...fs.readdirSync(path.join(REPO, 'core')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(REPO, 'core', f)),
    ...fs.readdirSync(path.join(REPO, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(REPO, 'scripts', f))];
  const found = [];
  for (const f of files) {
    const rel = path.relative(REPO, f);
    if (rel === path.join('scripts', 'attachments-restore-check.mjs')) continue;   // reads a RESTORED copy, never writes the live dir
    for (const w of unfencedWrites(fs.readFileSync(f, 'utf8'))) found.push(`${rel}: ${w}`);
  }
  assert.deepEqual(found, [], 'a write into the attachments dir outside the fence');
  assert.match(fs.readFileSync(path.join(REPO, 'server.js'), 'utf8'), /withAttachmentFence\s*\(/, 'PRECONDITION: the upload route actually takes the fence (a scan of nothing finds nothing)');
});

test('#1648 (F6c) the maintenance removal is reachable from no route and no tool: only its own module and tests name it', () => {
  const holders = [];
  for (const f of ['server.js', 'mcp-server.mjs']) if (/removeAttachment/.test(fs.readFileSync(path.join(REPO, f), 'utf8'))) holders.push(f);
  for (const dir of ['core', 'scripts']) {
    for (const f of fs.readdirSync(path.join(REPO, dir)).filter((x) => x.endsWith('.mjs'))) {
      const rel = path.join(dir, f);
      if (rel === path.join('core', 'attachment-maintenance.mjs')) continue;
      if (/removeAttachment/.test(fs.readFileSync(path.join(REPO, rel), 'utf8'))) holders.push(rel);
    }
  }
  assert.deepEqual(holders, [], 'removeAttachment is named outside its own module');
  assert.ok(fs.existsSync(MAINT) && /removeAttachment/.test(fs.readFileSync(MAINT, 'utf8')), 'PRECONDITION: the module exists and defines it (a scan of nothing finds nothing)');
});

// ------------------------------------------------------------------- F7: the order of an upload, and what the manifest may say

test('#1648 (F7a) an upload whose bytes cannot be stored gets NO id: the id exists only after the bytes are on disk', { timeout: 60000 }, async () => {
  const rest = await startRest(1000);
  try {
    fs.mkdirSync(rest.attachmentsDir, { recursive: true });
    fs.chmodSync(rest.attachmentsDir, 0o555);
    const r = await upload(rest);
    const text = await r.text();
    assert.ok(r.status >= 400, `the write failed, so the answer is an error (${r.status})`);
    assert.ok(!/"id"/.test(text), `and carries no id: ${text.slice(0, 120)}`);
    fs.chmodSync(rest.attachmentsDir, 0o755);
    assert.deepEqual(names(rest.attachmentsDir), [], 'nothing was written');
    const ok = await upload(rest);
    const j = await ok.json();
    assert.equal(ok.status, 201);
    assert.equal(fs.statSync(path.join(rest.attachmentsDir, j.id)).size, j.size, 'CONTROL: on success the id names a file of exactly the reported size');
  } finally { try { fs.chmodSync(rest.attachmentsDir, 0o755); } catch { /* gone */ } await rest.stop(); }
});

test('#1648 (F7b) the reference set is the SNAPSHOT\'s: a reference added after the snapshot is not in refs.json', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE);
  const att = mkAttachments(3);
  const executor = mkExecutor(refsOf(att.files));
  const outDir = mk('out1648-');
  await capture({ attachmentsDir: att.dir, outDir, executor, waitMs: 3000,
    hooks: { async before(step) { if (step === 'refs') executor.live.set('added-after-the-snapshot.png', 5); } } });
  const refs = JSON.parse(fs.readFileSync(path.join(outDir, 'refs.json'), 'utf8'));
  assert.deepEqual(refs.map((r) => r.id).sort(), att.files.map((f) => f.name).sort(), 'exactly the snapshot-time references');
});

test('#1648 (F7c) references with no file are the manifest\'s exact `dangling` id SET and make the status DEGRADED, never plain success', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE);
  const att = mkAttachments(3);
  const gone = ['aaaaaaaa-0000-4000-8000-000000000001.png', 'aaaaaaaa-0000-4000-8000-000000000002.png'];
  const outDir = mk('out1648-');
  const result = await capture({ attachmentsDir: att.dir, outDir, waitMs: 3000, executor: mkExecutor([...refsOf(att.files), ...gone.map((id) => ({ id, size: 10 }))]) });
  assert.equal(result.status, 'DEGRADED');
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.dangling].sort(), [...gone].sort(), 'the exact id set, not a count');
  assert.equal(manifest.status, 'DEGRADED');
  const clean = await capture({ attachmentsDir: att.dir, outDir: mk('out1648-'), waitMs: 3000, executor: mkExecutor(refsOf(att.files)) });
  assert.equal(clean.status, 'COMPLETE', 'CONTROL: with no dangling reference the same capture is COMPLETE');
});

test('#1648 (F7d) the dangling list cannot excuse a LOSS: a file that existed when the capture began and is gone before the copy fails the capture', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE);
  const att = mkAttachments(3);
  const lost = att.files[0].name;
  const outDir = mk('out1648-');
  await assert.rejects(() => capture({ attachmentsDir: att.dir, outDir, waitMs: 3000, executor: mkExecutor(refsOf(att.files)),
    hooks: { async before(step) { if (step === 'copy') fs.rmSync(path.join(att.dir, lost)); } } }), (e) => new RegExp(lost.replace('.', '\\.')).test(String(e.message)), 'it fails, and names the file');
  assert.ok(!fs.existsSync(path.join(outDir, 'COMPLETE')), 'and publishes nothing');
});

test('#1648 (F7e) a reference with contentSize 0 and a present file is neither dangling nor a match: it is reported as UNKNOWN metadata', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE);
  const att = mkAttachments(3);
  const outDir = mk('out1648-');
  const refs = refsOf(att.files); refs[1] = { id: refs[1].id, size: 0 };
  const result = await capture({ attachmentsDir: att.dir, outDir, waitMs: 3000, executor: mkExecutor(refs) });
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.unknownMetadata, [refs[1].id], 'listed as unknown metadata');
  assert.deepEqual(manifest.dangling, [], 'not dangling: its bytes are present');
  assert.equal(result.status, 'COMPLETE', 'and not a degraded set: nothing is missing');
});

test('#1648 (F7f) a COMPLETE capture, restored into a fresh directory, passes the existing restore checker', { timeout: 60000 }, async () => {
  const { capture } = await need(CAPTURE);
  const att = mkAttachments(4);
  const outDir = mk('out1648-');
  await capture({ attachmentsDir: att.dir, outDir, waitMs: 3000, executor: mkExecutor(refsOf(att.files)) });
  assert.ok(fs.existsSync(path.join(outDir, 'COMPLETE')), 'the set is marked complete');
  const restored = mk('restored1648-'); fs.rmSync(restored, { recursive: true });
  fs.cpSync(path.join(outDir, 'attachments'), restored, { recursive: true });
  const run = (extra = []) => { try { return { code: 0, out: execFileSync(process.execPath, [CHECKER, '--manifest', path.join(outDir, 'manifest.json'), '--restored', restored, '--refs-json', path.join(outDir, 'refs.json'), ...extra], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  assert.equal(run().code, 0, run().out);
  fs.writeFileSync(path.join(restored, att.files[0].name), 'tampered');
  assert.equal(run().code, 1, 'CONTROL: a byte changed in the restore makes the same check fail');
});
