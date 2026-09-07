/**
 * #1255 slice 1 — THE DIAGNOSTIC, not the fix.
 *
 * The operator loses typed content. Four explanations are live and they need
 * DIFFERENT fixes:
 *
 *   A  composer     the payload left the browser WHOLE and the UI lost it
 *   B  input/send   the payload was ALREADY short when it was sent
 *   C  queueing     the payload was whole, the acknowledgement stalled
 *   D  host         the machine stalled / the page reloaded under memory
 *                   pressure — manyhands is not the defect at all
 *
 * The room nearly built on C twice. D is invisible to anything that only
 * watches the page, because "the machine stalled" and "the composer lost it"
 * are the same observation from inside a tab.
 *
 * So this module records what happened and REFUSES TO GUESS when the evidence
 * cannot separate the four. `UNKNOWN` is a first-class verdict here, not a
 * failure — a diagnostic that always names a culprit is a coin toss with
 * better formatting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTrace, appendEvent, detectLoss, classify, serialize, deserialize, TRACE_MAX,
} from '../core/composer-trace.mjs';

const t0 = Date.parse('2026-09-07T18:00:00.000Z');
const at = (s) => t0 + s * 1000;

/** Build a trace from a list of events, oldest first. */
const traceOf = (...evs) => evs.reduce((tr, e) => appendEvent(tr, e), emptyTrace());

test('#1255 the buffer is bounded — a long composing session cannot grow without limit', () => {
  let tr = emptyTrace();
  for (let i = 0; i < TRACE_MAX + 250; i++) tr = appendEvent(tr, { kind: 'draft', t: at(i), len: i });
  assert.equal(tr.events.length, TRACE_MAX);
  assert.equal(tr.events.at(-1).len, TRACE_MAX + 249, 'the NEWEST events are the ones kept');
  assert.equal(tr.dropped, 250, 'and it says how many it dropped rather than pretending');
});

test('#1255 LOSS DETECTED — a sharp drop with no submit in between', () => {
  const tr = traceOf(
    { kind: 'draft', t: at(0), len: 40 },
    { kind: 'draft', t: at(10), len: 1800 },
    { kind: 'draft', t: at(20), len: 2400 },
    { kind: 'draft', t: at(21), len: 300 },     // ⇐ four fifths gone
  );
  const loss = detectLoss(tr);
  assert.ok(loss, 'a 2400 → 300 drop must be detected');
  assert.equal(loss.from, 2400);
  assert.equal(loss.to, 300);
  assert.equal(loss.at, at(21));
});

test('#1255 NEGATIVE CONTROL — posting empties the box and that is NOT a loss', () => {
  const tr = traceOf(
    { kind: 'draft', t: at(0), len: 1200 },
    { kind: 'draft', t: at(5), len: 2400 },
    { kind: 'submit', t: at(6), draftLen: 2400, payloadLen: 2400 },
    { kind: 'response', t: at(7), status: 200, ms: 900 },
    { kind: 'draft', t: at(8), len: 0 },        // the composer cleared, correctly
  );
  assert.equal(detectLoss(tr), null, 'a cleared box after a successful post is not a defect');
});

test('#1255 NEGATIVE CONTROL 2 — deliberate select-all-and-delete is not flagged as a mystery', () => {
  // A human clearing their own draft goes to ZERO, not to a fragment.
  const tr = traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'draft', t: at(1), len: 0 },
  );
  assert.equal(detectLoss(tr), null, 'a drop to exactly zero with no submit reads as the human clearing it');
});

test('#1255 CLASSIFY A — payload left whole, the UI lost the draft afterwards', () => {
  const v = classify(traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'submit', t: at(1), draftLen: 2400, payloadLen: 2400 },
    { kind: 'response', t: at(2), status: 200, ms: 400 },
    { kind: 'draft', t: at(3), len: 300 },
    { kind: 'host', t: at(3), freeMemMb: 8000, loadavg1: 2.0 },
  ));
  assert.equal(v.verdict, 'COMPOSER');
  assert.match(v.why, /whole/i);
});

test('#1255 CLASSIFY B — the payload was already short when it was sent', () => {
  const v = classify(traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'submit', t: at(1), draftLen: 2400, payloadLen: 300 },
    { kind: 'response', t: at(2), status: 200, ms: 400 },
    { kind: 'host', t: at(2), freeMemMb: 8000, loadavg1: 2.0 },
  ));
  assert.equal(v.verdict, 'SEND_PATH');
});

