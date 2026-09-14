/**
 * #1367 — one editor everywhere a description or comment is written.
 *
 * Unit lane (jsdom): the component's contract, independent of any page.
 *   - it wraps an EXISTING textarea in place: every selector that found the
 *     textarea before (#card-desc, .edit-desc, #convs-body) still finds it,
 *     and its value survives the mount;
 *   - preview renders through the SURFACE'S OWN renderer (the board shows a
 *     description as escaped text + #NNN links, the commons as chat markdown —
 *     a preview through the wrong one is a lie about what save will show);
 *   - #NNN in the preview carries the card's title on hover when the surface
 *     can resolve one, and nothing when it cannot;
 *   - Cmd/Ctrl+Enter submits, plain Enter does not;
 *   - it grows with content to a ceiling, then scrolls (jsdom has no layout,
 *     so scrollHeight is stubbed — the assertion is on what the component DOES
 *     with the number, not on the browser measuring it; the served test covers
 *     the real measure).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountEditor } from '../core/editor.mjs';
import { renderChatMarkdown } from '../core/render.mjs';

function dom(html = '<form id="f"><textarea id="ta" class="form-textarea">hello</textarea></form>') {
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`);
  return { window, doc: window.document, ta: window.document.getElementById('ta') };
}

const titles = { 1: 'first card', 2: 'second card' };
const resolveTitle = (n) => titles[n];

test('#1367 mounts IN PLACE: the textarea keeps its id, class, value and parent form', () => {
  const { doc, ta } = dom();
  const h = mountEditor(ta, { doc, render: renderChatMarkdown });
  assert.equal(doc.getElementById('ta'), ta, 'the same element is still reachable by id');
  assert.equal(ta.value, 'hello', 'value survives the mount');
  assert.ok(ta.closest('.mh-editor'), 'wrapped in the editor root');
  assert.equal(ta.closest('form')?.id, 'f', 'still inside its form');
  assert.equal(h.root, ta.closest('.mh-editor'));
  assert.equal(h.previewing, false, 'starts in write mode');
  assert.ok(h.root.querySelector('.mh-editor-preview').hidden, 'preview hidden until asked');
});

test('#1367 preview renders through the caller\'s renderer and titles #NNN from the resolver', () => {
  const { doc, ta } = dom();
  ta.value = 'see #1 and #2, also #9 — **bold**';
  const h = mountEditor(ta, { doc, render: renderChatMarkdown, resolveTitle });
  h.showPreview(true);
  assert.equal(h.previewing, true);
  assert.ok(ta.hidden, 'textarea hidden while previewing');
  const pv = h.root.querySelector('.mh-editor-preview');
  assert.equal(pv.hidden, false);
  const refs = [...pv.querySelectorAll('a[data-shortid]')].map((a) => [a.dataset.shortid, a.getAttribute('title')]);
  assert.deepEqual(refs, [['1', 'first card'], ['2', 'second card'], ['9', null]],
    'known refs carry a title, an unknown one carries none');
  assert.equal(pv.querySelector('strong')?.textContent, 'bold', 'markdown went through the renderer');
  h.showPreview(false);
  assert.equal(ta.hidden, false, 'back to writing');
  assert.equal(pv.hidden, true);
});

test('#1367 preview is re-rendered from the CURRENT value each time it is shown', () => {
  const { doc, ta } = dom();
  ta.value = 'one';
  const h = mountEditor(ta, { doc, render: (t) => `<p>${t}</p>` });
  h.showPreview(true);
  assert.equal(h.root.querySelector('.mh-editor-preview').textContent, 'one');
  h.showPreview(false);
  ta.value = 'two';
  h.showPreview(true);
  assert.equal(h.root.querySelector('.mh-editor-preview').textContent, 'two');
});

test('#1367 a resolver title with quotes lands as text, never as markup', () => {
  const { doc, ta } = dom();
  ta.value = '#1';
  const h = mountEditor(ta, { doc, render: renderChatMarkdown, resolveTitle: () => 'say "hi" <b>' });
  h.showPreview(true);
  const a = h.root.querySelector('.mh-editor-preview a[data-shortid]');
  assert.equal(a.getAttribute('title'), 'say "hi" <b>');
  assert.equal(h.root.querySelector('.mh-editor-preview b'), null, 'no element was created from the title');
});

test('#1367 no renderer → no preview control, but growth and submit still work', () => {
  const { doc, ta } = dom();
  const h = mountEditor(ta, { doc });
  assert.equal(h.root.querySelector('[data-editor-preview]'), null);
  assert.equal(h.root.querySelector('.mh-editor-preview'), null);
});

test('#1367 Cmd/Ctrl+Enter submits once; a bare Enter is a newline, not a submit', () => {
  const { window, doc, ta } = dom();
  let submits = 0;
  mountEditor(ta, { doc, onSubmit: () => { submits += 1; } });
  const key = (init) => ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  key({});
  assert.equal(submits, 0, 'plain Enter did not submit');
  key({ metaKey: true });
  assert.equal(submits, 1, 'Cmd+Enter submitted');
  key({ ctrlKey: true });
  assert.equal(submits, 2, 'Ctrl+Enter submitted');
});

test('#1367 grows to its content up to the ceiling, then scrolls', () => {
  const { window, doc, ta } = dom();
  let sh = 200;
  Object.defineProperty(ta, 'scrollHeight', { get: () => sh, configurable: true });
  mountEditor(ta, { doc, maxHeight: 480 });
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(ta.style.height, '200px', 'height follows content');
  assert.equal(ta.style.overflowY, 'hidden', 'no scrollbar while it fits');
  sh = 900;
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(ta.style.height, '480px', 'capped at the ceiling');
  assert.equal(ta.style.overflowY, 'auto', 'scrolls past the ceiling');
  // The wrapper must beat the surface's own max-height (index.html caps
  // .form-textarea at 120px — the "wall" #40 felt was a box that stopped
  // growing, not a byte limit).
  assert.equal(ta.style.maxHeight, '480px');
  // not laid out yet (a closed <details>, a hidden panel): never write 0px
  sh = 0;
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(ta.style.height, '', 'unmeasured ⇒ stylesheet height, not 0px');
  // and focus re-measures once visible
  sh = 300;
  ta.dispatchEvent(new window.Event('focus'));
  assert.equal(ta.style.height, '300px', 'focus grows to the now-measurable content');
});

test('#1367 destroy unwraps and leaves the textarea where it was', () => {
  const { doc, ta } = dom();
  const h = mountEditor(ta, { doc, render: renderChatMarkdown });
  h.destroy();
  assert.equal(ta.closest('.mh-editor'), null);
  assert.equal(ta.parentElement?.id, 'f');
  assert.equal(doc.querySelector('.mh-editor'), null);
});

test('#1367 mounting twice on one textarea returns the SAME handle, never nests', () => {
  const { doc, ta } = dom();
  const a = mountEditor(ta, { doc });
  const b = mountEditor(ta, { doc });
  assert.equal(a, b);
  assert.equal(doc.querySelectorAll('.mh-editor').length, 1);
});
