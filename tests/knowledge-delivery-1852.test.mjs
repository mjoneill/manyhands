/**
 * #1852 (#1848 slice 3) — DELIVERY: WHICH proposed links a seat is handed with a card, and what each one says. The rules
 * are pure (core/knowledge-delivery.mjs), so they run here with no graph. Nobody goes looking for a proposed link (#1850
 * measured zero finds), so the board hands a few over at the moment of work: when a card is claimed, and the first time a
 * seat reads it.
 *
 * INTERFACE PINNED HERE:
 *   selectDeliveries(links)            links: [{ id, status, score, source, shown, span, gist }] → the card's delivery SET:
 *                                      never dismissed · one per source · at most DELIVERY_MAX (2) · a DELIVERY-BORN confirm
 *                                      first (#1901), then score descending, then id
 *   selectDeliveries(links, { unanswered: true })   what a card READ shows: the same rules over the links this seat has
 *                                      given NO verdict on, so a claim keeps appearing until she answers it
 *   firstShowings(set)                 the part of a set this seat has not been shown: what a showing is RECORDED for
 *   deliveryBlock({ items, shortId, sources, recorded, reader }) → { means, items: [{ link, status, gist, quote, quoteTruncated?,
 *                                      source: { title, url }, score, answer: { confirm, dismiss } }], recorded? } | null
 *                                      #1901: a CONFIRMED item also carries, right after `status`: confirmedBy (the seat key,
 *                                      or the actor IRI of a non-seat), confirmedAt, confirmedByCount, yours, whoConfirmed
 *                                      (one sentence naming the decider and saying whether it was the reader). A proposed
 *                                      item carries none of them.
 *   linksOfDeliveryRows(rows, { actor }) the delivery query's rows → links; per link `mine` (the reader's standing verdict) and,
 *                                      from every seat's STANDING verdict (#1852's rule: her latest decision), who confirmed it
 *   quoteOf(span)                      → { quote, truncated }   cut at QUOTE_MAX_CHARS (300) with an ellipsis
 *   sourceOfPassage(passage)           `<source>/block/<n>` → `<source>`; anything else → null
 *   showIri(link, actor)               the ONE node a (seat, link) showing lives at: <link>/shown/<sha256(actor)>
 *
 *   S1  a dismissed link is never delivered
 *   S2  at most two per card
 *   S3  at most one per source: the second link from a source is passed over for the next source's
 *   S4  the order: a delivery-born confirm before everything else, then the higher score, then the link id. #1901: a confirm
 *       that was NOT delivery-born (no showing to its seat before it) ranks by score with the proposed ones
 *   S5  links whose source is not known share ONE slot: two of them are never assumed to be two sources
 *   S6  a link with neither a quote nor a gist is not deliverable
 *   S7  a link the seat herself dismissed is never delivered to her, whatever its status; one she confirmed may be
 *   F1  a card READ shows what the seat has not ANSWERED, shown before or not, and the cap is applied AFTER that filter:
 *       answering one claim lets the next one surface. A showing is recorded only for what she has not been shown.
 *   Q1  a long quote is cut at 300 characters with an ellipsis and flagged; a short one is untouched and carries no flag
 *   B1  an item carries the link id, status, gist, quote, source, score and the two exact answering calls, and no triple
 *   B2  the gist falls back to the quote
 *   B3  nothing to deliver → null, so the field is ABSENT, never an empty list
 *   B4  `means` says these are machine proposals found by meaning search, not endorsements, and what a confirm means
 *   B5  `recorded: false` appears only when the showing could not be recorded
 *   B6  a page is never invented
 *   B7  an item the seat was shown before says so (`shownBefore: true`), so a long-lived session can tell a repeat from news
 *   D1  #1901 a confirmed link names who confirmed it and when, from STANDING verdicts: the reader's own confirm when she
 *       gave one (yours), otherwise the most recent; and how many seats' confirms stand
 *   D2  #1901 a confirmed item carries confirmedBy, confirmedAt, confirmedByCount, yours and whoConfirmed beside its status;
 *       a proposed item is exactly what it was
 *   D3  #1901 DONE WHEN 2, a fixture of the block's TEXT: confirmed by seat X and read by seat Y, the text names X beside the
 *       confirm and says plainly it was not Y; read by X, it says it was X
 *   D5  #1901 a link is delivery-born when a seat whose confirm STANDS had been shown it (a LinkShowing) before that confirm
 *   D4  #1901 `means` says "confirmed" names another seat's verdict unless `yours` is true
 *   I1  the showing's IRI is fixed by link and seat: the same pair names the same node, another seat another node
 *   P1  the source of a passage
 *   HL1 #1905 decision ee188cd5 — hand-attached links have their OWN lane: four hand links from one source are all delivered
 *   HL2 the machine lane keeps both caps beside them: one per source, at most DELIVERY_MAX, hand links spending neither
 *   HL3 the hand lane is bounded at HAND_MAX (8) per read, oldest attach first, and names how many more there are
 *   HL4 a hand link this seat has answered, or that the room retired, is not delivered (the same filters as a machine link)
 *   HL5 the block says how many more hand links there are and the exact call that lists them; absent when there are none
 *   HL6 the order: the machine lane first, then the hand lane (an attached link does not outrank machine links, design 7)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  selectDeliveries, selectDeliverySet, firstShowings, deliveryBlock, quoteOf, sourceOfPassage, showIri, linksOfDeliveryRows,
  DELIVERY_MAX, HAND_MAX, QUOTE_MAX_CHARS,
} from '../core/knowledge-delivery.mjs';

const hex = (n) => crypto.createHash('sha256').update(String(n)).digest('hex');
const link = (n, over = {}) => ({ id: hex(n), status: 'proposed', score: 0.7, source: `https://scrumboard.local/source/${n}`, shown: false,
  span: `the verbatim span of claim ${n}`, gist: `the gist of claim ${n}`, ...over });
const ids = (xs) => xs.map((x) => x.id);

test('S1 a dismissed link is never delivered', () => {
  const got = selectDeliveries([link(1, { status: 'dismissed', score: 0.99 }), link(2)]);
  assert.deepEqual(ids(got), [hex(2)]);
});

test('S2 at most two per card', () => {
  assert.equal(DELIVERY_MAX, 2);
  const got = selectDeliveries([link(1, { score: 0.9 }), link(2, { score: 0.8 }), link(3, { score: 0.7 })]);
  assert.deepEqual(ids(got), [hex(1), hex(2)]);
});

test('S3 at most one per source: the second link from a source is passed over for the next source\'s', () => {
  const same = 'https://scrumboard.local/source/one';
  const got = selectDeliveries([link(1, { score: 0.9, source: same }), link(2, { score: 0.8, source: same }), link(3, { score: 0.7 })]);
  assert.deepEqual(ids(got), [hex(1), hex(3)]);
});

test('S4 the order: a delivery-born confirm first, then the higher score, then the link id', () => {
  const got = selectDeliveries([link(1, { score: 0.9 }), link(2, { score: 0.5, status: 'confirmed', deliveryBorn: true })]);
  assert.deepEqual(ids(got), [hex(2), hex(1)], 'a delivery-born confirm leads a higher-scored proposal');
  // #1901 — nine triage confirms (seats confirming from link_list, never shown the link) led six cards' deliveries
  const triage = selectDeliveries([link(1, { score: 0.9 }), link(2, { score: 0.5, status: 'confirmed', deliveryBorn: false })]);
  assert.deepEqual(ids(triage), [hex(1), hex(2)], 'a confirm that was not delivery-born ranks by score with the proposed ones');
  const unknown = selectDeliveries([link(1, { score: 0.9 }), link(2, { score: 0.5, status: 'confirmed' })]);
  assert.deepEqual(ids(unknown), [hex(1), hex(2)], 'and one nobody showed to be delivery-born is not assumed to be');
  const [lo, hi] = [hex(3), hex(4)].sort();
  const tie = selectDeliveries([{ ...link(3), id: hi }, { ...link(4), id: lo }]);
  assert.deepEqual(ids(tie), [lo, hi], 'equal scores are ordered by id, whatever order they arrived in');
  const unscored = selectDeliveries([link(5, { score: null }), link(6, { score: 0.1 })]);
  assert.deepEqual(ids(unscored), [hex(6), hex(5)], 'a link with no score sorts last');
});

test('S5 links whose source is not known share one slot', () => {
  const got = selectDeliveries([link(1, { score: 0.9, source: null }), link(2, { score: 0.8, source: null }), link(3, { score: 0.7 })]);
  assert.deepEqual(ids(got), [hex(1), hex(3)]);
});

test('S6 a link with neither a quote nor a gist is not deliverable', () => {
  const got = selectDeliveries([link(1, { score: 0.9, span: null, gist: null }), link(2, { score: 0.5 })]);
  assert.deepEqual(ids(got), [hex(2)]);
});

test('S7 a link the seat herself dismissed is never delivered to her; one she confirmed may be', () => {
  // `mine` is the seat's own standing verdict: since #1852 a dismiss hides a link from the seat that gave it, not from the room
  const got = selectDeliveries([link(1, { score: 0.9, mine: 'dismissed' }), link(2, { score: 0.8, status: 'confirmed', mine: 'dismissed' }), link(3, { score: 0.7, mine: 'confirmed' }), link(4, { score: 0.6, mine: null })]);
  assert.deepEqual(ids(got), [hex(3), hex(4)]);
});

test('F1 a card read shows what the seat has not answered, and the cap comes after that filter', () => {
  // WHY (reviewer, 2026-11-14): a seat that sees a claim, does not answer, and opens the card again (a resident agent in a
  // new wake remembers nothing of the first block) must still be able to answer it. Showing a link once and never again
  // would record "shown, never used" for a claim that could not be answered a second time.
  const links = [link(1, { score: 0.9, mine: 'confirmed' }), link(2, { score: 0.8, shown: true }), link(3, { score: 0.7 }), link(4, { score: 0.6 })];
  const read = selectDeliveries(links, { unanswered: true });
  assert.deepEqual(ids(read), [hex(2), hex(3)], 'the one she answered is left out BEFORE the cap, so the next one surfaces; one she was only shown stays');
  assert.deepEqual(ids(selectDeliveries(links)), [hex(1), hex(2)], 'CONTROL: a claim shows the card\'s two, a link she confirmed among them');
  assert.deepEqual(ids(firstShowings(read)), [hex(3)], 'only the link she has not been shown is a first showing to record');
  assert.deepEqual(selectDeliveries([link(1, { mine: 'confirmed' }), link(2, { mine: 'dismissed' })], { unanswered: true }), [], 'everything answered: nothing to show');
});

test('Q1 a long quote is cut at 300 characters with an ellipsis and flagged; a short one is untouched', () => {
  assert.equal(QUOTE_MAX_CHARS, 300);
  const long = 'x'.repeat(301);
  assert.deepEqual(quoteOf(long), { quote: `${'x'.repeat(300)}…`, truncated: true });
  assert.deepEqual(quoteOf('x'.repeat(300)), { quote: 'x'.repeat(300), truncated: false }, 'exactly 300 is whole');
  const astral = `${'x'.repeat(299)}😀tail`;
  assert.equal(quoteOf(astral).quote, `${'x'.repeat(299)}…`, 'the cut never leaves half of a surrogate pair');
});

test('B1 an item carries the link, status, gist, quote, source, score and the two exact calls, and no triple', () => {
  const l = link(1, { score: 0.681, source: 'https://scrumboard.local/source/s1' });
  const sources = new Map([['https://scrumboard.local/source/s1', { title: 'A paper', url: 'https://example.org/paper' }]]);
  const b = deliveryBlock({ items: [l], shortId: 42, sources });
  assert.deepEqual(b.items, [{
    link: hex(1), status: 'proposed', gist: 'the gist of claim 1', quote: 'the verbatim span of claim 1',
    source: { title: 'A paper', url: 'https://example.org/paper' }, score: 0.681,
    answer: {
      confirm: { tool: 'link_decide', args: { link: hex(1), verdict: 'confirmed', workingOn: 42 } },
      dismiss: { tool: 'link_decide', args: { link: hex(1), verdict: 'dismissed' } },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(b), /subject|predicate|object|reifies|triple/i, 'the subject-verb-object triple is never rendered');
});

test('B2 the gist falls back to the quote; a cut quote is flagged on the item', () => {
  const b = deliveryBlock({ items: [link(1, { gist: null, span: 'y'.repeat(400) })], shortId: 7, sources: new Map() });
  assert.equal(b.items[0].quote, `${'y'.repeat(300)}…`);
  assert.equal(b.items[0].quoteTruncated, true);
  assert.equal(b.items[0].gist, b.items[0].quote);
  assert.deepEqual(b.items[0].source, { title: null, url: null }, 'a source nobody described is named as unknown, never guessed');
  const whole = deliveryBlock({ items: [link(2)], shortId: 7, sources: new Map() });
  assert.equal('quoteTruncated' in whole.items[0], false, 'CONTROL: a whole quote carries no flag');
});

test('B3 nothing to deliver → null', () => {
  assert.equal(deliveryBlock({ items: [], shortId: 7, sources: new Map() }), null);
});

test('B4 `means` says these are machine proposals found by meaning search, not endorsements, and what a confirm means', () => {
  const { means } = deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() });
  assert.match(means, /MACHINE PROPOSALS/);
  assert.match(means, /meaning search/);
  assert.match(means, /not endorsements/);
  assert.match(means, /mattered to the work on this card/);
  assert.match(means, /until you answer it/, 'and that an unanswered claim keeps appearing on the card');
});

test('B5 `recorded: false` appears only when the showing could not be recorded', () => {
  assert.equal(deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map(), recorded: false }).recorded, false);
  assert.equal('recorded' in deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() }), false);
});

test('B6 a page is never invented', () => {
  const b = deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() });
  assert.equal('page' in b.items[0], false);
});

test('B7 an item the seat was shown before says so', () => {
  const b = deliveryBlock({ items: [link(1, { shown: true }), link(2, { source: 'https://scrumboard.local/source/other' })], shortId: 7, sources: new Map() });
  assert.equal(b.items[0].shownBefore, true);
  assert.equal('shownBefore' in b.items[1], false, 'news carries no flag');
});

// ── #1901 — WHO confirmed a delivered claim, and whether it was the reader ──
const LINK = (n) => `https://scrumboard.local/link/${hex(n)}`;
const v = (value) => ({ value });
/** One delivery-query row for link n; `d` is one decision on it (or none). */
const row = (n, { st = 'confirmed', d = null } = {}) => ({ l: v(LINK(n)), st: v(st), sc: v('0.7'), span: v(`the verbatim span of claim ${n}`), gist: v(`the gist of claim ${n}`),
  pass: v(`https://scrumboard.local/source/${n}/block/3`),
  ...(d ? { d: v(`${LINK(n)}/decision/${d.id}`), dby: v(`urn:ex:seat/${d.by}`), dv: v(d.verdict), dat: v(d.at) } : {}) });
