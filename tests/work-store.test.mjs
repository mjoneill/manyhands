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
import { declare, bid, nobid, grant, stateAt, STATES } from '../core/work-auction.mjs';

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

// ── #797 ⛔ KNOWN DEFECT, encoded as the test that must go green ─────────────
//
// MEASURED 2026-08-12. appendTransitions() reads the log, computes `already`
// from the transition COUNT, and appends. Two callers holding the same loaded
// object therefore write "the same" third transition as far as the store can
// tell — and it is not the same one.
//
// ⚠️ This required NO interleaving. The two appends below are fully SERIAL.
// It is a stale-snapshot lost update, not a race, so a lock alone will not
// fix it: identity here is POSITIONAL at both layers (`already` in the writer,
// `transitions.length === rec.seq` in the fold).
//
// ⭐ Marked `todo` deliberately rather than asserting the broken behaviour. A
// characterization test that asserts the loss would go RED when someone fixes
// the store, and the cheapest way to make it green again is to re-assert the
// loss. This encodes the property we WANT: it fails today, it does not break
// the suite, and it turns green exactly when #797's store boundary lands.
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
