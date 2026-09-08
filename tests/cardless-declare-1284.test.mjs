/**
 * #1284 — A DECLARATION MUST BE ABLE TO NAME AN ASK, NOT ONLY A CARD.
 *
 * ── The shape the card is about ─────────────────────────────────────────────
 * Someone asks the ROOM for something. Two seats each read it, each correctly
 * conclude it is theirs, and each do it. Neither was wrong. Neither raced.
 * NEITHER KNEW THERE WAS A RACE. A claim rail orders contenders; it cannot
 * create contention awareness where none existed — and by the time two seats
 * would reach for `card_claim`, each has already decided to act.
 *
 * ⇒ #1284's stated unit is therefore THE ASK, and an ask broadcast to a room
 *   has no card when it arrives.
 *
 * ── ⭐ WHAT WAS ACTUALLY MISSING, which is two lines and not a design ────────
 * The work object has carried `sourceMessageId` since #755 slice 2e, and
 * `core/work-auction.mjs` `declare()` defaults `card` to null with a comment
 * that says, in its own words, that a bid may name a source message instead
 * when no card exists yet. The store round-trips both fields. The gate skips a
 * window with no card. The state machine never needed a card.
 *
 * Two layers ABOVE the state machine forbade what it already modelled:
 *
 *   core/work-tools.mjs   `if (!Number.isInteger(card)) throw`
 *   mcp-server.mjs        `card` required in the inputSchema, and
 *                         `sourceMessageId` ABSENT from it entirely
 *
 * ⇒ So the field that could point at an ask was unreachable from the only
 *   surface the seats can call. That is #534's defect exactly: a capability
 *   the callers cannot reach protects nobody, and the seats are the colliding
 *   writers.
 *
 * ── ⛔ WHAT THIS DELIBERATELY DOES NOT CLAIM ────────────────────────────────
 * This does not make anyone declare. `decideCoveredAction` allows a seat
 * holding no open window, by construction, so the rail stays a volunteer
 * button and this only widens what a volunteer is able to point at. #755's
 * collapse question still answers NO, and #1284 acceptance 2 (a room where
 * nobody is racing pays nothing) is satisfied by that absence, not by a claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workDeclare, workBid, workList } from '../core/work-tools.mjs';
import { decideCoveredAction } from '../core/work-gate.mjs';
import { readWorkObjects } from '../core/work-store.mjs';
import { STATES } from '../core/work-auction.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'cardless-1284-'));
const T0 = '2026-09-08T12:00:00.000Z';
const DURING = '2026-09-08T12:05:00.000Z';

// The id of a commons message, which is the only handle an ask HAS before
// anyone has decided it deserves a card.
const ASK = '87f4c10c-7ab2-46d0-b101-e06cd8b0ba5f';

// ── the population the card was written about ───────────────────────────────

test('#1284 a declaration can name an ASK with no card at all', () => {
  const d = dir();
  const r = workDeclare({
    dir: d, id: 'w-ask', by: 'ada', sourceMessageId: ASK,
    required: ['ada', 'bo'], replyByMinutes: 20, now: T0,
  });
  assert.equal(r.state, STATES.BIDDING);
  assert.deepEqual(r.pending, ['bo'], 'the second seat is who the window is FOR');

  // Persisted, and both anchors round-trip through the store — the absent one
  // as an explicit null, not as a missing key.
  const [wo] = readWorkObjects(d);
  assert.equal(wo.sourceMessageId, ASK);
  assert.equal(wo.card, null);
});

test('#1284 a second seat reading the same ask sees the first one holding it', () => {
  // This is acceptance 1 in one assertion: the ask is answerable BEFORE the
  // action, and the answer is visible to whoever reads next.
  const d = dir();
  workDeclare({
    dir: d, id: 'w-ask', by: 'ada', sourceMessageId: ASK,
    required: ['ada', 'bo'], replyByMinutes: 20, now: T0,
  });
  const seen = workList({ dir: d, now: DURING }).open;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sourceMessageId, ASK, 'and it is findable BY THE ASK, not by a card');
  assert.deepEqual(seen[0].bidders, ['ada']);
});

test('#1284 the ask-anchored window still contests like any other', () => {
  // Delegation, not a second state machine: a cardless object goes to
  // arbitration on a second bid exactly as a card-anchored one does.
  const d = dir();
  workDeclare({
    dir: d, id: 'w-ask', by: 'ada', sourceMessageId: ASK,
    required: ['ada', 'bo'], replyByMinutes: 20, now: T0,
  });
  const r = workBid({ dir: d, id: 'w-ask', by: 'bo', now: DURING });
  assert.deepEqual(r.bidders, ['ada', 'bo']);
});

// ── ⛔ the refusal: an anchor is REQUIRED, it is the CARD that is optional ───

test('#1284 a declaration naming NEITHER a card nor an ask is refused', () => {
  // Making `card` optional must not make the object anchorless. A work object
  // carries no title and no description on purpose — the pointer is the ONLY
  // thing it says about what it is for, so an object with no pointer says
  // nothing at all and could never be recognised by the seat it is meant to
  // warn.
  const d = dir();
  assert.throws(
    () => workDeclare({ dir: d, id: 'w-void', by: 'ada', required: ['ada'], replyByMinutes: 20, now: T0 }),
    /card or sourceMessageId/,
  );
  assert.equal(readWorkObjects(d).length, 0, 'and nothing is persisted by a refusal');
});

test('#1284 a card, when given, is still required to be an integer shortId', () => {
  const d = dir();
  assert.throws(
    () => workDeclare({ dir: d, id: 'w-bad', by: 'ada', card: '755', required: ['ada'], replyByMinutes: 20, now: T0 }),
    /integer shortId/,
    'optional is not the same as unvalidated',
  );
});

test('#1284 an empty-string sourceMessageId is not an anchor', () => {
  // The falsifier for the check above: a guard that only tests presence would
  // accept '' and record an object pointing at nothing, which reads back as a
  // real anchor in every listing.
  const d = dir();
  assert.throws(
    () => workDeclare({ dir: d, id: 'w-empty', by: 'ada', sourceMessageId: '', required: ['ada'], replyByMinutes: 20, now: T0 }),
    /card or sourceMessageId/,
  );
});


test('#1284 ⛔ PROSE cannot arrive in the anchor — the shape is the PII guard', () => {
  // This surface carries no free-text field by design, which is what makes
  // "no PII reaches the work-object log" structural rather than a habit. The
  // first full-suite run caught a bare string here and went red, correctly.
  //
  // ⚠️ The MCP schema pins the same pattern. It is checked HERE as well because
  // a guard that exists at exactly one boundary is a property of where it sits,
  // and this module has other callers.
  const d = dir();
  assert.throws(
    () => workDeclare({
      dir: d, id: 'w-prose', by: 'ada', sourceMessageId: 'a sentence of prose, which is what this field must never accept',
      required: ['ada'], replyByMinutes: 20, now: T0,
    }),
    /uuid|no free text/,
  );
  assert.equal(readWorkObjects(d).length, 0);
});

// ── ⚠️ the consequence I am NOT hiding ──────────────────────────────────────

test('#1284 the gate does NOT gate a cardless window, and that is the honest limit', () => {
  // core/work-gate.mjs skips any window whose card is null, and until now its
  // source said that case was unreachable BECAUSE work_declare required a
  // card. This change makes it reachable, so the behaviour is asserted here
  // rather than left to be discovered.
  //
  // ⇒ It is also correct: the gate is a MUTEX OVER EDITS TO A NAMED CARD. An
  //   ask has no card to be a mutex over, so there is nothing for it to refuse
  //   and refusing everything would be worse. The value of an ask-anchored
  //   window is that a second seat can SEE it — visibility, not enforcement.
  const d = dir();
  workDeclare({
    dir: d, id: 'w-ask', by: 'ada', sourceMessageId: ASK,
    required: ['ada', 'bo'], replyByMinutes: 20, now: T0,
  });
  const r = decideCoveredAction({
    actor: 'ada', workObjects: readWorkObjects(d), now: DURING, card: 755,
  });
  assert.equal(r.allow, true, 'a cardless window covers no card, so it refuses no edit');
});
