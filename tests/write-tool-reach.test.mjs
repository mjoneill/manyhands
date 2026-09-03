/**
 * #1163 — THE CLASS behind #1106 / #534 / #548 / #775 / #790: a REST handler
 * that depends on a body field the MCP tool cannot send. Six instances in
 * three weeks, each found by a seat hitting it; this is the check that finds
 * the seventh before a seat does.
 *
 * The population is the LIVE tools/list of a real pair, joined to the routes
 * each tool's apiCall reaches and the `body.<f>` reads of the handler there.
 * n is printed before anything is asserted; n=0 or an unmapped write tool is
 * a failure of the instrument, never a pass (#1162).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';
import { analyzeWriteToolReach, formatReport, isFallbackCovered, bodyReads } from '../tools/write-tool-reach.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

// Every gap the live run finds is either FIXED (sha on its card) or FILED
// (uuid here) or DECLARED NOT A DEPENDENCY (reason here). An entry is a
// visible adjudication, never a baseline: the report still prints the gap.
const ADJUDICATED = [
  { tool: 'conversation_post', field: 'attachments', reason: 'FILED as card 9141ca7c-3236-4580-a38d-4b595358efed (#1164): a genuine gap — no MCP surface can attach a file — left as a design question, not baselined' },
  { tool: 'seat_declare', field: 'seat', reason: 'NOT A DEPENDENCY: the handler reads body.seat only to refuse a body that CONTRADICTS the path parameter; the tool sends the seat in the path' },
];

test('#1163 LIVE — every MCP write tool reaches every body field its REST handler depends on (n printed; unmapped = fail)', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [] }) });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const tools = (await session.listTools()).result.tools;
    const r = analyzeWriteToolReach({ mcpSource: src('mcp-server.mjs'), serverSource: src('server.js'), tools });
    console.log(formatReport(r));
    assert.ok(r.n >= 10, `population: expected at least 10 tool→route pairs, mapped ${r.n} — the instrument, not the code, is broken`);
    assert.ok(r.m >= 20, `fields checked: ${r.m}`);
    assert.deepEqual(r.unmapped, [], 'a write tool whose route could not be mapped is a FAIL, not an absence');
    // the member I am CERTAIN belongs: the tool that started this class
    assert.ok(r.rows.some((row) => row.tool === 'memory_update' && row.handler === 'handleUpdateMemory'), 'memory_update → handleUpdateMemory must be in the population');
    const unadjudicated = r.gaps.filter((g) => !ADJUDICATED.some((a) => a.tool === g.tool && a.field === g.field));
    assert.deepEqual(unadjudicated, [], `UNREACHABLE FIELDS (${r.dependsOn}):\n` + unadjudicated.map((g) => `  ${g.tool} → ${g.method} ${g.path} (${g.handler}) reads body.${g.field}, the tool cannot send it:\n    ${g.lines.join('\n    ')}`).join('\n'));
    // an adjudication for a gap that no longer exists is stale and must go
    for (const a of ADJUDICATED) {
      assert.ok(r.gaps.some((g) => g.tool === a.tool && g.field === a.field), `stale adjudication: ${a.tool}.${a.field} is no longer a gap — remove its entry`);
    }
  } finally { await pair.stop(); }
});

const FIX_MCP = `
export async function main() {
  const helper = async ({ id, ...patch }) => jsonResult(await apiCall('PATCH', \`/api/things/\${encodeURIComponent(id)}\`, patch));
  mcp.registerTool('thing_update', {
    inputSchema: { id: z.string(), body: z.string().optional() },
  }, helper);
  mcp.registerTool('ruling_create', {
    inputSchema: { statement: z.string(), decidedBy: z.string() },
  }, async (args) => jsonResult(await apiCall('POST', '/api/rulings', args)));
  mcp.registerTool('thing_get', {
    inputSchema: { id: z.string() },
  }, async ({ id }) => jsonResult(await apiCall('GET', \`/api/things/\${id}\`)));
}
`;
const FIX_SERVER = `
async function handleUpdateThing(req, res, id) {
  const body = JSON.parse(await readBody(req));
  if (body.ifVersion !== undefined && body.ifVersion !== current) return sendJSON(res, 409, {});
  const author = body.by || 'owner';
  return sendJSON(res, 200, { body: body.body, author });
}

async function handleCreateRuling(req, res) {
  const body = JSON.parse(await readBody(req));
  const who = body.decidedBy || body.by;
  return sendJSON(res, 201, { statement: body.statement, who });
}

const routes = [
  { method: 'PATCH', re: /^\\/api\\/things\\/([^\\/]+)$/, fn: (req, res, m) => handleUpdateThing(req, res, m[1]) },
  { method: 'POST',  re: /^\\/api\\/rulings$/,            fn: (req, res) => handleCreateRuling(req, res) },
];
`;
const fixtureTools = (over = {}) => [
  { name: 'thing_update', inputSchema: { properties: over.thing_update ?? { id: {}, body: {} } } },
  { name: 'ruling_create', inputSchema: { properties: { statement: {}, decidedBy: {} } } },
  { name: 'thing_get', inputSchema: { properties: { id: {} } } },
];

test('#1163 RED on the known shape — a handler reading ifVersion and by that the tool cannot send is a GAP naming tool, endpoint and field (the #1106 / #534 shape, through a helper by reference)', () => {
  const r = analyzeWriteToolReach({ mcpSource: FIX_MCP, serverSource: FIX_SERVER, tools: fixtureTools() });
  assert.equal(r.n, 2, 'two write pairs; the GET is not in the population');
  const gaps = r.gaps.map((g) => `${g.tool}:${g.field}@${g.handler}`).sort();
  assert.deepEqual(gaps, ['thing_update:by@handleUpdateThing', 'thing_update:ifVersion@handleUpdateThing']);
  assert.match(formatReport(r), /thing_update\s+PATCH\s+\/api\/things\/\$\{encodeURIComponent\(id\)\}\s+handleUpdateThing\s+GAP/);
  // and GREEN once the tool declares them — the same shape #1106 shipped
  const fixed = analyzeWriteToolReach({ mcpSource: FIX_MCP, serverSource: FIX_SERVER, tools: fixtureTools({ thing_update: { id: {}, body: {}, ifVersion: {}, by: {} } }) });
  assert.deepEqual(fixed.gaps, []);
});

test('#1163 FALSE-POSITIVE CONTROL — a field read only as a fallback for a field the tool DOES send is not a gap, and the rule is stated', () => {
  const r = analyzeWriteToolReach({ mcpSource: FIX_MCP, serverSource: FIX_SERVER, tools: fixtureTools() });
  const ruling = r.rows.find((row) => row.tool === 'ruling_create');
  assert.equal(ruling.fields.find((f) => f.field === 'by').status, 'fallback-covered');
  assert.equal(ruling.fields.find((f) => f.field === 'decidedBy').status, 'declared');
  assert.match(r.dependsOn, /\|\| chain beside a field the tool declares/);
  // the rule's edge: the SAME field read elsewhere WITHOUT a declared partner is a dependency again
  const reads = bodyReads('  const a = body.decidedBy || body.by;\n  const b = body.by;\n');
  assert.equal(isFallbackCovered('by', reads.get('by'), new Set(['decidedBy'])), false);
});

test('#1163 at ZERO population the analyzer reports zero gaps — the green that must not count, which is why the LIVE test asserts n before anything else and the CLI exits 2', () => {
  const r = analyzeWriteToolReach({ mcpSource: FIX_MCP, serverSource: FIX_SERVER, tools: [] });
  assert.equal(r.n, 0);
  assert.equal(r.gaps.length, 0, 'zero gaps at zero population is exactly the green that must not count');
});
