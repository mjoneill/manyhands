/**
 * #1274 — THE WAKE SCAN'S OWN CEILING.
 *
 * #1237 replaced a newest-60 window with a since-cursor and a limit of 500.
 * The server clamps any limit to MAX_CONV_LIST_LIMIT (200) and returns the
 * NEWEST 200 of the matching set, saying nothing. So when more than 200 posts
 * land between two ticks, the rows nearest the cursor — the unanswered ones —
 * are the rows dropped, and the cursor then moves past them for good.
 *
 * The recovery is to page BACKWARD with `before` while holding `since` fixed.
 *
 * ⚠️ These tests are written so that removing the paging FAILS them. A window
 * test that only checks "all rows came back" passes when the fixture happens
 * to fit in one page, which is the failure mode this card is about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMentionWindow, mentionScanPath, findMentions, CONV_LIST_CAP } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** A fake board that behaves like server.js: window by `since`, then the NEWEST `min(limit, cap)`. */
function fakeBoard(messages, { cap = CONV_LIST_CAP } = {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    const url = new URL(path, 'http://x');
    const since = url.searchParams.get('since');
    const before = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit'));
    // Ordered by createdAt like the real store, so a duplicate row cannot ride
    // into the newest page on array position alone — that artifact made this
    // file's dedupe test survive a sabotage run it should have failed.
    let rows = messages.filter((m) => (!since || m.createdAt >= since) && (!before || m.createdAt < before))
      .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
    const total = rows.length;                       // X-Total-Count: counted BEFORE the slice
    rows = rows.slice(-Math.min(limit, cap));        // the N most-recent
    return { rows, total };
  };
  return { get, calls };
}

const msgs = (n, { start = Date.parse('2026-09-07T00:00:00.000Z'), everyMs = 1000, author = 'someone' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${String(i).padStart(4, '0')}`,
    author,
    body: i === 0 ? 'hello @testseat, are you there?' : `chatter ${i}`,
    createdAt: new Date(start + i * everyMs).toISOString(),
  }));

test('#1274 the cap is the SERVER\'s and the loop knows the number', () => {
  assert.equal(CONV_LIST_CAP, 200, 'must track server.js MAX_CONV_LIST_LIMIT');
});

test('#1274 A BUSY WINDOW COMES BACK WHOLE — 431 posts past a 200-row cap', async () => {
  const all = msgs(431);
  const { get, calls } = fakeBoard(all);
  const out = await fetchMentionWindow(get, { lastAnsweredAt: all[0].createdAt });
  assert.equal(out.complete, true, 'the window was fully read');
  assert.equal(out.messages.length, 431, `got ${out.messages.length} of 431`);
  assert.ok(calls.length >= 3, `431 rows at a 200 cap needs 3+ pages, made ${calls.length}`);
  // ⭐ THE SABOTAGE GUARD: without `before` paging the fetcher can only ever see
  // the newest 200, so the OLDEST row is the one that proves a second page ran.
  assert.equal(out.messages[0].id, 'm0000', 'the oldest row in the window must be present');
  assert.ok(calls.some((c) => c.includes('before=')), 'recovery must page backward with `before`');
});

test('#1274 the rows come back OLDEST-FIRST and deduped, so the oldest unanswered mention is wake[0]', async () => {
  const all = msgs(431);
  all.push({ ...all[0] });                                   // a duplicate id across a page boundary
  const { get } = fakeBoard(all);
  const out = await fetchMentionWindow(get, { lastAnsweredAt: all[0].createdAt });
  const ids = out.messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  const sorted = [...out.messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((m) => m.id);
  assert.deepEqual(ids, sorted, 'ascending by createdAt');
  const mentions = findMentions(out.messages, 'testseat');
  assert.equal(mentions[0].id, 'm0000', 'the FIRST wake must be the oldest unanswered mention');
});

test('#1274 NEGATIVE CONTROL — a quiet window still costs exactly one request', async () => {
  const { get, calls } = fakeBoard(msgs(12));
  const out = await fetchMentionWindow(get, { lastAnsweredAt: '2026-09-06T00:00:00.000Z' });
  assert.equal(out.complete, true);
  assert.equal(out.messages.length, 12);
  assert.equal(calls.length, 1, `a quiet tick must not page, made ${calls.length} requests`);
  assert.equal(calls[0].includes('before='), false, 'the first request carries no `before`');
});

test('#1274 A WINDOW TOO BIG TO WALK IS REPORTED, NOT ABSORBED', async () => {
  const { get } = fakeBoard(msgs(2000));
  const out = await fetchMentionWindow(get, { lastAnsweredAt: '2026-09-06T00:00:00.000Z' }, undefined, { maxPages: 2 });
  assert.equal(out.complete, false, 'the loop must say it could not finish');
  assert.ok(out.truncated, 'a truncation record is present');
  assert.equal(typeof out.truncated.seen, 'number');
  assert.equal(typeof out.truncated.total, 'number');
  assert.ok(out.truncated.total > out.truncated.seen, 'the record names both numbers');
});

test('#1274 mentionScanPath carries `before` when asked and omits it otherwise', () => {
  const now = '2026-09-07T10:00:00.000Z';
  const first = mentionScanPath({ lastAnsweredAt: '2026-09-07T09:00:00.000Z' }, now);
  assert.equal(first.includes('before='), false);
  const next = mentionScanPath({ lastAnsweredAt: '2026-09-07T09:00:00.000Z' }, now, { before: '2026-09-07T09:30:00.000Z' });
  assert.match(next, /before=2026-09-07T09%3A30%3A00\.000Z/);
  assert.match(next, /since=2026-09-07T09%3A00%3A00\.000Z/);   // the window is HELD, not moved
});

// ---------------------------------------------------------------------------
// THE SEAM. The pure pieces above agree with a fake that I wrote from reading
// server.js. This one asks the real server, because the whole defect is that
// what the loop believed about the transport was wrong.
test('#1274 SEAM: against the REAL server, a window past the cap comes back whole', async () => {
  const board = makeBoardFixture({ cards: [], nextShortId: 1 });
  board.conversations = msgs(431).map((m) => ({ ...m, attachedTo: null, mentions: [] }));
  const srv = await startRestServer({ board });
  try {
    const get = async (path) => {
      const r = await fetch(`${srv.baseUrl}${path}`);
      assert.equal(r.ok, true, `GET ${path} → ${r.status}`);
      const total = r.headers.get('x-total-count');
      return { rows: await r.json(), total: total == null ? null : Number(total) };
    };
    // The bare call is the defect, stated as an assertion so it cannot rot away.
    const one = await get(mentionScanPath({ lastAnsweredAt: '2026-09-06T00:00:00.000Z' }));
    assert.equal(one.rows.length, CONV_LIST_CAP, 'the server still clamps a wide limit');
    assert.equal(one.total, 431, 'and X-Total-Count still tells the truth about what was there');

    const out = await fetchMentionWindow(get, { lastAnsweredAt: '2026-09-06T00:00:00.000Z' });
    assert.equal(out.complete, true);
    assert.equal(out.messages.length, 431);
    assert.equal(out.messages[0].id, 'm0000');
  } finally {
    await srv.stop();
  }
});
