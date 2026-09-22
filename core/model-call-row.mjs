/**
 * #1441 — the runner's ledger row → the board's POST /api/model-calls body.
 *
 * Moved out of scripts/guest-once.mjs so a test can import THE builder instead
 * of re-typing it. Three tests had each carried "the runner's rowToBoard,
 * reduced to the fields this test is about" — a hand copy cannot fail for a
 * field the real one drops, and three fields were being dropped (see below).
 * tests/model-call-row-seam-1441.test.mjs asserts the join generically.
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
  // "did the caching work pay off" is answerable only by a human logging into
  // the vendor's dashboard, once per change.
  cachedPromptTokens: row.usage?.cachedPromptTokens ?? null,
  cost: (agent.model?.costIn != null || agent.model?.costOut != null)
    ? ((row.usage?.promptTokens ?? 0) * (agent.model.costIn ?? 0) + (row.usage?.completionTokens ?? 0) * (agent.model.costOut ?? 0)) : 0,
  stopReason: row.stopReason ?? null, latencyMs: row.latencyMs, ok: row.ok, error: row.error ?? null,
  anomalies: row.anomalies ?? [],   // #1352
  contextHandedTo: row.contextHandedTo ?? [], producedPost: row.postId ?? null, at: row.at,
  // #1203 finding — the knobs that reproduce the call, and the resident's fields (#1226), ride the board row too.
  sampling: agent.model?.sampling ?? null, wake: row.wake ?? null, memory: row.memory ?? null, memoryWritten: row.memoryWritten ?? [], claims: row.claims ?? [],
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
  };
}
