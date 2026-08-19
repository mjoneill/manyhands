/**
 * #917 — `parent` must RESOLVE a card, not MINT an IRI from whatever string it
 * was handed.
 *
 * ⛔ MY REGRESSION, shipped in #254 and found by a colleague using the feature
 * for its purpose twenty minutes after it deployed:
 *
 *     card_update(905, parent: "857")   → 200. card_get echoes parent: "857".
 *     ?c isPartOf+ <the #857 node>      → 0 rows.
 *
 *     #905  schema:isPartOf → entity:857                ← minted from the string
 *     #857  its real node   → entity:e5c3ad70-df1f-…    ← 104 triples
 *     COUNT { <entity:857> ?p ?o }  →  0
 *
 * ⇒ The write path stores the string it is given and the projection faithfully
 * renders it, so a shortId becomes an edge to a node that does not exist.
 *
 * ⭐⭐ AND IT FAILS IN THE DIRECTION THAT LOOKS LIKE SUCCESS. The write returns
 * 200, the card shows a parent, and only the traversal disagrees. A seat
 * asserting membership on 120 cards would get 120 green writes and a traversal
 * still returning zero — and would reasonably conclude the TRAVERSAL was broken,
 * which is the one part that is fine.
 *
 * ── WHY MY #254 TESTS MISSED IT, which is the part worth keeping ────────────
 *
 * Every parent test I wrote passed `card.id` — the UUID — because that is what
 * the fixture had in hand. I never once passed a shortId. And a shortId is what
 * every card reference in this room looks like: it is the form a seat actually
 * reaches for, and the only form I did not try.
 *
 * ⇒ A fixture built from what the setup returns tests the path the setup takes.
 * The input a human types is a different input.
 *
 * ── THE ACCEPTANCE THAT DECIDES THIS CARD ──────────────────────────────────
 *
 * From #917, and it is why these tests query the GRAPH rather than the card:
 *
 *   "the test asserts the TRAVERSAL returns the child — not that the write
 *    returned 200, and not that card_get echoes the parent back. Both of those
 *    pass today, with a dangling edge."
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession } from './helpers/harness.mjs';

const mk = async (baseUrl, title, extra = {}) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', ...extra }),
  });
  return { status: r.status, card: await r.json() };
};

const patch = async (baseUrl, id, body) => {
  const r = await fetch(`${baseUrl}/api/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

/** THE ACCEPTANCE: ask the GRAPH whether the child is reachable from the apex. */
const traverse = async (session, apexShortId) => {
  const r = await session.callTool('graph_query', {
    by: 'ada',
    query: `SELECT ?id WHERE { ?apex schema:identifier "${apexShortId}" . `
         + '?c schema:isPartOf+ ?apex ; schema:identifier ?id }',
  });
  const text = r.result?.content?.[0]?.text;
  assert.ok(text, `graph_query returned nothing: ${JSON.stringify(r).slice(0, 200)}`);
  const out = JSON.parse(text);
  return (out.rows || []).map((row) => row.id).sort();
};

test('#917 ⛔ THE ACCEPTANCE: a shortId parent is REACHABLE BY TRAVERSAL', async () => {
  const p = await startPair();
  try {
    const apex = (await mk(p.rest.baseUrl, 'the apex')).card;
    const child = (await mk(p.rest.baseUrl, 'the child')).card;

    const res = await patch(p.rest.baseUrl, child.id, { parent: String(apex.shortId) });
    assert.equal(res.status, 200, 'setting a parent by shortId must be accepted');

    const session = await mcpSession(p.mcp.mcpUrl);
    assert.deepEqual(await traverse(session, apex.shortId), [String(child.shortId)],
      'THE WHOLE CARD: the write returning 200 is not the property — the traversal finding '
      + 'the child is. Both pass today with an edge pointing at a node that does not exist.');
  } finally { await p.stop(); }
});

test('#917 the stored value is CANONICAL — a shortId in, a uuid stored', async () => {
  // The mechanism behind the assertion above, pinned separately so a future
  // change that makes the traversal pass some other way still has to keep the
  // stored form canonical. Two cards cannot both be `parent: "857"` and mean
  // different things.
  const p = await startPair();
  try {
    const apex = (await mk(p.rest.baseUrl, 'apex')).card;
    const child = (await mk(p.rest.baseUrl, 'child')).card;
    await patch(p.rest.baseUrl, child.id, { parent: String(apex.shortId) });
    assert.equal((await get(p.rest.baseUrl, child.id)).parent, apex.id,
      'the shortId must be resolved to the card id before storage, not echoed back');
  } finally { await p.stop(); }
});

