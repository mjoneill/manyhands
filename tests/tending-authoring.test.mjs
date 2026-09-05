/**
 * #1189 — controls for the WRITE half of the runtime seam (#804).
 *
 * The existing write surface (`whisper_pool`, #802) takes an array of plain
 * STRINGS and replaces the pool wholesale. Every one of these tests fails if
 * this module is implemented that way, which is the point: the strings path
 * would silently discard identity, version lineage, authorship and the
 * authorship ruling recorded on 2026-08-15 — and it would look like it
 * worked, because the room would still receive a whisper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPrompt, editPrompt, setEnabled, reorderPlaylist, removePrompt, setShuffle,
} from '../core/tending-authoring.mjs';
import { resolvePool } from '../core/tending-pool.mjs';
import { promptId, promptVersionId, playlistId, playlistVersionId } from '../core/tending-ids.mjs';

const AT = '2026-09-05T02:00:00.000Z';
const LATER = '2026-09-05T03:00:00.000Z';

function seed() {
  return [
    { '@id': promptId('alpha'), '@type': 'scrum:TendingPrompt', identifier: 'alpha', 'scrum:importedAt': AT },
    {
      '@id': promptVersionId('alpha', 1),
      '@type': 'scrum:TendingPromptVersion',
      'scrum:ofPrompt': promptId('alpha'),
      'scrum:version': 1,
      'scrum:body': 'A body',
      author: 'person:ada',
      'scrum:provenanceNote': 'authorship ruled 2026-08-15',
      'scrum:importedAt': AT,
    },
    { '@id': playlistId('room-tending'), '@type': 'scrum:TendingPlaylist', identifier: 'room-tending', 'scrum:importedAt': AT },
    {
      '@id': playlistVersionId('room-tending', 1),
      '@type': 'scrum:TendingPlaylistVersion',
      'scrum:ofPlaylist': playlistId('room-tending'),
      'scrum:version': 1,
      'scrum:orderedPrompts': { '@list': [promptVersionId('alpha', 1)] },
      'scrum:importedAt': AT,
    },
    { '@id': 'https://scrumboard.local/tending/state/current', '@type': 'scrum:TendingState', 'scrum:enabled': true },
  ];
}

const find = (ents, id) => ents.find((e) => e['@id'] === id);

test('editing a prompt MINTS v2 and leaves v1 byte-intact, provenance included', () => {
  // DEFECT: mutating scrum:body in place. This is the whole reason the model is
  // versioned, and the loss would be invisible — the new text reads correctly.
  const out = editPrompt(seed(), { slug: 'alpha', body: 'A body, revised', by: 'bee', at: LATER });
  const v1 = find(out, promptVersionId('alpha', 1));
  const v2 = find(out, promptVersionId('alpha', 2));

  assert.equal(v1['scrum:body'], 'A body', 'v1 body was mutated');
  assert.equal(v1.author, 'person:ada', 'v1 authorship was lost');
  assert.equal(v1['scrum:provenanceNote'], 'authorship ruled 2026-08-15', 'v1 provenance was lost');
  assert.ok(v2, 'no v2 was minted');
  assert.equal(v2['scrum:body'], 'A body, revised');
  assert.equal(v2['scrum:version'], 2);
  assert.equal(v2['scrum:ofPrompt'], promptId('alpha'), 'v2 is not tied to the durable identity');
});

test('an edit is what the next firing reads', () => {
  const out = editPrompt(seed(), { slug: 'alpha', body: 'A body, revised', by: 'bee', at: LATER });
  assert.equal(resolvePool(out)[0].body, 'A body, revised');
});

test('the edit author is recorded on the NEW version and never backdated onto v1', () => {
  // DEFECT: attributing the original to whoever edited it — inventing provenance.
  const out = editPrompt(seed(), { slug: 'alpha', body: 'revised', by: 'bee', at: LATER });
  assert.equal(find(out, promptVersionId('alpha', 2)).author, 'person:bee');
  assert.equal(find(out, promptVersionId('alpha', 1)).author, 'person:ada');
});

test('creating a prompt appends it to the playlist as a NEW playlist version', () => {
  // DEFECT: mutating the existing playlist version's @list in place, which
  // destroys the record of what the room was running before.
  const out = createPrompt(seed(), { slug: 'bravo', body: 'B body', by: 'ada', at: LATER });
  const v1 = find(out, playlistVersionId('room-tending', 1));
  const v2 = find(out, playlistVersionId('room-tending', 2));

  assert.deepEqual(v1['scrum:orderedPrompts']['@list'], [promptVersionId('alpha', 1)], 'playlist v1 mutated');
  assert.ok(v2, 'no new playlist version');
  assert.deepEqual(v2['scrum:orderedPrompts']['@list'],
    [promptVersionId('alpha', 1), promptVersionId('bravo', 1)]);
  assert.deepEqual(resolvePool(out).map((p) => p.slug), ['alpha', 'bravo']);
});

test('creating a prompt with a slug that already exists is REFUSED', () => {
  // DEFECT: two TendingPrompt nodes at one @id, or a silent overwrite of a
  // prompt whose lineage someone else authored.
  assert.throws(() => createPrompt(seed(), { slug: 'alpha', body: 'x', by: 'bee', at: LATER }), /exists/i);
});

test('an empty or blank body is REFUSED on create and on edit', () => {
  assert.throws(() => createPrompt(seed(), { slug: 'b', body: '   ', by: 'bee', at: LATER }), /body/i);
  assert.throws(() => editPrompt(seed(), { slug: 'alpha', body: '', by: 'bee', at: LATER }), /body/i);
});

test('editing or disabling an unknown prompt is REFUSED rather than silently ignored', () => {
  assert.throws(() => editPrompt(seed(), { slug: 'ghost', body: 'x', by: 'bee', at: LATER }), /unknown|not found/i);
  assert.throws(() => setEnabled(seed(), { slug: 'ghost', enabled: false }), /unknown|not found/i);
});

test('disabling sets the flag on the durable prompt node and the pool drops it', () => {
  const out = setEnabled(seed(), { slug: 'alpha', enabled: false, by: 'ada', at: LATER });
  assert.equal(find(out, promptId('alpha'))['scrum:enabled'], false);
  assert.deepEqual(resolvePool(out), []);
});

test('re-enabling restores it, and the text is unchanged by the round trip', () => {
  const off = setEnabled(seed(), { slug: 'alpha', enabled: false, by: 'ada', at: LATER });
  const on = setEnabled(off, { slug: 'alpha', enabled: true, by: 'ada', at: LATER });
  assert.equal(resolvePool(on)[0].body, 'A body');
});

test('reordering mints a new playlist version and the pool follows it', () => {
  const two = createPrompt(seed(), { slug: 'bravo', body: 'B body', by: 'ada', at: LATER });
  const out = reorderPlaylist(two, { slugs: ['bravo', 'alpha'], by: 'ada', at: LATER });
  assert.deepEqual(resolvePool(out).map((p) => p.slug), ['bravo', 'alpha']);
  // the previous order is still readable
  assert.deepEqual(find(out, playlistVersionId('room-tending', 2))['scrum:orderedPrompts']['@list'],
    [promptVersionId('alpha', 1), promptVersionId('bravo', 1)]);
});

test('reordering with a missing or unknown slug is REFUSED — no partial application', () => {
  // DEFECT: dropping whatever the caller forgot to list. A reorder that also
  // deletes is the single most destructive thing this surface could do.
  const two = createPrompt(seed(), { slug: 'bravo', body: 'B body', by: 'ada', at: LATER });
  assert.throws(() => reorderPlaylist(two, { slugs: ['bravo'], by: 'ada', at: LATER }), /every|missing|all/i);
  assert.throws(() => reorderPlaylist(two, { slugs: ['bravo', 'alpha', 'ghost'], by: 'ada', at: LATER }), /unknown|not found/i);
});

test('removing a prompt drops it from the PLAYLIST and KEEPS its entity and versions', () => {
  // The room ruled this on 2026-09-05: removal is a tombstone, not a scrub.
  // The lineage, authorship and provenance survive; only membership ends.
  const two = createPrompt(seed(), { slug: 'bravo', body: 'B body', by: 'ada', at: LATER });
  const out = removePrompt(two, { slug: 'alpha', by: 'ada', at: LATER });

  assert.deepEqual(resolvePool(out).map((p) => p.slug), ['bravo']);
  assert.ok(find(out, promptId('alpha')), 'the prompt entity was destroyed');
  assert.ok(find(out, promptVersionId('alpha', 1)), 'the version was destroyed');
  assert.equal(find(out, promptVersionId('alpha', 1))['scrum:provenanceNote'], 'authorship ruled 2026-08-15');
});

test('shuffle is graph state on TendingState, and defaults OFF when absent', () => {
  const ents = seed();
  assert.equal(find(ents, 'https://scrumboard.local/tending/state/current')['scrum:shuffle'], undefined);
  const out = setShuffle(ents, { shuffle: true, by: 'ada', at: LATER });
  assert.equal(find(out, 'https://scrumboard.local/tending/state/current')['scrum:shuffle'], true);
});

test('every authoring op leaves the input array UNMUTATED', () => {
  // DEFECT: in-place mutation of the caller's entities. The board write seam
  // reads the document, applies, and persists — an op that mutates its input
  // corrupts the in-memory document even when the write is later refused.
  const original = seed();
  const snapshot = JSON.parse(JSON.stringify(original));
  editPrompt(original, { slug: 'alpha', body: 'x', by: 'bee', at: LATER });
  createPrompt(original, { slug: 'zulu', body: 'z', by: 'bee', at: LATER });
  setEnabled(original, { slug: 'alpha', enabled: false, by: 'bee', at: LATER });
  setShuffle(original, { shuffle: true, by: 'bee', at: LATER });
  removePrompt(original, { slug: 'alpha', by: 'bee', at: LATER });
  assert.deepEqual(original, snapshot);
});
