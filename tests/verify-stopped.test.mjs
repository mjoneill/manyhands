/**
 * #752 — "terminated" may be asserted only after a SUCCESSFUL process-table read
 * observes every captured PID absent.
 *
 * THE DEFECT. `table()` caught every ps failure and returned `[]`. An empty table
 * means "no captured pid is present", so `verifyStopped` returned TRUE on the one
 * input where it knew nothing:
 *
 *     function table() { try { … } catch { return []; } }
 *     if (!table().some(({ pid }) => captured.pids.has(pid))) return true;
 *
 * ⇒ A failure to observe was rendered as an observation of absence.
 *
 * WHY IT MATTERED BEYOND THE RETURN VALUE. `terminationVerified` is the reassuring
 * half of the loudest sentence this system emits (suite-watch.mjs):
 *
 *     `${full.terminationVerified ? 'and its process tree terminated'
 *                                 : 'but cleanup could not be verified'}`
 *
 * So a ps failure during a timeout produced "killed after 900s AND ITS PROCESS TREE
 * TERMINATED" — the comfort manufactured by the same failure that made it
 * unknowable, telling a human to stop looking for orphans exactly when nothing
 * could see them.
 *
 * WHY THESE TESTS INJECT A READER RATHER THAN MOCK ps. verifyStopped was not
 * exported, which is why the defect could be READ but not MEASURED — a second seat hit
 * precisely that wall confirming it. A replica would test the reading rather than
 * the code, so the function is exported and takes its observer as a parameter.
 * These drive the real implementation.
 *
 * ⚠️ Note the shape is identical to #747 one function along in the same file:
 * unexported, therefore unwitnessed. That one was closed while standing on this one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyStopped } from '../scripts/run-process-tree.mjs';

const captured = (...pids) => ({ pids: new Set(pids), groups: new Set() });

/** An observer that fails: the ps read did not happen. */
const failing = () => ({ ok: false, rows: [] });
/**
 * An observer that succeeds and sees none of OUR captured pids.
 *
 * ⚠️ It still carries a witness row — the reader's own process. Round one used
 * `rows: []`, which is an IMPOSSIBLE process table: a real successful read always
 * contains at least the reader itself. Encoding the impossible state as the
 * success fixture is how a parse failure could pass for an observation.
 */
const witnessOk = () => ({ ok: true, rows: [{ pid: process.pid, ppid: 1, pgid: process.pid }] });
/** An observer that succeeds and still sees one of our pids. */
const stillThere = (pid) => () => ({ ok: true, rows: [{ pid, ppid: 1, pgid: pid }] });

test('#752 EVERY read fails → NOT verified', async () => {
  // The headline defect. Pre-fix this returned true on the first iteration.
  let reads = 0;
  const ok = await verifyStopped(captured(4242), 150, () => { reads += 1; return failing(); });
  assert.equal(ok, false,
    'a failed ps observation must never be reported as observed absence — it is the ' +
    'difference between "the tree is gone" and "I could not look"');
  assert.ok(reads > 1, 'it must keep polling rather than concluding from one failure');
});

test('#752 first read fails, a LATER successful observation with the captured PID absent → verified', async () => {
  // Failing closed must not mean failing permanently: a transient ps failure
  // followed by a real observation of absence is a genuine verification.
  let n = 0;
  const ok = await verifyStopped(captured(4242), 2000, () => (++n === 1 ? failing() : witnessOk()));
  assert.equal(ok, true, 'a transient failure must not poison a later real observation');
  assert.equal(n >= 2, true);
});

test('#752 a SUCCESSFUL read that still contains a captured pid → NOT verified', async () => {
  // The pre-existing true-negative. If this broke, the fix would have disarmed
  // real verification, which is worse than the hazard it removes.
  const ok = await verifyStopped(captured(4242), 150, stillThere(4242));
  assert.equal(ok, false, 'a pid still present is not termination');
});

test('#752 a successful observation with the captured PID absent → verified (the fix must not disarm)', async () => {
  const ok = await verifyStopped(captured(4242), 2000, witnessOk);
  assert.equal(ok, true, 'the ordinary success path must still return true');
});

