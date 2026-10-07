/**
 * #1598 K11 (the whole-board save retires), THE FORGERY INVARIANTS KEPT AT THE BOUNDARY. The rows that existed to say "a client cannot forge X through `/api/save`" (outbox state, decoration fields, conversations with a forged counter and epoch,
 * a stale wholesale delete) tested a guarantee of a route that is going away: with `/api/save` answering 410 they have nothing left to exercise, and deleting them would also delete the invariant they pinned. This file keeps the invariant where
 * it still lives: each historical forgery payload is POSTed to `/api/save`, which must answer 410, and the stored state must be unchanged. Written by the separate test author. A REAL REST server, no executor, no browser, synthetic content.
 *
 * Each payload's row is CONTROLLED the way the old rows were: the old rows asserted "the save really wrote" first, because a refusal that changes nothing looks identical to a save that was sabotaged. Here the control is the other way round: a
 * per-card PATCH in the same server DOES change the stored title, so "unchanged" cannot be a server that stopped writing.
 *
 *   F1  OUTBOX: a forged, an emptied and a null `announcementOutbox` alongside a real retitle: 410, the title and the server's outbox unchanged. (was announcement-outbox-1574-c3a S2)
 *   F2  DECORATION: a card carrying `descriptionExcerpt` and `legacyArrayIndex`: 410, neither field becomes stored state. (was decoration-not-writable-1288, the /api/save row)
 *   F3  CONVERSATIONS: extra, renumbered, emptied and null conversations and a forged counter and epoch: 410, the server's posts, every postSeq and the next number unchanged. (was post-seq-1592 Q10b)
 *   F4  STALE WHOLESALE DELETE: a card list missing most of the board: 410, every card still there. (was api.test #230)
 *   F5  CONTENT TYPE: a `text/plain` body: refused (any 4xx), board unchanged. (was api-security's 415 row)
 *
 * NOT COVERED, by name: #1584 F5 (a save preserving move fences): the fence semantics are card-move routes' and are pinned in their own rows; the "2xx means landed" and "settled version" rows (#237, #466), which describe a success path that no
 * longer exists; the page's own `saveToJSONFile` (the browser suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const api = async (base, method, route, body, headers = { 'Content-Type': 'application/json' }) => {
  const res = await fetch(`${base}${route}`, { method, headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const newCard = async (base, title) => (await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada' })).body;
const titleOf = async (base, id) => (await api(base, 'GET', `/api/cards/${id}`)).body.title;
const snapshot = async (base) => (await api(base, 'GET', '/api/board')).body;
const retitled = (snap, id, title) => ({ cards: snap.cards.map((c) => (c.id === id ? { ...c, title } : c)), columns: snap.columns, nextShortId: snap.nextShortId });
const outbox = async (base) => (await api(base, 'GET', '/api/outbox')).body;
const posts = async (base) => (await api(base, 'GET', '/api/conversations')).body;
async function withServer(body) { const s = await startRestServer({ board: makeBoardFixture() }); try { return await body(s); } finally { await s.stop(); } }
/** the control: a per-card PATCH in this server really changes the stored title, so "unchanged" below cannot mean "the server stopped writing" */
async function controlPatchWrites(base, id) {
  const r = await api(base, 'PATCH', `/api/cards/${id}`, { title: 'control retitle', by: 'ada' });
  assert.ok(r.status < 300, `CONTROL: a per-card PATCH is accepted (${r.status} ${r.text.slice(0, 120)})`);
  assert.equal(await titleOf(base, id), 'control retitle', 'CONTROL: and it lands');
  await api(base, 'PATCH', `/api/cards/${id}`, { title: 'original', by: 'ada' });
  assert.equal(await titleOf(base, id), 'original', 'CONTROL: and can be put back');
}
const refused = (r, label) => assert.equal(r.status, 410, `${label}: a whole-board POST is refused with 410 (${r.status} ${r.text.slice(0, 160)})`);

