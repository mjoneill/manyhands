/**
 * #1588 — the HOST-PRESERVATION guard for a full test suite on a host that is also running production.
 *
 * Measured 2026-10-27 (#1487): concurrent test load on this host made production card reads time out (503) while the
 * executor's /health still answered. The suite lock (#1283) orders runs that take it; this guard protects the host from
 * load the lock never sees (another session's tests, a heavy build). Two halves, one rule:
 *
 *   LAUNCH   load already over the ceiling → the run does not start (exit 75), and says why in one line
 *   MID-RUN  load over the ceiling for two consecutive samples → the run SELF-ABORTS through the runner's ordered
 *            teardown (exit 75), with a line that cannot be mistaken for a hang-kill, a duration cap, or a verdict
 *
 * ⚠️ The ceiling is PROVISIONAL: the host's core count, until #1487's unmeasured cell (a throttled full suite ALONE on a
 * quiet host) gives a measured number. Override with RUN_TESTS_LOAD_CEILING. It is never tuned to make one night pass.
 *
 * On only for a FULL suite (RUN_TESTS_LEDGER=full, which run-tests.sh sets), off under CI (a CI runner shares its host
 * with no production), and off when RUN_TESTS_HOST_GUARD=off (said aloud at launch, never silent).
 * Test seam: RUN_TESTS_LOAD_PROBE names a file whose number is read as the 1-minute load instead of os.loadavg().
 */
import fs from 'node:fs';
import os from 'node:os';

export const HOST_GUARD_EXIT = 75;   // EX_TEMPFAIL: the host was not fit for the run; nothing about the code was judged

export function hostGuardConfig(env = process.env, cores = os.availableParallelism()) {
  const full = env.RUN_TESTS_LEDGER === 'full';
  const ci = env.CI === 'true' || env.CI === '1';
  const off = env.RUN_TESTS_HOST_GUARD === 'off';
  const requested = Number(env.RUN_TESTS_LOAD_CEILING);
  const ceiling = Number.isFinite(requested) && requested > 0 ? requested : cores;
  const interval = Number(env.RUN_TESTS_LOAD_INTERVAL_MS);
  return {
    enabled: full && !ci && !off,
    why: !full ? 'not a full suite' : ci ? 'CI' : off ? 'RUN_TESTS_HOST_GUARD=off' : null,
    ceiling,
    provisional: !(Number.isFinite(requested) && requested > 0),
    intervalMs: Number.isFinite(interval) && interval >= 50 ? interval : 5000,
    probe: env.RUN_TESTS_LOAD_PROBE || null,
  };
}

/** the 1-minute load average, or the test probe's number */
export function sampleLoad(cfg) {
  if (cfg.probe) {
    const n = Number(String(fs.readFileSync(cfg.probe, 'utf8')).trim());
    if (Number.isFinite(n)) return n;
  }
  return os.loadavg()[0];
}

const ceilingText = (cfg) => `${cfg.ceiling}${cfg.provisional ? ' (provisional: the core count, until #1487 measures it)' : ''}`;

/** LAUNCH: a line to print, and whether to refuse. */
export function launchCheck(cfg) {
  if (!cfg.enabled) return { refuse: false, line: cfg.why === 'RUN_TESTS_HOST_GUARD=off' ? '# host guard: OFF (RUN_TESTS_HOST_GUARD=off): this full suite runs with no host-load protection' : null };
  const load = sampleLoad(cfg);
  if (load > cfg.ceiling) {
    return { refuse: true, line: `# host guard: REFUSED to start: load ${load.toFixed(2)} is over the ceiling ${ceilingText(cfg)}; this host also serves production (#1588, #1487). Nothing was run. Try again when the host is quiet.` };
  }
  return { refuse: false, line: `# host guard: on, load ${load.toFixed(2)}, ceiling ${ceilingText(cfg)}, sampled every ${cfg.intervalMs} ms` };
}

/**
 * MID-RUN: sample on an interval; two consecutive samples over the ceiling call `abort(line)` once.
 * Returns a stop function. The timer never holds the process open.
 */
export function startGuard(cfg, { abort, rowsRun = () => 0, now = () => new Date().toISOString(), sample = () => sampleLoad(cfg) }) {
  if (!cfg.enabled) return () => {};
  let over = 0, fired = false;
  const t = setInterval(() => {
    if (fired) return;
    let load;
    try { load = sample(); } catch { return; }
    over = load > cfg.ceiling ? over + 1 : 0;
    if (over >= 2) {
      fired = true;
      clearInterval(t);
      abort(`# self-aborted: load crossed ${load.toFixed(2)} at ${now()} (ceiling ${ceilingText(cfg)}), rows run ${rowsRun()}, host-preservation guard (#1588). This run is INCOMPLETE: no verdict, and its rows are not full-suite evidence.`);
    }
  }, cfg.intervalMs);
  t.unref();
  return () => clearInterval(t);
}
