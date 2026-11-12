/**
 * #1626, THE FILE'S COPY MUST NEVER BEAT THE GRAPH'S ANSWER: "GRAPH WINS BY IDENTITY", AS A DIFFERENTIAL. The reads merge the graph's posts and the document's by identity, and the claim is that a post the graph holds, a tombstone included, replaces any
 * document copy. Written by the separate test author in answer to the review's open item (the claim "needs its differential row before the removal is called green"). The case that matters is a REDACTED post: the graph holds a content-free tombstone
 * and the file still holds the text it carried, because the file was never rewritten. If any surface still reads the file's copy, the text a person asked to have removed is served back. A real executor, real REST servers, the real scripts, synthetic
 * content. Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass.
 *
 *   P7a  WITH THE COPY STILL IN THE FILE: after one post (attached to a card) is redacted in the graph, a server whose file still holds its text serves it from NO surface: the conversation list, the post by id, the card's comments, `/api/changes`, search,
 *        `/api/load` and `/api/board`. A control first: before the redaction every one of the list-shaped surfaces shows the text, so an absence afterwards is not an empty answer.
 *   P7b  AFTER THE REMOVAL: the retire script (which holds a redacted post by its tombstone) removes the file's copies, and the same surfaces still serve the text nowhere, and the file no longer holds it.
 *
 * NOT COVERED, by name: the append-only event log, which keeps the text of the post's original create event (a redaction does not rewrite history; the feed projects it through the tombstone, which is the surface this row reads); a post redacted in the FILE only (there is no such path); attachments of a redacted post; the MCP catch-up and the channel hint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGraphClient } from '../core/graph-client.mjs';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `p1626-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const COMMENT = (n) => n && n['@type'] === 'Comment';
const commentsIn = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'].filter(COMMENT);
const nodesOtherThanComments = (file) => JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'].filter((n) => !COMMENT(n)));
const sha = (file) => fs.readFileSync(file);
const run = (script, args, env = {}) => { const r = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 }); return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }; };
const eventLines = (dir) => { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).flatMap((f) => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []; }); };

/** a unit-off server makes document-born posts (so the file holds real Comment nodes, with the epoch and postSeq the backfill needs); the backfill copies them into a real executor */
async function seed(tag, { backfillLimit = null } = {}) {
  const s0 = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1626-'));
  const file = path.join(dir, 'board.json'); let cards = []; const postIds = [];
  try {
    const mk = async (title) => (await api(s0.baseUrl, 'POST', '/api/cards', { title: `${tag} ${title}`, description: 'x', createdBy: 'ada' })).body;
    cards = [await mk('card one'), await mk('card two')];
    for (let i = 0; i < 9; i++) {
      const body = { author: i % 2 ? 'gizmo' : 'ada', body: `${tag}-post-${i}${i === 4 ? ' @gizmo look' : ''}` };
      if (i === 2 || i === 5) body.attachedTo = cards[0].id;
      const r = await api(s0.baseUrl, 'POST', '/api/conversations', body); assert.equal(r.status, 201, `seed: post ${i} (${r.status} ${r.text.slice(0, 100)})`); postIds.push(r.body.id);
    }
    assert.equal((await api(s0.baseUrl, 'POST', `/api/cards/${cards[1].id}/claim`, { by: 'ada' })).status, 200, 'seed: a claim, which makes the board author a post of its own');
    fs.copyFileSync(s0.boardFile, file);
  } finally { await s0.stop(); }
  const exec = await startExecutor({ store: tmpStore('p1626-store-'), datasetId: 'p1626-test', create: true });
  const out = { dir, file, exec, cards, postIds, datasetId: 'p1626-test', eventsDir: path.join(dir, 'events'), tag, posts: commentsIn(file).length };
  assert.ok(out.posts >= 10, `seed: the file holds the posts (${out.posts})`);
  const bf = run('backfill-posts-r0.mjs', ['--board-file', file, '--executor-url', exec.baseUrl, '--dataset-id', out.datasetId, ...(backfillLimit != null ? ['--limit', String(backfillLimit)] : [])]);
  assert.equal(bf.code, 0, `seed: the backfill completes (exit ${bf.code}) ${bf.out.slice(-300)}`);
  out.backfill = JSON.parse(bf.stdout.trim().split('\n').pop());
  out.stop = async () => { await killExecutor(exec); };
  return out;
}
const retire = (S, file, { apply = false } = {}) => run('retire-unit3-collections-1582.mjs', ['--board-data', file, '--executor', S.exec.baseUrl, '--dataset', S.datasetId, '--kinds', 'posts', ...(apply ? ['--apply'] : [])], { SCRUM_EVENT_LOG_DIR: S.eventsDir });
const serve = (S, file) => startRestServer({ boardFile: file, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: S.datasetId, SCRUM_GRAPH_EXECUTOR_URL: S.exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_EVENT_LOG_DIR: S.eventsDir } });
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const VOLATILE = /^(generatedAt|asOf|now|serverTime|uptimeMs|startedAt|bootedAt|fetchedAt|since|ms|tookMs|elapsedMs|lastUpdated|nextPostSeq|postReservations)$/;   // `since` here is /api/insights' own window start (now minus six hours), which differs by milliseconds between two servers; `ms` is a surface's own timing, `lastUpdated` is the file's own stamp, which the removal moves, `postReservations` is the idempotent-retry map for posts, which `/api/load` derives from the posts in the file and which therefore goes with them (named in NOT COVERED), and `nextPostSeq` is a counter that lives in each server's own FILE (the probe post below is written through A only, so B's file is one behind: that is the test's shape, not a defect; numbering continuity after the removal is asserted in P3)
// volatile keys are DROPPED, not replaced: a key present on one side only must not read as a difference
const maskDeep = (v) => { if (Array.isArray(v)) return v.map(maskDeep); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.test(k)).map(([k, x]) => [k, maskDeep(x)])); return v; };

