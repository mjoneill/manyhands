/**
 * #1624 (review 08:45Z) — ONE write whose outcome is never guessed. The intention is kept as sent; an UNKNOWN first
 * answer (the request may have landed) is reconciled by its receipt, and ONLY an ABSENT receipt is replayed, with the
 * SAME opId and the SAME intention (a fresh opId could land a second write). Reloading a cache does not answer "did
 * THIS request commit?"; the receipt does. Returns the client's outcome object: APPLIED, PRECONDITION_FAILED, REJECTED,
 * UNAVAILABLE (nothing was sent), RECONCILE_REQUIRED, or UNKNOWN (still undetermined after reconciling).
 */
// #1762 S1 (review) — with native history ON, a card or collection write that carries NO history is refused before it is
// sent: a path that forgot to compute it would otherwise commit changes no history records. Named migrations are exempt
// (an import or backfill is history being brought in, not a change being made).
const HISTORY_EXEMPT_OPS = [/^urn:ex:op\/collection\/import\//, /^urn:ex:op\/cutover\//, /^urn:ex:op\/backfill\//, /^urn:ex:op\/migrate-/];
export function lacksRequiredHistory(i, on = process.env.SCRUM_HISTORY_NATIVE === '1') {
  if (!on || !i || typeof i.opId !== 'string' || HISTORY_EXEMPT_OPS.some((re) => re.test(i.opId))) return false;
  const parts = i.kind === 'card.write' ? [...(i.parts || []), ...(i.collections || [])]
    : i.kind === 'entity.put' && i.entity?.kind === 'collection' ? (i.entity.parts || []) : [];
  return parts.some((p) => !p || !p.history);
}

export async function durableUpdate(client, intention) {
  if (lacksRequiredHistory(intention)) return { outcome: 'REJECTED', reason: `HISTORY_REQUIRED: native history is on (SCRUM_HISTORY_NATIVE=1) and this ${intention.kind} (${intention.opId}) carries none; nothing was sent` };
  let r = await client.update(intention);
  if (r.outcome !== 'UNKNOWN') return r;
  const rc = await client.reconcile(intention);
  if (rc.outcome === 'ABSENT') return client.update(intention);
  return rc;
}
