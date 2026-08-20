/**
 * #965 — an OPEN PERSON-BLOCKER removes a card from `board_ready`.
 *
 * ⛔ THE LIVE DEFECT, measured three times on 2026-08-20, the sharpest at
 * 19:57Z with BOTH reads at the same watermark (projectedThrough 8816,
 * behindBy 0 — so this is blindness, not lag):
 *
 *   graph_query:  ?b a scrum:Blocker ; scrum:blocks <#604> ;
 *                    scrum:blockedByPerson person:michael ; scrum:status "open"
 *                 ⇒ 1 row. note: "…Do not pull or duplicate this work…"
 *   board_ready:  ready[0] = #604 · reasons ["column:backlog","unclaimed",
 *                                            "no-open-blockers"]
 *
 * ⇒ The card whose blocker note literally says "do not pull" was RANK 1 OF 504,
 * and the queue's stated reason for offering it was that it had no open
 * blocker. `"no-open-blockers"` was FALSE, not incomplete.
 *
 * ── THE DECISION ────────────────────────────────────────────────────────────
 * GATING, ruled by the PO on 2026-08-20 after @michael declined ("I don't have
 * context to add value") and handed it back. Labelled a PO DECISION, explicitly
 * NOT consensus and NOT a majority: the two seats who agreed are one
 * instrument, and the third abstained. The ADVISORY branch is deleted rather
 * than shipped behind a flag — a dormant second answer is exactly this card's
 * own subject, two representations of one fact with nothing saying which
 * governs.
 *
 * ── WHY A FLAT RULE, inherited from #817 and binding ────────────────────────
 * ⚠️ PRESENT AND OPEN ⇒ EXCLUDE. Do NOT look at who the person is. The tempting
 * refinement — "unless the named person is the seat asking" — is inference no
 * edge asserts. A flat rule is arguable; a clever one is a guess with a query
 * attached.
 *
 * ── SIZING, so nobody treats this as an edge case ───────────────────────────
 * Re-measured at one watermark (seq 8857) after a units error was corrected:
 * card→card unresolved blockers cover NINE cards; open person-blockers cover
 * TEN. The mechanism the queue has never consulted gates MORE cards than the
 * one it was built around.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady, READY_EXPLAIN } from '../core/ready-query.mjs';

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

/**
 * ⭐ THE DISCRIMINATING FIXTURE (acceptance 2). The person-blocked card is given
 * the HIGHEST priority and the LOWEST shortId, so under the ready ordering
 * (p0 first, ties oldest-first) a ruleset that ignores person-blockers puts it
 * at POSITION 1 — where it actually sat on the live board. A fixture where it
 * sorts last could pass by accident.
 */
