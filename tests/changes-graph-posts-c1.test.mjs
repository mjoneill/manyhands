/**
 * `/api/changes`, GRAPH-BACKED (#1574, the production exposure gate named by the contract owner and the builder; rubric #1602). Pre-registered by the separate
 * test author BEFORE the build, against the design as the builder stated it at 19:58Z and as the contract owner corrected it at 19:59Z. Copy unchanged into
 * tests/. REAL executor (a python with pyoxigraph), REAL REST server with the conversations unit on; without a python every test is SKIPPED, and a skip is NOT a
 * pass. Synthetic content only.
 *
 * WHY THIS IS THE GATE: the resident runner's context window reads `GET /api/changes` (`fetchBoundedChanges`), whose post rows carry a 120-character excerpt of the
 * post (`title`), and text that reaches a model cannot be taken back. Measured on `be81ab2` (a probe, this seat, 19:59Z): with the unit on, a post written through
 * the API appears in NO row of `/api/changes` (totals.posts is 0; the only rows are two `board-meta` rows for the counter and the reservations), so a resident's
 * context misses every new post; and a post written BEFORE the unit was on still has its text in the event log, so a post redacted in the graph afterwards would
 * still be served from its old log row. Both halves are silent. The design: the graph source also takes the post, announce and redact receipts into the `posts`
 * bucket, each post row's state is read from the graph NOW (a post redacted since replays as the tombstone, never its text), a redact receipt is its own row,
 * and with the unit on EVERY log-sourced conversation row is projected through the graph by post id (a tombstone there replaces the row's state). An unreadable
 * executor is a 503. Unit off is unchanged.
 *
 * WHAT IS PINNED, as behaviour of the HTTP answer (not of the merge's internals):
 *   C1 PARITY        posts written with the unit OFF, then read with the unit ON over the same board and log and an EMPTY graph, answer the same rows, totals and
 *                    truncation as the unit OFF over that same data; the unit OFF needs no executor and its cursor is still the `chg2.` form.
 *   C2 ONCE, POSTS   with the unit on, each graph-only post is exactly ONE row (kind conversation, op post, its id, its author, its text excerpt as `title`), in the
 *                    `posts` bucket: totals.posts counts them, `limitPosts` truncates them (and does not touch the cards bucket). The cursor is the `chg3.` form.
 *   C3 REDACTED, NO TEXT   a graph post redacted after its write replays WITHOUT its text anywhere in the answer (any row that names it has `title` null); its redact
 *                    receipt is a row (`op: 'redact'`) that also carries none of it; a visible post beside it keeps its excerpt.
 *   C4 STALE LOG ROW (the contract owner's pin)   a post written with the unit OFF has its text in the event log. After it is imported into the graph and redacted
 *                    there, the unit-ON answer carries none of its text, while the unit-OFF answer over the same log still does (the control: retention of the
 *                    event is the physical-erasure work; keeping it out of THIS API is this slice's).
 *   C5 BOUNDARY      a page walk (`before`, `limitPosts=1`, `limitCards=1`, `history=true`) over a window that holds log rows, graph rows and a withheld (redacted)
 *                    log row yields every visible post exactly once, none of the redacted post's text, and ends; then a forward cursor resumes with exactly the rows
 *                    written after it from BOTH sources (a card change in the log and a post in the graph), once each, and a second read at the new cursor is quiet.
 *   C6 UNAVAILABLE   with the unit on and the executor DOWN the answer is a 503, never a 200 built from the log alone; once the executor is back the answer is
 *                    whole again.
 *
 * NOT COVERED, by name: the log-born unit ON as well (both units; the design says the 503 applies to either, only the conversations unit is exercised here); the
 * `board-meta` rows the unit-on counter writes into the `cards` bucket (seen in the probe, two rows however many posts, not pinned either way); announce receipts
 * (`op/announce/`) and attachment-bearing posts; `before` as a legacy numeric cursor; a `since` older than the log's retention; the resident runner reading the
 * result (T3 pins the runner on the list route; its context window is exercised by a separate fake-model row once this exists); physical erasure of the log row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'chg-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const SINCE = '2020-01-01T00:00:00.000Z';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROSTER_FILE = path.join(os.tmpdir(), `chg-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const changes = (base, qs) => api(base, 'GET', `/api/changes?${qs}`);
const enc = encodeURIComponent;
const postRows = (body) => (body.changes || []).filter((r) => r.kind === 'conversation');

/** The unit-OFF history: a server with no executor writes `posts` through the API (each is an event-log row WITH its text), then is killed leaving its data. */
async function phaseOff(posts) {
  const off = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const posted = [];
  for (const p of posts) { const r = await api(off.baseUrl, 'POST', '/api/conversations', { author: p.author, body: p.body }); assert.equal(r.status, 201, r.text); posted.push({ ...r.body, body: p.body }); await sleep(15); }
  off.kill(); await sleep(400);
  return { boardFile: off.boardFile, posted, off };
}
/** A server over an existing board file (so the same event log), with or without the unit. */
const serverOver = (boardFile, exec) => startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, ...(exec ? { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) } });
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
const importPost = async (exec, p) => { const r = await client(exec).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redact = async (exec, id) => { const r = await client(exec).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

/** The unit ON from nothing: a fresh board, a fresh executor. */
async function unitOn(body) {
  const exec = await startExecutor({ store: tmpStore('chg-store-'), datasetId: DSID, create: true });
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }),
    env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  // `ctx.exec` is REASSIGNED by a row that restarts the executor (C6): the cleanup must kill whichever is current, or the orphan holds the test process open
  const ctx = { rest, exec, base: rest.baseUrl, post: (author, text) => api(rest.baseUrl, 'POST', '/api/conversations', { author, body: text }) };
  try { return await body(ctx); }
  finally { await rest.stop(); await killExecutor(ctx.exec); }
}

