/**
 * #1851 — the LIVE search seam: createRestSearch turns the board's POST /api/search into the `search(q)` proposeLinks takes.
 * The linker's whole promise ("no link" never means "never searched") rests on this adapter refusing every answer that did
 * not search everything, so those refusals are the rows.
 *
 *   S1  an answer maps to hits: id, shortId, title, score, kind; the request carries q, k, by and the bearer
 *       (#1852 added the title: the extractor's finish post names the card a claim may bear on)
 *   S2  available:false (no embedder, unreadable index) ⇒ ok:false with the server's reason
 *   S3  partial:true (cards or Sources not yet embedded) ⇒ ok:false: a partial index could not search everything
 *   S4  an "abstain" verdict still returns its hits: the linker thresholds the scores itself, the verdict is a different question
 *   S5  a non-200 or a transport error ⇒ ok:false, never a throw that would end the run without a reason
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestSearch } from '../core/knowledge-linking.mjs';

const answer = (extra = {}) => ({ available: true, model: 'qwen3-embedding:8b', verdict: 'answer', partial: false, results: [
  { id: 'uuid-1', shortId: 1319, title: 't', column: 'backlog', score: 0.681 },
  { id: 'https://scrumboard.local/source/abc', kind: 'source', title: 's', score: 0.6 },
], ...extra });
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); if (reply instanceof Error) throw reply; return { status: reply.status ?? 200, json: async () => reply.json, text: async () => JSON.stringify(reply.json) }; };
  fn.calls = calls; return fn;
}

test('S1 an answer maps to hits; the request carries q, k, by and the bearer', async () => {
  const f = fakeFetch({ json: answer() });
  const search = createRestSearch({ base: 'http://board', token: 'tok', by: 'extractor', k: 8, fetchImpl: f });
  const r = await search('keep the top layer small');
  assert.deepEqual(r, { ok: true, hits: [{ id: 'uuid-1', shortId: 1319, title: 't', score: 0.681, kind: 'card' }, { id: 'https://scrumboard.local/source/abc', shortId: null, title: 's', score: 0.6, kind: 'source' }] });
  assert.equal(f.calls[0].url, 'http://board/api/search');
  assert.deepEqual(f.calls[0].body, { q: 'keep the top layer small', k: 8, by: 'extractor' });
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(search.model(), 'qwen3-embedding:8b', 'the embed model is read from the board\'s answer, never assumed');
});

test('S2 available:false ⇒ ok:false with the server\'s reason', async () => {
  const search = createRestSearch({ base: 'http://board', token: 't', by: 'x', k: 8, fetchImpl: fakeFetch({ json: { available: false, reason: 'embedder unavailable' } }) });
  const r = await search('q');
  assert.equal(r.ok, false);
  assert.match(r.reason, /embedder unavailable/);
});

test('S3 partial:true ⇒ ok:false: a partial index could not search everything', async () => {
  const search = createRestSearch({ base: 'http://board', token: 't', by: 'x', k: 8, fetchImpl: fakeFetch({ json: answer({ partial: true, coverage: { indexed: 10, total: 12, stale: 2 } }) }) });
  const r = await search('q');
  assert.equal(r.ok, false);
  assert.match(r.reason, /partial/);
});

test('S4 an abstain verdict still returns its hits', async () => {
  const search = createRestSearch({ base: 'http://board', token: 't', by: 'x', k: 8, fetchImpl: fakeFetch({ json: answer({ verdict: 'abstain' }) }) });
  const r = await search('q');
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 2);
});

test('S5 a non-200 or a transport error ⇒ ok:false, never a throw', async () => {
  const a = await createRestSearch({ base: 'http://b', token: 't', by: 'x', k: 8, fetchImpl: fakeFetch({ status: 503, json: { error: 'down' } }) })('q');
  assert.equal(a.ok, false); assert.match(a.reason, /503/);
  const b = await createRestSearch({ base: 'http://b', token: 't', by: 'x', k: 8, fetchImpl: fakeFetch(new Error('ECONNREFUSED')) })('q');
  assert.equal(b.ok, false); assert.match(b.reason, /ECONNREFUSED/);
});