const T1 = '2026-11-13T01:34:29.000Z'; const T2 = '2026-11-14T09:00:00.000Z'; const T3 = '2026-11-14T10:00:00.000Z';
const X = 'urn:ex:seat/seat-x'; const Y = 'urn:ex:seat/seat-y'; const Z = 'urn:ex:seat/seat-z';

test('D1 a confirmed link names who confirmed it and when, from standing verdicts', () => {
  const one = [row(1, { d: { id: 'a', by: 'seat-x', verdict: 'confirmed', at: T1 } })];
  const [byY] = linksOfDeliveryRows(one, { actor: Y });
  assert.deepEqual({ by: byY.confirmedBy, at: byY.confirmedAt, n: byY.confirmedByCount, yours: byY.yours, mine: byY.mine },
    { by: 'seat-x', at: T1, n: 1, yours: false, mine: null }, 'another seat\'s confirm is named, and is not hers');
  const [byX] = linksOfDeliveryRows(one, { actor: X });
  assert.deepEqual({ by: byX.confirmedBy, at: byX.confirmedAt, n: byX.confirmedByCount, yours: byX.yours, mine: byX.mine },
    { by: 'seat-x', at: T1, n: 1, yours: true, mine: 'confirmed' }, 'her own confirm is hers');
  const [anon] = linksOfDeliveryRows(one, { actor: null });
  assert.equal(anon.yours, false, 'a read with no seat owns no verdict');

  // two seats confirmed, z the more recent; a third confirmed and then dismissed, so her confirm no longer stands
  const many = [row(2, { d: { id: 'a', by: 'seat-x', verdict: 'confirmed', at: T1 } }), row(2, { d: { id: 'b', by: 'seat-z', verdict: 'confirmed', at: T2 } }),
    row(2, { d: { id: 'c', by: 'seat-w', verdict: 'confirmed', at: T2 } }), row(2, { d: { id: 'd', by: 'seat-w', verdict: 'dismissed', at: T3 } })];
  const [m] = linksOfDeliveryRows(many, { actor: Y });
  assert.deepEqual({ by: m.confirmedBy, at: m.confirmedAt, n: m.confirmedByCount, yours: m.yours }, { by: 'seat-z', at: T2, n: 2, yours: false },
    'the most recent STANDING confirm is named, and the count is of seats whose confirm stands');
  const [mx] = linksOfDeliveryRows(many, { actor: X });
  assert.deepEqual({ by: mx.confirmedBy, at: mx.confirmedAt, n: mx.confirmedByCount, yours: mx.yours }, { by: 'seat-x', at: T1, n: 2, yours: true },
    'when the reader confirmed it too, HER confirm is the one named: confirmedBy and yours never disagree');
  const [p] = linksOfDeliveryRows([row(3, { st: 'proposed' })], { actor: Y });
  assert.deepEqual({ by: p.confirmedBy, n: p.confirmedByCount, yours: p.yours }, { by: null, n: 0, yours: false }, 'a proposed link has no confirmer');
  const [other] = linksOfDeliveryRows([{ ...row(4), d: v(`${LINK(4)}/decision/e`), dby: v('urn:ex:agent/linker'), dv: v('confirmed'), dat: v(T1) }], { actor: Y });
  assert.equal(other.confirmedBy, 'urn:ex:agent/linker', 'an actor that is not a seat is named by its whole IRI, never cut to a fake seat key');
});

