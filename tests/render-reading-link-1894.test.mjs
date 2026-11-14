/**
 * #1894 — ONE address the commons may link: `/reading.html?run=run-<lowercase uuid>`, the page that shows what the board read.
 * Extractor posts carry it as plain text; renderChatMarkdown (core/render.mjs) escapes everything and used to link only #NNN.
 *
 *   W1  the exact address becomes ONE link whose href is built from the matched uuid, with the address as its text
 *   W2  every near miss stays plain, escaped text: no anchor at all
 *   W3  the address works in a sentence (trailing . , ! ? ) and inside a list item, and beside a #NNN ref
 *   W4  #NNN, bold, italic and lists are unchanged (their own tests are render.test.mjs, untouched)
 *   W5  an address inside a word, a URL, or markup is never linked; whatever is emitted, every anchor's href is one of the two shapes
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChatMarkdown } from '../core/render.mjs';

const U = '44d706e1-16af-4a45-8671-d4baef63563b';
const ADDR = `/reading.html?run=run-${U}`;
const anchors = (html) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const hrefs = (html) => anchors(html).map((a) => /href="([^"]*)"/.exec(a)?.[1]);

test('W1 the exact address is one link, href built from the uuid, text is the address', () => {
  const html = renderChatMarkdown(`read it on the board: ${ADDR}`);
  assert.equal(html, `read it on the board: <a class="readinglink" href="${ADDR}">${ADDR}</a>`);
  assert.deepEqual(hrefs(html), [ADDR]);
  assert.equal(renderChatMarkdown(ADDR), `<a class="readinglink" href="${ADDR}">${ADDR}</a>`, 'alone on its line');
});

const NEAR = {
  'another path': `/settings.html?run=run-${U}`,
  'extra query param': `${ADDR}&x=1`,
  'extra query param first': `/reading.html?x=1&run=run-${U}`,
  'absolute url, another host': `https://evil.example${ADDR}`,
  'absolute url, protocol-relative': `//evil.example${ADDR}`,
  'absolute url, with a port': `http://127.0.0.1:3141${ADDR}`,
  'uppercase uuid': `/reading.html?run=run-${U.toUpperCase()}`,
  'uppercase RUN': `/reading.html?run=RUN-${U}`,
  'one uppercase hex digit': `/reading.html?run=run-${U.replace('d706', 'D706')}`,
  'short uuid': `/reading.html?run=run-${U.slice(0, -1)}`,
  'non-hex uuid': `/reading.html?run=run-${U.replace(/.$/, 'g')}`,
  'no dashes': `/reading.html?run=run-${U.replaceAll('-', '')}`,
  'no run- prefix': `/reading.html?run=${U}`,
  'trailing tag': `${ADDR}<script>`,
  'trailing letters': `${ADDR}ZZ`,
  'trailing hex letters': `${ADDR}aa`,
  'trailing dot-dot path': `${ADDR}/../x`,
  'trailing slash': `${ADDR}/`,
  'trailing hash': `${ADDR}#frag`,
  'trailing percent': `${ADDR}%2e`,
  'trailing quote': `${ADDR}"onmouseover="x`,
  'javascript: prefix': `javascript:${ADDR}`,
  'data: prefix': `data:text/html,${ADDR}`,
  'a longer path': `/x${ADDR}`,
  'inside a word': `x${ADDR}`,
  'the uuid twice': `${ADDR}-${U}`,
};
for (const [name, text] of Object.entries(NEAR)) {
  test(`W2 near miss stays plain escaped text: ${name}`, () => {
    const html = renderChatMarkdown(text);
    assert.deepEqual(anchors(html), [], `no anchor from ${JSON.stringify(text)}: ${html}`);
    assert.ok(!/<(script|img|iframe)/i.test(html), 'nothing became live markup');
  });
}

test('W3 in a sentence, in a list, and beside a #NNN ref', () => {
  for (const tail of ['.', ',', '!', '?', ')']) {
    assert.deepEqual(hrefs(renderChatMarkdown(`see ${ADDR}${tail} thanks`)), [ADDR], `trailing ${tail}`);
    assert.deepEqual(hrefs(renderChatMarkdown(`see ${ADDR}${tail}`)), [ADDR], `trailing ${tail} at the end`);
  }
  assert.deepEqual(hrefs(renderChatMarkdown(`- one\n- read ${ADDR}\n- three`)), [ADDR]);
  const both = renderChatMarkdown(`#1894 ${ADDR}`);
  assert.deepEqual(hrefs(both), ['index.html?card=1894', ADDR]);
  assert.deepEqual(hrefs(renderChatMarkdown(`${ADDR} and ${ADDR.replace('44d7', '55d7')}`)), [ADDR, ADDR.replace('44d7', '55d7')]);
});

test('W4 #NNN, bold, italic and lists are unchanged', () => {
  assert.equal(renderChatMarkdown('see #12 and **bold** and *it*'), 'see <a class="cardref" data-shortid="12" href="index.html?card=12">#12</a> and <strong>bold</strong> and <em>it</em>');
  assert.equal(renderChatMarkdown("it's #39"), 'it&#39;s <a class="cardref" data-shortid="39" href="index.html?card=39">#39</a>');
  assert.equal(renderChatMarkdown('word#3 &#39;'), 'word#3 &amp;#39;');
  assert.equal(renderChatMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderChatMarkdown('a\nb'), 'a<br>b');
  assert.equal(renderChatMarkdown(`<b>${ADDR}</b>`).includes('<b>'), false, 'markup around it is still escaped');
});

test('W5 whatever is emitted, every anchor is a card link or exactly the reading address built from a lowercase uuid', () => {
  const nasty = [...Object.values(NEAR), ADDR, `**${ADDR}**`, `*${ADDR}*`, `[x](${ADDR})`, `"${ADDR}"`, `'${ADDR}'`, `<${ADDR}>`, `a ${ADDR}\n${ADDR}`];
  for (const t of nasty) {
    for (const h of hrefs(renderChatMarkdown(t))) {
      assert.ok(/^index\.html\?card=\d+$/.test(h) || /^\/reading\.html\?run=run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(h), `${JSON.stringify(t)} → href ${h}`);
    }
  }
  // the link text is the matched address and nothing else
  const m = /<a class="readinglink" href="([^"]+)">([^<]*)<\/a>/.exec(renderChatMarkdown(`x ${ADDR}`));
  assert.equal(m[1], m[2]);
});
