/**
 * #254 — `parent` over MCP, and the guard that has to come with it.
 *
 * ⛔ THE CARD SAYS THIS IS ONE FIELD. It isn't, and the reason is a split that
 * predates it: TWO routes write `parent`, and only one of them is guarded.
 *
 *     PATCH /api/nodes/:id   { parent }   ✅ reparentWouldCycle() — refuses cycles
 *     PATCH /api/cards/:id   { parent }   ⛔ `parent` is in PATCHABLE_CARD_FIELDS
 *                                            and NOTHING checks it
 *
 * `reparentWouldCycle` has exactly one call site in the whole server. So the
 * card route can already strand a subtree in a cycle today — a node with no path
 * to any root, invisible to every tree walk, reachable only by id.
 *
 * ⇒ ⭐ That is a PRE-EXISTING defect, not one this card introduces. But #254's
 * "minimal fix" is to expose `parent` on the MCP card tools — which would route
 * every agent onto the unguarded path and make an occasional REST mistake into
 * the default way the room reparents things. Shipping the field without the
 * guard is #904's shape again: a write surface handed to the population least
 * able to notice it is broken.
 *
 * ⚠️ AND IT IS #890's LESSON, EXACTLY: sharing a CONSTANT is not sharing a RULE.
 * Both routes already share the same `parent` field and the same store; what
 * they do not share is the PREDICATE that decides whether a write is legal.
 * Unifying the data was never the fix — unifying the check is.
 *
 * ── WHY THE CYCLE TEST IS FIRST ────────────────────────────────────────────
 *
 * A cycle is the failure that cannot be seen from the outside afterwards: the
 * write returns 200, the card reads back exactly as sent, and the damage is a
 * property of the GRAPH rather than of any single record. Nothing downstream
 * reports it. It is the #831 shape — accepted, stored, and wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

const create = async (baseUrl, title, extra = {}) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', ...extra }),
  });
  return r.json();
};

const patchCard = async (baseUrl, id, body) => {
  const r = await fetch(`${baseUrl}/api/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

/** Walk parents from `id`; returns false if we revisit a node (a cycle). */
const reachesRoot = async (baseUrl, id) => {
  const seen = new Set();
  let cur = id;
  while (cur) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = (await get(baseUrl, cur)).parent ?? null;
  }
  return true;
};

test('#254 ⛔ THE UNGUARDED ROUTE: card PATCH must refuse a parent cycle', async () => {
  const s = await startRestServer();
  try {
    const a = await create(s.baseUrl, 'A');
    const b = await create(s.baseUrl, 'B');

    // Legal: B under A. This must succeed, or the test below proves nothing.
    const nest = await patchCard(s.baseUrl, b.id, { parent: a.id });
    assert.equal(nest.status, 200, 'anchor: a legal reparent must still work');
    assert.equal((await get(s.baseUrl, b.id)).parent, a.id);

    // ⛔ Illegal: A under B, closing the loop A → B → A.
    const cycle = await patchCard(s.baseUrl, a.id, { parent: b.id });
    assert.equal(cycle.status, 409,
      'the card route must refuse a cycle exactly as the node route does, WITH ITS CODE — '
      + 'reparentWouldCycle had ONE call site and this was not it');

    assert.equal(await reachesRoot(s.baseUrl, a.id), true,
      'and after a refused write, every node must still reach a root');
  } finally { await s.stop(); }
});

test('#254 card PATCH must refuse SELF-parenting', async () => {
  const s = await startRestServer();
  try {
    const a = await create(s.baseUrl, 'A');
    const res = await patchCard(s.baseUrl, a.id, { parent: a.id });
    assert.equal(res.status, 409, 'a node cannot contain itself');
    assert.equal((await get(s.baseUrl, a.id)).parent ?? null, null, 'and nothing was written');
  } finally { await s.stop(); }
});

