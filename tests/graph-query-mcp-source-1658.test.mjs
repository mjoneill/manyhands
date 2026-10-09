/**
 * #1658 — the MCP `graph_query` tool must be able to ASK for a store: a seat that cannot send `source` cannot choose the store, and the harness-side contract (every answer names its store,
 * a request may ask for one) would be a REST-only feature. Rows written against the tool's observable behaviour, with a fake REST that records what the tool sends to POST /api/graph.
 *
 *   M0 CONTROL  no `source` given: the tool still answers, forwards query, limit and by, and sends NO `source` (the server default applies); the fake's answer is passed through unaltered
 *   M1          `source: 'executor'` reaches POST /api/graph as `source: 'executor'`
 *   M2          `source: 'replica'` reaches POST /api/graph as `source: 'replica'`
 *   M3          `source: 'both'` (neither) is refused at the tool: an error result, and NOTHING reaches /api/graph
 *   M4          the tool's registered input schema names `source` with exactly the two values (a seat can SEE the choice)
 *
 * NOT covered, by name: board-tools (the resident seats' own graph_query), what the server does with the value (tests/graph-query-source-1658.test.mjs), that a seat is allowed to choose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMcpServer, mcpSession } from './helpers/harness.mjs';

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => res(b)); });
async function withTool(fn) {
  const sent = [];
  const rest = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.startsWith('/api/graph')) { sent.push(JSON.parse(await readBody(req))); return res.end(JSON.stringify({ rows: [{ s: 'x' }], returned: 1, truncated: false, limit: 100, source: 'replica' })); }
    res.end('{}');
  });
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  const mcp = await startMcpServer({ restApiBase: `http://127.0.0.1:${rest.address().port}` });
  try { const session = await mcpSession(mcp.mcpUrl); await fn({ session, sent }); } finally { await mcp.stop(); rest.close(); }
}
const Q = 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1';

test('M0 CONTROL: without `source` the tool forwards query, limit and by, sends no source, and passes the answer through', { timeout: 60000 }, async () => {
  await withTool(async ({ session, sent }) => {
    const r = await session.callTool('graph_query', { query: Q, limit: 5, by: 'tester' });
    assert.ok(!r.error && !r.result?.isError, JSON.stringify(r).slice(0, 300)); assert.equal(sent.length, 1);
    assert.equal(sent[0].query, Q); assert.equal(sent[0].limit, 5); assert.equal(sent[0].by, 'tester'); assert.ok(!('source' in sent[0]), `no source is sent when none is given (sent: ${JSON.stringify(sent[0])})`);
    assert.deepEqual(JSON.parse(r.result.content[0].text).rows, [{ s: 'x' }]);
  });
});
for (const which of ['executor', 'replica']) {
  test(`M${which === 'executor' ? 1 : 2} \`source: '${which}'\` reaches POST /api/graph unchanged`, { timeout: 60000 }, async () => {
    await withTool(async ({ session, sent }) => {
      const r = await session.callTool('graph_query', { query: Q, source: which }); assert.ok(!r.error && !r.result?.isError, JSON.stringify(r).slice(0, 300));
      assert.equal(sent.length, 1); assert.equal(sent[0].source, which); assert.equal(sent[0].query, Q);
    });
  });
}
test('M3 `source: "both"` is refused at the tool and nothing reaches /api/graph', { timeout: 60000 }, async () => {
  await withTool(async ({ session, sent }) => {
    const r = await session.callTool('graph_query', { query: Q, source: 'both' });
    assert.ok(r.error || r.result?.isError, `an error result for an invalid source (got ${JSON.stringify(r).slice(0, 200)})`); assert.equal(sent.length, 0, 'and the REST never saw the call');
  });
});
test('M4 the tool\'s registered input schema names `source` with exactly the two values', { timeout: 60000 }, async () => {
  await withTool(async ({ session }) => {
    const tools = await session.listTools(); const list = tools.result?.tools ?? tools.tools ?? tools; const t = list.find((x) => x.name === 'graph_query');
    assert.ok(t, 'graph_query is registered'); const p = t.inputSchema?.properties?.source;
    assert.ok(p, `the input schema has a source property (properties: ${Object.keys(t.inputSchema?.properties ?? {})})`); assert.deepEqual([...(p.enum ?? [])].sort(), ['executor', 'replica']);
  });
});
