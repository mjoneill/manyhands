// #1786 — the builder's fault row for the send guard's AT-MOST-ONCE trade: a window reserved and then never sent (the MCP
// crashed after the reservation, or the 201 was lost, or the post failed) is BURNED — the acceptable silence, #804's
// fail-silent rule — and is never a false firing. Collections unit on, a real executor. Without a python with pyoxigraph the
// row is SKIPPED, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { tendingTick } from '../core/tending-tick.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'wgs-1786';
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const mints = async (base, window) => {
  const r = await fetch(`${base}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `SELECT ?m WHERE { ?m a scrum:TendingMint ; scrum:clockWindow ${JSON.stringify(window)} }` }) });
  assert.equal(r.status, 200, 'the graph answers');
  return (await r.json()).rows.length;
};

test('#1786 F1 a reserved window whose send never happens is BURNED: no TendingMint, and no later tick sends it', { skip: SKIP, timeout: 240000 }, async () => {
  const store = tmpStore('wgs-1786-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' };
  let rest = null;
  try {
    rest = await startRestServer({ board: makeBoardFixture(), env });
    const window = new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString();
    // the MCP's own composition (pick → reserve → post → record), with the POST failing after the reservation
    const now = new Date().toISOString();
    let recorded = 0, posted = 0;
    const tick = () => tendingTick({
      now, enabled: true, quietAfterMinutes: 1, lastActivityAt: () => '2000-01-01T00:00:00.000Z',
      eligibility: () => ({ eligible: ['ada'] }),
      mint: async () => {
        const r = await post(rest.baseUrl, '/api/tending/windows', { window, by: 'board' });
        return r.status === 201 ? { window, body: 'a whisper', mintedAt: now } : null;
      },
      post: async () => { posted++; throw new Error('injected: the post never lands'); },
      onMinted: () => { recorded++; },
    });
    const first = await tick();
    assert.equal(first.reason, 'delivery-failed', `the first tick reserved and failed to deliver (${JSON.stringify(first)})`);
    assert.equal(recorded, 0, 'an undelivered offer is not recorded as a firing');
    assert.equal(await mints(rest.baseUrl, window), 0, 'and the graph holds NO TendingMint for the window');
    const second = await tick();
    assert.equal(second.reason, 'nothing-to-mint', `the window is burned: a later tick sends nothing (${JSON.stringify(second)})`);
    assert.equal(posted, 1, 'exactly one send was ever attempted for the window');
  } finally {
    await rest?.stop(); await killExecutor(exec);
    fs.rmSync(store, { recursive: true, force: true });
  }
});
