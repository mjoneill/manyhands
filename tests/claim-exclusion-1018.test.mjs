/**
 * #1018 acceptance 2 — THE NEGATIVE CONTROL. Exclusion is DEMONSTRATED here,
 * not inferred from the fact that a claim verb exists.
 *
 * The card marks this condition, in its own words, as "THE HALF THAT CAN FAIL",
 * and it says why it is not hypothetical: #755 shipped a bid/grant gate on
 * 2026-08-10 and MEASURED the same day that "the gate refuses only the
 * declarer's own actions and never reads `required`, so v1 cannot refuse a
 * second seat and does not reach that goal at any level of compliance."
 *
 * A verb that exists, is called correctly, returns 200, and refuses nobody
 * passes every does-it-exist test ever written about it. So:
 *
 *   ⛔ "card_claim is a compare-and-set under withWriteLock, therefore it
 *      excludes" is an ARGUMENT. #755's v1 had an equally good argument.
 *   ✅ N racers, one winner, N-1 refusals naming that winner, is a MEASUREMENT.
 *
 * The card also records that #1019 (a `reference` card used as an operations
 * lock for the gateway) has >= 7 perfectly-paired claim/release cycles in
 * production — real usage, zero collisions, and still no demonstration, because
 * nothing in that history ever had two seats claim at the same instant. Usage
 * without contention cannot show exclusion; only contention can.
 *
 * These tests run against a REAL server over HTTP, because the property under
 * test is a property of the server's write lock, and a unit test of the
 * handler's body would assume away the thing being measured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const CLAIMANTS = ['ada', 'grace', 'hopper', 'lovelace', 'noether', 'curie', 'franklin', 'meitner'];

async function withServer(fn) {
  const rest = await startRestServer({});
  try {
    return await fn(rest);
  } finally {
    await rest.stop();
  }
}

const post = (baseUrl, route, body) =>
  fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function makeCard(rest, title = 'a contested resource') {
  const res = await post(rest.baseUrl, '/api/cards', { title, by: 'ada', column: 'backlog' });
  assert.equal(res.status, 201, 'fixture card must be created');
  return (await res.json()).shortId;
}

/** Fire every claim without awaiting any of them: the requests overlap in flight. */
const raceClaims = (rest, id, claimants) =>
  Promise.all(claimants.map(async (by) => {
    const res = await post(rest.baseUrl, `/api/cards/${id}/claim`, { by });
    return { by, status: res.status, body: await res.json() };
  }));

