/**
 * #755 slice 2e — the INPUT PATH. MCP tools over the existing transitions.
 *
 * ── WHY THIS EXISTS, and it is not "another mechanism" ──────────────────────
 * The gate is armed. The store is live. The state machine has been complete
 * since slice 1. And a bid is still a COMMONS POST — prose.
 *
 * The only work object that has ever existed was hand-built during the 2c
 * verification. There is no way for a seat to declare, bid, nobid, contest or
 * grant, so:
 *
 *   signal 1  cannot count bids, because no bid record can be created
 *   signal 2  can only count actions taken while holding an object
 *             nobody has a way to make
 *
 * ⇒ Those signals are not "unmeasured pending effort". They are unmeasurable
 *   BY CONSTRUCTION until this path exists. Boring days cannot produce
 *   evidence when the instrument has no input.
 *
 * ── THE PROPERTY THAT MATTERS MOST ─────────────────────────────────────────
 * ⚠️ These tools must be a THIN SHELL over core/work-auction.mjs. The moment
 * they re-implement a rule — who may answer, what closes a window, when a
 * timeout grants — there are two state machines, and the room has spent all
 * day on what happens when two things that should agree can disagree.
 *
 * So the tests below assert DELEGATION, not behaviour duplication: the tool
 * layer validates its inputs, persists, and returns derived state. Every rule
 * is the module's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workDeclare, workBid, workNobid, workContest, workGrant, workList,
} from '../core/work-tools.mjs';
import { STATES } from '../core/work-auction.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'work-tools-'));
const T0 = '2026-08-10T12:00:00.000Z';
const DURING = '2026-08-10T12:05:00.000Z';
const AFTER = '2026-08-10T12:30:00.000Z';

const declared = (d, over = {}) => workDeclare({
  dir: d, id: 'w1', by: 'ada', card: 755, required: ['ada', 'bo'],
  replyByMinutes: 20, now: T0, ...over,
});

// ── the round trip a seat actually needs ────────────────────────────────────

test('#755-2e a seat can declare, and the object is on disk immediately', () => {
  const d = dir();
  const r = declared(d);
  assert.equal(r.id, 'w1');
  assert.equal(r.state, STATES.BIDDING);
  assert.deepEqual(r.bidders, ['ada']);
  assert.deepEqual(r.pending, ['bo']);
  // persisted, not just returned
  assert.equal(workList({ dir: d, now: DURING }).open.length, 1);
});

test('#755-2e ⭐ replyBy is computed from MINUTES, so a caller cannot forget a deadline', () => {
  // The first hand-run's own recorded defect: a bid with no replyBy is not a
  // window, it is an intention that resolves when the bidder decides it has.
  const d = dir();
  const r = declared(d);
  assert.equal(r.replyBy, '2026-08-10T12:20:00.000Z');
  assert.throws(() => workDeclare({ dir: d, id: 'w2', by: 'ada', card: 755, required: ['ada'], now: T0 }), /replyByMinutes/);
});

test('#755-2e ⛔ a bid, a nobid and a contest all become RECORDS — the point of the slice', () => {
  const d = dir();
  declared(d);
  const bid = workBid({ dir: d, id: 'w1', by: 'bo', now: DURING });
  assert.deepEqual(bid.bidders.slice().sort(), ['ada', 'bo']);

  const d2 = dir();
  declared(d2);
  assert.deepEqual(workNobid({ dir: d2, id: 'w1', by: 'bo', now: DURING }).pending, []);

  const d3 = dir();
  declared(d3);
  const c = workContest({ dir: d3, id: 'w1', by: 'bo', now: DURING });
  assert.deepEqual(c.contesters, ['bo']);
  assert.equal(c.state, STATES.ARBITRATION_DUE, 'a contest suspends the auto-grant');
});

test('#755-2e workList reports OPEN and SETTLED separately, both derived at now', () => {
  const d = dir();
  declared(d);
  assert.equal(workList({ dir: d, now: DURING }).open.length, 1);
  const after = workList({ dir: d, now: AFTER });
  assert.equal(after.open.length, 0, 'timed out — no longer in play');
  assert.equal(after.settled.length, 1);
  assert.equal(after.settled[0].grantedBy, 'timeout');
});

// ── ⚠️ DELEGATION: no second state machine ──────────────────────────────────

test('#755-2e ⛔⛔ THE TOOLS DO NOT RE-IMPLEMENT ANY RULE — asserted against the source', () => {
  // If the tool layer decides who may answer, what closes a window, or when a
  // timeout grants, there are two state machines that can disagree. The room
  // has spent a full day on exactly that class.
  const src = readFileSync(new URL('../core/work-tools.mjs', import.meta.url), 'utf8');
  const code = src.replace(/^\s*(\/\/.*|\*.*|\/\*.*)$/gm, '');
  for (const forbidden of ['STATES.BIDDING', 'STATES.GRANTED', 'replyBy <', 'now >=', 'includes(actor)']) {
    assert.equal(code.includes(forbidden), false, `tool layer re-implements a rule: ${forbidden}`);
  }
  // and it must actually import the module rather than reasoning alone
  assert.match(code, /from '\.\/work-auction\.mjs'/);
  assert.match(code, /from '\.\/work-store\.mjs'/);
});

test('#755-2e a rule violation surfaces the MODULE\'s error, not a paraphrase', () => {
  const d = dir();
  declared(d);
  workNobid({ dir: d, id: 'w1', by: 'bo', now: DURING });
  // bo already answered — the module refuses, and the tool must not soften it
  assert.throws(() => workBid({ dir: d, id: 'w1', by: 'bo', now: DURING }), /bo has already answered/);
});

test('#755-2e ⛔ every tool REFUSES without a clock', () => {
  const d = dir();
  assert.throws(() => workDeclare({ dir: d, id: 'x', by: 'ada', card: 1, required: ['ada'], replyByMinutes: 20 }), /now is required/);
  declared(d);
  assert.throws(() => workBid({ dir: d, id: 'w1', by: 'bo' }), /now is required/);
  assert.throws(() => workList({ dir: d }), /now is required/);
});

test('#755-2e ⛔ acting on an unknown work object refuses rather than creating one', () => {
  const d = dir();
  assert.throws(() => workBid({ dir: d, id: 'nope', by: 'bo', now: DURING }), /no work object/);
});

// ── PII: the free-text guard survives the new surface ───────────────────────

test('#755-2e ⛔ NO FREE TEXT — the tools accept no description, and refuse unknown fields', () => {
  const d = dir();
  assert.throws(
    () => workDeclare({ dir: d, id: 'w9', by: 'ada', card: 755, required: ['ada'], replyByMinutes: 20, now: T0, description: 'anything' }),
    /unknown field: description/,
  );
  assert.throws(
    () => workDeclare({ dir: d, id: 'w9', by: 'ada', card: 755, required: ['ada'], replyByMinutes: 20, now: T0, title: 'x' }),
    /unknown field: title/,
  );
});

test('#755-2e the card pointer is carried and nothing else is', () => {
  const d = dir();
  declared(d);
  const line = JSON.parse(readFileSync(join(d, 'work-objects.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(line.card, 755);
  assert.deepEqual(
    Object.keys(line).sort(),
    ['card', 'declaredBy', 'id', 'replyBy', 'required', 'seq', 'sourceMessageId', 'transition'].sort(),
  );
});
