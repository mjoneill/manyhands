/**
 * #1624 (review 08:45Z) — ONE write whose outcome is never guessed. The intention is kept as sent; an UNKNOWN first
 * answer (the request may have landed) is reconciled by its receipt, and ONLY an ABSENT receipt is replayed, with the
 * SAME opId and the SAME intention (a fresh opId could land a second write). Reloading a cache does not answer "did
 * THIS request commit?"; the receipt does. Returns the client's outcome object: APPLIED, PRECONDITION_FAILED, REJECTED,
 * UNAVAILABLE (nothing was sent), RECONCILE_REQUIRED, or UNKNOWN (still undetermined after reconciling).
 */
export async function durableUpdate(client, intention) {
  let r = await client.update(intention);
  if (r.outcome !== 'UNKNOWN') return r;
  const rc = await client.reconcile(intention);
  if (rc.outcome === 'ABSENT') return client.update(intention);
  return rc;
}
