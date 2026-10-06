/**
 * NO MENTION SCAN WITHOUT AN EFFECTIVE MENTION WAKE (#1608, narrowed by the contract owner's 04:55Z ruling and accepted at 04:55Z: "for channel mode: skip the mention scan and the pair-cap history read when
 * `effectiveWakeOn` lacks `mention`; channel delivery still produces the by-id read and wake; wake-mode residents retain their existing scan behaviour"). Written by the separate test author, before the build,
 * to that ruling. The durable-pending contract for WAKE-MODE residents is a separate slice (#1612) and its rows are in wake-mode-pending-s1.test.mjs, marked todo.
 *
 * THE REAL RUNNER (`scripts/guest-once.mjs`), a REAL REST server, a fake model that records every call, and a RECORDING PROXY between the runner and the board that remembers EVERY GET. No executor is needed.
 *
 *   R1 THE DELIVERY PATH STILL WORKS   A channel-mode resident with one open delivery for a post: the runner reads that post BY ID, makes exactly one model call whose prompt carries the post, and the delivery ends
 *                                      settled (no open deliveries). The unchanged path is DEMONSTRATED here, not assumed from the untouched code.
 *   R2 NO UNUSED SCAN                  In that same kind of pass the runner makes NO request to the conversation list at all: neither the mention scan nor the pair-cap history read (both are `GET /api/conversations?...`).
 *   R3 AN IDLE CHANNEL SEAT READS NOTHING   Channel mode, no deliveries, a cursor frozen 3 h ago and 450 posts since. Two passes (two new posts between them) make no model call and no request to the conversation list.
 *                                      This is the case that was costing 25 pages a minute.
 *   R4 WAKE MODE KEEPS ITS SCAN        A resident that takes mention wakes (not channel mode), one mention in its window: the pass makes a list request of the existing shape (`attachedTo=null&since=...&limit=500`), one model call carrying the
 *                                      mention and posts one reply, and the cursor (`lastAnsweredId`) names that mention: unchanged behaviour, pinned so the change cannot reach it.
 *
 * NOT COVERED, by name: `--once-id` (a hand run; the build says it still scans, and no row pins it); the durable-pending contract for wake-mode residents (#1612, deferred); assignment and schedule wakes; a delivery for a
 * post that is redacted (TB1 owns it); the model's reply text; the pair cap between two residents; and the ledger itself (its state machine is the board's, and R1 reads only its open set).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';

const MIN = 60000;
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROSTER_FILE = path.join(os.tmpdir(), `s1r-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

/** A fake Ollama. `mode`: 'reply' (a published reply), 'decline' (a NO_REPLY line), 'down' (the connection is dropped), 'hang' (the request is never answered). Every request is recorded with a sequence number. */
function fakeOllama(seq) {
  const o = { mode: 'reply', calls: [], firstSeq: null, conns: new Set() };
  const srv = http.createServer((req, res) => {
    o.conns.add(req.socket);
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const n = ++seq.n; if (o.firstSeq === null) o.firstSeq = n;
      o.calls.push({ seq: n, body: raw });
      if (o.mode === 'down') { req.socket.destroy(); return; }
      if (o.mode === 'hang') return;
      const content = o.mode === 'decline' ? 'NO_REPLY' : 'REPLY: Gizmo here.';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => { o.baseUrl = `http://127.0.0.1:${srv.address().port}`; o.stop = () => new Promise((r) => { for (const s of o.conns) { try { s.destroy(); } catch { /* gone */ } } srv.close(() => r()); }); resolve(o); }));
}

