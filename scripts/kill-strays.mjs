#!/usr/bin/env node
/**
 * scripts/kill-strays.mjs — #813. Clear leaked test servers WITHOUT being able
 * to reach the live board.
 *
 *   node scripts/kill-strays.mjs                    # PLAN. Signals nothing.
 *   node scripts/kill-strays.mjs --kill 91002 91003 # signal ONLY these, if allowed
 *
 * ── WHY TWO PHASES ────────────────────────────────────────────────────────
 * #813's incident was not a missing check. The operator had ALREADY printed
 * `pid 23259 … ⛔ LIVE — DO NOT TOUCH` four commands before killing it. What
 * failed is that the selection was RE-DERIVED at kill time, by a pattern, from
 * a live process table.
 *
 * ⇒ So this command cannot select and signal in one step. `--kill` accepts only
 *   pids a human already read in a plan, and each is re-checked against the
 *   fence before any signal is sent. Naming a protected pid explicitly is
 *   REFUSED — an operator's insistence is not a fence override, because the
 *   operator's insistence is exactly what happened on 2026-08-15.
 *
 * All decisions come from core/stray-selector.mjs, which is pure and tested
 * (tests/stray-selector.test.mjs) including the incident itself.
 *
 * ── #490: THE PATTERN WAS THE HOLE ────────────────────────────────────────
 * ⛔ This file used to gather candidates with `SCRUM_STRAY_PATTERN`, an
 *    operator-supplied SUBSTRING defaulting to `node server.js`. That default
 *    is the bare name match #490 requirement 2 forbids by name — `node
 *    server.js` describes the live board as accurately as it describes an
 *    orphan — and it was ALSO the whole of the Node-only rule, which the
 *    selector never enforced. Point that variable at another runtime and the
 *    selector returned another project's processes as eligible, having refused
 *    nothing, because they sit in no live tree.
 *
 * ⇒ It is gone. Candidates are gathered by RUNTIME (first token is node) and
 *   every one is then re-proved by the selector against the positive scope. No
 *   knob here can widen what the rail will accept.
 *
 * ⚠️ AND IT MISSED HALF THE LEAK. Orphaned test RUNNERS are `node --test
 *    <path>.test.mjs` — they never match `node server.js`, so a sweep run in
 *    2026-08-24 reported "0 killed" while 42 orphans were live, and the only
 *    two processes its pattern DID match were the two live production
 *    services. A command that finds nothing it should kill and matches only
 *    what it must never touch reads to its operator as a clean machine.
 */
import { execFileSync } from 'node:child_process';
import { selectStrays } from '../core/stray-selector.mjs';

// The fence. Supplied by the OPERATOR, never baked in.
//
// ⛔ This was originally a hardcoded default naming the live trees under $HOME,
// and #837's guard test refused it: "no tracked source reaches for LIVE board,
// roster or home-directory data". The guard was right, and the reason is worse
// than the rule — a tracked default is a fence that ships. It would be correct
// on this machine, silently wrong on any clone, and the failure mode of a WRONG
// fence is that this tool volunteers someone's production server as eligible.
//
// ⇒ So there is no default. Unset means REFUSE, not "protect nothing".
const LIVE_TREES = (process.env.SCRUM_LIVE_TREES || '').split(':').filter(Boolean);

// #490 — the POSITIVE scope: the trees whose test processes are OURS to reap.
// Same reasoning as above, mirrored: no default. Unset means REFUSE, not
// "everything unprotected is ours". The selector throws NO_SCOPE on empty.
const DEV_TREES = (process.env.SCRUM_DEV_TREES || '').split(':').filter(Boolean);

const PROTECTED_PORTS = (process.env.SCRUM_PROTECTED_PORTS || '3141,3001,18789')
  .split(',').map(Number).filter(Boolean);

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

/** cwd for a pid, or null if unreadable — null means REFUSE, never "safe". */
function cwdOf(pid) {
  const out = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function listeningPorts(pid) {
  const out = sh('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
  return [...out.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1]));
}

/** Is the FIRST token of a command line the node binary? */
const runtimeIsNode = (command) =>
  /(^|\/)node(\d+(\.\d+)*)?$/.test(String(command).trim().split(/\s+/)[0] || '');

/**
 * Every node process on the machine, with the cwd/ports/env the selector needs.
 *
 * ⚠️ The runtime pre-filter can only NARROW what reaches the rail — the
 *    selector re-proves `isNode` itself, so this is a cost saving (one lsof per
 *    candidate, not per process) and never a permission. Anything that widened
 *    the gather would still be refused downstream.
 *
 * `ps -E` appends the environment, which is where SCRUM_BOARD_FILE lives — the
 * mark that identifies a spawned fixture server. Verified on this platform
 * rather than assumed; a missing env column would silently demote every fixture
 * server to "unmarked" and spare the exact processes we exist to clear.
 */