const domain = () => ({
  nodes: [
    card('blocked', 10, 'needs a human before anyone can start', {
      column: 'backlog',
      'scrum:priority': 'p0',
      'scrum:blockers': [{ person: 'michael', status: 'open', note: 'do not pull; decision pending' }],
    }),
    // ⛔ CONTROL — a CLEARED person-blocker must NOT exclude. #881 built
    // `status` so the queue CONVERGES rather than accumulating; a rule that
    // ignores status hides a card forever once anyone ever blocked it.
    card('cleared', 20, 'was blocked, now answered', {
      column: 'backlog',
      'scrum:priority': 'p0',
      'scrum:blockers': [{ person: 'michael', status: 'cleared', note: 'answered' }],
    }),
    // ⛔ CONTROL — a CARD-blocker on a DONE target is already handled by the
    // existing rule and must keep its own reason, not be relabelled.
    card('cardblocked', 30, 'blocked by a live card', {
      column: 'backlog', 'scrum:priority': 'p1', blockedBy: ['live'],
    }),
    card('live', 40, 'ordinary available work', { column: 'backlog', 'scrum:priority': 'p1' }),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));

test('#965 an OPEN person-blocker EXCLUDES the card, and names the person', () => {
  const { ready, excluded } = pageReady(readyFromStore(storeFor()));

  assert.equal(ready.some((c) => c.shortId === 10), false,
    'the person-blocked card must not be offered — it is p0 and oldest, so a ruleset ignoring '
    + 'person-blockers fails HERE, at position 1, which is where #604 actually sat');
  assert.equal(excluded.find((c) => c.shortId === 10)?.reason, 'person-blocker:michael',
    'the verdict must NAME who is waited on — a boolean tells a reader nothing they can act on');
});

/**
 * ⭐⭐⭐ ACCEPTANCE 1, and it is the half that was unconditional under EITHER
 * branch: the verdict must stop asserting something false.
 */
test('#965 `no-open-blockers` is never claimed while an open person-blocker exists', () => {
  const v = READY_EXPLAIN(readyFromStore(storeFor()), 10);
  assert.equal(v.ready, false);
  assert.ok(!(v.reasons || []).includes('no-open-blockers'),
    `explain() still claims no-open-blockers on a card that has one: ${JSON.stringify(v)}`);
});

test('#965 a CLEARED person-blocker does NOT exclude — the queue converges', () => {
  const { ready } = pageReady(readyFromStore(storeFor()));
  assert.ok(ready.some((c) => c.shortId === 20),
    'a cleared blocker must return the card to the queue, or #881\'s status field means nothing '
    + 'and any card ever blocked is hidden forever');
});

test('#965 the existing card-blocker rule is unchanged (acceptance 4)', () => {
  const { ready, excluded } = pageReady(readyFromStore(storeFor()));
  assert.equal(excluded.find((c) => c.shortId === 30)?.reason, 'open-blocker:40',
    'a card→card blocker must keep its own reason, not be relabelled by the new rule');
  assert.ok(ready.some((c) => c.shortId === 40), 'unrelated work is unaffected');
});

/**
 * ⭐ ACCEPTANCE 3 — MUTATION, both directions. Without this the rule could be
 * satisfied by a fixture that never discriminated.
 */
test('#965 MUTATION: removing the blocker returns the card to ready', () => {
  const d = domain();
  delete d.nodes.find((n) => n['@id'] === 'blocked')['scrum:blockers'];
  const { ready } = pageReady(readyFromStore(storeFor(d)));
  assert.ok(ready.some((c) => c.shortId === 10),
    'with the blocker gone the card must be offered again — otherwise the exclusion is firing '
    + 'on something other than the blocker');
});

/**
 * ⛔ THE FLAT-RULE CONSTRAINT, from #817 and binding here.
 */
test('#965 the rule is FLAT — WHO the person is never changes the verdict', () => {
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'blocked')['scrum:blockers'] = [
    { person: 'someone-else-entirely', status: 'open', note: 'still a human' },
  ];
  const { excluded } = pageReady(readyFromStore(storeFor(d)));
  assert.equal(excluded.find((c) => c.shortId === 10)?.reason, 'person-blocker:someone-else-entirely',
    'the exclusion must not consult who is named — "unless it is the seat asking" is inference '
    + 'no edge asserts');
});

/**
 * ⛔⛔ THE ORDERING DEPENDENCY WITH #966, named by the Value Steward and by
 * neither card on its own:
 *
 *   "When #966 lands, #965's gating consumer must recognise BOTH open
 *    blockedByPerson AND open blockedByAnyHuman blockers."
 *
 * ⇒ Otherwise a card blocked on ANY HUMAN becomes ready again — THIS CARD'S
 * EXACT DEFECT, reintroduced by its own sibling, with no error and a `reasons`
 * array that reads correct. #966 is built and undeployed, so this is written
 * now rather than discovered later.
 */
test('#965 an open ANY-HUMAN blocker excludes too — the rule covers every blocker predicate', () => {
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'blocked')['scrum:blockers'] = [
    { anyHuman: true, status: 'open', note: 'one bounded round trip; any human can supply it' },
  ];
  const { ready, excluded } = pageReady(readyFromStore(storeFor(d)));
  assert.equal(ready.some((c) => c.shortId === 10), false,
    'a card waiting on ANY human is not pullable by a seat either — if this passes only for named '
    + 'persons, #966 silently reopens the hole #965 closed');
  assert.equal(excluded.find((c) => c.shortId === 10)?.reason, 'person-blocker:any-human',
    'the any-human case needs its own readable key, not a fabricated person name');
});
