import test from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const convs = [
  { id: 'a', body: 'the canary arrived and the runner saw it', author: 'ada', attachedTo: null, createdAt: '2026-08-01T00:00:00.000Z', mentions: [] },
  { id: 'b', body: 'oxigraph loads as WASM in 19ms',       author: 'bex',  attachedTo: null, createdAt: '2026-08-02T00:00:00.000Z', mentions: [] },
  { id: 'c', body: 'a CANARY in capitals, same word',      author: 'cy',    attachedTo: null, createdAt: '2026-08-03T00:00:00.000Z', mentions: [] },
  { id: 'd', body: 'nothing to do with birds',             author: 'cy',    attachedTo: null, createdAt: '2026-08-04T00:00:00.000Z', mentions: [] },
];
const fixture = () => makeBoardFixture({ cards: [], conversations: convs });
const get = (base, qs) => fetch(`${base}/api/conversations${qs}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test('#1010 q= finds a term ANYWHERE in the corpus, not just the recent window', async () => {
  const s = await startRestServer({ board: fixture() });
  try {
    const r = await get(s.baseUrl, '?q=canary');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((c) => c.id).sort(), ['a', 'c'], 'both canary messages, including the OLDEST');
  } finally { await s.stop(); }
});

test('#1010 NEGATIVE CONTROL — a term present nowhere returns ZERO, not everything', async () => {
  // ⛔ Without this, a filter that never filters passes the test above. That is
  // the exact shape of the bug being fixed: a search that quietly matches its
  // whole input reads as working.
  const s = await startRestServer({ board: fixture() });
  try {
    const r = await get(s.baseUrl, '?q=zzzzz-no-such-term');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [], 'no matches means empty, not unfiltered');
  } finally { await s.stop(); }
});

test('#1010 THE BUG ITSELF — q filters BEFORE limit, so a match outside the recent window still returns', async () => {
  // The defect: the client searched the 50 most-recent it had loaded. If the
  // server applied `limit` first and `q` second, the API would reproduce the
  // same lie one layer down — matches only among the recent slice.
  const s = await startRestServer({ board: fixture() });
  try {
    const r = await get(s.baseUrl, '?q=canary&limit=1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((c) => c.id), ['c'], 'the most-recent MATCH, not "a match among the most-recent"');
    const naive = convs.slice(-1).filter((c) => c.body.toLowerCase().includes('canary'));
    assert.equal(naive.length, 0, 'CONTROL: limit-then-filter would have returned nothing — so this test can fail');
  } finally { await s.stop(); }
});

test('#1010 search is case-insensitive', async () => {
  const s = await startRestServer({ board: fixture() });
  try {
    assert.equal((await get(s.baseUrl, '?q=CANARY')).body.length, 2);
    assert.equal((await get(s.baseUrl, '?q=wasm')).body.length, 1, 'lowercase needle finds the uppercase WASM');
  } finally { await s.stop(); }
});

test('#1010 an empty or whitespace q does not filter — it is not a search', async () => {
  const s = await startRestServer({ board: fixture() });
  try {
    assert.equal((await get(s.baseUrl, '?q=')).body.length, convs.length);
    assert.equal((await get(s.baseUrl, '?q=%20%20')).body.length, convs.length);
  } finally { await s.stop(); }
});

test('#1010 q composes with author rather than replacing it', async () => {
  const s = await startRestServer({ board: fixture() });
  try {
    const r = await get(s.baseUrl, '?q=canary&author=cy');
    assert.deepEqual(r.body.map((c) => c.id), ['c'], 'cy said canary once; ada said it too and is excluded');
  } finally { await s.stop(); }
});
