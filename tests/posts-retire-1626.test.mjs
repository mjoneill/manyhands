/**
 * #1626 — REMOVE THE BOARD FILE'S POST COPIES. Written by the separate test author BEFORE the removal is run on the live file. The removal script is `scripts/retire-unit3-collections-1582.mjs --kinds posts` (branch
 * card/1626-retire-posts) and its input gate is `scripts/backfill-posts-r0.mjs`. What these rows protect is the same thing step 4 protected for deliveries, with one difference that makes it riskier: a post is read by MORE
 * surfaces than a delivery is, and every one of them used to be able to fall back on the file's copy. A surface that still reads the copy keeps working until the day the copy is gone, and then it answers a SHORTER board with a 200.
 * So the main row is a DIFFERENTIAL, not a unit test: one executor holds the posts; a unit-on server whose file STILL HOLDS the copies and a unit-on server whose file holds NONE (the file the script actually produced) are asked the
 * same questions over every post-reading surface, and the answers must be identical. Real REST servers, a real executor, real scripts, synthetic content, no browser. Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass.
 *
 *   P1  THE SCRIPT: a dry run reports N of N and writes NOTHING (the file's bytes are identical); `--apply` removes exactly the post nodes, keeps every other node as it was, and appends exactly ONE board-meta event.
 *   P1b THE RECORD OF WHAT LEFT: that one event NAMES the number of posts that left (step 4's event named deliveries and model calls, and this event must not read "0 and 0" for 37 thousand posts). Its own row, so that a failure
 *       here cannot stand in for a failure of P1.
 *   P2  THE DIFFERENTIAL: server A (file holds the copies) and server B (file holds none), same graph: the conversation list in every variant (default, limit, since, author, attachedTo, mentions_me), a post by id (first and last), a card
 *       with comments, `/api/changes`, `/api/people`, `/api/insights`, `POST /api/search/all`, `/api/board/status`, `/api/board` and `/api/load` answer the same. Each list-shaped surface is also required to SHOW the seeded
 *       posts (an equal pair of empty answers is not a pass), and B's file is asserted to hold zero posts (the premise is checked, not assumed).
 *   P3  A POST CREATED AFTER THE REMOVAL READS BACK EVERYWHERE: on B, a new post attached to a card is in the list, by id, in the card's comments, in `/api/changes` and in search, and it is in the executor and NOT in B's file.
 *   P4  ONE MISSING POST REFUSES AND REMOVES NOTHING, AND THE BACKFILL BRINGS IT TO N OF N: the backfill is interrupted one post short; `--apply` exits non-zero naming the missing post and leaves the file byte-identical; after the
 *       backfill resumes the dry run reports N of N and `--apply` removes them. A post that exists only in the file is never removed.
 *   P5  A GRAPH COPY THAT DIFFERS FROM THE FILE'S IS NOT A HELD POST: the graph holds a post under the same id with other text; `--apply` refuses and the file keeps its copy. (The script presently checks that an id of the right type
 *       exists. The backfill refuses to overwrite a different copy, so this can only arise from something else writing the id; if you decide a presence check is enough, say so on #1626 and this row is dropped, not weakened.)
 *   P6  RE-RUNNING IS A NO-OP: a second `--apply` on the trimmed file exits 0, writes nothing and appends no event.
 *
 * NOT COVERED, by name: an idempotent RETRY of a post whose request id predates the removal (`/api/load`'s `postReservations`, derived from the posts in the file, goes with them; the differential masks it and does not test a replayed request id); a REDACTED post (the script counts a tombstone as held; no redaction is exercised here: the surfaces' tombstone rendering is pinned in the #1574 rows); attachments' bytes on disk; the cold boot of REST's
 * replica after the removal (step 4's lesson: the in-process replica replayed the removal for 15 minutes; that is a boot-time measurement on the live file, not a unit row); the live file's 37,414 posts, for which the independent
 * read-back is the measurement; surfaces I did not enumerate (a seat's MCP catch-up and the channel hint, which ride the same reads); concurrency between the removal and a live REST (the script is run with REST stopped).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('P1 THE SCRIPT: a dry run writes nothing; --apply removes exactly the posts, keeps every other node, and appends exactly ONE event', { skip: SKIP, timeout: 300000 }, async () => {
  const S = await seed(ALNUM());
  try {
    const before = sha(S.file); const others = nodesOtherThanComments(S.file); const ev0 = eventLines(S.eventsDir).length;
    const dry = retire(S, S.file);
    assert.equal(dry.code, 0, `a dry run completes (${dry.code}) ${dry.out.slice(-300)}`);
    assert.ok(new RegExp(`${S.posts} of ${S.posts} verified`).test(dry.out), `it reports ${S.posts} of ${S.posts} verified in the graph: ${dry.out.slice(-300)}`);
    assert.ok(before.equals(sha(S.file)), 'a dry run leaves the file byte-identical'); assert.equal(eventLines(S.eventsDir).length, ev0, 'and appends no event');
    const ap = retire(S, S.file, { apply: true });
    assert.equal(ap.code, 0, `--apply completes (${ap.code}) ${ap.out.slice(-300)}`);
    assert.equal(commentsIn(S.file).length, 0, 'the file holds no post afterwards'); assert.equal(nodesOtherThanComments(S.file), others, 'and every other node is exactly as it was');
    const events = eventLines(S.eventsDir).slice(ev0);
    assert.equal(events.length, 1, `exactly ONE event is appended (${events.length})`);
  } finally { await S.stop(); }
});

test('P1b THE RECORD OF WHAT LEFT: the one event the removal appends names the number of posts that left', { skip: SKIP, timeout: 300000 }, async () => {
  const S = await seed(ALNUM());
  try {
    const ev0 = eventLines(S.eventsDir).length;
    assert.equal(retire(S, S.file, { apply: true }).code, 0, '--apply completes');
    const events = eventLines(S.eventsDir).slice(ev0); assert.equal(events.length, 1, 'one event');
    const state = JSON.stringify(JSON.parse(events[0]).state);   // the state ONLY: the line also carries timestamps, and a small count matches the digits of a date
    assert.ok(new RegExp(`post[a-z"']*"?\\s*:\\s*${S.posts}\\b`, 'i').test(state), `the event's state names the number of posts that left (posts: ${S.posts}); it reads: ${state.slice(0, 300)}`);
  } finally { await S.stop(); }
});

test('P2 THE DIFFERENTIAL: a server whose file holds the copies and one whose file holds none, same graph, answer every post-reading surface identically', { skip: SKIP, timeout: 400000 }, async () => {
  const S = await seed(ALNUM());
  const trimmed = path.join(S.dir, 'trimmed.json'); fs.copyFileSync(S.file, trimmed);
  try {
    assert.equal(retire(S, trimmed, { apply: true }).code, 0, 'the script produces the trimmed file the live run would produce');
    assert.equal(commentsIn(trimmed).length, 0, 'PREMISE: B\'s file holds zero posts'); assert.equal(commentsIn(S.file).length, S.posts, 'PREMISE: A\'s file still holds all of them');
    const A = await serve(S, S.file); const B = await serve(S, trimmed);
    try {
      const changesSince = new Date().toISOString();
      const probe = await api(A.baseUrl, 'POST', '/api/conversations', { author: 'gizmo', body: `${S.tag}-changes-probe`, attachedTo: S.cards[0].id });
      assert.equal(probe.status, 201, `a post written through A (${probe.status} ${probe.text.slice(0, 100)})`);
      const a = await surfaces(A.baseUrl, S, { changesSince }); const b = await surfaces(B.baseUrl, S, { changesSince });
      const diffs = [];
      for (const label of Object.keys(a)) {
        assert.equal(a[label].status, 200, `A: ${label} answers 200 (${a[label].status} ${JSON.stringify(a[label].body).slice(0, 200)})`);
        if (a[label].shows) assert.ok(JSON.stringify(a[label].body).includes(S.tag), `A: ${label} actually shows the seeded posts (an empty pair of answers is not a pass)`);
        if (b[label].status !== a[label].status) diffs.push(`${label}: status ${a[label].status} with the copies, ${b[label].status} without`);
        else { const d = firstDiff(a[label].body, b[label].body, ''); if (d) diffs.push(`${label}: ${d}`); }
      }
      assert.deepEqual(diffs, [], 'every surface answers the same without the copies as with them; the surfaces that differ, and the first difference in each:\n  ' + diffs.join('\n  '));
    } finally { await A.stop(); await B.stop(); }
  } finally { await S.stop(); }
});

test('P3 A POST CREATED AFTER THE REMOVAL READS BACK EVERYWHERE: list, by id, card comments, changes, search; in the executor and not in the file', { skip: SKIP, timeout: 400000 }, async () => {
  const S = await seed(ALNUM());
  try {
    assert.equal(retire(S, S.file, { apply: true }).code, 0, 'the copies are removed first');
    const B = await serve(S, S.file);
    try {
      const mark = `${S.tag}-after-removal`;
      const sinceMark = new Date().toISOString();
      const made = await api(B.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `${mark} look at this`, attachedTo: S.cards[0].id });
      assert.equal(made.status, 201, `the post is accepted (${made.status} ${made.text.slice(0, 120)})`);
      const id = made.body.id; const has = (r) => JSON.stringify(r.body).includes(mark);
      const seeded = (await api(B.baseUrl, 'GET', '/api/conversations?limit=100')).body; const maxSeq = Math.max(...seeded.filter((c) => c.id !== id).map((c) => Number(c.postSeq)).filter(Number.isFinite));
      assert.ok(Number.isFinite(maxSeq) && maxSeq >= 10, `the seeded posts (nine and the board's claim announcement) carry their postSeq (${maxSeq})`);
      assert.equal(made.body.postSeq, maxSeq + 1, `numbering continues with no reuse and no gap after the removal: the new post is ${maxSeq + 1} (got ${made.body.postSeq})`);
      assert.ok(has(await api(B.baseUrl, 'GET', '/api/conversations?limit=5')), 'it is in the conversation list');
      assert.ok(has(await api(B.baseUrl, 'GET', `/api/conversations/${id}`)), 'it is readable by id');
      assert.ok(has(await api(B.baseUrl, 'GET', `/api/conversations?attachedTo=${S.cards[0].id}`)), 'it is in the card\'s list');
      assert.ok(has(await api(B.baseUrl, 'GET', `/api/cards/${S.cards[0].id}`)), 'it is in the card\'s comments');
      assert.ok(has(await api(B.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(sinceMark)}`)), 'it is in /api/changes');
      assert.ok(has(await api(B.baseUrl, 'POST', '/api/search/all', { q: mark })), 'search finds it');
      assert.ok(await holders(S.exec.baseUrl, mark) >= 1, 'the executor holds it');
      assert.ok(!fs.readFileSync(S.file, 'utf8').includes(mark), 'and the board file does not');
    } finally { await B.stop(); }
  } finally { await S.stop(); }
});

test('P4 ONE MISSING POST REFUSES AND REMOVES NOTHING; the backfill resumes and brings it to N of N; then the removal is allowed', { skip: SKIP, timeout: 300000 }, async () => {
  const S0 = ALNUM(); let S;
  const probe = await seed(S0, { backfillLimit: 0 }); const n = probe.posts; await probe.stop();   // learn N from a throwaway seed
  S = await seed(ALNUM(), { backfillLimit: n - 1 });
  try {
    assert.equal(S.backfill.written, S.posts - 1, `CONTROL: the backfill stopped one post short (${JSON.stringify(S.backfill)})`);
    const before = sha(S.file); const ev0 = eventLines(S.eventsDir).length;
    const dry = retire(S, S.file); assert.notEqual(dry.code, 0, `a dry run with one post missing from the graph refuses (exit ${dry.code}): ${dry.out.slice(-300)}`);
    assert.ok(/NOT IN THE GRAPH/.test(dry.out) && new RegExp(`${S.posts - 1} of ${S.posts}`).test(dry.out), `and names the gap: ${dry.out.slice(-400)}`);
    const ap = retire(S, S.file, { apply: true }); assert.notEqual(ap.code, 0, `--apply refuses too (exit ${ap.code})`);
    assert.ok(before.equals(sha(S.file)), 'the file is byte-identical: a post that exists only in the file is never removed'); assert.equal(eventLines(S.eventsDir).length, ev0, 'and no event was appended');
    const resume = run('backfill-posts-r0.mjs', ['--board-file', S.file, '--executor-url', S.exec.baseUrl, '--dataset-id', S.datasetId]); assert.equal(resume.code, 0, `the backfill resumes (${resume.code}) ${resume.out.slice(-200)}`);
    const dry2 = retire(S, S.file); assert.equal(dry2.code, 0, `the dry run now passes (${dry2.code}): ${dry2.out.slice(-300)}`); assert.ok(new RegExp(`${S.posts} of ${S.posts} verified`).test(dry2.out), `N of N: ${dry2.out.slice(-200)}`);
    assert.equal(retire(S, S.file, { apply: true }).code, 0, 'and --apply removes them'); assert.equal(commentsIn(S.file).length, 0);
  } finally { await S.stop(); }
});

test('P5 A GRAPH COPY THAT DIFFERS FROM THE FILE\'S IS NOT A HELD POST: the script refuses and the file keeps its copy', { skip: SKIP, timeout: 300000 }, async () => {
  const S = await seed(ALNUM());
  try {
    // another writer put DIFFERENT text under one post's id: the file now holds the only copy of what that post said
    const doc = JSON.parse(fs.readFileSync(S.file, 'utf8')); const target = doc['@graph'].filter(COMMENT)[3];
    const altered = path.join(S.dir, 'altered.json'); const ad = JSON.parse(JSON.stringify(doc));
    const t = ad['@graph'].find((n) => n['@id'] === target['@id']); const textKey = ['text', 'body', 'schema:text'].find((k) => typeof t[k] === 'string'); assert.ok(textKey, 'the post node carries its text under a known key');
    t[textKey] = `${t[textKey]} (this graph copy says something else)`; fs.writeFileSync(altered, JSON.stringify(ad));
    // replace the graph's copy of that one post: a fresh executor holding the altered file's posts, the SAME ids
    await S.stop();
    const exec2 = await startExecutor({ store: tmpStore('p1626b-store-'), datasetId: 'p1626-test', create: true }); S.exec = exec2; S.stop = async () => { await killExecutor(exec2); };
    const bf = run('backfill-posts-r0.mjs', ['--board-file', altered, '--executor-url', exec2.baseUrl, '--dataset-id', S.datasetId]); assert.equal(bf.code, 0, `CONTROL: the altered file backfills (${bf.code})`);
    const before = sha(S.file); const ap = retire(S, S.file, { apply: true });
    assert.notEqual(ap.code, 0, `the original file's post differs from the graph's: --apply must refuse (exit ${ap.code}): ${ap.out.slice(-300)}`);
    assert.ok(before.equals(sha(S.file)), 'and the file keeps every copy, byte for byte');
  } finally { await S.stop(); }
});

test('P6 RE-RUNNING IS A NO-OP: a second --apply on the trimmed file exits 0, writes nothing, appends no event', { skip: SKIP, timeout: 300000 }, async () => {
  const S = await seed(ALNUM());
  try {
    assert.equal(retire(S, S.file, { apply: true }).code, 0);
    const before = sha(S.file); const ev = eventLines(S.eventsDir).length;
    const again = retire(S, S.file, { apply: true });
    assert.equal(again.code, 0, `a second run exits 0 (${again.code}) ${again.out.slice(-200)}`); assert.ok(before.equals(sha(S.file)), 'the file is byte-identical'); assert.equal(eventLines(S.eventsDir).length, ev, 'and no event was appended');
  } finally { await S.stop(); }
});
