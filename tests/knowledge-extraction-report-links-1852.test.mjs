/**
 * #1852 (supply) — the finish post says which of our cards a run's claims may bear on. The extractor now links each run it
 * publishes; the post is where a person and a seat first SEE that, so it shows the few strongest links, counts the rest, and
 * points at the run's readable page. A run that could not be linked says so in one line: "no link" must never be able to
 * mean "never searched" (#1851), in the post as in the linker.
 *
 * INTERFACE PINNED HERE: finishBody({ url, result, links }) where `links` is what the extractor's linking step returned:
 *   { made:true, minScore, assertions, proposed, skipped, links:[{ shortId, title, score, gist, card }] }
 *   { made:false, reason }
 *   absent or null: the run was not linked at all (it published nothing, or the caller has no linker) and the post is as before
 *
 *   F1  with links: up to three "may bear on" lines, the total, and the page line are ADDED; every line the post had before is
 *       still there, unchanged and in order (the exact text is pinned)
 *   F2  the three shown are the highest scores, at most one per card; a long title is cut near 60 characters and a long gist
 *       is cut too; the line carries the GIST, never the subject—verb→object triple
 *   F3  nothing proposed: ONE line saying no claim matched a card at or above the threshold, naming the threshold and how many
 *       claims were searched
 *   F3b nothing NEW because every match already had a link: said as that, never as "none matched"
 *   F4  links not made: ONE short line with the reason, on one line however the reason arrived
 *   F5  the page line is /reading.html?run=<the last segment of the run IRI>; a card number in a link line becomes a card
 *       link in the commons (the renderer's own #NNN rule), and no added line turns into a bullet
 *   F6  no `links`: the post is byte-identical to the one #1862 wrote
 *   F7  the addition is bounded: forty links with very long titles and gists add at most five lines, none of them long
 *
 * Sabotage, 2026-11-14: showing a card once per link instead of once turns F1 and F2 red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishBody, ofRunQuery } from '../core/knowledge-extraction-report.mjs';
import { renderChatMarkdown } from '../core/render.mjs';

const URL1 = 'https://example.test/articles/harness';
const RUN = 'https://scrumboard.local/activity/run-44d706e1-16af-4a45-8671-d4baef63563b';
const result = {
  runId: RUN, outcome: 'partial', proposals: 5, counters: { spanInventions: 2, providerFailures: 0 }, repairs: 3,
  published: [
    { iri: 'a1', block: 1, type: 'definition', predicate: 'scrum:relatedTo', subject: 'harness', object: 'model' },
    { iri: 'a2', block: 2, type: 'empirical', predicate: 'scrum:relatedTo', subject: 'harness', object: 'tools' },
    { iri: 'a3', block: 4, type: 'recommendation', predicate: 'schema:about', subject: 'Tools', object: 'action' },
  ],
  rejected: [{ iri: 'r1', reason: 'span-mismatch', detail: 'x' }, { iri: 'r2', reason: 'span-mismatch', detail: 'y' }],
};
const link = (shortId, score, gist, title = `Card ${shortId}`) => ({ shortId, title, score, gist, card: `uuid-${shortId}` });
const made = (links, extra = {}) => ({ made: true, minScore: 0.6, assertions: 3, proposed: links.length, skipped: 0, links, ...extra });
const SEVEN = [
  link(1319, 0.681, 'a harness is the layer between a model and the world', 'Keep the injected top layer small'),
  link(1406, 0.755, 'tools are how a model acts', 'Seats reach for tools they were never handed'),
  link(1319, 0.702, 'the harness decides what the model sees'),
  link(327, 0.64, 'a harness should recommend the next action'),
  link(88, 0.61, 'tools are how a model acts'),
  link(1406, 0.605, 'a harness should recommend the next action'),
  link(512, 0.601, 'a harness is the layer between a model and the world'),
];

test('F1 with links the post gains three link lines, the total and the page line; every earlier line is unchanged and in order', () => {
  const before = finishBody({ url: URL1, result });
  const body = finishBody({ url: URL1, result, links: made(SEVEN) });
  assert.equal(body, [
    `✅ extraction finished (partial): ${URL1}`,
    'wrote 3 assertions about 4 concepts · by type: definition 1, empirical 1, recommendation 1 · by predicate: scrum:relatedTo 2, schema:about 1',
    '  harness —scrum:relatedTo→ model (definition, block 1)',
    '  harness —scrum:relatedTo→ tools (empirical, block 2)',
    '  Tools —schema:about→ action (recommendation, block 4)',
    '2 rejected: span-mismatch 2',
    '5 proposed · span repairs 3 · span inventions 2 · provider failures 0',
    '🔗 may bear on #1406 Seats reach for tools they were never handed: "tools are how a model acts"',
    '🔗 may bear on #1319 Card 1319: "the harness decides what the model sees"',
    '🔗 may bear on #327 Card 327: "a harness should recommend the next action"',
    '7 proposed links to 5 cards (machine guesses; answer them with link_decide)',
    `run ${RUN}`,
    `open it with graph_query: ${ofRunQuery(RUN)}`,
    'read it on the board: /reading.html?run=run-44d706e1-16af-4a45-8671-d4baef63563b',
    '(#1862)',
  ].join('\n'));
  const added = body.split('\n').filter((l) => /^🔗 |proposed links? to|^read it on the board/.test(l));
  assert.equal(added.length, 5);
  assert.deepEqual(body.split('\n').filter((l) => !added.includes(l)), before.split('\n'), 'the lines #1862 wrote are all still there, as they were');
});

test('F2 the highest scores are shown, one per card; long titles and gists are cut; the line carries the gist, never the triple', () => {
  const long = 'A card whose title runs on well past any width a room post should give to one card title, on and on';
  const gist = `the harness ${'keeps the layer between a model and the world small and '.repeat(6)}plain`;
  const body = finishBody({ url: URL1, result, links: made([link(7, 0.9, gist, long), link(7, 0.95, 'the stronger claim on the same card', long), link(8, 0.7, 'second card')]) });
  const lines = body.split('\n').filter((l) => l.startsWith('🔗 '));
  assert.equal(lines.length, 2, 'two cards, two lines: the same card is not shown twice');
  assert.match(lines[0], /^🔗 may bear on #7 .*: "the stronger claim on the same card"$/, 'a card is shown by its strongest link');
  const title = lines[0].slice('🔗 may bear on #7 '.length, lines[0].indexOf(': "'));
  assert.ok(title.length <= 61 && title.endsWith('…') && long.startsWith(title.slice(0, -1).trimEnd()), `the title is cut near 60 characters: ${JSON.stringify(title)}`);
  assert.match(body, /3 proposed links to 2 cards/);
  const one = finishBody({ url: URL1, result, links: made([link(7, 0.9, gist)]) }).split('\n').find((l) => l.startsWith('🔗 '));
  assert.ok(one.length < 260 && one.endsWith('…"'), `a long gist is cut: ${one.length} characters`);
  assert.doesNotMatch(one, /—|→/, 'never the subject—verb→object triple');
  assert.match(finishBody({ url: URL1, result, links: made([link(7, 0.9, 'g')]) }), /^1 proposed link to 1 card \(machine guesses; answer them with link_decide\)$/m);
  // a hit with no number or no title still makes a readable line
  assert.match(finishBody({ url: URL1, result, links: made([{ shortId: null, title: 'Untitled work', score: 0.9, gist: 'g', card: 'u1' }]) }), /^🔗 may bear on Untitled work: "g"$/m);
  assert.match(finishBody({ url: URL1, result, links: made([{ shortId: 9, title: null, score: 0.9, gist: 'g', card: 'u2' }]) }), /^🔗 may bear on #9: "g"$/m);
});

test('F3 nothing proposed: one line naming the threshold and how many claims were searched', () => {
  const body = finishBody({ url: URL1, result, links: made([], { assertions: 3 }) });
  const lines = body.split('\n').filter((l) => /link/i.test(l) && !l.startsWith('open it'));
  assert.deepEqual(lines, ['links: none of the 3 claims matched a card at or above 0.6 (every claim was searched)']);
  assert.doesNotMatch(body, /🔗/);
  assert.match(body, /^read it on the board: \/reading\.html\?run=run-44d706e1/m, 'the page is still pointed at');
});

test('F3b nothing new because every match already had a link: said as that, never as "none matched"', () => {
  const body = finishBody({ url: URL1, result, links: made([], { assertions: 3, skipped: 4 }) });
  assert.match(body, /^links: no new ones; 4 matches at or above 0\.6 already had a link \(proposed, confirmed or dismissed\)$/m);
  assert.doesNotMatch(body, /none of the/);
});

test('F4 links not made: one short line with the reason', () => {
  const body = finishBody({ url: URL1, result, links: { made: false, reason: 'search unavailable for https://scrumboard.local/assertion/a1: embedder unavailable\n  Nothing was searched.' } });
  const line = body.split('\n').find((l) => l.startsWith('links:'));
  assert.equal(line, 'links: not made (search unavailable for https://scrumboard.local/assertion/a1: embedder unavailable Nothing was searched.)');
  assert.doesNotMatch(body, /🔗|proposed links/);
  const huge = finishBody({ url: URL1, result, links: { made: false, reason: 'x'.repeat(2000) } }).split('\n').find((l) => l.startsWith('links:'));
  assert.ok(huge.length < 260, `a long reason is cut (${huge.length})`);
  assert.match(finishBody({ url: URL1, result, links: { made: false } }), /^links: not made \(no reason given\)$/m);
});

test('F5 the page line names the run by its last segment; a card number is a card link in the commons; no added line becomes a bullet', () => {
  const body = finishBody({ url: URL1, result: { ...result, runId: 'https://scrumboard.local/activity/run-abc' }, links: made(SEVEN) });
  assert.match(body, /^read it on the board: \/reading\.html\?run=run-abc$/m);
  const html = renderChatMarkdown(body);
  assert.ok(html.includes('<a class="cardref" data-shortid="1406" href="index.html?card=1406">#1406</a>'), 'the card number is clickable where the post is read');
  assert.doesNotMatch(html, /<ul>/, 'nothing in the post starts a list');
  // no run to name (a caller that has none): no page line, and nothing invented
  assert.doesNotMatch(finishBody({ url: URL1, result: { ...result, runId: null }, links: made(SEVEN) }), /reading\.html/);
});

test('F6 no links: the post is byte-identical to the one #1862 wrote', () => {
  const before = finishBody({ url: URL1, result });
  assert.equal(finishBody({ url: URL1, result, links: null }), before);
  assert.equal(finishBody({ url: URL1, result, links: undefined }), before);
  assert.doesNotMatch(before, /links|reading\.html|🔗/);
});

test('F7 the addition is bounded: forty links with very long titles and gists add at most five short lines', () => {
  const many = Array.from({ length: 40 }, (_, k) => link(100 + k, 0.6 + k / 1000, 'g'.repeat(900), 't'.repeat(400)));
  const before = finishBody({ url: URL1, result }).split('\n');
  const after = finishBody({ url: URL1, result, links: made(many) }).split('\n');
  const added = after.filter((l) => !before.includes(l));
  assert.equal(added.length, 5);
  for (const l of added) assert.ok(l.length < 260, `${l.length}: ${l.slice(0, 80)}`);
  assert.match(after.join('\n'), /40 proposed links to 40 cards/);
});
