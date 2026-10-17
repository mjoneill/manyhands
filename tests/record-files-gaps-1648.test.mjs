/**
 * #1648 (the rest) — rows for the code reviewer's three findings on PR #75 at dec6811 (her REQUEST CHANGES on the card, commons 43205) and the
 * builder's fix designs (43207). TEST AUTHOR's, written before the fixes: RED at dec6811.
 *
 *   G-A  paired capture, BOTH conflict directions (post size right and card size wrong, then post wrong and card right): the job never
 *        certifies clean (not exit 0, not ok:true), and the standalone verifier on whatever set it left does not pass either
 *   G-B  a lock whose owner is DEAD is never reaped (fail closed, 43207): two runs started together both refuse with exit 7 and name the lock's
 *        path, nothing is published, and the lock is byte-unchanged afterwards
 *   G-C  release leaves someone else's lock untouched: the lock is replaced by a foreign owner's record while the job runs (fault injection,
 *        tests/helpers/record-lock-swap-1648.mjs), and after the job the foreign record is still there, byte for byte
 *   G-E  (43214) a run red ONLY for attachment-refs still prunes; any other red withholds pruning; every report carries redRuns and redSince; a red streak never prunes the newest ok:true set (keptLastClean, 43221), records-only (G-E3) or paired (G-E4, 43225); with the state file deleted (G-E5) and never a set whose manifest cannot be read (G-E6, 43233); of two clean sets the NEWEST (G-E7)
 *   G-F1 a "closed" segment that got SHORTER is closed history changed (found by mutation, W15)
 *   G-H1 two clean PAIRED runs: the second links unchanged attachment and snapshot files from the first set, both still verify (43219)
 *   G-D  the verifier refuses an inventory it could not take: a missing --live-root, an unreadable one, and one whose recursive scan fails part-way
 *        each fail and name the root; an EMPTY readable root is a valid control and passes
 *
 * NOT covered, by name: the primitive interleaving the reviewer used for the stale-recovery race (with fail-closed there is no recovery to race);
 * a lock left by a LIVE owner (B-file behaviour: exit 7, unchanged); paired dedupe across runs, the writable-restore probe, retention (owed, next).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB = path.join(ROOT, 'scripts/record-files-backup.mjs');
const VERIFY = path.join(ROOT, 'scripts/record-files-verify.mjs');
const SWAP = path.join(ROOT, 'tests/helpers/record-lock-swap-1648.mjs');
const LOCK = '.records.lock';
const SKIP_PY = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const BK = 'urn:scrum:bookkeeping:executor';

const temps = [];
after(() => { for (const d of temps) { spawnSync('chmod', ['-R', 'u+rwx', d]); fs.rmSync(d, { recursive: true, force: true }); } });
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
const ev = (seq) => JSON.stringify({ seq, op: 'upsert', entity: `e${seq}`, actor: 'ada', occurred_at: '2026-10-15T00:00:00.000Z', recorded_at: '2026-10-15T00:00:00.000Z', state: { n: seq } });

function world() {
  const root = mk('rfg1648-'); const live = path.join(root, 'live'); const events = path.join(live, 'board-data-events'); const dest = path.join(root, 'dest');
  fs.mkdirSync(events, { recursive: true }); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(events, 'events-2026-10-15.jsonl'), `${ev(1)}\n${ev(2)}\n`);
  fs.writeFileSync(path.join(events, 'cursors.json'), `${JSON.stringify({ version: 1, seats: { ada: { acked: 1, served: 2 } } })}\n`);
  const ledger = path.join(live, 'work-objects.jsonl'); fs.writeFileSync(ledger, '{"id":"w1"}\n');
  const cfg = path.join(live, 'roster.json'); fs.writeFileSync(cfg, JSON.stringify({ seats: {} }));
  const args = ['--dest', dest, '--event-log-dir', events, '--work-store', ledger, '--config', cfg, '--min-free-bytes', '1'];
  return { root, live, events, dest, ledger, cfg, args };
}
const parse = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()); } catch { return null; } };
const published = (dest) => fs.readdirSync(dest).filter((n) => /^records-\d{8}T\d{6}Z$/.test(n));
const pre = () => assert.ok(fs.existsSync(JOB) && fs.existsSync(VERIFY), 'PRECONDITION: the job and its verifier exist');

// a pid that is certainly not running: spawn a process, let it exit, and use its pid
function deadPid() { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); const pid = Number(r.stdout); try { process.kill(pid, 0); return null; } catch { return pid; } }

test('#1648 (G-B) a dead owner\'s lock is never reaped: two runs started together both refuse with exit 7 naming the lock, nothing is published, the lock is unchanged', async () => {
  pre(); const w = world();
  const pid = deadPid(); assert.ok(pid, 'PRECONDITION: a pid that is not running');
  const lock = path.join(w.dest, LOCK);
  // the lock as a crashed run would leave it: the job's own format if it records JSON, else a bare pid. Both shapes are tried below.
  for (const body of [String(pid), JSON.stringify({ pid, nonce: 'a-crashed-run', owner: 'record-files-backup', startedAt: '2026-10-17T00:00:00.000Z' })]) {
    fs.writeFileSync(lock, body);
    const one = () => new Promise((resolve) => {
      const c = spawn(process.execPath, [JOB, ...w.args], { cwd: w.root }); let out = ''; let err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => resolve({ code, out, err }));
    });
    const [a, b] = await Promise.all([one(), one()]);
    for (const [n, r] of [['first', a], ['second', b]]) {
      assert.equal(r.code, 7, `${n} run with a dead owner's lock (${body.slice(0, 40)}): exit 7, refused (got ${r.code}): ${(r.out + r.err).slice(0, 200)}`);
      assert.ok((r.out + r.err).includes(lock) || (r.out + r.err).includes(LOCK), `${n} run names the lock's path`);
    }
    assert.deepEqual(published(w.dest), [], 'nothing was published');
    assert.equal(fs.readFileSync(lock, 'utf8'), body, 'and the lock is byte-unchanged: never reaped, never rewritten');
    assert.deepEqual(fs.readdirSync(w.dest).filter((n) => n !== LOCK), [], 'and nothing else was left in --dest');
  }
});

test('#1648 (G-C) release leaves someone else\'s lock untouched: a lock taken over mid-run is still there, byte for byte, after the job', () => {
  pre(); const w = world();
  const r = spawnSync(process.execPath, [JOB, ...w.args], { cwd: w.root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: `--import ${SWAP}`, RFB_LOCK_SWAP_FOREIGN: String(process.pid) } });
  const lock = path.join(w.dest, LOCK); const marker = `${lock}.swapped-by-test`;
  assert.ok(fs.existsSync(marker), `PRECONDITION: the job created its working set with its lock held, and the hook replaced the lock (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 300)}`);
  const foreign = fs.readFileSync(marker, 'utf8');
  assert.ok(fs.existsSync(lock), 'the foreign owner\'s lock was NOT removed by the job\'s release');
  assert.equal(fs.readFileSync(lock, 'utf8'), foreign, 'and it is byte for byte the foreign record');
});

test('#1648 (G-D) the verifier refuses an inventory it could not take: missing, unreadable and part-way-unreadable live roots fail by name; an empty readable root passes', () => {
  pre(); const w = world();
  const r = spawnSync(process.execPath, [JOB, ...w.args], { cwd: w.root, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `PRECONDITION: a clean published set (${r.stderr.slice(0, 200)})`);
  const set = parse(r.stdout).setDir;
  const verify = (...roots) => spawnSync(process.execPath, [VERIFY, '--set', set, ...roots.flatMap((x) => ['--live-root', x])], { encoding: 'utf8', timeout: 60000 });
  const empty = mk('rfg1648-empty-');
  const ok = verify(w.live, empty); assert.equal(ok.status, 0, `CONTROL: the real live root plus an EMPTY readable root passes: ${(ok.stdout + ok.stderr).slice(0, 300)}`);
  const missing = path.join(w.root, 'no-such-root');
  const v1 = verify(w.live, missing); assert.notEqual(v1.status, 0, 'a missing live root fails'); assert.ok((v1.stdout + v1.stderr).includes(missing), 'and names it');
  const locked = mk('rfg1648-locked-'); fs.writeFileSync(path.join(locked, 'x.json'), '{}'); fs.chmodSync(locked, 0o000);
  const v2 = verify(w.live, locked); fs.chmodSync(locked, 0o755);
  assert.notEqual(v2.status, 0, 'an unreadable live root fails'); assert.ok((v2.stdout + v2.stderr).includes(locked), 'and names it');
  const deep = mk('rfg1648-deep-'); const sub = path.join(deep, 'sub'); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'y.json'), '{}'); fs.chmodSync(sub, 0o000);
  const v3 = verify(w.live, deep); fs.chmodSync(sub, 0o755);
  assert.notEqual(v3.status, 0, 'a live root whose recursive scan fails part-way fails'); assert.ok((v3.stdout + v3.stderr).includes(deep), 'and names it');
});

/** A scratch executor seeded with one attachment id referenced by a post (size `post`) and by a card's entityJson (size `card`). */
async function seeded(tag, id, post, card) {
  const store = tmpStore(`rfg1648-${tag}-`); fs.rmSync(store, { recursive: true }); temps.push(store, `${store}.checkpoints`);
  const ex = await startExecutor({ store, datasetId: `rfg-${tag}`, create: true });
  const cardJson = JSON.stringify({ '@id': `card-${tag}`, '@type': 'Card', title: 'holds a file', attachments: [{ id, name: 'f.txt', mime: 'text/plain', size: card }] });
  const sparql = `INSERT DATA { <https://scrumboard.local/entity/post-${tag}-att-0> <https://scrumboard.local/ns#attachmentOf> <https://scrumboard.local/entity/post-${tag}> ;
      <https://schema.org/identifier> "${id}" ; <https://schema.org/contentSize> "${post}" .
    GRAPH <${BK}> { <https://scrumboard.local/entity/card-${tag}> <https://scrumboard.local/ns#entityJson> ${JSON.stringify(cardJson)} } }`;
  const r = await fetch(`${ex.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:op:rfg-1648-seed-${tag}` }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the seed landed: ${await r.text()}`);
  return ex;
}

test('#1648 (G-A) a paired run never certifies contradictory reference sizes clean, in either direction, in the job or the standalone verifier', { skip: SKIP_PY, timeout: 240000 }, async () => {
  pre();
  const id = 'cccccccc-3333-4333-8333-cccccccccccc.txt'; const bytes = 'abc';   // the true size is 3
  for (const [tag, post, card] of [['postright', 3, 999], ['cardright', 999, 3]]) {
    const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), bytes);
    const ex = await seeded(tag, id, post, card);
    try {
      const r = spawnSync(process.execPath, [JOB, ...w.args, '--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY], { cwd: w.root, encoding: 'utf8', timeout: 180000 });
      const rep = parse(r.stdout);
      assert.ok(rep, `${tag}: one JSON report (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 300)}`);
      assert.notEqual(r.status, 0, `${tag} (post ${post}, card ${card}, file ${bytes.length} bytes): the job does not exit 0`);
      assert.notEqual(rep.ok, true, `${tag}: and does not say ok:true`);
      assert.ok(JSON.stringify(rep).includes(id), `${tag}: and the report names the attachment whose references disagree`);
      if (rep.setDir && fs.existsSync(rep.setDir)) {
        const v = spawnSync(process.execPath, [VERIFY, '--set', rep.setDir, '--live-root', w.live, '--live-root', att, '--python', PY], { encoding: 'utf8', timeout: 180000 });
        assert.notEqual(v.status, 0, `${tag}: the standalone verifier on the set it left does not pass either: ${(v.stdout).slice(0, 300)}`);
      }
    } finally { await killExecutor(ex); }
  }
});

// ---- G-E: pruning and a lasting red (the steward point 43213, the PO's choice 43214) ----
// A run whose ONLY findings are attachment-refs still prunes (a contradiction in the board's metadata says nothing about older sets); a run with
// any other red finding withholds pruning; every report carries redRuns and redSince, so a lasting contradiction is visible to a person.
const runJob = (w, extra = []) => { const t0 = Date.now(); const r = spawnSync(process.execPath, [JOB, ...w.args, ...extra], { cwd: w.root, encoding: 'utf8', timeout: 180000 }); return { ...r, rep: parse(r.stdout), t0, t1: Date.now() }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1648 (G-E1) a green run reports redRuns 0; a run red for closed history withholds pruning and keeps every older set', async () => {
  // THREE sets, not two: found by mutation (Y1, any red run prunes, survived). With two sets both are protected anyway (the newest and the last
  // clean one), so a prune that wrongly ran deleted nothing. Here the OLDEST set A is held only by the withheld prune.
  pre(); const w = world();
  const a = runJob(w); assert.equal(a.status, 0, `PRECONDITION: a green first run (${a.stderr.slice(0, 200)})`);
  assert.equal(a.rep.redRuns, 0, `a green run reports redRuns: 0 (got ${JSON.stringify(a.rep.redRuns)})`);
  await pause(1100);
  const a2 = runJob(w); assert.equal(a2.status, 0, 'PRECONDITION: a second green set');
  await pause(1100);
  const p = path.join(w.events, 'events-2026-10-15.jsonl'); const buf = fs.readFileSync(p); buf[10] = buf[10] === 0x41 ? 0x42 : 0x41; fs.writeFileSync(p, buf);
  const b = runJob(w, ['--keep-hourly', '0', '--keep-daily', '0']);
  assert.equal(b.status, 1, `PRECONDITION: red for closed history (exit ${b.status})`);
  assert.deepEqual(published(w.dest).sort(), [a, a2, b].map((r) => path.basename(r.rep.setDir)).sort(), 'pruning was withheld: all three sets are still there, the oldest included');
  assert.equal(b.rep.redRuns, 1, `and the report counts this red run (redRuns ${JSON.stringify(b.rep.redRuns)})`);
  assert.ok(Date.parse(b.rep.redSince) >= b.t0 - 1000 && Date.parse(b.rep.redSince) <= b.t1 + 1000, `redSince is this run's time (got ${JSON.stringify(b.rep.redSince)})`);
  // and a GREEN run ends the streak (found by mutation: Y4, a green run that does not reset, survived every row)
  await pause(1100);
  const c = runJob(w); assert.equal(c.status, 0, `PRECONDITION: green again, the changed history now deduped from the red set (exit ${c.status})`);
  assert.equal(c.rep.redRuns, 0, `a green run after a red one resets redRuns to 0 (got ${JSON.stringify(c.rep.redRuns)})`);
  assert.equal(c.rep.redSince ?? null, null, `and redSince to null (got ${JSON.stringify(c.rep.redSince)})`);
});

