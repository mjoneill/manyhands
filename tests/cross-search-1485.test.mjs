/**
 * #1485 — ONE search across cards, posts and decisions, with a coverage line
 * per surface, so "found nothing" names what was searched.
 *
 * The pain it answers (on the card): a seat said "no retro is on the record"
 * after searching card descriptions only; the retro was a commons post. A
 * search that cannot say WHAT it searched turns a partial look into a claim.
 *
 * Core (pure): tokenize, the incremental lexical index, decision ranking.
 * Served: POST /api/search/all and the MCP `search_all` tool, called the way a
 * seat calls them (#656's lesson: test the tool, not the helper).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, scanRank, rankDecisions } from '../core/cross-search.mjs';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

// ── tokenize ────────────────────────────────────────────────────────────────

test('#1485 tokenize keeps #NNN, shas and uuids WHOLE, and a dated range yields its short date too', () => {
  const t = tokenize('RETRO — sprint 2026-09-17→09-24 on #1402, see 7a78421 and 0c81bd86-5bff-4d5d-bd2e-60d52a511a5b');
  for (const w of ['retro', 'sprint', '#1402', '7a78421', '0c81bd86-5bff-4d5d-bd2e-60d52a511a5b', '2026-09-17', '09-17', '09-24']) {
    assert.ok(t.includes(w), `missing ${w} in ${JSON.stringify(t)}`);
  }
  assert.ok(!t.includes('the'), 'stopwords dropped');
});

// ── the scan ranker ─────────────────────────────────────────────────────────

const post = (id, text, extra = {}) => ({ '@id': id, text, author: 'ada', about: null, dateCreated: '2026-09-01T00:00:00.000Z', ...extra });
const ids = (r) => r.hits.map((h) => h.id);

test('#1485 BM25 ranks the post that says it; NEGATIVE CONTROL: a term present nowhere returns zero hits', () => {
  const ps = [post('p1', 'the canary arrived and the runner saw it'), post('p2', 'oxigraph loads as WASM'), post('p3', 'a canary canary in the mine')];
  assert.deepEqual(ids(scanRank(ps, 'canary', { k: 10 })), ['p3', 'p1'], 'both canary posts, the denser one first');
  const none = scanRank(ps, 'zzzz-no-such-term', { k: 10 });
  assert.deepEqual(none.hits, [], 'a filter that never filters would pass the test above');
  assert.equal(none.searched, 3, 'zero HITS over three SEARCHED — the two numbers are different facts');
});

test('#1485 ⭐ NO INDEX IS HELD: an edit or a delete is visible on the very next call', () => {
  // The scan reads what it is handed. A held index would answer "beta" here.
  assert.deepEqual(ids(scanRank([post('p1', 'alpha'), post('p2', 'beta')], 'beta')), ['p2']);
  assert.deepEqual(ids(scanRank([post('p1', 'alpha'), post('p2', 'delta')], 'beta')), [], 'edited away');
  assert.deepEqual(ids(scanRank([post('p1', 'alpha')], 'delta')), [], 'deleted');
});

test('#1485 matching is substring: a short date finds the long one, and "retro" finds "retrospective" (not the reverse)', () => {
  const ps = [post('p1', 'RETRO — sprint 2026-09-17→09-24'), post('p2', 'our retrospective, finally')];
  assert.deepEqual(ids(scanRank(ps, '09-17')), ['p1']);
  assert.deepEqual(ids(scanRank(ps, 'retro')).sort(), ['p1', 'p2']);
  assert.deepEqual(ids(scanRank(ps, 'retrospective')), ['p2'], 'the named synonym gap, pinned so a fix is visible');
});

test('#1485 a post in a TALK is excluded by default and COUNTED as excluded (#1457 P9: the owner decides who sees Talks)', () => {
  const r = scanRank([post('p1', 'canary in the room'), post('t1', 'canary in a talk', { 'scrum:conversation': 'talk-1' })], 'canary');
  assert.deepEqual(ids(r), ['p1']);
  assert.equal(r.excluded, 1, 'the coverage line must say a talk was skipped, not pretend it was searched');
  assert.equal(r.searched, 1);
});

test('#1485 decisions rank lexically over their statement', () => {
  const ds = [
    { id: 'd-1', statement: 'One full suite at a time, announced, niced, load under 10.', decidedAt: '2026-09-24T21:50:00Z', live: true },
    { id: 'd-2', statement: 'The blue seat is the tall seat.', decidedAt: '2026-09-24T13:04:00Z', live: true },
  ];
  assert.deepEqual(rankDecisions(ds, 'full suite niced', 5).map((h) => h.id), ['d-1']);
  assert.deepEqual(rankDecisions(ds, 'zzzz', 5), []);
});

// ── served ──────────────────────────────────────────────────────────────────

const card = (shortId, title, description = '') => ({
  id: `uuid-${shortId}`, shortId, title, description, type: 'task', assignees: [], labels: [], for: '', priority: null,
  column: 'backlog', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] }, claimedBy: null, claimedAt: null,
});
const board = () => makeBoardFixture({
  cards: [card(1, 'Sprint card for the fortnight', 'the sprint')],
  conversations: [
    { id: 'm-1', body: 'RETRO — sprint 2026-09-17→09-24, opening now', author: 'kit', attachedTo: 'uuid-1', createdAt: '2026-09-21T16:10:55.000Z', mentions: [] },
    { id: 'm-2', body: 'unrelated chatter about lunch', author: 'kit', attachedTo: null, createdAt: '2026-09-21T17:00:00.000Z', mentions: [] },
  ],
  nextShortId: 2,
});
const searchAll = (base, body) => fetch(`${base}/api/search/all`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('#1485 ⭐ the case that made the card: the retro POST is found, and coverage names every surface and its method', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await fetch(`${s.baseUrl}/api/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'One full suite at a time, announced and niced.', decidedBy: 'kit', by: 'kit', constrains: ['suites'], reopensIf: 'a suite run corrupts nothing under load' }),
    });
    const r = await searchAll(s.baseUrl, { q: 'did sprint 09-17 to 09-24 have a retro?', by: 'kit' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { posts, decisions, cards, coverage } = r.body;
    assert.equal(posts.hits[0].id, 'entity:m-1', 'a post hit is in #1484 grammar');
    assert.equal(posts.hits[0].about, 1, 'the card the post sits on, as a shortId');
    assert.match(posts.hits[0].snippet, /RETRO/);
    assert.equal(coverage.posts.method, 'bm25-scan');
    assert.equal(coverage.posts.searched, 2);
    assert.equal(coverage.decisions.method, 'bm25-scan');
    assert.equal(coverage.decisions.searched, 1);
    // No embedder configured in this harness: cards must say UNSEARCHED, never "0 hits".
    assert.equal(coverage.cards.searched, 0);
    assert.ok(coverage.cards.error, 'an unreachable surface names why');
    assert.equal(cards.hits.length, 0);
    assert.ok(Array.isArray(decisions.hits));
    assert.ok(r.body.asOf, 'coverage carries when it was true');
  } finally { await s.stop(); }
});

test('#1485 a decision-only question lands in the decisions group, as decision:<uuid>', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const d = await (await fetch(`${s.baseUrl}/api/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'One full suite at a time, announced and niced.', decidedBy: 'kit', by: 'kit', constrains: ['suites'], reopensIf: 'a suite run corrupts nothing under load' }),
    })).json();
    const id = d.id ?? d.decision?.id;
    assert.ok(id, JSON.stringify(d));
    const r = await searchAll(s.baseUrl, { q: 'full suite niced' });
    assert.deepEqual(r.body.decisions.hits.map((h) => h.id), [`decision:${id}`]);
    assert.deepEqual(r.body.posts.hits, [], 'no post says it');
  } finally { await s.stop(); }
});

test('#1485 a missing q is a 400, not an empty answer', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await searchAll(s.baseUrl, {});
    assert.equal(r.status, 400);
  } finally { await s.stop(); }
});

test('#1485 SEAM: the MCP search_all tool reaches the same answer through REST', async () => {
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('search_all', { q: 'retro sprint 2026-09-17', by: 'kit' });
    const body = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(body.posts.hits[0].id, 'entity:m-1');
    assert.equal(body.coverage.posts.method, 'bm25-scan');
  } finally { await mcp.stop(); await rest.stop(); }
});
