/**
 * #804 slice zero — the JSON-LD entity partition must be able to hold a new
 * class, and must REFUSE to silently reclassify one it does not know.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ───────────────────────────────────────
 *
 * `jsonLdToDomain` partitioned the graph with a three-way whitelist —
 * Comment, Person, scrum:Column — and everything else fell through into
 * `nodes`, which round-trips through nodeToCard. So an unrecognised @type was
 * not rejected; it was SILENTLY CONVERTED INTO A CARD on the next load, and
 * surfaced in card_list, which is how this room sees itself.
 *
 * The file already warned about this for people and columns (#686/#687). The
 * fallthrough was fine while three classes were all that existed. It stops
 * being fine the moment anything else needs to live in the graph — which is
 * what "graph first" requires.
 *
 * ⭐ The tending system is the first such thing, but this test is deliberately
 * written against a SYNTHETIC unknown type, not against tending: the property
 * under test is that the partition is closed, not that one particular class
 * was added to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd, jsonLdToDomain, TENDING_TYPES } from '../core/jsonld.mjs';

const baseDomain = () => ({
  nodes: [{ '@id': 'entity:c1', '@type': 'CreativeWork', identifier: 1, name: 'a card', board: {} }],
  messages: [{ '@id': 'entity:m1', '@type': 'Comment', text: 'hi' }],
  people: [{ '@id': 'person:ada', '@type': 'Person', name: 'ada' }],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  nextShortId: 2,
});

// ── the existing four classes still round-trip ────────────────────────────

test('cards, messages, people and columns survive a round trip unchanged', () => {
  const d = baseDomain();
  const back = jsonLdToDomain(domainToJsonLd(d));
  assert.equal(back.nodes.length, 1);
  assert.equal(back.messages.length, 1);
  assert.equal(back.people.length, 1);
  assert.equal(back.columns.length, 1);
  assert.equal(back.nextShortId, 2);
});

// ── ⭐ THE FALLTHROUGH: an unknown type must NOT become a card ─────────────

test('⛔ an UNKNOWN @type does not silently become a card', () => {
  // ⇒ THE DISCRIMINATION: before slice zero this entity landed in `nodes` and
  // reappeared in card_list as a phantom. The bug produced no error, no log,
  // and a plausible-looking card — which is the worst possible failure shape.
  const doc = domainToJsonLd(baseDomain());
  doc['@graph'].push({ '@id': 'entity:x1', '@type': 'scrum:SomethingNobodyModelled', name: 'not a card' });

  const back = jsonLdToDomain(doc);
  const ids = back.nodes.map((n) => n['@id'] ?? n.id);
  assert.equal(
    ids.includes('entity:x1'), false,
    'an unmodelled entity must never surface as a card',
  );
});

test('⚠️ and it is PRESERVED rather than dropped — silent deletion is the other bad answer', () => {
  // Refusing to make it a card is only half. Discarding it would make the
  // serializer lossy, and a store that quietly loses entities is worse than
  // one that misfiles them: at least a phantom card is visible.
  const doc = domainToJsonLd(baseDomain());
  const stranger = { '@id': 'entity:x1', '@type': 'scrum:SomethingNobodyModelled', name: 'not a card', keep: 'me' };
  doc['@graph'].push(stranger);

  const back = jsonLdToDomain(doc);
  const again = domainToJsonLd(back);
  const found = again['@graph'].find((e) => e['@id'] === 'entity:x1');
  assert.ok(found, 'the unknown entity survives the round trip');
  assert.equal(found.keep, 'me', 'and carries its unmodelled fields verbatim');
});

// ── the tending classes specifically ──────────────────────────────────────

test('the tending types are declared, and are not cards', () => {
  // graph-first: these are first-class citizens of @graph beside cards,
  // messages, people and columns — not a sidecar file, not a card facet.
  assert.ok(Array.isArray(TENDING_TYPES) && TENDING_TYPES.length > 0);
  const doc = domainToJsonLd(baseDomain());
  for (const t of TENDING_TYPES) {
    doc['@graph'].push({ '@id': `entity:${t}-1`, '@type': t, name: t });
  }
  const back = jsonLdToDomain(doc);
  assert.equal(back.nodes.length, 1, 'still exactly one card — tending nodes are not cards');
  assert.equal(back.tending.length, TENDING_TYPES.length, 'they land in their own class');
});

test('tending entities round-trip losslessly, with their fields intact', () => {
  const doc = domainToJsonLd(baseDomain());
  doc['@graph'].push({
    '@id': 'entity:prompt-1',
    '@type': 'scrum:TendingPromptVersion',
    'scrum:body': 'hello',
    'schema:author': 'person:ada',
    'schema:dateCreated': '2026-08-14T23:00:00.000Z',
    'scrum:version': 1,
  });
  const back = jsonLdToDomain(doc);
  const again = domainToJsonLd(back);
  const p = again['@graph'].find((e) => e['@id'] === 'entity:prompt-1');
  assert.equal(p['@type'], 'scrum:TendingPromptVersion');
  assert.equal(p['scrum:body'], 'hello');
  assert.equal(p['schema:author'], 'person:ada');
  assert.equal(p['scrum:version'], 1);
});

test('a board with NO tending entities does not sprout an empty key', () => {
  // Absence preserved, not coerced — the same rule people already follows,
  // so an untouched board's file does not churn on first save.
  const back = jsonLdToDomain(domainToJsonLd(baseDomain()));
  assert.equal('tending' in back, false);
});

// ── ⭐ ORDER MUST BE DECLARED, NOT INCIDENTAL ─────────────────────────────

test('⭐ an @list-wrapped predicate keeps BOTH its wrapper and its order across save→load→save', () => {
  // In JSON-LD a bare array is a SET — multi-valued predicates are unordered
  // by specification. A playlist whose order survives only because JSON
  // happens to round-trip arrays in sequence has an ordering guarantee held
  // by accident of the current implementation, and any framing, compaction or
  // normalisation step is free to break it.
  //
  // ⚠️ THE DISCRIMINATION: a naive path that does `Array.isArray(v)` or
  // spreads the value would flatten {"@list":[…]} into a bare array. The order
  // would still LOOK right in this test — so asserting order alone proves
  // nothing. The assertion that discriminates is that the WRAPPER survives,
  // because the wrapper is the thing that makes the order a declaration.
  const doc = domainToJsonLd({
    ...baseDomain(),
    tending: [{
      '@id': 'entity:pl-v1',
      '@type': 'scrum:TendingPlaylistVersion',
      'scrum:orderedPrompts': { '@list': ['entity:p3', 'entity:p1', 'entity:p2'] },
      'scrum:version': 1,
    }],
  });
  const twice = domainToJsonLd(jsonLdToDomain(doc));
  const pl = twice['@graph'].find((e) => e['@id'] === 'entity:pl-v1');

  assert.ok(pl['scrum:orderedPrompts']['@list'], 'the @list wrapper survives — order is DECLARED');
  assert.deepEqual(
    pl['scrum:orderedPrompts']['@list'],
    ['entity:p3', 'entity:p1', 'entity:p2'],
    'and the sequence is the one that was written, not sorted or set-ified',
  );
});

test('⛔ a playlist version with a BARE ARRAY is REFUSED at load, not quietly accepted', () => {
  // ⚠️ Preservation is not enforcement. This module uses JSON-LD as a
  // vocabulary — nothing expands to triples — so declaring @container:@list in
  // the context does not by itself make a bare array illegal. Without this
  // check a playlist could be written with a plain array, round-trip
  // perfectly, and carry an ordering guarantee that exists only in the
  // writer's intention.
  const doc = domainToJsonLd(baseDomain());
  doc['@graph'].push({
    '@id': 'entity:pl-bad',
    '@type': 'scrum:TendingPlaylistVersion',
    'scrum:orderedPrompts': ['entity:p1', 'entity:p2'],   // ⇐ bare array
  });
  assert.throws(() => jsonLdToDomain(doc), /bare array|@list/i);
});

test('a playlist version with NO orderedPrompts is allowed — absent is not malformed', () => {
  const doc = domainToJsonLd(baseDomain());
  doc['@graph'].push({ '@id': 'entity:pl-empty', '@type': 'scrum:TendingPlaylistVersion' });
  assert.doesNotThrow(() => jsonLdToDomain(doc));
});
