/**
 * #856 — A REDIRECT IS NOT A REFUSAL, AND SILENCE IS NOT AN ANSWER.
 *
 * ⚠️ THE SILENCE THIS CLOSES WAS DELIBERATE, AND THE REASON IT WAS DELIBERATE
 * IS THE HARDEST CONSTRAINT ON THE FIX.
 *
 * `READ_PROJECTION_FIELDS` was introduced by #844 with a documented rationale:
 *
 *   "They are projections, not card fields, and reporting them turns every
 *    read-modify-write noisy."
 *
 * That objection is correct. A well-behaved client does GET -> change one field
 * -> PATCH the whole object, and the object it got back CONTAINS `comments`,
 * because GET emits it. So a naive "report every projection" rule fires on every
 * correct RMW cycle — which is the always-fires rule #844 exists to prevent,
 * reproduced inside the diagnostic built to prevent it.
 *
 * ⇒ THE FIX IS THE COMPARAND, NOT THE RULE. #844 could not see these fields
 *   because `isEchoOfStored` compares against `card.comments`, which is
 *   undefined. The route BUILDS the projection; it knows the emitted value.
 *
 *     submitted deep-equals the projection  -> SILENT.    an RMW echo.
 *     submitted differs                     -> REDIRECTED. a real attempt.
 *
 * ⭐ AND THE ANSWER IS A DESTINATION, NOT A NAME. `ignoredFields` and
 * `refusedFields` are bare lists because the key IS the whole message — there
 * is nothing to add to "I did not recognise `foo`". Here there is: the caller
 * CAN do what they tried, through a different door. A caller who sends
 * `comments` and gets back `["comments"]` learns exactly what they already knew.
 * A redirect that does not name the destination is a 404 wearing a signpost.
 *
 * ⛔ WHY NOT `refusedFields`: the discriminator is not "how real is the key",
 * it is WHETHER THE CALLER HAS ANYWHERE ELSE TO GO.
 *     id        REFUSED     you may not do this. There is no other door.
 *     comments  REDIRECTED  you CAN do this. Different door.
 *   Folding a redirect into `refusedFields` tells a caller to STOP when the
 *   true answer is TURN LEFT — actionable and wrong, which is worse than silent.
 *
 * ⛔ `by` IS NOT IN THIS CLASS AND MUST NEVER BE REPORTED. It is not dropped:
 *   it is CONSUMED, by the event log, in the same request (`server.js`, the
 *   `cardEvent('update', card, by)` call). Reporting it as ignored, refused, OR
 *   redirected would be false in all three directions. The distinction was
 *   already written in prose in the set's own comment — "it travels WITH a
 *   write (#675), it is not a field OF the card" — while the code put both keys
 *   in one Set and treated them identically. A comment asserting a runtime
 *   property is a test case in prose; this file is that comment, encoded.
 *
 * ⚠️ THE LOAD-BEARING TEST HERE IS THE ONE THAT ASSERTS SILENCE (RC1).
 * RC2 fails before the fix and passes after — it is the easy direction. RC1
 * passes BOTH before and after, and its whole job is to fail if someone
 * "fixes" this by reporting projections unconditionally. Without RC1, the fix
 * and the regression-to-noise both go green.
 *
 * The map-not-list container and the anywhere-else-to-go discriminator came
 * from review, not from the author of this file; the `by` exemption was reached
 * independently by two readers before either wrote it down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const mk = async (baseUrl, body = {}) => (await fetch(`${baseUrl}/api/cards`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'orig', createdBy: 'ada', ...body }),
})).json();

const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

const patch = async (baseUrl, id, body) => {
  const res = await fetch(`${baseUrl}/api/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** Attach a real comment so the projection under test is non-empty. */
