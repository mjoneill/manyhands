/**
 * D1g-0 — THE `conversation_get` BOARD TOOL. Pre-registered by the separate test author BEFORE it exists. Copy unchanged into tests/. PURE: no server, no executor.
 *
 * WHY: with pushes carrying only a post id (decision 3dc9df18), the receiving seat reads the post itself. The resident's runtime builds its tools from
 * `core/board-tools.mjs` `toolsFor(agent)`, which maps `agent.toolGrants` over a FIXED catalog that has no `conversation_get`, so an id-only wake lands on a
 * seat with nothing to call (reported by the resident from inside her own wake, and read in the code). This file pins the CODE half only: the catalog entry and
 * what the executor does with it. The GRANT on any agent record is a separate, permission-changing act (a live grant is the owner's) and is NOT in this file.
 *
 * PINNED: the catalog has a read-only `conversation_get({id})`; adding it widens NO existing agent (no grants, no tools; the nine existing grants map to the
 * same nine tools); the executor reads `GET /api/conversations/<id>` (id encoded), passes the server's answer through unchanged (a tombstone stays a tombstone,
 * the tool adds no content), never writes, and never turns an unreadable or unknown answer into something post-shaped.
 * NOT COVERED, BY NAME: that a given seat's real runtime MOUNTS the tool (the thin-slice demonstration in the resident's own wake), MCP-side tool wrappers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TOOLS, toolsFor, makeExecutor } from '../core/board-tools.mjs';

const NINE = ['card_get', 'board_search', 'graph_query', 'graph_authority', 'predicate_list', 'kind_list', 'seat_declare', 'seat_clear', 'memory_update'];
const names = (ts) => ts.map((t) => t.function.name);
const spy = () => { const calls = []; const mk = (verb, impl) => async (...a) => { calls.push([verb, ...a]); return impl ? impl(...a) : { ok: true }; }; return { calls, mk }; };

test('G0 the catalog gains a read-only `conversation_get` that takes an id: a string, required, and nothing that writes', () => {
  const t = BOARD_TOOLS.find((x) => x.function.name === 'conversation_get');
  assert.ok(t, 'conversation_get is in the catalog');
  assert.equal(t.type, 'function');
  const p = t.function.parameters; assert.equal(p.type, 'object');
  assert.deepEqual(Object.keys(p.properties), ['id']); assert.equal(p.properties.id.type, 'string'); assert.deepEqual(p.required, ['id']);
  assert.match(t.function.description, /read/i); assert.doesNotMatch(t.function.description, /\b(post|write|create|delete|edit)s? (a|the) (new )?(message|post)\b/i, 'it describes reading, not writing');
  assert.equal(new Set(names(BOARD_TOOLS)).size, BOARD_TOOLS.length, 'no duplicate tool names');
});

test('G1 NO GRANTS, NO TOOLS and NO WIDENING: adding the entry gives an agent with no grants nothing, and an agent holding exactly the nine existing grants still gets exactly those nine; only an explicit grant yields `conversation_get`', () => {
  assert.deepEqual(toolsFor({}), []); assert.deepEqual(toolsFor({ toolGrants: [] }), []); assert.deepEqual(toolsFor(), []);
  assert.deepEqual(names(toolsFor({ toolGrants: NINE })), NINE, 'the existing nine grants map to the same nine tools');
  assert.ok(!names(toolsFor({ toolGrants: NINE })).includes('conversation_get'), 'the new tool is not handed to anyone by default');
  assert.deepEqual(names(toolsFor({ toolGrants: ['conversation_get'] })), ['conversation_get'], 'an explicit grant yields it');
  assert.deepEqual(names(toolsFor({ toolGrants: ['conversation_get', 'no_such_tool'] })), ['conversation_get'], 'an unknown grant is ignored, as today');
});

test('G2 THE EXECUTOR READS THE POST BY ID and only reads: GET /api/conversations/<id> with the id URL-encoded (a hostile id cannot aim the request elsewhere); no post/put/delete/patch is ever called', async () => {
  const s = spy(); const answer = { id: 'abc', body: 'hello', author: 'ada', postSeq: 7 };
  const execute = makeExecutor({ get: s.mk('get', () => answer), post: s.mk('post'), put: s.mk('put'), del: s.mk('del'), patch: s.mk('patch') });
  const out = await execute('conversation_get', { id: 'abc' });
  assert.deepEqual(out, answer, 'the server\'s answer comes back unchanged');
  await execute('conversation_get', { id: '../cards/1?x=y#z' });
  const gets = s.calls.filter((c) => c[0] === 'get'); assert.equal(gets.length, 2);
  assert.equal(gets[0][1], '/api/conversations/abc');
  assert.equal(gets[1][1], `/api/conversations/${encodeURIComponent('../cards/1?x=y#z')}`, 'the id is encoded into ONE path segment');
  assert.deepEqual(s.calls.filter((c) => c[0] !== 'get'), [], 'no write verb was called');
});

test('G3 A TOMBSTONE PASSES THROUGH UNCHANGED and the tool adds nothing: the answer {id, postSeq, redacted:true, body:null} comes back exactly, with no note, text or field of its own', async () => {
  const tomb = { id: 'abc', postSeq: 7, redacted: true, body: null };
  const execute = makeExecutor({ get: async () => tomb });
  assert.deepEqual(await execute('conversation_get', { id: 'abc' }), tomb);
});

test('G4 A MISSING ID IS REFUSED CLEARLY and calls nothing: no id (undefined, null, empty, whitespace) throws a message naming `id`, and no request is made', async () => {
  const s = spy(); const execute = makeExecutor({ get: s.mk('get') });
  for (const bad of [undefined, null, '', '   ']) await assert.rejects(() => execute('conversation_get', { id: bad }), /id/i);
  await assert.rejects(() => execute('conversation_get', {}), /id/i);
  assert.deepEqual(s.calls, [], 'nothing was fetched');
});

test('G5 UNKNOWN AND UNREADABLE ANSWERS ARE NEVER POST-SHAPED: a 404 from the board and a 503/transport failure each either reject or come back as an explicit not-found / UNAVAILABLE marker; neither returns an empty object, an empty body, or anything that reads as a post', async () => {
  const notFound = Object.assign(new Error('Conversation not found'), { status: 404 });
  const unavailable = Object.assign(new Error('graph unavailable'), { status: 503 });
  assert.deepEqual(await makeExecutor({ get: async () => ({ id: 'abc', body: 'ok' }) })('conversation_get', { id: 'abc' }), { id: 'abc', body: 'ok' }, 'control: with a readable board the tool exists and answers (so a rejection below is about the failure, not about a missing tool)');
  for (const [label, err] of [['404', notFound], ['503', unavailable], ['transport', new TypeError('fetch failed')]]) {
    const execute = makeExecutor({ get: async () => { throw err; } });
    let out, threw = false; try { out = await execute('conversation_get', { id: 'abc' }); } catch (e) { threw = true; assert.doesNotMatch(String(e?.message), /no such tool/i, `${label}: a rejection for a missing tool is not a handled failure`); }
    if (!threw) {
      assert.ok(out && typeof out === 'object', `${label}: an explicit marker, not nothing`);
      assert.ok(out.found === false || out.status === 'UNAVAILABLE', `${label}: marked not-found or UNAVAILABLE: ${JSON.stringify(out)}`);
      assert.ok(!('body' in out) || out.body == null, `${label}: no post body`);
    }
  }
});

test('G6 DOT SEGMENTS: `.` and `..` survive encodeURIComponent and a URL layer may normalize them away (`/api/conversations/..` is `/api/`), so they are REFUSED before any request, naming the id; ids that merely CONTAIN dots, a percent-encoded dot sequence or slashes are encoded into ONE segment and still fetched as that segment', async () => {
  const s = spy(); const execute = makeExecutor({ get: s.mk('get', () => ({ id: 'x' })) });
  assert.deepEqual(await execute('conversation_get', { id: 'abc' }), { id: 'x' }, 'control: the tool exists and fetches a plain id');
  const before = s.calls.length;
  for (const bad of ['.', '..', ' . ', ' .. ']) await assert.rejects(() => execute('conversation_get', { id: bad }), /id/i, `${JSON.stringify(bad)} is refused`);
  assert.equal(s.calls.length, before, 'no request was made for a dot segment');
  for (const odd of ['a.b', '...', '%2e%2e', '%2E%2E/x', 'a/b', '..%2f..']) {
    await execute('conversation_get', { id: odd });
    const path = s.calls.at(-1)[1];
    assert.equal(path, `/api/conversations/${encodeURIComponent(odd)}`, `${JSON.stringify(odd)} is exactly one encoded segment`);
    assert.equal(path.slice('/api/conversations/'.length).includes('/'), false, `${JSON.stringify(odd)}: no raw slash in the segment`);
    assert.ok(!/(^|\/)\.\.?(\/|$)/.test(path), `${JSON.stringify(odd)}: the path contains no dot segment`);
  }
});