/** A recording proxy to the board: remembers every GET of the conversation list with its place in the sequence and how many rows came back. */
function recordingProxy(target, seq) {
  const reqs = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const n = ++seq.n;
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    try {
      const f = await fetch(`${target}${req.url}`, { method: req.method, headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) });
      const buf = Buffer.from(await f.arrayBuffer());
      if (req.method === 'GET') { let rows = null; if (req.url.startsWith('/api/conversations?')) { try { const j = JSON.parse(buf.toString('utf8')); rows = (Array.isArray(j) ? j : (j.conversations ?? [])).length; } catch { /* not a list */ } } reqs.push({ seq: n, url: req.url, rows }); }
      const out = Object.fromEntries([...f.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)));
      res.writeHead(f.status, out); res.end(buf);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ reqs, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) })));
}

const iso = (ageMin) => new Date(Date.now() - ageMin * MIN).toISOString();
const post = (id, seq, body, ageMin, mentions = []) => ({ id, body, author: 'ada', attachedTo: null, attachments: [], mentions, postSeq: seq, createdAt: iso(ageMin) });
const mention = (id, seq, tag, ageMin) => post(id, seq, `@gizmo please look. ${tag}`, ageMin, ['gizmo']);
const fillers = (n, firstAgeMin, lastAgeMin, startSeq) => Array.from({ length: n }, (_, i) => post(`f-${startSeq + i}`, startSeq + i, `filler ${startSeq + i}`, firstAgeMin - (i * (firstAgeMin - lastAgeMin)) / Math.max(1, n - 1)));

async function stack(docPosts, body, { channel = false, state = null } = {}) {
  const seq = { n: 0 };
  const ollama = await fakeOllama(seq);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: docPosts.length + 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const proxy = await recordingProxy(rest.baseUrl, seq);
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's1r-')), 'gizmo.state.json');
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  const children = new Set();
  try {
    const made = await api(rest.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: channel ? 'resident' : 'guest', contextPolicy: 'artifact-only', by: 'ada', ...(channel ? { deliveryMode: 'channel' } : {}) });
    assert.equal(made.status, 201, `the resident is created: ${made.text}`);
    const start = () => {
      const mark = proxy.reqs.length; const callsBefore = ollama.calls.length; ollama.firstSeq = null;
      const p = spawn(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'guest-once.mjs'), '--seat', 'gizmo'], { env: { ...process.env, SCRUM_BOARD_URL: proxy.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(p);
      let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
      const done = new Promise((resolve) => p.on('close', (code) => { children.delete(p); resolve({ code, out, err, mark, callsBefore }); }));
      return { child: p, done };
    };
    const scanReqs = (r) => proxy.reqs.slice(r.mark).filter((q) => ollama.firstSeq === null || q.seq < ollama.firstSeq);
    const s = {
      base: rest.baseUrl, ollama, proxy, stateFile, start, scanReqs,
      pass: async () => { const r = await start().done; assert.equal(r.code, 0, `the runner ends clean: ${r.err}${r.out}`); r.scan = scanReqs(r); r.calls = ollama.calls.slice(r.callsBefore); r.reqs = proxy.reqs.slice(r.mark); return r; },
      state: () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } },
      post: (text) => api(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: text }),
      replies: async () => { const r = await api(rest.baseUrl, 'GET', '/api/conversations?attachedTo=null&limit=200'); return (Array.isArray(r.body) ? r.body : r.body.conversations).filter((m) => m.author === 'gizmo'); },
    };
    return await body(s);
  } finally { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } await proxy.stop(); await rest.stop(); await ollama.stop(); }
}
const rowsOf = (reqs) => reqs.reduce((a, q) => a + (q.rows ?? 0), 0);
const sinceOf = (q) => new URL(q.url, 'http://x').searchParams.get('since');
const pendingOf = (st) => (Array.isArray(st.pending) ? st.pending : []);
const ALLOWED_KEYS = new Set(['attachedTo', 'since', 'before', 'limit', 'mentions_me']);


