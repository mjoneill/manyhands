// #1785 — the one-time tending-config import at BOOT, with the collections unit ON (production's configuration). Every other
// #1785 row runs in document mode, where a write outside the lock simply saves; with the unit on, a collection write outside
// withWriteLock THROWS ("#1624: … cannot be committed to the graph"), and a boot import that swallowed it would silently drop
// the file's values (production's file holds quietAfterMinutes 58, not the default). Without a python with pyoxigraph the row
// is SKIPPED, and a skip is NOT a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'tcc-1785';

test('#1785 C1 with the collections unit ON, the first boot imports the file\'s switch AND threshold, and a restart keeps them', { skip: SKIP, timeout: 240000 }, async () => {
  const store = tmpStore('tcc-1785-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-1785-'));
  const file = path.join(dir, 'tending-config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, quietAfterMinutes: 58 }));
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_TENDING_CONFIG_FILE: file };
  let rest = null, again = null;
  try {
    rest = await startRestServer({ board: makeBoardFixture(), env });
    const got = await (await fetch(`${rest.baseUrl}/api/tending-config`)).json();
    assert.deepEqual(got, { enabled: true, quietAfterMinutes: 58 }, `the import committed to the graph (stderr: ${rest.stderr().slice(-600)})`);
    assert.doesNotMatch(rest.stderr(), /tending config import failed/, 'and the boot did not swallow a refused write');
    fs.writeFileSync(file, JSON.stringify({ enabled: false, quietAfterMinutes: 5 }));   // a later file edit must change nothing
    rest.kill();
    again = await startRestServer({ boardFile: rest.boardFile, env });
    assert.deepEqual(await (await fetch(`${again.baseUrl}/api/tending-config`)).json(), { enabled: true, quietAfterMinutes: 58 },
      'a restart reads the graph, not the edited file');
  } finally {
    await again?.stop(); await rest?.stop(); await killExecutor(exec);
    // the suite's tmp check fails a run on any NEW leftover: the store and the config folder go with the test
    for (const p of [store, dir]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});