function candidates(showSpared = false) {
  const out = sh('ps', ['-AE', '-o', 'pid=,ppid=,pgid=,command=']);
  return out.split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] } : null;
    })
    .filter(Boolean)
    // ⛔ #490 requirement 5, found in the beneficiary review: this pre-filter is
    // why the person whose work is at risk CANNOT SEE that they were spared.
    // A non-node process never reaches the rail, so it never appears in REFUSED
    // — and from outside, "refused" and "never considered" render identically,
    // as absence. That is not a safety defect (the pre-filter can only narrow,
    // and the selector re-proves isNode itself); it is an EVIDENCE defect, and
    // requirement 5 is an evidence requirement.
    //
    // ⇒ --show-spared drops the pre-filter so every process on the box is put to
    //   the rail and the refusals are printed by name. It costs one lsof per
    //   process, which is exactly why it is not the default.
    .filter((p) => p.pid !== process.pid && (showSpared || runtimeIsNode(p.command)))
    // `ps -E` glues argv and env into one string; the selector reads both, and
    // splitting them here would need a delimiter ps does not provide.
    .map((p) => ({ ...p, env: p.command, cwd: cwdOf(p.pid), ports: listeningPorts(p.pid) }));
}

const argv = process.argv.slice(2);
// The beneficiary's flag: prove the refusal happened rather than asserting it.
const showSpared = argv.includes('--show-spared');
const killIdx = argv.indexOf('--kill');
const asked = killIdx === -1 ? null : argv.slice(killIdx + 1).map(Number).filter(Boolean);
let plan;
try {
  plan = selectStrays({
    candidates: candidates(showSpared),
    liveTrees: LIVE_TREES,
    devTrees: DEV_TREES,
    protectedPorts: PROTECTED_PORTS,
    selfPid: process.pid,
    selfPgid: typeof process.getpgrp === 'function' ? process.getpgrp() : null,
  });
} catch (e) {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(2);
}

console.log(`\n  fence      ${LIVE_TREES.join('\n             ')}`);
console.log(`  ports      ${PROTECTED_PORTS.join(', ')}`);
console.log(`  owned      ${DEV_TREES.join('\n             ')}`);
console.log(`  scope      ${showSpared
  ? 'EVERY process on this box, put to the rail (--show-spared)'
  : 'node processes only — rerun with --show-spared to see what else would be refused'}\n`);
// ⛔ #490 — WITH 420 ROWS, A FLAT LIST IS NOT EVIDENCE. The beneficiary review
// asked that the person whose work is at risk can SEE they were spared; the
// first cut printed every refusal in one column and buried 239 `not-node` rows
// under 178 `unknown-cwd` ones. A finding you have to grep for is a finding the
// reader does not have. So: the shape first, the rows after.
const byReason = plan.refused.reduce((m, r) => m.set(r.reason, (m.get(r.reason) || 0) + 1), new Map());
console.log(`  ⛔ REFUSED (${plan.refused.length})`);
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(n).padStart(5)}  ${reason}`);
}
console.log('');
for (const r of plan.refused) console.log(`     ${String(r.pid).padStart(7)}  ${r.reason.padEnd(15)} ${r.detail}`);
console.log(`\n  ✅ ELIGIBLE (${plan.kill.length})`);
// The plan states WHY each candidate is eligible. #813's incident was a
// selection re-derived by eye at kill time; a list of bare pids invites exactly
// that, because it gives the operator nothing to check against.
for (const c of plan.kill) {
  console.log(`     ${String(c.pid).padStart(7)}  ${c.mark.padEnd(19)} ${c.cwd}`);
}

if (asked === null) {
  console.log('\n  PLAN ONLY — nothing signalled.');
  console.log('  To act, name the pids you just read:  --kill <pid> [pid...]\n');
  process.exit(0);
}

const eligible = new Set(plan.kill.map((c) => c.pid));
const blocked = asked.filter((p) => !eligible.has(p));
if (blocked.length) {
  // Refusing the WHOLE batch, not just the blocked entries. A partial kill
  // teaches the operator that naming a protected pid is harmless, and the next
  // list is longer.
  console.error(`\n✗ REFUSED: ${blocked.join(', ')} — not in the eligible set above.`);
  console.error('  Nothing was signalled. Naming a pid explicitly does not override the fence:');
  console.error('  on 2026-08-15 the operator had already identified the live pid by hand.\n');
  process.exit(1);
}

for (const pid of asked) {
  try { process.kill(pid, 'SIGTERM'); console.log(`  SIGTERM → ${pid}`); }
  catch (e) { console.log(`  ${pid}: ${e.code || e.message}`); }
}
console.log('');
