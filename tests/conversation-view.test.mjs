/**
 * #226 — pure core of the shared conversation-view component. The DOM render
 * is covered by commons-e2e.test.mjs (puppeteer); here we pin the two pure
 * helpers the component is built on: query construction (scope → REST URL) and
 * message merge (dedupe + chronological sort, the spine of load + poll).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationsUrl, mergeMessages, tokenizeCardRefs, cardRefHref } from '../core/conversation-view.mjs';

test('conversationsUrl: unscoped commons → bare endpoint (all messages, board parity)', () => {
  assert.equal(conversationsUrl(), '/api/conversations');
  assert.equal(conversationsUrl({}), '/api/conversations');
  // An empty/blank attachedTo is NOT a filter — it means "all".
  assert.equal(conversationsUrl({ attachedTo: '' }), '/api/conversations');
});

test('conversationsUrl: a node id scopes to that thread', () => {
  assert.equal(
    conversationsUrl({ attachedTo: 'node-1' }),
    '/api/conversations?attachedTo=node-1',
  );
  // ids are encoded (defends against odd characters in a uuid-shaped value)
  assert.ok(conversationsUrl({ attachedTo: 'a b' }).includes('attachedTo=a%20b'));
});

test('conversationsUrl: since / before / limit ride along, baseUrl prefixes', () => {
  const url = conversationsUrl({ baseUrl: 'http://x', attachedTo: 'n', since: '2026-01-01', limit: 50 });
  assert.ok(url.startsWith('http://x/api/conversations?'));
  assert.ok(url.includes('attachedTo=n'));
  assert.ok(url.includes('since=2026-01-01'));
  assert.ok(url.includes('limit=50'));
  assert.ok(conversationsUrl({ before: '2026-02-02' }).includes('before=2026-02-02'));
});

test('mergeMessages: dedupes by id, keeps existing on collision', () => {
  const existing = [{ id: 'a', body: 'first', createdAt: '2026-01-01' }];
  const incoming = [
    { id: 'a', body: 'DUPLICATE — should not overwrite', createdAt: '2026-01-01' },
    { id: 'b', body: 'new', createdAt: '2026-01-02' },
  ];
  const merged = mergeMessages(existing, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((m) => m.id === 'a').body, 'first', 'existing wins on id collision');
});

test('mergeMessages: sorts chronologically (oldest first, newest last)', () => {
  const merged = mergeMessages(
    [{ id: 'c', createdAt: '2026-03-03' }],
    [{ id: 'a', createdAt: '2026-01-01' }, { id: 'b', createdAt: '2026-02-02' }],
  );
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
});

test('mergeMessages: drops null / id-less entries (defensive)', () => {
  const merged = mergeMessages(
    [null, { body: 'no id' }, { id: 'ok', createdAt: '2026-01-01' }],
    [undefined, { id: 'ok2', createdAt: '2026-01-02' }],
  );
  assert.deepEqual(merged.map((m) => m.id), ['ok', 'ok2']);
});

// ── #291: tokenizeCardRefs — the pure core of clickable #NNN card refs ────────
// Behavior we pin: a body is split into text + ref tokens so the DOM layer can
// build text-nodes + <a> (never innerHTML). The tokenizer knows nothing about
// which cards exist — it just recognizes the #NNN shape at a word boundary.

test('tokenizeCardRefs: a lone reference splits into text + ref', () => {
  assert.deepEqual(tokenizeCardRefs('see #207'), [
    { type: 'text', value: 'see ' },
    { type: 'ref', shortId: 207, raw: '#207' },
  ]);
});

test('tokenizeCardRefs: #185/#119 → two separate refs (the slash is text)', () => {
  assert.deepEqual(tokenizeCardRefs('#185/#119'), [
    { type: 'ref', shortId: 185, raw: '#185' },
    { type: 'text', value: '/' },
    { type: 'ref', shortId: 119, raw: '#119' },
  ]);
});

test('tokenizeCardRefs: word-boundary — a # glued to a word char is NOT a ref', () => {
  // "abc#5" is mid-token (e.g. a fragment/anchor), not a card ref.
  assert.deepEqual(tokenizeCardRefs('abc#5'), [{ type: 'text', value: 'abc#5' }]);
});

test('tokenizeCardRefs: non-numeric #foo is left as plain text', () => {
  assert.deepEqual(tokenizeCardRefs('a #foo b'), [{ type: 'text', value: 'a #foo b' }]);
});

test('tokenizeCardRefs: XSS-safety — HTML metacharacters stay verbatim as DATA in text tokens', () => {
  // The tokenizer must never emit markup; special chars ride inside text tokens
  // (which the DOM layer renders via createTextNode) so nothing can inject.
  const toks = tokenizeCardRefs('<img src=x onerror=alert(1)> #5');
  assert.deepEqual(toks, [
    { type: 'text', value: '<img src=x onerror=alert(1)> ' },
    { type: 'ref', shortId: 5, raw: '#5' },
  ]);
});

test('tokenizeCardRefs: empty / null / undefined → no tokens', () => {
  assert.deepEqual(tokenizeCardRefs(''), []);
  assert.deepEqual(tokenizeCardRefs(null), []);
  assert.deepEqual(tokenizeCardRefs(undefined), []);
});

test('tokenizeCardRefs: ref at start of string is recognized', () => {
  assert.deepEqual(tokenizeCardRefs('#42 done'), [
    { type: 'ref', shortId: 42, raw: '#42' },
    { type: 'text', value: ' done' },
  ]);
});

test('cardRefHref: builds a board deep-link that scrollToCardByShortId can resolve', () => {
  assert.equal(cardRefHref(207), 'index.html?card=207');
  assert.equal(cardRefHref(185, 'index.html'), 'index.html?card=185');
});

// ── #688 — the string "null" is an absence wearing quotes ──────────────────
// 42 live posts carried attachedTo: "null" (a 4-char string) because one
// client serialized its null. The write boundary must treat it as the null it
// means: a post "attached to" the string "null" is attached to nothing, and
// storing it verbatim makes it invisible to every attachedTo-is-null filter.
import { startRestServer as srv688, makeBoardFixture as fix688 } from './helpers/harness.mjs';

test('#688: attachedTo "null" (string) is stored as null, not as a phantom card ref', async () => {
  const s = await srv688({ board: fix688({ cards: [], conversations: [] }) });
  try {
    const mk = (attachedTo) => fetch(`${s.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x', author: 'ada', attachedTo }),
    }).then((r) => r.json());
    assert.equal((await mk('null')).attachedTo, null, 'the string "null" means null');
    assert.equal((await mk(undefined)).attachedTo, null, 'absent stays null');
    assert.equal((await mk('some-uuid')).attachedTo, 'some-uuid', 'real refs untouched');
  } finally {
    await s.stop();
  }
});
