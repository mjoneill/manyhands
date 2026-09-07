/**
 * #1255 slice 1 — the BROWSER half of the composer diagnostic.
 *
 * Two jobs, and the order matters:
 *
 *   1. NEVER LOSE THE DRAFT AGAIN. The textarea is mirrored to storage on every
 *      keystroke and restored on load. This is a FIX inside a diagnostic slice
 *      and that is deliberate: it is the one change that helps under all four
 *      hypotheses, so it should not wait for the diagnosis.
 *   2. Record what happened, so the next loss can be attributed instead of
 *      argued about — draft lengths, the submitted payload, the response
 *      timing, and host samples the page cannot otherwise see.
 *
 * ⛔ RULE FOR EVERYTHING IN HERE: the watcher must never be the reason the
 *    composer breaks. Every storage touch and every fetch is wrapped, and a
 *    failure degrades to "no diagnostic" rather than "no compose box".
 */
import { emptyTrace, appendEvent, detectLoss, classify, serialize, deserialize } from './composer-trace.mjs';

export const DRAFT_KEY = 'manyhands.composer.draft';
export const TRACE_KEY = 'manyhands.composer.trace';
/** Sample the host while there is something to lose, not all day. */
export const HOST_SAMPLE_MS = 5000;

const safeGet = (k) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private mode, quota — not our problem to solve */ } };
const safeDel = (k) => { try { window.localStorage.removeItem(k); } catch { /* ignore */ } };

export function loadTrace() { return deserialize(safeGet(TRACE_KEY)); }
export function saveTrace(tr) { safeSet(TRACE_KEY, serialize(tr)); }

/**
 * Attach to a textarea + form. Returns a handle so a test — or a curious
 * operator at the console — can read the verdict without touching internals.
 */
export function mountComposerWatch(doc, { textarea, form, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const ta = textarea || doc.getElementById('convs-body');
  if (!ta) return null;
  let trace = loadTrace();
  const record = (ev) => { trace = appendEvent(trace, { ...ev, t: ev.t ?? now() }); saveTrace(trace); };

  // 1 — RESTORE. A draft that survived a reload is the whole point; if the
  // box already has content (browser-restored), the stored draft yields to it.
  const saved = safeGet(DRAFT_KEY);
  if (saved && !ta.value) {
    ta.value = saved;
    record({ kind: 'restore', len: saved.length });
  }

  ta.addEventListener('input', () => {
    safeSet(DRAFT_KEY, ta.value);
    record({ kind: 'draft', len: ta.value.length });
  });

  // 2 — HOST SAMPLES, only while there is a draft to lose. This is the sample
  // that separates "the machine stalled" from "the composer dropped it"; with
  // no samples the verdict is UNKNOWN, which is the honest answer.
  let timer = null;
  const sample = async () => {
    if (!ta.value) return;
    try {
      const r = await fetchImpl('/api/host-pressure');
      if (!r.ok) return;
      const h = await r.json();
      record({ kind: 'host', freeMemMb: h.freeMemMb, loadavg1: h.loadavg1, rssMb: h.rssMb });
    } catch { /* the endpoint being unreachable is itself not worth breaking anything over */ }
  };
  timer = setInterval(sample, HOST_SAMPLE_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  const handle = {
    /** Take a host sample NOW. The interval calls this; a test can too — an
     *  assertion that awaits a method which does not exist passes forever. */
    sampleNow: sample,
    trace: () => trace,
    verdict: () => classify(trace),
    loss: () => detectLoss(trace),
    /** The submit seam: what the box held vs what the request actually carries. */
    noteSubmit: (draftLen, payloadLen) => record({ kind: 'submit', draftLen, payloadLen }),
    noteResponse: (status, ms) => record({ kind: 'response', status, ms }),
    /** ⛔ Called ONLY after a post is confirmed stored. A cleared box is not a saved one. */
    clearDraft: () => safeDel(DRAFT_KEY),
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    reset: () => { trace = emptyTrace(); saveTrace(trace); },
  };
  return handle;
}
