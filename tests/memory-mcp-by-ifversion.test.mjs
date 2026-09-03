/**
 * #1106 — memory_update's MCP schema dropped `ifVersion` AND `by`, and
 * memory_create dropped `by`. #466's memory CAS shipped at REST and was
 * unreachable from the tool every seat uses; worse, a write by a non-owner
 * was recorded as the OWNER's, and the laundered byline is byte-identical to
 * an honest one. The sibling (card_update, #534) carried the lesson in a
 * comment; this file is the check the sibling never got.
 *
 * Every assertion here goes THROUGH the MCP session, because REST already
 * passed — the defect is reachability, and a curl cannot see it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';

const api = async (base, method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const text = (call) => call.result?.content?.map((c) => c.text ?? '').join('') ?? '';
const parsed = (call) => JSON.parse(text(call));
const versions = async (base, id) => (await api(base, 'GET', `/api/memories/${id}/versions`)).body.versions;

test('#1106 REACHABILITY — memory_update declares ifVersion and by; memory_create declares by', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [] }) });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const tools = (await session.listTools()).result.tools;
    const upd = tools.find((t) => t.name === 'memory_update').inputSchema.properties;
    const cre = tools.find((t) => t.name === 'memory_create').inputSchema.properties;
    assert.ok(upd.ifVersion, 'memory_update.ifVersion declared');
    assert.ok(upd.by, 'memory_update.by declared');
    assert.ok(cre.by, 'memory_create.by declared');
    assert.match(upd.by.description, /owner/i, 'the description says what happens WITHOUT it');
  } finally { await pair.stop(); }
});

test('#1106 ATTRIBUTION — a non-owner writing through MCP with `by` is recorded as THEMSELVES, on create and on update', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [] }) });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const c = await session.callTool('memory_create', { owner: 'ada', title: 'shared guide', body: 'v1 text', by: 'bo' });
    assert.ok(!c.result?.isError, text(c));
    const id = parsed(c).id;
    let v = await versions(pair.rest.baseUrl, id);
    assert.equal(v[0].author, 'bo', 'v1 author is the WRITER, not the owner');

    const u = await session.callTool('memory_update', { id, bodyAppend: '\nv2 addition', by: 'bex' });
    assert.ok(!u.result?.isError, text(u));
    v = await versions(pair.rest.baseUrl, id);
    assert.equal(v.length, 2);
    assert.equal(v[1].author, 'bex', 'v2 author is the writer');
  } finally { await pair.stop(); }
});

test('#1106 CAS — a stale ifVersion through MCP is REFUSED and writes nothing; the correct one advances', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [] }) });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const c = await session.callTool('memory_create', { owner: 'ada', title: 't', body: 'ONE', by: 'ada' });
    const id = parsed(c).id;
    // someone else moved it on
    const other = await api(pair.rest.baseUrl, 'PATCH', `/api/memories/${id}`, { body: 'TWO', by: 'bo' });
    assert.equal(other.status, 200);
    const stale = await session.callTool('memory_update', { id, body: 'FROM STALE', ifVersion: 1, by: 'bex' });
    assert.ok(stale.result?.isError, 'stale ifVersion must surface as an error through the tool');
    assert.match(text(stale), /moved on|409/);
    let v = await versions(pair.rest.baseUrl, id);
    assert.equal(v.length, 2, 'the refused write left nothing');
    assert.equal(v[1].body, 'TWO');

    const ok = await session.callTool('memory_update', { id, body: 'THREE', ifVersion: 2, by: 'bex' });
    assert.ok(!ok.result?.isError, text(ok));
    v = await versions(pair.rest.baseUrl, id);
    assert.equal(v.length, 3);
    assert.equal(v[2].author, 'bex');
  } finally { await pair.stop(); }
});

test('#1106 NEGATIVE CONTROL — without `by` the shipped fallback is UNCHANGED: the owner is recorded, and no ifVersion means no precondition', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [] }) });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const c = await session.callTool('memory_create', { owner: 'ada', title: 't', body: 'ONE' });
    const id = parsed(c).id;
    const u = await session.callTool('memory_update', { id, body: 'TWO' });
    assert.ok(!u.result?.isError, text(u));
    const v = await versions(pair.rest.baseUrl, id);
    assert.deepEqual(v.map((x) => x.author), ['ada', 'ada'], 'fallback to owner is a contract this card does NOT change (named on #1106, not decided)');
  } finally { await pair.stop(); }
});
