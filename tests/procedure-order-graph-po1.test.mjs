/**
 * #1624 K13, THE ORDER OF A PROCEDURE'S VERSIONS. Found by the live read-back after the flip (2026-10-07): for the two procedures with more than one version the file served `versions` oldest-first (v1, v2) and the graph-served board served them newest-first (v2, v1), same set, no data difference. My first rows (definitions-graph-d1)
 * compared lists as sets and said so in their header, so they could not see it. The build owner decided it is a regression in what the board answers and fixes it by sorting a procedure's versions ASCENDING by version number where the wire is built. These rows pin the order, from the outside, on a real executor, with the document path as the control.
 *
 *   PO0  CONTROL (green today): with the unit OFF a procedure revised four times lists its versions v1, v2, v3, v4, v5 in that order, and the order is the same on three reads.
 *   PO1  THE SAME THROUGH THE GRAPH (unit ON): the same script lists v1..v5 in ascending order, the same on three reads, and equal to the unit-off server's answer element by element. (RED on a build that serves them newest-first.)
 *   PO2  ASCENDING BY VERSION NUMBER, NOT BY LUCK: five concurrent revisions of one procedure land as v2..v6; afterwards the list is v1..v6 in ascending order on the unit-on server, whatever order the revisions committed in.
 *   PO4  A MIGRATED PROCEDURE KEEPS THE FILE'S ORDER (the case that was missed): procedures and versions created through a unit-off server, then COPIED INTO THE GRAPH by `scripts/migrate-collections-1624.mjs` and served by a unit-ON server: the versions list oldest-first, as the file's did. PO0 to PO3 all passed on the build that
 *        shipped the regression, because a procedure CREATED through the unit lists ascending; the live regression was in the ones that arrived by MIGRATION, so only this row can fail on it. (RED on 193d23e.)
 *   PO3  ORDER IS PER PROCEDURE AND DOES NOT DISTURB ITS NEIGHBOURS: two procedures, one with three versions and one with one, both listed correctly in one answer; the single-version procedure is unchanged.
 *
 * NOT COVERED, by name: the MCP tool's own rendering of the list (it forwards REST, but I did not call it); the order of OTHER arrays on the wire (a run's `generated`, a role's versions, a playlist's prompts): they were equal in the read-back, not pinned here; versions created before the change that sort differently by creation time than by number (the live two are consistent both ways).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_SMALLKINDS';
const ROSTER_FILE = path.join(os.tmpdir(), `po1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => { const r = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not json */ } return { status: r.status, body: j, text: t }; };
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const num = (name) => Number(/ v(\d+)$/.exec(String(name))?.[1]);
const versionNames = async (base, procName) => { const l = (await api(base, 'GET', '/api/procedures')).body ?? []; const p = l.find((x) => x.name === procName); assert.ok(p, `the procedure "${procName}" is listed`); return p.versions.map((v) => v.name); };

async function script(base, tag) {
  const name = `${tag} method`; const c = await api(base, 'POST', '/api/procedures', { by: 'ada', name, body: `${tag} v1 text` }); assert.equal(c.status, 201, `CONTROL: created (${c.status} ${c.text.slice(0, 120)})`);
  for (let n = 2; n <= 5; n++) { const r = await api(base, 'POST', '/api/procedure-versions', { by: n % 2 ? 'ada' : 'gizmo', procedure: name, body: `${tag} revision ${n}` }); assert.equal(r.status, 201, `CONTROL: revision ${n} (${r.status} ${r.text.slice(0, 120)})`); }
  return name;
}
async function unitOn(body) {
  const exec = await startExecutor({ store: tmpStore('po1k-'), datasetId: 'po1k', create: true });
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'po1k', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl }); } finally { await rest.stop(); await killExecutor(exec); }
}
const ascending = (names) => names.map(num).every((n, i, a) => i === 0 || a[i - 1] < n);

test('PO0 CONTROL: with the unit OFF five versions list v1..v5 in order, stable across three reads', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const name = await script(rest.baseUrl, tag); const reads = []; for (let i = 0; i < 3; i++) reads.push(await versionNames(rest.baseUrl, name));
    assert.deepEqual(reads[0].map(num), [1, 2, 3, 4, 5], `the document path lists v1..v5 oldest-first (${reads[0].join(' | ')})`); assert.deepEqual(reads[1], reads[0]); assert.deepEqual(reads[2], reads[0]);
  } finally { await rest.stop(); }
});