/** the path and values of the first difference between two JSON values, or null; arrays are compared by index */
function firstDiff(x, y, at) {
  if (x === y) return null;
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[k], y[k], `${at}/${k}`); if (d) return d; }
    return null;
  }
  return `${at || '/'}  with the copies ${JSON.stringify(x)?.slice(0, 80)}  without ${JSON.stringify(y)?.slice(0, 80)}`;
}
/** every post-reading surface, asked of one server; `shows` marks those that must contain the seeded posts */
async function surfaces(base, S, { changesSince }) {
  const tag = S.tag; const out = {};
  const ask = async (label, method, route, body, shows) => { const r = await api(base, method, route, body); out[label] = { status: r.status, body: r.body === null ? r.text : maskDeep(r.body), shows }; };
  const since = encodeURIComponent('2020-01-01T00:00:00.000Z');
  await ask('conv list', 'GET', '/api/conversations', undefined, true);
  await ask('conv limit 3', 'GET', '/api/conversations?limit=3', undefined, true);
  await ask('conv since', 'GET', `/api/conversations?since=${since}`, undefined, true);
  await ask('conv author', 'GET', '/api/conversations?author=ada', undefined, true);
  await ask('conv attachedTo', 'GET', `/api/conversations?attachedTo=${S.cards[0].id}`, undefined, true);
  await ask('conv mentions_me', 'GET', '/api/conversations?mentions_me=gizmo', undefined, true);
  await ask('conv by id first', 'GET', `/api/conversations/${S.postIds[0]}`, undefined, true);
  await ask('conv by id last', 'GET', `/api/conversations/${S.postIds[S.postIds.length - 1]}`, undefined, true);
  await ask('card with comments', 'GET', `/api/cards/${S.cards[0].id}`, undefined, true);
  await ask('changes', 'GET', `/api/changes?since=${encodeURIComponent(changesSince)}`, undefined, true);   // /api/changes refuses a `since` older than the log it holds, so it is asked from just before a post written through the server
  await ask('people', 'GET', '/api/people', undefined, false);
  await ask('insights', 'GET', '/api/insights', undefined, false);
  await ask('search all', 'POST', '/api/search/all', { q: `${tag}-post` }, true);
  await ask('board status', 'GET', '/api/board/status', undefined, false);
  await ask('board', 'GET', '/api/board', undefined, false);
  await ask('load', 'GET', '/api/load', undefined, false);
  return out;
}


