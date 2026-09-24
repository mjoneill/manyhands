/**
 * #1406 slice 1 — `memory_assemble`: a seat's memories, assembled to a BUDGET.
 *
 * The ask, carried on #971: "your memory file locally could reference
 * a graph query that assembles the memories you want at query time." So a
 * session-start hook can PULL instead of a file holding copies, and the byte
 * ceiling becomes a budget parameter rather than a truncation.
 *
 * ⭐ What this pins beyond the card's TEST section, from #1438's tradeoffs: a
 * budget "can silently truncate what mattered" and "a seat cannot know what was
 * summarised away". So whatever does not fit is NAMED — id and title, in the
 * payload and in the text — and the seat can walk back to it by id. Left out
 * is never the same as absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleMemories } from '../core/memory-assemble.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const bytes = (s) => Buffer.byteLength(s, 'utf8');

function fixture() {
  const out = [];
  const owners = ['ada', 'grace', 'hopper'];
  const prios = ['p0', 'p1', 'p2', 'p3', undefined];
  for (let i = 0; i < 300; i++) {
    out.push({
      id: `m${i}`,
      title: `lesson ${i}`,
      owner: owners[i % 3],
      tags: [],
      ...(prios[i % 5] ? { priority: prios[i % 5] } : {}),
      body: `body of lesson ${i} — `.padEnd(80 + (i % 7) * 20, 'x'),
      version: 1,
      updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    });
  }
  return out;
}

const RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const rank = (m) => (m.priority in RANK ? RANK[m.priority] : 4);

test('#1406 300 memories, 3 seats, 4 KB: within budget, one owner, priority then recency', () => {
  const all = fixture();
  const a = assembleMemories(all, { owner: 'ada', budgetBytes: 4096 });
  assert.ok(bytes(a.text) <= 4096, `text is ${bytes(a.text)} bytes`);
  assert.equal(a.bytes, bytes(a.text));
  assert.ok(a.included.length > 0);
  const byId = new Map(all.map((m) => [m.id, m]));
  for (const id of a.included) assert.equal(byId.get(id).owner, 'ada');
  for (let i = 1; i < a.included.length; i++) {
    const p = byId.get(a.included[i - 1]);
    const q = byId.get(a.included[i]);
    assert.ok(rank(p) < rank(q) || (rank(p) === rank(q) && p.updatedAt >= q.updatedAt),
      `${p.id} (${p.priority},${p.updatedAt}) before ${q.id} (${q.priority},${q.updatedAt})`);
  }
  // Sabotage found the order loop above can pass VACUOUSLY: at 4 KB every
  // included memory may share one rank. So pin the two ends too — the lead is
  // ada's best rank, and nothing omitted outranks anything included.
  const adaRanks = all.filter((m) => m.owner === 'ada').map(rank);
  assert.equal(rank(byId.get(a.included[0])), Math.min(...adaRanks), 'the best-ranked memory leads');
  const worstIncluded = Math.max(...a.included.map((id) => rank(byId.get(id))));
  for (const o of a.omitted) assert.ok(rank(byId.get(o.id)) >= worstIncluded, `omitted ${o.id} outranks an included memory`);
  // every one of ada's memories is either included or named as omitted
  const adas = all.filter((m) => m.owner === 'ada').length;
  assert.equal(a.included.length + a.omitted.length, adas);
});

test('#1406 what does not fit is NAMED, in the payload and in the text', () => {
  const a = assembleMemories(fixture(), { owner: 'ada', budgetBytes: 4096 });
  assert.ok(a.omitted.length > 0, 'the fixture must overflow 4 KB');
  for (const o of a.omitted) assert.ok(o.id && o.title);
  assert.match(a.text, /not included/i);
  assert.ok(a.text.includes(a.omitted[0].id), 'the first omitted id is in the text, so the seat can fetch it');
});

test('#1406 the budget holds even when the omitted list itself would not fit', () => {
  const a = assembleMemories(fixture(), { owner: 'ada', budgetBytes: 600 });
  assert.ok(bytes(a.text) <= 600, `text is ${bytes(a.text)} bytes`);
  assert.ok(a.omitted.length > 0);
});

test('#1406 memories that fit EXACTLY come back whole — the footer reserve is held only when something overflows', () => {
  // Reproduced in review: the reserve was held back on every include
  // check, so a seat whose memories fit its budget still lost one.
  const three = [0, 1, 2].map((i) => ({ id: `m${i}`, title: `t${i}`, owner: 'ada', tags: [], priority: 'p1',
    body: 'y'.repeat(300), version: 1, updatedAt: `2026-09-0${i + 1}T00:00:00.000Z` }));
  const whole = assembleMemories(three, { owner: 'ada', budgetBytes: 100000 });
  const exact = assembleMemories(three, { owner: 'ada', budgetBytes: whole.bytes });
  assert.deepEqual(exact.omitted, [], 'nothing omitted at exactly the needed size');
  assert.equal(exact.included.length, 3);
  assert.equal(exact.text, whole.text);
  const tight = assembleMemories(three, { owner: 'ada', budgetBytes: whole.bytes - 1 });
  assert.ok(tight.omitted.length > 0, 'one byte short does overflow');
  assert.ok(Buffer.byteLength(tight.text, 'utf8') <= whole.bytes - 1);
});

test('#1406 a memory added after the first assembly appears in the second, nothing else touched', () => {
  const all = fixture();
  const first = assembleMemories(all, { owner: 'grace', budgetBytes: 4096 });
  all.push({ id: 'new1', title: 'fresh p0 lesson', owner: 'grace', tags: [], priority: 'p0',
    body: 'learned just now', version: 1, updatedAt: '2026-09-24T13:00:00.000Z' });
  const second = assembleMemories(all, { owner: 'grace', budgetBytes: 4096 });
  assert.ok(!first.included.includes('new1'));
  assert.equal(second.included[0], 'new1', 'a newest p0 leads');
});

test('#1406 an empty seat assembles to an explicit "no memories", never an empty string', () => {
  const a = assembleMemories(fixture(), { owner: 'nobody', budgetBytes: 4096 });
  assert.deepEqual(a.included, []);
  assert.deepEqual(a.omitted, []);
  assert.match(a.text, /no memories/i);
  assert.match(a.text, /nobody/);
});

test('#1406 a budget must be a positive integer — refused, never defaulted silently', () => {
  for (const budgetBytes of [0, -5, 1.5, undefined, '4096']) {
    assert.throws(() => assembleMemories([], { owner: 'ada', budgetBytes }), /budget/i);
  }
  assert.throws(() => assembleMemories([], { budgetBytes: 4096 }), /owner/i);
});

// ── the seam: the REST read the session-start hook will actually call ──────────

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('#1406 GET /api/memories/assemble returns the assembly from the live store', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const low = await api(s.baseUrl, 'POST', '/api/memories', { title: 'low', body: 'a p3 lesson', owner: 'ada', tags: [], priority: 'p3' });
    assert.equal(low.status, 201, JSON.stringify(low.body));
    const high = await api(s.baseUrl, 'POST', '/api/memories', { title: 'high', body: 'a p0 lesson', owner: 'ada', tags: [], priority: 'p0' });
    assert.equal(high.status, 201, JSON.stringify(high.body));
    await api(s.baseUrl, 'POST', '/api/memories', { title: 'not mine', body: 'grace only', owner: 'grace', tags: [] });

    const r = await api(s.baseUrl, 'GET', '/api/memories/assemble?owner=ada&budget=4096');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.included, [high.body.id, low.body.id]);
    assert.ok(!r.body.text.includes('grace only'));
    assert.ok(Buffer.byteLength(r.body.text, 'utf8') <= 4096);
  } finally { await s.stop(); }
});

test('#1406 GET /api/memories/assemble refuses a missing owner or budget with 400', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await api(s.baseUrl, 'GET', '/api/memories/assemble?budget=4096')).status, 400);
    assert.equal((await api(s.baseUrl, 'GET', '/api/memories/assemble?owner=ada')).status, 400);
    assert.equal((await api(s.baseUrl, 'GET', '/api/memories/assemble?owner=ada&budget=0')).status, 400);
  } finally { await s.stop(); }
});

// ── the seam a seat crosses: the MCP tool, not the curl ────────────────────────
import { startPair, mcpSession } from './helpers/harness.mjs';

test('#1406 THROUGH MCP — memory_assemble is declared and returns the same assembly REST does', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [] }) });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const tools = (await session.listTools()).result.tools;
    const t = tools.find((x) => x.name === 'memory_assemble');
    assert.ok(t, 'memory_assemble is a declared tool');
    assert.ok(t.inputSchema.properties.owner && t.inputSchema.properties.budgetBytes);

    await session.callTool('memory_create', { owner: 'ada', title: 'kept', body: 'the lesson', by: 'ada', priority: 'p1' });
    const call = await session.callTool('memory_assemble', { owner: 'ada', budgetBytes: 2048 });
    assert.ok(!call.result?.isError, JSON.stringify(call));
    const out = JSON.parse(call.result.content.map((c) => c.text ?? '').join(''));
    assert.equal(out.included.length, 1);
    assert.match(out.text, /the lesson/);
    const rest = await (await fetch(`${pair.rest.baseUrl}/api/memories/assemble?owner=ada&budget=2048`)).json();
    assert.deepEqual(out, rest, 'the tool is the REST read, unchanged');
  } finally { await pair.stop(); }
});
