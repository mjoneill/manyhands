/**
 * #1624 (review 08:45Z) — a collection write whose outcome is UNKNOWN is never guessed. Builder's rows, the collections
 * unit against a REAL executor behind a fault proxy:
 *   U1 LOST ACK: the executor applies the write and the reply is dropped: the commit still answers APPLIED (by the
 *      receipt), the cache holds the entity at version 1, and the graph holds exactly one write of it.
 *   U2 REQUEST NOT ARRIVED: the update is dropped before the executor: the receipt is ABSENT, the SAME intention is
 *      replayed, and the entity lands once.
 *   U3 NOTHING SENT: the proxy refuses the connection: the commit throws "unavailable", nothing is in the graph, and the
 *      cache stays current (a snapshot still answers), since nothing could have been written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createCollectionsUnit } from '../core/collections-unit.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const RS = 'https://scrumboard.local/ns#';

async function faultProxy(execUrl) {
  const state = { armed: null, updates: 0, down: false };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (state.down) { req.socket.destroy(); return; }
      const isUpdate = req.url === '/update';
      const fault = isUpdate ? state.armed : null; if (fault) state.armed = null;
      if (isUpdate) state.updates++;
      if (fault === 'drop-request') { req.socket.destroy(); return; }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      try {
        const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
        const t = await f.text();
        if (fault === 'drop-reply') { req.socket.destroy(); return; }
        res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
      } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
async function world(body) {
  const x = await startExecutor({ store: tmpStore('cu-'), datasetId: 'cu-test', create: true });
  const p = await faultProxy(x.baseUrl);
  const direct = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'cu-test', timeoutMs: 30000 });
  let n = 0;
  const unit = createCollectionsUnit({ client: createGraphClient({ baseUrl: p.url, expectedDatasetId: 'cu-test', timeoutMs: 30000 }), families: [{ key: 'models' }], mintId: () => `u${process.pid}-${++n}` });
  await unit.load();
  try { return await body({ unit, p, direct }); } finally { p.close(); await killExecutor(x); }
}
const model = (key) => ({ '@id': `https://scrumboard.local/model/${key}`, '@type': 'scrum:Model', 'scrum:modelKey': key, name: key });
const writesOf = async (direct, iri) => {
  const q = await direct.query(`SELECT ?op WHERE { <${iri}> <urn:ex:recordedBy> ?op }`);
  assert.ok(q.ok, q.reason); return q.rows.length;
};
const verOf = async (direct, iri) => {
  const q = await direct.query(`SELECT ?v WHERE { <${iri}> <urn:ex:ver> ?v }`);
  assert.ok(q.ok, q.reason); return q.rows.map((r) => Number(r.v.value));
};

test('U1 LOST ACK: the executor applied it and the reply was lost: APPLIED by the receipt, version 1, written once', { skip: SKIP }, async () => {
  await world(async ({ unit, p, direct }) => {
    const m = model('lost-ack');
    p.state.armed = 'drop-reply';
    const r = await unit.commit({ models: [m] }, { actor: 'ada' });
    assert.equal(r.outcome, 'APPLIED');
    assert.deepEqual(await verOf(direct, m['@id']), [1]);
    assert.equal(await writesOf(direct, m['@id']), 1);
    assert.equal(unit.snapshot().models.length, 1, 'the cache holds it');
  });
});

test('U2 REQUEST NOT ARRIVED: the receipt is ABSENT, the SAME intention is replayed, and it lands once', { skip: SKIP }, async () => {
  await world(async ({ unit, p, direct }) => {
    const m = model('not-arrived');
    p.state.armed = 'drop-request';
    const before = p.state.updates;
    const r = await unit.commit({ models: [m] }, { actor: 'ada' });
    assert.equal(r.outcome, 'APPLIED');
    assert.equal(p.state.updates - before, 2, 'one dropped update and one replay, no third write');
    assert.deepEqual(await verOf(direct, m['@id']), [1]);
    assert.equal(await writesOf(direct, m['@id']), 1);
  });
});

test('U3 NOTHING SENT: unavailable, nothing in the graph, and the cache is still current', { skip: SKIP }, async () => {
  await world(async ({ unit, p, direct }) => {
    const m = model('never-sent');
    p.state.down = true;
    await assert.rejects(unit.commit({ models: [m] }, { actor: 'ada' }), (e) => e.code === 'COLLECTIONS_UNAVAILABLE');
    p.state.down = false;
    assert.deepEqual(await verOf(direct, m['@id']), []);
    assert.deepEqual(unit.snapshot().models, [], 'a snapshot still answers: nothing could have been written');
  });
});
