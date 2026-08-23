/**
 * Server-side tests for the JSON-file storage adapter (core/store.mjs).
 *
 * Behavior tests against THROWAWAY temp files — never the live board-data.json,
 * so they cannot race the running :3141 server (#47). The adapter owns the file
 * conventions (atomic write, _README-first, lastUpdated stamp); the domain core
 * stays pure (ADR-002 D2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDomain, saveDomain } from '../core/store.mjs';

const tmpFile = (name = 'board-data.json') =>
  join(mkdtempSync(join(tmpdir(), 'scrum-store-')), name);

const seedBoard = {
  _README: ['⚠️  do not edit directly'],
  cards: [{
    id: 'c1', shortId: 1, title: 'A', description: '', type: 'task',
    assignees: ['sage'], labels: [], for: '', priority: null, column: 'backlog',
    order: 0, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    relationships: { relatedTo: [], blockedBy: [] },
  }],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [{
    id: 'm1', body: 'hi', author: 'alex', attachedTo: null,
    attachments: [], mentions: [], createdAt: '2026-05-01T00:00:00.000Z',
  }],
  nextShortId: 2,
  lastUpdated: '2026-05-01T00:00:00.000Z',
};

test('loadDomain projects a raw board file into nodes + messages + passthrough meta', () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify(seedBoard));
  const d = loadDomain(f);
  assert.equal(d.nodes.length, 1);
  assert.equal(d.messages.length, 1);
  assert.equal(d.nodes[0]['@type'], 'CreativeWork');
  assert.equal(d.messages[0]['@type'], 'Comment');
  assert.equal(d.nextShortId, 2);
});

test('saveDomain persists schema.org JSON-LD: _README first, @graph, meta stamped', () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify(seedBoard));   // seed in the LEGACY shape
  saveDomain(f, loadDomain(f), { now: '2026-06-15T00:00:00.000Z' });
  const written = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(Object.keys(written)[0], '_README', '_README leads the file');
  assert.equal(written['@context']['@vocab'], 'https://schema.org/', 'schema.org-shaped on disk');
  assert.ok(Array.isArray(written['@graph']), 'content lives in @graph');
  const card = written['@graph'].find((e) => e['@type'] === 'CreativeWork');
  assert.ok(card && card.name === 'A', 'the card persisted as a CreativeWork node');
  assert.ok(written['@graph'].some((e) => e['@type'] === 'Comment'), 'the message persisted as a Comment');
  assert.equal(written['scrum:meta'].lastUpdated, '2026-06-15T00:00:00.000Z', 'lastUpdated stamped in meta');
  assert.ok(written['@graph'].some((e) => e['@type'] === 'scrum:Column'), 'columns ride in @graph (#687)');
});

test('loadDomain reads back the JSON-LD it wrote (canonical format round-trips through disk)', () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify(seedBoard));
  const d1 = loadDomain(f);                       // legacy → domain
  saveDomain(f, d1, { now: '2026-06-15T00:00:00.000Z' });   // → JSON-LD on disk
  const onDisk = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(!('cards' in onDisk), 'no legacy cards key — file is JSON-LD');
  const d2 = loadDomain(f);                        // JSON-LD → domain
  assert.deepEqual(d2.nodes, d1.nodes);
  assert.deepEqual(d2.messages, d1.messages);
});

test('persistence round-trip is stable: load → save → load preserves domain content', () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify(seedBoard));
  const d1 = loadDomain(f);
  saveDomain(f, d1, { now: '2026-06-15T00:00:00.000Z' });
  const d2 = loadDomain(f);
  assert.deepEqual(d2.nodes, d1.nodes);
  assert.deepEqual(d2.messages, d1.messages);
  assert.deepEqual(d2.columns, d1.columns);
  assert.equal(d2.nextShortId, d1.nextShortId);
});

test('loadDomain on a missing file returns an empty domain', () => {
  const d = loadDomain(tmpFile('does-not-exist.json'));
  assert.deepEqual(d.nodes, []);
  assert.deepEqual(d.messages, []);
  assert.equal(d.nextShortId, 1);
});

/**
 * #1014 — THE CONTRACT A CACHE MUST NOT BREAK.
 *
 * `loadDomain` re-reads and re-parses the whole store on every call, which is
 * why 8 concurrent readers cost 8×110 ms (measured: a 0.89 s wall against a
 * 0.10 s control on a route that reads nothing). The obvious fix is to memoize
 * the parsed domain — and the obvious memoization is WRONG, because callers
 * MUTATE what they are handed: server.js:489 writes `c.mentions` onto
 * conversations and :503 replaces `data.columns`.
 *
 * A cache that returns one shared object therefore leaks one request's
 * mutations into the next — a corruption that returns 200 and passes every
 * other test in this file. These two tests pin the contract BEFORE the cache
 * exists, so the cache cannot land without honouring it.
 *
 * ⚠️ Honest note on what these can and cannot catch: with no cache they pass
 * trivially, because reparsing isolates for free. Their discriminating power is
 * against a NAIVE cache, and that was verified by building one — see #1014.
 */
test('#1014 loadDomain hands back an isolated object — a caller mutation must not reach the next load', () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify(seedBoard));

  const first = loadDomain(f);
  // Exactly what server.js does to the value it is handed.
  first.messages[0].mentions = ['MUTATED_BY_A_PREVIOUS_REQUEST'];
  first.columns = [{ id: 'CLOBBERED', name: 'CLOBBERED', order: 0 }];
  first.nodes[0].name = 'MUTATED';

  const second = loadDomain(f);

  assert.deepEqual(second.messages[0].mentions, [],
    'a previous caller\'s mutation of `mentions` must not be visible to the next load');
  assert.equal(second.columns[0].id, 'backlog',
    'a previous caller replacing `columns` must not be visible to the next load');
  assert.equal(second.nodes[0].name, 'A',
    'a previous caller mutating a node must not be visible to the next load');
});

test('#1014 loadDomain reflects a file that changed underneath it', () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify(seedBoard));
  assert.equal(loadDomain(f).nodes[0].name, 'A');

  // A second writer moves the store on. Any cache must notice.
  const moved = structuredClone(seedBoard);
  moved.cards[0].title = 'B';
  moved.lastUpdated = '2026-05-02T00:00:00.000Z';
  writeFileSync(f, JSON.stringify(moved));
  // Force a distinct mtime: same-millisecond writes are real, and a cache keyed
  // on mtime alone would serve the stale parse without this being deliberate.
  const future = new Date(Date.now() + 2000);
  utimesSync(f, future, future);

  assert.equal(loadDomain(f).nodes[0].name, 'B',
    'a store that moved on disk must be visible to the next load');
});