test('#752 the DEFAULT observer is the real one — the export is a seam, not a fork', async () => {
  // Without this, the tests above could all pass against an injected path while
  // production used a different, unverified one. Our own pid is definitely in the
  // real process table, so a real read must find it present and refuse to verify.
  const ok = await verifyStopped(captured(process.pid), 150);
  assert.equal(ok, false,
    'called with no observer, verifyStopped must read the REAL process table — ' +
    'and our own live pid is present in it, so it cannot claim termination');
});

test('#752 ANTI-VACUITY: the observers actually differ, so the assertions above discriminate', async () => {
  assert.equal(failing().ok, false);
  assert.equal(witnessOk().ok, true);
  assert.notEqual(failing().ok, witnessOk().ok);
});

/**
 * #752 round 2 — "successful observation" was defined too weakly.
 *
 * `readTable().ok` meant only "ps exited zero". So malformed output, or any parser
 * or filter change that dropped every row, produced `{ok: true, rows: []}` — and
 * verifyStopped reported termination CONFIRMED from a PARSE failure rather than an
 * observed absence. The original defect improved but was not closed: the comfort
 * could still be manufactured, one layer down.
 *
 * The witness is the same one #747 exists to protect: A VALID FULL PROCESS TABLE
 * CONTAINS THE READER'S OWN PID. If our own process is missing from what we parsed,
 * we did not read the process table, whatever ps's exit code said.
 */
test('#752 ps exits ZERO but output is malformed → NOT a successful observation', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => 'not a process table at all\n???\n');
  assert.equal(t.ok, false,
    'a clean exit code is not an observation — the parse produced no self row');
});

test('#752 ps output is well-formed but our OWN pid is absent → NOT successful', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => '  4242     1  4242\n  4243     1  4243\n');
  assert.equal(t.ok, false,
    'a table without the reader in it is not the process table the reader is in');
});

test('#752 ps output containing our own pid → successful, and the rows survive', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => `  4242     1  4242\n  ${process.pid}     1  ${process.pid}\n`);
  assert.equal(t.ok, true, 'self present ⇒ we really did read the table');
  assert.equal(t.rows.length, 2, 'and the parsed rows are still returned');
});

test('#752 the REAL ps read succeeds and contains us — the witness is satisfiable', async () => {
  // Anti-vacuity for the three above: if the real reader could not satisfy the
  // witness, the guard would be permanently closed and verification would be dead.
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable();
  assert.equal(t.ok, true, 'the real process table must contain this process');
  assert.ok(t.rows.some((r) => r.pid === process.pid));
});

test('#752 a parse failure can no longer manufacture "terminated"', async () => {
  // End to end through the real producer: ps "succeeds" with garbage, so no self
  // row, so no observation, so no verification — however long we poll.
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const ok = await verifyStopped(captured(4242), 150, () => readTable(() => 'garbage\n'));
  assert.equal(ok, false,
    'the whole point: comfort must not be manufacturable by a broken parser');
});

/**
 * #752 round 4 — completeness held BY CONSTRUCTION, not inferred from rows.
 *
 * Rounds 1–3 all made the same move: pick a row we expect to see and treat its
 * presence as evidence. ps exception → exit code → parse → self → self+init. Each
 * closed the mutant in front of it; each left the class open one predicate along,
 * because NO predicate over returned rows can distinguish a complete table from a
 * scoped one that satisfies the predicate. `ps -p 1,<self>` satisfies every
 * witness anyone proposed and still hides a live child.
 *
 * ⇒ So the question is not "does the output look complete?" but "did production
 *   ASK for a complete table?" That is answerable, and it is pinned here the same
 *   way #745 pins the group kill: with a spy on the invocation itself.
 *
 * ⚠️ Deliberately NOT tested: that some scoped output makes ok false. No consumer
 * can distinguish scoped output from a genuinely small system without inventing
 * another row predicate — which is the architecture that was stopped.
 */
const PS_BIN = '/bin/ps';
const PS_ARGS = ['-axo', 'pid=,ppid=,pgid='];

