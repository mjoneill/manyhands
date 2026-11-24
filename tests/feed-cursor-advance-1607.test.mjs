/**
 * #1607 — AN EXHAUSTED LIVE PAGE ADVANCES TO THE HEAD IT READ. Contract change approved by the R3 contract owner
 * (2026-11-24) after tests/feed-cursor-visibility-1607.test.mjs answered the visibility question.
 * REAL executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: a live cursor behind the head runs the operation scan (opBatch: every receipt, ~1.3 s on the live store). When the
 * scan found no post, the page echoed its own cursor, so after any NON-post commit every idle poller stayed behind the
 * head and repeated the scan on every poll until the next post (2026-11-23: ~46 such polls a minute, the read gate
 * saturated, 503s for everyone).
 *
 *   S1  NON-POST COMMIT: the first poll after it answers an empty page whose cursor is the head that poll read; the next
 *       poll makes NO operation scan (the idle path); a later post is still delivered exactly once.
 *   S2  LIMIT-STOPPED vs EXHAUSTED: a page that stops because it reached `limit` returns the last DELIVERED commit (the
 *       rest are still owed); the page after it, which exhausts the scan, delivers the remainder once and advances to the
 *       head.
 *   S4  A REDACTION ACROSS THE ADVANCE: redactions are in the same scan, so a consumer that received a post gets its
 *       redaction exactly once even with non-post commits after it, and only then advances to the head.
 *   S3  THE IDENTITY FENCE ON THE ADVANCING PATH: a store swapped between the reads of a behind-the-head poll is 503
 *       GRAPH_DISCOVERY_UNAVAILABLE with no items and no cursor, never an advanced cursor into the other store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { freePort, waitForHttp, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { BK as BKG } from '../core/graph-vocab.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'a1607-test';
const EX = 'urn:ex:';
const commitOf = (token) => Number(String(token).split('.')[3]);
const SCAN = `<${EX}outcome>`;   // the operation scan's signature: only opBatch reads receipt outcomes on a feed poll

/** A proxy in front of the executor: counts operation scans, and can send every query after the Nth to another executor. */
async function startProxy(execUrl) {
  const p = { scans: 0, queries: 0, swap: null };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let target = execUrl;
    if (req.url.startsWith('/query')) {
      p.queries++;
      if (body.toString('utf8').includes(SCAN)) p.scans++;
      if (p.swap && ++p.swap.seen > p.swap.after) target = p.swap.to;
    }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${target}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body } : {}) });
      const t = Buffer.from(await f.arrayBuffer());
      res.statusCode = f.status; res.setHeader('Content-Type', f.headers.get('content-type') || 'application/json'); res.end(t);
    } catch (e) { res.statusCode = 502; res.end(String(e.message)); }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

async function spawnServer(boardFile, execUrl) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '',
    SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'a1607-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `a1607-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `a1607-${port}`,
    SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}
async function stack(body) {
  const store = tmpStore('a1607-store-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1607-'));
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture({ conversations: [] }), null, 2));
  const srv = await spawnServer(file, proxy.url);
  try { return await body({ base: srv.base, execUrl: exec.baseUrl, proxy, stderr: srv.stderr }); }
  finally { srv.stop(); await proxy.stop(); await killExecutor(exec); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
}

async function api(base, method, route, body) {
  const r = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const say = async (s, body) => { const r = await api(s.base, 'POST', '/api/conversations', { author: 'ada', body }); assert.equal(r.status, 201, r.text); return r.body.id; };
const feed = (s, after, limit = 50) => api(s.base, 'GET', `/api/conversations?afterCommit=${encodeURIComponent(after)}&limit=${limit}`);
const tip = async (s) => { const r = await feed(s, 'tip'); assert.equal(r.status, 200, r.text); return r.body.nextAfterCommit; };
async function head(execUrl) {
  const r = await fetch(`${execUrl}/query`, { method: 'POST', body: `SELECT ?s WHERE { GRAPH ${BKG} { <${EX}dataset> <${EX}commitSeq> ?s } }` });
  const j = await r.json(); const rows = j.results?.bindings || [];
  assert.equal(rows.length, 1, `one marker: ${JSON.stringify(j).slice(0, 200)}`);
  return Number(rows[0].s.value);
}
let raw = 0;
/** A NON-post commit: the marker moves and an APPLIED receipt is written for an op that is not a post operation. */
async function nonPostCommit(execUrl) {
  const op = `${EX}op/raw/a1607-${process.pid}-${++raw}`;
  const r = await fetch(`${execUrl}/update`, { method: 'POST', headers: { 'x-op-id': op }, body: `DELETE { GRAPH ${BKG} { <${EX}dataset> <${EX}commitSeq> ?s } }
INSERT { GRAPH ${BKG} { <${EX}dataset> <${EX}commitSeq> ?s1 . <${op}> <${EX}commitSeq> ?s1 ; <${EX}outcome> <${EX}APPLIED> } }
WHERE { GRAPH ${BKG} { <${EX}dataset> <${EX}commitSeq> ?s } BIND(?s + 1 AS ?s1) }` });
  assert.ok(r.status < 300, `non-post commit refused: ${r.status} ${await r.text()}`);
}

test('S1 NON-POST COMMIT: the next empty poll advances to the head it read, and the poll after that makes no operation scan', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await say(s, 'first');
    const cur = await tip(s);
    await nonPostCommit(s.execUrl); await nonPostCommit(s.execUrl);
    const h = await head(s.execUrl);
    assert.equal(h, commitOf(cur) + 2, 'control: two non-post commits moved the head past the cursor');

    const p1 = await feed(s, cur);
    assert.equal(p1.status, 200, p1.text);
    assert.deepEqual(p1.body.conversations, [], 'nothing was posted, so nothing is delivered');
    assert.equal(commitOf(p1.body.nextAfterCommit), h, 'an exhausted empty page answers the head it read, not its own cursor');

    const before = s.proxy.scans;
    const p2 = await feed(s, p1.body.nextAfterCommit);
    assert.equal(p2.status, 200, p2.text);
    assert.deepEqual(p2.body.conversations, []);
    assert.equal(p2.body.nextAfterCommit, p1.body.nextAfterCommit, 'idle at the head: its own cursor back');
    assert.equal(s.proxy.scans - before, 0, 'the second poll took the idle path: no operation scan');

    const id = await say(s, 'second');
    const p3 = await feed(s, p2.body.nextAfterCommit);
    assert.deepEqual(p3.body.conversations.map((c) => c.id), [id], 'control: a later post is still delivered');
    const p4 = await feed(s, p3.body.nextAfterCommit);
    assert.deepEqual(p4.body.conversations, [], 'and only once');
  });
});

