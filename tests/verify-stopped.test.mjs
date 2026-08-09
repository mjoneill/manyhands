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

test('#752 first read fails, a LATER successful empty read → verified', async () => {
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

test('#752 a successful read with our pid absent → verified (the fix must not disarm)', async () => {
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
