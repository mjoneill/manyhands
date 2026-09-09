/**
 * #1332 — WHERE IS THE CURRENT STATE ON THIS CARD?
 *
 * Measured over all 1,204 cards on 2026-09-09: of the twenty longest, the
 * newest dated block sits in the FIRST quarter 13 times and the LAST quarter 5.
 * Always-read-the-head is wrong ~25% of the time; always-read-the-tail — which
 * is what I did on #1268, re-deriving a finding its head recorded as shipped —
 * is wrong ~65%. Nothing in the artifact says which kind you are holding.
 *
 * ⭐ SO THE CONTROLS BELOW ARE A PAIR AND NEITHER IS OPTIONAL. A mechanism that
 * only resolves head-newest cards handles 65% of the population and has ENCODED
 * the bug; one that returns a constant passes any single-direction test. The
 * two fixtures differ ONLY in where the newest block sits, and the same call
 * must give opposite answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { cardOutline } from '../core/card-outline.mjs';

const filler = (n) => 'x '.repeat(n);

/** Correction PREPENDED as a blockquote — this board's convention for a retraction. */
const HEAD_NEWEST = [
  '> # ⛔ CORRECTION 2026-09-09T18:17Z — the premise below is false',
  '> the newest thing on this card is its first line.',
  filler(400),
  '## Original finding 2026-08-01T09:00Z',
  filler(400),
  '### A detail 2026-07-15',
  filler(400),
].join('\n');

/** Working notes APPENDED — the same board's convention for evidence. */
const TAIL_NEWEST = [
  '# Original finding 2026-07-15T09:00Z',
  filler(400),
  '## Evidence 2026-08-01T12:00Z',
  filler(400),
  '## ⇒ MEASURED 2026-09-09T18:17Z — the newest thing is the last block',
  filler(400),
].join('\n');

const newestIndex = (sections) => {
  const dated = sections.map((s, i) => ({ i, at: s.at })).filter((s) => s.at);
  return dated.reduce((a, b) => (b.at > a.at ? b : a)).i;
};

test('#1332 blockquoted headings are indexed — corrections are PREPENDED as `> #` here', () => {
  const { sections } = cardOutline('> ## ⛔ CORRECTION 2026-09-09\nbody\n## Ordinary 2026-08-01');
  assert.equal(sections.length, 2, 'a naive /^#/ finds only the ordinary heading');
  assert.match(sections[0].text, /CORRECTION/);
  // ⛔ The regression this pins: indexing only bare headings would MISS every
  // correction block, i.e. exactly what a reader wants when asking what is true
  // now. The feature would demo perfectly and be useless on the motivating cards.
});

test('#1332 POSITIVE CONTROL — head-newest card resolves to its FIRST section', () => {
  const { sections } = cardOutline(HEAD_NEWEST);
  assert.equal(newestIndex(sections), 0);
});

test('#1332 NEGATIVE CONTROL — tail-newest card resolves to its LAST section', () => {
  const { sections } = cardOutline(TAIL_NEWEST);
  assert.equal(newestIndex(sections), sections.length - 1);
  // ⇒ Same call, opposite answer. A constant-returning implementation passes
  //   one of these two tests and cannot pass both.
});

test('#1332 section spans are true sizes, so a reader sees cost before fetching', () => {
  const { sections, totalChars } = cardOutline(TAIL_NEWEST);
  assert.equal(sections.reduce((n, s) => n + s.chars, 0), totalChars,
    'spans must tile the body exactly — a gap would hide content from the reader');
  assert.ok(sections.every((s) => s.chars > 0));
});

test('#1332 `at` is absent when a heading carries no date — never inferred from position', () => {
  const { sections } = cardOutline('## no date here\nbody');
  assert.equal(sections[0].at, undefined);
});

