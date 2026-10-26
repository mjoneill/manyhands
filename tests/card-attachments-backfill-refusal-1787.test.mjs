// #1787 — the builder's row for the backfill's failure path: when a write is not APPLIED the script exits 1 and names the
// card, never reporting success. The refusal is injected by a proxy that forwards every read to a real executor and answers
// every /update with a 500 (the executor away mid-backfill). Without a python with pyoxigraph it is SKIPPED, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { cardQuads, cardIriOf, shortIdMap } from '../core/cards-graph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'backfill-card-attachments-1787.mjs');
const DS = 'bf-refusal-1787';
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => resolve({ status, out, err }));
});

test('#1787 BR1 a backfill write that is not APPLIED exits 1, names the card, and never prints the success line', { skip: !HAVE_PY && 'no executor python', timeout: 180000 }, async (t) => {
  const x = await startExecutor({ store: tmpStore('bf-1787-'), datasetId: DS, create: true });
  t.after(() => killExecutor(x));
  const g = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DS, timeoutMs: 30000, label: 'br1' });
  const card = { id: 'c-br1', shortId: 7, title: 'with an attachment', column: 'backlog', version: 1, attachments: [{ id: 'att-1', name: 'a.png', mime: 'image/png', size: 3 }] };
  const w = await g.update({ kind: 'card.write', opId: 'urn:ex:op/card/br1', actor: 'https://scrumboard.local/person/ada', parts: [{ iri: cardIriOf(card.id), expectedVersion: null, version: '1', quads: cardQuads(card, shortIdMap([card])), json: JSON.stringify(card) }] });
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  // make it look pre-#1787: the attachment nodes are absent
  const ep = (await (await fetch(`${x.baseUrl}/health`)).json()).epoch;
  const strip = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:ex:op/test/br1-strip', 'x-epoch': String(ep) }, body: `DELETE WHERE { ?a <https://scrumboard.local/ns#attachmentOf> <${cardIriOf(card.id)}> . ?a ?p ?o }` });
  assert.equal(strip.status, 200, await strip.text());
  const dry = await run(['--executor', x.baseUrl, '--dataset', DS]);
  assert.equal(dry.status, 0, dry.err);
  assert.match(dry.out, /1 need attachment nodes/, 'PRECONDITION: the card needs its nodes');

  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url.startsWith('/update')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"injected: the executor is away"}'); }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const f = await fetch(`${x.baseUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(await f.text());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { proxy.closeAllConnections?.(); proxy.close(() => r()); }));
  const r = await run(['--executor', `http://127.0.0.1:${proxy.address().port}`, '--dataset', DS, '--apply']);
  assert.equal(r.status, 1, `a refused write exits 1 (out: ${r.out} err: ${r.err})`);
  assert.match(r.err, /card c-br1 \(#7\) was not written/, 'and names the card');
  assert.doesNotMatch(r.out, /#1787 backfill: scanned/, 'and never prints the success line');
});
