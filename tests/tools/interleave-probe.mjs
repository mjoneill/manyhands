/**
 * #558 — the instrument behind the numbers in tests/api-write-lock.test.mjs.
 *
 * That test's header cites "500 overlapped rounds lost nothing" and "60/60 lost
 * with one injected yield". This is the probe that produced both, committed so
 * the numbers have a receipt instead of a memory of one.
 *
 *   node tests/tools/interleave-probe.mjs [serverDir] [rounds] [--inject-yield]
 *
 *     serverDir  a checkout to run (default `.`)
 *     rounds     positive integer (default 200)
 *
 * Each round fires /api/save and /api/conversations concurrently against a
 * hermetic server + temp board, then checks the file for both writes. Anything
 * accepted with 2xx and missing from disk is a loss.
 *
 * ── THE THREE MODES, AND ALL THREE ARE THE ARGUMENT ─────────────────────────
 * One mode alone proves nothing. Read them as a sequence:
 *
 *   1 · baseline — is it broken today?          [PRE-FIX checkout]
 *       node tests/tools/interleave-probe.mjs <pre-fix-tree> 500
 *       →  ⚪ no loss.  The interleave CANNOT happen: handleSave's critical
 *          section has no `await` and core/store.mjs is *Sync, so it cannot be
 *          preempted. Atomic by accident, not by the mutex.
 *
 *   2 · positive control — is the probe even capable of seeing a loss?
 *       node tests/tools/interleave-probe.mjs <pre-fix-tree> 60 --inject-yield
 *       →  🔴 LOSS DETECTED, every round.  One inserted `await` is the whole
 *          difference, and it is the change #530's async-store direction makes.
 *
 *   3 · the fix — and is the lock what prevents it?
 *       node tests/tools/interleave-probe.mjs <fixed-tree> 60 --inject-yield
 *       →  ⚪ no loss.  Same injected yield, but inside withWriteLock, so the
 *          competing append waits instead of being discarded.
 *
 * ⭐ Mode 1 without mode 2 is uninterpretable: a null from an unvalidated probe
 *   is indistinguishable from a probe that never overlapped the requests at all.
 *   Mode 2 without mode 3 shows the hazard but not the remedy. The set of three
 *   says: not broken today · one yield away · and here is what holds it.
 *
 * ⚠️ `<pre-fix-tree>` is NOT `.` once this file lives on a branch that has the
 *   fix — and it is not a placeholder either. The pre-fix revision is pinned:
 *
 *       5ab38f2fe4b4646a4fbbbb983c838fd613954709
 *
 *   (`main` at the time #558 was built; verified pre-fix by inspection — zero
 *   `withWriteLock` inside `handleSave` — and an ancestor of both branches.)
 *
 * ── THE WHOLE RECEIPT, copy-paste from a fixed checkout ─────────────────────
 *
 *     B=$(mktemp -d)
 *     git archive 5ab38f2fe4b4646a4fbbbb983c838fd613954709 | tar -x -C "$B"
 *     ln -s "$PWD/node_modules" "$B/node_modules"   # an archive carries none
 *
 *     node tests/tools/interleave-probe.mjs "$B" 500                 # exit 0
 *     node tests/tools/interleave-probe.mjs "$B" 60  --inject-yield  # exit 1
 *     node tests/tools/interleave-probe.mjs .   60  --inject-yield   # exit 0
 *
 *     rm -rf "$B"
 *
 * ⭐ Run all three or none. Mode 2 alone shows a hazard with no remedy; mode 3
 *   alone shows a pass that is indistinguishable from an injection that never
 *   applied. (@indigo, who nearly certified mode 3 by itself.)
 *
 * ⭐ And you do not have to trust any of these paths: every run prints which
 *   kind of checkout it was actually pointed at, determined from the code.
 *
 * `--inject-yield` builds and removes its own patched tree via the same injector
 * the automated behavior test uses (tools/yielding-tree.mjs), so the one-round
 * test and the many-round probe cannot drift apart in what they inject.
 *
 * ── EXIT CODES — the verdict is machine-readable and fails closed ───────────
 *
 *   0  clean: every requested round was accepted, nothing lost
 *   1  loss detected — mode 2's expected outcome, a finding rather than an error
 *   2  usage error (unknown flag, bad rounds, no server.js in the target)
 *   3  INCONCLUSIVE: some rounds were refused, so a null concludes nothing
 *
 * ⚠️ Code 3 exists because a run where every write was REFUSED used to print
 *   `⚪ no loss` — identical to a clean 500-round null. Nothing lost and nothing
 *   measured are not the same result, and only one of them is reassuring.
 *   Rounds refused by the server are excluded from the denominator, never
 *   silently counted as survivals.
 *
 * Not a test — nothing here asserts. It is a measuring device, and it is slow
 * (500 rounds ≈ 40s), so it stays out of the suite deliberately.
 *
 * Review credit: the second and third modes exist because the first version
 * documented a positive control no committed command could build. The argument
 * validation and the single cleanup path below came from the same review.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { makeYieldingTree } from './yielding-tree.mjs';
import { describeTarget } from './lock-coverage.mjs';

const USAGE = 'usage: node tests/tools/interleave-probe.mjs [serverDir] [rounds] [--inject-yield]';

function die(message) {
  console.error(`✗ ${message}\n  ${USAGE}`);
  process.exit(2);
}

// ── arguments ───────────────────────────────────────────────────────────────
// Validated rather than coerced: `--injectyield` silently doing nothing would
// produce a ⚪ no-loss that reads exactly like mode 1, and `rounds=abc` becomes
// NaN, which makes the loop body run zero times and print a confident 0-of-NaN.
// Both are wrong answers dressed as results, which is the failure this whole
// card is about.
const KNOWN_FLAGS = new Set(['--inject-yield']);
const argv = process.argv.slice(2);

const flags = argv.filter((a) => a.startsWith('-'));
for (const f of flags) if (!KNOWN_FLAGS.has(f)) die(`unknown flag: ${f}`);

const positional = argv.filter((a) => !a.startsWith('-'));
if (positional.length > 2) die(`unexpected argument: ${positional[2]}`);

const INJECT = flags.includes('--inject-yield');
const TARGET_DIR = path.resolve(positional[0] ?? '.');
if (!fs.existsSync(path.join(TARGET_DIR, 'server.js'))) {
  die(`no server.js in ${TARGET_DIR}`);
}

const roundsArg = positional[1] ?? '200';
if (!/^\d+$/.test(roundsArg) || Number(roundsArg) < 1) {
  die(`rounds must be a positive integer, got: ${roundsArg}`);
}
const ROUNDS = Number(roundsArg);

// ── everything below owns a resource, so everything below is in one try ─────
// One `finally` for the whole run, and cleanups that tolerate never having been
// created. The previous version cleaned the temp tree only on the success path:
// a server that failed to come up threw past it, leaving a patched checkout and
// a temp board behind — and the config file was never cleaned at any point.
const cleanups = [];
const cleanupAll = () => {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* best effort: one failure must not skip the rest */ }
  }
};

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const CARD = (title) => ({
  id: 'card-a', shortId: 1, title, column: 'backlog', order: 0,
  assignees: ['unassigned'], labels: [], relationships: { relatedTo: [], blockedBy: [] },
});
const COLUMNS = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

