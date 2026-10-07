/**
 * #1624 (read-back 1, 2026-10-07T13:57Z) — after the small-kinds flip, /api/procedures listed a procedure's versions
 * newest-first (v2, v1) where the document had always listed them oldest-first: the graph returns entities in no
 * particular order. Builder's rows, real executor:
 *   PO1 unit ON: a procedure revised five times, read through a FRESH server (its cache loaded from the graph), lists
 *       its versions v1 … v6 (by version number, oldest first).
 *   PO2 unit OFF (control): the same order, so the wire is the same on either store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `po1624-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
async function scenario(base) {
  const name = `order check ${process.pid}`;
  assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name, body: 'first: one step' })).status, 201);
  // Six versions: the graph returns entities in an order set by their random ids, so with six a missing sort shows up
  // except by a 1-in-720 chance (with two or three it can pass by luck, measured).
  for (const body of ['two', 'three', 'four', 'five', 'six'].map((w) => `step ${w}`)) {
    const r = await api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: name, body });
    assert.ok(r.status === 200 || r.status === 201, `a revision lands (${r.status} ${r.text.slice(0, 120)})`);
  }
  return { name, versions: await listed(base, name) };
}
async function listed(base, name) {
  const list = await api(base, 'GET', '/api/procedures');
  assert.equal(list.status, 200);
  const p = list.body.find((x) => x.name === name);
  assert.ok(p, 'the procedure is listed');
  return p.versions.map((v) => v.name ?? v.title ?? v.version);
}

test('PO1 unit ON: a procedure\'s versions are listed oldest first (v1 … v6)', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('po-'), datasetId: 'po-test', create: true });
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'po-test', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' };
  try {
    // Written through one server, then read through a FRESH one: a running server's cache keeps write order, and the
    // order only scrambles when the cache is LOADED from the graph (a restart: what happened live at the cutover).
    const first = await startRestServer({ board: makeBoardFixture(), env });
    let name;
    try { name = (await scenario(first.baseUrl)).name; } finally { await first.stop(); }
    const second = await startRestServer({ board: makeBoardFixture(), env });
    try {
      const names = await listed(second.baseUrl, name);
      assert.deepEqual(names.map((n) => /\sv(\d+)$/.exec(String(n))?.[1]), ['1', '2', '3', '4', '5', '6'], `oldest first after a cache load (${JSON.stringify(names)})`);
    } finally { await second.stop(); }
  } finally { await killExecutor(exec); }
});

test('PO2 unit OFF (control): the same order', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const names = (await scenario(rest.baseUrl)).versions;
    assert.deepEqual(names.map((n) => /\sv(\d+)$/.exec(String(n))?.[1]), ['1', '2', '3', '4', '5', '6'], `oldest first (${JSON.stringify(names)})`);
  } finally { await rest.stop(); }
});
