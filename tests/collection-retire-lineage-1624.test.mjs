/**
 * #1624 (review 13:20Z) — the retire step accepts a graph copy that DIFFERS from the file's only when the graph moved on
 * FROM THIS EXACT CONTENT: newer in the graph AND an APPLIED receipt for the import of exactly the file's copy. Builder's
 * rows, real executor, scratch board files only:
 *   RL1 a legitimate graph edit after the import (version 2 through the unit): the file's copy is stale and retire ACCEPTS.
 *   RL2 the file's copy edited after the import (a file-only edit): retire REFUSES and writes nothing.
 *   RL3 the import itself FAILED (the graph already held the entity with other content: PRECONDITION_FAILED receipt),
 *       then the graph moved on: retire REFUSES. A failed receipt is not lineage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { makeBoardFixture } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createCollectionsUnit } from '../core/collections-unit.mjs';
import { collectionFamilies } from '../core/collection-families.mjs';
import { boardToDomain } from '../core/mapping.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const talk = (id, name) => ({ '@id': `https://scrumboard.local/talk/${id}`, '@type': 'scrum:Talk', name, 'scrum:with': 'ada', creator: 'ada', dateCreated: '2026-10-01T00:00:00.000Z' });

function writeBoard(dir, talks) {
  const board = makeBoardFixture(); board.talks = talks;
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(domainToJsonLd(boardToDomain(board)), null, 2));
  return file;
}
const run = (script, file, x, extra = []) => spawnSync(process.execPath, [path.join(REPO, 'scripts', script), '--board-data', file, '--executor', x.baseUrl, '--dataset', 'rl-test', ...extra],
  { encoding: 'utf8', env: { ...process.env, SCRUM_EVENT_LOG_DIR: path.join(path.dirname(file), 'events') }, timeout: 120000 });
async function graphEdit(x, id, name) {
  const unit = createCollectionsUnit({ client: createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'rl-test', timeoutMs: 30000 }), families: collectionFamilies({ cardsUnit: false }), mintId: () => `rl-${Date.now()}` });
  await unit.load();
  const data = unit.snapshot();
  const t = data.talks.find((e) => e['@id'] === `https://scrumboard.local/talk/${id}`);
  t.name = name;
  return unit.commit(data, { actor: 'ada' });
}
async function world(body) {
  const x = await startExecutor({ store: tmpStore('rl-'), datasetId: 'rl-test', create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl1624-'));
  try { return await body({ x, dir }); } finally { await killExecutor(x); }
}

test('RL1 a graph edit after the import: the file copy is stale, retire accepts', { skip: SKIP, timeout: 300000 }, async () => {
  await world(async ({ x, dir }) => {
    const file = writeBoard(dir, [talk('t1', 'first')]);
    const m = run('migrate-collections-1624.mjs', file, x, ['--apply']);
    assert.match(m.stdout, /COMPLETE/, `the migration completes (${m.stdout.slice(-300)} ${m.stderr.slice(-300)})`);
    assert.equal((await graphEdit(x, 't1', 'edited in the graph')).outcome, 'APPLIED', 'CONTROL: the graph edit lands (version 2)');
    const r = run('retire-collections-1624.mjs', file, x);
    assert.equal(r.status, 0, `retire accepts a graph that moved on from this exact import (${r.stdout.slice(-400)})`);
    assert.match(r.stdout, /1 of 1 verified/);
  });
});

test('RL2 the file copy edited after the import: retire refuses and writes nothing', { skip: SKIP, timeout: 300000 }, async () => {
  await world(async ({ x, dir }) => {
    const file = writeBoard(dir, [talk('t2', 'first')]);
    assert.match(run('migrate-collections-1624.mjs', file, x, ['--apply']).stdout, /COMPLETE/);
    assert.equal((await graphEdit(x, 't2', 'edited in the graph')).outcome, 'APPLIED');
    writeBoard(dir, [talk('t2', 'edited in the FILE only, after the import')]);
    const before = fs.readFileSync(file, 'utf8');
    const r = run('retire-collections-1624.mjs', file, x, ['--apply']);
    assert.equal(r.status, 1, `a file-only edit after the import is refused (${r.stdout.slice(-400)})`);
    assert.match(r.stdout, /not an APPLIED import of this content/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'and the file is untouched');
  });
});

test('RL3 a FAILED import (PRECONDITION_FAILED receipt), then the graph moved on: retire refuses', { skip: SKIP, timeout: 300000 }, async () => {
  await world(async ({ x, dir }) => {
    // The graph already holds t3 with other content, so the migration's create is PRECONDITION_FAILED.
    const pre = writeBoard(dir, [talk('t3', 'graph-born content')]);
    const unit = createCollectionsUnit({ client: createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'rl-test', timeoutMs: 30000 }), families: collectionFamilies({ cardsUnit: false }), mintId: () => 'rl3' });
    await unit.load();
    assert.equal((await unit.commit({ talks: [talk('t3', 'graph-born content')] }, { actor: 'ada' })).outcome, 'APPLIED', 'CONTROL: the graph holds t3 first');
    const file = writeBoard(dir, [talk('t3', 'the file says something else')]);
    assert.equal(file, pre);
    const m = run('migrate-collections-1624.mjs', file, x, ['--apply']);
    assert.match(m.stdout, /"PRECONDITION_FAILED":1/, `the import was refused by the graph (${m.stdout.slice(-300)})`);
    assert.equal((await graphEdit(x, 't3', 'moved on in the graph')).outcome, 'APPLIED', 'CONTROL: the graph moves on (version 2)');
    const r = run('retire-collections-1624.mjs', file, x, ['--apply']);
    assert.equal(r.status, 1, `a failed import is not lineage (${r.stdout.slice(-400)})`);
    assert.match(r.stdout, /not an APPLIED import of this content/);
  });
});
