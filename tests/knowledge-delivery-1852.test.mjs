/**
 * #1852 (#1848 slice 3) — DELIVERY: WHICH proposed links a seat is handed with a card, and what each one says. The rules
 * are pure (core/knowledge-delivery.mjs), so they run here with no graph. Nobody goes looking for a proposed link (#1850
 * measured zero finds), so the board hands a few over at the moment of work: when a card is claimed, and the first time a
 * seat reads it.
 *
 * INTERFACE PINNED HERE:
 *   selectDeliveries(links)            links: [{ id, status, score, source, shown, span, gist }] → the card's delivery SET:
 *                                      never dismissed · one per source · at most DELIVERY_MAX (2) · confirmed first, then
 *                                      score descending, then id
 *   firstShowings(set)                 the part of the set this seat has not been shown (card_get shows only that)
 *   deliveryBlock({ items, shortId, sources, recorded }) → { means, items: [{ link, status, gist, quote, quoteTruncated?,
 *                                      source: { title, url }, score, answer: { confirm, dismiss } }], recorded? } | null
 *   quoteOf(span)                      → { quote, truncated }   cut at QUOTE_MAX_CHARS (300) with an ellipsis
 *   sourceOfPassage(passage)           `<source>/block/<n>` → `<source>`; anything else → null
 *   showIri(link, actor)               the ONE node a (seat, link) showing lives at: <link>/shown/<sha256(actor)>
 *
 *   S1  a dismissed link is never delivered
 *   S2  at most two per card
 *   S3  at most one per source: the second link from a source is passed over for the next source's
 *   S4  the order: confirmed before proposed, then the higher score, then the link id
 *   S5  links whose source is not known share ONE slot: two of them are never assumed to be two sources
 *   S6  a link with neither a quote nor a gist is not deliverable
 *   S7  a link the seat herself dismissed is never delivered to her, whatever its status; one she confirmed may be
 *   F1  card_get shows only what the seat has not been shown, and the cap is applied BEFORE that: a re-read does not walk
 *       down the list two at a time
 *   Q1  a long quote is cut at 300 characters with an ellipsis and flagged; a short one is untouched and carries no flag
 *   B1  an item carries the link id, status, gist, quote, source, score and the two exact answering calls, and no triple
 *   B2  the gist falls back to the quote
 *   B3  nothing to deliver → null, so the field is ABSENT, never an empty list
 *   B4  `means` says these are machine proposals found by meaning search, not endorsements, and what a confirm means
 *   B5  `recorded: false` appears only when the showing could not be recorded
 *   B6  a page is never invented
 *   I1  the showing's IRI is fixed by link and seat: the same pair names the same node, another seat another node
 *   P1  the source of a passage
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  selectDeliveries, firstShowings, deliveryBlock, quoteOf, sourceOfPassage, showIri,
  DELIVERY_MAX, QUOTE_MAX_CHARS,
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

test('S4 the order: confirmed before proposed, then the higher score, then the link id', () => {
  const got = selectDeliveries([link(1, { score: 0.9 }), link(2, { score: 0.5, status: 'confirmed' })]);
  assert.deepEqual(ids(got), [hex(2), hex(1)], 'a confirmed link leads a higher-scored proposal');
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

test('F1 card_get shows only what the seat has not been shown, and the cap comes first', () => {
  const set = selectDeliveries([link(1, { score: 0.9, shown: true }), link(2, { score: 0.8 }), link(3, { score: 0.7 })]);
  assert.deepEqual(ids(firstShowings(set)), [hex(2)], 'link 3 is outside the card\'s two, so a re-read never reaches it');
  const seen = selectDeliveries([link(1, { score: 0.9, shown: true }), link(2, { score: 0.8, shown: true }), link(3, { score: 0.7 })]);
  assert.deepEqual(firstShowings(seen), [], 'both of the card\'s two were shown: nothing is new');
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
  const l = link(1, { status: 'confirmed', score: 0.681, source: 'https://scrumboard.local/source/s1' });
  const sources = new Map([['https://scrumboard.local/source/s1', { title: 'A paper', url: 'https://example.org/paper' }]]);
  const b = deliveryBlock({ items: [l], shortId: 42, sources });
  assert.deepEqual(b.items, [{
    link: hex(1), status: 'confirmed', gist: 'the gist of claim 1', quote: 'the verbatim span of claim 1',
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
});

test('B5 `recorded: false` appears only when the showing could not be recorded', () => {
  assert.equal(deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map(), recorded: false }).recorded, false);
  assert.equal('recorded' in deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() }), false);
});

test('B6 a page is never invented', () => {
  const b = deliveryBlock({ items: [link(1)], shortId: 7, sources: new Map() });
  assert.equal('page' in b.items[0], false);
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