test('#752 production PINS the instrument: absolute /bin/ps, exact unscoped argv', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const calls = [];
  readTable((file, args) => { calls.push([file, args]); return `  ${process.pid}     1  ${process.pid}\n`; });
  assert.equal(calls.length, 1, 'exactly one invocation');
  assert.deepEqual(calls[0], [PS_BIN, PS_ARGS],
    'ABSOLUTE path so a PATH shim cannot redefine the instrument, and the exact ' +
    'unscoped argv so the request itself carries the completeness');
});

test('#752 a partial/malformed row invalidates the WHOLE observation, not just that row', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => `  ${process.pid}     1  ${process.pid}\n  garbage here\n  4242  1  4242\n`);
  assert.equal(t.ok, false,
    'filtering a bad row turns "some of this is unreadable" into "this is what ' +
    'there is" — the same act as discarding a failed read, one line up');
});

test('#752 a row with the wrong FIELD COUNT invalidates the observation', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => `  ${process.pid}     1  ${process.pid}\n  4242  1\n`);
  assert.equal(t.ok, false, 'two fields is not a pid/ppid/pgid row');
});

test('#752 executor failure → invalid, and no rows leak out', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => { throw new Error('ENOENT: no ps'); });
  assert.equal(t.ok, false);
  assert.deepEqual(t.rows, []);
});

test('#752 well-formed output that does not contain the reader → invalid (anti-vacuity witness)', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => '  4242     1  4242\n  4243     1  4243\n');
  assert.equal(t.ok, false, 'we are always in a table we really read');
});

test('#752 the REAL pinned invocation succeeds and contains the reader', async () => {
  // Anti-vacuity for every negative above: the pinned instrument must actually
  // work, or the guard is permanently closed and verification is dead not careful.
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable();
  assert.equal(t.ok, true, `/bin/ps ${PS_ARGS.join(' ')} must succeed here`);
  assert.ok(t.rows.some((r) => r.pid === process.pid));
  assert.ok(t.rows.length > 10, 'a real system has many processes');
});

test('#752 a pinned, fully-parsed observation with the captured PID absent still verifies', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const ok = await verifyStopped(captured(999999), 2000,
    () => readTable(() => `  ${process.pid}     1  ${process.pid}\n  4242  1  4242\n`));
  assert.equal(ok, true, 'the fix must not disarm real verification');
});

/**
 * #752 — ruling B: pin /bin/ps, no discovery, no PATH fallback, and when the
 * instrument is unavailable say WHICH instrument rather than failing anonymously.
 *
 * The repo declares no platform and /bin/ps is absent on NixOS and some minimal
 * containers. That is a real compatibility gap and deliberately NOT solved here —
 * a candidate resolver adds a branch to the very instrument whose trustworthiness
 * we are making local. So it fails closed and names itself, and a beneficiary on
 * such a system becomes evidence for a separate card rather than a silent mystery.
 */
test('#752 an unavailable /bin/ps fails closed AND names the instrument', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable(() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; });
  assert.equal(t.ok, false);
  assert.match(t.reason, /\/bin\/ps/,
    'a generic failure reads as a broken instrument; naming the path turns ten ' +
    'minutes of mystery into one line of diagnosis');
});

test('#752 each failure mode carries its OWN reason — they need different responses', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const unreadable = readTable(() => { throw new Error('nope'); });
  const garbled = readTable(() => `  ${process.pid}   1  ${process.pid}\n  nonsense\n`);
  const notUs = readTable(() => '  4242  1  4242\n');

  assert.match(unreadable.reason, /unavailable/);
  assert.match(garbled.reason, /pars/i);
  assert.match(notUs.reason, /absent|self|reader/i);
  assert.notEqual(unreadable.reason, garbled.reason);
  assert.notEqual(garbled.reason, notUs.reason);
});

test('#752 a successful observation carries NO reason, and never fails the suite', async () => {
  const { readTable } = await import('../scripts/run-process-tree.mjs');
  const t = readTable();
  assert.equal(t.ok, true);
  assert.equal(t.reason, undefined, 'a reason on a success would read as a warning');
});
