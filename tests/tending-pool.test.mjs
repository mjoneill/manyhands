/**
 * #1189 — controls for the LIVE graph-backed whisper pool.
 *
 * Every test here fails under a specific defect, named in the test. The card
 * this belongs to exists because the firing path never read the graph at all:
 * 393 real firings against 1 TendingMint. So the defect these guard against is
 * not "wrong answer" — it is "plausible answer computed from the wrong place",
 * which is exactly what the old hardcoded DEFAULT_POOL produced for months
 * while looking correct from every observable surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePool, selectPrompt } from '../core/tending-pool.mjs';
import { promptId, promptVersionId, playlistId, playlistVersionId } from '../core/tending-ids.mjs';

const AT = '2026-08-15T00:00:00.000Z';

function prompt(slug, { enabled } = {}) {
  const n = {
    '@id': promptId(slug),
    '@type': 'scrum:TendingPrompt',
    identifier: slug,
    'scrum:importedAt': AT,
  };
  if (enabled !== undefined) n['scrum:enabled'] = enabled;
  return n;
}

function version(slug, v, body) {
  return {
    '@id': promptVersionId(slug, v),
    '@type': 'scrum:TendingPromptVersion',
    'scrum:ofPrompt': promptId(slug),
    'scrum:version': v,
    'scrum:body': body,
    'scrum:importedAt': AT,
  };
}

function playlist(slug, versionIds) {
  return [
    { '@id': playlistId(slug), '@type': 'scrum:TendingPlaylist', identifier: slug, 'scrum:importedAt': AT },
    {
      '@id': playlistVersionId(slug, 1),
      '@type': 'scrum:TendingPlaylistVersion',
      'scrum:ofPlaylist': playlistId(slug),
      'scrum:version': 1,
      'scrum:orderedPrompts': { '@list': versionIds },
      'scrum:importedAt': AT,
    },
  ];
}

/**
 * The fixture's PLAYLIST ORDER (b, a, c) deliberately DISAGREES with the array
 * order the entities appear in (a, b, c). A reader that iterates the entity
 * array — the obvious implementation — passes every other assertion here and
 * fails this one. That disagreement is the whole point of the fixture.
 */
function fixture() {
  return [
    prompt('alpha'),
    version('alpha', 1, 'A body'),
    prompt('bravo'),
    version('bravo', 1, 'B body'),
    prompt('charlie'),
    version('charlie', 1, 'C body'),
    ...playlist('room-tending', [
      promptVersionId('bravo', 1),
      promptVersionId('alpha', 1),
      promptVersionId('charlie', 1),
    ]),
  ];
}

test('pool comes back in PLAYLIST order, not entity-array order', () => {
  // DEFECT: iterating the tending array instead of following orderedPrompts.
  const pool = resolvePool(fixture());
  assert.deepEqual(pool.map((p) => p.slug), ['bravo', 'alpha', 'charlie']);
  assert.deepEqual(pool.map((p) => p.body), ['B body', 'A body', 'C body']);
});

test('a prompt with scrum:enabled false is excluded', () => {
  // DEFECT: honouring only the global TendingState flag, so the operator's
  // per-whisper disable silently does nothing and the prompt keeps firing.
  const ents = fixture().map((e) =>
    e['@id'] === promptId('alpha') ? { ...e, 'scrum:enabled': false } : e);
  const pool = resolvePool(ents);
  assert.deepEqual(pool.map((p) => p.slug), ['bravo', 'charlie']);
});

test('absent scrum:enabled means ENABLED — absence is not disablement', () => {
  // DEFECT: treating a missing flag as false, which would silence all three
  // bootstrapped prompts on the first deploy and read as "tending is broken".
  const pool = resolvePool(fixture());
  assert.equal(pool.length, 3);
});

test('the HIGHEST version of a prompt wins, and lower versions are not returned', () => {
  // DEFECT: taking the first matching version, so an edit appears to do
  // nothing. This is the failure mode the operator hits on a first edit.
  const ents = [...fixture(), version('alpha', 2, 'A body v2')];
  const pool = resolvePool(ents);
  const alpha = pool.find((p) => p.slug === 'alpha');
  assert.equal(alpha.body, 'A body v2');
  assert.equal(alpha.version, 2);
  assert.equal(pool.filter((p) => p.slug === 'alpha').length, 1);
});

test('a version with no body is refused rather than emitted as an empty whisper', () => {
  // DEFECT: posting an empty string to the room. The room cannot tell an empty
  // whisper from a broken one, and neither can the sender.
  const ents = [...fixture(), { ...version('delta', 1, ''), 'scrum:body': '' }, prompt('delta')];
  const pool = resolvePool(ents);
  assert.ok(!pool.some((p) => p.slug === 'delta'));
});

test('an empty pool returns empty — it does NOT fall back to built-in words', () => {
  // DEFECT: the #809 fallback, inherited. Falling back to DEFAULT_POOL here
  // would mean disabling every whisper still produces whispers, and the
  // substitution would be invisible from the room.
  const ents = fixture().map((e) =>
    e['@type'] === 'scrum:TendingPrompt' ? { ...e, 'scrum:enabled': false } : e);
  assert.deepEqual(resolvePool(ents), []);
});

test('selectPrompt with shuffle OFF returns the first enabled prompt in order', () => {
  const pool = resolvePool(fixture());
  assert.equal(selectPrompt(pool, { shuffle: false }).slug, 'bravo');
});

test('selectPrompt with shuffle ON only ever returns an ENABLED prompt', () => {
  // DEFECT: shuffling over the unfiltered list, so a disabled whisper fires
  // roughly 1/N of the time — intermittent, and it looks like a ghost.
  const ents = fixture().map((e) =>
    e['@id'] === promptId('alpha') ? { ...e, 'scrum:enabled': false } : e);
  const pool = resolvePool(ents);
  for (let i = 0; i < 200; i += 1) {
    const picked = selectPrompt(pool, { shuffle: true, rand: Math.random });
    assert.ok(picked.slug !== 'alpha', 'a disabled prompt was selected under shuffle');
  }
});

test('selectPrompt is deterministic given rand, and can reach EVERY enabled prompt', () => {
  // DEFECT: a shuffle that always returns index 0 passes the test above
  // perfectly. Reachability is what separates "filtered" from "shuffled".
  const pool = resolvePool(fixture());
  assert.equal(selectPrompt(pool, { shuffle: true, rand: () => 0 }).slug, 'bravo');
  assert.equal(selectPrompt(pool, { shuffle: true, rand: () => 0.99 }).slug, 'charlie');
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) seen.add(selectPrompt(pool, { shuffle: true, rand: Math.random }).slug);
  assert.equal(seen.size, 3, 'shuffle never reached all three enabled prompts');
});

test('selectPrompt on an empty pool returns null rather than throwing', () => {
  assert.equal(selectPrompt([], { shuffle: false }), null);
  assert.equal(selectPrompt([], { shuffle: true, rand: Math.random }), null);
});

test('a prompt absent from the playlist is NOT fired, even though its version exists', () => {
  // DEFECT: unioning playlist members with every TendingPromptVersion found,
  // which would resurrect a removed whisper. Removal must mean removal.
  const ents = [...fixture(), prompt('echo'), version('echo', 1, 'E body')];
  const pool = resolvePool(ents);
  assert.ok(!pool.some((p) => p.slug === 'echo'));
});
