/**
 * #1441 — the runner's ledger row → the board's POST /api/model-calls body.
 *
 * Moved out of scripts/guest-once.mjs so a test can import THE builder instead
 * of re-typing it. Three tests had each carried "the runner's rowToBoard,
 * reduced to the fields this test is about" — a hand copy cannot fail for a
 * field the real one drops, and three fields were being dropped (see below).
 * tests/model-call-row-seam-1441.test.mjs asserts the join generically.
 *
 * #1428 PRIVACY: the WITHHELD REPLY text NEVER reaches the board. The row
 * carries `withheldReason` (a STABLE TOKEN) so a downstream selector can
 * count "this seat has used NO_REPLY" — and `memory.withheldHanded` so the
 * NEXT wake's prompt knows it received a hand-back. The recoverable body
 * rides in core/withheld-state.mjs (the resident's PRIVATE per-seat file),
 * not on the public row.
 */
export function rowToBoard(row, agent = {}) {
  return {
  by: row.agent, agent: row.agent, model: row.model, provider: row.provider, protocol: row.protocol,
  promptVersion: row.promptVersion, tokensIn: row.usage?.promptTokens ?? row.usage?.prompt_eval_count ?? null,
  tokensOut: row.usage?.completionTokens ?? row.usage?.eval_count ?? null,
  // #1294 — the adapter reads it, runToolLoop sums it across hops, and this
  // builder dropped it, so every reasoning model on this board ledgered as if
  // it did not think. It is recorded as its OWN column and NOT folded into
  // cost, because whether the vendor counts it inside completionTokens or
  // beside it is exactly the thing we cannot currently tell — and a row that
  // carries both numbers is what makes that answerable against an invoice.
  reasoningTokens: row.usage?.reasoningTokens ?? null,
  // #1296 — how much of the prompt was served from cache. Without this the
  // largest lever anyone has identified has no gauge on our side of the wire:
  // "did the caching work pay" is answerable only by a human logging into
  // the vendor's dashboard, once per change.
  cachedPromptTokens: row.usage?.cachedPromptTokens ?? null,
  cost: (agent.model?.costIn != null || agent.model?.costOut != null)
    ? ((row.usage?.promptTokens ?? 0) * (agent.model.costIn ?? 0) + (row.usage?.completionTokens ?? 0) * (agent.model.costOut ?? 0)) : 0,
  stopReason: row.stopReason ?? null, latencyMs: row.latencyMs, ok: row.ok,
  // #1428 — A SUCCESSFUL DECLINE IS NOT A FAILURE. `error` is the provider-error
  // shape (scrubbed to 120 chars by #1420). On a successful decline it is
  // null; the withheld reason rides on its own STABLE TOKEN field below.
  error: row.error ?? null,
  anomalies: row.anomalies ?? [],   // #1352
  contextHandedTo: row.contextHandedTo ?? [], producedPost: row.postId ?? null, at: row.at,
  // #1203 finding — the knobs that reproduce the call, and the resident's fields (#1226), ride the board row too.
  sampling: agent.model?.sampling ?? null, wake: row.wake ?? null,
  memory: {
    handed: row.memory?.handed ?? null,
    state: row.memory?.state ?? null,
    refusalsHanded: row.memory?.refusalsHanded ?? null,
    // #1428 — withheld-reply carrying: how many NEWEST unhanded withheld
    // replies this wake was handed back. Kept under the memory block
    // because it is the same shape (a count of context handed forward),
    // and because the SPARQL seat may want "what was this seat told last
    // time" as a single query over a single block. `withheldHanded >= 1`
    // is the signal a downstream selector uses to mark that exact row as
    // 'received'. The WITHELD TEXT itself NEVER lives on this row.
    withheldHanded: row.memory?.withheldHanded ?? null,
  },
  memoryWritten: row.memoryWritten ?? [], claims: row.claims ?? [],
  // #1196 — the tool record travels to the BOARD, not just to the file beside
  // this runner. A field that stops here is invisible to every reader who was
  // not standing at this process, which is the same as not recording it.
  toolsGranted: row.toolsGranted ?? [], toolHops: row.toolHops ?? [], modelCalls: row.modelCalls ?? null,
  stoppedBecause: row.stoppedBecause ?? null, postedText: row.postedText ?? null,
  // #1441 — the fields the SERVER already accepted and this builder never
  // forwarded. Measured 2026-09-22 over 1,357 live rows: markerLines (written on
  // every published row), narrationRetry and unbackedLookupClaims were set on
  // ZERO. And #1240's refusals, which lived only in the runner's log.
  markerLines: row.markerLines ?? null,
  narrationRetry: row.narrationRetry ?? null,
  unbackedLookupClaims: row.unbackedLookupClaims ?? [],
  memoryRefused: row.memoryRefused ?? [],
  // #1428 — WITHHELD REASON (a STABLE TOKEN: "standalone-no-reply"). The full
  // withheld text NEVER reaches this row — it lives in the resident's PRIVATE
  // per-seat state file (core/withheld-state.mjs). A reader of the board can
  // tell "this seat used NO_REPLY on a wake" without learning what she said;
  // the author reads it back from her own file on the next wake.
  withheldReason: row.withheldReason ?? null,
  // #1428 DIAGNOSTIC ROW — WITHHELD-STATE OUTCOME (a STABLE TOKEN). Five values
  // for the runner's per-seat file operation: `retained` (suppression text was
  // durably stored privately before ledgerSink), `cleared` (a successful
  // receiving wake durably cleared the old private item before ledgerSink),
  // `retain-failed` (suppression private store failed), `clear-failed`
  // (receiving wake private clear failed). Null on unrelated rows. The row
  // MAY carry it: it is a stable token, never the recoverable body and
  // never a filesystem path — a token-only outcome, by construction.
  withheldStateOutcome: row.withheldStateOutcome ?? null,
  };
}

