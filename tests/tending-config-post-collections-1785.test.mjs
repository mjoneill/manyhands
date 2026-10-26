// #1785 — the RUNTIME tending save with the collections unit ON (production's configuration). The boot import's collections-on
// row (tending-config-collections-1785) covers the first boot; every runtime POST row elsewhere (the stale-claim seam, the
// settings surface) runs in document mode, where a write outside the lock simply saves. This row puts the save through the
// graph path: POST /api/tending-config answers the clean value, GET agrees, and a restart reads it back from the graph with
// the file still holding the old values. Test author's row. Without a python with pyoxigraph it is SKIPPED, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'tcp-1785';

test('#1785 P1 with the collections unit ON, a runtime save commits to the graph and survives a restart; the file is never written', { skip: SKIP, timeout: 240000 }, async () => {
  const store = tmpStore('tcp-1785-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcp-1785-'));
  const file = path.join(dir, 'tending-config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, quietAfterMinutes: 58 }));
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_TENDING_CONFIG_FILE: file };
  let rest = null, again = null;
  try {
    rest = await startRestServer({ board: makeBoardFixture(), env });
    assert.deepEqual(await (await fetch(`${rest.baseUrl}/api/tending-config`)).json(), { enabled: true, quietAfterMinutes: 58 }, 'PRECONDITION: the boot import ran');
    const bytes = fs.readFileSync(file);
    const p = await fetch(`${rest.baseUrl}/api/tending-config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, quietAfterMinutes: 42 }) });
    assert.equal(p.status, 200, `P1: the save is accepted (${p.status}; stderr: ${rest.stderr().slice(-400)})`);
    assert.deepEqual(await p.json(), { enabled: false, quietAfterMinutes: 42 }, 'P1: it answers the clean value');
    assert.deepEqual(await (await fetch(`${rest.baseUrl}/api/tending-config`)).json(), { enabled: false, quietAfterMinutes: 42 }, 'P1: GET agrees');
    assert.doesNotMatch(rest.stderr(), /outside withWriteLock/, 'P1: no write outside the lock');
    assert.ok(fs.readFileSync(file).equals(bytes), 'P1: the file is never written');
    rest.kill();
    again = await startRestServer({ boardFile: rest.boardFile, env });
    assert.deepEqual(await (await fetch(`${again.baseUrl}/api/tending-config`)).json(), { enabled: false, quietAfterMinutes: 42 }, 'P1: a restart reads the saved value from the graph, not the file');
  } finally { await again?.stop(); await rest?.stop(); await killExecutor(exec); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});
