/**
 * #1858 — if the ceremony bell is silent, a scheduled poster names the seats who open.
 *
 * The bell runs inside the MCP server, so anything that stops that process silences it AND the
 * bell's own missing-flag (both are written by the same tick). The fallback therefore lives in a
 * separate scheduled job, and its trigger is the ROOM: at slot + 6 min, is there a bell opener
 * for this slot? If not, and no fallback for this slot has posted either, post one room post
 * naming the configured seats.
 *
 * The decision is pure (fallbackDecide); the job script only fetches the room and posts.
 *
 * Sabotage profiles (each must turn a row red):
 *   (a) ignore the bell opener          → F2 fails
 *   (b) ignore an earlier fallback post → F3 fails
 *   (c) fire before slot + 6 min        → F4 fails
 *   (d) match the opener by kind only   → F5 fails (last week's opener would count)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fallbackDecide, FALLBACK_DELAY_MS, FALLBACK_WINDOW_MS, fallbackMarker } from '../core/ceremony-fallback.mjs';

// 2026-11-11 is a Wednesday (UTC weekday 3).
const W = (h, m = 0) => `2026-11-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const REVIEW = { kind: 'review', weekday: 3, time: '16:00' };
const RETRO = { kind: 'retro', weekday: 3, time: '17:00' };
const SEATS = ['seat-one', 'seat-two'];
const bellOpener = (at, hhmm = '16:00', kind = 'review') => ({ author: 'board', attachedTo: null, createdAt: at, body: `🔔 ${hhmm}Z: ${kind}. @seat-one opens.` });

test('F1: at slot + 6 min with no opener in the room, one post names every configured seat, in order', () => {
  const out = fallbackDecide({ now: W(16, 6), entries: [REVIEW], posts: [], seats: SEATS });
  assert.equal(out.length, 1);
  const [d] = out;
  assert.equal(d.action, 'post');
  assert.equal(d.key, 'review@2026-11-11T16:00:00.000Z');
  assert.ok(d.body.startsWith(fallbackMarker('review', Date.parse(W(16)))), d.body);
  const i1 = d.body.indexOf('@seat-one'), i2 = d.body.indexOf('@seat-two');
  assert.ok(i1 > 0 && i2 > i1, `both seats named, first one first: ${d.body}`);
});

test('F2: a bell opener for this slot in the room means nothing is posted', () => {
  const out = fallbackDecide({ now: W(16, 6), entries: [REVIEW], posts: [bellOpener(W(16, 0))], seats: SEATS });
  assert.deepEqual(out.map((d) => d.action), ['skip-bell-posted']);
});

test('F2b: a LATE bell opener (still before the fallback runs) also counts', () => {
  const out = fallbackDecide({ now: W(16, 9), entries: [REVIEW], posts: [bellOpener(W(16, 8))], seats: SEATS });
  assert.deepEqual(out.map((d) => d.action), ['skip-bell-posted']);
});

test('F3: a fallback already posted for this slot is not posted again (a re-run, or a late second fire)', () => {
  const first = fallbackDecide({ now: W(16, 6), entries: [REVIEW], posts: [], seats: SEATS })[0];
  const posted = { author: 'board', attachedTo: null, createdAt: W(16, 6), body: first.body };
  const out = fallbackDecide({ now: W(16, 20), entries: [REVIEW], posts: [posted], seats: SEATS });
  assert.deepEqual(out.map((d) => d.action), ['skip-fallback-posted']);
});

test('F4: before slot + 6 min nothing fires, and after the window nothing fires', () => {
  assert.deepEqual(fallbackDecide({ now: W(16, 5), entries: [REVIEW], posts: [], seats: SEATS }), []);
  const lateMs = Date.parse(W(16)) + FALLBACK_DELAY_MS + FALLBACK_WINDOW_MS;
  assert.deepEqual(fallbackDecide({ now: new Date(lateMs).toISOString(), entries: [REVIEW], posts: [], seats: SEATS }), []);
});

test('F5: an opener for a DIFFERENT slot (last week, or the other ceremony) does not count', () => {
  const lastWeek = bellOpener('2026-11-04T16:00:05.000Z');
  const retroOpener = bellOpener(W(16, 1), '17:00', 'retro');
  const out = fallbackDecide({ now: W(16, 6), entries: [REVIEW, RETRO], posts: [lastWeek, retroOpener], seats: SEATS });
  assert.deepEqual(out.map((d) => [d.key, d.action]), [['review@2026-11-11T16:00:00.000Z', 'post']]);
});

test('F6: an opener-shaped post by anyone other than the board, or inside a card thread, does not count', () => {
  const bySeat = { ...bellOpener(W(16, 1)), author: 'seat-one' };
  const inThread = { ...bellOpener(W(16, 1)), attachedTo: 'card:1858' };
  const out = fallbackDecide({ now: W(16, 6), entries: [REVIEW], posts: [bySeat, inThread], seats: SEATS });
  assert.deepEqual(out.map((d) => d.action), ['post']);
});

test('F7: with no seats configured it still posts, and says nobody is named (a silent fallback is the hole it exists for)', () => {
  const [d] = fallbackDecide({ now: W(16, 6), entries: [REVIEW], posts: [], seats: [] });
  assert.equal(d.action, 'post');
  assert.doesNotMatch(d.body, /@/);
  assert.match(d.body, /nobody is named/i);
});

test('F8: each ceremony is its own slot: the retro fallback fires at 17:06 even though the review had a bell', () => {
  const out = fallbackDecide({ now: W(17, 6), entries: [REVIEW, RETRO], posts: [bellOpener(W(16, 0))], seats: SEATS });
  assert.deepEqual(out.map((d) => [d.key, d.action]), [['retro@2026-11-11T17:00:00.000Z', 'post']]);
});

// ── the job script against a real REST server: the filtered read and the post ──
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const run = promisify(execFile);
const SCRIPT = path.join(PROJECT_DIR, 'scripts', 'ceremony-fallback.mjs');

// A schedule whose slot was 7 minutes ago, so the job's real clock is inside the window.
function scheduleSevenMinutesAgo() {
  const slot = new Date(Math.floor((Date.now() - 7 * 60 * 1000) / 60000) * 60000);
  const time = slot.toISOString().slice(11, 16);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-'));
  const file = path.join(d, 'ceremony-schedule.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, ceremonies: [{ kind: 'review', weekday: slot.getUTCDay(), time }] }));
  return { file, dir: d, time };
}
const job = (base, file) => run(process.execPath, [SCRIPT], { env: { ...process.env, SCRUM_REST_URL: base, SCRUM_CEREMONY_SCHEDULE_FILE: file, CEREMONY_FALLBACK_SEATS: 'seat-one,seat-two' } });
const boardPosts = async (base) => (await (await fetch(`${base}/api/conversations?author=board&limit=50`)).json());

test('J1: the job posts one fallback when the room has no opener, and a second run posts nothing', async () => {
  const server = await startRestServer({ board: makeBoardFixture({ cards: [] }) });
  const s = scheduleSevenMinutesAgo();
  try {
    const first = await job(server.baseUrl, s.file);
    assert.match(first.stdout, /posted /, first.stdout);
    const second = await job(server.baseUrl, s.file);
    assert.match(second.stdout, /skip-fallback-posted/, second.stdout);
    const fallbacks = (await boardPosts(server.baseUrl)).filter((p) => p.body.startsWith('⏰'));
    assert.equal(fallbacks.length, 1, 'exactly one fallback in the room');
    assert.match(fallbacks[0].body, /@seat-one, then @seat-two/);
  } finally { await server.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('J2 CONTROL: with the bell opener already in the room (posted the way the bell posts), the job posts nothing', async () => {
  const server = await startRestServer({ board: makeBoardFixture({ cards: [] }) });
  const s = scheduleSevenMinutesAgo();
  try {
    const r = await fetch(`${server.baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'board', body: `🔔 ${s.time}Z: review. @seat-one opens.` }) });
    assert.ok(r.ok, `seed opener ${r.status}`);
    const out = await job(server.baseUrl, s.file);
    assert.match(out.stdout, /skip-bell-posted/, out.stdout);
    assert.equal((await boardPosts(server.baseUrl)).filter((p) => p.body.startsWith('⏰')).length, 0);
  } finally { await server.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});