const redactInGraph = async (S, id) => { const r = await createGraphClient({ baseUrl: S.exec.baseUrl, expectedDatasetId: S.datasetId }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: 'https://scrumboard.local/person/ada', post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', `PRECONDITION: the post is redacted in the graph (${JSON.stringify(r)})`); };
async function leaks(S, base, marker) {
  const recent = encodeURIComponent(new Date(Date.now() - 6 * 3600e3).toISOString());
  const surfaces = [['conversation list', 'GET', '/api/conversations?limit=100'], ['post by id', 'GET', `/api/conversations/${S.postIds[2]}`], ['card comments', 'GET', `/api/cards/${S.cards[0].id}`], ['attachedTo list', 'GET', `/api/conversations?attachedTo=${S.cards[0].id}`],
    ['search all', 'POST', '/api/search/all', { q: marker }], ['load', 'GET', '/api/load'], ['board', 'GET', '/api/board'], ['changes', 'GET', `/api/changes?since=${recent}`]];
  const out = [];
  for (const [label, method, route, body] of surfaces) {
    const r = await api(base, method, route, body);
    // /api/search/all ECHOES the query (`q`), so the marker is always in its body: only its HITS count (my first draft read the whole body and called the echo a leak)
    const text = label === 'search all' ? JSON.stringify(r.body?.posts?.hits ?? []) : r.text;
    out.push({ label, status: r.status, has: text.includes(marker) });
  }
  return out;
}

test('P7a THE FILE\'S COPY NEVER BEATS THE GRAPH: a post redacted in the graph is served from no surface by a server whose file still holds its text', { skip: SKIP, timeout: 400000 }, async () => {
  const S = await seed(ALNUM());
  try {
    const marker = `${S.tag}-post-2`;   // the post attached to the first card
    const A = await serve(S, S.file);
    try {
      const before = await leaks(S, A.baseUrl, marker);
      for (const label of ['conversation list', 'post by id', 'card comments', 'attachedTo list', 'search all']) assert.ok(before.find((x) => x.label === label).has, `CONTROL: before the redaction, ${label} shows the text`);
      await redactInGraph(S, S.postIds[2]);
      const after = await leaks(S, A.baseUrl, marker);
      const bad = after.filter((x) => x.has).map((x) => `${x.label} (${x.status})`);
      assert.deepEqual(bad, [], `the redacted post's text is served by: ${bad.join(', ')}`);
    } finally { await A.stop(); }
  } finally { await S.stop(); }
});

test('P7b AFTER THE REMOVAL: the retire script removes the file\'s copies and the redacted text is still served nowhere', { skip: SKIP, timeout: 400000 }, async () => {
  const S = await seed(ALNUM());
  try {
    const marker = `${S.tag}-post-2`; await redactInGraph(S, S.postIds[2]);
    const ap = retire(S, S.file, { apply: true }); assert.equal(ap.code, 0, `the removal goes ahead: a redacted post is held by its tombstone (${ap.code}): ${ap.out.slice(-300)}`);
    assert.ok(!fs.readFileSync(S.file, 'utf8').includes(marker), 'the file no longer holds the redacted text');
    const B = await serve(S, S.file);
    try { const bad = (await leaks(S, B.baseUrl, marker)).filter((x) => x.has).map((x) => `${x.label} (${x.status})`); assert.deepEqual(bad, [], `the redacted post's text is served by: ${bad.join(', ')}`); } finally { await B.stop(); }
  } finally { await S.stop(); }
});