test('D5 a link is delivery-born when a seat whose confirm stands had been shown it before that confirm', () => {
  const T0 = '2026-11-12T00:00:00.000Z';
  /** A decision row by `by`, with that seat's showing of the link at `shownAt` (or none). */
  const dr = (n, by, verdict, at, id, shownAt = null) => ({ ...row(n, { d: { id, by, verdict, at } }),
    ...(shownAt ? { dsh: v(`${LINK(n)}/shown/${hex(by)}`), dshat: v(shownAt) } : {}) });
  const born = (rows) => linksOfDeliveryRows(rows, { actor: Y })[0].deliveryBorn;
  assert.equal(born([dr(1, 'seat-x', 'confirmed', T2, 'a', T1)]), true, 'shown, then confirmed: delivery-born');
  assert.equal(born([dr(1, 'seat-x', 'confirmed', T1, 'a')]), false, 'confirmed with no showing (a link_list triage confirm): not');
  assert.equal(born([dr(1, 'seat-x', 'confirmed', T1, 'a', T2)]), false, 'shown only AFTER the confirm: not');
  assert.equal(born([dr(1, 'seat-x', 'confirmed', T1, 'a', T0), dr(1, 'seat-x', 'dismissed', T2, 'b', T0)]), false, 'a confirm its seat replaced with a dismiss no longer stands, so it lends no rank');
  assert.equal(born([dr(1, 'seat-x', 'confirmed', T1, 'a'), dr(1, 'seat-z', 'confirmed', T3, 'b', T2)]), true, 'one standing delivery-born confirm among others is enough');
  assert.equal(born([row(1, { st: 'proposed' })]), false, 'a proposed link is never delivery-born');
});

