/**
 * #1366 — a half-written comment survives a misclick, on EVERY composer.
 *
 * Unit lane. Two mechanisms, tested apart:
 *   composer-watch  now takes a KEY per (surface, target) and an optional BASE
 *                   — the text the box was prefilled with — so an edit draft is
 *                   restored only against the version it was written on and a
 *                   stale draft never overwrites a newer description (#466's
 *                   lost-update shape, in a textarea);
 *   leaving-guard   one registry per page: any dirty composer makes
 *                   `beforeunload` return a value, and a same-origin link click
 *                   asks first, NAMING the surface ("an unsent comment on #1321").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountComposerWatch, DRAFT_KEY, draftKeyFor } from '../core/composer-watch.mjs';
import { installLeavingGuard, registerComposer, _resetForTests } from '../core/leaving-guard.mjs';

function world({ storage = new Map(), value = '', url = 'http://board.test/index.html' } = {}) {
  const { window } = new JSDOM(`<!doctype html><body><textarea id="ta">${value}</textarea><a id="same" href="/wiki.html">wiki</a><a id="hash" href="#x">hash</a><a id="ext" href="https://elsewhere.test/">out</a><a id="blank" href="/x" target="_blank">new tab</a></body>`, { url });
  window.localStorage.clear();
  for (const [k, v] of storage) window.localStorage.setItem(k, v);
  const prevWin = global.window;
  global.window = window; // composer-watch reads window.localStorage
  return { window, doc: window.document, ta: window.document.getElementById('ta'), restore: () => { global.window = prevWin; } };
}
/** Copy a window's localStorage into a Map, so the next `world` starts where this one ended (a reload). */
const snapshot = (win) => { const m = new Map(); for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); m.set(k, win.localStorage.getItem(k)); } return m; };
const type = (w, text) => { w.ta.value = text; w.ta.dispatchEvent(new w.window.Event('input', { bubbles: true })); };

test('#1366 keys: two composers on one page keep two drafts; a keyed draft restores on its own target only', () => {
  const w = world();
  const a = mountComposerWatch(w.doc, { textarea: w.ta, key: 'card:c1', sample: false });
  type(w, 'comment for c1');
  assert.equal(w.window.localStorage.getItem(draftKeyFor('card:c1')), 'comment for c1');
  assert.equal(w.window.localStorage.getItem(DRAFT_KEY), null, 'the legacy key is untouched');
  a.stop();
  // same storage, different target: nothing restores
  const w2 = world({ storage: new Map([[draftKeyFor('card:c1'), 'comment for c1']]) });
  const b = mountComposerWatch(w2.doc, { textarea: w2.ta, key: 'card:c2', sample: false });
  assert.equal(w2.ta.value, '', 'c2 does not see c1\'s draft');
  b.stop();
  // same target: restores
  const w3 = world({ storage: new Map([[draftKeyFor('card:c1'), 'comment for c1']]) });
  const c = mountComposerWatch(w3.doc, { textarea: w3.ta, key: 'card:c1', sample: false });
  assert.equal(w3.ta.value, 'comment for c1');
  c.clearDraft();
  assert.equal(w3.window.localStorage.getItem(draftKeyFor('card:c1')), null, 'clearDraft releases THIS key');
  c.stop();
  w3.restore();
});

test('#1366 no key ⇒ the #1255 behaviour and key are byte-for-byte unchanged', () => {
  const w = world();
  const h = mountComposerWatch(w.doc, { textarea: w.ta, sample: false });
  type(w, 'legacy');
  assert.equal(w.window.localStorage.getItem(DRAFT_KEY), 'legacy');
  h.stop(); w.restore();
});

test('#1366 base: an EDIT draft restores over the prefill it was written on, and is DROPPED against a newer one', () => {
  // prefilled edit box, base = the description as loaded
  const w = world({ value: 'v1 description' });
  const h = mountComposerWatch(w.doc, { textarea: w.ta, key: 'edit:c9', base: 'v1 description', sample: false });
  type(w, 'v1 description plus my half-typed change');
  h.stop();
  // come back, same version: the draft wins over the prefill (the #1255 "browser-restored box wins" rule
  // does not apply — the prefill is the SERVER's text, not the operator's)
  const w2 = world({ storage: snapshot(w.window), value: 'v1 description' });
  const h2 = mountComposerWatch(w2.doc, { textarea: w2.ta, key: 'edit:c9', base: 'v1 description', sample: false });
  assert.equal(w2.ta.value, 'v1 description plus my half-typed change');
  h2.stop();
  // come back after someone else edited: base differs ⇒ the draft is not restored and is discarded
  const w3 = world({ storage: snapshot(w.window), value: 'v2 description by someone else' });
  const h3 = mountComposerWatch(w3.doc, { textarea: w3.ta, key: 'edit:c9', base: 'v2 description by someone else', sample: false });
  assert.equal(w3.ta.value, 'v2 description by someone else', 'a stale draft never overwrites a newer description');
  assert.equal(w3.window.localStorage.getItem(draftKeyFor('edit:c9')), null, 'and it is dropped, not left to ambush the next open');
  h3.stop(); w3.restore();
});

