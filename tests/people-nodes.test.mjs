/**
 * #686 — people become GRAPH NODES: Person entities materialized into @graph
 * at write time, from the roster + observed actors, by one function from one
 * authority. The #686 reframe (principal-ruled, see the card): #619's
 * derive-on-read was an interim step whose rationale the event log dissolved —
 * a node materialized at projection time is rebuilt, never synced, so #618's
 * drift stays unrepresentable AND the node is real.
 *
 * The #619 consent guard survives intact and is pinned here: PERSON_SOURCE_FIELDS
 * stays closed, mentions never mint a person, EXCLUDED_IDENTITIES never appear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { domainToJsonLd, jsonLdToDomain, PERSON_IRI_BASE } from '../core/jsonld.mjs';
import { ensurePeople, EXCLUDED_IDENTITIES } from '../core/people.mjs';
import { loadDomain, saveDomain } from '../core/store.mjs';

const ROSTER = { seats: {
  ada: { name: 'Ada', glyph: '🅰️', aliases: ['adalovelace'] },
  bex: { name: 'Bex', glyph: '🅱️', aliases: [] },
  board: { name: 'Board', glyph: '🤖', aliases: [] },   // roster member, NOT a person
} };

const mkDomain = () => ({
  nodes: [
    { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
      additionalType: 'scrum:task', creator: 'ada',
      board: { assignees: ['bex'], labels: [], column: 'backlog', order: 0 } },
  ],
  messages: [
    { '@type': 'Comment', '@id': 'm1', text: 'hi', author: 'Ghost', about: null,
      dateCreated: '2026-08-05T00:00:00Z', mentions: ['stranger_handle'] },
  ],
  columns: [], nextShortId: 2, lastUpdated: null,
});

// ── the document layer ─────────────────────────────────────────────────────

test('Person nodes ride @graph and round-trip exactly — and never pollute nodes or messages', () => {
  const domain = mkDomain();
  domain.people = [
    { '@type': 'Person', '@id': `${PERSON_IRI_BASE}bex`, identifier: 'bex',
      name: 'Bex', 'scrum:glyph': '🅱️', 'scrum:resolved': true, 'scrum:aliases': [] },
  ];
  const doc = domainToJsonLd(domain);
  const inGraph = doc['@graph'].filter((e) => e['@type'] === 'Person');
  assert.equal(inGraph.length, 1, 'the Person is IN the graph document');
  const back = jsonLdToDomain(doc);
  assert.deepEqual(back, domain, 'exact inverse with people present');
  // THE PHANTOM-CARD CONTROL: a Person must never round-trip into the card
  // collection — that failure would surface people in card_list as cards.
  assert.equal(back.nodes.some((n) => n['@type'] === 'Person'), false);
  assert.equal(back.messages.some((n) => n['@type'] === 'Person'), false);
});

test('people-absent domains keep their existing exact round-trip (no people key invented)', () => {
  const domain = mkDomain();
  const back = jsonLdToDomain(domainToJsonLd(domain));
  assert.deepEqual(back, domain);
  assert.equal('people' in back, false, 'absence is preserved, not converted to []');
});

test('@context declares person-reference terms as @id-typed — and mentions deliberately NOT', () => {
  const doc = domainToJsonLd(mkDomain());
  const ctx = doc['@context'];
  for (const term of ['creator', 'author', 'assignees', 'claimedBy']) {
    assert.equal(ctx[term]?.['@type'], '@id', `${term} declared as an IRI reference`);
    assert.equal(ctx[term]?.['@context']?.['@base'], PERSON_IRI_BASE,
      `${term} strings resolve in the person IRI space`);
  }
  // The #619 consent guard at the vocabulary level: mentions are regex-scraped
  // prose holding real external people's handles. Declaring them @id-typed
  // would mint IRIs for strangers. The absence is the design.
  assert.equal(ctx.mentions, undefined, 'mentions must NOT be an @id-typed term');
});

// ── the materialization ────────────────────────────────────────────────────

test('ensurePeople mints from roster + observed actors; excludes non-persons; consent guard holds', () => {
  const out = ensurePeople(mkDomain(), ROSTER);
  const keys = out.people.map((p) => p.identifier);
  assert.ok(keys.includes('ada'), 'roster seat observed as creator');
  assert.ok(keys.includes('bex'), 'roster seat observed as assignee');
  assert.ok(keys.includes('Ghost'), 'unknown author surfaces as a node');
  assert.equal(out.people.find((p) => p.identifier === 'Ghost')['scrum:resolved'], false,
    'unknown identity is marked, never guessed');
  assert.equal(keys.includes('stranger_handle'), false,
    'CONSENT GUARD: a mentions-only handle must never become a Person');
  for (const ex of EXCLUDED_IDENTITIES) {
    assert.equal(keys.includes(ex), false, `${ex} is a role, not a person`);
  }
  const iri = out.people.find((p) => p.identifier === 'bex')['@id'];
  assert.equal(iri, `${PERSON_IRI_BASE}bex`, 'node @id lives where the @context points');
});

test('ensurePeople is deterministic and idempotent — materialized, not accumulated', () => {
  const once = ensurePeople(mkDomain(), ROSTER);
  const twice = ensurePeople(once, ROSTER);
  assert.deepEqual(twice.people, once.people, 'second pass changes nothing');
  const again = ensurePeople(mkDomain(), ROSTER);
  assert.deepEqual(again.people, once.people, 'same inputs, byte-same output (rebuild-safe)');
});

// ── the write boundary ─────────────────────────────────────────────────────

test('saveDomain with a roster mints people into the stored document; without one it PRESERVES them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people686-'));
  const file = path.join(dir, 'board.json');

  saveDomain(file, mkDomain(), { now: '2026-08-05T02:30:00Z', roster: ROSTER });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const persons = stored['@graph'].filter((e) => e['@type'] === 'Person');
  assert.ok(persons.length >= 2, 'people are IN the persisted graph');

  // The preservation control (write-granularity): a roster-less save — the
  // redact CLI, a script — must not strip the people a rostered writer minted.
  const reloaded = loadDomain(file);
  saveDomain(file, reloaded, { now: '2026-08-05T02:31:00Z' });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    after['@graph'].filter((e) => e['@type'] === 'Person'), persons,
    'roster-less save preserves existing Person nodes byte-for-byte');
});
