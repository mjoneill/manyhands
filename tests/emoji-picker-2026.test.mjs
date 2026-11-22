/**
 * #2026 — choosing any emoji, not only the six. The pure parts, in node:
 *
 *   P1  WHAT COUNTS AS AN EMOJI: exactly one RGI emoji (skin tones, flags and ZWJ sequences included); a letter, an empty
 *       string, two emoji or trailing text do not. A bare ❤ (no U+FE0F) normalises to the ❤️ the picker sends.
 *   P2  THE ROOM'S TOP SIX (the 2026-11-22 decision): count the live reactions of the window by emoji, most used
 *       first, a tie going to the more recently used; the picker's first row is that top six, padded from the default
 *       six while the room has little history, never the same emoji twice.
 *   P3  SEARCH BY NAME: case-insensitive, every word must match; "croc" finds 🐊; an empty query is the whole table.
 *   P4  THE TABLE: every entry is an emoji the server accepts, named, none twice; it holds the six and 🐊 "crocodile".
 *   V8  THE PICKER (jsdom): the first row is the room's top six; "more" opens a search box and a grid; typing filters it;
 *       a pick reacts with that emoji and closes the picker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { REACTION_PALETTE, isReactionEmoji, normalizeReactionEmoji, topEmoji, topRow, searchEmoji } from '../core/reaction-palette.mjs';
import { EMOJI_NAMES, EMOJI_NAMES_UNICODE_VERSION } from '../core/emoji-names.mjs';
import { renderReactionRow } from '../core/reactions-view.mjs';

test('P1 WHAT COUNTS AS AN EMOJI', () => {
  for (const s of ['👍', '🐊', '👍🏽', '🇺🇸', '🤷‍♀️', '❤️']) assert.equal(isReactionEmoji(s), true, `${s} is one emoji`);
  for (const s of ['a', '', '👍👍', '👍 ', ' 👍', '1', '#', null, undefined, 42]) assert.equal(isReactionEmoji(s), false, `${JSON.stringify(s)} is not`);
  assert.equal(normalizeReactionEmoji('❤'), '❤️', 'a bare heart becomes the heart the picker sends');
  assert.equal(normalizeReactionEmoji('🐊'), '🐊', 'an emoji already whole is unchanged');
  assert.equal(normalizeReactionEmoji('a'), null, 'a non-emoji normalises to nothing');
});

test('P2 THE ROOM\'S TOP SIX', () => {
  const r = (emoji, at) => ({ emoji, at });
  const window = [r('👀', '2026-11-01T00:00:00Z'), r('🐊', '2026-11-02T00:00:00Z'), r('🐊', '2026-11-03T00:00:00Z'),
    r('🍑', '2026-11-04T00:00:00Z'), r('👀', '2026-11-05T00:00:00Z'), r('😈', '2026-11-06T00:00:00Z'), r('x', '2026-11-07T00:00:00Z')];
  assert.deepEqual(topEmoji(window, 6), [{ emoji: '👀', count: 2 }, { emoji: '🐊', count: 2 }, { emoji: '😈', count: 1 }, { emoji: '🍑', count: 1 }],
    'most used first; a tie goes to the one used more recently; a non-emoji is never counted');
  assert.equal(topEmoji(window, 2).length, 2, 'capped at n');
  assert.deepEqual(topRow([]), [...REACTION_PALETTE], 'no history: the original six');
  assert.deepEqual(topRow(['🐊', '👀']), ['🐊', '👀', '👍', '❤️', '😂', '🤷'], 'the room\'s top first, padded from the six, no repeat');
  assert.deepEqual(topRow(['x', null, '🐊']), ['🐊', ...REACTION_PALETTE.slice(0, 5)], 'junk is dropped');
  assert.equal(topRow(['🍑', '🍆', '💦', '🐊', '😈', '🧠', '👀']).length, 6, 'always six');
});

test('P3 SEARCH BY NAME', () => {
  const table = [['🐊', 'crocodile'], ['😂', 'face with tears of joy'], ['😹', 'cat face with tears of joy'], ['👍', 'thumbs up sign']];
  assert.deepEqual(searchEmoji(table, 'croc'), ['🐊']);
  assert.deepEqual(searchEmoji(table, 'JOY'), ['😂', '😹'], 'case does not matter');
  assert.deepEqual(searchEmoji(table, 'cat joy'), ['😹'], 'every word must match');
  assert.deepEqual(searchEmoji(table, '  '), table.map(([e]) => e), 'an empty query is the whole table');
  assert.deepEqual(searchEmoji(table, 'zebra'), []);
});

test('P4 THE TABLE', () => {
  assert.match(EMOJI_NAMES_UNICODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(EMOJI_NAMES.length > 1000, `a full set, not a sample (${EMOJI_NAMES.length})`);
  const seen = new Set();
  for (const [e, name] of EMOJI_NAMES) {
    assert.equal(isReactionEmoji(e), true, `${e} is accepted by the server`);
    assert.ok(typeof name === 'string' && name.length, `${e} has a name`);
    assert.ok(!seen.has(e), `${e} once`); seen.add(e);
  }
  for (const e of REACTION_PALETTE) assert.ok(seen.has(e), `the six are browsable too: ${e}`);
  assert.deepEqual(EMOJI_NAMES.find(([e]) => e === '🐊'), ['🐊', 'crocodile']);
  assert.deepEqual(EMOJI_NAMES[0], ['😀', 'grinning face'], 'browsing opens on faces, as pickers do, not on ⏩ or ♈');
});

test('V8 THE PICKER: the room\'s top row first, "more" opens search and a grid, typing filters, a pick reacts and closes', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const doc = window.document;
  const calls = [];
  const table = [['🐊', 'crocodile'], ['😂', 'face with tears of joy'], ['🦖', 't-rex']];
  const row = renderReactionRow(doc, { postId: 'p1', chips: [], me: 'ada', enabled: true, onToggle: (e, on) => calls.push([e, on]),
    top: ['🐊'], loadNames: async () => table });
  doc.body.appendChild(row);
  row.querySelector('.cv-reaction-add').click();
  const picker = row.querySelector('.cv-reaction-picker');
  const firstRow = [...picker.querySelectorAll('.cv-reaction-top .cv-reaction-pick')].map((b) => b.dataset.emoji);
  assert.deepEqual(firstRow, topRow(['🐊']), 'the first row is the room\'s top six');
  const browse = picker.querySelector('.cv-reaction-browse');
  assert.equal(browse.hidden, true, 'the full set stays closed until asked');
  picker.querySelector('.cv-reaction-more').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(browse.hidden, false, '"more" opens it');
  const grid = () => [...browse.querySelectorAll('.cv-reaction-grid .cv-reaction-pick')].filter((b) => !b.hidden).map((b) => b.dataset.emoji);
  assert.deepEqual(grid(), ['🐊', '😂', '🦖'], 'the whole table before typing');
  const box = browse.querySelector('.cv-reaction-search');
  box.value = 'croc'; box.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(grid(), ['🐊'], 'typing filters it');
  [...browse.querySelectorAll('.cv-reaction-pick')].find((b) => b.dataset.emoji === '🐊').click();
  assert.deepEqual(calls, [['🐊', true]], 'a pick reacts with it');
  assert.equal(picker.hidden, true, 'and closes the picker');
});
