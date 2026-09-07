/**
 * #303-2 — the shared cross-surface nav. The whole point is parity: every
 * surface offers the same links, and exactly one is marked active. These
 * pure tests guard the contract; nav-e2e.test.mjs proves it renders on each page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_ITEMS, renderTopNav } from '../core/header.mjs';

test('every surface is represented, once', () => {
  const ids = NAV_ITEMS.map((i) => i.id);
  // #1290 added Insights. Kept as an EXACT list rather than a count: a new
  // surface must be declared here deliberately, never slip in.
  assert.deepEqual(ids, ['board', 'wiki', 'commons', 'insights', 'settings']);
  assert.equal(new Set(ids).size, ids.length, 'no dupes');
});

test('renderTopNav emits every link regardless of which is active', () => {
  for (const active of NAV_ITEMS.map((i) => i.id)) {
    const html = renderTopNav(active);
    for (const it of NAV_ITEMS) {
      assert.ok(html.includes(it.label), `${active} nav shows ${it.label}`);
    }
  }
});

test('exactly the active item is a non-link <span aria-current>, the rest are <a href>', () => {
  const html = renderTopNav('settings');
  // active = settings → a span, not an anchor
  assert.ok(/<span class="navlink active" aria-current="page">⚙️ Settings<\/span>/.test(html), html);
  assert.ok(!/href="\/settings\.html"/.test(html), 'active item has no href');
  // the other three are anchors with their hrefs
  assert.ok(html.includes('href="/"'), 'board link present');
  assert.ok(html.includes('href="/wiki.html"'), 'wiki link present');
  assert.ok(html.includes('href="/commons.html"'), 'commons link present');
  assert.ok(html.includes('href="/insights.html"'), 'insights link present');
  // exactly one active
  assert.equal((html.match(/class="navlink active"/g) || []).length, 1, 'exactly one active');
});

test('an unknown active id still renders every item (all as links)', () => {
  const html = renderTopNav('nonexistent');
  assert.equal((html.match(/<a class="navlink"/g) || []).length, NAV_ITEMS.length, 'every item is a link');
  assert.ok(!html.includes('active'), 'nothing marked active');
});
