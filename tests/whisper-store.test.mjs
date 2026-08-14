/**
 * #802 — persistence for the board-owned whisper: the prompt pool (editable by
 * any seat, no deploy) and the per-window settlement record.
 *
 * The pure decision lives in core/whisper-window.mjs. This is the node half —
 * file I/O, atomic write, and the ONE critical section where load→claim→persist
 * must not yield.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_POOL,
  readPool,
  writePool,
  readWhisperState,
  claimWindow,
  mintOnce,
  recentWhispers,
} from '../whisper-store.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-store-'));
}
const W = (h) => `2026-08-13T${String(h).padStart(2, '0')}:00:00.000Z`;

// ── the pool ───────────────────────────────────────────────────────────────

test('a missing pool file reads as the default pool, not a crash and not empty', () => {
  const d = tmpdir();
  const pool = readPool(path.join(d, 'nope.json'));
  assert.ok(Array.isArray(pool) && pool.length > 0);
  assert.deepEqual(pool, DEFAULT_POOL);
});

test('a corrupt pool file falls back to the default rather than silencing the room', () => {
  const d = tmpdir();
  const f = path.join(d, 'pool.json');
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(readPool(f), DEFAULT_POOL);
});

test('any seat can rewrite the pool, and the next read sees it — no restart, no deploy', () => {
  const d = tmpdir();
  const f = path.join(d, 'pool.json');
  writePool(['first thing', 'second thing'], f);
  assert.deepEqual(readPool(f), ['first thing', 'second thing']);
  writePool(['reworded'], f);
  assert.deepEqual(readPool(f), ['reworded'], 'a later edit wins with no process restart');
});

test('writePool refuses an empty pool — silence must be a choice about cadence, not an empty message', () => {
  const d = tmpdir();
  const f = path.join(d, 'pool.json');
  assert.throws(() => writePool([], f), /at least one/);
  assert.throws(() => writePool(['   '], f), /at least one/);
  assert.throws(() => writePool('not an array', f), /array/);
});

test('writePool drops blanks but keeps the rest, so one bad line does not reject the edit', () => {
  const d = tmpdir();
  const f = path.join(d, 'pool.json');
  writePool(['keep me', '  ', '', 'keep me too'], f);
  assert.deepEqual(readPool(f), ['keep me', 'keep me too']);
});

// ── settlement, on disk ────────────────────────────────────────────────────

test('an unwritten state reads as never-whispered', () => {
  const d = tmpdir();
  const s = readWhisperState(path.join(d, 'state.json'));
  assert.equal(s.lastWhisperWindow, null);
  assert.equal(s.lastWhisperBy, null);
});

test('⭐ three seats claiming the same window against the SAME FILE produce exactly one grant', () => {
  // The store is where the race actually lands: core/whisper-window.mjs is pure
  // and threads state by hand, which is a promise the caller has to keep.
  // Here the seats do NOT share a state object — they each hit the file.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const prompt = { window: W(14), body: 'x', mintedAt: W(14) };
  const results = ['ada', 'bo', 'cy'].map((seat) =>
    claimWindow({ seat, prompt, now: W(14), file: f }),
  );
  assert.equal(results.filter((r) => r.granted).length, 1);
  assert.deepEqual(results.map((r) => r.reason), ['granted', 'already-whispered-this-window', 'already-whispered-this-window']);
  assert.equal(readWhisperState(f).lastWhisperBy, 'ada');
});

test('⚠️ POSITIVE CONTROL through the store — a ten-hour-late prompt is refused and writes nothing', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const stale = { window: W(9), body: 'x', mintedAt: '2026-08-13T09:25:00.000Z' };
  const r = claimWindow({ seat: 'ada', prompt: stale, now: '2026-08-13T20:03:00.000Z', file: f });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'expired-window');
  assert.equal(fs.existsSync(f), false, 'a refused claim does not create the state file');
  // ...and the current window is still available to whoever is actually awake.
  const fresh = { window: W(20), body: 'x', mintedAt: W(20) };
  assert.equal(claimWindow({ seat: 'bo', prompt: fresh, now: '2026-08-13T20:03:00.000Z', file: f }).granted, true);
});

test('a grant is appended to a history, so "did the room get tended" is answerable after the fact', () => {
  // A record that says only that a message was dispatched cannot establish
  // reach retroactively. The settled stage is the one the board owns, so it is
  // the one recorded here. Raised by Value Steward and independent review.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  for (const [h, seat] of [[12, 'ada'], [13, 'cy'], [14, 'bo']]) {
    claimWindow({ seat, prompt: { window: W(h), body: 'x', mintedAt: W(h) }, now: W(h), file: f });
  }
  const hist = recentWhispers(f);
  assert.deepEqual(hist.map((e) => e.seat), ['ada', 'cy', 'bo']);
  assert.deepEqual(hist.map((e) => e.window), [W(12), W(13), W(14)]);
});

test('the history records the seats the prompt REACHED, not just that it was sent', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  claimWindow({
    seat: 'ada',
    prompt: { window: W(14), body: 'x', mintedAt: W(14) },
    now: W(14),
    file: f,
    reached: ['ada', 'bo'], // cy was not a live receiver in this window
  });
  const [e] = recentWhispers(f);
  assert.deepEqual(e.reached, ['ada', 'bo']);
  assert.equal(e.reached.includes('cy'), false);
});

test('⚠️ when reach is UNKNOWN the field is absent — the roster is who we hoped to reach, not who we reached', () => {
  // ⭐ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. The test above asserts the
  // right value while PASSING `reached` explicitly, so a implementation that
  // falls back to the full roster when reach is unknown satisfies it — the
  // fallback branch never runs. I had written "the discriminating assertion"
  // in that test's comment. It discriminated nothing; this is the case where
  // the two candidate implementations differ.
  //
  // Absent must stay absent. A record that invents ['ada','bo','cy']
  // when nobody measured is worse than no record, because it answers the
  // archaeology question CONFIDENTLY and wrongly.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  claimWindow({ seat: 'ada', prompt: { window: W(14), body: 'x', mintedAt: W(14) }, now: W(14), file: f });
  const [e] = recentWhispers(f);
  assert.equal('reached' in e, false, 'unknown reach is recorded as unknown, never as the roster');
});

test('the history is bounded, so the state file cannot grow without limit', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  for (let i = 0; i < 300; i++) {
    const w = new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString();
    claimWindow({ seat: 'ada', prompt: { window: w, body: 'x', mintedAt: w }, now: w, file: f });
  }
  const hist = recentWhispers(f);
  assert.ok(hist.length <= 168, `history capped, got ${hist.length}`);
  assert.equal(hist[hist.length - 1].seat, 'ada');
  // the cap drops the OLDEST, so the most recent window survives
  assert.equal(hist[hist.length - 1].window, new Date(Date.UTC(2026, 0, 1) + 299 * 3600000).toISOString());
});

// ── the board side: minting, once per window, however often the timer ticks ──

test('mintOnce returns the prompt on the first tick of a window and null on every later tick', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const pool = ['alpha'];
  const first = mintOnce({ now: '2026-08-13T14:00:00.000Z', file: f, pool });
  assert.equal(first.body, 'alpha');
  assert.equal(first.window, W(14));
  // the timer ticks every minute; the room must not get sixty prompts an hour
  for (const m of ['01', '17', '59']) {
    assert.equal(mintOnce({ now: `2026-08-13T14:${m}:00.000Z`, file: f, pool }), null);
  }
  // ...and the next window mints again
  assert.equal(mintOnce({ now: W(15), file: f, pool }).window, W(15));
});

test('an empty pool mints nothing and does not burn the window', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  assert.equal(mintOnce({ now: W(14), file: f, pool: [] }), null);
  // the pool being empty is a content problem; when it is fixed the window is
  // still available rather than silently consumed.
  assert.equal(mintOnce({ now: W(14), file: f, pool: ['alpha'] }).body, 'alpha');
});

test('⚠️ SEAM — a whisper claim must not erase the mint guard', () => {
  // The two guards share one state file, and claimWindow rewrites that file
  // from the settlement state. If it drops lastMintedWindow, the very next
  // timer tick re-mints a window that was already sent — and this is invisible
  // from either function read on its own. Defects live in the seams.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const pool = ['alpha'];
  const p = mintOnce({ now: W(14), file: f, pool });
  assert.ok(p);
  claimWindow({ seat: 'ada', prompt: p, now: '2026-08-13T14:05:00.000Z', file: f });
  assert.equal(
    mintOnce({ now: '2026-08-13T14:06:00.000Z', file: f, pool }),
    null,
    'the window was already minted; whispering in it must not make it mintable again',
  );
});

test('⚠️ SEAM — minting must not erase the whisper settlement', () => {
  // The mirror of the test above, and the more damaging direction: if mintOnce
  // rewrites the file without carrying the settlement forward, the whisper
  // record vanishes and a second seat can whisper into a window that already
  // had one.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const pool = ['alpha'];
  const p = mintOnce({ now: W(14), file: f, pool });
  claimWindow({ seat: 'ada', prompt: p, now: W(14), file: f });
  mintOnce({ now: W(15), file: f, pool });
  const hist = recentWhispers(f);
  assert.equal(hist.length, 1, 'the grant history survives a later mint');
  assert.equal(hist[0].seat, 'ada');
});

// ── #804 — the claim-attempt report (bounded demo instrumentation) ─────────

test('⭐ EVERY claim attempt is reported — REFUSALS included, which is the whole point', () => {
  // Before this, a refused claim wrote nothing and logged nothing: only the
  // winner got a server-side timestamp. A contention test would then have one
  // server-observed time and N-1 seat-reported ones — and a seat's own clock is
  // exactly what cannot be trusted (two seats self-reported through a 42-minute
  // lag they could not see).
  //
  // ⚠️ THE DISCRIMINATION: an implementation that reports only on success — the
  // one we HAD — produces a single entry here. The assertion is on the REFUSED
  // ones, so that version fails.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const seen = [];
  const prompt = { window: W(14), body: 'x', mintedAt: W(14) };
  for (const seat of ['ada', 'bo', 'cy']) {
    claimWindow({ seat, prompt, now: W(14), file: f, receivedAt: W(14), onAttempt: (a) => seen.push(a) });
  }
  assert.equal(seen.length, 3, 'all three attempts reported, not just the winner');
  assert.deepEqual(seen.map((a) => a.outcome), ['granted', 'refused', 'refused']);
  assert.deepEqual(seen.map((a) => a.seat), ['ada', 'bo', 'cy']);
  for (const a of seen) assert.equal(a.receivedAt, W(14));
  // a refusal names who holds it; a grant has nobody to name
  assert.equal(seen[0].heldBy, null);
  assert.equal(seen[1].heldBy, 'ada');
  assert.equal(seen[2].heldBy, 'ada');
});

test('an EXPIRED claim is reported too, and is distinguishable from a lost race', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const seen = [];
  claimWindow({
    seat: 'ada',
    prompt: { window: W(9), body: 'x', mintedAt: W(9) },
    now: '2026-08-13T20:03:00.000Z',
    file: f,
    onAttempt: (a) => seen.push(a),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, 'refused');
  assert.equal(seen[0].reason, 'expired-window');
  assert.equal(seen[0].heldBy, null, 'nobody held it — it simply expired');
});

test('the report is ephemeral — it does NOT write durable history (F4 stays deferred)', () => {
  // ⚠️ Guards the scope boundary the steward set: instrumentation reports, it
  // does not persist. If this ever starts writing, F4 has been silently
  // half-built under a demo label.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const prompt = { window: W(14), body: 'x', mintedAt: W(14) };
  claimWindow({ seat: 'ada', prompt, now: W(14), file: f, onAttempt: () => {} });
  claimWindow({ seat: 'bo', prompt, now: W(14), file: f, onAttempt: () => {} });
  const hist = recentWhispers(f);
  assert.equal(hist.length, 1, 'only the GRANT is durable; the refusal is reported, not stored');
  assert.equal(hist[0].seat, 'ada');
});

test('claimWindow works unchanged with no reporter attached', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const r = claimWindow({ seat: 'ada', prompt: { window: W(14), body: 'x', mintedAt: W(14) }, now: W(14), file: f });
  assert.equal(r.granted, true);
});

test('⭐⭐ receivedAt is preserved EXACTLY on both outcomes — the contention clock is ARRIVAL, not completion', () => {
  // The Value Steward's discriminating control. "Does it emit?" would pass against an
  // implementation that stamps at completion or at log-flush; this one cannot,
  // because each call injects a DISTINCT entry time and completion is forced to
  // a different value entirely.
  //
  // ⚠️ Why it matters: a claim that ARRIVED on time but settled slowly (disk,
  // GC, a slow read) reads as late if timed at completion — so a valid
  // contention run could be recorded invalid, or an invalid one waved through.
  const d = tmpdir();
  const f = path.join(d, 'state.json');
  const seen = [];
  const prompt = { window: W(14), body: 'x', mintedAt: W(14) };
  const FAR_LATER = '2026-08-13T23:59:59.000Z';

  claimWindow({
    seat: 'ada', prompt, now: W(14), file: f,
    receivedAt: '2026-08-13T14:00:01.000Z',
    completedClock: () => FAR_LATER,
    onAttempt: (a) => seen.push(a),
  });
  claimWindow({
    seat: 'bo', prompt, now: W(14), file: f,
    receivedAt: '2026-08-13T14:00:04.000Z',
    completedClock: () => FAR_LATER,
    onAttempt: (a) => seen.push(a),
  });

  assert.equal(seen[0].outcome, 'granted');
  assert.equal(seen[1].outcome, 'refused');
  // the exact injected entry times survive, on BOTH paths
  assert.equal(seen[0].receivedAt, '2026-08-13T14:00:01.000Z');
  assert.equal(seen[1].receivedAt, '2026-08-13T14:00:04.000Z');
  // ...and are NOT contaminated by completion time
  assert.notEqual(seen[0].receivedAt, FAR_LATER);
  assert.notEqual(seen[1].receivedAt, FAR_LATER);
  assert.equal(seen[0].completedAt, FAR_LATER);

  // the interval the demo actually consumes: 3 seconds, from arrival times
  const delta = Date.parse(seen[1].receivedAt) - Date.parse(seen[0].receivedAt);
  assert.equal(delta, 3000, 'contention interval is computed from receivedAt alone');
});
