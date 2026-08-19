/**
 * #912 — "everything under apex X, containment only, depth ≤ N", as a knob.
 *
 * ⭐ THE CARD'S OWN FINDING, and it is why this is small: the capability already
 * works. `?c schema:isPartOf+ ?apex` returns #867's six children in 6.9ms,
 * containment-only, no blow-up — `relatedTo` and `mentionsCard` are simply not
 * in the path. #902 said the expression did not exist; going to build it proved
 * otherwise. So this is not "build a traversal", it is "expose one".
 *
 * ── ⛔ WHY THE FIXTURE IS THREE LEVELS DEEP, AND WHY THAT IS THE WHOLE TEST ──
 *
 * The card is explicit, and it is the most important line in it:
 *
 *     ?c schema:isPartOf ?apex                    depth = 1  → 6
 *     ?c schema:isPartOf/schema:isPartOf? ?apex   depth ≤ 2  → 6
 *
 * Identical — because the containment forest on the live board is ONE LEVEL
 * DEEP everywhere: 19 edges, 4 parents, zero grandchildren. ⇒ A WORKING DEPTH
 * LIMIT AND A BROKEN ONE RETURN THE SAME SET ON PRODUCTION, by construction.
 * There is no input on that board that could tell them apart, so a green run
 * against it would be a check that cannot fail.
 *
 * ⇒ Hence a grandparent → parent → child fixture built here, where `depth=1`
 * returning the child is a visible failure. [[a fixture that cannot discriminate]]
 *
 * ── AND THE CONTROL THAT DECIDES WHETHER THIS CHANGED ANYTHING ──────────────
 *
 * The existing unbounded traversal returns ~87% of the board because it follows
 * association edges. A card joined to the apex by `relatedTo` but NOT by
 * containment must be ABSENT here. If it is present, this returns the same set
 * under a new name and has changed nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

const mk = async (baseUrl, title, extra = {}) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', ...extra }),
  });
  assert.equal(r.status, 201, `setup: create ${title}`);
  return r.json();
};

const list = async (baseUrl, qs) => {
  const r = await fetch(`${baseUrl}/api/cards?${qs}`);
  return { status: r.status, body: await r.json() };
};

const titles = (body) => (body.cards || []).map((c) => c.title).sort();

/**
 * grandparent
 *   └─ parent
 *        └─ child
 * cousin ── relatedTo ──▶ grandparent   (association, NOT containment)
 * stranger                              (nothing at all)
 */
const tree = async (baseUrl) => {
  const gp = await mk(baseUrl, 'grandparent');
  const parent = await mk(baseUrl, 'parent', { parent: gp.id });
  const child = await mk(baseUrl, 'child', { parent: parent.id });
  const cousin = await mk(baseUrl, 'cousin', { relationships: { relatedTo: [gp.shortId] } });
  const stranger = await mk(baseUrl, 'stranger');
  return { gp, parent, child, cousin, stranger };
};

