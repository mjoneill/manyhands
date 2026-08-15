/**
 * #805 — controls for the tending bootstrap.
 *
 * Every one of these is written to FAIL under a specific defect this card
 * exists to prevent, rather than to confirm the happy path. The defects are
 * named in each test, because a control whose failure mode nobody can state is
 * a control nobody can trust.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTendingEntities, mergeTending, person } from '../core/tending-bootstrap.mjs';
import { assertTendingShape, jsonLdToDomain, domainToJsonLd } from '../core/jsonld.mjs';
import { promptVersionId, playlistVersionId } from '../core/tending-ids.mjs';

const IMPORTED_AT = '2026-08-15T00:00:00.000Z';

/** The three live prompts, with the provenance actually evidenced on the board. */
const PROMPTS = [
  {
    slug: 'hello-ladies',
    body: '*quietly* Shhhhh… hello ladies. Things have gone quiet.',
    author: 'wren',
    evidencedBy: ['git:2a6f4d0', 'b2d746ab-e9eb-4641-82bd-5b86074d15b9'],
    influencedBy: 'michael',
    provenanceNote:
      'Greeting register attributed to michael, adopted room-wide from '
      + '2026-05-19. Influence, explicitly not authorship or co-authorship.',
  },
  {
    slug: 'nobody-watching',
    body: "*quietly* Hello, you. The room's gone still.",
    author: 'wren',
    evidencedBy: ['git:2a6f4d0', '266f5a67-da33-46f8-a6f3-82ff4bd03a43'],
    provenanceNote:
      'No seat utterance found in board-graph history searched 2026-08-15. '
      + 'Not evidence of never-sent.',
  },
  { slug: 'quiet-hour', body: '*quietly* Shhhh. Quiet hour.', author: 'wren' },
];

const STATE = {
  history: [{
    window: '2026-08-14T22:00:00.000Z',
    seat: 'wren',
    at: '2026-08-14T22:45:36.788Z',
    reached: [],
  }],
};

const build = (over = {}) => buildTendingEntities({
  prompts: PROMPTS, config: { enabled: true }, state: STATE, importedAt: IMPORTED_AT, ...over,
});

const byId = (es, id) => es.find((e) => e['@id'] === id);
const ofType = (es, t) => es.filter((e) => e['@type'] === t);

// ── IDEMPOTENCY ────────────────────────────────────────────────────────────

test('⭐ re-running the bootstrap UPSERTS rather than duplicating', () => {
  // DEFECT: a bootstrap keyed on anything non-deterministic (a fresh UUID, a
  // wall clock) appends a second copy of every node on the second run. The
  // board then holds two playlists and six prompt versions, with no error.
  const domain = { tending: [] };
  const once = mergeTending(domain, build());
  const twice = mergeTending(once, build());

  assert.equal(twice.tending.length, once.tending.length,
    're-bootstrapping must not grow the graph');
  assert.deepEqual(
    twice.tending.map((e) => e['@id']).sort(),
    once.tending.map((e) => e['@id']).sort(),
  );
});

test('the legacy grant keeps ONE id across runs — it is a closed historical set', () => {
  // DEFECT: using newEventKey() here would mint a fresh UUID per run, so every
  // bootstrap would append another copy of the same 22:00 grant.
  const a = ofType(build(), 'scrum:TendingClaimAttempt');
  const b = ofType(build(), 'scrum:TendingClaimAttempt');
  assert.equal(a.length, 1);
  assert.equal(a[0]['@id'], b[0]['@id']);
});

test('merging leaves entities this bootstrap did not produce untouched', () => {
  // DEFECT: a bootstrap that replaces domain.tending wholesale would delete the
  // runtime writers' nodes (#804) on every run.
  const runtimeNode = { '@id': 'https://scrumboard.local/tending/mint/abc', '@type': 'scrum:TendingMint' };
  const merged = mergeTending({ tending: [runtimeNode] }, build());
  assert.ok(byId(merged.tending, runtimeNode['@id']), "a runtime writer's node must survive");
});

// ── PROVENANCE: the card's central requirement ─────────────────────────────

test('⭐ ABSENT author stays absent — it never defaults to anyone', () => {
  // DEFECT: defaulting an unknown author to the committer, or to the seat that
  // ran the bootstrap, invents provenance. That is the failure this card was
  // written to prevent, on the night the room had an attribution incident.
  const es = build({ prompts: [{ slug: 'orphan', body: 'text of unknown origin' }] });
  const v = byId(es, promptVersionId('orphan', 1));
  assert.ok(v, 'the version must exist');
  assert.equal('author' in v, false, 'no author key at all — not null, not a guess');
});

test('influencedBy is carried and is NOT author', () => {
  // DEFECT: collapsing register-influence into authorship would make michael a
  // co-author of a prompt he did not write.
  const v = byId(build(), promptVersionId('hello-ladies', 1));
  assert.equal(v.author, person('wren'));
  assert.equal(v['scrum:influencedBy'], person('michael'));
  assert.notEqual(v.author, v['scrum:influencedBy']);
});

test('⭐ no version carries a "first sent" superlative', () => {
  // DEFECT: firstSentBy/firstSentAt are claims about a SEARCH published as
  // properties of the thing. A later backfill finding an earlier utterance
  // makes them false, and an immutable node cannot be corrected.
  for (const v of ofType(build(), 'scrum:TendingPromptVersion')) {
    assert.equal('scrum:firstSentBy' in v, false);
    assert.equal('scrum:firstSentAt' in v, false);
  }
});