test('#917 CREATE resolves a shortId parent too, not only PATCH', async () => {
  const p = await startPair();
  try {
    const apex = (await mk(p.rest.baseUrl, 'apex')).card;
    const made = await mk(p.rest.baseUrl, 'born nested', { parent: String(apex.shortId) });
    assert.equal(made.status, 201);
    assert.equal(made.card.parent, apex.id, 'create must resolve it as well — #254 shipped both surfaces');

    const session = await mcpSession(p.mcp.mcpUrl);
    assert.deepEqual(await traverse(session, apex.shortId), [String(made.card.shortId)]);
  } finally { await p.stop(); }
});

test('#917 ⛔ AN UNRESOLVABLE PARENT IS REFUSED, NOT MINTED', async () => {
  // Acceptance 3. Today a valid parent and a typo are indistinguishable at the
  // API: both return 200 and both produce an edge. One of the edges points at
  // nothing, and nothing says which.
  const p = await startPair();
  try {
    const child = (await mk(p.rest.baseUrl, 'child')).card;
    const res = await patch(p.rest.baseUrl, child.id, { parent: '99999' });
    assert.equal(res.status, 400, 'a parent naming no card must fail loudly');
    assert.equal((await get(p.rest.baseUrl, child.id)).parent ?? null, null, 'and nothing was written');

    const made = await mk(p.rest.baseUrl, 'nope', { parent: '99999' });
    assert.equal(made.status, 400, 'create must refuse it too');
  } finally { await p.stop(); }
});

test('#917 the UUID path still works — the 19 live edges must not regress', async () => {
  // Acceptance 5. The existing containment edges all point at real UUIDs; the
  // fix must resolve the shortId form WITHOUT changing the form that already
  // works. This is the regression guard for the half that was never broken.
  const p = await startPair();
  try {
    const apex = (await mk(p.rest.baseUrl, 'apex')).card;
    const child = (await mk(p.rest.baseUrl, 'child')).card;
    await patch(p.rest.baseUrl, child.id, { parent: apex.id });
    assert.equal((await get(p.rest.baseUrl, child.id)).parent, apex.id, 'a uuid stays exactly as given');

    const session = await mcpSession(p.mcp.mcpUrl);
    assert.deepEqual(await traverse(session, apex.shortId), [String(child.shortId)]);
  } finally { await p.stop(); }
});

test('#917 clearing a parent still works after resolution is added', async () => {
  // ⚠️ The over-refusal check: `null` means "make this a root" and must not be
  // dragged into the resolver and refused as "a card that does not exist".
  const p = await startPair();
  try {
    const apex = (await mk(p.rest.baseUrl, 'apex')).card;
    const child = (await mk(p.rest.baseUrl, 'child')).card;
    await patch(p.rest.baseUrl, child.id, { parent: apex.id });
    const res = await patch(p.rest.baseUrl, child.id, { parent: null });
    assert.equal(res.status, 200, 'un-nesting must remain possible');
    assert.equal((await get(p.rest.baseUrl, child.id)).parent ?? null, null);
  } finally { await p.stop(); }
});

test('#917 ⭐ the MCP path resolves — the surface a seat actually reaches from', async () => {
  // #254 exists so an MCP-only seat can nest a card. If resolution lands only on
  // REST, the population this was built for still writes dangling edges.
  const p = await startPair();
  try {
    const apex = (await mk(p.rest.baseUrl, 'apex')).card;
    const child = (await mk(p.rest.baseUrl, 'child')).card;
    const session = await mcpSession(p.mcp.mcpUrl);

    await session.callTool('card_update', {
      id: String(child.shortId), parent: String(apex.shortId), by: 'ada',
    });
    assert.equal((await get(p.rest.baseUrl, child.id)).parent, apex.id);
    assert.deepEqual(await traverse(session, apex.shortId), [String(child.shortId)],
      'the seat that can only reach MCP must produce a real edge, not a plausible one');
  } finally { await p.stop(); }
});