test('#1648 (G-F1) a "closed" segment that got SHORTER is closed history changed: the run is red and names it (found by mutation: W15 survived)', async () => {
  pre(); const w = world();
  fs.writeFileSync(path.join(w.events, 'events-2026-10-16.jsonl'), `${ev(3)}\n`);   // a later day, so 10-15 is a CLOSED segment
  const a = runJob(w); assert.equal(a.status, 0, `PRECONDITION: a first set (${a.stderr.slice(0, 200)})`);
  await pause(1100);
  const p = path.join(w.events, 'events-2026-10-15.jsonl'); fs.writeFileSync(p, `${ev(1)}\n`);   // seq 2 is gone from a closed day
  const b = runJob(w);
  assert.equal(b.status, 1, `a closed segment that lost a line makes the run red (exit ${b.status})`);
  assert.ok(JSON.stringify(b.rep?.findings || []).includes('closed-history-changed') && JSON.stringify(b.rep.findings).includes('events-2026-10-15.jsonl'), `a closed-history-changed finding names the segment (findings ${JSON.stringify(b.rep?.findings).slice(0, 300)})`);
});

test('#1648 (G-E2) runs red ONLY for attachment-refs still prune, and count the lasting red: redRuns 3, redSince the first of them', { skip: SKIP_PY, timeout: 400000 }, async () => {
  pre();
  const id = 'dddddddd-4444-4444-8444-dddddddddddd.txt';
  const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), 'abc');
  const ex = await seeded('prune', id, 3, 999);
  try {
    const paired = ['--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY];
    const runs = [];
    for (let i = 0; i < 3; i++) { if (i) await pause(1100); runs.push(runJob(w, [...paired, '--keep-hourly', '1', '--keep-daily', '0'])); }
    for (const [i, r] of runs.entries()) {
      assert.equal(r.status, 1, `PRECONDITION: run ${i + 1} is red (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 200)}`);
      assert.ok((r.rep.findings || []).length > 0 && r.rep.findings.every((f) => /attachment/.test(JSON.stringify(f))), `PRECONDITION: run ${i + 1}'s only findings are the attachment-refs ones (${JSON.stringify(r.rep.findings).slice(0, 200)})`);
      assert.equal(r.rep.published, true, `run ${i + 1} published`);
    }
    assert.deepEqual(published(w.dest), [path.basename(runs[2].rep.setDir)], `the red-for-refs-only runs pruned: only the newest set is left (left ${JSON.stringify(published(w.dest))})`);
    assert.equal(runs[2].rep.redRuns, 3, `the third red run in a row reports redRuns: 3 (got ${JSON.stringify(runs[2].rep.redRuns)})`);
    const since = Date.parse(runs[2].rep.redSince);
    assert.ok(since >= runs[0].t0 - 1000 && since <= runs[0].t1 + 1000, `and redSince is the FIRST red run's time (got ${JSON.stringify(runs[2].rep.redSince)})`);
  } finally { await killExecutor(ex); }
});

