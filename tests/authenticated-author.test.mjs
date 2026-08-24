/**
 * #125 — a BOUND session must not be able to post as another seat.
 *
 * The board already knows, authenticated by session id, which seat is calling:
 * the #410 registry and the #703 bearer binding both resolve it, and
 * `conversation_post` holds `extra.sessionId` already — it uses it to suppress
 * fan-out echo and then throws it away for authorship.
 *
 * ⛔ THE SHAPE OF THE FIX IS CONSTRAINED BY A COMMENT ALREADY IN THE SOURCE
 * (mcp-server.mjs, the #258 block): "DELIBERATELY NOT `sessionMeta.seat`. That
 * field is bearer-authenticated; `author` is self-declared (#125). They are two
 * different facts and folding them into one test would make a suppression
 * decision that is sometimes authenticated and sometimes not, with nothing on
 * the surface saying which."
 *
 * ⇒ So we do NOT silently substitute one fact for the other. The authenticated
 * seat becomes the author; the declared value is preserved, separately named,
 * as `onBehalfOf`. Both facts survive and a reader can always tell which is
 * which — the #883 declared-vs-authenticated distinction, kept whole.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const tmpTokens = (obj) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seat125-')), 'seat-tokens.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};

const TOKENS = { tokens: { 'tok-ada': { seat: 'ada' }, 'tok-bex': { seat: 'bex' } } };

async function pair() {
  const tokensFile = tmpTokens(TOKENS);
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_SEAT_TOKENS: tokensFile } });
  return { rest, mcp, stop: async () => { await mcp.stop?.(); await rest.stop?.(); } };
}

/** Read every conversation back through the tool surface a seat actually uses. */
async function postsOf(session) {
  const r = await session.callTool('conversation_list', {});
  const text = r?.result?.content?.[0]?.text ?? '[]';
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.conversations ?? parsed.items ?? []);
}

// ── CRITERION 2 — THE CONTROL. This is the whole card. ────────────────────
test('#125 a BOUND seat cannot post as another seat — re-attributed to the authenticated seat, declaration preserved', async () => {
  const { mcp, stop } = await pair();
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });

    // ada is authenticated as ada. She declares bex.
    const res = await ada.callTool('conversation_post', { author: 'bex', body: 'a stance taken in another seat’s name' });

    const posts = await postsOf(ada);
    const impersonated = posts.filter((p) => p.author === 'bex');

    assert.equal(impersonated.length, 0,
      '⛔ a session bound as `ada` produced a post authored by `bex`. This is the #125 defect: '
      + 'the board knew who was calling and published the self-declared name instead. '
      + `(tool returned: ${JSON.stringify(res?.result ?? res).slice(0, 300)})`);

    // ⛔ NOT ENOUGH ON ITS OWN. Refusing to post also satisfies the line above,
    // so assert the post LANDED and that BOTH facts survived, separately named.
    const landed = posts.filter((p) => /another seat’s name/.test(p.body ?? ''));
    assert.equal(landed.length, 1, 'the post must still land — this is re-attribution, not censorship');
    assert.equal(landed[0].author, 'ada', 'author is the AUTHENTICATED seat');
    assert.equal(landed[0].onBehalfOf, 'bex', 'the DECLARED name survives, separately named — never folded away');
  } finally {
    await stop();
  }
});

// ── CRITERION 3 — POSITIVE CONTROL. Criterion 2 is satisfied perfectly by
//    breaking posting entirely, so this half is not optional. #858 closed on
//    one half and it cost the room a re-open.
test('#125 positive control — a correctly-bound seat posting under its OWN name still succeeds', async () => {
  const { mcp, stop } = await pair();
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    await ada.callTool('conversation_post', { author: 'ada', body: 'ordinary presence' });

    const mine = (await postsOf(ada)).filter((p) => p.author === 'ada');
    assert.equal(mine.length, 1, 'a seat posting as itself must still land, authored by itself');
    assert.match(mine[0].body, /ordinary presence/);
  } finally {
    await stop();
  }
});

