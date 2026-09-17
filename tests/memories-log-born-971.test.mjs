/**
 * #971 slice 2 — MEMORIES ARE BORN IN THE EVENT LOG and read from the graph;
 * board-data.json receives no row for them. The second D3 migration (after
 * seat state #1143 and decisions #1147) and the first with a MUTABLE identity.
 *
 * The three non-waivable gates the card names, each a test here:
 *   gate 1  failure coupling — no graph dependency ⇒ 503 GRAPH_DEPS_MISSING on
 *           every memory route, never an empty list dressed as "none".
 *   gate 2  write-path honesty at the REAL consuming surface — the resident
 *           runner's own REMEMBER: line (scripts/guest-once.mjs against a fake
 *           model) is saved through POST /api/memories and handed back by its
 *           own wake-time read, with the id ABSENT from board-data.json by grep
 *           (the PO's control), and retrievable by tag by a caller who did not
 *           write it (the card's negative control).
 *   gate 3  the projection floor — passed on #1369; measured, not tested here.
 * Plus: the record is DURABLE — a cold restart on the same board file replays
 * the log and the memory is there with every version; migration BY TOUCH — a
 * memory an older document still carries loses its rows on its first write and
 * the graph holds ONE title, not two; #1287's relatedTo edge through the graph
 * for a log-born memory; scrum:priority p0–p3 refused outside the four values.
 *
 * Sabotage profiles (distinct lines): create not projected ⇒ "handed back by
 * its own wake read"; update without the delete ⇒ "ONE title, not two"; touch
 * without dropping rows ⇒ "no rows left in the document"; list from the
 * document ⇒ "absent from the list"; priority unvalidated ⇒ "p9 refused".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer, freePort } from './helpers/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEATS = { ada: { name: 'Ada', color: '#7cc4a0' }, pip: { name: 'Pip', color: '#c47c7c' } };
const api = async (base, method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const graph = async (base, query) => (await api(base, 'POST', '/api/graph', { query })).body;

function fakeOllama(reply) {
  const prompts = [];   // every request body the model was handed — the instrument for "did the wake carry the memory"
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { prompts.push(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${srv.address().port}`, prompts, stop: () => new Promise((r) => srv.close(r)) })));
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts/guest-once.mjs'), '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#971 gate 2 — the resident runner REMEMBERs through the real save path; its own wake read hands the memory back; the document holds no row for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-971-'));
  const rosterFile = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS }));
  const ollama = await fakeOllama('Noted, the meter lands first.\nREMEMBER: the store meter is the sprint\'s first pull');
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_ROSTER_FILE: rosterFile } });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are Pip.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'resident', contextPolicy: 'artifact-only', deliveryMode: 'channel', by: 'ada' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const post = await api(s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip what lands first this sprint?' });
    assert.equal(post.status, 201);
    const offer = await api(s.baseUrl, 'POST', '/api/deliveries', { to: 'pip', conversation: post.body.id, source: 'fanout', by: 'board' });
    assert.equal(offer.status, 201, JSON.stringify(offer.body));
    const stateFile = path.join(dir, 'pip.state.json');
    const r1 = await runOnce({ SCRUM_BOARD_URL: s.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, 'pip');
    assert.equal(r1.code, 0, r1.err + r1.out);

    // the runner's OWN wake-time read shape (owner filter, agent-memory tag)
    const mine = await api(s.baseUrl, 'GET', '/api/memories?owner=pip&limit=50');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const kept = mine.body.memories.filter((m) => m.tags.includes('agent-memory'));
    assert.equal(kept.length, 1, `handed back by its own wake read: ${JSON.stringify(mine.body)}`);
    assert.equal(kept[0].body, 'the store meter is the sprint\'s first pull');
    assert.equal(kept[0].owner, 'pip');
    assert.equal(mine.body.legacyRows, 0, 'the document carries no memory rows at all');

    // the PO's control: absent from board-data.json by grep
    // ⚠️ Grep for the memory's IRI and its version's, not the bare uuid: the
    // runner's ledger row (#1240 provenance, a scrum:ModelCall in the document)
    // names the memory it wrote BY ID — that is a reference, not a row.
    const raw = fs.readFileSync(s.boardFile, 'utf8');
    assert.ok(!raw.includes(`scrumboard.local/memory/${kept[0].id}`), 'the memory IRI is ABSENT from board-data.json');
    assert.ok(!raw.includes('"scrum:Memory"') && !raw.includes('"scrum:MemoryVersion"'), 'no memory-typed row anywhere in the document');
    const doc = JSON.parse(raw);
    assert.ok(!(doc['@graph'] || []).some((e) => e['scrum:body'] === 'the store meter is the sprint\'s first pull'), 'the text lives on no document row');
    // …and present in the graph as the node the card describes, body one hop away
    const g = await graph(s.baseUrl, `SELECT ?body WHERE { <https://scrumboard.local/memory/${kept[0].id}> scrum:currentVersion ?v . ?v scrum:body ?body }`);
    assert.equal(g.rows?.length, 1, JSON.stringify(g));
    assert.equal(g.rows[0].body, 'the store meter is the sprint\'s first pull');

    // the card's negative control: retrieved by a caller who did not write it, by the collection (tag)
    const byTag = await api(s.baseUrl, 'GET', '/api/memories?tag=agent-memory');
    assert.ok(byTag.body.memories.some((m) => m.id === kept[0].id), 'a stranger finds it by tag');

    // and the runner reads it back on its NEXT wake — the same surface, second time
    const post2 = await api(s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip and after that?' });
    await api(s.baseUrl, 'POST', '/api/deliveries', { to: 'pip', conversation: post2.body.id, source: 'fanout', by: 'board' });
    const r2 = await runOnce({ SCRUM_BOARD_URL: s.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, 'pip');
    assert.equal(r2.code, 0, r2.err + r2.out);
    assert.equal(ollama.prompts.length, 2, 'two wakes, two model calls');
    assert.ok(!ollama.prompts[0].includes('the store meter is the sprint'), 'control: the FIRST wake could not have carried a memory that did not exist yet');
    assert.ok(ollama.prompts[1].includes('the store meter is the sprint'), `the second wake's prompt carried the memory read from the graph: ${ollama.prompts[1].slice(0, 400)}`);
  } finally { await s.stop(); await ollama.stop(); }
});

test('#971 durable — a cold restart on the same board file replays the log: the memory and both its versions are there', async () => {
  const s1 = await startRestServer({ board: makeBoardFixture({ cards: [] }) });
  let id, boardFile;
  try {
    boardFile = s1.boardFile;
    const c = await api(s1.baseUrl, 'POST', '/api/memories', { owner: 'ada', title: 'durable', body: 'v1 text', tags: ['t'] });
    assert.equal(c.status, 201, JSON.stringify(c.body)); id = c.body.id;
    const u = await api(s1.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: ' + more', title: 'durable, retitled', by: 'ada' });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.version, 2); assert.equal(u.body.body, 'v1 text + more'); assert.equal(u.body.title, 'durable, retitled');
  } finally { await s1.stop(); }
  const s2 = await startRestServer({ boardFile });
  try {
    const g = await api(s2.baseUrl, 'GET', `/api/memories/${id}`);
    assert.equal(g.status, 200, `after a cold restart the memory is read from the replayed log: ${JSON.stringify(g.body)}`);
    assert.equal(g.body.title, 'durable, retitled');
    assert.equal(g.body.version, 2);
    const v = await api(s2.baseUrl, 'GET', `/api/memories/${id}/versions`);
    assert.deepEqual(v.body.versions.map((x) => [x.version, x.body]), [[1, 'v1 text'], [2, 'v1 text + more']], 'every version survived the restart');
    const names = await graph(s2.baseUrl, `SELECT ?n WHERE { <https://scrumboard.local/memory/${id}> schema:name ?n }`);
    assert.equal(names.rows.length, 1, `ONE title, not two: ${JSON.stringify(names.rows)}`);
  } finally { await s2.stop(); }
});

test('#971 migration by touch — a memory an older document still carries loses its rows on its first write; the graph holds ONE title and every version', async () => {
  const iri = 'https://scrumboard.local/memory/00000000-0000-4000-8000-000000000971';
  const board = makeBoardFixture({ cards: [], memories: [
    { '@id': iri, '@type': 'scrum:Memory', identifier: '00000000-0000-4000-8000-000000000971', name: 'old title', 'scrum:owner': 'ada', 'scrum:tag': ['legacy'], 'scrum:currentVersion': `${iri}/v1` },
    { '@id': `${iri}/v1`, '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': iri, 'scrum:version': 1, 'scrum:body': 'from the document', author: 'ada', dateCreated: '2026-09-01T00:00:00.000Z' },
  ] });
  const s = await startRestServer({ board });
  try {
    const before = await api(s.baseUrl, 'GET', '/api/memories');
    assert.equal(before.body.legacyRows, 2, 'control: the document-born memory is counted as legacy rows');
    assert.equal(before.body.memories[0].title, 'old title', 'and read from the graph, projected from the document');

    const u = await api(s.baseUrl, 'PATCH', `/api/memories/00000000-0000-4000-8000-000000000971`, { title: 'new title', priority: 'p1', by: 'ada' });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.title, 'new title'); assert.equal(u.body.priority, 'p1'); assert.equal(u.body.version, 1, 'a retitle mints no version');

    const raw = s.readBoardFile();
    assert.equal((raw['@graph'] || []).filter((e) => /Memory/.test(e['@type'] || '')).length, 0, 'no rows left in the document — migrated by touch');
    const names = await graph(s.baseUrl, `SELECT ?n WHERE { <${iri}> schema:name ?n }`);
    assert.deepEqual(names.rows.map((r) => r.n), ['new title'], `ONE title, not two: ${JSON.stringify(names.rows)}`);
    const v = await api(s.baseUrl, 'GET', `/api/memories/00000000-0000-4000-8000-000000000971/versions`);
    assert.deepEqual(v.body.versions.map((x) => x.body), ['from the document'], 'the document-born version rode the event into the graph');
    assert.equal((await api(s.baseUrl, 'GET', '/api/memories')).body.legacyRows, 0);
  } finally { await s.stop(); }
});

test('#971 #1287 through the graph — relatedTo between a log-born memory and a document-born one; priority refused outside p0–p3', async () => {
  const iri = 'https://scrumboard.local/memory/00000000-0000-4000-8000-000000000972';
  const board = makeBoardFixture({ cards: [], memories: [
    { '@id': iri, '@type': 'scrum:Memory', identifier: '00000000-0000-4000-8000-000000000972', name: 'doc-born', 'scrum:owner': 'ada', 'scrum:currentVersion': `${iri}/v1` },
    { '@id': `${iri}/v1`, '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': iri, 'scrum:version': 1, 'scrum:body': 'x', author: 'ada', dateCreated: '2026-09-01T00:00:00.000Z' },
  ] });
  const s = await startRestServer({ board });
  try {
    const reg = await api(s.baseUrl, 'POST', '/api/predicates', { name: 'scrum:relatedTo', definition: 'SEE ALSO, and nothing more. Symmetric by construction.', by: 'ada' });
    assert.ok(reg.status === 201 || reg.status === 200, JSON.stringify(reg.body));
    const bad = await api(s.baseUrl, 'POST', '/api/memories', { owner: 'ada', title: 'p', body: 'b', priority: 'p9' });
    assert.equal(bad.status, 400, 'p9 refused');
    const c = await api(s.baseUrl, 'POST', '/api/memories', { owner: 'ada', title: 'log-born', body: 'y', priority: 'p0' });
    assert.equal(c.status, 201, JSON.stringify(c.body)); assert.equal(c.body.priority, 'p0');
    const a = await api(s.baseUrl, 'POST', '/api/assert', { by: 'ada', assertions: [{ subject: `https://scrumboard.local/memory/${c.body.id}`, predicate: 'scrum:relatedTo', object: iri }] });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const edges = await graph(s.baseUrl, `SELECT ?a ?b WHERE { ?a scrum:relatedTo ?b . ?a a scrum:Memory }`);
    assert.equal(edges.rows.length, 2, `symmetric, both memories: ${JSON.stringify(edges.rows)}`);
    assert.equal((await api(s.baseUrl, 'GET', '/api/memories')).body.legacyRows, 0, 'the document-born memory was migrated by the touch');
    const un = await api(s.baseUrl, 'PATCH', `/api/memories/${c.body.id}`, { priority: null, by: 'ada' });
    assert.equal(un.body.priority, undefined, 'null unsets');
    const list = await api(s.baseUrl, 'GET', '/api/memories');
    assert.ok(list.body.memories.some((m) => m.id === c.body.id), 'the log-born memory is in the list');
  } finally { await s.stop(); }
});

test('#971 gate 1 — no graph dependency ⇒ 503 GRAPH_DEPS_MISSING on the memory routes, never an empty list', async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-971-nograph-'));
  const env = { ...process.env, SCRUM_PORT: String(port), SCRUM_BOARD_FILE: path.join(dir, 'board-data.json'), SCRUM_MCP_NOTIFY_URL: '' };
  delete env.SCRUM_BOARD_API; delete env.MCP_PORT;
  const child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests/fixtures/hide-oxigraph-register.mjs'), 'server.js'], { cwd: ROOT, env });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('server running')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (const [m, p] of [['GET', '/api/memories'], ['GET', '/api/memories/x'], ['GET', '/api/memories/x/versions']]) {
      const r = await api(base, m, p);
      assert.equal(r.status, 503, `${m} ${p}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'GRAPH_DEPS_MISSING');
    }
    // A CREATE needs no graph: it appends to the log, which is the record, and
    // the board says so the moment anyone tries to read it back (503 above).
    // Unlike a seat declaration (#1143), which must read the prior state, a
    // birth reads nothing — refusing it would lose a memory to protect a read.
    const w = await api(base, 'POST', '/api/memories', { owner: 'ada', title: 't', body: 'b' });
    assert.equal(w.status, 201, 'the write lands in the log even when the graph cannot be read');
    const u = await api(base, 'PATCH', `/api/memories/${w.body.id}`, { body: 'c', by: 'ada' });
    assert.equal(u.status, 503, `an UPDATE reads the current state from the graph, so it is refused: ${JSON.stringify(u.body)}`);
  } finally { child.kill(); }
});
