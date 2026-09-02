/**
 * #1132 — a whole-array REPLACE without `ifVersion` is REFUSED.
 *
 * `acceptance`, `blockers` and `checks` have no append verb: every write
 * replaces the array. Their only protection against a concurrent writer is
 * the #534 compare-and-swap, and it was OPTIONAL — so a careful seat who
 * fetched, mutated, wrote once and read back could still delete an entry
 * that arrived while she was composing, and her read-back would pass
 * (measured 2026-09-02 05:18Z on #209). The discipline was present and
 * insufficient; that is the argument for a rail. Absence of a precondition
 * must not masquerade as a decision (#966's principle on a write path).
 *
 * Scope is exactly the three arrays on PATCH. Controls pin that the
 * description paths, create, and every other field are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'one', description: 'body', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z',
      relationships: { blockedBy: [2] }, version: 3,
      checks: [{ claim: 'existing', ask: 'ASK { ?c a schema:CreativeWork }', expect: true }] },
    { id: 'u-2', shortId: 2, title: 'two', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 3,
});

const ARRAYS = {
  acceptance: [{ condition: 'RC1', evidence: [] }],
  blockers: [{ card: 2, status: 'open', owner: 'ada' }],
  checks: [{ claim: 'c', ask: 'ASK { ?x a schema:CreativeWork }', expect: true }],
};

test('#1132 each of the three arrays is REFUSED without ifVersion, and the refusal names the fix', async () => {
  const s = await startRestServer({ board: board() });
  try {
    for (const [field, value] of Object.entries(ARRAYS)) {
      const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'ada', [field]: value });
      assert.equal(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /ifVersion/, `${field}: names the precondition`);
      assert.match(r.body.error, /1132|whole array|REPLACE/i, `${field}: says why`);
      const after = (await api(s.baseUrl, 'GET', '/api/cards/1')).body;
      assert.deepEqual(after.checks, board().cards[0].checks, `${field}: nothing was written`);
    }
    // an EMPTY array is a CLEAR — it clobbers a concurrent entry just the same
    const clear = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'ada', checks: [] });
    assert.equal(clear.status, 400, 'clearing without ifVersion is refused too');
  } finally { await s.stop(); }
});

test('#1132 with the version you read, the write lands; with a stale one it is a 409 (unchanged #534 behaviour)', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const v = (await api(s.baseUrl, 'GET', '/api/cards/1')).body.version;
    const ok = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'ada', ifVersion: v, checks: ARRAYS.checks });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.checks.length, 1);
    assert.equal(ok.body.checks[0].claim, 'c');
    const stale = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'bo', ifVersion: v, checks: [] });
    assert.equal(stale.status, 409, 'the version moved: a concurrent writer is REFUSED, not silently overwritten');
    assert.equal((await api(s.baseUrl, 'GET', '/api/cards/1')).body.checks[0].claim, 'c', 'ada\'s entry survived bo\'s stale clear');
  } finally { await s.stop(); }
});

test('#1132 CONTROLS: description, descriptionAppend, title, column, and create with arrays all still work without ifVersion', async () => {
  const s = await startRestServer({ board: board() });
  try {
    for (const patch of [{ description: 'new' }, { descriptionAppend: '\nmore' }, { title: 'renamed' }, { column: 'planned' }, { labels: ['x'] }]) {
      const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'ada', ...patch });
      assert.equal(r.status, 200, `${Object.keys(patch)[0]} without ifVersion: ${JSON.stringify(r.body)}`);
    }
    const c = await api(s.baseUrl, 'POST', '/api/cards', { title: 'fresh', createdBy: 'ada', checks: ARRAYS.checks, acceptance: ARRAYS.acceptance });
    assert.equal(c.status, 201, `create carries arrays with no version to compare: ${JSON.stringify(c.body)}`);
    assert.equal(c.body.checks.length, 1);
  } finally { await s.stop(); }
});

test('#1132 the rail reaches MCP: card_update with an array and no ifVersion is refused with the same words', async () => {
  const p = await startPair({ board: board() });
  try {
    const session = await mcpSession(p.mcp.mcpUrl);
    const r = await session.callTool('card_update', { id: '1', by: 'ada', checks: ARRAYS.checks });
    const text = r.result?.content?.[0]?.text ?? '';
    assert.ok(r.result?.isError || /ifVersion/.test(text), `expected a refusal naming ifVersion, got: ${text.slice(0, 200)}`);
    assert.match(text, /ifVersion/);
    const v = JSON.parse((await session.callTool('card_get', { id: '1' })).result.content[0].text).version;
    const ok = await session.callTool('card_update', { id: '1', by: 'ada', ifVersion: v, checks: ARRAYS.checks, return: 'id' });
    assert.ok(!ok.result?.isError, JSON.stringify(ok).slice(0, 200));
  } finally { await p.stop(); }
});