const confirmedBy = (by, { at = T1, count = 1, reader = Y } = {}) => ({ ...link(1, { status: 'confirmed', score: 0.5 }), confirmedBy: by, confirmedAt: at, confirmedByCount: count, yours: `urn:ex:seat/${by}` === reader });

test('D2 a confirmed item carries its decider beside its status; a proposed item is exactly what it was', () => {
  const b = deliveryBlock({ items: [confirmedBy('seat-x'), link(2, { source: 'https://scrumboard.local/source/other' })], shortId: 42, sources: new Map(), reader: Y });
  const [c, p] = b.items;
  assert.deepEqual(Object.keys(c).slice(0, 7), ['link', 'status', 'confirmedBy', 'confirmedAt', 'confirmedByCount', 'yours', 'whoConfirmed'], 'the decider sits right beside the status');
  assert.deepEqual({ by: c.confirmedBy, at: c.confirmedAt, n: c.confirmedByCount, yours: c.yours }, { by: 'seat-x', at: T1, n: 1, yours: false });
  assert.deepEqual(Object.keys(p), ['link', 'status', 'gist', 'quote', 'source', 'score', 'answer'], 'a proposed item: today\'s keys, in today\'s order');
  for (const k of ['confirmedBy', 'confirmedAt', 'confirmedByCount', 'yours', 'whoConfirmed']) assert.equal(k in p, false, `a proposed item carries no ${k}`);
});

