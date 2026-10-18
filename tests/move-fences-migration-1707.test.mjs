/**
 * #1707 — THE MIGRATION ROW for the move fences: fences recorded in the DOCUMENT before the graph held them must still
 * refuse their moves after the switch. BUILDER-WRITTEN (the rows the build answers to are tests/move-fences-executor-1707
 * by the test author); this one covers what those rows say they do not: the existing fences on a live board.
 *
 *   MM1  a fence recorded with the small-kinds unit OFF (the document path, as prod's existing fences were) makes a REST with the
 *        unit ON refuse to start, naming the migration: a board whose graph does not hold the document's fences must never serve
 *   MM2  after scripts/migrate-collections-1624.mjs --apply, the same REST starts, and the fenced move is refused 409 MOVE_FENCED,
 *        and the card does not move
 *   MM3  CONTROL: on that migrated board a never-fenced id still moves (the import fenced nothing extra)
 *
 * NOT covered: the retire step (it removes @graph nodes by @id; the document's fence STRINGS are not nodes and stay, which the
 * boot check then finds held); the browser's settle flow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };
const SMALL = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1' };
const api = async (base, method, route, body) => {
  const r = await fetch(`${base}${route}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* reported */ } return { status: r.status, json, text };
};
const move = (base, requestId) => api(base, 'PATCH', '/api/cards/1', { by: 'ada', column: 'planned', order: 1, makeRoom: true, requestId });

test('#1707 (MM1–MM3) fences recorded in the document before the switch: boot refuses until migrated, then every one still refuses its move', { skip: SKIP, timeout: 300000 }, async () => {
  const w = await wholeBoardWorld({ env: BASE });   // the small-kinds unit OFF: fences go to the document, as prod's did
  const env = { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, ...BASE };
  let rest = null;
  try {
    const X = 'mm-legacy-fence-0001', Y = 'mm-never-fenced-0002';
    const f = await api(w.rest.baseUrl, 'POST', '/api/cards/1/move-fence', { requestId: X });
    assert.equal(f.json?.outcome, 'fenced', `PRECONDITION: fenced on the document path (${f.text.slice(0, 160)})`);
    assert.ok(fs.readFileSync(w.boardFile, 'utf8').includes(X), 'PRECONDITION: the fence is in the document');
    const kept = fs.readFileSync(w.boardFile); await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks on stop

    // MM1 — the unit ON over a graph that does not hold the document's fence: must not serve
    let err = null;
    // a start the server REFUSES leaves the harness's attachments directory behind (it is made before the process runs and only
    // stop() removes it): note what exists, and remove exactly what the refused start made
    const attach = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('scrum-test-attach-')));
    const attachBefore = attach();
    try { rest = await startRestServer({ boardFile: w.boardFile, env: { ...env, ...SMALL } }); } catch (e) { err = e; }
    if (!rest) for (const n of attach()) if (!attachBefore.has(n)) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
    if (rest) { const k = fs.readFileSync(w.boardFile); await rest.stop(); fs.writeFileSync(w.boardFile, k); rest = null; assert.fail('MM1: REST served with the document\'s fence missing from the graph'); }
    assert.match(String(err?.message), /migrate-collections-1624/, `MM1: the refusal names the migration (${String(err?.message).slice(-300)})`);

    // MM2 — migrate, then the same REST starts and the fence holds
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-collections-1624.mjs'), '--board-data', w.boardFile, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--apply'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    assert.ok(/moveFences/.test(out), `PRECONDITION: the migration reports the moveFences family (${out.slice(-300)})`);
    rest = await startRestServer({ boardFile: w.boardFile, env: { ...env, ...SMALL } });
    const before = (await api(rest.baseUrl, 'GET', '/api/cards/1')).json;
    const p = await move(rest.baseUrl, X);
    assert.equal(p.status, 409, `MM2: the migrated fence still refuses its move (got ${p.status}: ${p.text.slice(0, 160)})`); assert.equal(p.json?.code, 'MOVE_FENCED');
    const after = (await api(rest.baseUrl, 'GET', '/api/cards/1')).json;
    assert.equal(after.column, before.column, 'MM2: and the card did not move');

    // MM3 — CONTROL: the import fenced nothing else
    const m = await move(rest.baseUrl, Y);
    assert.equal(m.status, 200, `MM3: a never-fenced id still moves (got ${m.status}: ${m.text.slice(0, 160)})`);
  } finally {
    if (rest) { const k = fs.existsSync(w.boardFile) ? fs.readFileSync(w.boardFile) : null; await rest.stop().catch(() => {}); if (k) fs.writeFileSync(w.boardFile, k); }
    await w.stop().catch(() => {});
  }
});
