/**
 * #1747 step 6 — the activity projector (#1641, a live first-party writer) declares the #1748 write protocol, so it keeps
 * working once a store is floored. ROW AUTHOR's rows for the builder's change (core/activity-projector.mjs): a REAL
 * projectBatch against a REAL executor.
 *   P0 CONTROL  unfloored: the batch applies (the header is harmless where there is no floor)
 *   P1          floored: the batch applies and the cursor advances
 *   P2          floored, the header stripped from the batch's /update: refused 428, cursor and counters unmoved, so P1's
 *               success is the header's doing and not a floor that admits everyone
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectBatch, readCursor } from '../core/activity-projector.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { spawnExecutor, killExecutor, HAVE_PY, PY } from './helpers/graph-executor-proc.mjs';

const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 120000 };
const owned = { dirs: new Set(), children: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); owned.dirs.add(d); return d; };
const start = async (extra = []) => {
  const store = tmp('proj1747-store-'); fs.rmSync(store, { recursive: true });
  const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', 'proj-1747', '--create', ...extra]); owned.children.add(x); return x;
};
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
const counters = (h) => [h.updates, h.flushes, h.commitSeq];
/** a log of two complete events and an empty work ledger: the smallest real input projectBatch accepts */
function sources() {
  const logDir = tmp('proj1747-log-'), workDir = tmp('proj1747-work-');
  const ev = (seq) => JSON.stringify({ seq, ts: '2026-10-25T09:00:00.000Z', op: 'card.update', actor: 'ada', entity: { id: `uuid-p${seq}`, kind: 'card', shortId: seq } });
  fs.writeFileSync(path.join(logDir, 'events-2026-10-25.jsonl'), `${ev(1)}\n${ev(2)}\n`);
  fs.writeFileSync(path.join(workDir, 'work-objects.jsonl'), '');
  return { logDir, workDir };
}
const activityStored = async (x, seq) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `ASK { { ?a <http://www.w3.org/ns/prov#used> <https://scrumboard.local/entity/uuid-p${seq}> } UNION { GRAPH ?g { ?a <http://www.w3.org/ns/prov#used> <https://scrumboard.local/entity/uuid-p${seq}> } } }` });
  return (await r.json()).boolean;
};

for (const [label, extra] of [['P0 CONTROL, unfloored', []], ['P1, floored', ['--install-write-floor', WRITE_PROTOCOL]]]) {
  test(`#1747 (${label}) a real projectBatch applies and the cursor advances`, T, async () => {
    const x = await start(extra);
    assert.equal((await health(x)).writeFloor, extra.length ? WRITE_PROTOCOL : null, 'PRECONDITION: the floor is as named');
    const r = await projectBatch({ ...sources(), executorUrl: x.baseUrl });
    assert.deepEqual([r.cursor.seq, r.cursor.workRows], [2, 0], `the batch's cursor (${JSON.stringify(r)})`);
    const c = await readCursor(x.baseUrl);
    assert.deepEqual([c.seq, c.workRows], [2, 0], 'and the executor holds it');
    assert.equal(await activityStored(x, 2), true, 'the activity was projected');
  });
}

test('#1747 (P2, floored) the same batch with the protocol header STRIPPED is refused 428: cursor, activities and counters unmoved', T, async () => {
  const x = await start(['--install-write-floor', WRITE_PROTOCOL]);
  const h0 = await health(x);
  const c0 = await readCursor(x.baseUrl);
  const real = globalThis.fetch;
  let stripped = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/update') && init.headers && WRITE_PROTOCOL_HEADER in init.headers) {
      const { [WRITE_PROTOCOL_HEADER]: _gone, ...rest } = init.headers; stripped++;
      return real(url, { ...init, headers: rest });
    }
    return real(url, init);
  };
  let err = null;
  try { await projectBatch({ ...sources(), executorUrl: x.baseUrl }); } catch (e) { err = e; } finally { globalThis.fetch = real; }
  assert.equal(stripped, 1, 'PRECONDITION: the batch sent exactly one /update, and it carried the header (which was stripped)');
  assert.match(String(err?.message), /HTTP 428/, `refused with 428 (${err?.message})`);
  const c1 = await readCursor(x.baseUrl);
  assert.deepEqual([c1.seq, c1.workRows, c1.present], [c0.seq, c0.workRows, c0.present], 'the cursor did not move');
  assert.equal(await activityStored(x, 2), false, 'no activity was projected');
  assert.deepEqual(counters(await health(x)), counters(h0), 'nothing applied or flushed');
});
