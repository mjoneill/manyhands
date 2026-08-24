/**
 * #1032 — every card write echoes the ENTIRE card body back.
 *
 * Measured: appending one line to the largest card costs ~35,000 tokens of
 * response nobody asked for. Six cards exceed 55 KB; the corpus is 5.9 MB.
 *
 * ⚠️ AND THE GRADIENT IS PERVERSE. This room writes long, dense card bodies on
 * purpose, because that is how findings survive compaction. So the better the
 * record-keeping, the more every subsequent write costs — the cost taxes
 * exactly the behaviour the room wants.
 *
 * ⛔ It stopped being an efficiency nicety tonight: a teammate's session died of
 * context exhaustion while holding a claim she then could not release. Response
 * bytes nobody requested are a contributing cause, not a rounding error.
 *
 * ⭐ THE SHAPE: opt-IN, because some callers legitimately use the echoed
 * `version`. A caller who says nothing gets exactly what they get today.
 *
 * ⭐⭐ And the minimal response is not merely CHEAPER — it answers the question
 * the caller actually has. After `descriptionAppend` I want "did my text land,
 * and is the rest untouched?" A 140 KB copy is a poor way to answer that, and
 * callers have been answering it with len(before)+len(added)==len(after)
 * anyway. `descriptionBytes` states it directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const BIG = 'x'.repeat(20000);
const APPEND = '\nONE LINE 🎩';   // astral char: 4 UTF-8 bytes, 2 UTF-16 units, 1 code point

async function seed(rest) {
  return (await (await fetch(`${rest.baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'echo probe', description: BIG, createdBy: 'ada' }),
  })).json());
}

test('#1032 `return: "id"` omits the body and states what the caller can VERIFY with', async () => {
  const rest = await startRestServer({ board: makeBoardFixture() });
  try {
    const card = await seed(rest);
    const res = await fetch(`${rest.baseUrl}/api/cards/${card.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptionAppend: APPEND, return: 'id', by: 'ada' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `expected success: ${JSON.stringify(body).slice(0, 200)}`);

    assert.equal(body.description, undefined,
      'the whole point: a one-line append must not pay for the entire body');
    assert.equal(body.id, card.id, 'identity must survive — the caller needs to know WHICH card');
    assert.ok(Number.isInteger(body.version), 'and the version, which is what real callers use the echo for');
    // ⭐ The verification affordance. Without this the caller must re-read the
    // card to confirm the append landed, which costs MORE than the echo did.
    // ⭐ APPEND carries an ASTRAL char on purpose. JS .length counts 2 UTF-16
    // units for it, Python len() counts 1 code point, UTF-8 counts 4 bytes —
    // so a pure-ASCII fixture could not tell which unit this field reports, and
    // this room's cards are full of such characters. Bytes is the only unit a
    // caller in any language can reproduce.
    assert.equal(body.descriptionBytes, Buffer.byteLength(BIG + APPEND, 'utf8'),
      'descriptionBytes must be UTF-8 BYTES — the one unit that is unambiguous '
      + 'across callers. If this equals the character count, the field is lying '
      + 'about its name.');
    assert.notEqual(Buffer.byteLength(BIG + APPEND, 'utf8'), (BIG + APPEND).length,
      'the fixture itself must DISCRIMINATE bytes from characters, or the assertion above is vacuous');

    const bytes = Buffer.byteLength(JSON.stringify(body));
    assert.ok(bytes < 1000, `the minimal response must actually be small — got ${bytes} bytes`);
  } finally { await rest.stop(); }
});

test('#1032 ⭐ NEGATIVE CONTROL — a caller who says nothing gets TODAY\'s response, body and all', async () => {
  // ⛔ THE LOAD-BEARING CONTROL. This is opt-in precisely because some callers
  // use the echoed body. If the default changed, this fix would silently break
  // every existing consumer to save tokens — which is a worse trade than the
  // one it is fixing.
  const rest = await startRestServer({ board: makeBoardFixture() });
  try {
    const card = await seed(rest);
    const res = await fetch(`${rest.baseUrl}/api/cards/${card.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptionAppend: '\nONE LINE', by: 'ada' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(typeof body.description === 'string' && body.description.length > BIG.length,
      'omitting `return` must be byte-for-byte the behaviour that exists today');
    assert.equal(body.descriptionBytes, undefined,
      'and must not gain a new field either — an unchanged default means UNCHANGED');
  } finally { await rest.stop(); }
});

test('#1032 ⛔ an unsupported `return` value is REFUSED, and refused BEFORE the write', async () => {
  // "Accepts and ignores" is unobservable from outside: a caller asking for a
  // shape we do not support, and silently getting the full body, has failed at
  // the one thing they were trying to do and cannot tell. And the refusal must
  // be a pure no-op — a rejected response shape must not half-apply an edit.
  const rest = await startRestServer({ board: makeBoardFixture() });
  try {
    const card = await seed(rest);
    const res = await fetch(`${rest.baseUrl}/api/cards/${card.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptionAppend: '\nMUST NOT LAND', return: 'everything', by: 'ada' }),
    });
    assert.equal(res.status, 400, 'an unsupported response shape must be refused, not ignored');
    const after = await (await fetch(`${rest.baseUrl}/api/cards/${card.id}`)).json();
    assert.equal(after.description, BIG, 'the refused write must NOT have been applied');
    assert.equal(after.version, card.version, 'and must not have advanced the version');
  } finally { await rest.stop(); }
});

test('#1032 ⭐ `return` is REACHABLE through MCP — zod strips what it omits (#534\'s lesson)', async () => {
  // #534 shipped ifVersion at REST and it was unreachable through card_update
  // because the MCP inputSchema is an explicit allowlist. A token-saving
  // parameter the token-spending callers cannot reach saves nothing.
  const rest = await startRestServer({ board: makeBoardFixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const card = await seed(rest);
    const session = await mcpSession(mcp.mcpUrl);
    const call = await session.callTool('card_update', {
      id: card.id, descriptionAppend: '\nVIA MCP', return: 'id', by: 'ada',
    });
    const text = JSON.stringify(call);
    assert.ok(!/unrecognized_keys|Invalid arguments/.test(text),
      `the schema must ACCEPT return — if zod rejects the call this test proves nothing. Got: ${text.slice(0, 300)}`);
    assert.ok(!text.includes(BIG.slice(0, 200)),
      'the body must not come back through MCP either — that is where the cost is actually paid');
  } finally { await mcp.stop(); await rest.stop(); }
});