test('#1332 the outline REPLACES the description over REST, and says what it cost', async () => {
  const board = makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 'long one', description: TAIL_NEWEST,
      column: 'backlog', createdAt: '2026-07-15T09:00:00Z', updatedAt: '2026-09-09T18:17:00Z',
    }],
    nextShortId: 2,
  });
  const server = await startRestServer({ board });
  try {
    const plain = await (await fetch(`${server.baseUrl}/api/cards/1`)).json();
    assert.equal(typeof plain.description, 'string', 'the default response is unchanged');

    const out = await (await fetch(`${server.baseUrl}/api/cards/1?outline=1`)).json();
    // ⛔ #794's rule: this must not ACCOMPANY the body. An outline shipped
    // beside a 33KB description costs more than it saves and still reads as a win.
    assert.equal(out.description, undefined, 'outline must REPLACE the description');
    assert.equal(out.descriptionChars, TAIL_NEWEST.length, 'and report the cost declined');
    assert.equal(out.shortId, 1);
    assert.ok(out.outline.sections.length >= 3);
    assert.equal(newestIndex(out.outline.sections), out.outline.sections.length - 1);
    assert.ok(JSON.stringify(out).length < TAIL_NEWEST.length,
      'the whole outline response must be smaller than the body it stands in for');
  } finally { await server.stop(); }
});

test('#1332 the outline is DERIVED — the stored card never acquires it', async () => {
  const board = makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 't', description: HEAD_NEWEST,
      column: 'backlog', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    }],
    nextShortId: 2,
  });
  const server = await startRestServer({ board });
  try {
    await (await fetch(`${server.baseUrl}/api/cards/1?outline=1`)).json();
    const after = await (await fetch(`${server.baseUrl}/api/cards/1`)).json();
    assert.equal(after.description, HEAD_NEWEST, 'body unchanged by an outline read');
    assert.equal(after.outline, undefined, 'and no derived field survives onto the card');
    assert.equal(after.descriptionChars, undefined);
  } finally { await server.stop(); }
});

/**
 * ⛔ FENCED CODE — reviewing 8f76600.
 *
 * She measured before judging: of the 542 cards over 5KB, 15 carry phantom
 * headings, 44 in total, and on ZERO cards is a phantom the newest dated
 * section. A real defect that could not, today, produce a wrong answer.
 *
 * ⭐ Her sharper finding is about my suite, not my code: "a mutation suite tests
 * the code you wrote against the INPUTS YOU IMAGINED." My five mutations were
 * ordering and truncation. None could surface this, because no fixture had a
 * fence. The severity test below is the one that would have failed.
 */
test('#1332 a `#` line inside a fence is NOT a heading', () => {
  const body = [
    '# Real heading',
    '```', '# tests 2805', '# pass 2803', '```',
    '## Another real',
    '```bash', '# a shell comment', '```',
  ].join('\n');
  const { sections, headingsFound } = cardOutline(body);
  assert.equal(headingsFound, 2, 'three phantoms would make this 5');
  assert.deepEqual(sections.map((x) => x.text), ['Real heading', 'Another real']);
});

test('#1332 SEVERITY — a DATED line in a fence must never become the newest section', () => {
  // ⇒ The case that review's measurement showed does not occur today and the
  //   mechanism permits: a fenced line with a later date wins `newest` and
  //   sends the reader into a code block — the one thing this index exists
  //   to get right.
  const body = [
    '## Genuine current state 2026-09-09',
    'body',
    '```', '# 2026-09-10 tomorrow in a code block', '```',
  ].join('\n');
  const { sections } = cardOutline(body);
  assert.equal(sections.length, 1);
  assert.equal(newestIndex(sections), 0, 'the fenced future date must not win');
});

test('#1332 fences close only on a matching, no-shorter delimiter — and count inside a quote', () => {
  // A longer closing fence is legal; a shorter one does not close, and ~~~ does
  // not close ```. Corrections are quoted here, so `> ```' is still a fence.
  const mixed = ['```', '# hidden', '~~~', '# still hidden', '````', '# real after close'].join('\n');
  assert.deepEqual(cardOutline(mixed).sections.map((s) => s.text), ['real after close']);
  const quoted = ['> ```', '> # hidden in a quoted fence', '> ```', '> ## visible'].join('\n');
  assert.deepEqual(cardOutline(quoted).sections.map((s) => s.text), ['visible']);
});

test('#1332 truncation is confessed, and spans stay true across the cut', () => {
  const many = Array.from({ length: 12 }, (_, i) => `## H${i} 2026-08-0${(i % 9) + 1}\nbody`).join('\n');
  const r = cardOutline(many, { maxSections: 5 });
  assert.equal(r.sections.length, 5);
  assert.equal(r.headingsFound, 12);
  assert.equal(r.truncated, true, 'a capped list that does not say so is a silent partial answer');
  // spans were computed over ALL headings before the cut, so section 4 does not
  // silently absorb the seven that were dropped
  assert.ok(r.sections[4].chars < many.length / 2);
});