test('#1648 (G-E3) a red streak never prunes the last CLEAN recovery point: a green set, then three refs-only red runs, leave exactly the green set and the newest red one', { skip: SKIP_PY, timeout: 400000 }, async () => {
  pre();
  const id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee.txt';
  const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), 'abc');
  // the green set: a records-only run is ok:true (its notCovered says attachments were not captured), which is what "clean" means here (43221)
  const green = runJob(w); assert.equal(green.status, 0, `PRECONDITION: a green run (${green.stderr.slice(0, 200)})`);
  const ex = await seeded('lastclean', id, 3, 999);
  try {
    const paired = ['--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY];
    const runs = [];
    for (let i = 0; i < 3; i++) { await pause(1100); runs.push(runJob(w, [...paired, '--keep-hourly', '1', '--keep-daily', '0'])); }
    for (const [i, r] of runs.entries()) assert.equal(r.status, 1, `PRECONDITION: run ${i + 1} is red (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 200)}`);
    const left = published(w.dest).sort();
    assert.deepEqual(left, [path.basename(green.rep.setDir), path.basename(runs[2].rep.setDir)].sort(), `exactly the green set and the newest red set are left (left ${JSON.stringify(left)})`);
    const last = runs[2].rep;
    const named = last.keptLastClean ?? last.pruned?.keptLastClean;
    assert.ok(named && String(named).includes(path.basename(green.rep.setDir).replace(/^records-/, '')), `and keptLastClean names the green set (got ${JSON.stringify(named)})`);
    const keptEntry = (last.pruned?.kept || []).find((k) => k.name === path.basename(green.rep.setDir));
    assert.ok(keptEntry && /clean/i.test(JSON.stringify(keptEntry.reasons ?? keptEntry.reason ?? '')), `and pruned.kept lists the green set with a reason that says it is the last clean one (got ${JSON.stringify(last.pruned?.kept)})`);
  } finally { await killExecutor(ex); }
});