test('evidencedBy points at durable sources rather than restating them', () => {
  // DEFECT: copying the 161 existing utterance Comments into prompt fields
  // replaces a primary source with a summary of it, and the copy drifts.
  const v = byId(build(), promptVersionId('hello-ladies', 1));
  assert.deepEqual(v['scrum:evidencedBy'], ['git:2a6f4d0', 'b2d746ab-e9eb-4641-82bd-5b86074d15b9']);
});

// ── LEGACY: do not manufacture facts ───────────────────────────────────────

test('⭐ the legacy grant is NOT relabelled as a silence', () => {
  // DEFECT: the successor keys on silence; this grant settled a CLOCK WINDOW.
  // Calling the old window a silence key would invent a fact the record cannot
  // support, and it would be invisible afterwards.
  const mint = ofType(build(), 'scrum:TendingMint')[0];
  assert.equal(mint['scrum:legacyClockWindow'], '2026-08-14T22:00:00.000Z');
  assert.equal('scrum:ofSilence' in mint, false, 'no silence edge may be manufactured');
  assert.equal(ofType(build(), 'scrum:TendingSilence').length, 0);
});

test('the legacy attempt records a declared seat and NO bound actor', () => {
  // DEFECT: promoting the sidecar's declared seat to `actor` would assert the
  // caller was authenticated. The flat store never knew that.
  const at = ofType(build(), 'scrum:TendingClaimAttempt')[0];
  assert.equal(at['scrum:declaredSeatRaw'], 'wren');
  assert.equal(at['scrum:declaredSeat'], person('wren'));
  assert.equal('scrum:actor' in at, false, 'bound actor is unknowable here and must be absent');
});

test('empty reached is preserved as a measurement, not dropped', () => {
  // DEFECT: dropping an empty array loses the distinction between "measured,
  // and it was zero" and "never measured".
  const mint = ofType(build(), 'scrum:TendingMint')[0];
  assert.deepEqual(mint['scrum:seatNamesWithOpenStreamsAtSend'], []);
});

test('state imports enabled but INVENTS no pausedAt/pausedBy', () => {
  // DEFECT: the flat config carried neither. Backfilling "paused by whoever
  // deployed" would be exactly the invented provenance this card forbids.
  const s = byId(build(), 'https://scrumboard.local/tending/state/current');
  assert.equal(s['scrum:enabled'], true);
  assert.equal('scrum:pausedAt' in s, false);
  assert.equal('scrum:actor' in s, false);
});

// ── ORDER: the playlist's whole reason to exist ────────────────────────────

test('⭐ orderedPrompts is {"@list":[…]} and survives the shape gate', () => {
  // DEFECT: a bare array is an unordered SET in JSON-LD. It round-trips in
  // order today and carries no guarantee. This module emitted one on its first
  // draft; assertTendingShape caught it on first contact.
  const pv = byId(build(), playlistVersionId('room-tending', 1));
  assert.ok(!Array.isArray(pv['scrum:orderedPrompts']), 'must not be a bare array');
  assert.deepEqual(pv['scrum:orderedPrompts']['@list'], [
    promptVersionId('hello-ladies', 1),
    promptVersionId('nobody-watching', 1),
    promptVersionId('quiet-hour', 1),
  ]);
  assert.doesNotThrow(() => assertTendingShape(pv));
});

test('⛔ NEGATIVE: flattening the wrapper to a bare array is REFUSED', () => {
  const pv = { ...byId(build(), playlistVersionId('room-tending', 1)) };
  pv['scrum:orderedPrompts'] = pv['scrum:orderedPrompts']['@list'];   // the mutation
  assert.throws(() => assertTendingShape(pv), /bare array/);
});

test('⭐ order survives a real save → load round trip through the graph', () => {
  // DEFECT: order that holds only inside this module proves nothing. This is
  // the one control that exercises the actual serializer both directions.
  const domain = mergeTending({ nodes: [], messages: [], people: [], columns: [] }, build());
  const reloaded = jsonLdToDomain(domainToJsonLd(domain));
  const pv = byId(reloaded.tending, playlistVersionId('room-tending', 1));
  assert.deepEqual(pv['scrum:orderedPrompts']['@list'], [
    promptVersionId('hello-ladies', 1),
    promptVersionId('nobody-watching', 1),
    promptVersionId('quiet-hour', 1),
  ], 'the exact sequence must survive the round trip');
});

test('tending entities do not surface as phantom cards', () => {
  // DEFECT: the pre-slice-zero partition made any unknown @type a card. Every
  // prompt version would have appeared in card_list on the next load.
  const domain = mergeTending({ nodes: [], messages: [], people: [], columns: [] }, build());
  const reloaded = jsonLdToDomain(domainToJsonLd(domain));
  assert.equal(reloaded.nodes.length, 0, 'no tending entity may become a card');
  assert.ok(reloaded.tending.length >= 9);
});

// ── GUARDS ─────────────────────────────────────────────────────────────────

test('a prompt without slug or body is refused rather than half-written', () => {
  assert.throws(() => build({ prompts: [{ body: 'no slug' }] }), /slug and body/);
  assert.throws(() => build({ prompts: [] }), /non-empty/);
});

test('importedAt is required — the migration timestamp is recorded, never inferred', () => {
  assert.throws(
    () => buildTendingEntities({ prompts: PROMPTS, importedAt: undefined }),
    /importedAt is required/,
  );
});