test('C1 PARITY: posts written with the unit OFF answer the same rows, totals and truncation read with the unit ON over an EMPTY graph as with the unit OFF; the unit OFF needs no executor and keeps the chg2 cursor', { skip: SKIP }, async () => {
  const { boardFile, posted } = await phaseOff([{ author: 'ada', body: 'log post one c1-a' }, { author: 'bea', body: 'log post two c1-b' }, { author: 'ada', body: 'log post three c1-c' }]);
  const exec = await startExecutor({ store: tmpStore('chg-store-'), datasetId: DSID, create: true });
  let onAns, offAns;
  try {
    const on = await serverOver(boardFile, exec);
    try { onAns = await changes(on.baseUrl, `since=${enc(SINCE)}&history=true`); } finally { on.kill(); await sleep(400); }
  } finally { await killExecutor(exec); }
  const off = await serverOver(boardFile, null);
  try { offAns = await changes(off.baseUrl, `since=${enc(SINCE)}&history=true`); } finally { await off.stop(); }
  assert.equal(onAns.status, 200, onAns.text); assert.equal(offAns.status, 200, offAns.text);
  const pick = (a) => ({ rows: a.body.changes, totals: a.body.totals, truncated: a.body.truncated, covers: a.body.covers, omits: a.body.omits, returned: a.body.returned, history: a.body.history });
  assert.equal(postRows(offAns.body).length, 3, 'CONTROL: the unit-OFF answer holds the three log posts');
  assert.deepEqual(postRows(offAns.body).map((r) => r.title), ['log post one c1-a', 'log post two c1-b', 'log post three c1-c'], 'CONTROL: with their text excerpts');
  assert.deepEqual(pick(onAns), pick(offAns), 'the unit ON over an empty graph answers the unit OFF\'s rows, totals and truncation');
  assert.match(offAns.body.cursor, /^chg2\./, 'the unit OFF keeps the chg2 cursor and needs no executor');
  assert.deepEqual(postRows(onAns.body).map((r) => r.id), posted.map((p) => p.id), 'and the rows are the posts, in order');
});