test('#1648 (G-E4) a red streak never prunes the last clean PAIRED recovery point: a clean paired set survives three refs-only red runs that follow it', { skip: SKIP_PY, timeout: 500000 }, async () => {
  // the reviewer's point (43225): a records-only ok:true set is not a verified ATTACHMENT recovery point, so G-E3 alone cannot show this
  pre();
  const id = 'ffffffff-6666-4666-8666-ffffffffffff.txt';
  const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), 'abc');
  const ex = await seeded('pairedclean', id, 3, 3);   // consistent: both references say 3, the file is 3 bytes
  try {
    const paired = ['--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY];
    const clean = runJob(w, paired);
    assert.equal(clean.status, 0, `PRECONDITION: a clean PAIRED run (exit ${clean.status}): ${(clean.stdout + clean.stderr).slice(0, 300)}`);
    assert.ok(clean.rep.attachments && JSON.stringify(clean.rep.attachments).includes('paired'), 'PRECONDITION: and it really captured attachments');
    // the board turns contradictory: a second post reference to the same file, with a different size
    const u = await fetch(`${ex.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:op:rfg-1648-contradict' }, body: `INSERT DATA {
      <https://scrumboard.local/entity/post-pairedclean-2-att-0> <https://scrumboard.local/ns#attachmentOf> <https://scrumboard.local/entity/post-pairedclean-2> ;
        <https://schema.org/identifier> "${id}" ; <https://schema.org/contentSize> "999" . }` });
    assert.equal(u.status, 200, `PRECONDITION: the contradicting reference landed: ${await u.text()}`);
    const runs = [];
    for (let i = 0; i < 3; i++) { await pause(1100); runs.push(runJob(w, [...paired, '--keep-hourly', '1', '--keep-daily', '0'])); }
    for (const [i, r] of runs.entries()) assert.equal(r.status, 1, `PRECONDITION: run ${i + 1} is red (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 200)}`);
    const left = published(w.dest).sort();
    assert.deepEqual(left, [path.basename(clean.rep.setDir), path.basename(runs[2].rep.setDir)].sort(), `exactly the clean paired set and the newest red set are left (left ${JSON.stringify(left)})`);
    const last = runs[2].rep; const cleanName = path.basename(clean.rep.setDir);
    const namedPaired = last.keptLastCleanPaired ?? last.pruned?.keptLastCleanPaired;
    assert.ok(namedPaired && String(namedPaired).includes(cleanName.replace(/^records-/, '')), `keptLastCleanPaired names the clean paired set (43226; got ${JSON.stringify(namedPaired)})`);
    const keptEntry = (last.pruned?.kept || []).find((k) => k.name === cleanName);
    assert.ok(keptEntry && JSON.stringify(keptEntry.reasons ?? keptEntry.reason ?? '').includes('last-clean-paired'), `and pruned.kept lists it with the reason "last-clean-paired" (got ${JSON.stringify(last.pruned?.kept)})`);
    const v = spawnSync(process.execPath, [VERIFY, '--set', clean.rep.setDir, '--live-root', w.live, '--live-root', att, '--python', PY], { encoding: 'utf8', timeout: 180000 });
    assert.equal(v.status, 0, `and the surviving clean paired set still verifies on its own, attachments included: ${v.stdout.slice(0, 300)}`);
  } finally { await killExecutor(ex); }
});

// ---- losing the state file costs a count, never a recovery point (the steward point 43231, the PO's change 43233) ----
test('#1648 (G-E5) with DEST/.records-state.json deleted, a red streak still never prunes the last clean set: it is read from the published sets themselves', { skip: SKIP_PY, timeout: 400000 }, async () => {
  pre();
  const id = '99999999-7777-4777-8777-999999999999.txt';
  const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), 'abc');
  const green = runJob(w); assert.equal(green.status, 0, `PRECONDITION: a green run (${green.stderr.slice(0, 200)})`);
  const state = path.join(w.dest, '.records-state.json');
  fs.rmSync(state, { force: true });
  assert.equal(fs.existsSync(state), false, 'PRECONDITION: the state file is gone');
  const ex = await seeded('nostate', id, 3, 999);
  try {
    const paired = ['--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY];
    const runs = [];
    for (let i = 0; i < 3; i++) { await pause(1100); runs.push(runJob(w, [...paired, '--keep-hourly', '1', '--keep-daily', '0'])); }
    for (const [i, r] of runs.entries()) assert.equal(r.status, 1, `PRECONDITION: run ${i + 1} is red (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 200)}`);
    assert.ok(published(w.dest).includes(path.basename(green.rep.setDir)), `the clean set survived although the state file was deleted (left ${JSON.stringify(published(w.dest))})`);
    assert.equal(runs[0].rep.streakRebuilt, true, `and the first run after the loss says the streak was rebuilt (got ${JSON.stringify(runs[0].rep.streakRebuilt)})`);
  } finally { await killExecutor(ex); }
});