test('#1255 CLASSIFY C — payload whole, the acknowledgement stalled', () => {
  const v = classify(traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'submit', t: at(1), draftLen: 2400, payloadLen: 2400 },
    { kind: 'response', t: at(90), status: 200, ms: 89000 },
    { kind: 'host', t: at(90), freeMemMb: 8000, loadavg1: 2.0 },
  ));
  assert.equal(v.verdict, 'QUEUEING');
  assert.match(v.why, /89/);
});

test('#1255 CLASSIFY D — the host stalled, and this is the one a page-only test cannot see', () => {
  const v = classify(traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'host', t: at(1), freeMemMb: 9000, loadavg1: 2.0 },
    { kind: 'host', t: at(20), freeMemMb: 380, loadavg1: 19.4 },   // memory gone, load spiked
    { kind: 'draft', t: at(21), len: 300 },
  ));
  assert.equal(v.verdict, 'HOST_PRESSURE');
  assert.match(v.why, /memor|load/i);
});

test('#1255 ⭐ IT REFUSES TO GUESS — a loss with no host samples is UNKNOWN, not COMPOSER', () => {
  const v = classify(traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'draft', t: at(21), len: 300 },
  ));
  assert.equal(v.verdict, 'UNKNOWN',
    'without host samples, "the UI lost it" and "the machine stalled" are the SAME observation');
  assert.match(v.why, /host/i, 'and it must say what evidence was missing');
});

test('#1255 no loss at all reports NO_LOSS rather than an accusation', () => {
  const v = classify(traceOf({ kind: 'draft', t: at(0), len: 40 }, { kind: 'draft', t: at(1), len: 120 }));
  assert.equal(v.verdict, 'NO_LOSS');
});

test('#1255 the trace survives a reload — round-trips through a string, and bad input yields an EMPTY trace not a throw', () => {
  const tr = traceOf(
    { kind: 'draft', t: at(0), len: 2400 },
    { kind: 'submit', t: at(1), draftLen: 2400, payloadLen: 2400 },
  );
  const back = deserialize(serialize(tr));
  assert.deepEqual(back.events, tr.events);
  // localStorage can hand back anything at all; a diagnostic must not be the
  // thing that breaks the composer it is watching.
  for (const junk of [null, undefined, '', 'not json', '{"events":"nope"}', '[]']) {
    const r = deserialize(junk);
    assert.deepEqual(r.events, [], `deserialize(${JSON.stringify(junk)}) must be empty, not a throw`);
  }
});

// ---------------------------------------------------------------------------
// THE SEAM. The module above is pure; this asks the real server for the thing
// the module cannot compute — because the whole point of the host sample is
// that the page cannot see the host.
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

test('#1255 SEAM: /api/host-pressure answers with the fields the diagnostic needs', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const t = Date.now();
    const r = await fetch(`${srv.baseUrl}/api/host-pressure`);
    const ms = Date.now() - t;
    assert.equal(r.status, 200);
    const h = await r.json();
    for (const k of ['at', 'loadavg1', 'freeMemMb', 'totalMemMb', 'rssMb']) {
      assert.ok(h[k] !== undefined, `missing ${k}`);
    }
    assert.equal(typeof h.freeMemMb, 'number');
    assert.ok(h.freeMemMb > 0 && h.freeMemMb <= h.totalMemMb, `freeMemMb ${h.freeMemMb} of ${h.totalMemMb}`);
    assert.ok(Number.isFinite(Date.parse(h.at)), 'at must be a timestamp the trace can join on');
    // ⛔ An instrument that queues behind the board's write lock is useless in
    // exactly the window it exists to measure (#1114). This must not read the board.
    assert.ok(ms < 2000, `host-pressure took ${ms}ms — it must not touch the store`);

    // And the join actually works: a sample from the wire classifies.
    const { classify, appendEvent, emptyTrace } = await import('../core/composer-trace.mjs');
    const now = Date.parse(h.at);
    let tr = emptyTrace();
    tr = appendEvent(tr, { kind: 'draft', t: now - 2000, len: 2400 });
    tr = appendEvent(tr, { kind: 'host', t: now, freeMemMb: h.freeMemMb, loadavg1: h.loadavg1 });
    tr = appendEvent(tr, { kind: 'draft', t: now + 1000, len: 300 });
    const v = classify(tr);
    assert.notEqual(v.verdict, 'UNKNOWN', 'a real host sample must lift the verdict off UNKNOWN');
    assert.ok(['COMPOSER', 'HOST_PRESSURE'].includes(v.verdict), `got ${v.verdict}`);
  } finally {
    await srv.stop();
  }
});