test('S2 LIMIT-STOPPED keeps the last delivered commit; the EXHAUSTED page after it delivers the rest once and advances to the head', { skip: SKIP }, async () => {
  await stack(async (s) => {
    const cur = await tip(s);
    const ids = [await say(s, 'a'), await say(s, 'b'), await say(s, 'c')];
    await nonPostCommit(s.execUrl);
    const h = await head(s.execUrl);

    const p1 = await feed(s, cur, 2);
    assert.equal(p1.status, 200, p1.text);
    assert.deepEqual(p1.body.conversations.map((c) => c.id), ids.slice(0, 2));
    assert.equal(commitOf(p1.body.nextAfterCommit), p1.body.conversations[1].commitSeq, 'a page stopped by its limit returns the last DELIVERED commit');
    assert.ok(commitOf(p1.body.nextAfterCommit) < h, 'control: that is below the head, so the third post is still owed');

    const p2 = await feed(s, p1.body.nextAfterCommit, 2);
    assert.deepEqual(p2.body.conversations.map((c) => c.id), [ids[2]], 'the remainder, once');
    assert.equal(commitOf(p2.body.nextAfterCommit), h, 'the exhausted page advances past the trailing non-post commit to the head');

    const p3 = await feed(s, p2.body.nextAfterCommit, 2);
    assert.deepEqual(p3.body.conversations, [], 'nothing is delivered twice');
  });
});

test('S4 A REDACTION ACROSS THE ADVANCE: a consumer that received a post receives its redaction once, even with non-post commits after it, and only then advances to the head', { skip: SKIP }, async () => {
  await stack(async (s) => {
    const cur = await tip(s);
    const id = await say(s, 'to be redacted');
    const got = await feed(s, cur);
    assert.deepEqual(got.body.conversations.map((c) => c.id), [id], 'control: the consumer received the post');
    const r = await createGraphClient({ baseUrl: s.execUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `${EX}op/redact/a1607-s4`,
      actor: 'https://scrumboard.local/person/ada', post: { id }, authorityRef: 'test-authority-ref', occurredAt: '2026-11-24T00:00:00.000Z' });
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    await nonPostCommit(s.execUrl); await nonPostCommit(s.execUrl);
    const h = await head(s.execUrl);

    const p = await feed(s, got.body.nextAfterCommit);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.conversations.length, 1, `exactly one item: the redaction (${p.text.slice(0, 300)})`);
    const [item] = p.body.conversations;
    assert.equal(item.op, 'redact'); assert.equal(item.id, id); assert.equal(item.redacted, true); assert.equal(item.body, null);
    assert.ok(item.commitSeq < h, 'control: the redaction is below the head, with non-post commits above it');
    assert.equal(commitOf(p.body.nextAfterCommit), h, 'having delivered it, the exhausted page advances past the non-post commits to the head');

    const before = s.proxy.scans;
    const q = await feed(s, p.body.nextAfterCommit);
    assert.deepEqual(q.body.conversations, [], 'the redaction is not delivered twice');
    assert.equal(s.proxy.scans - before, 0, 'and the next poll is idle');
  });
});

test('S3 THE IDENTITY FENCE ON THE ADVANCING PATH: a store swapped mid-poll is 503 with no items and no cursor', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await say(s, 'first');
    const cur = await tip(s);
    await nonPostCommit(s.execUrl);
    const otherStore = tmpStore('a1607-other-');
    const other = await startExecutor({ store: otherStore, datasetId: DSID, create: true });
    try {
      s.proxy.swap = { after: 1, to: other.baseUrl, seen: 0 };   // the marker read answers from the real store; every later read from the other
      const r = await feed(s, cur);
      s.proxy.swap = null;
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.code, 'GRAPH_DISCOVERY_UNAVAILABLE');
      assert.equal(r.body.conversations, undefined, 'no items');
      assert.equal(r.body.nextAfterCommit, undefined, 'no cursor, advanced or otherwise');
      const again = await feed(s, cur);
      assert.equal(again.status, 200, `control: the genuine cursor still works once the real store answers: ${again.text}`);
    } finally { await killExecutor(other); fs.rmSync(otherStore, { recursive: true, force: true }); }
  });
});