test('D3 the block\'s TEXT makes the decider unambiguous: confirmed by X and read by Y says X, and that it was not Y; read by X says X', () => {
  // DONE WHEN 2 (#1901): a small-model seat (guest) was shown another seat's confirm and posted "I accepted that claim". This is
  // a fixture of the text such a seat reads (the MCP tools hand the JSON through as it is), not a live model call.
  const textFor = (reader) => JSON.stringify(deliveryBlock({ items: [confirmedBy('seat-x', { reader })], shortId: 1179, sources: new Map(), reader }), null, 2);
  const toY = textFor(Y);
  assert.match(toY, /"status": "confirmed",\s*"confirmedBy": "seat-x",\s*"confirmedAt": "2026-11-13T01:34:29.000Z"/, 'X is named beside the confirm, with when');
  assert.match(toY, /"yours": false/);
  assert.match(toY, /seat-x confirmed this claim at 2026-11-13T01:34:29.000Z/);
  assert.match(toY, /NOT yours: you \(seat-y\) have given no verdict on this claim/, 'and it says plainly that the reader, by name, did not');
  assert.doesNotMatch(toY, /You \(seat-y\) confirmed/);
  const toX = textFor(X);
  assert.match(toX, /"yours": true/);
  assert.match(toX, /You \(seat-x\) confirmed this claim at 2026-11-13T01:34:29.000Z: this verdict is yours/);
  assert.doesNotMatch(toX, /NOT yours/);
  const anon = JSON.stringify(deliveryBlock({ items: [confirmedBy('seat-x', { reader: null })], shortId: 1179, sources: new Map(), reader: null }));
  assert.match(anon, /seat-x confirmed this claim at .*not a verdict of yours/, 'a read with no seat is told it owns none of it');
  const several = JSON.stringify(deliveryBlock({ items: [confirmedBy('seat-z', { at: T2, count: 2 })], shortId: 1, sources: new Map(), reader: Y }));
  assert.match(several, /seat-z confirmed this claim at 2026-11-14T09:00:00.000Z \(2 seats' confirms stand; seat-z's is the latest\)/);
  const mineOfTwo = JSON.stringify(deliveryBlock({ items: [confirmedBy('seat-x', { count: 2, reader: X })], shortId: 1, sources: new Map(), reader: X }));
  assert.match(mineOfTwo, /You \(seat-x\) confirmed this claim at .*: this verdict is yours\. 1 other seat's confirm stands too\./);
  const none = JSON.stringify(deliveryBlock({ items: [{ ...confirmedBy(null), yours: false, confirmedByCount: 0, confirmedAt: null }], shortId: 1, sources: new Map(), reader: Y }));
  assert.match(none, /No seat's confirm of this claim stands now.*not your verdict/);
});

test('D4 `means` says "confirmed" names another seat\'s verdict unless `yours` is true', () => {
  const { means } = deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() });
  assert.match(means, /"confirmed" is ANOTHER seat's verdict unless `yours` is true/);
  assert.match(means, /`confirmedBy` names the seat and `confirmedAt` when/);
  assert.match(means, /never say you confirmed or accepted a claim whose `yours` is false/);
});

test('I1 the showing\'s IRI is fixed by link and seat', () => {
  const l = `https://scrumboard.local/link/${hex(1)}`;
  const a = showIri(l, 'urn:ex:seat/seat-a');
  assert.equal(a, showIri(l, 'urn:ex:seat/seat-a'));
  assert.equal(a, `${l}/shown/${crypto.createHash('sha256').update('urn:ex:seat/seat-a').digest('hex')}`);
  assert.notEqual(a, showIri(l, 'urn:ex:seat/seat-b'));
});

test('P1 the source of a passage', () => {
  assert.equal(sourceOfPassage('https://scrumboard.local/source/abc/block/12'), 'https://scrumboard.local/source/abc');
  assert.equal(sourceOfPassage('https://scrumboard.local/source/abc'), null);
  assert.equal(sourceOfPassage(null), null);
});

// ── #1905 — a claim attached BY HAND says so, with who, when and why; a machine link's item is unchanged ──
test('HD1 #1905 the delivery rows carry a hand link\'s attacher, time and reason; a machine link has none', () => {
  const hand = { ...row(5, { st: 'proposed' }), sc: undefined, ab: v('urn:ex:seat/seat-x'), ar: v('the inbox the card asks for'), lat: v(T2) };
  const [h, m] = linksOfDeliveryRows([hand, row(6, { st: 'proposed' })], { actor: Y });
  assert.deepEqual({ attachedBy: h.attachedBy, attachedAt: h.attachedAt, attachReason: h.attachReason }, { attachedBy: 'seat-x', attachedAt: T2, attachReason: 'the inbox the card asks for' });
  assert.deepEqual({ attachedBy: m.attachedBy, attachedAt: m.attachedAt, attachReason: m.attachReason }, { attachedBy: null, attachedAt: null, attachReason: null });
});

test('HD2 #1905 a hand-attached item names who attached it, when and why, says it is not a confirm, and tells the attacher it is hers; a machine item is byte-for-byte unchanged', () => {
  const hand = link(7, { score: null, attachedBy: 'seat-x', attachedAt: T2, attachReason: 'the inbox the card asks for' });
  const toY = deliveryBlock({ items: [hand], shortId: 1902, sources: new Map(), reader: Y }).items[0];
  assert.deepEqual({ by: toY.attachedBy, at: toY.attachedAt, why: toY.attachReason }, { by: 'seat-x', at: T2, why: 'the inbox the card asks for' });
  assert.match(toY.whoAttached, /^seat-x attached this claim to the card by hand at 2026-11-14T09:00:00\.000Z, because: the inbox the card asks for\./);
  assert.match(toY.whoAttached, /not a confirm/i);
  assert.doesNotMatch(toY.whoAttached, /You \(/);
  const toX = deliveryBlock({ items: [hand], shortId: 1902, sources: new Map(), reader: X }).items[0];
  assert.match(toX.whoAttached, /^You \(seat-x\) attached this claim to the card by hand at /);
  const machine = link(8);
  const plain = deliveryBlock({ items: [machine], shortId: 1902, sources: new Map(), reader: Y }).items[0];
  const before = deliveryBlock({ items: [{ ...machine, attachedBy: null, attachedAt: null, attachReason: null }], shortId: 1902, sources: new Map(), reader: Y }).items[0];
  assert.equal(JSON.stringify(before), JSON.stringify(plain), 'null attach fields render nothing');
  for (const k of ['attachedBy', 'attachedAt', 'attachReason', 'whoAttached']) assert.equal(k in plain, false, `a machine item has no ${k}`);
});

test('HD3 #1905 `means` says an item with attachedBy was attached by hand, and that attaching is not a confirm', () => {
  const { means } = deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() });
  assert.match(means, /`attachedBy`.*by hand/i);
  assert.match(means, /not a confirm/i);
});