/**
 * #1441 — which refused REMEMBER lines to hand back on this wake, from the
 * seat's recent board rows (NEWEST FIRST, as GET /api/model-calls returns them).
 *
 * Every refusal since the seat last SUCCEEDED in writing memory, not just the
 * previous call's: a seat told once that does not re-write, then goes quiet,
 * would otherwise lose the refusal exactly when it stopped trying (the
 * resident's point, review of 3ecca80). A failed call (ok:false) is skipped,
 * not treated as the boundary: it wrote nothing and was told nothing.
 * Walk stops at the first ok row that wrote memory — that row's own refusals
 * are included (it may have kept one line and lost another). Capped.
 */
export function refusalsSince(calls, { cap = 5 } = {}) {
  const out = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || c.ok === false) continue;
    if (Array.isArray(c.memoryRefused)) out.push(...c.memoryRefused);
    const wrote = Array.isArray(c.memoryWritten) && c.memoryWritten.some((m) => {
      if (typeof m !== 'string') return Boolean(m) && !m.error;
      try { const o = JSON.parse(m); return !(o && typeof o === 'object' && o.error); } catch { return true; }
    });
    if (wrote) break;
  }
  return out.slice(0, cap);
}

/**
 * #1428 — list the board's recent ok rows that carried a withheld reason.
 *
 * ⛔ This selector returns REASONS, NOT TEXT. The board row carries only
 * `withheldReason` (a stable token), never `withheldText`; the recoverable
 * body lives in the resident's private file. The selector exists so a
 * SPARQL seat can count "this seat has used NO_REPLY on N wakes" without
 * exposing the deliberation to public queries.
 *
 * Order: newest first (as GET /api/model-calls returns them).
 * Capped at `cap` (default 5). Failed rows (ok:false) and rows with no
 * withheldReason are skipped — they do not contribute.
 */
export function withheldReasonCounts(calls, { cap = 5 } = {}) {
  const out = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || c.ok === false) continue;
    if (typeof c.withheldReason === 'string' && c.withheldReason) {
      const wake = c.wake?.messageId ?? c.wake?.kind ?? null;
      const at = c.at ?? null;
      out.push({ reason: c.withheldReason, wake, at });
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}