test('#1018 ⭐ NEGATIVE CONTROL — 8 simultaneous claims, EXACTLY ONE succeeds', async () => {
  await withServer(async (rest) => {
    const id = await makeCard(rest);
    const results = await raceClaims(rest, id, CLAIMANTS);

    const winners = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 409);

    assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}: ${winners.map((w) => w.by).join(',')}`);
    assert.equal(refused.length, CLAIMANTS.length - 1, 'every other claimant is refused');
    assert.equal(winners.length + refused.length, CLAIMANTS.length, 'no claim returned anything else');
  });
});

test('#1018 — every refusal NAMES the holder, and it is the seat that actually won', async () => {
  // A 409 that does not say who holds it leaves the loser unable to yield to
  // anyone in particular, which is the difference between an error and a
  // coordination primitive.
  await withServer(async (rest) => {
    const id = await makeCard(rest);
    const results = await raceClaims(rest, id, CLAIMANTS);
    const winner = results.find((r) => r.status === 200);
    const refused = results.filter((x) => x.status === 409);

    // Guard the population before looping over it. Mutation-tested: with the
    // compare-and-set removed there are NO refusals, and a for-loop over an
    // empty list passes while asserting nothing. An assertion whose subject can
    // vanish must first assert that its subject exists.
    assert.equal(refused.length, CLAIMANTS.length - 1, 'there must BE refusals for this test to mean anything');
    assert.ok(winner, 'and a winner for them to name');

    for (const r of refused) {
      assert.equal(r.body.claimed, false, `${r.by} must be told it did not claim`);
      assert.equal(r.body.holder, winner.by, `${r.by} must be told WHO holds it`);
      assert.ok(r.body.claimedAt, 'and since when');
    }
  });
});

test('#1018 ⛔ THE STATE, not just the responses — the board agrees with the winner', async () => {
  // The responses could all be correct while the stored card records someone
  // else, or nobody. A winner that is not the holder is a lock that reports
  // success and protects nothing.
  await withServer(async (rest) => {
    const id = await makeCard(rest);
    const results = await raceClaims(rest, id, CLAIMANTS);
    const winner = results.find((r) => r.status === 200);

    const card = await (await fetch(`${rest.baseUrl}/api/cards/${id}`)).json();
    assert.equal(card.claimedBy, winner.by, 'the stored holder is the seat that got the 200');
    assert.equal(card.claimedAt, winner.body.claimedAt, 'and the timestamp it was told');
  });
});

test('#1018 ⛔ A REFUSED CLAIM MUST NOT WRITE — the losers leave no trace', async () => {
  // #1018's incidents are about a second actor CHANGING something after being
  // too late. A 409 that still bumped the version or stamped the card would be
  // exactly that failure wearing a refusal's clothes.
  await withServer(async (rest) => {
    const id = await makeCard(rest);
    await post(rest.baseUrl, `/api/cards/${id}/claim`, { by: 'ada' });
    const afterFirst = await (await fetch(`${rest.baseUrl}/api/cards/${id}`)).json();

    for (const by of ['grace', 'hopper', 'lovelace']) {
      const res = await post(rest.baseUrl, `/api/cards/${id}/claim`, { by });
      assert.equal(res.status, 409);
    }

    const afterRefusals = await (await fetch(`${rest.baseUrl}/api/cards/${id}`)).json();
    assert.equal(afterRefusals.version, afterFirst.version, 'a refusal must not bump the version');
    assert.equal(afterRefusals.updatedAt, afterFirst.updatedAt, 'nor restamp the card');
    assert.equal(afterRefusals.claimedBy, 'ada', 'nor move the claim');
    assert.equal(afterRefusals.claimedAt, afterFirst.claimedAt, 'nor the claim time');
  });
});

test('#1018 — the race repeats: 5 rounds, one winner each, no round with two or zero', async () => {
  // One race passing could be one scheduling accident. The property has to hold
  // every time or it is not a property.
  await withServer(async (rest) => {
    const outcomes = [];
    for (let round = 0; round < 5; round++) {
      const id = await makeCard(rest, `contested ${round}`);
      const results = await raceClaims(rest, id, CLAIMANTS);
      outcomes.push(results.filter((r) => r.status === 200).length);
    }
    assert.deepEqual(outcomes, [1, 1, 1, 1, 1], `every round must have exactly one winner, got ${outcomes.join(',')}`);
  });
});

test('#1018 ⛔ THE CONTROL ON THE CONTROL — claims on DIFFERENT cards must all succeed', async () => {
  // Without this, a server that refused every claim after the first — for any
  // reason, including a bug that ignores which card is being claimed — would
  // pass every test above. "Exactly one winner" must come from contention on
  // ONE resource, not from a lock that is simply too broad.
  await withServer(async (rest) => {
    const ids = [];
    for (let i = 0; i < CLAIMANTS.length; i++) ids.push(await makeCard(rest, `uncontested ${i}`));

    const results = await Promise.all(ids.map(async (id, i) => {
      const res = await post(rest.baseUrl, `/api/cards/${id}/claim`, { by: CLAIMANTS[i] });
      return res.status;
    }));

    assert.deepEqual(results, results.map(() => 200), 'eight claims on eight cards are eight winners');
  });
});

test('#1018 — release makes the resource claimable again, by someone else', async () => {
  // An operations lock that cannot be handed over is a lock that gets abandoned
  // and then routed around, which is how a convention stops being used.
  await withServer(async (rest) => {
    const id = await makeCard(rest);
    assert.equal((await post(rest.baseUrl, `/api/cards/${id}/claim`, { by: 'ada' })).status, 200);
    assert.equal((await post(rest.baseUrl, `/api/cards/${id}/claim`, { by: 'grace' })).status, 409);

    const rel = await fetch(`${rest.baseUrl}/api/cards/${id}/claim`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'ada' }),
    });
    assert.equal(rel.status, 200, 'the holder can release');

    assert.equal((await post(rest.baseUrl, `/api/cards/${id}/claim`, { by: 'grace' })).status, 200,
      'and the next seat can then take it');
  });
});

test('#1018 — a race to RE-claim after a release also yields exactly one winner', async () => {
  // The handover is the moment two waiting seats are most likely to collide,
  // and it is the one the production usage on #1019 has never exercised under
  // contention.
  await withServer(async (rest) => {
    const id = await makeCard(rest);
    await post(rest.baseUrl, `/api/cards/${id}/claim`, { by: 'ada' });
    await fetch(`${rest.baseUrl}/api/cards/${id}/claim`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'ada' }),
    });

    const results = await raceClaims(rest, id, CLAIMANTS.filter((c) => c !== 'ada'));
    assert.equal(results.filter((r) => r.status === 200).length, 1, 'exactly one winner on the re-claim');
  });
});
