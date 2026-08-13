/**
 * #755 slice 2d — the work-object store. The line that turns the adapter from
 * tested-and-inert into live-when-armed.
 *
 * ── WHY THIS IS THE CRITICAL PATH ───────────────────────────────────────────
 * The gate (2b) is wired and tested, and `openWorkObjects()` returns []. So
 * arming the flag today refuses NOBODY, and the review instrument reports
 * signal 2 as a STRUCTURAL ZERO — a cell that looks like "no bypasses" and
 * means "no instrument". This store is what removes that caveat.
 *
 * ── SHAPE: APPEND-ONLY JSONL, ONE LINE PER TRANSITION ───────────────────────
 * Not a mutable document. The transition log IS the state, and `stateAt`
 * already derives everything from it — so persistence is "append the
 * transition and re-read", with no separate snapshot to fall out of sync.
 *
 * ⇒ DESIGN B survives a restart by construction: nothing is in memory that
 *   isn't on disk, and re-reading the file yields the identical derived state.
 *
 * ── PURE POINTERS, NO DISCRIMINATOR, DELIBERATELY ───────────────────────────
 * A discriminator (which slice of a card a bid is for) was designed tonight —
 * referent-validated rather than shape-validated — and then NOT shipped,
 * because `one card per grantable unit` forbids the collision it solves. If a
 * real bid cannot be expressed without one, that is a MEASURED requirement
 * rather than a designed one. See #755.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTransitions, readWorkObjects, openWorkObjectsAt, foldLines } from '../core/work-store.mjs';
import { declare, bid, nobid, grant, stateAt, settle, STATES } from '../core/work-auction.mjs';

const T0 = '2026-08-10T02:00:00.000Z';
const REPLY_BY = '2026-08-10T02:20:00.000Z';
const DURING = '2026-08-10T02:10:00.000Z';
const AFTER = '2026-08-10T02:30:00.000Z';

const dir = () => mkdtempSync(join(tmpdir(), 'work-store-'));
const wo = (id, by = 'ada') => declare({ id, by, at: T0, replyBy: REPLY_BY, required: ['ada', 'bo'] });

// ── round trip ──────────────────────────────────────────────────────────────

test('#755-2d a written work object comes back identical', () => {
  const d = dir();
  const a = wo('w1');
  appendTransitions(d, a);
  const back = readWorkObjects(d);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], a);
});

test('#755-2d ⭐⭐ DERIVED STATE SURVIVES THE ROUND TRIP — design B, against a real file', () => {
  // The unit test used JSON.parse(JSON.stringify(...)). This is the same
  // property against bytes that actually left the process.
  const d = dir();
  appendTransitions(d, wo('w1'));
  const back = readWorkObjects(d)[0];
  assert.equal(stateAt(back, DURING).state, STATES.BIDDING);
  assert.equal(stateAt(back, AFTER).state, STATES.GRANTED);
  assert.equal(stateAt(back, AFTER).grantedBy, 'timeout');
});

test('#755-2d appending a LATER transition preserves the earlier ones — append-only, never rewrite', () => {
  const d = dir();
  const a = wo('w1');
  appendTransitions(d, a);
  const b = nobid(a, { by: 'bo', at: DURING });
  appendTransitions(d, b);
  const back = readWorkObjects(d)[0];
  assert.deepEqual(back.transitions, b.transitions);
  assert.equal(stateAt(back, DURING).state, STATES.GRANTED, 'early-close should now hold');
});

test('#755-2d ⭐ appending twice does not duplicate transitions — the log is a SET by (id, seq)', () => {
  // A retry, a double-write, a crash mid-append: none of them may inflate the
  // log, because a duplicated `bid` would change who the auction thinks bid.
  const d = dir();
  const a = wo('w1');
  appendTransitions(d, a);
  appendTransitions(d, a);
  const back = readWorkObjects(d)[0];
  assert.deepEqual(back.transitions, a.transitions);
});

test('#755-2d several work objects coexist and stay separate', () => {
  const d = dir();
  appendTransitions(d, wo('w1', 'ada'));
  appendTransitions(d, wo('w2', 'bo'));
  const back = readWorkObjects(d);
  assert.deepEqual(back.map((o) => o.id).sort(), ['w1', 'w2']);
  assert.deepEqual(stateAt(back.find((o) => o.id === 'w1'), DURING).bidders, ['ada']);
});

// ── what the gate actually asks for ─────────────────────────────────────────

test('#755-2d ⭐⭐ openWorkObjectsAt returns only the ones still in play', () => {
  const d = dir();
  appendTransitions(d, wo('open-1'));
  appendTransitions(d, grant(wo('granted-1'), { by: 'bo', to: 'ada', at: DURING }));
  const live = openWorkObjectsAt(d, DURING);
  assert.deepEqual(live.map((o) => o.id), ['open-1']);
});

test('#755-2d a window that has timed out is no longer OPEN — derived, not written', () => {
  const d = dir();
  appendTransitions(d, wo('w1'));
  assert.equal(openWorkObjectsAt(d, DURING).length, 1);
  assert.equal(openWorkObjectsAt(d, AFTER).length, 0, 'timeout granted it; nothing had to fire');
});

test('#755-2d ⛔ openWorkObjectsAt REFUSES without a clock, like everything else here', () => {
  const d = dir();
  assert.throws(() => openWorkObjectsAt(d), /now is required/);
});

test('#755-2d an ABSENT store is empty, not an error — the gate must not break the board', () => {
  // If the store directory does not exist, the correct behaviour is "no open
  // work objects", not a throw that would take card_create down with it.
  const missing = join(tmpdir(), 'work-store-does-not-exist-xyz');
  assert.equal(existsSync(missing), false);
  assert.deepEqual(readWorkObjects(missing), []);
  assert.deepEqual(openWorkObjectsAt(missing, DURING), []);
});

// ── the log is hostile-input tolerant, because a log always eventually is ────

test('#755-2d a corrupt line is SKIPPED and COUNTED, never silently dropped', () => {
  const d = dir();
  appendTransitions(d, wo('w1'));
  writeFileSync(join(d, 'work-objects.jsonl'), readFileSync(join(d, 'work-objects.jsonl'), 'utf8') + '{not json\n');
  const { objects, malformed } = foldLines(readFileSync(join(d, 'work-objects.jsonl'), 'utf8'));
  assert.equal(objects.length, 1);
  assert.equal(malformed, 1, 'a skipped line must be reported, or the store lies about its own reach');
});

test('#755-2d foldLines is PURE — same text, same objects, no filesystem', () => {
  const text = '{"id":"w1","seq":0,"transition":{"type":"declare","by":"ada","at":"' + T0 + '"},"replyBy":"' + REPLY_BY + '","required":["ada","bo"],"declaredBy":"ada","sourceMessageId":null}\n';
  const a = foldLines(text);
  const b = foldLines(text);
  assert.deepEqual(a, b);
  assert.equal(a.objects[0].id, 'w1');
});

// ── PII: the store cannot hold what the object cannot carry ─────────────────

test('#755-2d ⛔ NO FREE TEXT REACHES DISK — the stored line has only known keys', () => {
  const d = dir();
  appendTransitions(d, bid(wo('w1'), { by: 'bo', at: DURING }));
  const lines = readFileSync(join(d, 'work-objects.jsonl'), 'utf8').trim().split('\n');
  for (const line of lines) {
    const rec = JSON.parse(line);
    assert.deepEqual(
      Object.keys(rec).sort(),
      ['card', 'declaredBy', 'id', 'replyBy', 'required', 'seq', 'sourceMessageId', 'transition'].sort(),
    );
    assert.deepEqual(Object.keys(rec.transition).sort().filter((k) => !['type', 'by', 'at', 'to'].includes(k)), []);
  }
  // ⚠️ The guard is upstream: work-auction's writers refuse unknown fields, so
  // there is no free-text field for a description to arrive in. This test
  // asserts that property survives all the way to the bytes on disk — the
  // place where "we'll scrub it later" stops being available.
});

// ── ⛔ AN OBJECT THAT DID NOT EXIST YET IS NOT AN OPEN WINDOW ────────────────
//
// The adjacent edge to the stateAt time-filter fix, found in review before it
// could be quoted: `replyBy` and `required` are OBJECT-level, not transition
// level. So once transitions are filtered to `at <= now`, a query BEFORE the
// declaration leaves zero transitions but a fully-formed object — and stateAt
// computes OPEN with empty bidders.
//
// ⭐ Harmless for signal 2: empty bidders means nobody matches, so no actor is
//    falsely counted.
// ⚠️ NOT harmless for any retrospective count of open windows, which is exactly
//    the kind of number that gets quoted later.

test('#755-2d ⛔ a work object is not "open" at a time before it was declared', () => {
  const d = dir();
  appendTransitions(d, wo('w1'));
  const beforeItExisted = '2026-08-10T01:00:00.000Z'; // an hour before T0
  assert.deepEqual(openWorkObjectsAt(d, beforeItExisted), [], 'a phantom open window');
  assert.equal(openWorkObjectsAt(d, DURING).length, 1, 'and it IS open once it exists');
});

test('#755-2d an object is in play from the instant of its declaration, not later', () => {
  const d = dir();
  appendTransitions(d, wo('w1'));
  assert.equal(openWorkObjectsAt(d, T0).length, 1, 'must count AT its own declaration timestamp');
});

test('#797 openWorkObjectsAt REFUSES a non-string `now`, like stateAt', () => {
  // The same defect lived at both clock boundaries: `if (!now)` tests presence,
  // and the failure mode is type. A numeric `now` here silently reports that
  // NOTHING is open, which reads as a quiet board rather than a broken query.
  const d = dir();
  assert.throws(() => openWorkObjectsAt(d, Date.parse('2026-08-10T13:00:00.000Z')), /canonical/);
});

// ── #797 ⛔ A LATENT STORE DEFECT — reachable through this API, NOT through
//           the tool path. Read the scope note before acting on it.
//
// MEASURED 2026-08-12 against appendTransitions() DIRECTLY: it reads the log,
// computes `already` from the transition COUNT, and appends. Two callers
// holding the same loaded object therefore write "the same" next transition as
// far as the store can tell — and it is not the same one. Identity is
// POSITIONAL at both layers (`already` in the writer, `transitions.length ===
// rec.seq` in the fold), so a retry and a conflict are indistinguishable.
//
// ⛔⛔ SCOPE CORRECTION, same day, by the author. The first version of this
// comment implied the running system loses answers. IT DOES NOT, via the tool
// path:
//
//   core/work-tools.mjs:94-95 is the ONLY production writer, and it runs
//   load() [readFileSync] → verb → appendTransitions() [appendFileSync]
//   with NO await between them. A single-threaded event loop cannot interleave
//   two callers there, so the second caller re-reads AFTER the first appended.
//
// ⚠️ So the stale snapshot below is constructed BY THIS TEST and is not
// currently produced by any caller. The mechanism is real; the claim that it
// drops live answers was wrong and propagated because it arrived with a repro
// attached.
//
// ⭐ WHY IT IS STILL WORTH FIXING: nothing DECLARES that critical section. The
// invariant holds because two synchronous calls happen to be adjacent, and no
// comment at the call site says so. One `await` inserted between those lines —
// or one second writing process, against which in-process synchrony is not a
// lock — makes it live and silent.
//
// ⭐ Marked `todo` rather than asserting the broken behaviour: a characterization
// test that asserts the loss goes RED when someone fixes the store, and the
// cheapest way to green it again is to re-assert the loss. A test that punishes
// the fix is worse than no test.
//
// ⚠️ It does NOT self-announce. A `{ todo: true }` test reports todo forever;
// the marker comes off by hand or not at all. See #797's card comment.
test('#797 two stale callers submitting different answers must BOTH survive', { todo: true }, () => {
  const d = dir();
  const base = declare({
    id: 'w-stale', by: 'ada', at: T0,
    required: ['bo', 'cy'], replyBy: AFTER,
  });
  appendTransitions(d, base);

  // Both read the same tail before either wrote — the normal case for a bid
  // window, not an unlucky one.
  const first = nobid(base, { by: 'bo', at: DURING });
  const second = bid(base, { by: 'cy', at: DURING });

  appendTransitions(d, first);
  appendTransitions(d, second); // returns 0 today, and reports success

  const answered = readWorkObjects(d)[0].transitions.map((t) => t.by);
  assert.ok(answered.includes('bo'), 'the first answer must be in the log');
  assert.ok(
    answered.includes('cy'),
    'the second answer was ACCEPTED by the API and is absent from the log — '
    + 'indistinguishable, from both ends, from never having answered at all',
  );
});

// ── #797 ⭐⭐⭐ THE PRODUCTION-SHAPED FIXTURE — shapes nobody designed ─────────
//
// Copied from the live work store on 2026-08-12 and SANITISED: seat names
// substituted, object ids replaced, card pointers and source message ids
// removed. Only the transition structures remain, which is the whole point —
// constructed fixtures test the cases the author thought of, and these five test
// the cases the protocol actually produced.
//
// ⚠️ THIS EXISTS BECAUSE THE FIRST VERSION OF THIS CHECK WAS AN AD-HOC RUN.
// Its result was posted as a table of ✅s, which reads exactly like a test
// result and was a measurement that would never run again and that nobody else
// could reproduce. A finding that lives only where nobody re-reads it is the
// class this board has been carding all week.
//
// The date is in the FILENAME so the next reader can see how old these shapes
// are rather than inheriting them as current.

const FIXTURE = new URL('./fixtures/work-objects-2026-08-12.jsonl', import.meta.url);
const FIXTURE_NOW = '2026-08-12T19:45:00.000Z';

test('#797 ⭐⭐ settlement does not move ANY production-shaped object', () => {
  const objects = foldLines(readFileSync(FIXTURE, 'utf8')).objects;
  assert.equal(objects.length, 5, 'the fixture must carry all five shapes');

  for (const wo of objects) {
    const before = stateAt(wo, FIXTURE_NOW);
    const after = stateAt(settle(wo, FIXTURE_NOW), FIXTURE_NOW);

    // #795 added a `settlement` field whose whole purpose is to differ between a
    // settled and an unsettled object, so the comparison is pinned to "nothing
    // BUT that field moved" rather than relaxed.
    assert.deepEqual({ ...after, settlement: null }, before,
      `${wo.id} drifted under settlement — it must alter DURABILITY, never the ANSWER`);
    assert.ok(after.settlement, `${wo.id} produced no settlement record`);
    assert.equal(after.settlement.closureReason, before.grantedBy,
      `${wo.id}: the recorded closure reason must match the one the view already derived`);
  }
});

test('#797 the fixture carries the three timeout-with-pending grants that make it worth having', () => {
  // ⭐ These are the shapes no hand-written fixture would have included: grants
  // the room has explicitly questioned, where a required seat never answered.
  // They are why the settlement freezes `pendingAtClosure` onto the fact rather
  // than recording a bare grant.
  const objects = foldLines(readFileSync(FIXTURE, 'utf8')).objects;
  const settlements = objects
    .map((wo) => settle(wo, FIXTURE_NOW).transitions.find((t) => t.type === 'settlement'))
    .filter(Boolean);

  assert.equal(settlements.length, 5, 'every settled shape must materialise exactly once');
  const withCaveat = settlements.filter((s) => s.pendingAtClosure.length > 0);
  assert.equal(withCaveat.length, 3, 'three grants closed with a required seat still pending');
  assert.deepEqual(withCaveat.map((s) => s.closureReason), ['timeout', 'timeout', 'timeout']);
  assert.deepEqual(
    settlements.filter((s) => s.pendingAtClosure.length === 0).map((s) => s.closureReason),
    ['early-close', 'early-close'],
    'and the two unambiguous ones closed because everyone answered',
  );
});
