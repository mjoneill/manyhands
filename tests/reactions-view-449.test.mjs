/**
 * #449 session 2 — the chip row under a post (core/reactions-view.mjs), rendered into jsdom. What a reader sees and what a
 * click does, not how it is built:
 *
 *   V1  CHIPS: one per emoji, in the server's order, with its count; yours is marked (aria-pressed) and named "You", first.
 *   V2  WHO REACTED: the names are on the chip for hover (title) and for a screen reader or keyboard (aria-label).
 *   V3  A CLICK TOGGLES YOURS: clicking a chip you gave removes it; clicking one you didn't adds it. Nothing else is sent.
 *   V4  THE PICKER: ☺+ opens the six-emoji palette; a pick reacts (or removes one you already gave) and closes it; Escape closes it.
 *   V5  NO STORE, NO BUTTON: with reactions not enabled, or no viewer identity, chips still show but nothing can be clicked.
 *   V6  URLS: the batch read never names more than 200 posts in one URL, and never names one twice.
 *   V7  SAFE: a reactor name that looks like markup is shown as text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderReactionRow, reactionsUrls, chipsView, REACTION_PALETTE } from '../core/reactions-view.mjs';

const NAMES = { ada: 'Ada', gizmo: 'Gizmo', board: 'Board' };
const nameOf = (k) => NAMES[k] || k;
function mount(opts) {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const doc = window.document;
  const calls = [];
  const row = renderReactionRow(doc, { postId: 'p1', nameOf, enabled: true, onToggle: (emoji, on) => calls.push([emoji, on]), ...opts });
  doc.body.appendChild(row);
  return { doc, row, calls, chips: () => [...row.querySelectorAll('.cv-reaction')] };
}
const SERVER = [{ emoji: '😂', by: ['gizmo', 'ada'] }, { emoji: '👍', by: ['board'] }];

test('V1 CHIPS: one per emoji in order, with counts; yours is marked and named You, first', () => {
  const { chips } = mount({ chips: SERVER, me: 'ada' });
  assert.deepEqual(chips().map((b) => [b.querySelector('.cv-reaction-emoji').textContent, b.querySelector('.cv-reaction-count').textContent, b.getAttribute('aria-pressed')]),
    [['😂', '2', 'true'], ['👍', '1', 'false']]);
  assert.match(chips()[0].title, /^You and Gizmo reacted with 😂$/);
});

test('V2 WHO REACTED: names on the chip for hover and for a screen reader', () => {
  const { chips } = mount({ chips: [{ emoji: '👏', by: ['ada', 'gizmo', 'board'] }], me: null });
  const b = chips()[0];
  assert.equal(b.title, 'Ada, Gizmo and Board reacted with 👏');
  assert.ok(b.getAttribute('aria-label').startsWith('Ada, Gizmo and Board reacted with 👏'));
});

test('V3 A CLICK TOGGLES YOURS: off for one you gave, on for one you did not', () => {
  const { chips, calls } = mount({ chips: SERVER, me: 'ada' });
  chips()[0].click();
  chips()[1].click();
  assert.deepEqual(calls, [['😂', false], ['👍', true]]);
});

test('V4 THE PICKER: opens the palette, a pick reacts or removes yours and closes it, Escape closes it', () => {
  const { row, calls, doc } = mount({ chips: SERVER, me: 'ada' });
  const add = row.querySelector('.cv-reaction-add');
  const picker = row.querySelector('.cv-reaction-picker');
  assert.equal(picker.hidden, true, 'closed until asked');
  add.click();
  assert.equal(picker.hidden, false);
  assert.deepEqual([...picker.querySelectorAll('button')].map((b) => b.textContent), [...REACTION_PALETTE]);
  // by dataset, not a [data-emoji="…"] selector: jsdom's selector engine misses astral-plane characters like 👀 (browsers don't)
  const pick = (emoji) => [...picker.querySelectorAll('button')].find((b) => b.dataset.emoji === emoji);
  pick('👀').click();
  assert.equal(picker.hidden, true, 'a pick closes it');
  add.click();
  pick('😂').click();
  assert.deepEqual(calls, [['👀', true], ['😂', false]], 'picking one you already gave removes it');
  add.click();
  picker.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(picker.hidden, true, 'Escape closes it');
});

test('V5 NO STORE, NO BUTTON: chips show but nothing can be clicked', () => {
  for (const opts of [{ enabled: false, me: 'ada' }, { enabled: true, me: null }]) {
    const { row, chips, calls } = mount({ chips: SERVER, ...opts });
    assert.equal(chips().length, 2, 'the chips still show');
    assert.equal(row.querySelector('.cv-reaction-add'), null, 'no add button');
    chips()[1].click();
    assert.deepEqual(calls, [], 'a click sends nothing');
  }
  const { row } = mount({ chips: [], enabled: false, me: 'ada' });
  assert.equal(row.children.length, 0, 'no chips and no store: an empty row');
});

test('V6 URLS: at most 200 posts per read, none twice', () => {
  const ids = Array.from({ length: 450 }, (_, k) => `p${k}`);
  const urls = reactionsUrls('http://h', [...ids, 'p0', 'p1']);
  assert.equal(urls.length, 3);
  const named = urls.flatMap((u) => new URL(u).searchParams.get('posts').split(','));
  assert.equal(named.length, 450);
  assert.equal(new Set(named).size, 450);
  assert.ok(urls.every((u) => new URL(u).searchParams.get('posts').split(',').length <= 200));
  assert.deepEqual(reactionsUrls('', []), []);
});

test('V7 SAFE: a reactor name that looks like markup is shown as text', () => {
  const { row } = mount({ chips: [{ emoji: '👍', by: ['<img src=x onerror=alert(1)>'] }], me: null, nameOf: (k) => k });
  assert.equal(row.querySelector('img'), null, 'no element was made from the name');
  assert.ok(chipsView([{ emoji: '👍', by: ['<b>x</b>'] }], null)[0].label.includes('<b>x</b>'));
});
