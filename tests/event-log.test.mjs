/**
 * #669 (slice 1 of #642) — the append-only event log.
 *
 * Behavior tests against THROWAWAY temp dirs — never the live board (#47).
 *
 * The four invariants the room set as the acceptance bar:
 *   1. seq is monotonic and total, assigned under the caller's write lock.
 *   2. A validation failure appends NOTHING — validate → append → project.
 *   3. Full state per event; the log is append-only and never rewritten.
 *   4. Genesis snapshot + replay reproduces the store exactly.
 *
 * ⚠️ Each test here was seen RED before its green was trusted (#666 discipline).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, nextSeq, replay, EVENT_OPS } from '../core/event-log.mjs';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'scrum-eventlog-'));

const cardEvent = (over = {}) => ({
  actor: 'ada',
  op: 'update',
  entity: { kind: 'card', id: 'c1', shortId: 1 },
  state: { id: 'c1', shortId: 1, title: 'A', column: 'backlog' },
  ...over,
});

// ── 1. seq: monotonic, total, survives segmentation ───────────────────────

test('#669 seq starts at 1 and increases monotonically', () => {
  const dir = tmpDir();
  const a = appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:00.000Z' });
  const b = appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:01.000Z' });
  const c = appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:02.000Z' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(c.seq, 3);
  assert.equal(nextSeq(dir), 4);
});

test('#669 seq stays monotonic ACROSS day segments (the total order is global)', () => {
  const dir = tmpDir();
  appendEvent(dir, cardEvent(), { now: '2026-08-04T23:59:59.000Z' });
  const rolled = appendEvent(dir, cardEvent(), { now: '2026-08-05T00:00:01.000Z' });
  // Two segments on disk, but one continuous sequence.
  const files = readdirSync(dir).filter((f) => f.startsWith('events-')).sort();
  assert.equal(files.length, 2, `expected 2 day segments, got ${files.join(',')}`);
  assert.equal(rolled.seq, 2, 'seq must not restart in a new segment');
  assert.deepEqual(readEvents(dir).map((e) => e.seq), [1, 2]);
});

test('#669 a fresh log reports nextSeq 1 and reads back empty', () => {
  const dir = tmpDir();
  assert.equal(nextSeq(dir), 1);
  assert.deepEqual(readEvents(dir), []);
});

// ── 2. validate → append → project: a bad event appends NOTHING ───────────

test('#669 validation failure appends NOTHING — the log is untouched', () => {
  const dir = tmpDir();
  appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:00.000Z' });
  const before = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');

  for (const bad of [
    cardEvent({ op: 'frobnicate' }),              // closed vocabulary
    cardEvent({ op: undefined }),
    cardEvent({ entity: undefined }),
    cardEvent({ entity: { kind: 'card' } }),      // no id
    cardEvent({ entity: { kind: 'wombat', id: 'x' } }),
  ]) {
    assert.throws(() => appendEvent(dir, bad, { now: '2026-08-04T10:00:05.000Z' }));
  }

  const after = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
  assert.equal(after, before, 'a rejected event must leave the log byte-identical');
  assert.equal(nextSeq(dir), 2, 'a rejected event must not burn a seq');
});

test('#669 the op vocabulary is CLOSED — #681 added redact, and nothing else since', () => {
  // Slice 1 asserted `redact` ABSENT, deliberately pinning its own boundary; the
  // op arrived with #681 under the #642 R8 ruling, so this test failing was the
  // intended signal, not a regression. The control that matters is unchanged: an
  // op outside this set is a rejected write, so growing the list stays a decision
  // someone makes on purpose rather than a thing that drifts.
  assert.deepEqual([...EVENT_OPS].sort(), ['create', 'delete', 'post', 'redact', 'update']);
});

// ── 3. append-only, full state, one line per event ────────────────────────

test('#669 one JSON object per line, full state preserved verbatim', () => {
  const dir = tmpDir();
  const big = { id: 'c1', shortId: 1, title: 'A', description: 'x'.repeat(500), column: 'done' };
  appendEvent(dir, cardEvent({ state: big }), { now: '2026-08-04T10:00:00.000Z' });
  const file = join(dir, 'events-2026-08-04.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed.state, big, 'state is the FULL entity, not a diff');
  assert.equal(parsed.actor, 'ada');
  assert.equal(parsed.recorded_at, '2026-08-04T10:00:00.000Z');
});

test('#669 appending never rewrites an earlier line', () => {
  const dir = tmpDir();
  appendEvent(dir, cardEvent({ state: { id: 'c1', title: 'first' } }), { now: '2026-08-04T10:00:00.000Z' });
  const file = join(dir, 'events-2026-08-04.jsonl');
  const firstLine = readFileSync(file, 'utf8').split('\n')[0];
  appendEvent(dir, cardEvent({ state: { id: 'c1', title: 'second' } }), { now: '2026-08-04T10:00:01.000Z' });
  assert.equal(readFileSync(file, 'utf8').split('\n')[0], firstLine, 'line 1 must be untouched');
  const evs = readEvents(dir);
  assert.equal(evs[0].state.title, 'first', 'the prior version survives — versions, not diffs');
  assert.equal(evs[1].state.title, 'second');
});

test('#669 occurred_at defaults to recorded_at but is preserved when supplied', () => {
  const dir = tmpDir();
  const a = appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:00.000Z' });
  assert.equal(a.occurred_at, '2026-08-04T10:00:00.000Z');
  const b = appendEvent(dir, cardEvent({ occurred_at: '2026-08-01T00:00:00.000Z' }),
    { now: '2026-08-04T10:00:01.000Z' });
  assert.equal(b.occurred_at, '2026-08-01T00:00:00.000Z');
  assert.equal(b.recorded_at, '2026-08-04T10:00:01.000Z');
});

// ── 4. genesis snapshot + replay reproduces the store ─────────────────────

test('#669 replay of genesis + events reproduces the board exactly', () => {
  const dir = tmpDir();
  const genesis = {
    cards: [{ id: 'c1', shortId: 1, title: 'A' }],
    conversations: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    nextShortId: 2,
  };
  appendEvent(dir, {
    actor: 'ada', op: 'create',
    entity: { kind: 'card', id: 'c2', shortId: 2 },
    state: { id: 'c2', shortId: 2, title: 'B' },
  }, { now: '2026-08-04T10:00:00.000Z' });
  appendEvent(dir, {
    actor: 'cyd', op: 'update',
    entity: { kind: 'card', id: 'c1', shortId: 1 },
    state: { id: 'c1', shortId: 1, title: 'A-edited' },
  }, { now: '2026-08-04T10:00:01.000Z' });
  appendEvent(dir, {
    actor: 'bex', op: 'post',
    entity: { kind: 'conversation', id: 'm1' },
    state: { id: 'm1', body: 'hi', author: 'bex' },
  }, { now: '2026-08-04T10:00:02.000Z' });

  const out = replay(genesis, readEvents(dir));
  assert.equal(out.cards.length, 2);
  assert.equal(out.cards.find((c) => c.id === 'c1').title, 'A-edited', 'update applied');
  assert.equal(out.cards.find((c) => c.id === 'c2').title, 'B', 'create applied');
  assert.equal(out.conversations.length, 1, 'post applied');
  assert.equal(out.columns.length, 1, 'untouched collections carried through');
});

test('#669 replay applies delete as a removal, and the tombstone keeps the last state', () => {
  const dir = tmpDir();
  const genesis = { cards: [{ id: 'c1', shortId: 1, title: 'A' }], conversations: [], columns: [] };
  appendEvent(dir, {
    actor: 'ada', op: 'delete',
    entity: { kind: 'card', id: 'c1', shortId: 1 },
    state: { id: 'c1', shortId: 1, title: 'A' },   // tombstone = last known body
  }, { now: '2026-08-04T10:00:00.000Z' });
  const out = replay(genesis, readEvents(dir));
  assert.equal(out.cards.length, 0, 'deleted card is gone from the projection');
  assert.equal(readEvents(dir)[0].state.title, 'A', 'but the tombstone still carries its body');
});

test('#669 replay is a PURE function — it does not mutate the genesis snapshot', () => {
  const dir = tmpDir();
  const genesis = { cards: [{ id: 'c1', shortId: 1, title: 'A' }], conversations: [], columns: [] };
  const frozen = JSON.stringify(genesis);
  appendEvent(dir, cardEvent({ state: { id: 'c1', shortId: 1, title: 'mutated' } }),
    { now: '2026-08-04T10:00:00.000Z' });
  replay(genesis, readEvents(dir));
  assert.equal(JSON.stringify(genesis), frozen, 'genesis must be untouched by replay');
});

// ── bounded reads (the shape slice 2 will build on) ───────────────────────

test('#669 readEvents honours sinceSeq and limit', () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i++) {
    appendEvent(dir, cardEvent(), { now: `2026-08-04T10:00:0${i}.000Z` });
  }
  assert.deepEqual(readEvents(dir, { sinceSeq: 2 }).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(readEvents(dir, { limit: 2 }).map((e) => e.seq), [1, 2]);
  assert.deepEqual(readEvents(dir, { sinceSeq: 1, limit: 2 }).map((e) => e.seq), [2, 3]);
});

test('#669 a corrupt trailing line does not destroy the readable prefix', () => {
  const dir = tmpDir();
  appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:00.000Z' });
  appendEvent(dir, cardEvent(), { now: '2026-08-04T10:00:01.000Z' });
  const file = join(dir, 'events-2026-08-04.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8') + '{"seq":3,"trunc', 'utf8');
  const evs = readEvents(dir);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2], 'torn tail is skipped, prefix survives');
  assert.ok(existsSync(file));
});