test('#1648 (G-E6) a set whose manifest cannot be read is never pruned, and a finding names it', async () => {
  pre(); const w = world();
  const a = runJob(w); assert.equal(a.status, 0, 'PRECONDITION: set A');
  await pause(1100);
  const b = runJob(w); assert.equal(b.status, 0, 'PRECONDITION: set B');
  // A's manifest becomes unreadable (mode 000: the owner can still do this to a read-only set)
  const man = path.join(a.rep.setDir, 'records-manifest.json');
  assert.ok(fs.existsSync(man), 'PRECONDITION: a set holds records-manifest.json');
  fs.chmodSync(man, 0o000);
  assert.throws(() => fs.readFileSync(man), /EACCES/, 'PRECONDITION: and it is now unreadable');
  await pause(1100);
  const c = runJob(w, ['--keep-hourly', '0', '--keep-daily', '0']);
  fs.chmodSync(man, 0o444);
  const left = published(w.dest);
  assert.ok(left.includes(path.basename(a.rep.setDir)), `the set with an unreadable manifest was NOT pruned (left ${JSON.stringify(left)})`);
  assert.ok(!left.includes(path.basename(b.rep.setDir)), 'CONTROL: the readable older set B was pruned, so pruning did run');
  assert.ok(JSON.stringify(c.rep?.findings || []).includes(path.basename(a.rep.setDir)), `and a finding names set A (findings ${JSON.stringify(c.rep?.findings).slice(0, 300)})`);
});

