/**
 * #1825 — the export reads every kind from where that kind LIVES, and says so when it cannot prove it got all of it.
 *
 * Observed 2026-11-07: an export taken on a board running the graph units wrote "Commons messages: 0" and "Total messages on the
 * board: 0 (all accounted for)". The posts were on the board. export-board.mjs read one source, GET /api/board, and since
 * #1582/#1626 that route deliberately leaves out the collections whose record is the graph (posts, deliveries, model calls).
 *
 * Rows:
 *   G1  a board under the graph conversations unit: the export holds the board's posts (board-level and card-attached), not 0
 *       (the real REST and a real executor)
 *   F1  model calls are read from their route under their own key (`calls`), so the export holds them
 *   F2  a source that answers without its declared key REFUSES the export, naming the route and the key (exit 1)
 *   F3  deliveries are read with all=1: the route's bare form is active + last 24 h, and the export holds the WHOLE history
 *   F4  a count planted to disagree (the board's graph holds 5 posts, the list serves 2) ⇒ exit 1, INDEX says INCOMPLETE and names
 *       the kind and both numbers, and never says "all accounted for"
 *   F5  postSeq holes are DIAGNOSTIC (PO 50927): listed in the INDEX with a count, and the export still succeeds
 *   F6  a kind whose recount cannot be taken is UNVERIFIED in the INDEX, never matched, and the export still succeeds
 *   F7  every recount is labelled "recounted, same store": the second count comes from the same graph, so nothing is called matched
 * Rows F1–F7 run against a small fake board (this file's own), so each fault can be planted exactly. G1 is the real thing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { PROJECT_DIR } from './helpers/harness.mjs';

const EXPORTER = path.join(PROJECT_DIR, 'export-board.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'x1825-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));   // #1672: this file's own temp, and only that

const runExport = (base, spaces, dir) => spawnSync(process.execPath, [EXPORTER, '--out', dir, '--base', base, '--raw', '--spaces', spaces],
  { encoding: 'utf8', timeout: 120000 });
const indexOf = (dir) => fs.readFileSync(path.join(dir, '00-INDEX.md'), 'utf8');
const allParts = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('part-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

test('#1825 G1: under the graph conversations unit the export holds the board\'s posts, board-level and card-attached, not 0', T, async () => {
  const w = await wholeBoardWorld();
  try {
    // PRECONDITION: the posts are on the board, served by their own route (the fixture has one board post and one card post)
    const listed = await (await fetch(`${w.rest.baseUrl}/api/conversations`)).json();
    assert.equal(listed.length, 2, `PRECONDITION: the board serves its 2 posts (got ${listed.length})`);
    const board = await (await fetch(`${w.rest.baseUrl}/api/board`)).json();
    assert.equal(board.conversations, undefined, 'PRECONDITION: /api/board leaves the posts out under the unit (the shape that hid them)');

    const dir = path.join(OUT, 'g1');
    const r = runExport(w.rest.baseUrl, 'cards,commons', dir);
    assert.equal(r.status, 0, `the export ran (exit ${r.status}): ${(r.stdout + r.stderr).slice(-600)}`);
    const idx = indexOf(dir);
    assert.match(idx, /\*\*Total messages on the board:\*\* 2\b/, `the index counts both posts:\n${idx.slice(0, 900)}`);
    const parts = allParts(dir);
    assert.ok(parts.includes('a board post'), 'the board-level post is in the archive');
    assert.ok(parts.includes('a card post'), 'the card-attached post is in the archive, on its card');
  } finally { await w.stop(); }
});

// ── F rows: a fake board whose every answer this file chooses ─────────────────
const NOW = '2026-11-07T00:00:00.000Z';
const fakeCard = { id: 'uuid-1', shortId: 1, title: 'card one', description: 'body', type: 'task', assignees: [], labels: [], column: 'backlog', order: 1, createdAt: NOW, updatedAt: NOW, createdBy: 'ada', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] } };
const post = (n, extra = {}) => ({ id: `p-${n}`, postSeq: n, author: 'ada', body: `post number ${n}`, attachedTo: null, createdAt: `2026-11-07T00:00:0${n}.000Z`, attachments: [], mentions: [], ...extra });
const delivery = (n) => ({ id: `d-${n}`, to: 'ada', conversation: 'p-1', offeredAt: `2026-1${n}-01T00:00:00.000Z` });

/**
 * Serve a board. `posts`, `calls`, `deliveries` are the full records; `counts` maps a kind (as the registry names it) to what the graph
 * COUNT answers, or to 'fail' for a 503. `deliveriesRecent` is what the bare /api/deliveries serves (the route's 24-hour bound);
 * `callsKey` is the key /api/model-calls answers under.
 */
