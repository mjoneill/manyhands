/**
 * #1022 — memories gain bodyAppend / bodyPrepend, the byte-preserving verbs
 * cards got in #864/#906. Every memory edit used to be a full-body replace:
 * read, concatenate locally, send the whole thing back — the #466 shape, on
 * the store the room keeps its shared lessons in.
 *
 * The card's own acceptance names the discriminators, and these tests are
 * those conditions, not a description of the API:
 *   - two concurrent appends BOTH survive (an append implemented as a
 *     client-side read-modify-write has not fixed this; one composed on the
 *     server under the write lock has)
 *   - version history stays append-only: the append mints a NEW version and
 *     every prior one is still retrievable
 *   - the request carries the addition only, never the existing body
 *   - prepend lands BEFORE the text it corrects (#906's reason to exist)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(baseUrl, method, path, body) {
  const payload = body ? JSON.stringify(body) : undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(payload ? { body: payload } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, sentBytes: payload ? Buffer.byteLength(payload) : 0 };
}

// A body with the things a re-composition damages: a fence, a regex, a
// SPARQL literal with quotes. Byte-preservation is asserted against THIS.
const ORIGINAL = 'lesson one\n\n```js\nconst re = /a\\/b"c/;\n```\nASK { ?x schema:name "x\\"y" }\n';
const MEM = { title: 'probe', body: ORIGINAL, tags: [], owner: 'ada' };

test('#1022 bodyAppend adds to the END byte-for-byte and mints a new version', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;
    assert.equal(c.body.version, 1);

    const add = '\n\n## added later\n`x`\n';
    const u = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: add, by: 'bex' });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.version, 2, 'an append is a NEW version — history is append-only');
    assert.equal(u.body.body, ORIGINAL + add, 'original survives as an exact prefix');

    const g = await api(s.baseUrl, 'GET', `/api/memories/${id}`);
    assert.equal(g.body.body, ORIGINAL + add, 'read back, not the echo');
  } finally { await s.stop(); }
});

test('#1022 bodyPrepend lands BEFORE the text it corrects; prepend + append compose', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;

    const pre = '# ⛔ CORRECTION — read this first\n\n';
    const u = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyPrepend: pre, by: 'bex' });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.body, pre + ORIGINAL, 'the correction is ABOVE the claim it corrects');

    const post = '\n---\nfootnote\n';
    const both = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { bodyAppend: post, bodyPrepend: 'TOP\n', by: 'cy' });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.body, 'TOP\n' + pre + ORIGINAL + post,
      'prepend + existing + append, independent of JSON key order');
    assert.equal(both.body.version, 3);
  } finally { await s.stop(); }
});

test('#1022 ⛔ NEGATIVE CONTROL — two seats appending concurrently BOTH survive', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;

    // Fired without awaiting between them: neither caller read the other's
    // text, and neither sent the existing body. The server composes under its
    // write lock, so the second append lands on top of the first rather than
    // on top of the snapshot both callers would have held.
    const [a, b] = await Promise.all([
      api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: '\nFROM-A', by: 'ada' }),
      api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: '\nFROM-B', by: 'bex' }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));

    const g = await api(s.baseUrl, 'GET', `/api/memories/${id}`);
    assert.ok(g.body.body.includes('FROM-A'), 'A survived');
    assert.ok(g.body.body.includes('FROM-B'), 'B survived');
    assert.ok(g.body.body.startsWith(ORIGINAL), 'and the original is intact under both');
    assert.equal(g.body.version, 3, 'two appends, two versions');
  } finally { await s.stop(); }
});

test('#1022 NEGATIVE CONTROL — every prior version is still retrievable after appends', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;
    await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: ' +1', by: 'ada' });
    await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyPrepend: '0+ ', by: 'ada' });

    const v = await api(s.baseUrl, 'GET', `/api/memories/${id}/versions`);
    assert.equal(v.status, 200);
    const bodies = (v.body.versions ?? v.body).map((x) => x.body ?? x['scrum:body']);
    assert.deepEqual(bodies, [ORIGINAL, ORIGINAL + ' +1', '0+ ' + ORIGINAL + ' +1'],
      'three versions, oldest first, none rewritten');
  } finally { await s.stop(); }
});

test('#1022 NEGATIVE CONTROL — the request carries the ADDITION, never the existing body', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const big = 'x'.repeat(4000) + '\n';
    const c = await api(s.baseUrl, 'POST', '/api/memories', { ...MEM, body: big });
    const id = c.body.id;

    const add = '\none line\n';
    const u = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: add, by: 'ada' });
    assert.equal(u.status, 200);
    // The payload actually SENT, measured — not the API's shape.
    assert.ok(u.sentBytes < 200,
      `adding ${add.length} chars must not cost the 4 KB body: sent ${u.sentBytes} bytes`);
    assert.equal(u.body.body, big + add);
  } finally { await s.stop(); }
});

test('#1022 refused: body together with an append verb; an EMPTY append', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;

    const both = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { body: 'REPLACED', bodyAppend: 'x', by: 'ada' });
    assert.equal(both.status, 400, 'replace and append in one write is two intentions');
    assert.match(both.body.error, /bodyAppend/);

    const empty = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: '', by: 'ada' });
    assert.equal(empty.status, 400, 'an empty append would mint a version of unchanged text');

    const notStr = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyPrepend: 7, by: 'ada' });
    assert.equal(notStr.status, 400);

    const g = await api(s.baseUrl, 'GET', `/api/memories/${id}`);
    assert.equal(g.body.version, 1, 'nothing was written by any refused request');
    assert.equal(g.body.body, ORIGINAL);
  } finally { await s.stop(); }
});

test('#1022 ifVersion still guards an append — CAS composes with the verb, not instead of it', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;
    await api(s.baseUrl, 'PATCH', `/api/memories/${id}`, { bodyAppend: ' +1', by: 'ada' });

    const stale = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { bodyAppend: ' +2', by: 'bex', ifVersion: 1 });
    assert.equal(stale.status, 409, 'a caller who insists on version 1 is told it moved');

    const fresh = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { bodyAppend: ' +2', by: 'bex', ifVersion: 2 });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.body, ORIGINAL + ' +1 +2');
  } finally { await s.stop(); }
});
