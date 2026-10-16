/**
 * #1703 — rows for the L1 ceilings (decision a74dc60a). TEST AUTHOR's, written before any build.
 *
 * The L1 step used to fail when the executor path's p95 was above 1.0 s OR above 2x the in-process p95. The decision relaxes it: the executor-path
 * p95 of GET /api/ready on the L1 fixture must be <= 1.5 s idle and <= 3.0 s under six CPU burners; the ratio is printed and NOT asserted.
 *
 * The verdict used to be an inline closure in a test that spawns executors and burners, so it could not be tested without them. The contract (card #1703)
 * is a small pure helper, tests/helpers/l1-gate-1644.mjs, exporting L1_CEILING_MS, p95 and l1Verdict(phase, ph). These rows pin that helper and the
 * wiring around it; they need no executor, no server and no clock.
 *
 *   V0  the helper exists and exports what the contract says; the ceilings are frozen at 1500 and 3000
 *   P*  p95 is nearest rank on an ascending COPY (n = 1, 3, 20, 21, 40), throws on empty, does not mutate
 *   V1  CONTROL: both phases clean -> ok, no failures
 *   V2  the retained breach: idle executor 338 ms against in-process 145 ms (ratio 2.33, the old rule failed it) is ok
 *   V3  the four real loaded readings of #1701 (614/283, 1019/471, 1174/653, 2023/1104) all used to fail and are ok now
 *   V4  idle boundary: 1500 ok, 1501 fails
 *   V5  loaded boundary: 3000 ok, 3001 fails
 *   V6  the phases are not swapped or shared: 2000 ms fails idle and passes loaded; 1400 passes both
 *   V7  the verdict uses the nearest-rank p95 of 40 samples: three over the ceiling fail, two do not
 *   V8  the ratio is data only: tiny in-process p95, empty or zero in-process samples -> still ok; ratio is the number or null
 *   V9  fewer than one executor query fails with a message starting PRECONDITION, however fast the samples
 *   V10 empty executor samples fail (never ok, never a throw); an unknown phase throws
 *   V11 the input arrays are not mutated
 *   V12 the failure message carries the words `hard ceiling`, the rounded p95, the ceiling in ms and the phase line; no failure talks about the ratio
 *   W1  the latency test's title starts L1 LATENCY (the checker matches the prefix), says 1.5 s and 3.0 s, and not 1.0 s or 2x
 *   W2  the latency test calls l1Verdict for BOTH phases, from the helper
 *   W3  the latency test has no inline `<= 1000` or `2 * b` bound left
 *   W4  the latency test still prints the `L1 <label>:` lines with the ratio in them (the checker needs `# L1 idle:` and `# L1 loaded`)
 *   W5  no stale text: the latency test's header and ci.yml no longer say the bounds are unchanged, 1.0 s or 2x
 *   W6  CONTROL: ci.yml still has the L1 step, and the checker still matches the L1 title by prefix
 *
 * NOT covered, by name: the real L1 run (executor, proxy, burners; that is the L1 step itself); how often 1.5 s or 3.0 s would trip (three isolated loaded readings, #1701);
 * the regression baseline (#1702); that the ceilings are the right ones (the owner's, decision a74dc60a).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'tests/helpers/l1-gate-1644.mjs';
const LATENCY = path.join(ROOT, 'tests/latency/ready-executor-1644-latency.test.mjs');
const CI = path.join(ROOT, '.github/workflows/ci.yml');
const CHECKER = path.join(ROOT, 'scripts/check-platform-skips.mjs');

// the helper is loaded lazily so a missing module fails each row with ONE clear message instead of a load error for the whole file
async function gate() {
  try { return await import(path.join(ROOT, HELPER)); }
  catch (e) { assert.fail(`PRECONDITION: ${HELPER} must exist and load (the contract of card #1703); got ${e.code || e.name}: ${String(e.message).split('\n')[0]}`); }
}

// n samples whose nearest-rank p95 is `hi` when `top` of them are `hi` and the rest `lo`; returned in DESCENDING order so a missing sort shows
const samples = (n, lo, hi, top) => Array.from({ length: n }, (_, i) => (i < top ? hi : lo));
const ascending = (xs) => [...xs].sort((a, b) => a - b);
// a phase with a flat executor leg at `on` and a flat in-process leg at `off`
const flat = (on, off, extra = {}) => ({ on: { ms: Array.from({ length: 40 }, () => on), queries: 40 }, off: { ms: Array.from({ length: 40 }, () => off), queries: 0 }, line: `L1 test: executor p95=${on}`, ...extra });

test('#1703 (V0) the helper exists, exports L1_CEILING_MS, p95 and l1Verdict, and the ceilings are frozen at 1500 idle and 3000 loaded', async () => {
  const g = await gate();
  assert.equal(typeof g.p95, 'function'); assert.equal(typeof g.l1Verdict, 'function');
  assert.deepEqual({ ...g.L1_CEILING_MS }, { idle: 1500, loaded: 3000 });
  assert.equal(Object.isFrozen(g.L1_CEILING_MS), true, 'the ceilings are frozen: nobody widens them at run time');
});

test('#1703 (P*) p95 is nearest rank on an ascending copy: index min(n-1, ceil(0.95 n)-1)', async () => {
  const { p95 } = await gate();
  assert.equal(p95([7]), 7, 'n = 1');
  assert.equal(p95([5, 1, 3]), 5, 'n = 3: ceil(2.85) = 3, the last');
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19, 'n = 20: ceil(19) = 19, the 19th, not the max');
  assert.equal(p95(Array.from({ length: 21 }, (_, i) => 21 - i)), 20, 'n = 21 given DESCENDING: ceil(19.95) = 20, the 20th of the sorted list, not the max');
  assert.equal(p95(samples(40, 100, 900, 3)), 900, 'n = 40: the 38th of 40, so the top three decide it');
  assert.equal(p95(samples(40, 100, 900, 2)), 100, 'and the top two do not');
  assert.throws(() => p95([]), 'an empty sample list has no p95; it must not answer undefined or 0');
  const given = [9, 1, 5, 3]; const copy = [...given]; p95(given); assert.deepEqual(given, copy, 'p95 does not reorder its input');
});

test('#1703 (V1 CONTROL) both phases clean -> ok with no failures, and the returned fields are the numbers', async () => {
  const { l1Verdict } = await gate();
  for (const [phase, ceil] of [['idle', 1500], ['loaded', 3000]]) {
    const v = l1Verdict(phase, flat(120, 100));
    assert.equal(v.ok, true, `${phase}: ${JSON.stringify(v.failures)}`); assert.deepEqual(v.failures, []);
    assert.equal(v.executorP95, 120); assert.equal(v.inProcessP95, 100); assert.equal(v.ceilingMs, ceil);
    assert.ok(Math.abs(v.ratio - 1.2) < 1e-9, `ratio is executor p95 over in-process p95 (${v.ratio})`);
  }
});

test('#1703 (V2) the retained breach: idle executor 338 ms against in-process 145 ms (ratio 2.33) is ok, because the ratio is no longer a gate', async () => {
  const { l1Verdict } = await gate();
  const v = l1Verdict('idle', flat(338, 145)); assert.equal(v.ok, true, JSON.stringify(v.failures));
  assert.ok(Math.abs(v.ratio - 338 / 145) < 1e-9, `and it is still reported (${v.ratio})`);
});

test('#1703 (V3) the four real loaded readings that failed the old rule (614/283, 1019/471, 1174/653, 2023/1104) are ok under the loaded ceiling', async () => {
  const { l1Verdict } = await gate();
  for (const [on, off] of [[614, 283], [1019, 471], [1174, 653], [2023, 1104]]) {
    const v = l1Verdict('loaded', flat(on, off)); assert.equal(v.ok, true, `${on}/${off}: ${JSON.stringify(v.failures)}`);
  }
});

test('#1703 (V4) idle boundary: 1500 ms passes, 1501 ms fails', async () => {
  const { l1Verdict } = await gate();
  assert.equal(l1Verdict('idle', flat(1500, 1500)).ok, true, 'equal to the ceiling passes');
  assert.equal(l1Verdict('idle', flat(1501, 1501)).ok, false, 'one millisecond over fails');
});

test('#1703 (V5) loaded boundary: 3000 ms passes, 3001 ms fails', async () => {
  const { l1Verdict } = await gate();
  assert.equal(l1Verdict('loaded', flat(3000, 3000)).ok, true);
  assert.equal(l1Verdict('loaded', flat(3001, 3001)).ok, false);
});

test('#1703 (V6) the phases are not swapped or shared: 2000 ms fails idle and passes loaded; 1400 ms passes both', async () => {
  const { l1Verdict } = await gate();
  assert.equal(l1Verdict('idle', flat(2000, 2000)).ok, false); assert.equal(l1Verdict('loaded', flat(2000, 2000)).ok, true);
  assert.equal(l1Verdict('idle', flat(1400, 1400)).ok, true); assert.equal(l1Verdict('loaded', flat(1400, 1400)).ok, true);
  assert.equal(l1Verdict('idle', flat(2000, 2000)).ceilingMs, 1500); assert.equal(l1Verdict('loaded', flat(2000, 2000)).ceilingMs, 3000);
});

test('#1703 (V7) the verdict reads the nearest-rank p95 of 40 samples: three over the ceiling fail, two do not', async () => {
  const { l1Verdict } = await gate();
  const mk = (top) => ({ on: { ms: samples(40, 400, 1501, top), queries: 40 }, off: { ms: samples(40, 400, 400, 0), queries: 0 }, line: 'L1 idle: x' });
  const three = l1Verdict('idle', mk(3)); assert.equal(three.ok, false, 'the 38th of 40 is over'); assert.equal(three.executorP95, 1501);
  const two = l1Verdict('idle', mk(2)); assert.equal(two.ok, true, `two slow calls in 40 are above the 95th percentile (${JSON.stringify(two.failures)})`); assert.equal(two.executorP95, 400);
});

test('#1703 (V8) the ratio is data only: a tiny in-process p95, a zero one or none at all never fails the phase', async () => {
  const { l1Verdict } = await gate();
  const tiny = l1Verdict('idle', flat(1400, 1)); assert.equal(tiny.ok, true); assert.equal(tiny.ratio, 1400);
  const zero = l1Verdict('idle', flat(1400, 0)); assert.equal(zero.ok, true); assert.equal(zero.ratio, null, 'a zero in-process p95 gives no ratio, not Infinity');
  const none = flat(1400, 1); none.off = { ms: [], queries: 0 };
  const v = l1Verdict('loaded', none); assert.equal(v.ok, true, JSON.stringify(v.failures)); assert.equal(v.ratio, null, 'no in-process samples: no ratio');
});

test('#1703 (V9) no executor query fails with a message starting PRECONDITION, however fast the samples', async () => {
  const { l1Verdict } = await gate();
  const ph = flat(50, 50); ph.on.queries = 0;
  const v = l1Verdict('idle', ph); assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.startsWith('PRECONDITION')), `a failure starts with PRECONDITION: ${JSON.stringify(v.failures)}`);
  const one = flat(50, 50); one.on.queries = 1; assert.equal(l1Verdict('idle', one).ok, true, 'CONTROL: exactly one query is enough');
});

test('#1703 (V10) empty executor samples fail and never throw; an unknown phase throws', async () => {
  const { l1Verdict } = await gate();
  const ph = flat(50, 50); ph.on.ms = [];
  let v; assert.doesNotThrow(() => { v = l1Verdict('loaded', ph); });
  assert.equal(v.ok, false); assert.ok(v.failures.some((f) => /no executor samples/i.test(f)), JSON.stringify(v.failures));
  for (const bad of ['night', 'Idle', 'LOADED', '', undefined, null]) assert.throws(() => l1Verdict(bad, flat(50, 50)), `phase ${JSON.stringify(bad)} is not idle or loaded`);
});

test('#1703 (V11) the verdict does not reorder or change the sample arrays it is given', async () => {
  const { l1Verdict } = await gate();
  const on = [900, 100, 500, 300, 700, 200, 800, 400, 600, 1000]; const off = [90, 10, 50, 30, 70, 20, 80, 40, 60, 100];
  const onCopy = [...on]; const offCopy = [...off];
  l1Verdict('idle', { on: { ms: on, queries: 10 }, off: { ms: off, queries: 0 }, line: 'L1 idle: x' });
  assert.deepEqual(on, onCopy); assert.deepEqual(off, offCopy);
  const f = Object.freeze([...on]); const g = Object.freeze([...off]);
  assert.doesNotThrow(() => l1Verdict('idle', { on: { ms: f, queries: 10 }, off: { ms: g, queries: 0 }, line: 'L1 idle: x' }), 'frozen arrays are accepted: nothing sorts them in place');
  assert.deepEqual(ascending(on).slice(-1), [1000]);
});

test('#1703 (V12) a failing phase says `hard ceiling`, the rounded p95, the ceiling in ms and the phase line, and no failure talks about the ratio', async () => {
  const { l1Verdict } = await gate();
  // the line must NOT contain the rounded value or the ceiling, or the message would pass those checks on the line alone
  const line = 'L1 idle: load1=0.50  in-process n=40 p95=100 ms | executor n=40 (ratio 15.0)';
  const idle = l1Verdict('idle', { ...flat(1501.6, 100), line }); assert.equal(idle.ok, false);
  const msg = idle.failures.find((f) => f.includes('hard ceiling')); assert.ok(msg, `a failure names the hard ceiling: ${JSON.stringify(idle.failures)}`);
  assert.ok(msg.includes('1502'), `the rounded p95 (1501.6 -> 1502): ${msg}`); assert.ok(msg.includes('1500'), `the idle ceiling: ${msg}`); assert.ok(msg.includes(line), `the phase line: ${msg}`);
  const loaded = l1Verdict('loaded', { ...flat(3200, 100), line: 'L1 loaded (6 CPU burners): x' }); const lm = loaded.failures.find((f) => f.includes('hard ceiling'));
  assert.ok(lm && lm.includes('3200') && lm.includes('3000') && lm.includes('L1 loaded (6 CPU burners): x'), `loaded: ${lm}`);
  // the phase line itself prints the ratio (that is the point), so it is removed before looking for a ratio verdict
  for (const f of [...idle.failures.map((x) => x.split(line).join('')), ...loaded.failures.map((x) => x.split('L1 loaded (6 CPU burners): x').join(''))]) assert.ok(!/2x|ratio/i.test(f), `no failure is about the ratio: ${f}`);
  assert.equal(idle.failures.filter((f) => f.includes('hard ceiling')).length, 1, 'one message per breach, not one per sample');
});

// ---- wiring and stale text (static) ----
const latencyText = () => fs.readFileSync(LATENCY, 'utf8');
const titleOf = (text) => { const m = text.match(/\btest\(\s*(['"`])(L1 LATENCY[^]*?)\1\s*,/); return m ? m[2] : null; };

test('#1703 (W1) the latency test title starts with L1 LATENCY, says 1.5 s and 3.0 s, and says neither 1.0 s nor 2x', () => {
  const title = titleOf(latencyText()); assert.ok(title, 'a test whose title starts with L1 LATENCY (the checker matches the prefix)');
  assert.ok(title.includes('1.5 s'), title); assert.ok(title.includes('3.0 s'), title);
  assert.ok(!title.includes('1.0 s'), title); assert.ok(!/2x/.test(title), title);
});

test('#1703 (W2) the latency test imports l1Verdict from the helper and calls it for both phases', () => {
  const t = latencyText();
  assert.match(t, /import\s*\{[^}]*\bl1Verdict\b[^}]*\}\s*from\s*['"]\.\.\/helpers\/l1-gate-1644\.mjs['"]/, 'imported from ../helpers/l1-gate-1644.mjs');
  assert.match(t, /l1Verdict\(\s*['"]idle['"]/, 'called with the idle phase'); assert.match(t, /l1Verdict\(\s*['"]loaded['"]/, 'called with the loaded phase');
  assert.ok((t.match(/assert\.ok\(\s*\w+\.ok\b/g) || []).length >= 2, 'and the ok of each verdict is asserted (assert.ok(<verdict>.ok, ...) twice)');
});

test('#1703 (W3) no inline bound is left in the latency test: no `<= 1000`, no `2 * b`', () => {
  const t = latencyText();
  assert.ok(!/<=\s*1000\b/.test(t), 'the 1.0 s ceiling is gone'); assert.ok(!/\b2\s*\*\s*b\b/.test(t), 'the 2x ratio gate is gone');
});

test('#1703 (W4) the latency test still prints `L1 <label>:` lines with the ratio in them, for idle and loaded', () => {
  const t = latencyText();
  assert.match(t, /`L1 \$\{label\}:/, 'the line template the checker reads'); assert.match(t, /ratio \$\{/, 'the ratio is printed');
  assert.match(t, /phase\(\s*\w+,\s*'idle'\s*\)/); assert.match(t, /phase\(\s*\w+,\s*'loaded \(6 CPU burners\)'\s*\)/);
});

test('#1703 (W5) no stale text: the latency test header and ci.yml no longer say the bounds are unchanged or name 1.0 s / 2x as the gate', () => {
  const t = latencyText(); const ci = fs.readFileSync(CI, 'utf8');
  for (const [name, text] of [['latency test', t], ['ci.yml', ci]]) {
    assert.ok(!/bounds are unchanged/i.test(text), `${name}: "bounds are unchanged"`);
    assert.ok(!/p95\s*<=\s*1\.0 s/.test(text), `${name}: "p95 <= 1.0 s"`); assert.ok(!/<=\s*2x the in-process/.test(text), `${name}: "<= 2x the in-process"`);
  }
  assert.ok(!/1\.0 s \(hard ceiling\)/.test(t), 'the header does not describe the 1.0 s hard ceiling');
});

test('#1703 (W6 CONTROL) ci.yml still has the L1 step and the checker still matches the L1 title by prefix', () => {
  const ci = fs.readFileSync(CI, 'utf8'); const checker = fs.readFileSync(CHECKER, 'utf8');
  assert.match(ci, /name:\s*L1 latency, alone/); assert.match(ci, /ready-executor-1644-latency\.test\.mjs/);
  assert.match(checker, /const L1_PREFIX = 'L1 LATENCY'/);
  const title = titleOf(latencyText()); if (title) assert.ok(title.startsWith('L1 LATENCY'));
});
