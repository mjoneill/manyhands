/**
 * Item 13 (#1086) — POST /api/search and the MCP board_search tool, end to end
 * through a FAKE embedder that speaks Ollama's /api/embed shape.
 *
 * The fake maps text to a small vector by keyword counts, so relevance is
 * meaningful and deterministic: a query about "deploy" lands on the deploy
 * card. It is not a model; it is the plumbing under test — the contract, the
 * incremental index, the coverage report, the unconfigured refusal, the log.
 * The live embedder is exercised separately against the frozen eval set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const AXES = ['deploy', 'search', 'gate', 'presence', 'banana'];
function fakeVec(text) {
  const t = text.toLowerCase();
  const v = AXES.map((w) => (t.match(new RegExp(w, 'g')) || []).length);
  return v.some((x) => x > 0) ? v : [0.01, 0.01, 0.01, 0.01, 0.01];
}
async function fakeEmbedder() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: body.model, embeddings: body.input.map(fakeVec) }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/api/embed`, calls, stop: () => new Promise((r) => srv.close(r)) };
}

const card = (shortId, title, description = '') => ({
  id: `uuid-${shortId}`, shortId, title, description, type: 'task', assignees: [], labels: [], for: '', priority: null,
  column: 'backlog', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] }, claimedBy: null, claimedAt: null,
});
const board = () => makeBoardFixture({
  cards: [
    card(1, 'The deploy script asks CI before it exports', 'deploy deploy deploy'),
    card(2, 'Semantic search over cards', 'search search'),
    card(3, 'The push gate reads pushed objects', 'gate gate'),
    card(4, 'Presence plugin logs to the file sink', 'presence'),
  ],
  conversations: [], nextShortId: 5,
});
const search = (srv, body) => fetch(`${srv.baseUrl}/api/search`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('unconfigured embedder ⇒ available:false with the reason and the thresholds — never a zero-result answer', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const r = await search(srv, { q: 'how does deploy work' });
    assert.equal(r.available, false);
    assert.match(r.reason, /SEARCH_EMBED_URL/);
    assert.equal(typeof r.abstainBelow, 'number');
    assert.equal('results' in r, false);
  } finally { await srv.stop(); }
});

test('a clear question ANSWERS with the right card, builds the index on first use, and reports full coverage', async () => {
  const emb = await fakeEmbedder();
  const srv = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  try {
    const r = await search(srv, { q: 'deploy deploy', by: 'ada' });
    assert.equal(r.available, true);
    assert.equal(r.verdict, 'answer');
    assert.equal(r.top.shortId, 1);
    assert.equal(r.results[0].shortId, 1);
    assert.deepEqual(r.coverage, { indexed: 4, total: 4, stale: 0 });
    assert.equal(r.partial, false);
    assert.equal(r.abstainBelow, 0.5); assert.equal(r.askWithin, 0.03); assert.equal(r.k, 8);
    assert.equal(r.generation.model, 'fake'); assert.equal(r.generation.dims, 5);
    assert.equal(emb.calls.length, 1, 'ONE embedder call: query + the batch');
    assert.equal(emb.calls[0].input.length, 5, 'the query and four cards');
    assert.equal(emb.calls[0].input[1], '# The deploy script asks CI before it exports\n\ndeploy deploy deploy', 'the measured text shape, byte for byte');
    // the index file and the verbatim log exist beside the board data
    const dir = path.dirname(srv.boardFile);
    const idx = fs.readFileSync(path.join(dir, 'search-index.jsonl'), 'utf8').trim().split('\n');
    assert.equal(idx.length, 5, 'header + four rows');
    assert.equal(JSON.parse(idx[0]).generation.textShape, '# title\n\nbody');
    const log = fs.readFileSync(path.join(dir, 'search-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log[0].q, 'deploy deploy', 'verbatim');
    assert.equal(log[0].by, 'ada'); assert.equal(log[0].verdict, 'answer');
  } finally { await srv.stop(); await emb.stop(); }
});

test('the second search re-embeds NOTHING; a changed card re-embeds only itself', async () => {
  const emb = await fakeEmbedder();
  const srv = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  try {
    await search(srv, { q: 'gate' });
    await search(srv, { q: 'gate' });
    assert.equal(emb.calls[1].input.length, 1, 'only the query on a warm index');
    await fetch(`${srv.baseUrl}/api/cards/uuid-3`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'gate gate gate — edited' }) });
    const r = await search(srv, { q: 'gate' });
    assert.equal(emb.calls[2].input.length, 2, 'the query and the one changed card');
    assert.equal(r.top.shortId, 3);
    assert.equal(r.coverage.stale, 0);
  } finally { await srv.stop(); await emb.stop(); }
});

test('a question about nothing on the board ABSTAINS — and says why, with the threshold', async () => {
  const emb = await fakeEmbedder();
  const srv = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  try {
    const r = await search(srv, { q: 'banana bread recipe' });
    assert.equal(r.verdict, 'abstain');
    assert.equal(r.top, null);
    assert.match(r.reason, /abstainBelow/);
    assert.ok(r.results.length > 0, 'the ranking is still shown — the verdict is the answer, the list is the evidence');
  } finally { await srv.stop(); await emb.stop(); }
});

test('two cards equally close ⇒ ASK, with both as the question', async () => {
  const emb = await fakeEmbedder();
  const b = makeBoardFixture({ cards: [card(1, 'deploy one', 'deploy'), card(2, 'deploy two', 'deploy'), card(3, 'gate', 'gate')], conversations: [], nextShortId: 4 });
  const srv = await startRestServer({ board: b, env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  try {
    const r = await search(srv, { q: 'deploy' });
    assert.equal(r.verdict, 'ask');
    assert.deepEqual(r.contenders.map((c) => c.shortId).sort(), [1, 2]);
  } finally { await srv.stop(); await emb.stop(); }
});

test('a bounded batch answers PARTIAL and says how much was searched; the next call finishes the index', async () => {
  const emb = await fakeEmbedder();
  const srv = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake', SEARCH_MAX_EMBED: '2' } });
  try {
    const a = await search(srv, { q: 'presence' });
    assert.equal(a.partial, true);
    assert.deepEqual(a.coverage, { indexed: 2, total: 4, stale: 2 });
    const b2 = await search(srv, { q: 'presence' });
    assert.equal(b2.partial, false);
    assert.deepEqual(b2.coverage, { indexed: 4, total: 4, stale: 0 });
    assert.equal(b2.top.shortId, 4);
  } finally { await srv.stop(); await emb.stop(); }
});

test('the embedder going away mid-life ⇒ available:false with the reason, not an empty answer', async () => {
  const emb = await fakeEmbedder();
  const srv = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  try {
    await emb.stop();
    const r = await search(srv, { q: 'deploy' });
    assert.equal(r.available, false);
    assert.match(r.reason, /embedder unavailable/);
  } finally { await srv.stop(); }
});

test('an index built under another model is refused with the remedy, not mixed', async () => {
  const emb = await fakeEmbedder();
  const srv1 = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  const dir = path.dirname(srv1.boardFile);
  try { await search(srv1, { q: 'deploy' }); } finally { await srv1.stop(); }
  const idx = fs.readFileSync(path.join(dir, 'search-index.jsonl'), 'utf8');
  const srv2 = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'other-model' } });
  try {
    fs.writeFileSync(path.join(path.dirname(srv2.boardFile), 'search-index.jsonl'), idx);
    const r = await search(srv2, { q: 'deploy' });
    assert.equal(r.available, false);
    assert.match(r.reason, /generation mismatch/);
    assert.match(r.reason, /Delete/);
  } finally { await srv2.stop(); await emb.stop(); }
});

test('MCP board_search rides the same surface', async () => {
  const emb = await fakeEmbedder();
  const rest = await startRestServer({ board: board(), env: { SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('board_search', { q: 'presence plugin', by: 'ada' });
    const r = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(r.verdict, 'answer');
    assert.equal(r.top.shortId, 4);
  } finally { await mcp.stop(); await rest.stop(); await emb.stop(); }
});
