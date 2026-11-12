/**
 * #1826 — GET /api/deliveries pages with an (offeredAt, id) cursor whose bound is IN THE QUERY, not a slice after a full read.
 * Measured on prod 2026-11-12T20:09Z: `all=1` with no cursor answered 503 after 10 s against 21,867 deliveries, so a complete
 * history (the exporter's, #1825) must be a walk of bounded reads. REST plus a REAL executor; synthetic content. Without a
 * python with pyoxigraph the graph rows are SKIPPED, and a skip is not a pass.
 *
 *   C1 (graph unit) a walk at limit=2 over 7 deliveries, FIVE of them sharing one offeredAt across page boundaries, returns
 *      every delivery exactly once, in the unpaged list's order; the last page answers `next: null`.
 *   C2 (graph unit) the bound is in the query: every executor read made while serving a page carries a LIMIT or pins its
 *      deliveries with VALUES. CONTROL: the unpaged all=1 list makes a read with neither (so the probe can see one).
 *   C3 a cursor this route did not mint answers 400 BAD_CURSOR, never SPARQL text and never the first page.
 *   C4 (unit off, the document) the same contract: the same walk over the same tie shape, every delivery once, `next: null` last.
 *   C5 the exporter's deliveries source is declared paged and bounded. The exporter's walk and its refusals run against a fake
 *      board in tests/export-graph-kinds-1825.test.mjs (F3b, F3c).
 *
 * NOT COVERED: prod's size (the rows prove the walk, not its speed at 21.9k); `open=1` pages, whose failed-attempt filter runs
 * after the read (a page may hold fewer than `limit`; `next` still comes from the chosen ids).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `c1826-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const N = 7;
// p1 alone first, p2..p6 SHARE one instant, p7 alone last: at limit=2 the shared instant straddles three page boundaries.
const OFFERED = (i) => (i === 1 ? '2026-01-01T00:00:00.000Z' : i === N ? '2026-01-01T00:00:02.000Z' : '2026-01-01T00:00:01.000Z');
const RS = 'https://scrumboard.local/ns#';

const api = async (base, route) => {
  const res = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const iso = (ageMin) => new Date(Date.now() - ageMin * 60000).toISOString();
const post = (id, seq) => ({ id, body: `delivered post ${id}`, author: 'ada', attachedTo: null, attachments: [], mentions: ['gizmo'], postSeq: seq, createdAt: iso(5) });
const posts = () => Array.from({ length: N }, (_, i) => post(`p${i + 1}`, i + 1));

async function walk(base, limit) {
  const seen = []; let after = null; let pages = 0;
  for (;;) {
    const r = await api(base, `/api/deliveries?all=1&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    assert.equal(r.status, 200, `a page answers 200 (${r.status} ${r.text.slice(0, 200)})`);
    assert.ok('next' in r.body, 'a page names its next cursor, null on the last page');
    assert.ok(r.body.deliveries.length <= limit, `a page holds at most ${limit}`);
    seen.push(...r.body.deliveries); pages += 1;
    if (r.body.next === null) break;
    assert.notEqual(r.body.next, after, 'the cursor moves');
    after = r.body.next;
    assert.ok(pages < 50, 'the walk ends');
  }
  return { seen, pages };
}

function assertCompleteWalk(seen, pages, unpaged) {
  const ids = seen.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, `no delivery is repeated across pages: ${ids.join(' ')}`);
  assert.equal(ids.length, N, `every delivery is walked: got ${ids.length} of ${N}`);
  assert.deepEqual(ids, unpaged.map((d) => d.id), 'the walk is the unpaged list, in its order');
  assert.equal(pages, Math.ceil(N / 2), 'limit=2 over 7 is 4 pages');
  assert.equal(seen.filter((d) => d.offeredAt === OFFERED(2)).length, 5, 'CONTROL: five deliveries share one offeredAt, so ties really straddle page boundaries');
}

async function startQueryProbe(execUrl) {
  const p = { reads: [] };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url.startsWith('/query')) p.reads.push(body.toString('utf8') + decodeURIComponent(req.url.split('?')[1] || ''));
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body } : {}) });
      res.statusCode = f.status; res.setHeader('content-type', f.headers.get('content-type') || 'application/json'); res.end(await f.text());
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => p.server.close(r));
  return p;
}

async function graphBoard(body) {
  const dsid = 'c1826-test';
  const exec = await startExecutor({ store: tmpStore('c1826-store-'), datasetId: dsid, create: true });
  const probe = await startQueryProbe(exec.baseUrl);
  const rest = await startRestServer({
    board: makeBoardFixture({ conversations: posts(), postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 }),
    env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: probe.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' },
  });
  try {
    for (let i = 1; i <= N; i++) {
      const r = await fetch(`${rest.baseUrl}/api/deliveries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'gizmo', conversation: `p${i}`, source: 'fanout', by: 'board' }) });
      assert.equal(r.status, 201, `CONTROL setup: create p${i} answers 201`);
      // Give the tie shape directly in the store: REST stamps offeredAt with the clock, which can't be made to repeat on cue.
      const u = await fetch(`${exec.baseUrl}/update`, {
        method: 'POST', headers: { 'x-op-id': `urn:ex:op/test-1826-offered-${i}` },
        body: `DELETE { ?d <${RS}offeredAt> ?x } INSERT { ?d <${RS}offeredAt> ${JSON.stringify(OFFERED(i))} } WHERE { ?d <${RS}ofConversation> <https://scrumboard.local/entity/p${i}> ; <${RS}offeredAt> ?x }`,
      });
      assert.equal(u.status, 200, `CONTROL setup: offeredAt for p${i} rewritten`);
    }
    return await body({ base: rest.baseUrl, probe });
  } finally { await rest.stop(); await probe.down(); await killExecutor(exec); }
}

test('C1 graph unit: a walk at limit=2 returns every delivery once, in order, across shared-offeredAt boundaries', { skip: SKIP, timeout: 180000 }, async () => {
  await graphBoard(async ({ base }) => {
    const unpaged = (await api(base, '/api/deliveries?all=1')).body.deliveries;
    assert.equal(unpaged.length, N, 'CONTROL: the unpaged list holds all 7');
    assert.ok(!('next' in (await api(base, '/api/deliveries?all=1')).body), 'an unpaged list carries no cursor (callers without limit/after are unchanged)');
    const { seen, pages } = await walk(base, 2);
    assertCompleteWalk(seen, pages, unpaged);
  });
});

test('C2 graph unit: every executor read behind a page is bounded (LIMIT or VALUES); the unpaged read is not', { skip: SKIP, timeout: 180000 }, async () => {
  await graphBoard(async ({ base, probe }) => {
    probe.reads.length = 0;
    await api(base, '/api/deliveries?all=1');
    const unbounded = probe.reads.filter((q) => /Delivery/.test(q) && !/LIMIT/.test(q) && !/VALUES \?d/.test(q));
    assert.ok(unbounded.length >= 1, `CONTROL: the unpaged all=1 list makes an unbounded read the probe can see (saw ${probe.reads.length} reads)`);
    probe.reads.length = 0;
    await walk(base, 2);
    const listReads = probe.reads.filter((q) => /Delivery/.test(q));
    assert.ok(listReads.length >= 4, `the walk reaches the executor (${listReads.length} reads)`);
    const bad = listReads.filter((q) => !/LIMIT 3\b/.test(q) && !/VALUES \?d/.test(q));
    assert.deepEqual(bad, [], 'no read behind a page is unbounded');
  });
});

test('C3 a cursor the route did not mint is 400 BAD_CURSOR', { skip: SKIP, timeout: 180000 }, async () => {
  await graphBoard(async ({ base }) => {
    for (const after of ['nope!', Buffer.from('["x"]').toString('base64url'), Buffer.from('["2026-01-01T00:00:00Z","a> } DROP ALL #"]').toString('base64url')]) {
      const r = await api(base, `/api/deliveries?all=1&limit=2&after=${encodeURIComponent(after)}`);
      assert.equal(r.status, 400, `after=${after} → 400 (${r.status} ${r.text.slice(0, 120)})`);
      assert.equal(r.body?.code, 'BAD_CURSOR');
    }
    const ok = await api(base, '/api/deliveries?all=1');
    assert.equal(ok.body.deliveries.length, N, 'the store is untouched');
  });
});

test('C4 unit off (the document): the same walk, the same contract', { timeout: 120000 }, async () => {
  const deliveries = Array.from({ length: N }, (_, i) => ({
    '@id': `https://scrumboard.local/delivery/0000000${i + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, '@type': 'scrum:Delivery',
    'scrum:deliveredTo': 'gizmo', 'scrum:ofConversation': `p${i + 1}`, 'scrum:offeredAt': OFFERED(i + 1), 'scrum:source': 'fanout',
    'scrum:hasEvent': [{ 'scrum:state': 'offered', 'scrum:at': OFFERED(i + 1), 'scrum:source': 'fanout' }],
  }));
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: posts(), deliveries }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const unpaged = (await api(rest.baseUrl, '/api/deliveries?all=1')).body.deliveries;
    assert.equal(unpaged.length, N, 'CONTROL: the document serves all 7');
    const { seen, pages } = await walk(rest.baseUrl, 2);
    assertCompleteWalk(seen, pages, unpaged);
    const bad = await api(rest.baseUrl, '/api/deliveries?all=1&limit=2&after=nope!');
    assert.equal(bad.status, 400);
  } finally { await rest.stop(); }
});

test('C5 the exporter declares deliveries a paged, bounded, whole-history source (its walk and refusals: #1825 file, F3b/F3c)', { timeout: 60000 }, async () => {
  const { ROUTE_SOURCES } = await import('../core/export-spaces.mjs');
  assert.equal(ROUTE_SOURCES.deliveries.paged, 'next', 'deliveries is declared paged');
  assert.match(ROUTE_SOURCES.deliveries.source, /[?&]all=1\b/, 'still the whole history');
  assert.match(ROUTE_SOURCES.deliveries.source, /[?&]limit=\d+/, 'read in bounded pages');
});
