/**
 * #534 slice 3 — the precondition must be REACHABLE by the seats it protects.
 *
 * ⛔ THE DEFECT THIS EXISTS TO PREVENT, caught by checking a claim I had already
 * written into a commit message: slice 2 shipped `ifVersion` on the REST PATCH
 * and I wrote "the seats can opt in today via card_update". They could not.
 * `card_update`'s MCP inputSchema is an explicit zod allowlist, and zod STRIPS
 * what it omits — so the parameter never reached the handler that forwards it.
 *
 * ⇒ A capability its intended beneficiaries cannot reach is not delivered. The
 * seats ARE the colliding writers on this board; a CAS only they cannot call
 * protects nobody.
 *
 * Same class as #818's `implementedBy` ("the MCP schema carries it — zod strips
 * what it omits"), which is the test this one is modelled on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

test('#534 ifVersion reaches the handler through MCP — a stale one is REFUSED, not silently applied', async () => {
  const rest = await startRestServer({ board: makeBoardFixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const created = await (await fetch(`${rest.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'mcp cas probe', description: 'ORIGINAL', createdBy: 'ada' }),
    })).json();
    const id = created.id;
    const versionSeatHolds = created.version;

    // Another writer moves the card on.
    await fetch(`${rest.baseUrl}/api/cards/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptionAppend: ' +OTHER SEAT' }),
    });

    // A seat writes through its ACTUAL tool, declaring the version it read.
    const session = await mcpSession(mcp.mcpUrl);
    const call = await session.callTool('card_update', {
      id, description: 'CLOBBER FROM STALE SEAT', ifVersion: versionSeatHolds, by: 'ada',
    });

    // ⛔⛔ ANTI-VACUITY ON THIS TEST ITSELF, and it is not hypothetical: the
    // first cut of this file PASSED before the fix, for entirely the wrong
    // reason. zod rejects an unrecognized key by failing the WHOLE CALL
    // ("unrecognized_keys"), so no PATCH ever reached the server — the stale
    // write was "refused" because the tool call died, not because the
    // precondition worked. A test that passes when the feature is absent is
    // not a test. Its sibling below (a CORRECT ifVersion must still succeed)
    // is what exposed it.
    const callText = JSON.stringify(call);
    assert.ok(!/unrecognized_keys|Invalid arguments/.test(callText),
      `the tool call itself must be VALID — if the schema rejects ifVersion, this `
      + `test proves nothing about the precondition. Got: ${callText.slice(0, 300)}`);

    // ⭐ ANTI-VACUITY, and it is the whole test: if zod stripped ifVersion, this
    // PATCH is an ordinary full-body replace and the other seat's text is GONE
    // with a 200 — the exact #534 founding incident, now arriving through the
    // fix that was supposed to prevent it.
    const after = await (await fetch(`${rest.baseUrl}/api/cards/${id}`)).json();
    assert.equal(after.description, 'ORIGINAL +OTHER SEAT',
      'a stale ifVersion sent through MCP must be REFUSED — if the description is '
      + '"CLOBBER FROM STALE SEAT" then zod discarded the precondition and the '
      + 'concurrent write was silently destroyed');
    assert.equal(after.version, created.version + 1, 'and the refused write must not advance the version');
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#534 a CORRECT ifVersion through MCP still succeeds — the guard must not over-refuse', async () => {
  const rest = await startRestServer({ board: makeBoardFixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const created = await (await fetch(`${rest.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'mcp cas probe 2', description: 'ORIGINAL', createdBy: 'ada' }),
    })).json();

    const session = await mcpSession(mcp.mcpUrl);
    await session.callTool('card_update', {
      id: created.id, descriptionAppend: ' +MINE', ifVersion: created.version, by: 'ada',
    });

    const after = await (await fetch(`${rest.baseUrl}/api/cards/${created.id}`)).json();
    assert.equal(after.description, 'ORIGINAL +MINE', 'a current writer must not be blocked');
  } finally { await mcp.stop(); await rest.stop(); }
});
