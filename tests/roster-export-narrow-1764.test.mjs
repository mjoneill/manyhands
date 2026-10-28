// #1764 — the builder's row for the one failure the superset design leaves open: the graph commit landed and ONLY the
// narrowing export write failed (injected by the server's test-only seam). The save answers 500, the graph holds the new
// roster, and roster.json still lists the SUPERSET of old and new seats, which the history gate over-guards (never
// under-guards). The next boot's re-export narrows it to exactly the graph. Collections unit on, a real executor. Without a
// python with pyoxigraph the row is SKIPPED, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'ren-1764';
const FILE = { seats: { ann: { name: 'Ann', glyph: 'a', color: '#111111' }, bo: { name: 'Bo', glyph: 'b', color: '#222222' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } };
const NEXT = { seats: { ann: { name: 'Ann', glyph: 'a', color: '#111111' }, cy: { name: 'Cy', glyph: 'c', color: '#333333' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } };
const fileSeats = (f) => Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).seats);
const configured = async (base) => Object.entries((await (await fetch(`${base}/api/roster`)).json()).seats).filter(([, v]) => !v.agent).map(([k]) => k);

test('#1764 N1 the graph commit lands and only the narrowing export fails: a 500, the graph holds the new roster, the file a SUPERSET, and the next boot narrows it', { skip: SKIP, timeout: 240000 }, async () => {
  const store = tmpStore('ren-1764-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-1764-'));
  const file = path.join(dir, 'roster.json');
  fs.writeFileSync(file, JSON.stringify(FILE, null, 2));
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_ROSTER_FILE: file };
  let rest = null, again = null;
  try {
    rest = await startRestServer({ board: makeBoardFixture(), env: { ...env, SCRUM_TEST_FAIL_ROSTER_EXPORT_NARROW: '1' } });
    assert.deepEqual(await configured(rest.baseUrl), ['ann', 'bo', 'board'], 'PRECONDITION: the file was imported in order');
    const r = await fetch(`${rest.baseUrl}/api/roster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(NEXT) });
    assert.equal(r.status, 500, `the save reports the stale export (${await r.text()})`);
    assert.deepEqual(await configured(rest.baseUrl), ['ann', 'cy', 'board'], 'the graph commit stands: the new roster');
    const f = fileSeats(file);
    for (const k of ['ann', 'bo', 'cy', 'board']) assert.ok(f.includes(k), `the file is a SUPERSET of old and new: it still names ${k} (${f})`);
    rest.kill();
    again = await startRestServer({ boardFile: rest.boardFile, env });
    assert.deepEqual(fileSeats(file), ['ann', 'cy', 'board'], 'the boot re-export narrows the file to exactly the graph');
    assert.deepEqual(await configured(again.baseUrl), ['ann', 'cy', 'board'], 'and the roster is unchanged by the restart');
  } finally {
    await again?.stop(); await rest?.stop(); await killExecutor(exec);
    for (const p of [store, dir]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});
