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
/**
 * #1366 — one draft PER (surface, target). The #1255 mount kept one key for
 * one box; every other composer stood alone. A key like `card:<id>`,
 * `edit:<id>`, `wiki:<id>`, `retreat:<id>` or `commons` gives each box its
 * own slot, so returning to the same target restores the same draft and two
 * boxes on one page never trade texts. No key ⇒ the #1255 key, unchanged.
 * A key that already looks like a full storage key (contains a dot) is used
 * verbatim — that is how the retreat's pre-#1366 drafts keep restoring.
 */
export function draftKeyFor(key) {
  if (!key) return DRAFT_KEY;
  return key.includes('.') ? key : `${DRAFT_KEY}.${key}`;
}
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
export function mountComposerWatch(doc, { textarea, form, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), key = null, base = null, sample: doSample = true } = {}) {
  const ta = textarea || doc.getElementById('convs-body');
  if (!ta) return null;
  const KEY = draftKeyFor(key);
  let trace = loadTrace();
  const record = (ev) => { trace = appendEvent(trace, { ...ev, t: ev.t ?? now() }); saveTrace(trace); };

  // 1 — RESTORE. A draft that survived a reload is the whole point.
  //
  // Two shapes (#1366):
  //   no base  — a composer that starts EMPTY (a post, a comment, a new card).
  //              If the box already has content (browser-restored), the stored
  //              draft yields to it: never clobber what the operator can see.
  //   base     — a composer PREFILLED with the server's text (an edit). The
  //              draft is stored beside the base it was written on and restores
  //              ONLY over that same base; against a newer base it is DROPPED,
  //              because restoring it would silently overwrite someone else's
  //              edit — #466's lost update, in a textarea. The prefill is not
  //              the operator's text, so it does not win the way a browser-
  //              restored box does.
  const hasBase = typeof base === 'string';
  const readDraft = () => {
    const raw = safeGet(KEY);
    if (raw == null) return null;
    if (!hasBase) return raw;
    try { const o = JSON.parse(raw); return (o && typeof o === 'object' && o.base === base) ? String(o.text ?? '') : null; } catch { return null; }
  };
  const writeDraft = (text) => safeSet(KEY, hasBase ? JSON.stringify({ base, text }) : text);
  // A box no longer in the document cannot lose anything: a form that was
  // saved and re-rendered leaves its old textarea detached with the text
  // still in it, and the leaving guard must not ask about a ghost. (Found by
  // #1365's served test: a successful pop-out save was followed by a spurious
  // beforeunload on the next navigation.)
  const isDirty = () => (ta.isConnected === false ? false : (hasBase ? ta.value !== base : ta.value.length > 0));

  const saved = readDraft();
  if (saved != null && (hasBase ? saved !== base : (saved && !ta.value))) {
    ta.value = saved;
    record({ kind: 'restore', len: saved.length });
  } else if (hasBase && safeGet(KEY) != null && saved == null) {
    safeDel(KEY); // written on a base that no longer exists: drop it, don't ambush the next open
  }

  ta.addEventListener('input', () => {
    if (isDirty()) writeDraft(ta.value); else safeDel(KEY);
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
  // #1366 — one page now carries several composers; the host sampler is the
  // diagnostic's, and one sampler per page is plenty. Secondary mounts pass
  // sample:false.
  if (doSample) {
    timer = setInterval(sample, HOST_SAMPLE_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

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
    clearDraft: () => safeDel(KEY),
    /** #1366 — is there something in this box the operator would lose? */
    isDirty,
    key: KEY,
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    reset: () => { trace = emptyTrace(); saveTrace(trace); },
  };
  return handle;
}
