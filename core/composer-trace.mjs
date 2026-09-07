/**
 * #1255 slice 1 — THE COMPOSER DIAGNOSTIC.
 *
 * The operator loses typed content. Four explanations are live, they predict
 * four different fixes, and the room nearly built on the wrong one twice:
 *
 *   COMPOSER       the payload left the browser WHOLE and the UI lost the draft
 *   SEND_PATH      the payload was ALREADY short when it was sent
 *   QUEUEING       the payload was whole; the acknowledgement stalled
 *   HOST_PRESSURE  the machine stalled — this project is not the defect
 *
 * ⭐ HOST_PRESSURE is the one nothing inside the page can see. "The machine
 * froze and the tab reloaded" and "the composer lost it" are the SAME
 * observation from in there, which is why this module takes host samples and
 * why it answers UNKNOWN without them. A diagnostic that always names a
 * culprit is a coin toss with better formatting.
 *
 * Pure and DOM-free so it can be tested without a browser; the page supplies
 * events and persistence.
 */

/** Newest-N. A long composing session must not grow without bound. */
export const TRACE_MAX = 500;

/** A draft that falls below this fraction of its peak, to a NON-EMPTY remnant. */
const LOSS_RATIO = 0.35;
/** …and by at least this many characters, so small edits are not "loss". */
const LOSS_MIN_CHARS = 200;
/** A response slower than this is the operator-patience bound from #1114. */
const SLOW_RESPONSE_MS = 10_000;
/** Host thresholds. Deliberately coarse: this separates hypotheses, it does not profile. */
const LOW_FREE_MEM_MB = 1024;
const HIGH_LOADAVG = 8;
/** How far from the loss a host sample still counts as contemporaneous. */
const HOST_WINDOW_MS = 90_000;

export function emptyTrace() {
  return { events: [], dropped: 0 };
}

export function appendEvent(trace, ev) {
  const base = trace && Array.isArray(trace.events) ? trace : emptyTrace();
  const events = [...base.events, ev];
  const over = Math.max(0, events.length - TRACE_MAX);
  return { events: over ? events.slice(over) : events, dropped: (base.dropped || 0) + over };
}

const drafts = (t) => t.events.filter((e) => e && e.kind === 'draft' && typeof e.len === 'number');
const hosts = (t) => t.events.filter((e) => e && e.kind === 'host');

/**
 * The draft shrank to a FRAGMENT. Deliberately not "the draft shrank":
 *
 * ⛔ A drop to exactly ZERO is not a loss. That is the composer clearing after
 *    a successful post, or a human selecting all and deleting — both ordinary,
 *    and flagging them would bury the real thing in noise.
 * ⇒ What is not ordinary is text going from 2,400 characters to 300.
 */
export function detectLoss(trace) {
  const ds = drafts(trace || emptyTrace());
  for (let i = 1; i < ds.length; i++) {
    const from = ds[i - 1].len;
    const to = ds[i].len;
    if (to <= 0) continue;                              // cleared, not lost
    if (from - to < LOSS_MIN_CHARS) continue;           // an edit, not a loss
    if (to / from > LOSS_RATIO) continue;
    return { at: ds[i].t, from, to, ratio: to / from };
  }
  return null;
}

/**
 * Which of the four does the evidence actually support?
 *
 * Order matters: SEND_PATH and QUEUEING are readable from the SUBMIT alone and
 * do not require the draft to have visibly shrunk, so they are checked first.
 */
export function classify(trace) {
  const t = trace && Array.isArray(trace.events) ? trace : emptyTrace();

  const submit = t.events.find((e) => e && e.kind === 'submit'
    && typeof e.draftLen === 'number' && typeof e.payloadLen === 'number'
    && e.draftLen - e.payloadLen >= LOSS_MIN_CHARS
    && e.payloadLen / e.draftLen <= 0.9);
  if (submit) {
    return { verdict: 'SEND_PATH', why:
      `the request carried ${submit.payloadLen} of ${submit.draftLen} characters — it was already short BEFORE it left the page`,
      evidence: submit };
  }

  const slow = t.events.find((e) => e && e.kind === 'response'
    && (e.status === 0 || (typeof e.ms === 'number' && e.ms >= SLOW_RESPONSE_MS)));
  if (slow) {
    const secs = Math.round((slow.ms || 0) / 1000);
    return { verdict: 'QUEUEING', why:
      `the payload left whole and the acknowledgement took ${secs}s (status ${slow.status}) — the data is fine, the WAIT is the defect`,
      evidence: slow };
  }

  const loss = detectLoss(t);
  if (!loss) return { verdict: 'NO_LOSS', why: 'no draft fell to a fragment, and nothing was truncated or stalled' };

  const near = hosts(t).filter((h) => Math.abs((h.t ?? 0) - loss.at) <= HOST_WINDOW_MS);
  if (!near.length) {
    // ⛔ THE HONEST ANSWER. Without host samples, COMPOSER and HOST_PRESSURE
    // are the same observation, and picking one would be a coin toss.
    return { verdict: 'UNKNOWN', why:
      `the draft fell ${loss.from} → ${loss.to} characters, but there are no host samples within ${HOST_WINDOW_MS / 1000}s: `
      + 'a stalled machine and a broken composer are indistinguishable from inside the page',
      evidence: loss };
  }

  const pressed = near.find((h) => (typeof h.freeMemMb === 'number' && h.freeMemMb < LOW_FREE_MEM_MB)
    || (typeof h.loadavg1 === 'number' && h.loadavg1 >= HIGH_LOADAVG));
  if (pressed) {
    return { verdict: 'HOST_PRESSURE', why:
      `the draft fell ${loss.from} → ${loss.to} while the host was under pressure `
      + `(free memory ${pressed.freeMemMb}MB, load ${pressed.loadavg1}) — the machine, not the page`,
      evidence: { loss, host: pressed } };
  }

  return { verdict: 'COMPOSER', why:
    `the draft fell ${loss.from} → ${loss.to} on a healthy host, and any payload sent left whole — the loss is in the page`,
    evidence: { loss, host: near.at(-1) } };
}

/** ⚠️ Storage hands back whatever it likes. A diagnostic must never be the thing that breaks the composer it watches. */
export function serialize(trace) {
  try { return JSON.stringify(trace && Array.isArray(trace.events) ? trace : emptyTrace()); }
  catch { return JSON.stringify(emptyTrace()); }
}

export function deserialize(raw) {
  if (typeof raw !== 'string' || !raw) return emptyTrace();
  let v;
  try { v = JSON.parse(raw); } catch { return emptyTrace(); }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.events)) return emptyTrace();
  return { events: v.events.filter((e) => e && typeof e === 'object'), dropped: Number(v.dropped) || 0 };
}
