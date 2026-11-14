/**
 * #1689 — ambient recall in the browser: the pure rules behind the line under a room post and the Reading page's
 * "what have we read about…" box. The drawn result is covered by commons-e2e.test.mjs (puppeteer); here, without a
 * browser, the rules that keep untrusted text from becoming a link or markup.
 *
 *   L1  a recall row links ONLY to `/reading.html?run=run-<lowercase uuid>` and nothing after it; the href is rebuilt
 *       from the matched run id and carries `from=recall&post=<post id>`
 *   L2  `unavailable`, an absent field, a malformed field and empty items show nothing in the room; at most two items
 *   L3  the date reads "Nov 14"; a missing or broken date is null, never "Invalid Date"
 *   L4  the module and both pages never build markup from recall text: no innerHTML on any recall path
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RUN_ID_RE, runOfReadingPage, recallHref, recallItems, recallDateLabel, recallBlock } from '../core/recall-line.mjs';

const RUN = 'run-44d706e1-16af-4a45-8671-d4baef63563b';
const PAGE = `/reading.html?run=${RUN}`;
const item = (extra = {}) => ({
  source: { title: 'How Complex Systems Fail', url: 'urn:sha256:' + 'a'.repeat(64) },
  readingPage: PAGE, readAt: '2026-11-14T15:45:51.430Z',
  why: { gist: 'Root cause is blame.', quote: 'post-accident attribution to a root cause is fundamentally wrong', quoteTruncated: false, claim: 'https://scrumboard.local/assertion/x' },
  score: 0.635, ...extra,
});

test('L1 a recall row links only to one run\'s reading page, rebuilt from the run id, with from=recall&post=', () => {
  assert.equal(runOfReadingPage(PAGE), RUN);
  assert.equal(recallHref(PAGE, 'm-1'), `/reading.html?run=${RUN}&from=recall&post=m-1`);
  assert.equal(recallHref(PAGE, 'a b&c'), `/reading.html?run=${RUN}&from=recall&post=a%20b%26c`, 'the post id is encoded');
  for (const bad of [
    null, undefined, 42, '', RUN, `reading.html?run=${RUN}`, `/reading.html?run=${RUN.toUpperCase()}`, `${PAGE}&x=1`, `${PAGE} `,
    ` ${PAGE}`, `${PAGE}\n`, `https://evil.example${PAGE}`, `//evil.example${PAGE}`, `javascript:alert(1)//${PAGE}`,
    `/reading.html?run=run-44d706e1`, `/settings.html?run=${RUN}`, `/reading.html?x=1&run=${RUN}`, `${PAGE}#frag`,
  ]) {
    assert.equal(recallHref(bad, 'm-1'), null, `no link for ${JSON.stringify(bad)}`);
  }
  assert.equal(RUN_ID_RE.test(RUN), true);
  assert.equal(RUN_ID_RE.test(`${RUN}\n`), false, 'a trailing newline is not a run id');
});

test('L2 the room shows nothing for unavailable, absent, malformed or empty recall, and at most two items', () => {
  for (const post of [{}, { recall: null }, { recall: 'x' }, { recall: { unavailable: 'model down' } }, { recall: { unavailable: '', items: [item()] } },
    { recall: { items: [] } }, { recall: { items: 'nope' } }, { recall: { items: [null, 7, {}] } }]) {
    assert.deepEqual(recallItems(post), [], JSON.stringify(post));
  }
  const three = recallItems({ recall: { items: [item(), item({ source: { title: 'B' } }), item({ source: { title: 'C' } })] } });
  assert.deepEqual(three.map((x) => x.title), ['How Complex Systems Fail', 'B'], 'the contract says at most two; a third is not drawn');
  const [one] = recallItems({ recall: { items: [item()] } });
  assert.equal(one.gist, 'Root cause is blame.');
  assert.equal(one.quote, 'post-accident attribution to a root cause is fundamentally wrong');
  assert.ok(!('url' in one), 'a source url never reaches the room line');
});

test('L3 the date of a reading reads as month and day; a broken date is null', () => {
  assert.equal(recallDateLabel('2026-11-14T15:45:51.430Z', 'en-US'), 'Nov 14');
  for (const bad of [null, undefined, '', 'yesterday', 12345]) assert.equal(recallDateLabel(bad, 'en-US'), null);
});

test('L3b no item is drawn as an empty row, and a post with nothing to show gets no node at all', () => {
  const doc = { createElement() { throw new Error('nothing should be built'); } };
  assert.equal(recallBlock(doc, { id: 'm', body: 'hi' }), null);
  assert.equal(recallBlock(doc, { id: 'm', recall: { unavailable: 'down' } }), null);
});

test('L4 no recall path builds markup from text: no innerHTML in the module, and the pages build rows with textContent', () => {
  const mod = fs.readFileSync(new URL('../core/recall-line.mjs', import.meta.url), 'utf8');
  for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /setAttribute\(\s*['"]href/]) {
    assert.ok(!bad.test(mod), `recall-line.mjs must not use ${bad}`);
  }
  const cv = fs.readFileSync(new URL('../core/conversation-view.mjs', import.meta.url), 'utf8');
  assert.match(cv, /recallBlock\(doc, c\)/, 'the room view draws recall through the shared builder');
  const reading = fs.readFileSync(new URL('../reading.html', import.meta.url), 'utf8');
  assert.match(reading, /from '\.\/core\/recall-line\.mjs'/, 'the Reading page shares the run-id and link rules');
  assert.match(reading, /\/api\/recall\/opened/);
});