test('C2 EACH GRAPH POST IS ONE ROW IN THE POSTS BUCKET: three graph-only posts are three rows (conversation, post, id, author, excerpt), totals.posts counts them, limitPosts truncates them without touching the cards bucket, the cursor is chg3', { skip: SKIP }, async () => {
  await unitOn(async (s) => {
    const ps = [];
    for (const [a, t] of [['ada', 'graph post one c2-a'], ['bea', 'graph post two c2-b'], ['ada', 'graph post three c2-c']]) { const r = await s.post(a, t); assert.equal(r.status, 201, r.text); ps.push({ ...r.body, text: t }); await sleep(15); }
    // the card is written AFTER the posts: a card that is the board's very first write is stamped a few ms before its own log event, which the feed reads as "history that predates the log" and refuses `since` (an existing quirk, not this slice's)
    const card = await api(s.base, 'POST', '/api/cards', { title: 'a card for the cards bucket', description: 'x', createdBy: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    const all = await changes(s.base, `since=${enc(SINCE)}&history=true`);
    assert.equal(all.status, 200, all.text);
    const rows = postRows(all.body);
    assert.deepEqual(rows.map((r) => r.id).sort(), ps.map((p) => p.id).sort(), `exactly one row per graph post, no duplicates: ${JSON.stringify(rows)}`);
    for (const p of ps) {
      const r = rows.find((x) => x.id === p.id);
      assert.equal(r.op, 'post', `${p.id}: op post`);
      assert.equal(r.by, p.author, `${p.id}: by its author`);
      assert.equal(r.title, p.text, `${p.id}: the text excerpt as title (a visible post)`);
    }
    assert.equal(all.body.totals.posts, 3, `totals.posts counts the graph posts: ${JSON.stringify(all.body.totals)}`);
    assert.ok((all.body.changes || []).some((r) => r.kind === 'card' || r.id === card.body.id), 'CONTROL: the card change is in the answer (the cards bucket still works)');
    assert.match(all.body.cursor, /^chg3\.\d+\.[0-9a-f]{32}\.\d+\.\d+$/, `the cursor is the chg3 form: ${all.body.cursor}`);
    const cut = await changes(s.base, `since=${enc(SINCE)}&history=true&limitPosts=2`);
    assert.equal(postRows(cut.body).length, 2, `limitPosts=2 returns two post rows: ${JSON.stringify(postRows(cut.body))}`);
    assert.equal(cut.body.truncated.posts, true, 'and says the posts bucket was cut');
    assert.equal(cut.body.totals.posts, 3, 'with the total still three');
    assert.equal(cut.body.truncated.cards, all.body.truncated.cards, 'the cards bucket is untouched by limitPosts');
    assert.equal((cut.body.changes || []).filter((r) => r.kind !== 'conversation').length, (all.body.changes || []).filter((r) => r.kind !== 'conversation').length, 'and so are its rows');
  });
});

test('C3 A POST REDACTED AFTER ITS WRITE REPLAYS WITHOUT ITS TEXT: no row of the answer carries it, any row naming it has a null title, its redact receipt is a row that carries none of it, and the visible post beside it keeps its excerpt', { skip: SKIP }, async () => {
  await unitOn(async (s) => {
    const a = await s.post('ada', 'the one to be redacted c3-secret-text'); const b = await s.post('bea', 'the visible one c3-visible-text');
    assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, b.text);
    const before = await changes(s.base, `since=${enc(SINCE)}&history=true`);
    assert.ok(JSON.stringify(before.body).includes('c3-secret-text'), 'CONTROL: before the redaction the post\'s excerpt IS in the answer (the feed does carry post text)');
    await redact(s.exec, a.body.id);
    const after = await changes(s.base, `since=${enc(SINCE)}&history=true`);
    assert.equal(after.status, 200, after.text);
    assert.ok(!after.text.includes('c3-secret-text'), `no row carries the redacted text: ${after.text.slice(0, 600)}`);
    const named = postRows(after.body).filter((r) => r.id === a.body.id);
    assert.ok(named.every((r) => r.title === null), `every row naming the redacted post has a null title: ${JSON.stringify(named)}`);
    const receipt = named.find((r) => r.op === 'redact');
    assert.ok(receipt, `its redact receipt is a row (op redact): ${JSON.stringify(named)}`);
    const vis = postRows(after.body).find((r) => r.id === b.body.id && r.op === 'post');
    assert.equal(vis?.title, 'the visible one c3-visible-text', 'the visible post keeps its excerpt');
  });
});

test('C4 A STALE LOG ROW IS PROJECTED THROUGH THE GRAPH: a post written with the unit OFF (its text is in the event log), imported into the graph and redacted there, is served by the unit-ON answer without its text; the unit-OFF answer over the same log still carries it (the control)', { skip: SKIP }, async () => {
  const { boardFile, posted } = await phaseOff([{ author: 'ada', body: 'old post to be redacted c4-secret-text' }, { author: 'bea', body: 'old post that stays c4-visible-text' }]);
  const [x, y] = posted;
  const offFirst = await serverOver(boardFile, null);
  let control;
  try { control = await changes(offFirst.baseUrl, `since=${enc(SINCE)}&history=true`); } finally { offFirst.kill(); await sleep(400); }
  assert.ok(control.text.includes('c4-secret-text'), 'CONTROL: the unit-OFF answer over the log carries the text (the event log holds it)');
  const exec = await startExecutor({ store: tmpStore('chg-store-'), datasetId: DSID, create: true });
  try {
    for (const p of [x, y]) await importPost(exec, p);
    await redact(exec, x.id);
    const on = await serverOver(boardFile, exec);
    try {
      const ans = await changes(on.baseUrl, `since=${enc(SINCE)}&history=true`);
      assert.equal(ans.status, 200, ans.text);
      assert.ok(!ans.text.includes('c4-secret-text'), `the unit-ON answer carries none of the redacted post's text: ${ans.text.slice(0, 700)}`);
      const rowsOfX = postRows(ans.body).filter((r) => r.id === x.id);
      assert.ok(rowsOfX.every((r) => r.title === null), `any row naming it has a null title: ${JSON.stringify(rowsOfX)}`);
      const rowY = postRows(ans.body).find((r) => r.id === y.id);
      assert.equal(rowY?.title, 'old post that stays c4-visible-text', 'and the visible old post keeps its excerpt (the projection withholds only the tombstone)');
    } finally { await on.stop(); }
  } finally { await killExecutor(exec); }
});

test('C5 BOUNDARY: a page walk over log rows, graph rows and a withheld log row yields every visible post once and none of the redacted text; a forward cursor then resumes with exactly the rows written after it from BOTH sources, once each, and a re-read is quiet', { skip: SKIP }, async () => {
  const { boardFile, posted } = await phaseOff([{ author: 'ada', body: 'log one c5-l1' }, { author: 'bea', body: 'log two c5-secret-text' }, { author: 'ada', body: 'log three c5-l3' }]);
  const [l1, l2, l3] = posted;
  const exec = await startExecutor({ store: tmpStore('chg-store-'), datasetId: DSID, create: true });
  try {
    for (const p of [l1, l2, l3]) await importPost(exec, p);
    await redact(exec, l2.id);
    const rest = await serverOver(boardFile, exec);
    try {
      const post = (author, text) => api(rest.baseUrl, 'POST', '/api/conversations', { author, body: text });
      const g1 = await post('ada', 'graph one c5-g1'); await sleep(15); const g2 = await post('bea', 'graph two c5-g2');
      assert.equal(g1.status, 201, g1.text); assert.equal(g2.status, 201, g2.text);
      const base = `since=${enc(SINCE)}&history=true&limitCards=1&limitPosts=1`;
      let page = (await changes(rest.baseUrl, base)).body; const rows = [...page.changes]; let n = 0; const texts = [JSON.stringify(page)];
      while (page.nextBefore) { const r = await changes(rest.baseUrl, `${base}&before=${enc(page.nextBefore)}`); assert.equal(r.status, 200, r.text); page = r.body; rows.push(...page.changes); texts.push(JSON.stringify(page)); assert.ok(++n < 60, 'the walk ends'); }
      const visible = rows.filter((r) => r.kind === 'conversation' && r.op === 'post' && typeof r.title === 'string').map((r) => r.id);
      assert.deepEqual([...visible].sort(), [l1.id, l3.id, g1.body.id, g2.body.id].sort(), `every visible post exactly once (none skipped, none repeated): ${JSON.stringify(visible)}`);
      assert.ok(!texts.join('').includes('c5-secret-text'), 'and no page carries the redacted post\'s text');

      const first = (await changes(rest.baseUrl, `since=${enc(SINCE)}&history=true`)).body;
      assert.match(first.cursor, /^chg3\./, 'the cursor is chg3');
      const card = await api(rest.baseUrl, 'POST', '/api/cards', { title: 'written after the cursor c5-card', description: 'x', createdBy: 'ada' });
      assert.ok(card.status === 200 || card.status === 201, card.text);
      const g3 = await post('ada', 'graph three c5-g3'); assert.equal(g3.status, 201, g3.text);
      const next = (await changes(rest.baseUrl, `since=${enc(first.cursor)}&history=true`)).body;
      const nextPosts = postRows(next).filter((r) => r.op === 'post').map((r) => r.id);
      assert.deepEqual(nextPosts, [g3.body.id], `exactly the new graph post, once, and no old post: ${JSON.stringify(nextPosts)}`);
      assert.ok((next.changes || []).some((r) => r.title === 'written after the cursor c5-card'), 'and the card change written after it, from the log');
      const quiet = (await changes(rest.baseUrl, `since=${enc(next.cursor)}&history=true`)).body;
      assert.deepEqual(quiet.changes, [], `a re-read at the new cursor is quiet: ${JSON.stringify(quiet.changes)}`);
      assert.equal(quiet.cursor, next.cursor, 'and the cursor does not move');
    } finally { await rest.stop(); }
  } finally { await killExecutor(exec); }
});

test('C6 AN UNREADABLE GRAPH IS A 503, NEVER A LOG-ONLY 200: with the unit on and the executor down the answer is 503; once it is back the answer is whole again, with the graph post', { skip: SKIP }, async () => {
  await unitOn(async (s) => {
    const p = await s.post('ada', 'a graph post c6-a'); assert.equal(p.status, 201, p.text);
    assert.equal((await changes(s.base, `since=${enc(SINCE)}&history=true`)).status, 200, 'CONTROL: 200 while the executor is up');
    const port = s.exec.port; const store = s.exec.proc.spawnargs[s.exec.proc.spawnargs.indexOf('--store') + 1];
    await killExecutor(s.exec);
    const down = await changes(s.base, `since=${enc(SINCE)}&history=true`);
    assert.equal(down.status, 503, `503 with the executor down, never a log-only 200: ${down.status} ${down.text.slice(0, 300)}`);
    s.exec = await startExecutor({ store, datasetId: DSID, create: false, port });
    const back = await changes(s.base, `since=${enc(SINCE)}&history=true`);
    assert.equal(back.status, 200, back.text);
    assert.deepEqual(postRows(back.body).filter((r) => r.op === 'post').map((r) => r.id), [p.body.id], 'whole again: the graph post is in the answer');
  });
});
