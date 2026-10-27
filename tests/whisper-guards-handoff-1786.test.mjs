// #1786 (#139 review) — the HANDOFF from the old file guard: a window consumed before the graph guard existed must stay
// consumed. L1: a window already DELIVERED (a TendingMint for it) refuses a reservation. L2: a window the legacy
// whisper-state.json had consumed (lastMintedWindow, burned or delivered, with no reservation) refuses one after boot, and the
// NEXT window still reserves. Collections unit on, a real executor. Without a python with pyoxigraph it is SKIPPED, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const hourAt = (offset) => new Date((Math.floor(Date.now() / 3600_000) + offset) * 3600_000).toISOString();
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function world(dsid, extraEnv, body) {
  const store = tmpStore(`${dsid}-`);
  const exec = await startExecutor({ store, datasetId: dsid, create: true });
  let rest = null;
  try {
    rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', ...extraEnv } });
    await body(rest);
  } finally { await rest?.stop(); await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}

test('#1786 L1 a window already DELIVERED (a TendingMint for it, no reservation) refuses a new reservation', { skip: SKIP, timeout: 240000 }, async () => {
  await world('wgh1-1786', {}, async (rest) => {
    const w = hourAt(0);
    const m = await post(rest.baseUrl, '/api/tending/mints', { window: w, mintedAt: new Date().toISOString(), by: 'board' });
    assert.equal(m.status, 201, 'PRECONDITION: the delivered firing is recorded');
    const r = await post(rest.baseUrl, '/api/tending/windows', { window: w, by: 'board' });
    assert.equal(r.status, 409, `a delivered window is consumed (${await r.text()})`);
    assert.equal((await post(rest.baseUrl, '/api/tending/windows', { window: hourAt(1), by: 'board' })).status, 201, 'CONTROL: the next window reserves');
  });
});

test('#1786 L2 the legacy file guard\'s last consumed window (burned: no mint) stays consumed after boot; the next window reserves', { skip: SKIP, timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgh2-1786-'));
  const stateFile = path.join(dir, 'whisper-state.json');
  const w = hourAt(0);
  fs.writeFileSync(stateFile, JSON.stringify({ lastMintedWindow: w, lastMintedAt: new Date().toISOString(), history: [] }));
  try {
    await world('wgh2-1786', { SCRUM_WHISPER_STATE_FILE: stateFile }, async (rest) => {
      const r = await post(rest.baseUrl, '/api/tending/windows', { window: w, by: 'board' });
      assert.equal(r.status, 409, `the legacy consumed window is carried as consumed (${await r.text()})`);
      const g = await fetch(`${rest.baseUrl}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `SELECT ?m WHERE { ?m a scrum:TendingMint ; scrum:clockWindow ${JSON.stringify(w)} }` }) });
      assert.equal((await g.json()).rows.length, 0, 'no TendingMint is invented for a burned window');
      assert.equal((await post(rest.baseUrl, '/api/tending/windows', { window: hourAt(1), by: 'board' })).status, 201, 'the next unconsumed window still reserves');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