test('F1 OUTBOX: a forged, an emptied and a null announcementOutbox beside a real retitle: 410, the title and the server\'s outbox unchanged', { timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const a = await newCard(s.baseUrl, 'original');
    await api(s.baseUrl, 'POST', `/api/cards/${a.id}/claim`, { by: 'ada' });
    await controlPatchWrites(s.baseUrl, a.id);
    const before = await outbox(s.baseUrl);
    const forged = { origins: { 'forged-mutation': { mutationId: 'forged-mutation', slots: ['claim'], origin: { cardId: a.id, version: 99 }, committedAt: new Date().toISOString() } }, entries: { 'forged-obligation': { obligationId: 'forged-obligation', mutationId: 'forged-mutation', slot: 'claim', status: 'published', payload: { author: 'board', body: 'forged', mentions: [], notify: 'none' } } } };
    for (const [label, variant] of [['a forged outbox', { announcementOutbox: forged }], ['an emptied outbox', { announcementOutbox: { origins: {}, entries: {} } }], ['a null outbox', { announcementOutbox: null }]]) {
      const snap = await snapshot(s.baseUrl);
      refused(await api(s.baseUrl, 'POST', '/api/save', { ...retitled(snap, a.id, `retitled under ${label}`), ...variant }), label);
      assert.equal(await titleOf(s.baseUrl, a.id), 'original', `${label}: the refused save changed nothing`);
      assert.deepEqual(await outbox(s.baseUrl), before, `${label}: the server's outbox is unchanged`);
    }
  });
});

test('F2 DECORATION: a card carrying descriptionExcerpt and legacyArrayIndex: 410, and neither becomes stored state', { timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const a = await newCard(s.baseUrl, 'original');
    await controlPatchWrites(s.baseUrl, a.id);
    const card = (await api(s.baseUrl, 'GET', `/api/cards/${a.id}`)).body;
    refused(await api(s.baseUrl, 'POST', '/api/save', { cards: [{ ...card, descriptionExcerpt: 'INJECTED…', legacyArrayIndex: 99 }] }), 'a decorated card');
    const after = (await api(s.baseUrl, 'GET', `/api/cards/${a.id}`)).body;
    assert.ok(after.descriptionExcerpt !== 'INJECTED…' && after.legacyArrayIndex !== 99, 'no decoration became stored state');
  });
});

test('F3 CONVERSATIONS: extra, renumbered, emptied and null conversations and a forged counter and epoch: 410, posts and numbering unchanged', { timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const say = (body) => api(s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body });
    for (const t of ['one', 'two', 'three']) assert.equal((await say(t)).status, 201);
    const a = await newCard(s.baseUrl, 'original'); await controlPatchWrites(s.baseUrl, a.id);
    const before = await posts(s.baseUrl); const snap = await snapshot(s.baseUrl);
    const seen = before;
    const hostile = [{ id: 'smuggled', body: 'an un-numbered post a snapshot tried to introduce', author: 'ada', createdAt: new Date().toISOString() }, { ...seen[0], postSeq: 99 }, { ...seen[1], postSeq: 1 }];
    for (const extra of [{ conversations: hostile }, { conversations: [] }, { conversations: null }, { conversations: hostile, nextPostSeq: 1, postSeqEpoch: 'forged' }]) {
      refused(await api(s.baseUrl, 'POST', '/api/save', { cards: snap.cards, columns: snap.columns, nextShortId: snap.nextShortId, ...extra }), JSON.stringify(Object.keys(extra)));
      assert.deepEqual(await posts(s.baseUrl), before, `${JSON.stringify(Object.keys(extra))}: the server's posts and every postSeq are unchanged`);
    }
    assert.equal((await say('four')).body.postSeq, 4, 'numbering carries on with no reuse and no reset');
  });
});

test('F4 STALE WHOLESALE DELETE: a card list missing most of the board: 410, every card still there', { timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const cards = []; for (const t of ['a', 'b', 'c', 'd', 'e']) cards.push(await newCard(s.baseUrl, t));
    await controlPatchWrites(s.baseUrl, cards[0].id);
    const snap = await snapshot(s.baseUrl);
    refused(await api(s.baseUrl, 'POST', '/api/save', { cards: snap.cards.slice(0, 1), columns: snap.columns, nextShortId: snap.nextShortId }), 'a stale wholesale delete');
    assert.equal((await api(s.baseUrl, 'GET', '/api/cards')).body.length, 5, 'all five cards are still there');
  });
});

test('F5 CONTENT TYPE: a text/plain body to /api/save is refused and the board is unchanged', { timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const a = await newCard(s.baseUrl, 'original'); await controlPatchWrites(s.baseUrl, a.id);
    const snap = await snapshot(s.baseUrl);
    const r = await api(s.baseUrl, 'POST', '/api/save', JSON.stringify(retitled(snap, a.id, 'via text/plain')), { 'Content-Type': 'text/plain' });
    assert.ok(r.status >= 400 && r.status < 500, `refused with a 4xx (${r.status} ${r.text.slice(0, 120)})`);
    assert.equal(await titleOf(s.baseUrl, a.id), 'original', 'and nothing changed');
  });
});
