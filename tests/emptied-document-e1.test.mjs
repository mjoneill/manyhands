/**
 * STEP 1 OF PHASE 2: THE DOCUMENT NO LONGER HOLDS THE POSTS (decision recorded 2026-10-06 ~12:09Z: conversation posts must stop being READ from and stop being
 * WRITTEN to the board document; the ~37k old posts come out of it). Written by the separate test author, BEFORE the build, from the gate list in the review of 558ae4f
 * (the deployed commit). Synthetic content. REAL executor, REAL REST server with the posts unit on; without a python with pyoxigraph every row is SKIPPED, and a skip is
 * NOT a pass.
 *
 * THE STATE UNDER TEST is built from the outside, as it will exist after the posts are taken out: posts are created through the API (they land in the graph), the server is
 * killed, the document's `conversations` is emptied with the same store functions the rollback script uses (epoch and counter kept), and a second server starts on that
 * file against the SAME executor store. Nothing is stubbed.
 *
 *   E0  CONTROL: the emptied state is real, and the reads that must not depend on the document do not. The document holds zero posts; the post list, a card page's comments,
 *       a post by id, and `/api/load?conversations=1` all still show every post.
 *   E1  A REGRESSED COUNTER IS STILL REFUSED. With the document holding no posts, a counter at or below the highest post number in the graph (equal to it, and far
 *       below it) must make a post-creating write REFUSED and write nothing (the list is unchanged afterwards). The refusal may be either of the two that exist: 409
 *       POST_SEQ_BEHIND_GRAPH (the rewind guard of the graph post path, which reads the graph's highest number) or 500 POST_SEQ_STATE_CORRUPT (the document path's check). The
 *       property is the refusal and the empty write, not a code. (CORRECTED before the RED run was reported: the first draft pinned 500 POST_SEQ_STATE_CORRUPT only, on my
 *       wrong belief that nothing else read the graph's number. The RED run on 558ae4f answered 409 POST_SEQ_BEHIND_GRAPH, so this row passes today and is a control: it
 *       holds the guard in place while the document's posts come out.)
 *   E1b CONTROL: a counter one above the highest number is accepted, the post takes exactly that number, the next takes the one after, and no number repeats.
 *   E2  A READ-MODIFY-WRITE ECHO OF `comments` IS NOT AN ATTEMPT. A card fetched and written back with the `comments` it was given is not reported as a redirected field
 *       (#844); a DIFFERENT `comments` still is (the field is still not a card field), so the row cannot pass by the check being gone.
 *   E3  NO NEW POST IS WRITTEN INTO THE DOCUMENT (a control today: the graph post path writes no document conversation by design; this holds it). After a post is created through the API, the document's `conversations` is still empty, and the post is in the graph. (The
 *       counter and reservations leaving the document, so that a post is no document write at all, is the NEXT step and is NOT pinned here.)
 *   E4  SURVIVES A KILL: after a kill -9 and a restart on the emptied document, a new post takes a number above every earlier one and no number in the list repeats.
 *
 * NOT COVERED, by name: the legacy-mode outbox proof (`posts.find` in the document; the entry needs a built-up outbox this file does not construct); the standing checks
 * stale-claims and role-expiry (disabled under the unit today); `finishBoard`, the boot snapshot, `index.html` and the commons panel; rollback and backfill scripts (their
 * own rows); the cost of a write (a timing row, not this file's job); posts written by something other than REST (MCP goes through REST).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { loadDomain, saveDomain } from '../core/store.mjs';
import { boardToDomain, domainToBoard } from '../core/mapping.mjs';
import { NEXT_POST_SEQ } from '../core/post-seq.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'emp-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROSTER_FILE = path.join(os.tmpdir(), `emp-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const env = (url) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' });
const docPosts = (file) => domainToBoard(loadDomain(file)).conversations || [];
const rewriteDocument = (file, edit) => {
  const board = domainToBoard(loadDomain(file));
  edit(board);
  board.lastUpdated = new Date().toISOString();
  saveDomain(file, boardToDomain(board), { now: board.lastUpdated });
};
const maxSeq = (posts) => Math.max(0, ...posts.map((p) => p.postSeq).filter(Number.isSafeInteger));

/** Build the emptied-document state, then run `body`. `counter(max)` may set the document's counter before the second server starts. */
async function emptied(body, { counter = null } = {}) {
  const exec = await startExecutor({ store: tmpStore('emp-store-'), datasetId: DSID, create: true });
  let a = null; let b = null;
  try {
    a = await startRestServer({ board: makeBoardFixture({ postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: env(exec.baseUrl) });
    const card = await api(a.baseUrl, 'POST', '/api/cards', { title: 'step one card', description: 'x', createdBy: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    const made = [];
    for (const [i, attachedTo] of [[1, card.body.id], [2, card.body.id], [3, card.body.id], [4, undefined]]) {
      const r = await api(a.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `step-one post ${i} e1-marker`, ...(attachedTo ? { attachedTo } : {}) });
      assert.equal(r.status, 201, `setup post ${i}: ${r.status} ${r.text.slice(0, 200)}`);
      made.push(r.body);
    }
    const before = await api(a.baseUrl, 'GET', '/api/conversations');
    assert.equal(before.status, 200, before.text.slice(0, 200));
    const max = maxSeq(before.body);
    assert.ok(max >= 4, `SETUP CONTROL: the four posts are numbered (highest ${max})`);
    a.kill();
    rewriteDocument(a.boardFile, (board) => {
      board.conversations = [];
      if (counter) board[NEXT_POST_SEQ] = counter(max);
    });
    assert.equal(docPosts(a.boardFile).length, 0, 'SETUP CONTROL: the document now holds no posts');
    b = await startRestServer({ boardFile: a.boardFile, env: env(exec.baseUrl) });
    return await body({ base: b.baseUrl, file: a.boardFile, cardId: card.body.id, made, max, restart: async () => { b.kill(); b = await startRestServer({ boardFile: a.boardFile, env: env(exec.baseUrl) }); return b.baseUrl; } });
  } finally { try { await b?.stop(); } catch { /* gone */ } try { await a?.stop(); } catch { /* gone */ } await killExecutor(exec); }
}

test('E0 CONTROL: with the document holding no posts, the list, a card page, a post by id and /api/load?conversations=1 still show every post', { skip: SKIP, timeout: 180000 }, async () => {
  await emptied(async ({ base, file, cardId, made }) => {
    assert.equal(docPosts(file).length, 0);
    const list = await api(base, 'GET', '/api/conversations');
    assert.equal(list.status, 200, list.text.slice(0, 200));
    for (const m of made) assert.ok(list.body.some((c) => c.id === m.id && c.body === m.body), `the list holds ${m.id}`);
    const one = await api(base, 'GET', `/api/conversations/${made[0].id}`);
    assert.equal(one.status, 200, `a post by id: ${one.status} ${one.text.slice(0, 200)}`);
    assert.equal(one.body.body, made[0].body);
    const page = await api(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.equal(JSON.stringify(page.body.comments).includes('e1-marker') || (page.body.comments?.count ?? page.body.comments?.length ?? 0) >= 3, true, `the card page still carries its three comments: ${JSON.stringify(page.body.comments)?.slice(0, 300)}`);
    const load = await api(base, 'GET', '/api/load?conversations=1');
    assert.equal(load.status, 200, load.text.slice(0, 200));
    for (const m of made) assert.ok((load.body.conversations || []).some((c) => c.id === m.id), `/api/load?conversations=1 holds ${m.id}`);
  });
});

for (const [label, counter] of [['equal to the highest post number', (max) => max], ['far below it (1)', () => 1]]) {
  test(`E1 A REGRESSED COUNTER IS STILL REFUSED (${label}): a post-creating write is refused (409 POST_SEQ_BEHIND_GRAPH or 500 POST_SEQ_STATE_CORRUPT) and writes nothing`, { skip: SKIP, timeout: 180000 }, async () => {
    await emptied(async ({ base, file, max }) => {
      const before = await api(base, 'GET', '/api/conversations');
      assert.equal(before.status, 200, before.text.slice(0, 200));
      const r = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'a post that must not be numbered e1-refused' });
      const REFUSALS = { 409: 'POST_SEQ_BEHIND_GRAPH', 500: 'POST_SEQ_STATE_CORRUPT' };
      assert.ok(REFUSALS[r.status], `a post is refused when the counter is not above the highest committed number (${max}): ${r.status} ${r.text.slice(0, 300)}`);
      assert.equal(r.body?.code, REFUSALS[r.status], r.text.slice(0, 300));
      const after = await api(base, 'GET', '/api/conversations');
      assert.equal(after.body.length, before.body.length, 'and nothing was written: the list is the same length');
      assert.ok(!after.body.some((c) => String(c.body).includes('e1-refused')), 'and the refused post is not in it');
      assert.equal(new Set(after.body.map((c) => c.postSeq)).size, after.body.length, 'and no post number repeats');
      assert.equal(docPosts(file).length, 0, 'and the document is still empty');
    }, { counter });
  });
}

test('E1b CONTROL: a counter one above the highest number is accepted, the post takes exactly that number, the next takes the one after, and no number repeats', { skip: SKIP, timeout: 180000 }, async () => {
  await emptied(async ({ base, max }) => {
    const p1 = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'next one e1b-a' });
    assert.equal(p1.status, 201, p1.text.slice(0, 300));
    const p2 = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'next two e1b-b' });
    assert.equal(p2.status, 201, p2.text.slice(0, 300));
    assert.equal(p1.body.postSeq, max + 1, `the first takes the counter (${max + 1}): ${p1.body.postSeq}`);
    assert.equal(p2.body.postSeq, max + 2, `the second takes the next: ${p2.body.postSeq}`);
    const list = await api(base, 'GET', '/api/conversations');
    assert.equal(new Set(list.body.map((c) => c.postSeq)).size, list.body.length, 'no post number repeats');
  }, { counter: (max) => max + 1 });
});

