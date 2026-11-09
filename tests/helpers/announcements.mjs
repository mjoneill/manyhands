/**
 * #1845 — ONE shared way to observe a board announcement in a unit-on test (lifted from #1721's agents-graph-a1 helpers).
 *
 * WHY: with the conversations unit on, an announcement (a claim, a rest, a nudge) is a publisher-mode OBLIGATION committed in the
 * originating write, and its post is published AFTER the answer, un-awaited (#1574 1b: a down executor never costs the write). A test
 * that counts posts right after the 200 races that inline publish and sees 0 now and then. #1721 fixed that for ONE file; the helpers
 * stayed inside it, so the next file (cards-graph-c1, #1845) flaked the same way.
 *
 * THE CONTRACT (#1845, from the review on the card): the 200 promises the OBLIGATION, not the post. So a row asserts exactly ONE obligation at the 200
 * (pending or published, never blocked, postSeq and publicationAt fixed in that write, the frozen body naming what it should), THEN
 * drives publication through the idempotent verb, THEN counts posts. The two halves are exported separately on purpose: a helper that
 * only "settles whatever is pending" passes when the obligation was never written, which is the defect these rows exist to catch.
 *
 * Unit OFF: there is no publisher obligation (the post is written in the same document write). The CALLER skips the obligation half and
 * counts posts directly. That choice is not hidden in here.
 */
import assert from 'node:assert/strict';

async function call(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

/** The outbox entries `match(entry)` selects, as the outbox stores them (read under the write lock, so never across a write). */
export async function obligations(base, match) {
  const r = await call(base, 'GET', '/api/outbox');
  assert.equal(r.status, 200, `the outbox is readable (${r.status} ${r.text.slice(0, 120)})`);
  return (r.body?.entries ?? []).filter((e) => match(e));
}

/** Entries whose frozen body contains `needle`. ⚠️ A substring: "claimed #1" also selects "claimed #12". For a card, use mentionsCard. */
export const bodyIncludes = (needle) => (e) => String(e?.payload?.body ?? '').includes(needle);

/**
 * #1845 slice 2 — a text test for "<phrase> #<sid>" that names ONE card: the number ends where no digit follows, so #1 never selects
 * #12 or #10. The phrase is literal text, not a pattern. Use it for posts (`.filter((p) => mentionsCard('claimed', 1)(p.body))`) and,
 * through bodyMatches, for outbox entries.
 */
export function mentionsCard(phrase, sid) {
  const rx = new RegExp(`${String(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} #${Number(sid)}(?!\\d)`);
  return (text) => rx.test(String(text ?? ''));
}

/** Outbox entries whose frozen body passes `textTest` (e.g. mentionsCard('claimed', 12)). */
export const bodyMatches = (textTest) => (e) => textTest(e?.payload?.body);

/**
 * The obligation the 200 promised: exactly ONE publisher entry, pending or published (never blocked), sequenced in the same write,
 * its frozen body naming every string in `names`. Returns it.
 */
export async function assertOneObligation(base, match, { names = [] } = {}, label = 'at the 200') {
  const obs = await obligations(base, match);
  assert.equal(obs.length, 1, `${label}: exactly ONE obligation (${JSON.stringify(obs.map((e) => [e.slot, e.status]))})`);
  const [ob] = obs;
  assert.equal(ob.mode, 'publisher', `${label}: a publisher obligation (the post is written after the answer)`);
  assert.ok(['pending', 'published'].includes(ob.status), `${label}: pending or published, never ${ob.status} (${ob.reason ?? ''})`);
  assert.ok(Number.isSafeInteger(ob.postSeq) && ob.postSeq > 0, `${label}: its postSeq is reserved in the same write (${JSON.stringify(ob.postSeq)})`);
  assert.equal(typeof ob.publicationAt, 'string', `${label}: its publicationAt is fixed in the same write`);
  for (const n of names) assert.ok(String(ob.payload?.body ?? '').includes(n), `${label}: the frozen body names ${n}`);
  return ob;
}

/** Drive publication through the idempotent verb; bounded, and ends on the verb's own answer, not on a clock. */
export async function publishNow(base, obligationId, label = 'publish') {
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await call(base, 'POST', `/api/outbox/${encodeURIComponent(obligationId)}/publish`, {});
    assert.equal(last.status, 200, `${label}: the publish verb answers (${last.status} ${last.text.slice(0, 160)})`);
    if (last.body?.status !== 'pending') break;
  }
  assert.equal(last.body?.status, 'published', `${label}: publication completes when driven (${last.text.slice(0, 160)})`);
  return last.body;
}

/** Assert ONE obligation, then publish it. Returns { obligation, published }. Unit-on only: see the header. */
export async function settleOne(base, match, opts = {}, label = 'settle') {
  const obligation = await assertOneObligation(base, match, opts, label);
  const published = await publishNow(base, obligation.obligationId, label);
  return { obligation, published };
}
