/**
 * #1255 slice 1 — the browser half.
 *
 * The load-bearing assertion is the boring one: A DRAFT THAT WAS NOT POSTED
 * SURVIVES A RELOAD. Everything else here is the diagnostic; that one is the
 * thing the operator actually loses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountComposerWatch, DRAFT_KEY, TRACE_KEY } from '../core/composer-watch.mjs';

/** A textarea and a localStorage, small enough to read. */
function fakeWorld({ storage = new Map(), value = '' } = {}) {
  const listeners = {};
  const ta = {
    value,
    addEventListener: (k, fn) => { (listeners[k] ||= []).push(fn); },
    type: (text) => { ta.value = text; (listeners.input || []).forEach((f) => f()); },
  };
  const doc = { getElementById: (id) => (id === 'convs-body' ? ta : null) };
  global.window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  return { doc, ta, storage };
}

test('#1255 ⭐ AN UNPOSTED DRAFT SURVIVES A RELOAD — the defect that raised this card to p1', () => {
  const w = fakeWorld();
  const h1 = mountComposerWatch(w.doc, { textarea: w.ta });
  w.ta.type('a long and carefully considered message about the storage decision');
  h1.stop();

  // …the tab reloads. New page, same storage, empty box.
  const w2 = fakeWorld({ storage: w.storage });
  const h2 = mountComposerWatch(w2.doc, { textarea: w2.ta });
  assert.equal(w2.ta.value, 'a long and carefully considered message about the storage decision');
  h2.stop();
});

test('#1255 the saved draft is released ONLY on a confirmed post', () => {
  const w = fakeWorld();
  const h = mountComposerWatch(w.doc, { textarea: w.ta });
  w.ta.type('something worth keeping');
  assert.equal(w.storage.get(DRAFT_KEY), 'something worth keeping');
  h.clearDraft();
  assert.equal(w.storage.has(DRAFT_KEY), false);
  h.stop();
});

test('#1255 a browser-restored box WINS over the stored draft — never clobber what the operator can see', () => {
  const storage = new Map([[DRAFT_KEY, 'older stored text']]);
  const w = fakeWorld({ storage, value: 'what the browser already put back' });
  const h = mountComposerWatch(w.doc, { textarea: w.ta });
  assert.equal(w.ta.value, 'what the browser already put back');
  h.stop();
});

test('#1255 a loss is detected and classified UNKNOWN without host samples, HOST_PRESSURE with them', async () => {
  const w = fakeWorld();
  const h = mountComposerWatch(w.doc, { textarea: w.ta });
  w.ta.type('x'.repeat(2400));
  w.ta.type('x'.repeat(300));
  assert.ok(h.loss(), 'the drop to a fragment is a loss');
  assert.equal(h.verdict().verdict, 'UNKNOWN', 'no host samples ⇒ it must not accuse the composer');
  h.stop();

  // Same shape, but with the host sample the endpoint provides.
  const w2 = fakeWorld();
  const h2 = mountComposerWatch(w2.doc, {
    textarea: w2.ta,
    fetchImpl: async () => ({ ok: true, json: async () => ({ freeMemMb: 300, loadavg1: 22.5, rssMb: 900 }) }),
  });
  w2.ta.type('y'.repeat(2400));
  await h2.sampleNow();                       // a REAL call: if it vanishes, this test fails
  const host = h2.trace().events.filter((e) => e.kind === 'host');
  assert.equal(host.length, 1, 'the host sample must reach the trace');
  assert.equal(host[0].freeMemMb, 300);
  w2.ta.type('y'.repeat(300));
  const v = h2.verdict();
  assert.equal(v.verdict, 'HOST_PRESSURE', `with a starved host the verdict must name the host, got ${v.verdict}`);
  assert.match(v.why, /memor|load/i);
  h2.stop();
});

test('#1255 ⛔ THE WATCHER MUST NEVER BREAK THE COMPOSER — storage that throws is survivable', () => {
  const w = fakeWorld();
  global.window.localStorage = {
    getItem: () => { throw new Error('SecurityError: storage disabled'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('nope'); },
  };
  const h = mountComposerWatch(w.doc, { textarea: w.ta });
  assert.doesNotThrow(() => w.ta.type('typing into a box whose storage is dead'));
  assert.doesNotThrow(() => h.clearDraft());
  assert.equal(w.ta.value, 'typing into a box whose storage is dead', 'the box still works');
  h.stop();
});

// ---------------------------------------------------------------------------
// THE JOIN. The module can be perfect and reach nobody: the page has to mount
// it and has to report the submit. #1162's lesson, applied to a wiring seam —
// assert what CROSSES into the consumer, not just that the module is correct.
test('#1255 SEAM: index.html actually mounts the watcher and reports both halves of the submit', () => {
  const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(src, /import \{ mountComposerWatch \} from '\.\/core\/composer-watch\.mjs'/);
  assert.match(src, /window\._composerWatch = mountComposerWatch\(document\)/);
  assert.match(src, /_composerWatch\?\.noteSubmit\(/, 'the submit seam must be reported');
  assert.match(src, /_composerWatch\?\.noteResponse\(res\.status/, 'the response timing must be reported');
  assert.match(src, /_composerWatch\?\.noteResponse\(0,/, 'a THROWN fetch is status 0 and must be recorded too');
  assert.match(src, /_composerWatch\?\.clearDraft\(\)/, 'the draft must be released on a confirmed post');
  // ⛔ And the ordering that matters: clearDraft is inside the `if (ok)` branch.
  const okBranch = src.slice(src.indexOf('const ok = await postConversation('));
  const clearAt = okBranch.indexOf('clearDraft()');
  const ifOkAt = okBranch.indexOf('if (ok)');
  assert.ok(ifOkAt >= 0 && clearAt > ifOkAt && clearAt < ifOkAt + 400,
    'clearDraft must sit INSIDE the success branch — a cleared box is not a saved message');
});
