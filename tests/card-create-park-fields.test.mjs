/**
 * #830 (open half) — the park fields must be ABSENT from the create surface,
 * on all three lists at once.
 *
 * Measured before this change, by #831's audit:
 *
 *   parkedBy / parkedUntil / parkedReason on POST /api/cards
 *     declares : NO   (reported in ignoredFields)
 *     accepts  : YES  (validateCardFields enforces the pairing + the formats)
 *     reads    : NO   (createCardFromPayload never assigns them)
 *
 * ⇒ VALIDATED_THEN_DISCARDED, and worse than a plain silent drop: the route
 *   ADMITS it ignores the field AND refuses malformed values for it, in the
 *   same request. A caller who reads `ignoredFields` and a caller who trusts
 *   the 400 get opposite answers out of one write.
 *
 * ⚠️ WHY "REMOVE FROM CREATE" RATHER THAN "CONSUME AT CREATE".
 * Consuming it invents a born-parked state machine: a card that has never been
 * available, parked by someone at the moment of its own creation, with an
 * expiry it was born holding. Nobody asked for that object. A park is a
 * deferral of work that EXISTS — so PATCH is its surface, and #831's sweep
 * confirms the park trio is AGREE_SUPPORTED there today.
 *
 * ⚠️ AND WHY BOTH LISTS IN ONE CHANGE. Dropping only the schema leaves the
 * field unadvertised, still validated, and still discarded — strictly the
 * worst of the three states, because the 400 still teaches a caller the field
 * is supported while nothing advertises it. Schema and validator move together
 * or not at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const FUTURE = '2026-12-01T00:00:00.000Z';

async function createCard(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'park probe', createdBy: 'ada', ...body }),
  });
  return { status: res.status, body: await res.json() };
}

async function patchCard(baseUrl, shortId, body) {
  const res = await fetch(`${baseUrl}/api/cards/${shortId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'ada', ...body }),
  });
  return { status: res.status, body: await res.json() };
}

test('#830 create no longer VALIDATES the park fields', async () => {
  const server = await startRestServer();
  try {
    // Each of these used to return 400. A validator on a field the route
    // discards is a false-signal generator.
    const pairRule = await createCard(server.baseUrl, { parkedBy: 'ada' });   // half a park
    assert.equal(pairRule.status, 201, 'the pairing rule must not fire on create');

    const badParker = await createCard(server.baseUrl, { parkedBy: 'not a key!!', parkedUntil: FUTURE });
    assert.equal(badParker.status, 201, 'no parkedBy format rule on create');

    const badDate = await createCard(server.baseUrl, { parkedBy: 'ada', parkedUntil: 'not-a-date' });
    assert.equal(badDate.status, 201, 'no parkedUntil format rule on create');

    const badReason = await createCard(server.baseUrl, {
      parkedBy: 'ada', parkedUntil: FUTURE, parkedReason: 12345,
    });
    assert.equal(badReason.status, 201, 'no parkedReason type rule on create');

    // CONTROL: the card was really created, so 201 is not a broken probe.
    assert.equal(badReason.body.title, 'park probe');
  } finally {
    await server.stop();
  }
});

test('#830 create REPORTS the park fields as ignored, and stores nothing', async () => {
  const server = await startRestServer();
  try {
    const r = await createCard(server.baseUrl, {
      parkedBy: 'ada', parkedUntil: FUTURE, parkedReason: 'because',
    });
    assert.equal(r.status, 201);
    assert.deepEqual(
      [...(r.body.ignoredFields ?? [])].sort(),
      ['parkedBy', 'parkedReason', 'parkedUntil'],
      'all three must be named as ignored — silence here would be the #823 defect',
    );

    // And the drop itself is unchanged: this reports, it does not rescue.
    const fresh = await (await fetch(`${server.baseUrl}/api/cards/${r.body.shortId}`)).json();
    for (const f of ['parkedBy', 'parkedUntil', 'parkedReason']) {
      assert.equal(fresh[f], undefined, `${f} must not be stored by create`);
    }
  } finally {
    await server.stop();
  }
});

test('#830 PATCH is still the parking surface, with its rules intact', async () => {
  // The anti-overreach control. It would be easy to remove the park rules
  // globally and call the disagreement fixed — that "fix" would delete a
  // working feature. The rules must survive exactly where the field is real.
  const server = await startRestServer();
  try {
    const c = await createCard(server.baseUrl, {});

    const half = await patchCard(server.baseUrl, c.body.shortId, { parkedBy: 'ada' });
    assert.equal(half.status, 400, 'the pairing rule MUST still fire on PATCH');
    assert.match(half.body.error, /must be set together/);

    const bad = await patchCard(server.baseUrl, c.body.shortId, { parkedBy: 'ada', parkedUntil: 'nope' });
    assert.equal(bad.status, 400, 'the timestamp rule MUST still fire on PATCH');

    const ok = await patchCard(server.baseUrl, c.body.shortId, { parkedBy: 'ada', parkedUntil: FUTURE });
    assert.equal(ok.status, 200);
    const fresh = await (await fetch(`${server.baseUrl}/api/cards/${c.body.shortId}`)).json();
    assert.equal(fresh.parkedBy, 'ada', 'PATCH still parks');
    assert.equal(fresh.parkedUntil, FUTURE);
  } finally {
    await server.stop();
  }
});

test('#830 a clean create still reports nothing ignored', async () => {
  // Guards against the opposite failure: a route that now names fields nobody
  // sent, or that reports an empty array where it used to report nothing.
  const server = await startRestServer();
  try {
    const r = await createCard(server.baseUrl, { description: 'real' });
    assert.equal(r.status, 201);
    assert.ok(
      r.body.ignoredFields === undefined || r.body.ignoredFields.length === 0,
      `a clean create must claim nothing — got ${JSON.stringify(r.body.ignoredFields)}`,
    );
  } finally {
    await server.stop();
  }
});
