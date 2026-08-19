/**
 * #902 — `stale: 0` READS THE SAME WHETHER A CLAIM IS WATCHED BY A MEASUREMENT
 * OR BY A PROXY FOR SOMEONE'S JUDGEMENT.
 *
 * Measured on the live board, 2026-08-19. Every one of these reports `holds`, in
 * the same colour, in the same list:
 *
 *   ASK { ?a a prov:Activity ; scrum:shortId ?s }   a capability, in the store
 *   ASK { ?c schema:identifier "858" ;
 *         scrum:column column:done }                a CARD's state — a proxy for the
 *                                                   same human judgement that rotted
 *                                                   #857 five times in 31 hours
 *   ASK { ?c schema:identifier "894" }              fires ONLY if the card is deleted
 *   ASK { ?c a schema:CreativeWork }                ⛔ cannot fail while any card
 *                                                   exists — green by construction
 *
 * ⇒ A reader of `stale: 0` cannot tell which kind they are reading, and the two
 * mean opposite things about how much the number is worth.
 *
 * ⭐ THIS REPORTS EVIDENCE, NOT A VERDICT — and that is the design, not timidity.
 * A classifier deciding which checks are "good" would be one more judgement
 * smuggled into a mechanical-looking half, which is the defect this room spent
 * 2026-08-18 naming four separate times. The payload lists what each ASK touches;
 * the reader decides what it is worth.
 *
 * ⚠️ SYNTACTIC AND THEREFORE FALLIBLE. It reads query text. An ASK that reaches
 * card state by an unusual spelling is not flagged. It raises the floor and closes
 * nothing — stated here so a future reader does not take the flag for a guarantee.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const post = (baseUrl, body) => fetch(`${baseUrl}/api/cards`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

const checks = async (baseUrl) => (await fetch(`${baseUrl}/api/checks`)).json();

// A capability question: does this KIND OF THING exist in the store at all?
const MEASUREMENT = {
  claim: 'people are not yet projected as nodes',
  ask: 'ASK { ?p a schema:Person }',
  expect: false,
};
// A card-state question. Answers "where does this card sit", never "does the
// system do the thing" — and it is watching the same judgement that writes cards.
const CARD_STATE = {
  claim: 'card 1 is still in backlog',
  ask: 'ASK { ?c schema:identifier "1" ; scrum:column column:done }',
  expect: false,
};

test('#902 a check reports WHAT IT LOOKS AT, not only what it answered', async () => {
  const s = await startRestServer();
  try {
    await post(s.baseUrl, { title: 'watched by a measurement', checks: [MEASUREMENT], by: 'ada' });
    const body = await checks(s.baseUrl);

    const card = body.results.find((r) => r.title === 'watched by a measurement');
    assert.ok(card, `the watched card must appear. got ${JSON.stringify(body.results)}`);
    const [c] = card.checks;

    assert.ok(c.looksAt, 'every evaluated check must say what its ASK references');
    assert.ok(Array.isArray(c.looksAt.predicates), 'predicates must be a LIST — a scalar cannot be investigated (#727)');
    assert.ok(
      c.looksAt.predicates.includes('schema:Person'),
      `the predicates it names must be the ones in the ASK. got ${JSON.stringify(c.looksAt)}`,
    );
  } finally { await s.stop(); }
});

test('#902 ⛔ a check that only touches CARD IDENTITY is flagged as such', async () => {
  const s = await startRestServer();
  try {
    await post(s.baseUrl, { title: 'watched by a proxy', checks: [CARD_STATE], by: 'ada' });
    const body = await checks(s.baseUrl);

    const card = body.results.find((r) => r.title === 'watched by a proxy');
    const [c] = card.checks;
    assert.equal(
      c.looksAt.referencesOnlyCardIdentity, true,
      `an ASK constraining only identifier + column sees no capability. got ${JSON.stringify(c.looksAt)}`,
    );
    assert.equal(body.checksReferencingOnlyCardIdentity, 1, 'and it must be counted in the headline');
    assert.equal(body.checksTotal, 1, 'the denominator must be there too — a numerator alone is #857 §VI all over again');
  } finally { await s.stop(); }
});

// ⛔ A WILDCARD SCAN. Names no predicates at all, so a naive "everything it
// names is card identity" test is VACUOUSLY TRUE. This is the shape that was
// mis-flagged on the live board and could not appear in a fixture, because
// nobody writes a wildcard ASK by hand in a test.
const WILDCARD = {
  claim: 'no whisper state is in the graph',
  ask: 'ASK { ?s ?p ?o . FILTER(CONTAINS(STR(?p), "whisper")) }',
  expect: false,
};

test('#902 ⛔ REGRESSION — a WILDCARD scan is not a card-identity proxy', async () => {
  const s = await startRestServer();
  try {
    await post(s.baseUrl, { title: 'wildcard scan', checks: [WILDCARD], by: 'ada' });
    const body = await checks(s.baseUrl);
    const c = body.results.find((r) => r.title === 'wildcard scan').checks[0];
    assert.equal(
      c.looksAt.referencesOnlyCardIdentity, false,
      'a query that scans every predicate is the OPPOSITE of card-scoped. '
      + `The first implementation flagged this, on two live cards. got ${JSON.stringify(c.looksAt)}`,
    );
    assert.equal(body.checksReferencingOnlyCardIdentity, 0);
  } finally { await s.stop(); }
});

test('#902 ⭐ CONTROL — a MEASUREMENT is NOT flagged, so the flag distinguishes', async () => {
  const s = await startRestServer();
  try {
    // Without this, an implementation that flagged EVERY check would pass the
    // test above and report the whole board as proxy-watched. A flag that names
    // everything names nothing — the same shape as #894's staleSessions control.
    await post(s.baseUrl, { title: 'measurement', checks: [MEASUREMENT], by: 'ada' });
    await post(s.baseUrl, { title: 'proxy', checks: [CARD_STATE], by: 'ada' });
    const body = await checks(s.baseUrl);

    const m = body.results.find((r) => r.title === 'measurement').checks[0];
    const p = body.results.find((r) => r.title === 'proxy').checks[0];

    assert.equal(m.looksAt.referencesOnlyCardIdentity, false, 'a capability ASK must NOT be flagged');
    assert.equal(p.looksAt.referencesOnlyCardIdentity, true, 'a card-state ASK must be');
    assert.equal(body.checksTotal, 2);
    assert.equal(
      body.checksReferencingOnlyCardIdentity, 1,
      'exactly one of the two — if this is 0 or 2 the flag is constant and measures nothing',
    );
  } finally { await s.stop(); }
});
