/**
 * #1624 K13 — THE MIGRATION AND THE RETIREMENT OF THE SMALL-KIND COLLECTIONS, as the test author's independent rows. The build owner's blocker on the first retire script (review 13:20Z): it accepted a graph copy that differed from the file's whenever the graph was newer and ANY receipt existed for the import, which also
 * accepts a FAILED import and does not bind the receipt to the file's content, so a file-only edit could be discarded. The builder fixed it and added three rows on talks (RL1-RL3). These rows are mine and go further: they run over SEVERAL families, not talks alone, over a board file written by a REAL unit-off server through its
 * own REST routes (so the file's shapes are the server's, not a fixture's), against a REAL executor, with scratch files and a scratch store only. Nothing touches the live board, its file or its executor.
 *
 *   MR0  THE MIGRATION: a dry run writes nothing (the graph holds none afterwards); `--apply` prints COMPLETE and every family's entities are in the graph, the renamed tending prompt under its NEW slug and no entity under the old one; a second `--apply` writes nothing new and still prints COMPLETE.
 *   MR1  RETIRE BEFORE MIGRATE REFUSES: with the graph empty `retire` exits non-zero, names entities as NOT HELD, and the file is byte-identical.
 *   MR2  RETIRE AFTER MIGRATE: a dry run reports every entity verified and writes nothing; `--apply` removes exactly the family nodes, keeps every other node as it was, appends exactly ONE board-meta event naming the retirement, and a second `--apply` is a no-op (file byte-identical, no second event).
 *   MR3  A FILE EDIT AFTER THE IMPORT IS REFUSED, in more than one family: for a model, a predicate and a tending prompt in turn, the graph moves on (a version 2 through the unit) AND the file's copy is edited afterwards: retire refuses, names the entity, and the file is byte-identical. (The first retire script accepted this.)
 *   MR4  A FAILED IMPORT IS NOT LINEAGE: the graph already holds the model under its key with DIFFERENT content; the migration refuses it (INCOMPLETE, never overwritten); the graph copy is then edited (newer); retire refuses and the file is byte-identical.
 *   MR5  A LEGITIMATE GRAPH EDIT IS ACCEPTED, in more than one family: after the import the graph moves on for a model, a predicate and a tending prompt (the file untouched): retire accepts and the file's copies go.
 *   MR6  ONE REFUSED ENTITY HOLDS EVERYTHING BACK: with one stale file edit among many held entities, nothing at all is removed (the file is byte-identical), not even the entities that were fine.
 *
 * NOT COVERED, by name: roles and obligations (their card references need the real cards in the graph; the reference guard has its own rows) and talks beyond the builder's RL rows; wakes (their own `entity.put` path); the decision copies (graph authority since #1561, compared by presence only); the live data (the read-back
 * `readback-collections.mjs` is for that); a crash between two writes of the migration; concurrent writers while a retire runs (it is run with REST stopped); the cold boot after a retire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createCollectionsUnit } from '../core/collections-unit.mjs';
import { collectionFamilies } from '../core/collection-families.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DS = 'mr-test';
const ROSTER_FILE = path.join(os.tmpdir(), `mr1624-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const api = async (base, method, route, body) => { const r = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not json */ } return { status: r.status, body: j, text: t }; };
const sha = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0)).toString('base64');
const run = (script, file, x, extra = []) => spawnSync(process.execPath, [path.join(REPO, 'scripts', script), '--board-data', file, '--executor', x.baseUrl, '--dataset', DS, ...extra], { encoding: 'utf8', env: { ...process.env, SCRUM_EVENT_LOG_DIR: path.join(path.dirname(file), 'events') }, timeout: 180000 });
const events = (file) => { const d = path.join(path.dirname(file), 'events'); try { return fs.readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(d, String(f)), 'utf8')).join('\n').split('\n').filter(Boolean); } catch { return []; } };
const retireEvents = (file) => events(file).filter((l) => /small-kind-collections/.test(l)).length;

const unitFor = (x) => createCollectionsUnit({ client: createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DS, timeoutMs: 30000 }), families: collectionFamilies({ cardsUnit: false }), mintId: () => `mr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
async function graphState(x) { const u = unitFor(x); await u.load(); return u.snapshot(); }
async function graphEdit(x, collection, match, mutate) {
  const u = unitFor(x); await u.load(); const data = u.snapshot(); const e = (data[collection] ?? []).find(match); assert.ok(e, `the entity to edit is in the graph's ${collection}`); mutate(e);
  const r = await u.commit(data, { actor: 'ada' }); assert.equal(r.outcome, 'APPLIED', `CONTROL: the graph edit lands (${JSON.stringify(r).slice(0, 160)})`); return e;
}