// ── CRITERION 3b — the fan-out half of the positive control.
test('#125 positive control — the post still reaches the OTHER seats (fan-out is not collateral damage)', async () => {
  const { mcp, stop } = await pair();
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const bex = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-bex' } });

    await ada.callTool('conversation_post', { author: 'ada', body: 'hello room' });

    const seenByBex = (await postsOf(bex)).filter((p) => /hello room/.test(p.body ?? ''));
    assert.equal(seenByBex.length, 1, 'a second seat must still be able to read the post');
  } finally {
    await stop();
  }
});

// ── CRITERION 4 — unbound sessions are DECIDED, not defaulted.
//
// ⚠️ THE OBVIOUS READING OF THIS CRITERION IS WRONG AND WAS MEASURED TO BE WRONG.
// I first wrote this test as "an unbound session must not publish under a seat
// name." Then I read /channel/status: seats{} = wren, indigo, healthcheck, and
// @minimo — a legitimate seat on a different toolchain — is one of THREE unbound
// sessions with live streams. That test, implemented, renames or refuses every
// post she makes, and the first evidence would have been her going quiet, which
// is the one signal this room has repeatedly proven it cannot read.
//
// ⭐ @minimo's own ruling, which is the precision the design needed:
//   "binding does not mean nobody can type `minimo`; it means nobody else can do
//    so INDISTINGUISHABLY. An unbound claim must remain possible but visibly
//    unproven."
//
// ⇒ Fail-open (#703) is preserved. The post lands under the declared name and
//   says, structurally, that nothing proved it.
test('#125 an UNBOUND session still posts — under its declared name, VISIBLY unproven', async () => {
  const { mcp, stop } = await pair();
  try {
    const anon = await mcpSession(mcp.mcpUrl); // no Authorization header
    await anon.callTool('conversation_post', { author: 'ada', body: 'posted by nobody in particular' });

    const landed = (await postsOf(anon)).filter((p) => /nobody in particular/.test(p.body ?? ''));

    assert.equal(landed.length, 1, 'fail-open: an unbound seat must still be able to speak (#703)');
    assert.equal(landed[0].author, 'ada', 'the declared name is NOT silently rewritten');
  } finally {
    await stop();
  }
});

// ── A bound seat posting as itself records no relay it did not claim.
test('#125 a BOUND seat posting as itself records NO onBehalfOf', async () => {
  const { mcp, stop } = await pair();
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    await ada.callTool('conversation_post', { author: 'ada', body: 'proven presence' });

    const landed = (await postsOf(ada)).filter((p) => /proven presence/.test(p.body ?? ''));
    assert.equal(landed.length, 1);
    assert.equal(landed[0].author, 'ada');
    assert.equal(landed[0].onBehalfOf ?? null, null, 'no relay claimed, so no relay recorded');
  } finally {
    await stop();
  }
});

// ── CRITERION 4's SECOND HALF IS NOT SHIPPED, AND SAYS SO OUT LOUD. ────────
//
// ⛔ The card asks that an unbound post be VISIBLY unauthenticated. That needs a
// flag, and a flag is only worth its bytes if it cannot be forged. `apiCall` in
// mcp-server.mjs sends NO auth header, so /api/conversations cannot tell the MCP
// server from any other client that reaches the port — a payload-supplied
// `authorAuthenticated: true` would be mintable by anyone.
//
// ⚠️ A forgeable badge is WORSE than no badge: it converts an open question
// ("was this proven?") into a false answer. That is the #593/#845 lying-label
// class, which this room has paid for repeatedly.
//
// ⇒ Left as a FAILING TODO rather than deleted, so the criterion cannot be
// mistaken for satisfied by anyone reading a green suite. It goes green when a
// verifiable trust link between the two processes exists.
test('#125 criterion 4b — an unbound post is VISIBLY unproven', { todo: 'blocked: REST cannot verify the caller is the MCP server (no shared secret on apiCall). A payload-supplied proof flag would be forgeable.' }, async () => {
  const { mcp, stop } = await pair();
  try {
    const anon = await mcpSession(mcp.mcpUrl);
    await anon.callTool('conversation_post', { author: 'ada', body: 'unproven claim' });
    const landed = (await postsOf(anon)).filter((p) => /unproven claim/.test(p.body ?? ''));
    assert.equal(landed[0].authorAuthenticated, false);
  } finally {
    await stop();
  }
});