test('E2 AN ECHO OF `comments` IS NOT AN ATTEMPT: a card written back with the comments it was given reports no redirected field; a different `comments` still does', { skip: SKIP, timeout: 180000 }, async () => {
  await emptied(async ({ base, cardId }) => {
    const page = await api(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.ok(page.body.comments !== undefined, `the card page carries comments to echo: ${Object.keys(page.body)}`);
    const echo = await api(base, 'PATCH', `/api/cards/${cardId}`, { comments: page.body.comments, title: page.body.title, by: 'ada' });
    assert.equal(echo.status, 200, `the read-modify-write is accepted: ${echo.status} ${echo.text.slice(0, 300)}`);
    assert.equal(echo.body?.redirectedFields?.comments, undefined, `an echo of the card's own comments is not reported as an attempt to set them: ${JSON.stringify(echo.body?.redirectedFields)}`);
    const real = await api(base, 'PATCH', `/api/cards/${cardId}`, { comments: [{ id: 'forged', body: 'not a card field' }], by: 'ada' });
    assert.equal(real.status, 200, `${real.status} ${real.text.slice(0, 300)}`);
    assert.ok(real.body?.redirectedFields?.comments, `a DIFFERENT comments value is still reported (the field is still not writable here): ${JSON.stringify(real.body?.redirectedFields)}`);
  });
});

test('E3 NO NEW POST IS WRITTEN INTO THE DOCUMENT: after a post through the API the document still holds no posts and the post is in the graph', { skip: SKIP, timeout: 180000 }, async () => {
  await emptied(async ({ base, file, restart }) => {
    const r = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'a new post e3-marker' });
    assert.equal(r.status, 201, r.text.slice(0, 300));
    const url = await restart();   // a kill and a restart, so what is read is what was SAVED, not what is held in memory
    const back = await api(url, 'GET', `/api/conversations/${r.body.id}`);
    assert.equal(back.status, 200, `the post is in the graph: ${back.status} ${back.text.slice(0, 200)}`);
    assert.equal(docPosts(file).length, 0, `and the document still holds no posts (it holds ${docPosts(file).length})`);
  }, { counter: (max) => max + 1 });
});

test('E4 SURVIVES A KILL: after a kill -9 and a restart on the emptied document, a new post takes a number above every earlier one and no number repeats', { skip: SKIP, timeout: 180000 }, async () => {
  await emptied(async ({ base, restart }) => {
    const p1 = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'before the kill e4-a' });
    assert.equal(p1.status, 201, p1.text.slice(0, 300));
    const url = await restart();
    const p2 = await api(url, 'POST', '/api/conversations', { author: 'ada', body: 'after the kill e4-b' });
    assert.equal(p2.status, 201, `${p2.status} ${p2.text.slice(0, 300)}`);
    assert.ok(p2.body.postSeq > p1.body.postSeq, `the number after the restart (${p2.body.postSeq}) is above the one before it (${p1.body.postSeq})`);
    const list = await api(url, 'GET', '/api/conversations');
    assert.equal(new Set(list.body.map((c) => c.postSeq)).size, list.body.length, 'no post number repeats');
    assert.ok(list.body.some((c) => c.id === p1.body.id) && list.body.some((c) => c.id === p2.body.id), 'both are in the list');
  }, { counter: (max) => max + 1 });
});