/** a board FILE written by a real unit-off server, through its own routes: a model, a predicate, a procedure with a revision, and two tending prompts (one later given the pre-validation slug "scrum board-clarity", as in the live file) */
async function writeFile(dir, tag) {
  const s = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const ok = async (r, what) => assert.ok(r.status < 300, `${what} (${r.status} ${r.text.slice(0, 140)})`);
    await ok(await api(s.baseUrl, 'POST', '/api/models', { by: 'ada', key: `mr-${tag}`, model: `${tag}-model:1b`, protocol: 'ollama-native', costIn: 0.5, costOut: 1.5 }), 'a model is created');
    await ok(await api(s.baseUrl, 'POST', '/api/predicates', { by: 'ada', name: `scrum:mr${tag}`, definition: `${tag} a predicate registered by the migration rows to have something to migrate` }), 'a predicate is registered');
    await ok(await api(s.baseUrl, 'POST', '/api/procedures', { by: 'ada', name: `${tag} method`, body: `${tag} v1 text` }), 'a procedure is created');
    await ok(await api(s.baseUrl, 'POST', '/api/procedure-versions', { by: 'gizmo', procedure: `${tag} method`, body: `${tag} revised text` }), 'a procedure is revised');
    await ok(await api(s.baseUrl, 'POST', '/api/tending/whispers', { slug: `mr-${tag}-a`, body: `${tag} first whisper`, by: 'ada' }), 'a whisper is created');
    await ok(await api(s.baseUrl, 'POST', '/api/tending/whispers', { slug: `scrum-board-clarity`, body: `${tag} the whisper that will carry a space in its slug`, by: 'ada' }), 'a second whisper is created');
    s.kill();
    await new Promise((r) => setTimeout(r, 500));
    let text = fs.readFileSync(s.boardFile, 'utf8'); text = text.split('scrum-board-clarity').join('scrum board-clarity');   // the live file's one pre-validation slug
    const file = path.join(dir, 'board.json'); fs.writeFileSync(file, text); return file;
  } finally { await s.stop(); }
}
async function world(body) {
  const x = await startExecutor({ store: tmpStore('mr-'), datasetId: DS, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr1624-'));
  try { return await body({ x, dir, tag: ALNUM() }); } finally { await killExecutor(x); }
}
const nodeCount = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'].length;
const migrated = async (x, dir, tag) => { const file = await writeFile(dir, tag); const m = run('migrate-collections-1624.mjs', file, x, ['--apply']); assert.match(m.stdout, /COMPLETE/, `CONTROL: the migration completes (${m.stdout.slice(-400)} ${m.stderr.slice(-300)})`); return file; };
const editFile = (file, from, to) => { const t = fs.readFileSync(file, 'utf8'); assert.ok(t.includes(from), `the file contains "${from}" to edit`); fs.writeFileSync(file, t.split(from).join(to)); };

test('MR0 THE MIGRATION: dry run writes nothing; --apply is COMPLETE with the renamed prompt under its new slug; a second --apply writes nothing new', { skip: SKIP, timeout: 400000 }, async () => {
  await world(async ({ x, dir, tag }) => {
    const file = await writeFile(dir, tag); const before = await graphState(x);
    assert.ok(Object.values(before).every((v) => !Array.isArray(v) || v.length === 0), 'PRECONDITION: the graph holds nothing');
    const dry = run('migrate-collections-1624.mjs', file, x); assert.equal(dry.status, 0, `a dry run exits 0 (${dry.stderr.slice(-200)})`);
    const afterDry = await graphState(x); assert.ok(Object.values(afterDry).every((v) => !Array.isArray(v) || v.length === 0), 'a dry run wrote NOTHING to the graph');
    const m = run('migrate-collections-1624.mjs', file, x, ['--apply']); assert.match(m.stdout, /COMPLETE/, `--apply is COMPLETE (${m.stdout.slice(-300)})`); assert.equal(m.status, 0, 'and exits 0');
    const g = await graphState(x); const all = JSON.stringify(g);
    for (const needle of [`mr-${tag}`, `scrum:mr${tag}`, `${tag} method`, `${tag} revised text`, `mr-${tag}-a`]) assert.ok(all.includes(needle), `the graph holds ${needle}`);
    assert.ok(all.includes('scrum-board-clarity'), 'the renamed prompt is held under its NEW slug'); assert.equal(all.includes('scrum board-clarity'), false, 'and nothing is held under the OLD slug');
    const again = run('migrate-collections-1624.mjs', file, x, ['--apply']); assert.match(again.stdout, /COMPLETE/, 'a second --apply is still COMPLETE'); assert.equal(JSON.stringify(await graphState(x)), all, 'and the graph is exactly as it was: nothing was written twice');
  });
});

test('MR1 RETIRE BEFORE MIGRATE REFUSES: nothing held, the file is byte-identical', { skip: SKIP, timeout: 300000 }, async () => {
  await world(async ({ x, dir, tag }) => {
    const file = await writeFile(dir, tag); const before = sha(file); const r = run('retire-collections-1624.mjs', file, x, ['--apply']);
    assert.notEqual(r.status, 0, `retire exits non-zero with an empty graph (${r.stdout.slice(-300)})`); assert.match(r.stdout, /NOT HELD/, 'and names entities as NOT HELD'); assert.equal(sha(file), before, 'and the file is byte-identical');
  });
});

test('MR2 RETIRE AFTER MIGRATE: dry run writes nothing; --apply removes exactly the family nodes, keeps the rest, appends ONE event; a second --apply is a no-op', { skip: SKIP, timeout: 400000 }, async () => {
  await world(async ({ x, dir, tag }) => {
    const file = await migrated(x, dir, tag); const before = sha(file); const nodesBefore = nodeCount(file);
    const dry = run('retire-collections-1624.mjs', file, x); assert.equal(dry.status, 0, `a dry run exits 0 (${dry.stdout.slice(-300)})`); assert.equal(sha(file), before, 'a dry run leaves the file byte-identical'); assert.equal(retireEvents(file), 0, 'and appends no event');
    const doc0 = JSON.parse(fs.readFileSync(file, 'utf8'))['@graph']; const r = run('retire-collections-1624.mjs', file, x, ['--apply']); assert.equal(r.status, 0, `--apply exits 0 (${r.stdout.slice(-300)} ${r.stderr.slice(-200)})`); assert.match(r.stdout, /REMOVED \d+ small-kind entities/, 'it reports what it removed');
    const doc1 = JSON.parse(fs.readFileSync(file, 'utf8'))['@graph']; const removed = Number(/REMOVED (\d+)/.exec(r.stdout)[1]);
    assert.equal(doc1.length, nodesBefore - removed, `the file lost exactly the removed count (${nodesBefore} -> ${doc1.length}, removed ${removed})`); assert.ok(removed >= 6, `at least the six entities written by this world left (${removed})`);
    const kept = new Set(doc1.map((n) => n['@id'])); for (const n of doc0) if (kept.has(n['@id'])) assert.equal(JSON.stringify(doc1.find((m) => m['@id'] === n['@id'])), JSON.stringify(n), `a kept node is byte-for-byte as it was: ${n['@id']}`);
    assert.equal(doc1.some((n) => /scrum:(Model|Predicate|Procedure|TendingPrompt)/.test(String(n['@type']))), false, 'no migrated family node is left in the file'); assert.equal(retireEvents(file), 1, 'exactly ONE retirement event was appended');
    const after = sha(file); const again = run('retire-collections-1624.mjs', file, x, ['--apply']); assert.equal(again.status, 0, 'a second --apply exits 0'); assert.equal(sha(file), after, 'and leaves the file byte-identical'); assert.equal(retireEvents(file), 1, 'and appends no second event');
  });
});

for (const [label, collection, match, mutateGraph, fileFrom, fileTo] of [
  ['a model', 'models', (e) => String(e['@id']).includes('/model/'), (e) => { e['scrum:costIn'] = 9; }, '"scrum:costIn": 0.5', '"scrum:costIn": 3'],
  ['a predicate', 'predicates', (e) => String(e.name ?? e['@id']).includes('mr'), (e) => { e['scrum:definition'] = 'edited in the graph after the import'; }, null, null],
  ['a tending prompt', 'tending', (e) => String(e['scrum:body'] ?? '').includes('first whisper'), (e) => { e['scrum:body'] = 'edited in the graph after the import'; }, null, null],
]) {
  test(`MR3 (${label}) A FILE EDIT AFTER THE IMPORT IS REFUSED: the graph moved on AND the file's copy was edited afterwards: retire refuses and the file is byte-identical`, { skip: SKIP, timeout: 400000 }, async () => {
    await world(async ({ x, dir, tag }) => {
      const file = await migrated(x, dir, tag); const g = await graphState(x); const candidate = (g[collection] ?? []).find(match); assert.ok(candidate, `CONTROL: the graph holds ${label}`);
      const fileText = fs.readFileSync(file, 'utf8'); let from = fileFrom; let to = fileTo;
      if (!from) { const key = Object.keys(candidate).find((k) => typeof candidate[k] === 'string' && /first whisper|registered by the migration rows|definition/.test(candidate[k])); from = String(candidate[key]); to = `${from} (edited in the FILE afterwards)`; }
      if (!fileText.includes(from)) { assert.fail(`CONTROL: the file's copy of ${label} contains "${from.slice(0, 60)}" to edit (the file shape is not what the row assumed)`); }
      await graphEdit(x, collection, match, mutateGraph); editFile(file, from, to);
      const before = sha(file); const r = run('retire-collections-1624.mjs', file, x, ['--apply']);
      assert.notEqual(r.status, 0, `retire REFUSES a file-only edit after the import for ${label} (${r.stdout.slice(-300)})`); assert.match(r.stdout, /NOT HELD/, 'and names what is not held'); assert.equal(sha(file), before, 'and the file is byte-identical: the edit was not discarded');
    });
  });
}

test('MR4 A FAILED IMPORT IS NOT LINEAGE: the graph already holds the model with other content; the migration refuses it; after a graph edit retire still refuses', { skip: SKIP, timeout: 400000 }, async () => {
  await world(async ({ x, dir, tag }) => {
    const file = await writeFile(dir, tag); const pre = await graphState(x);
    // put a DIFFERENT model under the same key into the graph first, through the unit (as a REST create would)
    const u = unitFor(x); await u.load(); const data = u.snapshot(); const fileModel = JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'].find((n) => String(n['@id']).includes(`/model/`) && JSON.stringify(n).includes(`mr-${tag}`));
    assert.ok(fileModel, 'CONTROL: the file holds the model'); assert.ok(Array.isArray(data.models), 'CONTROL: the unit has a models collection'); const rival = { ...fileModel, 'scrum:costIn': '77' }; data.models = [...(data.models ?? []), rival];
    const seeded = await u.commit(data, { actor: 'ada' }); assert.equal(seeded.outcome, 'APPLIED', `CONTROL: the rival model is in the graph (${JSON.stringify(seeded).slice(0, 160)})`);
    const m = run('migrate-collections-1624.mjs', file, x, ['--apply']); assert.notEqual(m.status, 0, `the migration is INCOMPLETE (a different model already holds the key): exit ${m.status}`); assert.match(m.stdout, /INCOMPLETE|DIFFERENT|REFUSED/, `and says why (${m.stdout.slice(-300)})`);
    await graphEdit(x, 'models', (e) => String(e['@id']).includes('/model/'), (e) => { e['scrum:costIn'] = '78'; });
    const before = sha(file); const r = run('retire-collections-1624.mjs', file, x, ['--apply']);
    assert.notEqual(r.status, 0, `retire REFUSES: a failed import is not lineage (${r.stdout.slice(-300)})`); assert.equal(sha(file), before, 'and the file is byte-identical'); void pre;
  });
});

for (const [label, collection, match, mutate] of [
  ['a model', 'models', (e) => String(e['@id']).includes('/model/'), (e) => { e['scrum:costIn'] = 9; }],
  ['a tending prompt', 'tending', (e) => String(e['scrum:body'] ?? '').includes('first whisper'), (e) => { e['scrum:body'] = 'edited in the graph after the import'; }],
]) {
  test(`MR5 (${label}) A LEGITIMATE GRAPH EDIT IS ACCEPTED: the graph moved on from the imported content and the file is untouched: retire accepts`, { skip: SKIP, timeout: 400000 }, async () => {
    await world(async ({ x, dir, tag }) => {
      const file = await migrated(x, dir, tag); await graphEdit(x, collection, match, mutate);
      const r = run('retire-collections-1624.mjs', file, x, ['--apply']); assert.equal(r.status, 0, `retire ACCEPTS a graph that moved on from this exact import (${r.stdout.slice(-300)} ${r.stderr.slice(-200)})`); assert.match(r.stdout, /REMOVED \d+ small-kind entities/, 'and removes the file copies');
    });
  });
}

test('MR6 ONE REFUSED ENTITY HOLDS EVERYTHING BACK: a single stale file edit among many held entities: nothing at all is removed', { skip: SKIP, timeout: 400000 }, async () => {
  await world(async ({ x, dir, tag }) => {
    const file = await migrated(x, dir, tag); await graphEdit(x, 'models', (e) => String(e['@id']).includes('/model/'), (e) => { e['scrum:costIn'] = 9; }); editFile(file, '"scrum:costIn": 0.5', '"scrum:costIn": 3');
    const before = sha(file); const nodes = nodeCount(file); const r = run('retire-collections-1624.mjs', file, x, ['--apply']);
    assert.notEqual(r.status, 0, 'retire refuses'); assert.equal(sha(file), before, 'the file is byte-identical'); assert.equal(nodeCount(file), nodes, 'not one node left the file, including the entities that were held'); assert.equal(retireEvents(file), 0, 'and no retirement event was appended');
  });
});
