// #1764 (PR #140 review) — CONCURRENT full saves. A save's three steps (superset export, graph commit, exact export) run as
// one unit under the write lock for the first two, and the narrowing step after; if two saves could interleave, the file
// could end up narrowed to one roster while the graph holds another, which is an under-guard. Six different rosters POSTed
// at once: every save answers 200, the graph holds exactly ONE of them, and roster.json equals the graph's seats exactly.
// Collections unit on, a real executor. Without a python with pyoxigraph it is SKIPPED, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'rcc-1764';
const seat = (n, c) => ({ name: n, color: c });
const roster = (i) => ({ seats: { [`p${i}a`]: seat(`Person ${i} A`, '#111111'), [`p${i}b`]: seat(`Person ${i} B`, '#222222'), board: { name: 'Board', color: '#8899aa', kind: 'system' } } });

test('#1764 K1 six concurrent full roster saves: all 200, the graph holds exactly one posted roster, and the export equals it', { skip: SKIP, timeout: 240000 }, async () => {
  const store = tmpStore('rcc-1764-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-1764-'));
  const file = path.join(dir, 'roster.json');
  fs.writeFileSync(file, JSON.stringify(roster(0), null, 2));
  let rest = null;
  try {
    rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_ROSTER_FILE: file } });
    // three rounds of six at once, so the narrowing of one save has repeated chances to land after another save's commit
    for (let round = 0; round < 3; round++) {
      const posts = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => fetch(`${rest.baseUrl}/api/roster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roster(i)) })));
      assert.deepEqual(posts.map((r) => r.status), [200, 200, 200, 200, 200, 200], `round ${round}: every concurrent save is answered`);
    }
    const got = (await (await fetch(`${rest.baseUrl}/api/roster`)).json()).seats;
    const graphKeys = Object.entries(got).filter(([, v]) => !v.agent).map(([k]) => k);
    const winner = [1, 2, 3, 4, 5, 6].find((i) => JSON.stringify(Object.keys(roster(i).seats)) === JSON.stringify(graphKeys));
    assert.ok(winner, `the graph holds exactly one of the posted rosters (${graphKeys})`);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8')).seats;
    assert.deepEqual(Object.keys(exported), graphKeys, 'the export is EXACTLY the graph\'s roster, narrowed after the last commit, not another save\'s');
    for (const k of graphKeys) assert.equal(exported[k].name, got[k].name, `${k}: the export carries the graph's identity`);
  } finally {
    await rest?.stop(); rest = null; await killExecutor(exec);
    for (const p of [store, dir]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

test('#1764 K2 an EARLIER save whose narrowing lands after a LATER save\'s commit still leaves the export equal to the graph', { skip: SKIP, timeout: 240000 }, async () => {
  const store = tmpStore('rcc2-1764-');
  const exec = await startExecutor({ store, datasetId: 'rcc2-1764', create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc2-1764-'));
  const file = path.join(dir, 'roster.json');
  fs.writeFileSync(file, JSON.stringify(roster(0), null, 2));
  let rest = null;
  try {
    // the server holds ANY save naming p1a for 1.5 s between its commit and its narrowing (a test-only seam)
    rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_GRAPH_DATASET_ID: 'rcc2-1764', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_ROSTER_FILE: file, SCRUM_TEST_DELAY_ROSTER_NARROW_FOR: 'p1a' } });
    const slow = fetch(`${rest.baseUrl}/api/roster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roster(1)) });
    await new Promise((r) => setTimeout(r, 300));   // roster 1 has committed and is held before its narrowing
    const fast = await fetch(`${rest.baseUrl}/api/roster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roster(2)) });
    assert.equal(fast.status, 200); assert.equal((await slow).status, 200);
    const graphKeys = Object.entries((await (await fetch(`${rest.baseUrl}/api/roster`)).json()).seats).filter(([, v]) => !v.agent).map(([k]) => k);
    assert.deepEqual(graphKeys, Object.keys(roster(2).seats), 'PRECONDITION: the later save is the graph\'s roster');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).seats), graphKeys,
      'the earlier save\'s late narrowing writes the graph\'s CURRENT roster, never its own (which would unguard the later save\'s seats)');
  } finally {
    await rest?.stop(); await killExecutor(exec);
    for (const p of [store, dir]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});
