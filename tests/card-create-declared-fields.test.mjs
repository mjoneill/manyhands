/**
 * #830 — card_create advertises four fields REST create could not store.
 *
 * `parkedBy · parkedUntil · parkedReason · implementedBy` are declared
 * parameters on the MCP card_create tool, with descriptions, and are accepted
 * by validateCardFields at create — then dropped by createCardFromPayload,
 * which never read them. PATCH stored them the whole time. Same names, same
 * resource, two routes, two meanings.
 *
 * Self-inflicted: 235a0d9 (parked) and fbbbc31 (implementedBy) each added the
 * fields to the schema AND to PATCHABLE_CARD_FIELDS without wiring create.
 *
 * It slipped both of the night's guards by being KNOWN: #823 refuses unknown
 * keys (these are declared, so it accepts them); #829 reports dropped keys (it
 * did report them — and the write still evaporated). A declared-and-dropped
 * field is worse than an absent one, because the tool schema is the only
 * documentation and it reads as supported.
 *
 * Every assertion reads back from a FRESH GET: the 201 is not the evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

function apiTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer();
    try { await fn(server); } finally { await server.stop(); }
  });
}

const post = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, card: await res.json() };
};
const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

const SHA = 'a75a2476fde51792f3566ea2e6d00df512498bc4';

apiTest('#830 implementedBy is stored at create, not discarded', async ({ baseUrl }) => {
  const { res, card } = await post(baseUrl, {
    title: 'retroactive card', createdBy: 'ada', implementedBy: [SHA],
  });
  assert.equal(res.status, 201);
  assert.equal(card.title, 'retroactive card');            // control
  const stored = await get(baseUrl, card.shortId);          // the evidence
  assert.deepEqual(stored.implementedBy, [SHA]);
  assert.ok(
    card.ignoredFields === undefined || !card.ignoredFields.includes('implementedBy'),
    'a consumed field must not be reported as ignored',
  );
});

// ── ⚠️ THE PARKED HALF IS NOT BUILT HERE. These assert CURRENT behaviour,
//    and current behaviour is WRONG — recorded so the fix has a baseline.
//
//    There are THREE lists that disagree, not two:
//      1 MCP card_create schema   advertises parkedBy/parkedUntil/parkedReason
//      2 validateCardFields       VALIDATES them on create (shared with patch)
//      3 createCardFromPayload    consumes NONE of them
//
//    Dropping them from the schema alone leaves them un-advertised, still
//    validated, still discarded — the worst of the three states.
//
//    ✅ RESOLVED. The open half of #830 shipped: validateCardFields takes a
//    `surface` option and does not apply the park rules on create, and the MCP
//    card_create schema no longer advertises them. All three lists now agree at
//    ABSENT on create, while PATCH — where the field is genuinely consumed —
//    keeps every rule. The assertions below were rewritten from documenting the
//    defect to asserting the fix; the ORIGINAL expectations are preserved in
//    each comment so the change of intent is legible rather than silent.
//
//    ⭐ INVARIANT for that work: no field may be VALIDATED on a surface that
//    does not CONSUME it. A validator running on a discarded field is a false
//    signal generator — it teaches the caller the domain rule, then drops the
//    corrected input.

apiTest('#830 a park sent to create is reported and dropped, and NOT validated', async ({ baseUrl }) => {
  // WAS: '[current, wrong] a well-formed park is validated then discarded'.
  // The drop is unchanged and correct — create is not the parking surface.
  // What changed is that it is no longer VALIDATED on the way to being dropped.
  const { res, card } = await post(baseUrl, {
    title: 'deferred at birth', parkedBy: 'ada',
    parkedUntil: '2026-09-16T00:00:00.000Z', parkedReason: 'waiting',
  });
  assert.equal(res.status, 201);
  assert.equal(card.title, 'deferred at birth');   // control
  const stored = await get(baseUrl, card.shortId);
  assert.equal(stored.parkedBy, undefined, 'create does not consume a park');
  assert.deepEqual([...card.ignoredFields].sort(), ['parkedBy', 'parkedReason', 'parkedUntil'],
    'all three reported — a silent drop here would be the #823 defect');
});

// ── The park validators belong to PATCH ONLY ────────────────────────────
//
// ⚠️ THESE TWO ASSERTED 400 UNTIL #830's OPEN HALF SHIPPED, and that
// expectation was the defect wearing a test's clothes: it demanded a validator
// on a surface that discards the field. The rule "no field may be VALIDATED on
// a surface that does not CONSUME it" applies to the test suite too — a test
// can pin a false-signal generator in place just as firmly as code can.

apiTest('#830 a half-park is ACCEPTED at create — the rule lives on PATCH', async ({ baseUrl }) => {
  const { res, card } = await post(baseUrl, { title: 'permanent by forgetting', parkedBy: 'ada' });
  assert.equal(res.status, 201, 'create does not adjudicate parks; it reports and drops');
  assert.deepEqual(card.ignoredFields, ['parkedBy']);
});

apiTest('#830 an orphan expiry is ACCEPTED at create, and REFUSED on PATCH', async ({ baseUrl }) => {
  // Paired on purpose: the rule did not disappear, it moved to the surface
  // that actually stores the field. Deleting a validator and calling the
  // disagreement fixed would delete a working feature.
  const { res, card } = await post(baseUrl, {
    title: 'orphan expiry', parkedUntil: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(card.ignoredFields, ['parkedUntil']);

  const patched = await fetch(`${baseUrl}/api/cards/${card.shortId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'ada', parkedUntil: '2026-09-16T00:00:00.000Z' }),
  });
  assert.equal(patched.status, 400, 'the pairing rule is alive where the field is real');
});

apiTest('#830 a short sha is REFUSED at create', async ({ baseUrl }) => {
  const { res } = await post(baseUrl, { title: 'abbrev', implementedBy: ['a75a247'] });
  assert.equal(res.status, 400, 'the graph cannot expand an abbreviation');
});

// ── The #829 reporter must stay honest around the change ────────────────

apiTest('#830 a genuinely unknown key is still reported', async ({ baseUrl }) => {
  const { res, card } = await post(baseUrl, {
    title: 'mixed', implementedBy: [SHA], bogusField: 1,
  });
  assert.equal(res.status, 201);
  assert.deepEqual(card.ignoredFields, ['bogusField']);
});

apiTest('#254 supersedes #830 here: `parent` is now CONSUMED at create, and a malformed one is REFUSED', async ({ baseUrl }) => {
  // ⚠️ THIS TEST'S EXPECTATION WAS DELIBERATELY REVERSED, so the reversal is
  // recorded rather than discovered later.
  //
  // #830's version asserted `parent` stays ignored at create, and its stated
  // reason was SCOPE — "this card fixes the four that are declared, not
  // everything adjacent to them." That was a boundary on #830's work, not a
  // finding that create must never nest. #254 is the card that moves the
  // boundary: an MCP seat could not nest a page at all, which is why the
  // DigiCol hierarchy had to be built by curling REST.
  //
  // ⭐ AND THIS TEST EARNED ITS KEEP ON THE WAY PAST. When create began
  // consuming `parent`, the consume step took only strings — so `parent: 42`
  // was dropped AND, having just joined CREATE_CONSUMED_FIELDS, no longer
  // appeared in ignoredFields. Silently discarded on both channels at once.
  // The refusal below is the fix; the old assertion is what found it.
  const bad = await post(baseUrl, { title: 'p', parent: 42 });
  assert.equal(bad.res.status, 400, 'a non-string parent must be refused, not coerced or dropped');

  const parent = await post(baseUrl, { title: 'the epic' });
  const { res, card } = await post(baseUrl, { title: 'nested', parent: parent.card.id });
  assert.equal(res.status, 201);
  assert.equal(card.parent, parent.card.id, 'and a well-formed parent is STORED');
  assert.equal(card.ignoredFields, undefined, 'a consumed field is not reported as ignored (#831)');
});