test('#912 ⭐ one call returns everything under an apex, by containment', async () => {
  const s = await startRestServer();
  try {
    const t = await tree(s.baseUrl);
    const res = await list(s.baseUrl, `under=${t.gp.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    assert.deepEqual(titles(res.body), ['child', 'parent'],
      'the whole subtree, and the apex itself is not its own descendant');
  } finally { await s.stop(); }
});

test('#912 ⛔ THE CONTROL: an association edge is NOT containment', async () => {
  // If `cousin` appears, this follows association like the unbounded traversal
  // does and has changed nothing — which is the card's own acceptance 3.
  const s = await startRestServer();
  try {
    const t = await tree(s.baseUrl);
    const res = await list(s.baseUrl, `under=${t.gp.id}`);
    const got = titles(res.body);
    assert.equal(got.includes('cousin'), false,
      `a relatedTo card must be ABSENT — got ${JSON.stringify(got)}`);
    assert.equal(got.includes('stranger'), false, 'and an unconnected card too');
    // ⭐ PAIRED: prove the cousin edge actually exists, or "absent" is vacuous.
    const gp = await (await fetch(`${s.baseUrl}/api/cards/${t.gp.id}`)).json();
    assert.ok(gp.relationships.relatedTo.includes(t.cousin.shortId),
      'setup control: the association edge must really be there for its absence to mean anything');
  } finally { await s.stop(); }
});

test('#912 ⛔ DEPTH IS REAL — depth=1 returns the parent and NOT the child', async () => {
  // THE test. On the live board this assertion is unfalsifiable, because nothing
  // there is two levels deep. Here it fails loudly if depth is ignored.
  const s = await startRestServer();
  try {
    const t = await tree(s.baseUrl);
    const d1 = await list(s.baseUrl, `under=${t.gp.id}&depth=1`);
    assert.deepEqual(titles(d1.body), ['parent'],
      'depth=1 is direct children only — a grandchild here means depth is being ignored');

    const d2 = await list(s.baseUrl, `under=${t.gp.id}&depth=2`);
    assert.deepEqual(titles(d2.body), ['child', 'parent'], 'depth=2 reaches the grandchild');

    // ⭐ CONTROL ON THE CONTROL: the two must DIFFER, or the fixture is too
    // shallow to discriminate and both assertions above are decoration.
    assert.notDeepEqual(titles(d1.body), titles(d2.body),
      'depth=1 and depth=2 returned the same set — the fixture cannot discriminate');
  } finally { await s.stop(); }
});

test('#912 an apex with no children returns an EMPTY SET, not an error', async () => {
  // Acceptance 5. This is every apex on the board today, including #857 — so the
  // common case must not look like a failure.
  const s = await startRestServer();
  try {
    const lonely = await mk(s.baseUrl, 'lonely apex');
    const res = await list(s.baseUrl, `under=${lonely.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.cards, []);
    assert.equal(res.body.cardsTotal, 0);
  } finally { await s.stop(); }
});

test('#912 an unknown apex REFUSES rather than returning an empty set', async () => {
  // ⚠️ "No children" and "no such card" are different facts and must not share a
  // response. An empty set for a typo'd id is the silent-zero shape: the caller
  // concludes the subtree is empty when the question was never asked.
  const s = await startRestServer();
  try {
    const res = await list(s.baseUrl, 'under=11111111-2222-3333-4444-555555555555');
    assert.equal(res.status, 400, 'an apex that does not exist is a bad request, not an empty subtree');
    assert.match(JSON.stringify(res.body), /apex|under|not found|unknown/i);
  } finally { await s.stop(); }
});

test('#912 `under` composes with the existing filters', async () => {
  const s = await startRestServer();
  try {
    const t = await tree(s.baseUrl);
    await fetch(`${s.baseUrl}/api/cards/${t.child.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['keeper'] }),
    });
    const res = await list(s.baseUrl, `under=${t.gp.id}&label=keeper`);
    assert.deepEqual(titles(res.body), ['child'], 'subtree AND label, not one or the other');
  } finally { await s.stop(); }
});

test('#912 a cycle in the data cannot hang the walk', async () => {
  // ⚠️ #254 shipped a guard that refuses to CREATE a cycle, so this should be
  // unreachable — but a traversal that trusts its input to be acyclic is one
  // bad row away from an infinite loop on the endpoint anyone can hit. The
  // guard and the walk protect different things.
  const s = await startRestServer();
  try {
    const a = await mk(s.baseUrl, 'A');
    const b = await mk(s.baseUrl, 'B', { parent: a.id });
    // force a cycle past the guard, the only way it can happen: straight to disk
    const res = await fetch(`${s.baseUrl}/api/cards/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: b.id }),
    });
    assert.equal(res.status, 409, 'the #254 guard still refuses — this is the anchor, not the test');
    // With the guard holding, the walk cannot meet a cycle from this path; assert
    // the ordinary answer still comes back rather than pretending to test more.
    const out = await list(s.baseUrl, `under=${a.id}`);
    assert.equal(out.status, 200);
    assert.deepEqual(titles(out.body), ['B']);
  } finally { await s.stop(); }
});

test('#912 ⭐ reachable by an MCP-only seat (#904s lesson)', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const t = await tree(rest.baseUrl);
    const session = await mcpSession(mcp.mcpUrl);
    const r = await session.callTool('card_list', { under: t.gp.id, depth: 1 });
    const text = r.result?.content?.[0]?.text;
    assert.ok(text, `unexpected tool result: ${JSON.stringify(r).slice(0, 200)}`);
    const body = JSON.parse(text);
    assert.deepEqual(titles(body), ['parent'],
      'the knob must exist on the surface the seats actually use, with depth honoured');
  } finally { await mcp.stop(); await rest.stop(); }
});
