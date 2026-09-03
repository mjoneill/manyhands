/**
 * #679 — the read surface: what_changed_since as a pure function of the LOG.
 *
 * Every contract line here was ruled on #642 before this file existed:
 * pure-from-log (R5) · per-kind quotas default (R2) · latest-event-per-entity
 * default (R3) · honest per-kind truncation (R4) · CURSOR_TOO_OLD refusal,
 * never a silent partial (R6). Plus the two views the principal asked for by
 * name: per-card and per-actor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryChangesFromLog } from '../core/changes-log-query.mjs';

let seq = 0;
const ev = (op, kind, id, over = {}) => ({
  seq: ++seq, recorded_at: `2026-08-04T12:00:${String(seq % 60).padStart(2, '0')}.000Z`,
  actor: 'ada', op, entity: { kind, id, shortId: over.shortId ?? null },
  state: { id, title: `t-${id}`, body: `b-${id}` },
  ...over,
});
const reset = () => { seq = 0; };

test('deletes appear with tombstone state — the thing field-reads could never say', () => {
  reset();
  const events = [
    ev('create', 'card', 'c1', { shortId: 1 }),
    ev('delete', 'card', 'c1', { shortId: 1, state: { id: 'c1', title: 'gone', description: 'last words' } }),
  ];
  const r = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z', history: true });
  const del = r.changes.find((c) => c.op === 'delete');
  assert.ok(del, 'the delete event is served');
  assert.equal(del.title, 'gone', 'tombstone summary comes from the last state');
  assert.deepEqual(r.omits.cards, [], 'the ledger is EMPTY: deletes redeemed by #679, edit-actor by #675');
});

test('quotas: 96 posts cannot starve 4 card events out of the window', () => {
  reset();
  const events = [];
  for (let i = 0; i < 4; i++) events.push(ev('update', 'card', `c${i}`, { shortId: i + 1 }));
  for (let i = 0; i < 96; i++) events.push(ev('post', 'conversation', `m${i}`));
  const r = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z' });
  assert.equal(r.changes.filter((c) => c.kind === 'card').length, 4, 'all 4 card events present');
  assert.equal(r.changes.filter((c) => c.kind === 'conversation').length, 50, 'posts cut at their own quota');
  assert.equal(r.totals.posts, 96, 'true post total rides alongside');
  assert.equal(r.truncated.posts, true, 'the cut is confessed per kind');
  assert.equal(r.truncated.cards, false);
});

test('latest-event-per-entity by default; full history opt-in', () => {
  reset();
  const events = [];
  for (let i = 0; i < 5; i++) events.push(ev('update', 'card', 'hot', { shortId: 9 }));
  events.push(ev('update', 'card', 'cold', { shortId: 10 }));
  const dflt = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z' });
  assert.equal(dflt.changes.filter((c) => c.id === 'hot').length, 1, 'one entry per entity by default');
  assert.equal(dflt.changes.find((c) => c.id === 'hot').seq, 5, 'and it is the LATEST event');
  const hist = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z', history: true });
  assert.equal(hist.changes.filter((c) => c.id === 'hot').length, 5, 'history opt-in returns every event');
});

test('a since before the log’s retention REFUSES loudly — never a silent partial', () => {
  reset();
  const events = [ev('create', 'card', 'c1', { shortId: 1 })];
  assert.throws(
    () => queryChangesFromLog(events, { since: '2026-08-01T00:00:00Z', oldestRetained: '2026-08-04T16:39:00Z' }),
    (e) => e.code === 'CURSOR_TOO_OLD' && e.oldest_retained === '2026-08-04T16:39:00Z' && e.resync === true,
  );
});

test('per-card and per-actor filters — the principal’s hand-run views as parameters', () => {
  reset();
  const events = [
    ev('update', 'card', 'a', { shortId: 674 }),
    ev('update', 'card', 'b', { shortId: 675, actor: 'bex' }),
    ev('post', 'conversation', 'm1', { actor: 'bex' }),
  ];
  const byCard = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z', entity: 674 });
  assert.deepEqual(byCard.changes.map((c) => c.shortId), [674]);
  const byActor = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z', actor: 'bex' });
  assert.equal(byActor.changes.length, 2);
  assert.ok(byActor.changes.every((c) => c.by === 'bex'));
});

test('missing since refuses (the #643 rule, kept)', () => {
  assert.throws(() => queryChangesFromLog([], {}), (e) => e.code === 'MISSING_SINCE');
});

test('backward paging by seq cursor; unknown cursor refuses', () => {
  reset();
  const events = [];
  for (let i = 0; i < 60; i++) events.push(ev('post', 'conversation', `m${i}`));
  const p1 = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z' });
  assert.equal(p1.changes.at(-1).seq, 60, 'first page is the newest tail');
  const p2 = queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z', before: p1.changes[0].seq });
  assert.ok(p2.changes.every((c) => c.seq < p1.changes[0].seq), 'before pages strictly backward');
  assert.throws(
    () => queryChangesFromLog(events, { since: '2026-08-04T00:00:00Z', before: 9999 }),
    (e) => e.code === 'UNKNOWN_CURSOR',
  );
});

// —— the segment-skip's positive control (found in #679 verification) ——
// The first cut's skip NEVER fired ("events-202" < "2026-…" is false for all
// inputs) and passed every correctness test, because a skip that does nothing
// returns identical results. The discriminating input: an OLD-named segment
// whose content claims a recent recorded_at — visible exactly when the skip
// fails to fire, absent when it works.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvents } from '../core/event-log.mjs';

test('the day-segment skip actually SKIPS: an old segment cannot leak content into a since-window read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg679-'));
  const lie = { seq: 1, recorded_at: '2026-08-04T12:00:00.000Z', actor: 'ada', op: 'post', entity: { kind: 'conversation', id: 'x' }, state: { body: 'liar' } };
  fs.writeFileSync(path.join(dir, 'events-2020-01-01.jsonl'), JSON.stringify(lie) + '\n');
  const honest = { seq: 2, recorded_at: '2026-08-04T12:00:01.000Z', actor: 'ada', op: 'post', entity: { kind: 'conversation', id: 'y' }, state: { body: 'ok' } };
  fs.writeFileSync(path.join(dir, 'events-2026-08-04.jsonl'), JSON.stringify(honest) + '\n');

  const unskipped = readEvents(dir);
  assert.equal(unskipped.length, 2, 'without a window, everything is read');
  const windowed = readEvents(dir, { sinceDate: '2026-08-04T00:00:00Z' });
  assert.equal(windowed.length, 1, 'the old-named segment was actually skipped');
  assert.equal(windowed[0].entity.id, 'y');
});

test('#1027 a card row carries the COLUMN its state was in after the event; a post row carries null', () => {
  const rows = queryChangesFromLog([
    { seq: 1, recorded_at: '2026-09-01T00:00:01.000Z', op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1', shortId: 1 }, state: { id: 'c1', title: 't', column: 'done' } },
    { seq: 2, recorded_at: '2026-09-01T00:00:02.000Z', op: 'post', actor: 'ada', entity: { kind: 'conversation', id: 'p1' }, state: { id: 'p1', body: 'hi' } },
  ], { since: '2026-09-01T00:00:00.000Z', history: true }).changes;
  assert.equal(rows.find((r) => r.kind === 'card').column, 'done');
  assert.equal(rows.find((r) => r.kind === 'conversation').column, null);
});
