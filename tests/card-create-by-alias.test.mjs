/**
 * #862 — ONE CONCEPT, TWO FIELD NAMES, AND THE ROUTE THAT SAYS SO.
 *
 * `PATCH /api/cards/:id` takes the declared editor as `by`.
 * `POST  /api/cards`     took it as `createdBy`, and ignored `by` entirely.
 *
 * So a caller who learned `by` from the update route sent `by` to create and
 * was silently unattributed — except it was NOT silent: #823's diagnostic
 * reported `ignoredFields: ['by']`, correctly, and the reporter read the
 * message as the defect. The instrument worked; the reader did not.
 *
 * ⚰️ WHY IT MATTERED ENOUGH TO FIX RATHER THAN DOCUMENT.
 * `createdBy` is in IMMUTABLE_CARD_FIELDS (#631 — "authorship is a fact about
 * the past"), so the mistake is not repairable after the fact. Three cards
 * created through that door on 2026-08-18 carry `createdBy: null` permanently,
 * including #857 — the apex card arguing that this board is the room's
 * continuity organ. A rule protecting the integrity of authorship was the sole
 * reason the room's apex node is anonymous.
 *
 * ⇒ THE FIX IS THE INPUT, NOT THE RULE. Nothing here relaxes immutability;
 * that was considered and deliberately left alone (a null→value exception on a
 * declared-not-authenticated surface would let anyone claim authorship of any
 * unattributed card, and wants adversarial review by someone who was not in the
 * conversation that got bitten). Create simply learns the other route's word.
 *
 * ⚠️ PRECEDENCE IS PINNED, not incidental. `createdBy` is create's native
 * field and wins when both are sent, so the result cannot depend on JSON key
 * order — the same reasoning as #831's assignees/assignee precedence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const create = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'attribution probe', ...body }),
  });
  return { status: res.status, body: await res.json() };
};

test('#862 create accepts `by` as the declared author — the update route\'s word works here too', async () => {
  const s = await startRestServer();
  try {
    const r = await create(s.baseUrl, { by: 'ada' });
    assert.equal(r.status, 201);
    assert.equal(r.body.createdBy, 'ada', '`by` must reach the card the same way `createdBy` does');
  } finally { await s.stop(); }
});

test('#862 RC3 — the honest report stays honest: `by` is no longer named as ignored', async () => {
  const s = await startRestServer();
  try {
    const r = await create(s.baseUrl, { by: 'ada' });
    assert.ok(
      !(r.body.ignoredFields || []).includes('by'),
      'a consumed field must not be reported as discarded — the #823 channel is only '
      + `worth having while it is true. got ${JSON.stringify(r.body.ignoredFields)}`,
    );
    // ⭐ ANCHOR. Without it these assertions pass on a server that reports
    // nothing at all, measuring their own silence rather than `by`'s consumption.
    const anchored = await create(s.baseUrl, { by: 'ada', nosuchfield: 1 });
    assert.ok(
      (anchored.body.ignoredFields || []).includes('nosuchfield'),
      'anchor: an unknown key MUST still be reported (#823 intact)',
    );
    assert.ok(!(anchored.body.ignoredFields || []).includes('by'), '`by` still consumed alongside');
  } finally { await s.stop(); }
});

test('#862 the original spelling still works — `createdBy` is unchanged', async () => {
  const s = await startRestServer();
  try {
    const r = await create(s.baseUrl, { createdBy: 'grace' });
    assert.equal(r.body.createdBy, 'grace', 'the existing field must not regress');
  } finally { await s.stop(); }
});

test('#862 precedence is pinned: `createdBy` wins over `by`, whatever the key order', async () => {
  const s = await startRestServer();
  try {
    const a = await create(s.baseUrl, { createdBy: 'grace', by: 'ada' });
    const b = await create(s.baseUrl, { by: 'ada', createdBy: 'grace' });
    assert.equal(a.body.createdBy, 'grace', 'createdBy is create\'s native field and wins');
    assert.equal(b.body.createdBy, 'grace', 'and the result must not depend on JSON key order');
  } finally { await s.stop(); }
});

test('#862 declaring nothing still records nothing — null is not backfilled with a guess', async () => {
  const s = await startRestServer();
  try {
    const r = await create(s.baseUrl, {});
    assert.equal(
      r.body.createdBy, null,
      'a request that declares no author must stay null. The trust model is DECLARED, '
      + 'not authenticated (server.js, #631) — inventing an attribution is worse than lacking one.',
    );
  } finally { await s.stop(); }
});

test('#862 RC1 — the declared author reaches the EVENT LOG, not just the card', async () => {
  const s = await startRestServer();
  try {
    // Captured BEFORE the write, so the window is guaranteed to contain it.
    const before = new Date(Date.now() - 1000).toISOString();
    const r = await create(s.baseUrl, { by: 'ada' });
    // The card field is not the claim; the log is what #857 §II calls the record.
    //
    // ⚠️ Read against the ACTUAL contract, which was probed rather than assumed:
    // the response nests under `changes`, `shortId` is top-level rather than
    // under `entity`, and the actor is emitted as `by`. The store calls that
    // field `actor`; this projection renames it — which is quietly the best
    // argument on this card, since `by` is already the wire word for "who did
    // this" on every surface except the one that refused it.
    // ⚰️ #872 — THIS LINE ASKED `since=1970` AND FAILED ~1 IN 6.
    //
    // The 400 was `CURSOR_TOO_OLD`, and it was CORRECT: a cursor predating the
    // log's retention cannot be answered honestly, so /api/changes refuses
    // rather than serving "whatever survived" (#679). The inversion is the part
    // worth keeping — the question was never "why does this sometimes
    // fail" but ⭐ "why does it usually NOT", and the answer is that the test
    // passed six times in seven by taking a path where a correctness guard
    // happened not to fire. A test whose green depends on a guard staying
    // quiet is not testing the thing it names.
    //
    // ⇒ Ask from a cursor this run actually owns. `before` is captured above
    // the write, so the window provably contains the create and provably
    // predates nothing.
    // ⇒ FOLLOW THE DOCUMENTED CONTRACT rather than dodging the guard. A 400
    // CURSOR_TOO_OLD names `oldest_retained` and says "resync, then ask from
    // there"; a client that cannot do that is not a client. Asking from a
    // window the server will accept is what a returning agent actually does
    // (#643), so the test now exercises the real protocol instead of a lucky
    // path through it.
    const ask = (s0) => fetch(`${s.baseUrl}/api/changes?since=${encodeURIComponent(s0)}&limit=100`);
    let res = await ask(before);
    let body = await res.json();
    if (res.status === 400 && body.code === 'CURSOR_TOO_OLD') {
      assert.ok(body.oldest_retained, 'a refusal must name the boundary it is refusing from, or it is unactionable');
      res = await ask(body.oldest_retained);
      body = await res.json();
    }
    assert.equal(res.status, 200, `setup: /api/changes must answer, got ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    const mine = (body.changes || []).filter((e) => e.shortId === r.body.shortId);
    assert.ok(mine.length > 0, `setup: expected an event for #${r.body.shortId}, got none`);
    assert.ok(
      mine.some((e) => e.by === 'ada'),
      `the create event must carry the declared actor. got ${JSON.stringify(mine.map((e) => e.by))}`,
    );
  } finally { await s.stop(); }
});
