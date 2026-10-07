/**
 * #1628 — a card write whose reply was lost is answered by its RECEIPT, never guessed. Builder's row, REST with the cards
 * unit on and a REAL executor behind a fault proxy that drops ONE `POST /update`:
 *   K1 LOST ACK on a create: the executor applied it and the reply was lost: the create answers 201 (never 500 or 503),
 *      exactly ONE card with that title exists, and the next create is numbered one past it.
 *   K2 REQUEST NOT ARRIVED on a create: the receipt is ABSENT, the same intention is replayed: 201 and ONE card.
 * Each row asserts the proxy dropped exactly one write, so a row whose fault never fired fails instead of passing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `kla-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

async function faultProxy(execUrl) {
  const state = { armed: null, dropped: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const fault = req.url === '/update' ? state.armed : null; if (fault) { state.armed = null; state.dropped++; }
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
async function unitOn(body) {
  const exec = await startExecutor({ store: tmpStore('kla-'), datasetId: 'kla', create: true });
  const proxy = await faultProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'kla', SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1' } });
  try { return await body({ base: rest.baseUrl, proxy }); } finally { await rest.stop(); proxy.close(); await killExecutor(exec); }
}
const titled = async (base, title) => ((await api(base, 'GET', '/api/cards?limit=500')).body?.cards ?? (await api(base, 'GET', '/api/cards?limit=500')).body ?? []).filter((c) => c.title === title);

for (const [label, fault] of [['K1 LOST ACK', 'drop-reply'], ['K2 REQUEST NOT ARRIVED', 'drop-request']]) {
  test(`#1628 ${label} on a card create: 201 and exactly one card, never a 500 after a committed write`, { skip: SKIP, timeout: 300000 }, async () => {
    await unitOn(async ({ base, proxy }) => {
      const tag = `kla-${process.pid}-${fault}`;
      assert.equal((await api(base, 'POST', '/api/cards', { title: `${tag} control`, createdBy: 'ada' })).status, 201, 'CONTROL: a create lands with no fault');
      proxy.state.armed = fault;
      const r = await api(base, 'POST', '/api/cards', { title: `${tag} faulted`, createdBy: 'ada' });
      assert.equal(proxy.state.dropped, 1, 'THE FAULT FIRED: exactly one write was dropped');
      assert.equal(r.status, 201, `the create answers 201 (${r.status} ${r.text.slice(0, 160)})`);
      assert.equal((await titled(base, `${tag} faulted`)).length, 1, 'exactly ONE card with that title');
      const next = await api(base, 'POST', '/api/cards', { title: `${tag} after`, createdBy: 'ada' });
      assert.equal(next.status, 201);
      assert.equal(next.body.shortId, r.body.shortId + 1, 'the next create is numbered one past it (no number burned or reused)');
    });
  });
}