test('#254 ⭐ the guard is the SAME PREDICATE, proven by agreement on a 3-deep chain', async () => {
  // #890: sharing a constant is not sharing a rule. This drives the same illegal
  // reparent through BOTH routes and asserts they agree — if one is later made
  // stricter, this fails rather than the two silently diverging again.
  const s = await startRestServer();
  try {
    const a = await create(s.baseUrl, 'A');
    const b = await create(s.baseUrl, 'B');
    const c = await create(s.baseUrl, 'C');
    await patchCard(s.baseUrl, b.id, { parent: a.id });
    await patchCard(s.baseUrl, c.id, { parent: b.id });   // A → B → C

    // A under C would close a three-node loop. Both routes must say no.
    const viaCard = await patchCard(s.baseUrl, a.id, { parent: c.id });
    const viaNode = await fetch(`${s.baseUrl}/api/nodes/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: c.id }),
    });
    assert.equal(viaCard.status, viaNode.status,
      `the two routes disagree about the same illegal write: card=${viaCard.status} node=${viaNode.status}`);
    assert.equal(viaCard.status, 409,
      'and the answer they agree on must be "no" — with the SAME code, because a caller '
      + 'must not have to know which route the refusal came in on. My first version '
      + 'answered 400 here and this assertion is why that was caught.');
  } finally { await s.stop(); }
});

test('#254 clearing a parent (null) is still allowed — the guard must not refuse the legal case', async () => {
  // ⚠️ The over-refusal check. A rail whose failure mode is "the board stops
  // accepting truth" is worse than the defect it prevents; `parent: null` means
  // "make this a root" and is the normal way to un-nest.
  const s = await startRestServer();
  try {
    const a = await create(s.baseUrl, 'A');
    const b = await create(s.baseUrl, 'B');
    await patchCard(s.baseUrl, b.id, { parent: a.id });
    const res = await patchCard(s.baseUrl, b.id, { parent: null });
    assert.equal(res.status, 200, 'un-nesting must remain possible');
    assert.equal((await get(s.baseUrl, b.id)).parent ?? null, null);
  } finally { await s.stop(); }
});

// ── the actual ask of #254: the seats that cannot use REST ─────────────────

test('#254 ⭐ THE POINT: an MCP seat can NEST a card', async () => {
  // Filed 2026-06-18. Two different seats hit this independently; one had to curl
  // REST to build a page hierarchy because the tool surface could not express it.
  // It has blocked every containment write an agent might make for two months,
  // and it blocks #905's A2 today.
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const parent = await create(rest.baseUrl, 'the epic');
    const child = await create(rest.baseUrl, 'the subtask');
    const session = await mcpSession(mcp.mcpUrl);

    const res = await session.callTool('card_update', {
      id: String(child.shortId), parent: parent.id, by: 'ada',
    });
    assert.ok(res.result?.content?.[0]?.text, `unexpected tool result: ${JSON.stringify(res).slice(0, 200)}`);
    assert.equal((await get(rest.baseUrl, child.id)).parent, parent.id,
      'zod strips unknown keys silently (#823) — an unlisted field is accepted and discarded');
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#254 an MCP seat can set parent at CREATE', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const parent = await create(rest.baseUrl, 'the epic');
    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('card_create', {
      title: 'nested at birth', createdBy: 'ada', parent: parent.id,
    });
    assert.ok(res.result?.content?.[0]?.text, `unexpected tool result: ${JSON.stringify(res).slice(0, 200)}`);
    const made = JSON.parse(res.result.content[0].text);
    assert.equal((await get(rest.baseUrl, made.id)).parent, parent.id);
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#254 ⛔ and the MCP path inherits the guard — a cycle is refused there too', async () => {
  // ⚠️ THE PAIRED CONTROL for the whole card. Exposing the field without the
  // guard reaching this path would hand the unguarded route to exactly the
  // population least able to notice — #904's shape, one card later.
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const a = await create(rest.baseUrl, 'A');
    const b = await create(rest.baseUrl, 'B');
    await patchCard(rest.baseUrl, b.id, { parent: a.id });

    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('card_update', { id: String(a.shortId), parent: b.id, by: 'ada' });

    // ⚠️ My first version of this assertion grepped for /cycle|circular|refus|400/
    // and failed against CORRECT behaviour: the server answers 409 and says
    // "descendant of itself", so the fixture was testing my guess at the wording
    // rather than the property. Assert the two things that actually matter —
    // the call is marked an error, and the status is the incumbent's 409.
    assert.equal(res.result?.isError, true, 'the MCP path must mark the refusal as an error, not return it as success');
    const text = res.result?.content?.[0]?.text ?? '';
    assert.match(text, /\b409\b/, `the refusal must carry the status the REST route gave it. got: ${text.slice(0, 200)}`);
    assert.equal((await get(rest.baseUrl, a.id)).parent ?? null, null, 'and nothing was written');
  } finally { await mcp.stop(); await rest.stop(); }
});