// ── say which kind of tree this actually is, before measuring it ────────────
// `.` is not an identifier. The documented mode-2 command was true on a pre-fix
// checkout and silently false once the same file was cherry-picked onto the
// branch that adds the lock — a confident `⚪ no loss` that reads as
// reassurance. So the probe determines the property itself rather than
// trusting the path it was handed. Caught by @indigo running her own
// documented command and reading the output instead of the exit status.
const TARGET = describeTarget(TARGET_DIR);
console.log(`target: ${TARGET.reason}`);
if (TARGET.locked === null) {
  console.log('   ⚠️  cannot tell whether this checkout has the fix — interpret the result accordingly.');
} else {
  console.log(`   ⇒ with --inject-yield this is ${TARGET.locked ? 'MODE 3 (expect no loss: the lock holds)' : 'MODE 2 (expect loss: no lock)'}`);
}

let result;
try {
  let serverDir = TARGET_DIR;
  if (INJECT) {
    const yielding = makeYieldingTree(TARGET_DIR);
    cleanups.push(yielding.cleanup);
    serverDir = yielding.dir;
    console.log(`fault injection ON — one ${yielding.pauseMs}ms yield after handleSave's readBoard()`);
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const boardFile = path.join(os.tmpdir(), `probe-558-board-${stamp}.json`);
  fs.writeFileSync(boardFile, JSON.stringify({
    cards: [CARD('original')], columns: COLUMNS, conversations: [], nextShortId: 2, lastUpdated: null,
  }, null, 2));
  cleanups.push(() => fs.rmSync(boardFile, { force: true }));

  const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), `probe-558-attach-${stamp}-`));
  cleanups.push(() => fs.rmSync(attachDir, { recursive: true, force: true }));

  const configFile = path.join(os.tmpdir(), `probe-558-cfg-${stamp}.json`);
  cleanups.push(() => fs.rmSync(configFile, { force: true }));

  const port = await freePort();
  const proc = spawn('node', ['server.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      SCRUM_PORT: String(port),
      SCRUM_BOARD_FILE: boardFile,
      SCRUM_ATTACHMENTS_DIR: attachDir,
      SCRUM_CHANNEL_CONFIG_FILE: configFile,
      SCRUM_MCP_NOTIFY_URL: '', // never nudge the live channel from a probe (#218)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => proc.kill('SIGKILL'));

  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    try { await fetch(`${base}/api/board`); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server under test never came up from ${serverDir}\nstderr: ${stderr.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // `accepted` is the ONLY denominator. A round whose write was refused was
  // never measured, so it can neither survive nor be lost — and counting it as
  // "not lost" is how a probe that measured nothing reports reassurance.
  let lostComments = 0, lostSaves = 0, lostRounds = 0, both = 0, rejected = 0, accepted = 0;
  const rejections = [];
  for (let i = 0; i < ROUNDS; i++) {
    const sentinel = `sentinel-${i}-${Math.random().toString(36).slice(2)}`;
    const title = `renamed-${i}`;
    const [saved, appended] = await Promise.all([
      post('/api/save', {
        cards: [CARD(title)], columns: COLUMNS, nextShortId: 2, lastUpdated: new Date().toISOString(),
      }),
      post('/api/conversations', { author: 'probe', body: sentinel }),
    ]);
    if (!saved.ok || !appended.ok) {
      rejected++;
      if (rejections.length < 3) {
        rejections.push(`round ${i}: /api/save ${saved.status} · /api/conversations ${appended.status}`);
      }
      continue;
    }
    accepted++;

    const disk = fs.readFileSync(boardFile, 'utf8');
    const commentSurvived = disk.includes(sentinel);
    const saveSurvived = disk.includes(title);
    // Two counters, because they answer different questions and mixing them
    // produced a numerator that could exceed its denominator: lostWrites counts
    // vanished WRITES (a round can lose both), lostRounds counts rounds that
    // lost at least one. Only the second is commensurable with roundsAccepted.
    if (!commentSurvived) lostComments++;
    if (!saveSurvived) lostSaves++;
    if (!commentSurvived || !saveSurvived) lostRounds++;
    if (commentSurvived && saveSurvived) both++;
  }

  result = {
    target: TARGET_DIR,
    targetHasLock: TARGET.locked,
    injectedYield: INJECT,
    roundsRequested: ROUNDS,
    roundsAccepted: accepted,
    rejected,
    rejectionSamples: rejections,
    bothSurvived: both,
    lostRounds,
    lostWrites: lostComments + lostSaves,
    lostComments,
    lostSaves,
  };
} finally {
  cleanupAll();
}

console.log(JSON.stringify(result, null, 2));

// ── the verdict, and its exit code ──────────────────────────────────────────
// Fail closed on the ambiguous case. `rejected > 0` with no losses used to print
// ⚪ no loss, so a run where EVERY write was refused — nothing measured at all —
// read identically to a clean 500-round null. That is the exact failure this
// whole card is about: an instrument that cannot tell "nothing went wrong" from
// "nothing happened". A detected loss is still a real finding regardless of
// rejections, so only the reassuring outcome is gated.
//
//   0  clean: every requested round was accepted, nothing lost
//   1  loss detected (mode 2's expected outcome — a finding, not an error)
//   2  usage error
//   3  INCONCLUSIVE: some rounds never ran, so a null means nothing
if (result.lostRounds > 0) {
  console.log(`🔴 LOSS DETECTED — ${result.lostRounds} of ${result.roundsAccepted} accepted round(s) lost at least one`);
  console.log(`   accepted write (${result.lostWrites} write(s) total: ${result.lostComments} comment(s), ${result.lostSaves} save(s)).`);
  if (result.rejected) console.log(`   (${result.rejected} round(s) were refused and are excluded from the denominator.)`);
  process.exit(1);
}

if (result.rejected > 0) {
  console.log(`⚠️  INCONCLUSIVE — ${result.rejected} of ${result.roundsRequested} round(s) were refused, so nothing`);
  console.log(`    can be concluded from the ${result.roundsAccepted} that ran. A null here is not evidence of no loss.`);
  for (const r of result.rejectionSamples) console.log(`      ${r}`);
  process.exit(3);
}

console.log(`⚪ no loss — ${result.roundsAccepted} of ${result.roundsRequested} round(s) accepted and survived.`);
