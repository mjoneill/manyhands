/**
 * #1284 — THE ASK-ANCHORED DECLARATION, ASSERTED THROUGH THE SURFACE A SEAT CALLS.
 *
 * ⛔ A UNIT TEST CANNOT SEE THIS DEFECT. `core/work-auction.mjs` has accepted a
 * cardless declaration since #755 slice 2e — the comment beside the field says
 * a bid may name a source message instead when no card exists yet — and the
 * store round-trips it. Every layer beneath the tools already worked.
 *
 * What did not work was the only surface the seats can reach: the MCP
 * inputSchema is an explicit zod allowlist, `card` was required in it, and
 * `sourceMessageId` was ABSENT from it entirely. Zod strips what the schema
 * omits, so the field could not be sent no matter what the core accepted. That
 * is #534's defect exactly, and #534 is why this file boots the real server and
 * speaks JSON-RPC instead of grepping the source: a test that passes while no
 * seat can make the call is not testing the thing that was missing.
 *
 * ⚠️ These do NOT claim the rail is now enforced. `decideCoveredAction` allows
 * a seat holding no open window, by construction, so it remains a volunteer
 * button — this widens what a volunteer can point AT. #1284 acceptance 2 (a
 * room where nobody is racing pays nothing) holds because nothing new is
 * required of anyone, and the negative control below asserts that rather than
 * asserting it in prose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

const storeDir = () => mkdtempSync(join(tmpdir(), 'cardless-wiring-1284-'));
const armed = (store) => ({ SCRUM_WORK_GATE: 'on', SCRUM_WORK_STORE: store });
const payload = (res) => JSON.parse(res.result.content[0].text);

/** The id of a commons message — the only handle an ask has before it has a card. */
const ASK = '87f4c10c-7ab2-46d0-b101-e06cd8b0ba5f';

async function withServers(env, fn) {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env });
  try {
    await fn({ rest, mcp, session: await mcpSession(mcp.mcpUrl) });
  } finally {
    await mcp.stop();
    await rest.stop();
  }
}

test('#1284 ⭐⭐ A SEAT CAN DECLARE AGAINST AN ASK — the field that had no inlet', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    const declared = payload(await session.callTool('work_declare', {
      id: 'w-ask', by: 'ada', sourceMessageId: ASK,
      required: ['ada', 'bo'], replyByMinutes: 20,
    }));
    assert.equal(declared.id, 'w-ask');
    assert.deepEqual(declared.pending, ['bo']);

    // ⭐ And the SECOND seat sees what it is about. This is acceptance 1: the
    // ask is answerable before the action, and the answer is legible to whoever
    // reads next. The listing used to project id and replyBy only — for an
    // ask-anchored window that drops the sole handle it has.
    const [open] = payload(await session.callTool('work_list', {})).open;
    assert.equal(open.sourceMessageId, ASK, 'a reader can tell WHICH ask is held');
    assert.equal(open.card, null, 'and that it is not about a card');
  });
});

test('#1284 the schema ADVERTISES sourceMessageId and no longer requires card', async () => {
  // The complement of the call above: a caller reading the tool list must be
  // able to discover the field. A capability nobody is told about is reached by
  // accident or not at all.
  await withServers(armed(storeDir()), async ({ session }) => {
    const tool = (await session.listTools()).result.tools.find((t) => t.name === 'work_declare');
    const props = tool.inputSchema.properties;
    assert.ok(props.sourceMessageId, 'sourceMessageId is not advertised — it cannot be sent');
    const required = tool.inputSchema.required ?? [];
    assert.ok(!required.includes('card'), 'card must not be a required parameter');
    assert.ok(required.includes('replyByMinutes'), 'a window still cannot be opened without a deadline');
  });
});

test('#1284 ⛔ a declaration anchored on NEITHER is refused at the surface too', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    const res = await session.callTool('work_declare', {
      id: 'w-void', by: 'ada', required: ['ada'], replyByMinutes: 20,
    });
    const text = JSON.stringify(res);
    assert.match(text, /card or sourceMessageId/,
      'making card optional must not make the object anchorless');
    // And nothing was recorded by the refusal.
    const listed = payload(await session.callTool('work_list', {}));
    assert.equal(listed.open.length, 0);
    assert.equal(listed.settled.length, 0);
  });
});

test('#1284 NEGATIVE CONTROL — a card-anchored declaration is unchanged', async () => {
  // Acceptance 2's shape: a room where nobody is racing pays nothing, and the
  // seats already using the rail the old way must notice no difference. Without
  // this, a change that broke the card path while adding the ask path passes.
  await withServers(armed(storeDir()), async ({ session }) => {
    const declared = payload(await session.callTool('work_declare', {
      id: 'w-card', by: 'ada', card: 1284, required: ['ada', 'bo'], replyByMinutes: 20,
    }));
    assert.deepEqual(declared.pending, ['bo']);
    const [open] = payload(await session.callTool('work_list', {})).open;
    assert.equal(open.card, 1284);
    assert.equal(open.sourceMessageId, null);
  });
});
