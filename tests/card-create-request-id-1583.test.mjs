/**
 * #1583 — POST /api/cards is idempotent on a client-generated REQUEST ID.
 *
 * A browser whose create got no reply cannot tell "never arrived" from
 * "committed, reply lost". It re-sends with the same `requestId`; the server
 * answers with the card that request already made (200, `replayed: true`)
 * instead of a second one. The key is the request id only — never the title
 * or any other content, which two genuine creates may share.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const post = async (baseUrl, body) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const count = async (baseUrl) => (await (await fetch(`${baseUrl}/api/cards?limit=100`)).json()).cards.length;

test('#1583 a repeated requestId returns the SAME card (200, replayed) and creates nothing', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const requestId = randomUUID();
    const a = await post(s.baseUrl, { title: 'once', requestId });
    assert.equal(a.status, 201);
    assert.equal(a.body.createRequestId, requestId, 'the request id is stored on the card');
    const b = await post(s.baseUrl, { title: 'once', requestId });
    assert.equal(b.status, 200);
    assert.equal(b.body.replayed, true);
    assert.equal(b.body.id, a.body.id);
    assert.equal(b.body.shortId, a.body.shortId);
    assert.equal(await count(s.baseUrl), 1);
    const next = await post(s.baseUrl, { title: 'another' });
    assert.equal(next.body.shortId, a.body.shortId + 1, 'the replay did not consume a shortId');
    // Queryable: the stored card carries it.
    const got = await (await fetch(`${s.baseUrl}/api/cards/${a.body.id}`)).json();
    assert.equal(got.createRequestId, requestId);
  } finally { await s.stop(); }
});

test('#1583 the key is the REQUEST ID, not the content: same title + different ids = two cards; same id + different title = the original card', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const x = await post(s.baseUrl, { title: 'same words', requestId: randomUUID() });
    const y = await post(s.baseUrl, { title: 'same words', requestId: randomUUID() });
    assert.equal(x.status, 201);
    assert.equal(y.status, 201);
    assert.notEqual(x.body.id, y.body.id, 'identical content under two request ids is two genuine creates');
    const rid = randomUUID();
    const first = await post(s.baseUrl, { title: 'first words', requestId: rid });
    const again = await post(s.baseUrl, { title: 'other words', requestId: rid });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id, 'a replay is identified by its request id alone');
    assert.equal(again.body.title, 'first words', 'and returns what was stored, unchanged');
    assert.equal(await count(s.baseUrl), 3);
  } finally { await s.stop(); }
});

test('#1583 concurrent retries of ONE request create exactly one card', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const requestId = randomUUID();
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(s.baseUrl, { title: 'raced', requestId })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, 'one create');
    assert.equal(rs.filter((r) => r.status === 200 && r.body.replayed).length, 5, 'five replays');
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1, 'all name the same card');
    assert.equal(await count(s.baseUrl), 1);
  } finally { await s.stop(); }
});

test('#1583 a malformed requestId is refused, and a create without one still works', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    assert.equal((await post(s.baseUrl, { title: 'bad', requestId: 'x' })).status, 400);
    assert.equal((await post(s.baseUrl, { title: 'bad', requestId: 42 })).status, 400);
    const ok = await post(s.baseUrl, { title: 'no key' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.createRequestId, undefined);
    assert.equal(await count(s.baseUrl), 1);
  } finally { await s.stop(); }
});
