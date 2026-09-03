/**
 * #1158 — a reworded condition must not FORK.
 *
 * acceptanceUpsert keys on the condition's exact text (#1137). Rewording a
 * condition through it inserted a twin and left the original behind with its
 * old, often empty, evidence — the card then read as carrying open work it did
 * not have (#1150 carried one). The rail guards the OPERATION, which every
 * seat performs: `replaces` names a rename in place; a near-identical text
 * without it is refused naming the twin. The negative control includes a
 * rewording that CHANGES THE OPENING, the case a prefix detector misses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';
import { patchWithVersion } from './helpers/versioned-patch.mjs';

const api = async (base, method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const SHA = 'c'.repeat(40);
const card = (id, shortId) => ({ id, shortId, title: `card ${shortId}`, description: '', type: 'task', labels: [], assignees: [], column: 'backlog', order: shortId, createdAt: '2026-08-01T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] } });
const board = () => makeBoardFixture({ cards: [card('r-1', 1)], nextShortId: 2 });
const OLD = '4. The replica-sync latency of the tending read is MEASURED and stated on this card';
const SEED = [
  { condition: '1. the live read comes from the graph', evidence: [SHA], note: 'one' },
  { condition: OLD, evidence: [SHA], note: 'the number', blockedBy: [] },
];
async function seeded() {
  const s = await startRestServer({ board: board() });
  const r = await patchWithVersion(s.baseUrl, 1, { acceptance: SEED, by: 'ada' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return s;
}
const acc = async (s) => (await api(s.baseUrl, 'GET', '/api/cards/1')).body.acceptance;

test('#1158 `replaces` renames a condition IN PLACE: one entry after, evidence and note kept, slot kept', async () => {
  const s = await seeded();
  try {
    const NEW = 'The tending read\'s replica-sync latency is MEASURED and stated on this card (condition 4)';
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: NEW, replaces: OLD }], by: 'bex' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await acc(s);
    assert.equal(a.length, 2, 'no twin');
    assert.equal(a[1].condition, NEW, 'renamed in the same slot');
    assert.deepEqual(a[1].evidence, [SHA], 'evidence carried');
    assert.equal(a[1].note, 'the number', 'note carried');
    assert.equal(a[1].replaces, undefined, 'the key is never stored');
    assert.ok(!a.some((e) => e.condition === OLD), 'the old text is gone');
  } finally { await s.stop(); }
});

test('#1158 ⛔ NEGATIVE CONTROL — a reworded condition WITHOUT `replaces` is refused naming the twin; nothing written — including a rewording that CHANGES THE OPENING', async () => {
  const s = await seeded();
  try {
    const before = await acc(s);
    for (const reword of [
      '4. The replica-sync latency of the tending read is MEASURED and stated on this card, at load',   // same opening
      'MEASURED and stated on this card: the replica-sync latency of the tending read',                 // opening changed — a prefix detector misses this
    ]) {
      const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: reword, evidence: [] }], by: 'bex' });
      assert.equal(r.status, 400, `${reword} → ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /REWORDING/);
      assert.ok(r.body.error.includes(OLD), 'the refusal names the twin');
      assert.match(r.body.error, /replaces/);
    }
    assert.deepEqual(await acc(s), before, 'a refused write changes nothing');
  } finally { await s.stop(); }
});

test('#1158 a genuinely NEW condition still inserts, and an EXACT-text upsert still replaces (the #1137 contract is unchanged)', async () => {
  const s = await seeded();
  try {
    const n = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: '5. two seats read the diff before it merges', evidence: [] }], by: 'bex' });
    assert.equal(n.status, 200, JSON.stringify(n.body));
    const e = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: OLD, evidence: [SHA], note: 'discharged' }], by: 'bex' });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    const a = await acc(s);
    assert.equal(a.length, 3);
    assert.equal(a.find((x) => x.condition === OLD).note, 'discharged');
  } finally { await s.stop(); }
});

test('#1158 `replaces` naming a condition that does not exist is refused; `replaces` on a whole-array write is refused', async () => {
  const s = await seeded();
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: 'x', replaces: 'no such condition' }], by: 'bex' });
    assert.equal(r.status, 400); assert.match(r.body.error, /names no existing condition/);
    const cur = (await api(s.baseUrl, 'GET', '/api/cards/1')).body;
    const w = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptance: [{ condition: 'y', replaces: OLD }], by: 'bex', ifVersion: cur.version });
    assert.equal(w.status, 400); assert.match(w.body.error, /acceptanceUpsert key/);
    assert.equal((await acc(s)).length, 2);
  } finally { await s.stop(); }
});

test('#1158 REACHABILITY — `replaces` is declared on card_update over MCP and the description names the fork', async () => {
  const pair = await startPair({ board: board() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const tools = await session.listTools();
    const props = tools.result.tools.find((t) => t.name === 'card_update').inputSchema.properties;
    assert.ok(props.acceptanceUpsert.items.properties.replaces, 'replaces declared');
    assert.match(props.acceptanceUpsert.description, /twin/);
    await patchWithVersion(pair.rest.baseUrl, 1, { acceptance: SEED, by: 'ada' });
    const call = await session.callTool('card_update', { id: '1', acceptanceUpsert: [{ condition: 'The tending read latency, MEASURED (4)', replaces: OLD }], by: 'bex' });
    assert.ok(!call.result?.isError, JSON.stringify(call));
    const a = (await api(pair.rest.baseUrl, 'GET', '/api/cards/1')).body.acceptance;
    assert.equal(a.length, 2); assert.deepEqual(a[1].evidence, [SHA]);
  } finally { await pair.stop(); }
});