test('PO1 THE SAME THROUGH THE GRAPH: ascending v1..v5, stable across three reads, equal to the unit-off answer', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const offName = await script(off.baseUrl, tag); const expected = await versionNames(off.baseUrl, offName);
    await unitOn(async ({ base }) => {
      const name = await script(base, tag); const reads = []; for (let i = 0; i < 3; i++) reads.push(await versionNames(base, name));
      assert.deepEqual(reads[0].map(num), [1, 2, 3, 4, 5], `the graph-served board lists v1..v5 OLDEST-FIRST, as the file did (got ${reads[0].join(' | ')})`);
      assert.deepEqual(reads[1], reads[0], 'and the second read is the same'); assert.deepEqual(reads[2], reads[0], 'and the third');
      assert.deepEqual(reads[0], expected, 'and element by element equal to the unit-off server');
    });
  } finally { await off.stop(); }
});

test('PO2 ASCENDING BY VERSION NUMBER: five concurrent revisions land as v2..v6 and the list is v1..v6 ascending', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => {
    const tag = ALNUM(); const name = `${tag} method`; assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name, body: `${tag} v1 text` })).status, 201, 'CONTROL: created');
    const rs = await Promise.all([2, 3, 4, 5, 6].map((n) => api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: name, body: `${tag} concurrent revision ${n}` }))); assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201], 'all five are accepted');
    const names = await versionNames(base, name); assert.deepEqual(names.map(num), [1, 2, 3, 4, 5, 6], `v1..v6 each once, ascending (got ${names.join(' | ')})`);
  });
});

test('PO3 ORDER IS PER PROCEDURE: a three-version and a one-version procedure are both listed correctly, the single one unchanged', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => {
    const tag = ALNUM(); const a = `${tag} three`; const b = `${tag} one`;
    assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name: a, body: `${tag} a1` })).status, 201); assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name: b, body: `${tag} b1` })).status, 201);
    for (const n of [2, 3]) assert.equal((await api(base, 'POST', '/api/procedure-versions', { by: 'gizmo', procedure: a, body: `${tag} a${n}` })).status, 201);
    const an = await versionNames(base, a); const bn = await versionNames(base, b);
    assert.deepEqual(an.map(num), [1, 2, 3], `the three-version procedure ascends (${an.join(' | ')})`); assert.deepEqual(bn.map(num), [1], 'the one-version procedure lists exactly its one version');
  });
});

test('PO4 A MIGRATED PROCEDURE KEEPS THE FILE\'S ORDER: created through a unit-off server, migrated into the graph, served by a unit-on server: oldest-first', { skip: SKIP, timeout: 400000 }, async () => {
  const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url))); const script0 = path.join(REPO, 'scripts', 'migrate-collections-1624.mjs'); assert.ok(fs.existsSync(script0), 'the migrate script exists in this checkout');
  const tag = ALNUM(); const name = `${tag} method`; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po4-')); const file = path.join(dir, 'board.json');
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    assert.equal((await api(off.baseUrl, 'POST', '/api/procedures', { by: 'ada', name, body: `${tag} v1 text` })).status, 201, 'CONTROL: created');
    for (const n of [2, 3, 4]) assert.equal((await api(off.baseUrl, 'POST', '/api/procedure-versions', { by: 'gizmo', procedure: name, body: `${tag} revision ${n}` })).status, 201, `CONTROL: revision ${n}`);
    const fileOrder = await versionNames(off.baseUrl, name); assert.deepEqual(fileOrder.map(num), [1, 2, 3, 4], `CONTROL: the document path lists v1..v4 oldest-first (${fileOrder.join(' | ')})`);
    off.kill(); await new Promise((r) => setTimeout(r, 500)); fs.copyFileSync(off.boardFile, file);
  } finally { await off.stop(); }
  const exec = await startExecutor({ store: tmpStore('po4-'), datasetId: 'po4', create: true });
  try {
    const m = spawnSync(process.execPath, [script0, '--board-data', file, '--executor', exec.baseUrl, '--dataset', 'po4', '--apply'], { encoding: 'utf8', timeout: 180000, env: { ...process.env, SCRUM_EVENT_LOG_DIR: path.join(dir, 'events') } });
    assert.match(m.stdout, /COMPLETE/, `CONTROL: the migration completes (${m.stdout.slice(-300)} ${m.stderr.slice(-200)})`);
    fs.writeFileSync(path.join(dir, 'unit-board.json'), JSON.stringify({ '@context': {}, '@graph': [] }));
    const on = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'po4', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
    try { const names = await versionNames(on.baseUrl, name); assert.deepEqual(names.map(num), [1, 2, 3, 4], `the MIGRATED procedure's versions list oldest-first, as the file's did (got ${names.join(' | ')})`); } finally { await on.stop(); }
  } finally { await killExecutor(exec); }
});