test('#1366 base: typing the prefill back exactly is NOT a draft (nothing to lose, nothing to ask about)', () => {
  const w = world({ value: 'same' });
  const h = mountComposerWatch(w.doc, { textarea: w.ta, key: 'edit:c1', base: 'same', sample: false });
  type(w, 'same edited'); assert.equal(h.isDirty(), true);
  type(w, 'same'); assert.equal(h.isDirty(), false);
  assert.equal(w.window.localStorage.getItem(draftKeyFor('edit:c1')), null, 'a draft equal to its base is released');
  h.stop(); w.restore();
});

test('#1366 leaving guard: beforeunload returns a value only while a composer is dirty', () => {
  _resetForTests();
  const w = world();
  const h = mountComposerWatch(w.doc, { textarea: w.ta, key: 'commons', sample: false });
  registerComposer(h, { describe: () => 'an unsent post on the commons' });
  installLeavingGuard(w.window, { ask: () => true });
  const fire = () => { const e = new w.window.Event('beforeunload', { cancelable: true }); w.window.dispatchEvent(e); return e; };
  let e = fire();
  assert.equal(e.defaultPrevented, false, 'clean ⇒ no guard');
  type(w, 'half a thought');
  e = fire();
  assert.equal(e.defaultPrevented, true, 'dirty ⇒ the browser asks');
  // (jsdom's Event has a boolean legacy `returnValue`; the string form is a BeforeUnloadEvent detail the served lane owns)
  h.clearDraft(); w.ta.value = '';
  e = fire();
  assert.equal(e.defaultPrevented, false, 'posted ⇒ clean again');
  h.stop(); w.restore();
});

test('#1366 leaving guard: a same-origin link asks and NAMES the surface; hash, external and _blank links do not', () => {
  _resetForTests();
  const w = world();
  const asked = [];
  const h = mountComposerWatch(w.doc, { textarea: w.ta, key: 'card:c1', sample: false });
  registerComposer(h, { describe: () => 'an unsent comment on #1321' });
  installLeavingGuard(w.window, { ask: (msg) => { asked.push(msg); return false; } });
  type(w, 'do not lose me');
  const click = (id, init = {}) => { const e = new w.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }); w.doc.getElementById(id).dispatchEvent(e); return e; };
  let e = click('same');
  assert.equal(e.defaultPrevented, true, 'declined ⇒ navigation cancelled');
  assert.match(asked[0], /an unsent comment on #1321/);
  e = click('hash'); assert.equal(e.defaultPrevented, false, 'a hash link never leaves the page');
  e = click('ext'); assert.equal(e.defaultPrevented, false, 'an external link is the browser\'s beforeunload, not ours');
  e = click('blank'); assert.equal(e.defaultPrevented, false, 'a new tab loses nothing');
  e = click('same', { metaKey: true }); assert.equal(e.defaultPrevented, false, 'cmd-click opens a tab');
  assert.equal(asked.length, 1, 'asked exactly once, for the one real leave');
  h.stop(); w.restore();
});

test('#1366 leaving guard: accepting the ask lets the click through, and installs ONCE per window', () => {
  _resetForTests();
  const w = world();
  const h = mountComposerWatch(w.doc, { textarea: w.ta, key: 'commons', sample: false });
  registerComposer(h, { describe: () => 'an unsent post' });
  let asks = 0;
  installLeavingGuard(w.window, { ask: () => { asks += 1; return true; } });
  installLeavingGuard(w.window, { ask: () => { asks += 100; return true; } }); // second install is a no-op
  type(w, 'x');
  const e = new w.window.MouseEvent('click', { bubbles: true, cancelable: true });
  w.doc.getElementById('same').dispatchEvent(e);
  assert.equal(e.defaultPrevented, false, 'accepted ⇒ navigation proceeds');
  assert.equal(asks, 1, 'one guard, one ask');
  h.stop(); w.restore();
});