// #1905 decision ee188cd5: a hand link is a person saying "read this, and here's why"; the machine's budget does not ration it.
const hand = (n, over = {}) => link(n, { score: null, source: 'https://scrumboard.local/source/one-article', attachedBy: 'seat-x',
  attachedAt: `2026-11-15T10:0${n % 10}:00.000Z`, attachReason: `reason ${n}`, ...over });

test('HL1 #1905 four hand links from ONE source are all delivered, on a claim and on a read', () => {
  const four = [hand(1), hand(2), hand(3), hand(4)];
  assert.deepEqual(ids(selectDeliveries(four)), ids(four));
  assert.deepEqual(ids(selectDeliveries(four, { unanswered: true })), ids(four));
  // CONTROL: the same four without attachedBy are machine links, and the per-source cap keeps exactly one
  assert.equal(selectDeliveries(four.map((l) => ({ ...l, attachedBy: null }))).length, 1);
});

test('HL2 #1905 machine links keep both caps beside the hand lane, and hand links spend neither', () => {
  const same = 'https://scrumboard.local/source/one-article';
  const machines = [link(11, { score: 0.9, source: same }), link(12, { score: 0.8, source: same }), link(13, { score: 0.7 }), link(14, { score: 0.6 })];
  const got = selectDeliveries([...machines, hand(1), hand(2), hand(3), hand(4)]);
  const m = got.filter((l) => !l.attachedBy);
  assert.deepEqual(ids(m), [hex(11), hex(13)], 'one machine link from the hand links\' own source, then the next source; two in all');
  assert.equal(m.length, DELIVERY_MAX);
  assert.equal(got.filter((l) => l.attachedBy).length, 4, 'all four hand links still delivered');
});