test('#1648 (G-E7) of two clean sets, the NEWEST is the one a red streak keeps', { skip: SKIP_PY, timeout: 400000 }, async () => {
  // found by mutation (Z1, the clean sets read oldest-first): every other row has exactly one clean set, so "newest" was never pinned
  pre();
  const id = '88888888-8888-4888-8888-888888888888.txt';
  const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), 'abc');
  const a = runJob(w); assert.equal(a.status, 0, 'PRECONDITION: clean set A');
  await pause(1100);
  const b = runJob(w); assert.equal(b.status, 0, 'PRECONDITION: clean set B, newer than A');
  const ex = await seeded('twoclean', id, 3, 999);
  try {
    const paired = ['--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY];
    const runs = [];
    for (let i = 0; i < 3; i++) { await pause(1100); runs.push(runJob(w, [...paired, '--keep-hourly', '1', '--keep-daily', '0'])); }
    for (const [i, r] of runs.entries()) assert.equal(r.status, 1, `PRECONDITION: run ${i + 1} is red (exit ${r.status})`);
    const left = published(w.dest).sort();
    assert.deepEqual(left, [path.basename(b.rep.setDir), path.basename(runs[2].rep.setDir)].sort(), `the NEWER clean set B and the newest red set are left, and the older clean set A is pruned (left ${JSON.stringify(left)})`);
    const named = runs[2].rep.keptLastClean ?? runs[2].rep.pruned?.keptLastClean;
    assert.ok(named && String(named).includes(path.basename(b.rep.setDir).replace(/^records-/, '')), `keptLastClean names B (got ${JSON.stringify(named)})`);
  } finally { await killExecutor(ex); }
});

