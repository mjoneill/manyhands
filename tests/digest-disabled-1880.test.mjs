/**
 * #1880 — A DISABLED STANDING CHECK MUST NOT READ AS A CLEAN ONE. /api/checks returns a disabled check as
 * { id, claim, disabled: true, reason } with no rows, and renderDigest() skipped it exactly like a check that ran and found
 * nothing. So on 2026-11-12 the digest stayed silent ("nothing to say") while 3 of 7 checks were not running, and anyone
 * reading the silence took it as "all clear". #1162's own rule in the render function forbids exactly that.
 *
 * INTERFACE PINNED HERE:
 *   renderDigest(): a check with `disabled: true` is never skipped. Every disabled check is named on ONE line:
 *     "⏸ <n> standing check(s) not running · since <age> · <id> (<reason>) · <id> (<reason>) …  → re-enable it, or record why it stays off"
 *   checks sharing a reason are grouped: "<id>, <id> (<reason>)". A disabled check counts as something to say, so a day whose
 *   only content is ⏸ posts. It is NOT counted as failing: the header counts failing checks and items only.
 *   Age: first-seen is kept per disabled check under the key "<id>|disabled" and shown as "since <age>" for the oldest.
 *
 *   D1  one disabled check and every enabled check clean: a body, carrying the ⏸ line with the id and reason
 *   D2  CONTROL: every check enabled and clean: no body (silence, as before)
 *   D3  a failing check and a disabled one: both lines; the header says 1 check failing and counts only the failing items
 *   D4  age: a disabled check first seen two days ago reads "since 2 d", and its first-seen survives into the next map
 *   D5  checks with the same reason are named once, grouped, and a different reason stays separate
 *   D6  the tick: a day whose only content is a disabled check POSTS (it does not take the nothing-to-say path)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDigest, digestTick } from '../core/digest.mjs';

const NOW = '2026-11-12T09:00:00.000Z';
const R1574 = 'disabled under the graph conversations unit (#1574)';
const off = (id, reason = R1574) => ({ id, claim: `${id} claim`, disabled: true, reason });
const clean = (id) => ({ id, claim: `${id} claim`, rows: [] });
const failing = { id: 'phantom-block', claim: 'an open card declares blockedBy a done card', rows: [{ blocked: 1, blocker: 2 }, { blocked: 3, blocker: 4 }] };
const pauseLine = (body) => (body || '').split('\n').find((l) => l.startsWith('⏸ '));

test('D1 a disabled check with every enabled check clean still produces a body that names it', () => {
  const r = renderDigest({ standing: [clean('unregistered-kinds'), off('stale-claims')], now: NOW });
  assert.ok(r.body, 'not silent');
  const line = pauseLine(r.body);
  assert.ok(line, `a ⏸ line (${r.body})`);
  assert.match(line, /^⏸ 1 standing check not running · /);
  assert.ok(line.includes(`stale-claims (${R1574})`), line);
  assert.ok(!/failing/.test(r.body.split('\n')[0]) || /^0 standing checks failing/.test(r.body), `a disabled check is not reported as failing (${r.body})`);
});

test('D2 CONTROL: every check enabled and clean stays silent', () => {
  const r = renderDigest({ standing: [clean('unregistered-kinds'), clean('phantom-block')], now: NOW });
  assert.equal(r.body, null);
});

test('D3 a failing check and a disabled one: both lines, and the header counts only the failing', () => {
  const r = renderDigest({ standing: [failing, off('role-expiry')], now: NOW });
  assert.match(r.body, /^1 standing check failing, 2 items — /);
  assert.ok(r.body.includes('⚠️ 2 phantom-block'), 'the failing line');
  assert.ok(pauseLine(r.body)?.includes('role-expiry'), 'and the ⏸ line');
  assert.equal(r.items, 2, 'items counts the failing rows only');
});

test('D4 age: a disabled check first seen two days ago reads "since 2 d", and its first-seen is kept', () => {
  const twoDaysAgo = '2026-11-10T08:00:00.000Z';
  const r = renderDigest({ standing: [off('stale-claims')], now: NOW, firstSeen: { 'stale-claims|disabled': twoDaysAgo } });
  assert.match(pauseLine(r.body), / · since 2 d · /);
  assert.equal(r.firstSeen['stale-claims|disabled'], twoDaysAgo);
  const fresh = renderDigest({ standing: [off('stale-claims')], now: NOW });
  assert.match(pauseLine(fresh.body), / · since new · /);
  assert.equal(fresh.firstSeen['stale-claims|disabled'], NOW);
});

test('D5 checks sharing a reason are grouped; a different reason stays separate', () => {
  const r = renderDigest({ standing: [off('stale-claims'), off('role-expiry'), off('graph-store-meter'), off('other-check', 'turned off by hand')], now: NOW });
  const line = pauseLine(r.body);
  assert.match(line, /^⏸ 4 standing checks not running · /);
  assert.ok(line.includes(`stale-claims, role-expiry, graph-store-meter (${R1574})`), line);
  assert.ok(line.includes('other-check (turned off by hand)'), line);
  assert.equal(line.split(R1574).length - 1, 1, 'the shared reason appears once');
});

test('D6 the tick posts a day whose only content is a disabled check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg1880-'));
  try {
    const posts = [];
    const r = await digestTick({ now: NOW, file: path.join(dir, 'state.json'), standing: () => [clean('unregistered-kinds'), off('stale-claims')], post: async (b) => { posts.push(b); }, quietAfterMinutes: 30, lastActivityAt: () => null });
    assert.notEqual(r.reason, 'nothing-to-say', `not silenced (${JSON.stringify(r)})`);
    assert.equal(posts.length, 1, 'one digest posted');
    assert.ok(posts[0].body.includes('⏸ 1 standing check not running'), posts[0].body);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
