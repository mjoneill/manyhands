/**
 * #483 — the roster must be single-sourced, proven by behaviour.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The roster was claimed to be config-driven three times, and each claim was
 * true of fewer places than the sentence covered:
 *
 *   1. `core/identity.mjs` was made configurable — and reported as "the roster
 *      is config-driven", with two other sources still hardcoded.
 *   2. `index.html` and `mcp-server.mjs` were then fixed — and `mcp-server.mjs`
 *      still spelled the example seats out by hand in FOUR `.describe()` strings
 *      a few hundred lines below the derivation that worked. The aggregate
 *      looked right because one derivation genuinely worked.
 *
 * Three times, "a healthy total hiding a dead source". The general question that
 * would have caught all three, asked BEFORE claiming the property rather than
 * after: **how many places hold this fact?**
 *
 * So this test does not grep for literals. It configures a roster nobody could
 * mistake for the shipped example, boots the real MCP server, and reads back
 * what an AGENT is actually told. A literal-grep would pass the moment someone
 * built the seat list by concatenation; this fails unless the value genuinely
 * flows from the configured file to the surface.
 *
 * The example-roster names are the CONTROL, not the subject: if any of them
 * appears in a tool schema while a custom roster is configured, some surface is
 * still holding its own copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpServer, mcpSession } from './helpers/harness.mjs';

/** Seats no shipped example would ever contain. */
const UNMISTAKABLE = {
  zzquux: { name: 'Zzquux', glyph: '🜁', color: '#123456' },
  vlorbo: { name: 'Vlorbo', glyph: '🜂', color: '#654321' },
};

/** The shipped example seats — present in a default install, so they are the control. */
const EXAMPLE_SEATS = ['alex', 'robin', 'sage', 'nova', 'kit'];

/** Collect every string an agent can read: tool descriptions + schema descriptions. */
function agentVisibleText(tools) {
  const parts = [];
  for (const t of tools) {
    parts.push(t.name || '', t.description || '');
    const props = t.inputSchema?.properties || {};
    for (const [key, schema] of Object.entries(props)) {
      parts.push(key, schema?.description || '');
      // one level down, for array item schemas
      if (schema?.items?.description) parts.push(schema.items.description);
    }
  }
  return parts.join('\n');
}

test('#483 a configured roster reaches every seat list an agent reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-single-source-'));
  const rosterFile = join(dir, 'roster.json');
  writeFileSync(rosterFile, JSON.stringify({ seats: UNMISTAKABLE }));

  const mcp = await startMcpServer({ env: { SCRUM_ROSTER_FILE: rosterFile } });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const listed = await session.listTools();
    const tools = listed.result?.tools ?? listed.tools ?? [];
    assert.ok(tools.length > 0, 'tools/list returned nothing — the surface under test is empty');
    const everything = `${agentVisibleText(tools)}\n${session.instructions || ''}`;

    // The configured seats must actually be there — the load-bearing half. A
    // surface that mentions nobody would pass a "no example seats" check while
    // telling an agent nothing at all.
    for (const key of Object.keys(UNMISTAKABLE)) {
      assert.ok(
        everything.includes(key),
        `configured seat "${key}" appears nowhere an agent can read it — `
        + 'the roster is not reaching the tool schemas',
      );
    }

    // And no surface may still be holding its own copy of the example roster.
    for (const seat of EXAMPLE_SEATS) {
      const hit = new RegExp(`\\b${seat}\\b`, 'i').exec(everything);
      assert.equal(
        hit, null,
        `example seat "${seat}" survives in an agent-visible string while a custom `
        + `roster is configured — some surface holds its own copy. Context: `
        + `${JSON.stringify(everything.slice(Math.max(0, (hit?.index ?? 0) - 120), (hit?.index ?? 0) + 120))}`,
      );
    }

  } finally {
    await mcp.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#483 the seat list an agent is told about is not empty by default', async () => {
  // The mirror of the test above: with NO roster configured, a stranger's agent
  // must still be told about the shipped example seats. A derivation that reads
  // an absent file and yields nothing would satisfy "no example seats survive"
  // while leaving every schema uselessly blank — the failure mode that made the
  // browser suite render empty pickers for a whole evening.
  const mcp = await startMcpServer();
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const listed = await session.listTools();
    const tools = listed.result?.tools ?? listed.tools ?? [];
    const everything = `${agentVisibleText(tools)}\n${session.instructions || ''}`;
    const found = EXAMPLE_SEATS.filter((s) => new RegExp(`\\b${s}\\b`, 'i').test(everything));
    assert.ok(
      found.length >= 2,
      `with no roster.json configured, an agent should still be told about the shipped `
      + `example seats; found ${JSON.stringify(found)}`,
    );
  } finally {
    await mcp.stop();
  }
});