// ---- the reviewer's owed coverage (43219): paired dedupe across runs ----
test('#1648 (G-H1) two clean PAIRED runs: the second links the unchanged attachment and snapshot files from the first set, and still verifies on its own', { skip: SKIP_PY, timeout: 400000 }, async () => {
  pre();
  const id = '77777777-9999-4999-8999-777777777777.txt';
  const w = world(); const att = mk('rfg1648-att-'); fs.writeFileSync(path.join(att, id), 'abc');
  const ex = await seeded('dedupe', id, 3, 3);
  try {
    const paired = ['--source-attachments', att, '--source-executor', ex.baseUrl, '--python', PY];
    const a = runJob(w, paired); assert.equal(a.status, 0, `PRECONDITION: a clean paired run (exit ${a.status}): ${(a.stdout + a.stderr).slice(0, 300)}`);
    await pause(1100);
    const b = runJob(w, paired); assert.equal(b.status, 0, `PRECONDITION: a second clean paired run (exit ${b.status}): ${(b.stdout + b.stderr).slice(0, 300)}`);
    const files = (r) => new Map((r.rep.files || []).map((f) => [f.name, f]));
    const fa = files(a); const fb = files(b);
    // the attachment's copy: same name in both sets, linked from the first, one inode
    const attName = [...fb.keys()].find((n) => n.endsWith(`/${id}`));
    assert.ok(attName, `the second set lists the attachment's copy (files ${JSON.stringify([...fb.keys()].filter((n) => n.includes('attach')).slice(0, 5))})`);
    assert.ok(fb.get(attName).linkedFrom && path.resolve(fb.get(attName).linkedFrom).startsWith(path.resolve(a.rep.setDir)), `the attachment is linked from the FIRST set (linkedFrom ${JSON.stringify(fb.get(attName).linkedFrom)})`);
    assert.equal(fs.statSync(path.join(b.rep.setDir, attName)).ino, fs.statSync(path.join(a.rep.setDir, attName)).ino, 'one inode for both copies');
    // the executor snapshot: at least one immutable file (an SST) linked; every linked one has the same bytes as its counterpart
    const snapLinked = [...fb.values()].filter((f) => f.role === 'executor-snapshot' && f.linkedFrom);
    assert.ok(snapLinked.some((f) => /\.sst$/.test(f.name)), `at least one snapshot SST is linked, not copied (linked: ${JSON.stringify(snapLinked.map((f) => path.basename(f.name)))})`);
    for (const f of snapLinked) assert.ok(path.resolve(f.linkedFrom).startsWith(path.resolve(a.rep.setDir)), `${f.name} is linked from inside the first set, never from the live store`);
    assert.ok(b.rep.budget.linkedBytes > 0 && b.rep.budget.linkedBytes > b.rep.budget.copiedBytes, `the second run linked more than it copied (budget ${JSON.stringify(b.rep.budget)})`);
    // and neither set is damaged by sharing inodes: both verify on their own, the snapshot opened read-only included
    for (const r of [a, b]) {
      const v = spawnSync(process.execPath, [VERIFY, '--set', r.rep.setDir, '--live-root', w.live, '--live-root', att, '--python', PY], { encoding: 'utf8', timeout: 180000 });
      assert.equal(v.status, 0, `${path.basename(r.rep.setDir)} verifies on its own: ${v.stdout.slice(0, 300)}`);
    }
    assert.ok(fa.size > 0, 'CONTROL: the first set listed its files');
  } finally { await killExecutor(ex); }
});
