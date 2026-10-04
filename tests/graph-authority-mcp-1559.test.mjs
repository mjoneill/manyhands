/**
 * #1559 remainder (2) — MCP seats (the humans' and the Claude seats') ask the SAME shared
 * authority resolver resident seats reach through board-tools' graph_authority (#1558).
 * Before this, an MCP seat had only raw graph_query, which cannot tell "nothing governs it"
 * from "the store could not be read". The tool passes the route's envelope through UNALTERED,
 * and a failed read is UNAVAILABLE with the note, never a thrown error, never an empty answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture, freePort, PROJECT_DIR } from './helpers/harness.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const body = (r) => JSON.parse(r.result?.content?.[0]?.text ?? 'null');
const COORDS = { topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX', evaluationTime: '2026-10-04T17:00:00.000Z' };

test('#1559 graph_authority over MCP: on a board with NO graph slice the answer is UNAVAILABLE with its note — never an error, never empty', { timeout: 30000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    assert.ok(JSON.stringify(await session.listTools()).includes('"graph_authority"'), 'the tool is registered where an MCP seat looks');
    const r = await session.callTool('graph_authority', COORDS);
    assert.ok(!r.error && !r.result?.isError, `not a thrown error: ${JSON.stringify(r).slice(0, 300)}`);
    const b = body(r);
    assert.equal(b.status, 'UNAVAILABLE');
    assert.match(b.note, /NOT "nothing governs it"/);
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#1559 graph_authority over MCP returns EXACTLY the shared resolver route\'s envelope (real executor, explicit evaluation time)', { skip: SKIP, timeout: 60000 }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "gam" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [] }), env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: 'gam',
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY,
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${rest.baseUrl}/api/trial/counters`)).json().catch(() => ({}));
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const direct = await (await fetch(`${rest.baseUrl}/api/graph/authority?${new URLSearchParams(COORDS)}`)).json();
    assert.ok(['NO_AUTHORITY', 'CURRENT', 'UNRESOLVED', 'UNAVAILABLE'].includes(direct.status), JSON.stringify(direct).slice(0, 300));
    assert.ok(direct.meaning, 'the envelope carries its meaning');
    const viaMcp = body(await (await mcpSession(mcp.mcpUrl)).callTool('graph_authority', COORDS));
    assert.deepEqual(viaMcp, direct, 'passed through unaltered');
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#1559 graph_authority over MCP refuses a call missing topic, predicate or scope', { timeout: 30000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    for (const k of ['topic', 'predicate', 'scope']) {
      const { [k]: _, ...partial } = COORDS;
      const r = await session.callTool('graph_authority', partial);
      assert.ok(r.error || r.result?.isError, `${k} missing is refused: ${JSON.stringify(r).slice(0, 200)}`);
    }
  } finally { await mcp.stop(); await rest.stop(); }
});