const comment = async (baseUrl, cardId, body = 'a real comment') => (await fetch(`${baseUrl}/api/conversations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ author: 'ada', body, attachedTo: cardId }),
})).json();

test('#856 RC1 — echoing the comments projection back is SILENT (the load-bearing one)', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    await comment(server.baseUrl, c.id);
    const got = await get(server.baseUrl, c.shortId);

    // Guard the guard: if the projection were empty, this test would pass for
    // the wrong reason — an absent comparand is not an echo.
    assert.equal(got.comments.total, 1, 'setup: the projection must be non-empty');

    // The ordinary client pattern: the whole card back, one field changed.
    const r = await patch(server.baseUrl, c.shortId, { ...got, title: 'renamed', by: 'ada' });

    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'renamed', 'control: the one intended change landed');
    assert.equal(
      r.body.redirectedFields, undefined,
      `an RMW echo must produce NO redirect — got ${JSON.stringify(r.body.redirectedFields)}`,
    );
  } finally {
    await server.stop();
  }
});

test('#856 RC2 — a DIFFERENT comments value is redirected, and names where to go', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    await comment(server.baseUrl, c.id);

    const r = await patch(server.baseUrl, c.shortId, {
      by: 'ada',
      title: 'renamed',
      comments: [{ author: 'ada', body: 'trying to add a comment the wrong way' }],
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'renamed', 'control: the PATCH executed');
    assert.ok(r.body.redirectedFields, 'a real attempt must be reported');
    assert.ok(
      Object.prototype.hasOwnProperty.call(r.body.redirectedFields, 'comments'),
      `expected a redirect for comments — got ${JSON.stringify(r.body.redirectedFields)}`,
    );

    // ⛔ Asserted against the CONTENT, not merely against presence. A redirect
    // whose destination is "" or "unsupported" satisfies a truthiness check and
    // tells the caller nothing — which is the entire defect, relocated.
    const dest = r.body.redirectedFields.comments;
    assert.equal(typeof dest, 'string');
    assert.match(
      dest, /conversation/i,
      `the destination must name the real door, not merely exist — got ${JSON.stringify(dest)}`,
    );
  } finally {
    await server.stop();
  }
});

test('#856 RC3 — a redirected key is still NOT stored, and NOT in the other two lists', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);

    const r = await patch(server.baseUrl, c.shortId, {
      by: 'ada',
      title: 'renamed',
      comments: [{ body: 'nope' }],
    });

    // The permission is unchanged: this card is about the diagnostic only.
    const after = await get(server.baseUrl, c.shortId);
    assert.equal(after.comments.total, 0, 'the redirect must not have written a comment');
    assert.equal(after.title, 'renamed', 'control: the legitimate field did change');

    // A key that is redirected must not ALSO be reported as unrecognised or
    // refused — three names for one fact is the noise this family fights.
    assert.ok(
      !(r.body.ignoredFields || []).includes('comments'),
      `a redirect must not double-report as ignored — got ${JSON.stringify(r.body.ignoredFields)}`,
    );
    assert.ok(
      !(r.body.refusedFields || []).includes('comments'),
      `a redirect must not double-report as refused — got ${JSON.stringify(r.body.refusedFields)}`,
    );
  } finally {
    await server.stop();
  }
});

test('#856 RC4 — `by` is consumed, never reported, in any of the three lists', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);

    // `by` alongside a real change, and again alongside an unknown key so the
    // anchor below proves the reporting machinery was live in this same request.
    const r = await patch(server.baseUrl, c.shortId, {
      by: 'grace',
      title: 'renamed',
      nosuchfield: 'x',
    });

    assert.equal(r.body.title, 'renamed', 'control: the PATCH executed');

    // ⭐ ANCHOR. Without this the three assertions below would pass on a server
    // that reports nothing at all — the check would be measuring its own
    // silence rather than `by`'s exemption.
    assert.ok(
      (r.body.ignoredFields || []).includes('nosuchfield'),
      'anchor: an unknown key MUST still be reported (#823 intact)',
    );

    for (const list of ['ignoredFields', 'refusedFields', 'redirectedFields']) {
      const v = r.body[list];
      const names = Array.isArray(v) ? v : Object.keys(v || {});
      assert.ok(
        !names.includes('by'),
        `\`by\` is consumed by the event log, not discarded — it must not appear in ${list}, got ${JSON.stringify(v)}`,
      );
    }
  } finally {
    await server.stop();
  }
});

test('#856 RC5 — the #823/#844 contract is intact: unknown reported, echo silent', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    const got = await get(server.baseUrl, c.shortId);

    // Regression guard in both directions, in one request each.
    const noisy = await patch(server.baseUrl, c.shortId, { by: 'ada', title: 'a', bogus: 1 });
    assert.ok((noisy.body.ignoredFields || []).includes('bogus'), '#823: unknown keys still reported');

    // ⚠️ RE-READ. The `noisy` PATCH above bumped `updatedAt`, so echoing the
    // ORIGINAL `got` would send a genuinely stale value — correctly reported,
    // and nothing to do with the echo rule. Asserting against a stale read is
    // how a passing server looks broken.
    const fresh = await get(server.baseUrl, c.shortId);
    const quiet = await patch(server.baseUrl, c.shortId, { ...fresh, title: 'b', by: 'ada' });
    assert.equal(quiet.body.refusedFields, undefined, '#844: echoed immutables still silent');
    assert.ok(
      !(quiet.body.ignoredFields || []).length,
      `#844: a full echo must stay silent — got ${JSON.stringify(quiet.body.ignoredFields)}`,
    );
  } finally {
    await server.stop();
  }
});
