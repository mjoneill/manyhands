/**
 * #1066 — relationshipsAdd / relationshipsRemove.
 *
 * `relationships` MERGES at the type level and REPLACES within a type: the
 * array you send IS the new array. Its doc read like "add", and 68 edges
 * across three seats and four months were lost by callers sending only the
 * targets they meant to add. These verbs are the add and the remove spelled
 * so they cannot be spelled as a destructive write: send only the targets
 * you are changing, the server composes under its write lock, inverse edges
 * are maintained exactly as a whole-array write would maintain them, and no
 * ifVersion is needed because nothing not sent can be lost. The #1137 shape,
 * one field over. These tests are the card's release conditions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(baseUrl, method, path, body) {
  const payload = body ? JSON.stringify(body) : undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(payload ? { body: payload } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const rel = (over = {}) => ({ relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [], ...over });
const card = (id, shortId, relationships = rel()) => ({
  id, shortId, title: `card ${shortId}`, description: '', type: 'task', labels: [], assignees: [],
  column: 'backlog', order: shortId, createdAt: '2026-08-01T00:00:00.000Z', relationships,
});
// #1 already relates to #2 and #3 (both ends carried, as the server keeps them).
const board = () => makeBoardFixture({
  cards: [
    card('r-1', 1, rel({ relatedTo: [2, 3], blockedBy: [4] })),
    card('r-2', 2, rel({ relatedTo: [1] })),
    card('r-3', 3, rel({ relatedTo: [1] })),
    card('r-4', 4), card('r-5', 5), card('r-6', 6),
  ],
  nextShortId: 7,
});
const relOf = async (baseUrl, sid) => (await api(baseUrl, 'GET', `/api/cards/${sid}`)).body.relationships;

test('#1066 relationshipsAdd adds ONE target; every existing edge survives; the inverse lands on the target', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { relationshipsAdd: { relatedTo: [5] }, by: 'ada' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignoredFields, undefined, 'the verb must not be validated-then-discarded');
    const one = await relOf(s.baseUrl, 1);
    assert.deepEqual(one.relatedTo, [2, 3, 5], 'the two edges the caller did not send are still there');
    assert.deepEqual(one.blockedBy, [4], 'a type the caller did not name is untouched');
    assert.deepEqual((await relOf(s.baseUrl, 5)).relatedTo, [1], 'inverse maintained as a whole-array write would');
  } finally { await s.stop(); }
});

test('#1066 ⛔ THE CLOBBER — the pattern that lost 68 edges: two seats each ADD one target, no ifVersion, no await between; BOTH survive', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const [a, b] = await Promise.all([
      api(s.baseUrl, 'PATCH', '/api/cards/1', { relationshipsAdd: { relatedTo: [5] }, by: 'ada' }),
      api(s.baseUrl, 'PATCH', '/api/cards/1', { relationshipsAdd: { relatedTo: [6] }, by: 'bex' }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const one = await relOf(s.baseUrl, 1);
    assert.deepEqual([...one.relatedTo].sort(), [2, 3, 5, 6], 'neither add deleted the other, and the originals survive');
    assert.deepEqual((await relOf(s.baseUrl, 5)).relatedTo, [1]);
    assert.deepEqual((await relOf(s.baseUrl, 6)).relatedTo, [1]);
  } finally { await s.stop(); }
});

test('#1066 relationshipsRemove removes EXACTLY the target named, drops its inverse, leaves the rest', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { relationshipsRemove: { relatedTo: [2] }, by: 'ada' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [3]);
    assert.deepEqual((await relOf(s.baseUrl, 2)).relatedTo, [], 'the inverse on the removed target is gone too');
    assert.deepEqual((await relOf(s.baseUrl, 3)).relatedTo, [1], 'the untouched target keeps its inverse');
  } finally { await s.stop(); }
});

test('#1066 add of a target already present and remove of a target absent are both quiet no-ops — idempotent, 200, no duplicate edge', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const a = await api(s.baseUrl, 'PATCH', '/api/cards/1', { relationshipsAdd: { relatedTo: [2] }, by: 'ada' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [2, 3], 'no duplicate');
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { relationshipsRemove: { relatedTo: [6] }, by: 'ada' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [2, 3]);
  } finally { await s.stop(); }
});

test('#1066 add and remove in ONE write on different targets compose; the SAME target in both is refused as a contradiction', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const ok = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      relationshipsAdd: { relatedTo: [5] }, relationshipsRemove: { relatedTo: [3] }, by: 'ada',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [2, 5]);
    const bad = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      relationshipsAdd: { relatedTo: [6] }, relationshipsRemove: { relatedTo: [6] }, by: 'ada',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /6/);
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [2, 5], 'a refused write changes nothing');
  } finally { await s.stop(); }
});

test('#1066 malformed verbs are refused in the whole-field validator\'s own words, and write NOTHING', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const before = await relOf(s.baseUrl, 1);
    const cases = [
      [{ relationshipsAdd: { relatedTo: ['x'] } }, /shortIds \(integers\)/],
      [{ relationshipsAdd: { sideways: [2] } }, /unknown relationship type/],
      [{ relationshipsAdd: { supersededBy: [2] } }, /maintained by the server/],
      [{ relationshipsAdd: {} }, /empty/],
      [{ relationshipsAdd: [2] }, /object/],
      [{ relationshipsRemove: { relatedTo: 2 } }, /must be an array/],
    ];
    for (const [body, re] of cases) {
      const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { ...body, by: 'ada' });
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, re, JSON.stringify(body));
    }
    assert.deepEqual(await relOf(s.baseUrl, 1), before);
  } finally { await s.stop(); }
});

test('#1066 NEGATIVE CONTROL — `relationships` (replace) and a verb in ONE write → 400: two intentions', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      relationships: { relatedTo: [5] }, relationshipsAdd: { relatedTo: [6] }, by: 'ada',
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /relationshipsAdd/);
    assert.match(r.body.error, /relationships /);
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [2, 3]);
  } finally { await s.stop(); }
});

test('#1066 the verbs are PATCH-only: on create they are NOT silently dropped — the #823 disclosure names them (create takes `relationships`)', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'POST', '/api/cards', { title: 'new', createdBy: 'ada', relationshipsAdd: { relatedTo: [1] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok((r.body.ignoredFields || []).includes('relationshipsAdd'), `create must SAY it ignored the verb: ${JSON.stringify(r.body.ignoredFields)}`);
    assert.deepEqual((await relOf(s.baseUrl, 7)).relatedTo, [], 'and stored no edge from it');
  } finally { await s.stop(); }
});

test('#1066 the doc for `relationships` says REPLACES WITHIN A TYPE in those words — the sentence that was missing', async () => {
  const s = await startRestServer({ board: board() });
  try {
    // The MCP tool description is the doc every seat reads; it is asserted in
    // the MCP test below. Here: the REST error for a whole-array write that
    // would DROP targets names the verb that would not have.
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { relationships: { relatedTo: [5] }, by: 'ada' });
    assert.equal(r.status, 200, 'a replace is still legal — the doc fix is words, the verb is the rail');
    assert.deepEqual((await relOf(s.baseUrl, 1)).relatedTo, [5], 'and it still REPLACES: 2 and 3 are gone. This is the defect, kept, documented.');
  } finally { await s.stop(); }
});

// REACHABILITY — the MCP inputSchema is a zod allowlist that strips what it
// omits (#534's ifVersion shipped at REST and was unreachable from
// card_update). The seats who lost the 68 edges write through MCP, so a verb
// they cannot reach fixes nothing. Driven through a real session.
import { startPair, mcpSession } from './helpers/harness.mjs';

test('#1066 REACHABILITY — relationshipsAdd through card_update over a REAL MCP session lands the edge; the `relationships` doc says REPLACES', async () => {
  const pair = await startPair({ board: board() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const tools = await session.listTools();
    const upd = tools.result.tools.find((t) => t.name === 'card_update');
    const props = upd.inputSchema.properties;
    assert.ok(props.relationshipsAdd && props.relationshipsRemove, 'both verbs declared in the MCP schema');
    assert.match(props.relationships.description, /REPLACES WITHIN A TYPE/);
    assert.match(props.relationships.description, /relationshipsAdd/);
    const call = await session.callTool('card_update', { id: '1', relationshipsAdd: { relatedTo: [5] }, by: 'ada' });
    assert.ok(!call.result?.isError, JSON.stringify(call));
    assert.deepEqual((await relOf(pair.rest.baseUrl, 1)).relatedTo, [2, 3, 5]);
    assert.deepEqual((await relOf(pair.rest.baseUrl, 5)).relatedTo, [1]);
  } finally { await pair.stop(); }
});
