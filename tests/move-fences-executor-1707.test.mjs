/**
 * #1707 — rows for moving the move-fence set (`moveFences`) out of board-data.json. TEST AUTHOR's, written before
 * any build; the builder is someone else.
 *
 * Today `POST /api/cards/:id/move-fence` records a fenced requestId in the DOCUMENT (`data.moveFences`), and a later
 * makeRoom PATCH carrying that id is refused 409 MOVE_FENCED before anything is written. Fences are permanent by design.
 * A lost or re-seeded document forgets them, so a move its tab was told "can never land" could land. These rows are
 * black-box (REST routes plus the board file's bytes), so they do not care where the build keeps the fence.
 *
 *   MF0  CONTROL, passes today: fence X, then a makeRoom PATCH with X is 409 MOVE_FENCED and the card does not move.
 *   MF1  The fence SURVIVES the document: fence X, stop REST, then start a fresh REST on the same executor with a board
 *        file in a NEW directory (a copy with X deleted wherever it appears), PATCH with X → still 409 MOVE_FENCED, card
 *        unmoved. The new directory is the point: a fence kept in any file beside the old board file (a sidecar) is
 *        file authority too, and must not pass this row. RED today.
 *   MF2  The document no longer carries the fence: after fencing X, the board file's bytes do not contain X. RED today.
 *   MF3  CONTROL: a move that COMMITTED answers `committed` to a later fence of its own id (not `fenced`).
 *   MF4  CONTROL against over-refusal: an unfenced makeRoom PATCH with a fresh id is applied (200, the card moves).
 *
 * NOT covered, by name: the SCRUM_MOVE_FENCE_PAUSE_MS race (the existing #1584 rows hold it on the document path; the
 * builder must keep them green, and a version on the executor path is owed if the fence write moves); fence pruning
 * (fences are permanent); the browser's settle flow (granular-moves-1584).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };
const T = { skip: SKIP, timeout: 300000 };

async function api(base, method, route, body) {
  const r = await fetch(`${base}${route}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* reported by the caller */ }
  return { status: r.status, json, text };
}
const rid = (tag) => `mf-${tag}-${Math.random().toString(16).slice(2, 10)}`;
const card1 = async (base) => (await api(base, 'GET', '/api/cards/1')).json;
const move = (base, requestId) => api(base, 'PATCH', '/api/cards/1', { by: 'ada', column: 'planned', order: 1, makeRoom: true, requestId });
// delete `value` from every array in the parsed document, wherever it is: shape-agnostic, so the row does not depend on
// how the document spells the field
function scrub(node, value) {
  if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) { if (node[i] === value) node.splice(i, 1); else scrub(node[i], value); } }
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) scrub(node[k], value);
}

async function world(fn) {
  const w = await wholeBoardWorld({ env: PROD });
  let rest2 = null; const cleanups = [];
  try { await fn(w, async () => {
    // a fresh REST on the same executor, with the board file as `edit` leaves it (the first REST's stop removes its file)
    const copy = fs.readFileSync(w.boardFile, 'utf8');
    await w.rest.stop();
    return async (edit) => {
      // a NEW directory: nothing the first REST wrote beside its board file can be read by the second
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mf1707-')); const file2 = path.join(dir2, 'board.json');
      const doc = JSON.parse(copy); edit(doc); fs.writeFileSync(file2, JSON.stringify(doc, null, 2));
      w.boardFile2 = file2; cleanups.push(() => fs.rmSync(dir2, { recursive: true, force: true }));
      rest2 = await startRestServer({ boardFile: file2, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', ...PROD } });
      return rest2;
    };
  }); } finally { if (rest2) await rest2.stop().catch(() => {}); await w.stop().catch(() => {}); for (const c of cleanups) c(); }
}

test('#1707 (MF0 CONTROL) a fenced id is refused 409 MOVE_FENCED and the card does not move', T, async () => {
  await world(async (w) => {
    const base = w.rest.baseUrl; const before = await card1(base); const X = rid('mf0');
    const f = await api(base, 'POST', '/api/cards/1/move-fence', { requestId: X });
    assert.equal(f.status, 200, f.text.slice(0, 200)); assert.equal(f.json.outcome, 'fenced');
    const p = await move(base, X);
    assert.equal(p.status, 409, p.text.slice(0, 200)); assert.equal(p.json.code, 'MOVE_FENCED');
    const after = await card1(base);
    assert.equal(after.column, before.column, 'the card did not move'); assert.equal(after.order, before.order);
  });
});

test('#1707 (MF1) the fence survives the document: removed from the board file, a fresh REST still refuses the fenced move', T, async () => {
  await world(async (w, restart) => {
    const base = w.rest.baseUrl; const before = await card1(base); const X = rid('mf1');
    const f = await api(base, 'POST', '/api/cards/1/move-fence', { requestId: X });
    assert.equal(f.status, 200, f.text.slice(0, 200)); assert.equal(f.json.outcome, 'fenced', 'PRECONDITION: fenced');
    const start = await restart();
    const rest = await start((doc) => scrub(doc, X));
    assert.ok(!fs.readFileSync(w.boardFile2, 'utf8').includes(X), 'PRECONDITION: the new board file does not name the fenced id');
    const p = await move(rest.baseUrl, X);
    assert.equal(p.status, 409, `a fenced move must stay refused after the document forgets it (got ${p.status}: ${p.text.slice(0, 160)})`);
    assert.equal(p.json?.code, 'MOVE_FENCED');
    const after = await card1(rest.baseUrl);
    assert.equal(after.column, before.column, 'and the card did not move'); assert.equal(after.order, before.order);
  });
});

test('#1707 (MF2) the document no longer carries the fence: after fencing, the board file does not contain the id', T, async () => {
  await world(async (w) => {
    const X = rid('mf2');
    const f = await api(w.rest.baseUrl, 'POST', '/api/cards/1/move-fence', { requestId: X });
    assert.equal(f.status, 200, f.text.slice(0, 200)); assert.equal(f.json.outcome, 'fenced', 'PRECONDITION: fenced');
    assert.ok(!fs.readFileSync(w.boardFile, 'utf8').includes(X), 'board-data.json must not hold the fenced id');
  });
});

test('#1707 (MF3 CONTROL) a move that committed answers `committed` to a later fence of its own id', T, async () => {
  await world(async (w) => {
    const base = w.rest.baseUrl; const Y = rid('mf3');
    const m = await move(base, Y);
    assert.equal(m.status, 200, `PRECONDITION: the move applies (${m.status}: ${m.text.slice(0, 160)})`);
    const f = await api(base, 'POST', '/api/cards/1/move-fence', { requestId: Y });
    assert.equal(f.status, 200, f.text.slice(0, 200)); assert.equal(f.json.outcome, 'committed');
  });
});

test('#1707 (MF4 CONTROL) an unfenced makeRoom move with a fresh id is applied, never refused as fenced', T, async () => {
  await world(async (w) => {
    const base = w.rest.baseUrl; const other = rid('mf4-other'); const Z = rid('mf4');
    const f = await api(base, 'POST', '/api/cards/1/move-fence', { requestId: other });
    assert.equal(f.json?.outcome, 'fenced', 'PRECONDITION: a different id is fenced');
    const m = await move(base, Z);
    assert.equal(m.status, 200, `a move whose id was never fenced applies (got ${m.status}: ${m.text.slice(0, 160)})`);
    assert.equal((await card1(base)).column, 'planned', 'and the card moved');
  });
});
