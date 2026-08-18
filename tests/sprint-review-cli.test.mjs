/**
 * #755 — the review instrument must be RUNNABLE by someone who is not its author.
 *
 * ⚠️ The defect this closes: `core/sprint-signals.mjs` shipped with five
 * exports, a green test file, and no entry point. Its numbers were produced by
 * ad-hoc glue in the author's own session, and a second seat could not
 * reproduce them — not because the code was wrong, but because the glue existed
 * nowhere the repo could see.
 *
 * ⇒ On the closing day that person finds a module they cannot invoke, writes
 *   their own harness, and narrates the verdict anyway — which is the exact
 *   outcome the instrument was built to prevent.
 *
 * So these tests run the SCRIPT, as a subprocess, the way a stranger would.
 * A unit test of the functions cannot catch a missing entry point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/sprint-review.mjs', import.meta.url));

function fixtureDir(events) {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-'));
  writeFileSync(join(dir, 'events-2026-08-10.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

const SEATS_ARG = ['--seats', 'ada,bo,cy'];

function run(args, { expectFail = false } = {}) {
  try {
    return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (expectFail) return `${e.stdout || ''}${e.stderr || ''}__EXIT_${e.status}`;
    throw new Error(`script failed: ${e.stderr || e.message}`);
  }
}

const ev = (actor, op, at = '2026-08-10T02:30:00.000Z') => ({
  actor,
  op,
  entity: { kind: 'card', id: 'x' },
  occurred_at: at,
});

test('#755-cli ⭐⭐ THE SCRIPT EXISTS AND RUNS — a module with no entry point is not an instrument', () => {
  assert.ok(existsSync(SCRIPT), 'scripts/sprint-review.mjs is missing');
  const dir = fixtureDir([ev('ada', 'create'), ev('bo', 'update')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG]);
  assert.match(out, /SPRINT REVIEW/);
  assert.match(out, /SIGNAL 1/);
  assert.match(out, /SIGNAL 2/);
  assert.match(out, /SIGNAL 3/);
});

test('#755-cli the run is REPRODUCIBLE — same inputs, byte-identical report', () => {
  // The property that was missing: a second reader must be able to get the
  // author's numbers without writing their own harness.
  const dir = fixtureDir([ev('ada', 'create'), ev('bo', 'update')]);
  const args = ['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG];
  assert.equal(run(args), run(args));
});

test('#755-cli it reports the DENOMINATOR and the exclusions, so the filter is auditable', () => {
  // ⚠️ `stranger` was doing an `update` here. Once the denominator was bound to
  // what the gate actually ENFORCES, `update` stopped counting at all — so the
  // exclusion count changed for a reason that had nothing to do with the filter
  // this test is about. Both non-seat actors now do the enforced op.
  const dir = fixtureDir([ev('ada', 'update'), ev(null, 'update'), ev('stranger', 'update')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG]);

  // ⭐ #889 — THE RATIO IS BACK, AND IT MEANS SOMETHING NOW.
  //
  // Two revisions of this assertion in one evening, and the sequence is the
  // point: it began as a ratio over `create`, became UNMEASURABLE when #890
  // showed that no create could ever be a violation, and is a ratio again now
  // that the enforced op is one the gate can actually scope. Same three lines
  // of output, three different truth values, each correct for its own build.
  assert.match(out, /1 \/ 1|0 \/ 1/);
  assert.match(out, /2 non-seat action\(s\) excluded/);
  assert.match(out, /enforced ops counted: update/);
});

test('#755-cli ⚠️ it says an UNMEASURABLE signal is not a passing signal — every run, not just bad ones', () => {
  // A reader who sees only "none firing" reads it as "going well".
  const dir = fixtureDir([ev('ada', 'create')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG]);
  assert.match(out, /AN UNMEASURABLE SIGNAL IS NOT A PASSING SIGNAL/);
  assert.match(out, /of 3 signals measurable/);
});

test('#755-cli the structural-zero caveat reaches the OUTPUT, not just the return value', () => {
  // ⚠️ RESTORED, and the history is worth keeping. This asserted STRUCTURAL
  // ZERO originally; #890 replaced it with an R4 assertion because `create`
  // could never be scoped, so the stronger statement ("this population can
  // never produce evidence") superseded the weaker one ("we have no evidence
  // yet"). #889 moved the enforced op to `update`, which the gate CAN scope —
  // so R4 no longer fires here and the original caveat is the true one again.
  //
  // ⇒ Both were correct for their own build. The discipline that survives all
  //   three revisions: a zero that means "no instrument" must never print as a
  //   zero, whichever reason makes it so.
  const dir = fixtureDir([ev('ada', 'update'), ev('bo', 'update')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG]);
  assert.match(out, /STRUCTURAL ZERO/);
  assert.match(out, /not evidence of compliance/i);
});


test('#755-cli ⛔ it REFUSES without --since rather than reviewing everything', () => {
  const out = run([], { expectFail: true });
  assert.match(out, /--since/);
  assert.match(out, /__EXIT_2/);
});

test('#755-cli ⛔ a bad timestamp fails loudly instead of quietly reviewing nothing', () => {
  const out = run(['--since', 'last tuesday', ...SEATS_ARG], { expectFail: true });
  assert.match(out, /not a parseable timestamp/);
  assert.match(out, /__EXIT_2/);
});

test('#755-cli ⛔ a missing events dir fails rather than printing an empty report', () => {
  // An empty report from a missing directory is the plausible-zero defect
  // wearing a filesystem error.
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', '/nonexistent/xyz', ...SEATS_ARG], { expectFail: true });
  assert.match(out, /events dir not found/);
  assert.match(out, /__EXIT_2/);
});

test('#755-cli a firing signal exits 0 — a result is not an error', () => {
  // Non-zero on a firing signal would tempt someone to suppress the run.
  const dir = fixtureDir([ev('ada', 'create')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, '--human-races', '3', ...SEATS_ARG]);
  assert.match(out, /FIRING/);
});

test('#755-cli --human-races 0 is a RESULT, not an absence', () => {
  const dir = fixtureDir([ev('ada', 'create')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, '--human-races', '0', ...SEATS_ARG]);
  assert.match(out, /SIGNAL 3.*0 \/ 1/);
  assert.equal(/SIGNAL 3.*UNMEASURABLE/.test(out), false);
});

test('#755-cli the window is filtered by TIMESTAMP, not by filename', () => {
  // A filename-based window silently drops events in a file whose date
  // straddles the boundary — the awk timestamp-range trap in a different suit.
  const dir = fixtureDir([
    ev('ada', 'create', '2026-08-10T01:00:00.000Z'), // before the window
    ev('bo', 'create', '2026-08-10T05:00:00.000Z'), // inside it
  ]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG]);
  assert.match(out, /events since 2026-08-10T02:00:00Z: 1/);
});

test('#755-cli ⛔ it REFUSES a guessed roster — no seats, no run', () => {
  // A hardcoded seat list is a roster snapshot that goes stale SILENTLY: it
  // does not error, it quietly drops a seat's actions out of signal 2's
  // denominator. That is the instrument-reach defect this whole card is about,
  // so the script refuses rather than assuming.
  const dir = fixtureDir([ev('ada', 'create')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir], { expectFail: true });
  assert.match(out, /--seats/);
  assert.match(out, /__EXIT_2/);
});

test('#755-cli ⛔ it REFUSES to guess where the event log lives', () => {
  // A hardcoded path is one machine's layout published into a public repo.
  const out = run(['--since', '2026-08-10T02:00:00Z', ...SEATS_ARG], { expectFail: true });
  assert.match(out, /--events/);
  assert.match(out, /__EXIT_2/);
});

test('#755-cli the report NAMES the seats it counted, so a stale roster is visible', () => {
  const dir = fixtureDir([ev('ada', 'create')]);
  const out = run(['--since', '2026-08-10T02:00:00Z', '--events', dir, ...SEATS_ARG]);
  assert.match(out, /seats counted: ada, bo, cy/);
});
