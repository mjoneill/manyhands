/**
 * #1460 — POST /api/cursors/served answered 200 `served:false` with NO code
 * whenever the mark did not ADVANCE the lane's cursor: an earlier event marked
 * after a later one, or an event the lane had already acked. The MCP host logs
 * `served NOT recorded for <lane>: ${r.code}`, so each of those printed
 * `undefined` — 247 lines in one day, outnumbering the real reset failures ~5:1.
 *
 * Decision (on the card): an event AT OR BELOW the lane's cursor IS served — the
 * cursor is a high-water mark, and marking behind it asserts nothing new. So
 * the answer is `served: true`, with `advanced: false` and a code naming WHICH
 * cursor already covers it. The 200-that-looks-like-a-failure goes away, and a
 * reader who cares that it did not advance can still see why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

async function withLane(run) {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const reg = await post(s.baseUrl, '/api/cursors/register', { bearerSeat: 'ada' });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const identity = reg.body.identity.key;
    const c1 = (await post(s.baseUrl, '/api/conversations', { author: 'bo', body: 'first' })).body;
    const c2 = (await post(s.baseUrl, '/api/conversations', { author: 'bo', body: 'second' })).body;
    await run({ base: s.baseUrl, identity, first: c1.id, second: c2.id });
  } finally { await s.stop(); }
}
const mark = (base, identity, conversationId) => post(base, '/api/cursors/served', { identity, conversationId });

test('#1460 CONTROL: a mark that advances the cursor answers served:true, advanced:true', async () => {
  await withLane(async ({ base, identity, second }) => {
    const r = await mark(base, identity, second);
    assert.equal(r.status, 200);
    assert.equal(r.body.served, true, JSON.stringify(r.body));
    assert.equal(r.body.advanced, true);
    assert.equal(r.body.last_served_seq, r.body.seq);
  });
});

test('#1460 ⭐ an EARLIER event marked after a later one is served (the cursor covers it), NOT a codeless false', async () => {
  await withLane(async ({ base, identity, first, second }) => {
    await mark(base, identity, second);
    const r = await mark(base, identity, first);
    assert.equal(r.status, 200);
    assert.equal(r.body.served, true, `the undefined-logging case: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.advanced, false, 'it did not move the cursor, and says so');
    assert.equal(r.body.code, 'ALREADY_PAST');
    assert.ok(r.body.last_served_seq > r.body.seq, 'the cursor that covers it is named');
  });
});

test('#1460 an event the lane already ACKED is served too, with its own code', async () => {
  await withLane(async ({ base, identity, first, second }) => {
    await mark(base, identity, second);
    const ack = await post(base, '/api/cursors/inbound', { identity });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    const r = await mark(base, identity, first);
    assert.equal(r.body.served, true, JSON.stringify(r.body));
    assert.equal(r.body.advanced, false);
    assert.equal(r.body.code, 'ALREADY_ACKED');
  });
});

test('#1460 the real failures still say served:false WITH a code — nothing became silently true', async () => {
  await withLane(async ({ base, identity }) => {
    const missing = await mark(base, identity, 'no-such-conversation');
    assert.equal(missing.body.served, false);
    assert.equal(missing.body.code, 'EVENT_NOT_FOUND');
  });
});
