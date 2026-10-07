/**
 * #1584 — #118 Slice 2, the SERVER half: `PATCH /api/cards/:id` with
 * `{ column, order, makeRoom: true }` places the card at `order` in `column`
 * and, under the same write lock, shifts the cards it would collide with down
 * by one — only as far as the collision chain reaches, and no further.
 *
 * Why a server-side shift rather than N client PATCHes: a drag that renumbers
 * neighbours as several requests can be refused half-way (one neighbour 409s),
 * leaving the board in an order nobody chose. One request, one lock, one
 * compare-and-swap on the moved card: the move lands whole or not at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const ts = '2026-09-01T00:00:00.000Z';
const card = (shortId, column, order, extra = {}) => ({
  id: `m${shortId}`, shortId, title: `card ${shortId}`, description: '', type: 'task',
  column, order, assignees: ['unassigned'], labels: [], priority: null, for: '',
  createdAt: ts, updatedAt: ts, version: 1, ...extra,
});

const board = () => makeBoardFixture({
  cards: [
    card(1, 'backlog', 1), card(2, 'backlog', 2), card(3, 'backlog', 3), card(4, 'backlog', 7),
    card(5, 'planned', 1), card(6, 'planned', 2),
  ],
  nextShortId: 7,
});

const req = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const orders = async (baseUrl, column) => {
  const all = (await req(baseUrl, 'GET', `/api/cards?limit=50&column=${column}`)).body.cards;
  return Object.fromEntries(all.map((c) => [c.id, [c.order, c.version]]));
};

test('#1584 makeRoom: a card placed on an occupied order shifts exactly the collision chain, atomically', async () => {
  const s = await startRestServer({ board: board() });
  try {
    // m6 (planned) → backlog at order 2: m2 (2) and m3 (3) collide in a chain;
    // m4 (7) sits past a gap and must NOT move; m1 is above and must not move.
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 2, makeRoom: true, ifVersion: 1, return: 'id' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 2);
    assert.deepEqual(
      (r.body.shifted || []).map((c) => [c.id, c.order, c.version]).sort(),
      [['m2', 3, 2], ['m3', 4, 2]],
      'the response names every neighbour it renumbered, with its new order and version',
    );
    assert.equal(r.body.ignoredFields, undefined, 'makeRoom is honoured, not reported as ignored');
    const b = await orders(s.baseUrl, 'backlog');
    assert.deepEqual(b, { m1: [1, 1], m6: [2, 2], m2: [3, 2], m3: [4, 2], m4: [7, 1] },
      'stored: the chain shifted, the gap stopped it, nothing above moved, untouched cards keep their version');
    const p = await orders(s.baseUrl, 'planned');
    assert.deepEqual(p, { m5: [1, 1] }, 'the source column is left alone (a gap is harmless)');
  } finally { await s.stop(); }
});

test('#1584 makeRoom: a stale ifVersion refuses the WHOLE move — no neighbour is shifted', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1, makeRoom: true, ifVersion: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.body.currentVersion, 1);
    const b = await orders(s.baseUrl, 'backlog');
    assert.deepEqual(b, { m1: [1, 1], m2: [2, 1], m3: [3, 1], m4: [7, 1] }, 'nothing renumbered');
    const p = await orders(s.baseUrl, 'planned');
    assert.deepEqual(p, { m5: [1, 1], m6: [2, 1] }, 'and the card did not move');
  } finally { await s.stop(); }
});

test('#1584 makeRoom: a free slot shifts nothing; without makeRoom a collision is stored as sent (negative control)', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const free = await req(s.baseUrl, 'PATCH', '/api/cards/m5', { column: 'backlog', order: 5, makeRoom: true, ifVersion: 1 });
    assert.equal(free.status, 200);
    assert.equal(free.body.shifted, undefined, 'nothing collided, so nothing is reported shifted');
    const plain = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1, ifVersion: 1 });
    assert.equal(plain.status, 200);
    const b = await orders(s.baseUrl, 'backlog');
    assert.equal(b.m1[0], 1, 'a plain PATCH does not renumber — makeRoom is opt-in');
    assert.equal(b.m6[0], 1);
  } finally { await s.stop(); }
});

test('#1584 makeRoom: malformed requests are 400 and write nothing', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const noOrder = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', makeRoom: true, ifVersion: 1 });
    assert.equal(noOrder.status, 400, JSON.stringify(noOrder.body));
    const notTrue = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1, makeRoom: 'yes', ifVersion: 1 });
    assert.equal(notTrue.status, 400, JSON.stringify(notTrue.body));
    const frac = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1.5, makeRoom: true, ifVersion: 1 });
    assert.equal(frac.status, 400, JSON.stringify(frac.body));
    const p = await orders(s.baseUrl, 'planned');
    assert.deepEqual(p, { m5: [1, 1], m6: [2, 1] });
  } finally { await s.stop(); }
});

// ── Review round: ties, the anchor, the move's identity, whole neighbours ────

const tiedBoard = () => makeBoardFixture({
  cards: [
    card(1, 'backlog', 5), card(2, 'backlog', 5), card(3, 'backlog', 5),
    card(5, 'planned', 1, { description: 'x'.repeat(50) }), card(6, 'planned', 2),
  ],
  nextShortId: 7,
});
// The column as the board renders it: order ASC, ties by store position.
const rendered = async (baseUrl, column) => {
  const all = (await req(baseUrl, 'GET', '/api/cards?limit=50&legacyIndex=1')).body.cards.filter((c) => c.column === column);
  return all.sort((a, b) => (a.order - b.order) || (a.legacyArrayIndex - b.legacyArrayIndex)).map((c) => c.id);
};

test('#1584 after: a card dropped BETWEEN TWO TIED cards lands between them — the tied cards after the anchor are renumbered below it', async () => {
  const s = await startRestServer({ board: tiedBoard() });
  try {
    assert.deepEqual(await rendered(s.baseUrl, 'backlog'), ['m1', 'm2', 'm3'], 'precondition: a three-way tie, store order');
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 6, makeRoom: true, after: 'm1', ifVersion: 1, return: 'id' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await rendered(s.baseUrl, 'backlog'), ['m1', 'm6', 'm2', 'm3'], 'between m1 and m2, as dropped');
    const b = await orders(s.baseUrl, 'backlog');
    assert.deepEqual(b, { m1: [5, 1], m6: [6, 2], m2: [7, 2], m3: [8, 2] }, 'the anchor and anything above it keep their order and version');
    // Within the tie: m3 to just after m1.
    const r2 = await req(s.baseUrl, 'PATCH', '/api/cards/m3', { column: 'backlog', order: 6, makeRoom: true, after: 'm1', ifVersion: 2 });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(await rendered(s.baseUrl, 'backlog'), ['m1', 'm3', 'm6', 'm2']);
  } finally { await s.stop(); }
});

test('#1584 after:null puts the card at the TOP of a tied column, ahead of every tied card', async () => {
  const s = await startRestServer({ board: makeBoardFixture({
    cards: [card(1, 'backlog', 0), card(2, 'backlog', 0), card(6, 'planned', 1)], nextShortId: 7,
  }) });
  try {
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 0, makeRoom: true, after: null, ifVersion: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await rendered(s.baseUrl, 'backlog'), ['m6', 'm1', 'm2']);
  } finally { await s.stop(); }
});

test('#1584 after: an anchor that is no longer where the tab saw it is a 409 (NEIGHBOUR_MOVED) and writes nothing', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const elsewhere = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 2, makeRoom: true, after: 'm5', ifVersion: 1 });
    assert.equal(elsewhere.status, 409, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body.code, 'NEIGHBOUR_MOVED');
    const below = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 2, makeRoom: true, after: 'm3', ifVersion: 1 });
    assert.equal(below.status, 409, 'the anchor sorts at or below the requested order: ' + JSON.stringify(below.body));
    const gone = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 2, makeRoom: true, after: 'no-such-card', ifVersion: 1 });
    assert.equal(gone.status, 409);
    assert.deepEqual(await orders(s.baseUrl, 'backlog'), { m1: [1, 1], m2: [2, 1], m3: [3, 1], m4: [7, 1] }, 'nothing renumbered');
    assert.deepEqual(await orders(s.baseUrl, 'planned'), { m5: [1, 1], m6: [2, 1] }, 'nothing moved');
    const loose = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { title: 'x', after: 'm1' });
    assert.equal(loose.status, 400, '`after` without makeRoom is refused, not ignored');
  } finally { await s.stop(); }
});

test('#1584 requestId: recorded on the moved card; a REPLAY of the same move is a 409 and shifts nobody twice', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const move = { column: 'backlog', order: 2, makeRoom: true, after: 'm1', requestId: 'move-0001-abcd', ifVersion: 1 };
    const first = await req(s.baseUrl, 'PATCH', '/api/cards/m6', move);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const stored = (await req(s.baseUrl, 'GET', '/api/cards/m6')).body;
    assert.equal(stored.lastMoveRequestId, 'move-0001-abcd', 'readable by a tab whose reply was lost');
    const listed = (await req(s.baseUrl, 'GET', '/api/cards?limit=50')).body.cards.find((c) => c.id === 'm6');
    assert.equal(listed.lastMoveRequestId, 'move-0001-abcd', 'and on the list the board loads from');
    const replay = await req(s.baseUrl, 'PATCH', '/api/cards/m6', move);
    assert.equal(replay.status, 409, 'its own ifVersion refuses the replay');
    assert.deepEqual(await orders(s.baseUrl, 'backlog'), { m1: [1, 1], m6: [2, 2], m2: [3, 2], m3: [4, 2], m4: [7, 1] },
      'each neighbour shifted exactly once');
    const bad = await req(s.baseUrl, 'PATCH', '/api/cards/m5', { ...move, requestId: 'no spaces!', ifVersion: 1 });
    assert.equal(bad.status, 400);
  } finally { await s.stop(); }
});

test('#1584 shifted: each renumbered neighbour comes back WHOLE (current content, not just order+version), body left out, excerpt on request', async () => {
  const s = await startRestServer({ board: tiedBoard() });
  try {
    // A seat edits the neighbour first.
    const seat = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { title: 'edited by a seat', ifVersion: 1 });
    assert.equal(seat.status, 200);
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m5?excerpt=10',
      { column: 'planned', order: 2, makeRoom: true, after: null, ifVersion: 1, return: 'id' });
    // Top of planned at order 2: the walk starts at the first card, m6 (2), which shifts to 3.
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sh = (r.body.shifted || []).find((c) => c.id === 'm6');
    assert.ok(sh, 'm6 was shifted: ' + JSON.stringify(r.body));
    assert.equal(sh.title, 'edited by a seat', 'the neighbour as STORED, including the seat\'s edit');
    assert.equal(sh.version, 3);
    assert.equal(sh.order, 3);
    assert.equal('description' in sh, false, 'no body: an absent description makes the editor fetch');
    assert.equal(typeof sh.descriptionExcerpt, 'string', 'the tile preview, at the requested cap');
  } finally { await s.stop(); }
});


// ── Round 4: the move FENCE — the only thing that unblocks a save ────────────

const fence = (baseUrl, id, rid) => req(baseUrl, 'POST', `/api/cards/${id}/move-fence`, { requestId: rid });
const moveTo = (rid, ifVersion, extra = {}) => ({ column: 'backlog', order: 2, makeRoom: true, after: 'm1', requestId: rid, ifVersion, ...extra });
const UNMOVED = { m1: [1, 1], m2: [2, 1], m3: [3, 1], m4: [7, 1] };
// The move's id in the event log (the write-ahead claim the fence must ignore).
const loggedMoveIds = (boardFile) => {
  const dir = boardFile.replace(/\.json$/, '') + '-events';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l)).map((e) => e.state && e.state.lastMoveRequestId).filter(Boolean);
};
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('#1584 F1 crash gap (simulated): event appended, board write fails ⇒ 500; the fence says FENCED, never committed; a replay is 409 MOVE_FENCED', async () => {
  const s = await startRestServer({ board: board(), env: { SCRUM_TEST_FAIL_BOARD_WRITE_FOR_MOVE: 'crash-0001-move' } });
  try {
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', moveTo('crash-0001-move', 1));
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.ok(loggedMoveIds(s.boardFile).includes('crash-0001-move'), 'precondition: the event log CLAIMS the move');
    assert.deepEqual(await orders(s.baseUrl, 'backlog'), UNMOVED, 'the board does not have it');
    const f = await fence(s.baseUrl, 'm6', 'crash-0001-move');
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.outcome, 'fenced', 'a log claim is not a commit');
    const replay = await req(s.baseUrl, 'PATCH', '/api/cards/m6', moveTo('crash-0001-move', 1));
    assert.deepEqual([replay.status, replay.body.code], [409, 'MOVE_FENCED']);
    assert.deepEqual(await orders(s.baseUrl, 'backlog'), UNMOVED);
  } finally { await s.stop(); }
});

test('#1584 F1b crash gap (REAL): SIGKILL inside the gap, restart on the same data ⇒ the board lacks the move, the fence says FENCED, a replay is 409; no process left behind', async () => {
  const s1 = await startRestServer({ board: board(), env: {
    SCRUM_TEST_PAUSE_AFTER_EVENTS_FOR_MOVE: 'kill-0002-move', SCRUM_TEST_PAUSE_AFTER_EVENTS_MS: '20000' } });
  let s2 = null;
  try {
    const inFlight = req(s1.baseUrl, 'PATCH', '/api/cards/m6', moveTo('kill-0002-move', 1)).catch((e) => ({ error: e.message }));
    assert.ok(await s1.waitForStderr(/paused after events, before the board write \(kill-0002-move\)/, 8000), 'precondition: the server is inside the gap');
    s1.kill('SIGKILL');
    for (let i = 0; i < 50 && !gone(s1.pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(gone(s1.pid), 'the first server is dead');
    const dropped = await inFlight;
    assert.ok(dropped.error || dropped.status >= 500, 'the move got no answer: ' + JSON.stringify(dropped));
    assert.ok(loggedMoveIds(s1.boardFile).includes('kill-0002-move'), 'precondition: the log CLAIMS the move');

    s2 = await startRestServer({ boardFile: s1.boardFile });
    assert.deepEqual(await orders(s2.baseUrl, 'backlog'), UNMOVED, 'the stored board does not have the move');
    assert.deepEqual(await orders(s2.baseUrl, 'planned'), { m5: [1, 1], m6: [2, 1] });
    const f = await fence(s2.baseUrl, 'm6', 'kill-0002-move');
    assert.equal(f.body.outcome, 'fenced', JSON.stringify(f.body));
    const replay = await req(s2.baseUrl, 'PATCH', '/api/cards/m6', moveTo('kill-0002-move', 1));
    assert.deepEqual([replay.status, replay.body.code], [409, 'MOVE_FENCED']);
  } finally {
    if (s2) await s2.stop();
    await s1.stop();
    for (let i = 0; i < 50 && s2 && !gone(s2.pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(gone(s1.pid) && (!s2 || gone(s2.pid)), 'no server process left behind');
  }
});

test('#1584 F2 fence and move SERIALISE on the lock: a move fired into the fence\'s read→write gap waits, then is 409 MOVE_FENCED; nothing shifts', async () => {
  const s = await startRestServer({ board: board(), env: { SCRUM_MOVE_FENCE_PAUSE_MS: '900' } });
  try {
    const fencing = fence(s.baseUrl, 'm6', 'late-0003-move');   // reads, then pauses inside the lock
    await new Promise((r) => setTimeout(r, 250));
    const moving = req(s.baseUrl, 'PATCH', '/api/cards/m6', moveTo('late-0003-move', 1));
    const [f, m] = await Promise.all([fencing, moving]);
    assert.equal(f.body.outcome, 'fenced');
    assert.deepEqual([m.status, m.body.code], [409, 'MOVE_FENCED'], 'the move did not land between the fence\'s read and write');
    assert.deepEqual(await orders(s.baseUrl, 'backlog'), UNMOVED);
    // The other order: the move commits first, then the fence sees it.
    assert.equal((await req(s.baseUrl, 'PATCH', '/api/cards/m5', { ...moveTo('first-0004-move', 1) })).status, 200);
    assert.equal((await fence(s.baseUrl, 'm5', 'first-0004-move')).body.outcome, 'committed');
  } finally { await s.stop(); }
});

test('#1584 F3 committed and still the latest ⇒ COMMITTED (and nothing is fenced); committed then SUPERSEDED by a later move ⇒ FENCED, never committed-by-guess', async () => {
  const s = await startRestServer({ board: board() });
  try {
    assert.equal((await req(s.baseUrl, 'PATCH', '/api/cards/m6', moveTo('ours-0005-move', 1))).status, 200);
    assert.equal((await fence(s.baseUrl, 'm6', 'ours-0005-move')).body.outcome, 'committed');
    assert.equal((await req(s.baseUrl, 'PATCH', '/api/cards/m6',
      { column: 'planned', order: 1, makeRoom: true, after: null, requestId: 'seat-0006-move', ifVersion: 2 })).status, 200);
    const f = await fence(s.baseUrl, 'm6', 'ours-0005-move');
    assert.equal(f.body.outcome, 'fenced', 'superseded: it can no longer apply, and whether it did is not claimed');
    assert.equal((await req(s.baseUrl, 'GET', '/api/cards/m6')).body.lastMoveRequestId, 'seat-0006-move', 'the fence wrote nothing on the card');
  } finally { await s.stop(); }
});

test('#1584 fence: malformed requestId is 400 and writes nothing', async () => {
  const s = await startRestServer({ board: board() });
  try {
    assert.equal((await req(s.baseUrl, 'POST', '/api/cards/m6/move-fence', { requestId: 'x' })).status, 400);
    assert.equal((await req(s.baseUrl, 'PATCH', '/api/cards/m6', moveTo('x-not-fenced-0010', 1))).status, 200, 'nothing was fenced');
  } finally { await s.stop(); }
});

test('#1584 F1c crash gap, UNPAUSED race (best effort, reported): SIGKILL fired from a watch on the event log\'s append; when it lands in the gap, the fence must say FENCED', { todo: 'best effort: reported, never fails the run' }, async (t) => {
  const ATTEMPTS = 5;
  let landed = 0;
  for (let n = 0; n < ATTEMPTS; n++) {
    const s1 = await startRestServer({ board: board() });
    let s2 = null;
    const rid = `race-${String(n).padStart(4, '0')}-move`;
    try {
      const dir = s1.boardFile.replace(/\.json$/, '') + '-events';
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, () => { s1.kill('SIGKILL'); });
      await req(s1.baseUrl, 'PATCH', '/api/cards/m6', moveTo(rid, 1)).catch(() => null);
      watcher.close();
      s1.kill('SIGKILL');
      for (let i = 0; i < 50 && !gone(s1.pid); i++) await new Promise((r) => setTimeout(r, 100));
      s2 = await startRestServer({ boardFile: s1.boardFile });
      const stored = (await req(s2.baseUrl, 'GET', '/api/cards/m6')).body;
      const inGap = loggedMoveIds(s1.boardFile).includes(rid) && stored.column === 'planned';
      const f = await fence(s2.baseUrl, 'm6', rid);
      if (inGap) {
        landed++;
        assert.equal(f.body.outcome, 'fenced', 'a kill inside the gap must never read as committed');
      } else {
        assert.equal(f.body.outcome, stored.lastMoveRequestId === rid ? 'committed' : 'fenced', 'outside the gap the fence agrees with the board');
      }
    } finally {
      if (s2) await s2.stop();
      await s1.stop();
    }
    for (let i = 0; i < 50 && !(gone(s1.pid) && (!s2 || gone(s2.pid))); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(gone(s1.pid) && (!s2 || gone(s2.pid)), 'no server process left behind');
  }
  t.diagnostic(`unpaused race: the kill landed inside the gap in ${landed} of ${ATTEMPTS} attempts`);
});