const listReqs = (reqs) => reqs.filter((q) => q.url.startsWith('/api/conversations?'));
const byIdReqs = (reqs, id) => reqs.filter((q) => q.url === `/api/conversations/${id}` || q.url.startsWith(`/api/conversations/${id}?`));
const offer = async (s, id) => { const d = await api(s.base, 'POST', '/api/deliveries', { to: 'gizmo', conversation: id, source: 'fanout', by: 'board' }); assert.equal(d.status, 201, `the offer: ${d.text}`); return d; };

test('R1 THE DELIVERY PATH STILL WORKS: a channel-mode resident reads the delivered post by id, makes one model call carrying it, and the delivery ends settled', { timeout: 120000 }, async () => {
  await stack([post('d1', 1, 'a delivered post. r1-marker', 2, ['gizmo'])], async (s) => {
    await offer(s, 'd1');
    const p = await s.pass();
    assert.ok(byIdReqs(p.reqs, 'd1').length >= 1, `the post is read BY ID: ${p.reqs.map((q) => q.url).join(' | ').slice(0, 300)}`);
    assert.equal(p.calls.length, 1, `exactly one model call: ${p.calls.length}`);
    assert.ok(p.calls[0].body.includes('r1-marker'), 'and its prompt carries the delivered post');
    const open = await api(s.base, 'GET', '/api/deliveries?to=gizmo&open=1');
    assert.deepEqual(open.body.deliveries ?? [], [], `the delivery is settled after the pass: ${open.text.slice(0, 200)}`);
  }, { channel: true });
});

test('R2 NO UNUSED SCAN: a channel-mode pass that handles a delivery makes no request to the conversation list', { timeout: 120000 }, async () => {
  await stack([post('d1', 1, 'a delivered post. r2-marker', 2, ['gizmo'])], async (s) => {
    await offer(s, 'd1');
    const p = await s.pass();
    assert.equal(p.calls.length, 1, 'CONTROL: the delivery was handled (one model call)');
    assert.deepEqual(listReqs(p.reqs).map((q) => q.url), [], 'no mention scan and no pair-cap history read: not one GET of /api/conversations?...');
  }, { channel: true });
});

test('R3 AN IDLE CHANNEL SEAT READS NOTHING: with no deliveries, a frozen cursor and 450 posts since, two passes make no model call and no request to the conversation list', { timeout: 180000 }, async () => {
  await stack(fillers(450, 170, 2, 1), async (s) => {
    const p1 = await s.pass();
    assert.equal(p1.calls.length, 0, 'CONTROL: nothing to answer');
    assert.deepEqual(listReqs(p1.reqs).map((q) => q.url), [], `the first pass reads no conversation list (it read ${rowsOf(listReqs(p1.reqs))} rows)`);
    for (const t of ['r3 new one', 'r3 new two']) assert.equal((await s.post(t)).status, 201);
    const p2 = await s.pass();
    assert.equal(p2.calls.length, 0);
    assert.deepEqual(listReqs(p2.reqs).map((q) => q.url), [], 'and neither does the second');
  }, { channel: true, state: { lastAnsweredAt: iso(180) } });
});

test('R4 WAKE MODE KEEPS ITS SCAN: a resident that takes mention wakes still scans with the existing request shape, wakes once on its mention, replies, and moves its cursor to it', { timeout: 120000 }, async () => {
  await stack([mention('m1', 1, 'r4-marker', 3)], async (s) => {
    const p = await s.pass();
    const lists = listReqs(p.reqs);
    assert.ok(lists.length >= 1, 'the pass scans');
    assert.ok(/^\/api\/conversations\?attachedTo=null&since=[^&]+&limit=500/.test(lists[0].url), `the scan keeps its shape: ${lists[0].url}`);
    assert.equal(p.calls.length, 1, 'one model call');
    assert.ok(p.calls[0].body.includes('r4-marker'), 'carrying the mention');
    assert.equal((await s.replies()).length, 1, 'and one reply is posted');
    assert.equal(s.state().lastAnsweredId, 'm1', 'the cursor names the mention');
  });
});
