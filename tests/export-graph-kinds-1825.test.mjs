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
 *   F8  a collection holding heads AND versions (agent prompts: 1 prompt + 2 versions) is recounted by each row's own @type and
 *       summed, so 3 written against 1 head + 2 versions is recounted, not a false INCOMPLETE (found on the live board, 20:22Z:
 *       procedures 8 vs 3 and agent-prompts 11 vs 2 were heads + versions counted against the head type alone)
 *   F9  rows typed with a GENERIC type other entities share (runs as prov:Activity, which every write receipt also is) are not
 *       counted by that type: the kind is unverified, never a false INCOMPLETE (live board, 20:24Z: runs 31 vs 117,518)
 * Rows F1–F9 run against a small fake board (this file's own), so each fault can be planted exactly. G1 is the real thing.
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
function fakeBoard({ posts = [], calls = [], deliveries = [], deliveriesRecent = [], callsKey = 'calls', counts = {}, doc = {}, pager = 'ok' } = {}) {
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
    if (u.pathname === '/api/board') return send(200, { cards: [fakeCard], columns: [{ id: 'backlog', name: 'Backlog' }], ...doc });
    if (['/api/decisions', '/api/kinds', '/api/predicates', '/api/wakes'].includes(u.pathname)) return send(200, []);
    if (u.pathname === '/api/memories') return send(200, { total: 0, memories: [] });
    if (u.pathname === '/api/conversations') return send(200, u.searchParams.get('limit') ? posts.slice(-Number(u.searchParams.get('limit'))) : posts, { 'X-Total-Count': String(posts.length) });
    if (u.pathname === '/api/model-calls') return send(200, { [callsKey]: calls, count: calls.length });
    if (u.pathname === '/api/deliveries') {
      const d = u.searchParams.get('all') === '1' ? deliveries : deliveriesRecent;
      // #1826 — with limit/after the route answers a page and its `next` cursor. The fake pages TWO at a time whatever
      // limit asks, so an export of 3 deliveries is a real two-page walk.
      if (!u.searchParams.has('limit') && !u.searchParams.has('after')) return send(200, { deliveries: d, count: d.length });
      const from = Number(u.searchParams.get('after') ?? 0); const page = d.slice(from, from + 2);
      // `pager` plants a broken page: 'no-next' drops the cursor field, 'stuck' answers the cursor it was sent.
      if (pager === 'no-next') return send(200, { deliveries: page, count: page.length });
      if (pager === 'stuck' && u.searchParams.has('after')) return send(200, { deliveries: page, count: page.length, next: u.searchParams.get('after') });
      return send(200, { deliveries: page, count: page.length, next: from + 2 < d.length ? String(from + 2) : null });
    }
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

test('#1825 F8: a collection of heads AND versions is recounted by each row\'s own @type, summed — not a false INCOMPLETE', async () => {
  const AP = 'https://scrumboard.local/agent-prompt/guest';
  const agentPrompts = [
    { '@id': AP, '@type': 'scrum:AgentPrompt', 'scrum:currentVersion': `${AP}/v2` },
    { '@id': `${AP}/v1`, '@type': 'scrum:AgentPromptVersion', 'scrum:version': 1 },
    { '@id': `${AP}/v2`, '@type': 'scrum:AgentPromptVersion', 'scrum:version': 2 },
  ];
  const b = await fakeBoard({ doc: { agentPrompts }, counts: { 'scrum:AgentPrompt': 1, 'scrum:AgentPromptVersion': 2, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,agent-prompts', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    const idx = indexOf(dir);
    assert.match(idx, /agent-prompts[^\n]*wrote 3[^\n]*recounted, same store/, idx.slice(0, 1800));
    assert.doesNotMatch(idx, /INCOMPLETE/);
  } finally { await b.close(); }
});

test('#1825 F9: rows typed with a generic shared type (runs as prov:Activity) are unverified, never a false INCOMPLETE', async () => {
  const runs = [{ '@id': 'https://scrumboard.local/run/r-1', '@type': 'prov:Activity' }, { '@id': 'https://scrumboard.local/run/r-2', '@type': 'prov:Activity' }];
  const b = await fakeBoard({ doc: { runs }, counts: { 'prov:Activity': 1000, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,runs', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    const idx = indexOf(dir);
    assert.match(idx, /\*\*runs\*\*[^\n]*wrote 2[^\n]*unverified/, idx.slice(0, 1800));
    assert.doesNotMatch(idx, /INCOMPLETE/);
  } finally { await b.close(); }
});

test('#1825 F9b: a typed kind whose rows carry a type it does not own is unverified, never counted by the foreign type', async () => {
  const agentPrompts = [{ '@id': 'https://scrumboard.local/agent-prompt/x', '@type': 'scrum:AgentPrompt' }, { '@id': 'https://scrumboard.local/agent-prompt/x/act', '@type': 'prov:Activity' }];
  const b = await fakeBoard({ doc: { agentPrompts }, counts: { 'scrum:AgentPrompt': 1, 'prov:Activity': 1, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,agent-prompts', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    const idx = indexOf(dir);
    assert.match(idx, /agent-prompts[^\n]*unverified[^\n]*prov:Activity/, `a sum that happens to agree (1 + 1 = 2) must not pass a foreign type:\n${idx.slice(0, 1800)}`);
  } finally { await b.close(); }
});

test('#1826 F3b: the deliveries walk asks for pages and follows `next` to the end (3 deliveries, two pages)', async () => {
  const all = [delivery(1), delivery(2), delivery(3)];
  const b = await fakeBoard({ deliveries: all, counts: { 'scrum:Delivery': 3, 'scrum:Card': 1 } });
  try {
    const dir = fresh(); const r = await exportAsync(b.base, 'cards,deliveries', dir);
    assert.equal(r.status, 0, r.out.slice(-600));
    const reads = b.seen.filter((x) => x.startsWith('GET /api/deliveries'));
    assert.equal(reads.length, 2, `two pages were read: ${reads.join(' | ')}`);
    assert.ok(reads.every((x) => /[?&]all=1\b/.test(x) && /[?&]limit=\d+/.test(x)), `every page is the whole history, bounded: ${reads.join(' | ')}`);
    assert.match(reads[1], /[?&]after=2\b/, 'the second page sends back the first page\'s cursor');
    assert.ok(allParts(dir).includes('d-3'), 'the delivery on the second page is in the archive');
  } finally { await b.close(); }
});

for (const [pager, why] of [['no-next', /without its `next` cursor/], ['stuck', /same cursor twice/]]) {
  test(`#1826 F3c: a deliveries page that ${pager === 'no-next' ? 'drops its cursor' : 'repeats its cursor'} refuses the export, never a short archive`, async () => {
    const b = await fakeBoard({ deliveries: [delivery(1), delivery(2), delivery(3)], pager, counts: { 'scrum:Delivery': 3, 'scrum:Card': 1 } });
    try {
      const dir = fresh(); const r = await exportAsync(b.base, 'cards,deliveries', dir);
      assert.notEqual(r.status, 0, `the export refuses: ${r.out.slice(-400)}`);
      assert.match(r.out, why);
    } finally { await b.close(); }
  });
}

// ── P rows: the Settings picker counts what the exporter reads ────────────────
// Observed 2026-11-18: the exporter, read from each kind's own route, wrote commons 55014, deliveries 25089, model calls 8488, wakes 16
// and memories 2175, while GET /api/export/spaces (the counts beside the Settings checkboxes) said 0 for all five, because it counted
// the document GET /api/board serves, which leaves those collections out under the graph units. A person deciding what to export
// read those zeros. The picker now reads the same routes the exporter does, and a route it cannot read is "not read", never 0.
const pickerCounts = async (base) => {
  const r = await fetch(`${base}/api/export/spaces`);
  assert.equal(r.status, 200, 'the menu answers');
  return Object.fromEntries((await r.json()).spaces.map((x) => [x.space, x.count]));
};

test('#1825 P1: under the graph units the picker counts the posts and memories its routes serve, not the document\'s 0', T, async () => {
  const w = await wholeBoardWorld({ logborn: true });
  try {
    const posts = await (await fetch(`${w.rest.baseUrl}/api/conversations`)).json();
    const mems = await (await fetch(`${w.rest.baseUrl}/api/memories`)).json();
    assert.equal(posts.length, 2, 'PRECONDITION: the route serves the 2 posts');
    assert.equal(mems.memories.length, 1, 'PRECONDITION: the route serves the 1 memory');
    const board = await (await fetch(`${w.rest.baseUrl}/api/board`)).json();
    assert.equal(board.conversations, undefined, 'PRECONDITION: /api/board leaves the posts out (the shape that made the picker say 0)');
    const c = await pickerCounts(w.rest.baseUrl);
    assert.equal(c.commons, 2, `the picker counts the posts the route serves (got ${c.commons})`);
    assert.equal(c.memories, 1, `the picker counts the memory the route serves (got ${c.memories})`);
    // PO 55038: deliveries are counted by the graph COUNT (the exporter's own recount), not by walking ~51 pages, and say so.
    const menu = await (await fetch(`${w.rest.baseUrl}/api/export/spaces`)).json();
    const del = menu.spaces.find((x) => x.space === 'deliveries');
    const delRoute = await (await fetch(`${w.rest.baseUrl}/api/deliveries?all=1&limit=500`)).json();
    assert.equal(del.countedBy, 'graph', 'the deliveries count says it was counted in the graph');
    assert.equal(del.count, delRoute.deliveries.length, `the graph count agrees with the route (${del.count} vs ${delRoute.deliveries.length})`);
    assert.equal(menu.spaces.find((x) => x.space === 'memories').countedBy, 'route', 'a kind read in full says it was counted from its route');
    // PO 55050: the posts are counted by the route's own X-Total-Count, so the picker never parses the whole room in REST.
    const commons = menu.spaces.find((x) => x.space === 'commons');
    assert.equal(commons.countedBy, 'route-total', 'the posts count says it is the route\'s total');
    assert.equal(commons.count, posts.length, `the route's total agrees with what it serves (${commons.count} vs ${posts.length})`);
  } finally { await w.stop(); }
});

test('#1825 P2: a route that cannot be read leaves its kind null ("not read") with the reason, never 0; the others still count', async () => {
  const { readRouteSources } = await import('../core/export-spaces.mjs');
  const answers = {
    '/api/conversations': { status: 503, json: { error: 'graph down' } },
    '/api/memories': { status: 200, json: { memories: [{ id: 'm1' }, { id: 'm2' }] } },
  };
  const fakeFetch = async (url) => {
    const route = new URL(url).pathname;
    const a = answers[route] || { status: 404, json: {} };
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
  const r = await readRouteSources('http://x', ['commons', 'memories'], { fetch: fakeFetch });
  assert.equal(r.overrides.memories.length, 2, 'the readable kind is read');
  assert.equal(r.overrides.commons, undefined, 'the unreadable kind has no rows, not []');
  assert.match(r.unread.commons, /\/api\/conversations answered 503/, `the reason names the route and status (got ${r.unread.commons})`);
});

test('#1825 P3: Settings shows "not read" beside a kind whose count is null, never "null" or 0', async () => {
  const { withBrowserServer } = await import('./helpers/harness.mjs');
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (!req.url().endsWith('/api/export/spaces')) return req.continue();
      const real = await (await fetch(req.url())).json();
      for (const sp of real.spaces) if (sp.space === 'commons') { sp.count = null; sp.unread = '/api/conversations answered 503'; }
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(real) });
    });
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#export-panel [data-export-include] input[value=commons]', { timeout: 15000 });
    const shown = await page.$eval('#export-panel [data-export-include] input[value=commons]', (i) => i.parentElement.querySelector('.n').textContent);
    assert.equal(shown, 'not read', `Settings says it could not read the kind, not "${shown}"`);
  }, { server: {}, launch: { headless: 'new', args: ['--no-sandbox'] } });
});

test('#1825 P4: ?counts=0 answers the menu without reading any kind, so Settings can draw the boxes first', async () => {
  const { startRestServer } = await import('./helpers/harness.mjs');
  const s = await startRestServer({});
  try {
    const j = await (await fetch(`${s.baseUrl}/api/export/spaces?counts=0`)).json();
    assert.ok(j.spaces.length > 5, 'the menu lists the kinds');
    assert.ok(j.spaces.every((x) => !('count' in x)), 'no kind carries a count: nothing was read, so nothing is claimed');
  } finally { await s.stop(); }
});

test('#1825 P5: Settings shows "counting…" until the counts arrive, then the number, and labels a graph count', async () => {
  const { withBrowserServer } = await import('./helpers/harness.mjs');
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    let release; const gate = new Promise((r) => { release = r; });
    page.on('request', async (req) => {
      const u = req.url();
      if (!/\/api\/export\/spaces$/.test(u)) return req.continue();
      await gate;                                  // the full count is held until the test has seen the placeholder
      const real = await (await fetch(u)).json();
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(real) });
    });
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'domcontentloaded' });
    const sel = '#export-panel [data-export-include] input[value=deliveries]';
    await page.waitForSelector(sel, { timeout: 15000 });
    const before = await page.$eval(sel, (i) => i.parentElement.querySelector('.n').textContent);
    assert.equal(before, 'counting…', `the box is drawn before its count, and says so (got "${before}")`);
    release();
    await page.waitForFunction((q) => document.querySelector(q).parentElement.querySelector('.n').textContent !== 'counting…', { timeout: 15000 }, sel);
    const after = await page.$eval(sel, (i) => i.parentElement.querySelector('.n').textContent);
    assert.match(after, /^\d+ · counted in the graph$/, `the deliveries count is labelled as a graph count (got "${after}")`);
    const commonsShown = await page.$eval('#export-panel [data-export-include] input[value=commons]', (i) => i.parentElement.querySelector('.n').textContent);
    assert.match(commonsShown, /^\d+ · the route's total$/, `the posts count is labelled as the route's total (got "${commonsShown}")`);
  }, { server: {}, launch: { headless: 'new', args: ['--no-sandbox'] } });
});

test('#1825 P6: the picker never reads the posts in full: skip leaves a kind unread even when cards would pull it in', async () => {
  const { readRouteSources } = await import('../core/export-spaces.mjs');
  const asked = [];
  const fakeFetch = async (url) => { asked.push(new URL(url).pathname); return { ok: true, status: 200, json: async () => [] }; };
  const r = await readRouteSources('http://x', ['cards'], { fetch: fakeFetch, skip: ['commons'] });
  assert.ok(!asked.includes('/api/conversations'), `the posts route was not read (asked: ${asked.join(', ')})`);
  assert.equal(r.overrides.commons, undefined, 'and no rows are claimed for it');
});

test('#1825 P7: a route total is the X-Total-Count header as an integer; a missing or malformed header, or a failed call, is a reason, never a number', async () => {
  const { routeTotalOf } = await import('../core/export-spaces.mjs');
  const fake = (status, header) => async () => ({ ok: status === 200, status, headers: { get: (k) => (k.toLowerCase() === 'x-total-count' ? header : null) }, json: async () => [] });
  assert.deepEqual(await routeTotalOf('http://x', '/api/conversations?limit=1', { fetch: fake(200, '55045') }), { n: 55045 });
  assert.ok((await routeTotalOf('http://x', '/p', { fetch: fake(200, null) })).why, 'no header ⇒ a reason');
  assert.ok((await routeTotalOf('http://x', '/p', { fetch: fake(200, '12abc') })).why, 'a malformed header ⇒ a reason');
  assert.ok((await routeTotalOf('http://x', '/p', { fetch: fake(503, '9') })).why, 'a failed call ⇒ a reason, even with a header');
});