test('HL3 #1905 the hand lane is bounded at 8 per read, oldest attach first, and counts the rest', () => {
  assert.equal(HAND_MAX, 8);
  const nine = [9, 3, 7, 1, 5, 8, 2, 6, 4].map((n) => hand(n));
  const { items, moreAttached } = selectDeliverySet(nine);
  assert.deepEqual(ids(items), [1, 2, 3, 4, 5, 6, 7, 8].map(hex), 'oldest attachedAt first');
  assert.equal(moreAttached, 1);
  assert.equal(selectDeliverySet(nine.slice(0, 8)).moreAttached, 0, 'CONTROL: eight is not over the bound');
  assert.deepEqual(ids(selectDeliveries(nine)), ids(items), 'selectDeliveries is the same set');
});

test('HL4 #1905 an answered, dismissed or self-dismissed hand link is not delivered, and is not counted as more', () => {
  const links = [hand(1, { mine: 'confirmed' }), hand(2, { status: 'dismissed' }), hand(3, { mine: 'dismissed' }), hand(4)];
  assert.deepEqual(ids(selectDeliveries(links, { unanswered: true })), [hex(4)], 'a read: only the one she has not answered');
  assert.deepEqual(ids(selectDeliveries(links)), [hex(1), hex(4)], 'a claim: her confirm still shows, dismissals never');
  const eleven = Array.from({ length: 11 }, (_, i) => hand(i + 1, { attachedAt: `2026-11-15T10:${String(i).padStart(2, '0')}:00.000Z`, mine: i < 3 ? 'confirmed' : null }));
  const set = selectDeliverySet(eleven, { unanswered: true });
  assert.deepEqual({ n: set.items.length, more: set.moreAttached }, { n: 8, more: 0 }, 'the three answered ones are filtered BEFORE the bound');
});

test('HL5 #1905 the block names how many more hand links there are and the call that lists them; absent when none', () => {
  const block = deliveryBlock({ items: [hand(1)], shortId: 1902, sources: new Map(), moreAttached: 3 });
  assert.equal(block.moreAttached.count, 3);
  assert.deepEqual(block.moreAttached.read, { tool: 'link_list', args: { card: 1902 } });
  assert.match(block.moreAttached.says, /3 more/);
  assert.equal('moreAttached' in deliveryBlock({ items: [hand(1)], shortId: 1902, sources: new Map(), moreAttached: 0 }), false);
  assert.equal('moreAttached' in deliveryBlock({ items: [hand(1)], shortId: 1902, sources: new Map() }), false);
});

test('HL6 #1905 the machine lane comes first, then the hand lane', () => {
  const got = selectDeliveries([hand(1), link(21, { score: 0.9 }), hand(2), link(22, { score: 0.8 })]);
  assert.deepEqual(ids(got), [hex(21), hex(22), hex(1), hex(2)]);
});