function fakeBoard({ posts = [], calls = [], deliveries = [], deliveriesRecent = [], callsKey = 'calls', counts = {} } = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && u.pathname === '/api/graph') {
      let raw = ''; for await (const c of req) raw += c;
      const q = JSON.parse(raw).query;
      const kind = (/\ba\s+(\S+)\s*\}/.exec(q) || [])[1];
      const n = counts[kind];
      if (n === undefined || n === 'fail') return send(503, { error: 'graph unavailable (planted)' });
      return send(200, { rows: [{ n: String(n) }], truncated: false });
    }
    if (u.pathname === '/api/board') return send(200, { cards: [fakeCard], columns: [{ id: 'backlog', name: 'Backlog' }] });
    if (['/api/decisions', '/api/kinds', '/api/predicates', '/api/wakes'].includes(u.pathname)) return send(200, []);
    if (u.pathname === '/api/memories') return send(200, { total: 0, memories: [] });
    if (u.pathname === '/api/conversations') return send(200, u.searchParams.get('limit') ? posts.slice(-Number(u.searchParams.get('limit'))) : posts, { 'X-Total-Count': String(posts.length) });
    if (u.pathname === '/api/model-calls') return send(200, { [callsKey]: calls, count: calls.length });
    if (u.pathname === '/api/deliveries') { const d = u.searchParams.get('all') === '1' ? deliveries : deliveriesRecent; return send(200, { deliveries: d, count: d.length }); }
    return send(404, { error: `fake board: no route ${u.pathname}` });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((d) => srv.close(d)) })));
}
// the exporter runs as a child process; spawnSync would block this process's event loop, and the fake board lives in it
const exportAsync = (base, spaces, dir) => new Promise((ok) => {
  const ch = spawn(process.execPath, [EXPORTER, '--out', dir, '--base', base, '--raw', '--spaces', spaces], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; ch.stdout.on('data', (b) => { out += b; }); ch.stderr.on('data', (b) => { out += b; });
  ch.on('close', (status) => ok({ status, out }));
});
let nDir = 0;
const fresh = () => path.join(OUT, `f${++nDir}`);
const COMMENT = 'schema:Comment';

test('#1825 F1: model calls are read from their own route under their own key (`calls`), so the export holds them', async () => {
  const calls = [{ '@id': 'https://scrumboard.local/model-call/mc-1', agent: 'gizmo' }, { '@id': 'https://scrumboard.local/model-call/mc-2', agent: 'gizmo' }];
  const b = await fakeBoard({ calls, counts: { 'scrum:ModelCall': 2, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,model-calls', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    assert.match(indexOf(dir), /\*\*model-calls\*\* \(`scrum:ModelCall`\) — 2\b/, indexOf(dir).slice(0, 1500));
    assert.ok(allParts(dir).includes('mc-2'), 'the second call is in the archive');
  } finally { await b.close(); }
});

test('#1825 F2: a source that answers without its declared key refuses the export, naming the route and the key', async () => {
  const b = await fakeBoard({ calls: [{ '@id': 'mc-1' }], callsKey: 'rows', counts: { 'scrum:ModelCall': 1, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,model-calls', dir);
    assert.equal(r.status, 1, `refused (exit 1), got ${r.status}: ${r.out.slice(-400)}`);
    assert.match(r.out, /\/api\/model-calls/, 'the refusal names the route');
    assert.match(r.out, /\bcalls\b/, 'and the key it expected');
  } finally { await b.close(); }
});

test('#1825 F3: deliveries are read with all=1, so the export holds the whole history, not the route\'s last 24 hours', async () => {
  const all = [delivery(0), delivery(1), delivery(2)];
  const b = await fakeBoard({ deliveries: all, deliveriesRecent: [all[2]], counts: { 'scrum:Delivery': 3, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,deliveries', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    assert.match(indexOf(dir), /\*\*deliveries\*\* \(`scrum:Delivery`\) — 3\b/, indexOf(dir).slice(0, 1500));
    assert.ok(b.seen.some((s) => s.startsWith('GET /api/deliveries') && /[?&]all=1\b/.test(s)), `the read asked for all=1: ${b.seen.join(' | ')}`);
  } finally { await b.close(); }
});

test('#1825 F4: a count planted to disagree ⇒ exit 1, the INDEX says INCOMPLETE naming the kind and both numbers, and never "all accounted for"', async () => {
  const b = await fakeBoard({ posts: [post(1), post(2)], counts: { [COMMENT]: 5, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,commons', dir);
    assert.equal(r.status, 1, `exit 1 on a mismatch, got ${r.status}: ${r.out.slice(-400)}`);
    const idx = indexOf(dir);
    assert.match(idx, /INCOMPLETE/, idx.slice(0, 1500));
    assert.match(idx, /commons[^\n]*wrote 2[^\n]*5|commons[^\n]*5[^\n]*wrote 2/, 'names the kind, what was written and what the board holds');
    assert.doesNotMatch(idx, /all accounted for/, 'an incomplete export never says all accounted for');
  } finally { await b.close(); }
});

test('#1825 F5: postSeq holes are diagnostic — listed in the INDEX with a count — and the export still succeeds', async () => {
  const b = await fakeBoard({ posts: [post(1), post(2), post(4)], counts: { [COMMENT]: 3, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,commons', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    assert.match(indexOf(dir), /postSeq holes[^\n]*\b1\b[^\n]*\b3\b/, `the hole (1 of them, at 3) is listed:\n${indexOf(dir).slice(0, 1500)}`);
  } finally { await b.close(); }
});

test('#1825 F6: a kind whose recount cannot be taken is UNVERIFIED, never matched, and the export still succeeds', async () => {
  const b = await fakeBoard({ posts: [post(1)], counts: { [COMMENT]: 'fail', 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,commons', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    assert.match(indexOf(dir), /commons[^\n]*unverified/i, indexOf(dir).slice(0, 1500));
    assert.doesNotMatch(indexOf(dir), /commons[^\n]*\bmatched\b/i);
  } finally { await b.close(); }
});

test('#1825 F7: an agreeing recount from the same graph is labelled "recounted, same store", never "matched"', async () => {
  const b = await fakeBoard({ posts: [post(1), post(2)], counts: { [COMMENT]: 2, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,commons', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    const idx = indexOf(dir);
    assert.match(idx, /commons[^\n]*recounted, same store/, idx.slice(0, 1500));
    assert.match(idx, /cards[^\n]*recounted, same store/);
    assert.doesNotMatch(idx, /\bmatched\b/, 'nothing is called matched: no independent store was consulted');
  } finally { await b.close(); }
});
