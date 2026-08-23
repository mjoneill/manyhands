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

function candidates(pattern) {
  const out = sh('ps', ['-Ao', 'pid=,ppid=,pgid=,command=']);
  return out.split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] } : null;
    })
    .filter(Boolean)
    .filter((p) => p.command.includes(pattern) && p.pid !== process.pid)
    .map((p) => ({ ...p, cwd: cwdOf(p.pid), ports: listeningPorts(p.pid) }));
}

const argv = process.argv.slice(2);
const killIdx = argv.indexOf('--kill');
const asked = killIdx === -1 ? null : argv.slice(killIdx + 1).map(Number).filter(Boolean);
const pattern = process.env.SCRUM_STRAY_PATTERN || 'node server.js';

let plan;
try {
  plan = selectStrays({
    candidates: candidates(pattern),
    liveTrees: LIVE_TREES,
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
console.log(`  pattern    ${pattern}\n`);
console.log(`  ⛔ REFUSED (${plan.refused.length})`);
for (const r of plan.refused) console.log(`     ${String(r.pid).padStart(7)}  ${r.reason.padEnd(15)} ${r.detail}`);
console.log(`\n  ✅ ELIGIBLE (${plan.kill.length})`);
for (const c of plan.kill) console.log(`     ${String(c.pid).padStart(7)}  ${c.cwd}`);

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
