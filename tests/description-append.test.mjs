/**
 * #864 — A BYTE-PRESERVING EDIT, AVAILABLE TO EVERY SEAT.
 *
 * ⚰️ THE INEQUALITY. `card_update` takes a full `description` string and nothing
 * else, so a seat whose only write path is MCP cannot add a paragraph without
 * REGENERATING the whole field from context. That is not a copy — it is a
 * re-composition, and a model re-composing dense formatted text diverges.
 *
 *     a seat with bash/REST   can append. Byte-preserving edits are available.
 *     an MCP-only seat        CANNOT. Every description edit is a re-composition.
 *
 * ⇒ ⭐⭐⭐ #857 §I calls manyhands "infrastructure for several minds working as
 * PEERS". A seat that cannot edit a long card without corrupting it is not a
 * peer, and the asymmetry runs along the room's central write path.
 *
 * ── AND THE DRIFT IS NOT RANDOM, WHICH IS WHAT TO DESIGN AGAINST ──────────
 *
 * Measured on #814, a 9,770-byte card, on 2026-08-18:
 *
 *     similarity 0.999795 · inserted 4 × '\' · deleted NOTHING · reworded NOTHING
 *     all four landed inside the two SPARQL blocks, escaping the string literals
 *     `schema:identifier "805"`  became  `schema:identifier \"805\"`
 *
 * ⇒ ⛔ 99.98% byte-identical, prose untouched, formatting untouched, and the
 * EXECUTABLE part broken. Both example queries on that card became syntax
 * errors — including the one demonstrating its own test passing.
 *
 * ⚠️ Re-composition damages precisely the content that has a correctness
 * property. A model will not mangle prose in a way anyone notices; it mangles
 * QUOTING, and quoting is where the runnable things live.
 *
 * ⚠️ AND EVERY LAYER REPORTED SUCCESS: the PATCH returned 200, the writer's
 * read-back matched what she sent, the card rendered perfectly. An accurately
 * stored write of inaccurately reproduced content. The only instrument that
 * sees it is a diff against what was THERE — the one check a writer cannot run
 * on themselves.
 *
 * ── SO THE ACCEPTANCE TEST IS A CORRUPTION TEST ───────────────────────────
 *
 * From the card, and it is the right standard:
 *   ⛔ "The append worked" is not the property. "Nothing else moved" is.
 *
 * The tests below therefore assert BYTE-IDENTITY of the untouched region
 * against a fixture full of exactly the things that break — SPARQL with quoted
 * literals, a fenced code block, JSON, a regex, backslashes — with a paired
 * control proving the intended change actually landed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

/**
 * Everything that has ever been mangled by a re-composition, in one string.
 * ⚠️ Deliberately written with real escapes rather than described in prose: a
 * fixture that only TALKS about quoting cannot detect a quoting bug.
 */
const HAZARDOUS = [
  '# A card with runnable things in it',
  '',
  '```sparql',
  'SELECT ?commit WHERE { ?c schema:identifier "805" . ?c scrum:implementedBy ?commit }',
  'ASK { ?c schema:identifier "651" ; scrum:column column:done }',
  '```',
  '',
  'Inline JSON: `{"alias": "schema-org", "canonical": "schema.org"}`',
  'A regex: `/^[0-9a-f]{8}-[0-9a-f]{4}$/i` and a path `C:\\Users\\x`',
  'A shell line: `grep -oE "nn\\(S \\+ .[a-z]+.\\)" file.mjs`',
  "An apostrophe's worth of prose, and a \"quoted phrase\".",
].join('\n');

const create = async (baseUrl, description) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'append probe', description, createdBy: 'ada' }),
  });
  return r.json();
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

test('#864 ⛔ THE PROPERTY: appending leaves every prior byte identical', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, HAZARDOUS);
    const before = (await get(s.baseUrl, card.id)).description;
    assert.equal(before, HAZARDOUS, 'setup: the fixture must survive CREATE unchanged');

    const res = await patch(s.baseUrl, card.id, { descriptionAppend: '\n\n## An appended section\n\nnew text.' });
    assert.equal(res.status, 200, `append must be accepted: ${JSON.stringify(res.body).slice(0, 200)}`);

    const after = (await get(s.baseUrl, card.id)).description;
    assert.ok(
      after.startsWith(before),
      'THE WHOLE CARD. The original must be a byte-exact PREFIX of the result — you '
      + 'cannot mangle text you never retyped. First divergence at index '
      + `${[...before].findIndex((ch, i) => after[i] !== ch)}`,
    );
    // ⭐ PAIRED CONTROL: prefix-preservation is satisfied by a no-op, so prove
    // the intended change also landed. "Nothing moved" and "nothing happened"
    // are the same to the assertion above.
    assert.ok(after.endsWith('new text.'), 'and the appended text must actually be there');
    assert.equal(after.length, before.length + '\n\n## An appended section\n\nnew text.'.length);
  } finally { await s.stop(); }
});

test('#864 the quoting survives — the specific bytes that broke on the live card', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, HAZARDOUS);
    await patch(s.baseUrl, card.id, { descriptionAppend: '\n\nmore.' });
    const after = (await get(s.baseUrl, card.id)).description;

    // ⭐ ANCHOR FIRST. Every assertion below says "this text is still intact",
    // which is trivially true if the write did nothing at all — and on the
    // pre-fix server it DID do nothing, so this test passed while the six
    // around it failed. An intactness claim needs proof the write happened.
    assert.ok(after.endsWith('more.'), 'anchor: the append must have landed, or "unchanged" is free');

    // The exact corruption measured on #814: `"805"` became `\"805\"`.
    assert.ok(after.includes('schema:identifier "805"'), 'the SPARQL literal must be untouched');
    assert.equal((after.match(/\\"/g) || []).length, 0, 'no backslash-escaped quotes may appear');
    assert.ok(after.includes('C:\\Users\\x'), 'and a windows path must keep its single backslashes');
    assert.ok(after.includes('{"alias": "schema-org"'), 'inline JSON keeps its quotes');
  } finally { await s.stop(); }
});

test('#864 ⛔ sending BOTH description and descriptionAppend is refused, not silently ordered', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'original');
    const res = await patch(s.baseUrl, card.id, { description: 'replaced', descriptionAppend: ' plus' });
    assert.equal(
      res.status, 400,
      'These are two different edits to one field, and any precedence rule makes the '
      + 'result depend on a convention the caller cannot see. #831/#862 pinned '
      + 'precedence where both spellings mean the SAME thing; these do not.',
    );
    const after = (await get(s.baseUrl, card.id)).description;
    assert.equal(after, 'original', 'and a refused write must change nothing');
  } finally { await s.stop(); }
});

test('#864 a non-string append is refused rather than coerced', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'original');
    for (const bad of [42, { a: 1 }, ['x'], true]) {
      const res = await patch(s.baseUrl, card.id, { descriptionAppend: bad });
      assert.equal(res.status, 400, `descriptionAppend: ${JSON.stringify(bad)} must be refused, not String()-ed`);
    }
    assert.equal((await get(s.baseUrl, card.id)).description, 'original', 'nothing was written');
  } finally { await s.stop(); }
});

test('#864 appending to a card with NO description starts it, rather than writing "undefined"', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, '');
    await patch(s.baseUrl, card.id, { descriptionAppend: 'first words' });
    assert.equal((await get(s.baseUrl, card.id)).description, 'first words');
  } finally { await s.stop(); }
});

test('#864 the field is CONSUMED, not reported as discarded (#823)', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'x');
    const res = await patch(s.baseUrl, card.id, { descriptionAppend: 'y' });
    assert.ok(
      !(res.body.ignoredFields || []).includes('descriptionAppend'),
      `a consumed field must not be named as ignored. got ${JSON.stringify(res.body.ignoredFields)}`,
    );
    // ⭐ ANCHOR: without this the assertion passes on a server that reports
    // nothing at all, measuring its own silence.
    const anchored = await patch(s.baseUrl, card.id, { descriptionAppend: 'z', nosuchfield: 1 });
    assert.ok((anchored.body.ignoredFields || []).includes('nosuchfield'), 'anchor: #823 still reports unknown keys');
  } finally { await s.stop(); }
});

// ── the beneficiary: the seat that cannot use REST ─────────────────────────

test('#864 ⭐ THE POINT: an MCP-only seat can append without re-composing', async () => {
  // ⚠️ #619's finding, and #656's `q` an hour ago: a capability that exists only
  // on REST leaves the primary beneficiary standing at a door they cannot open.
  // The seat this card is FOR reaches the board through MCP and nowhere else.
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const card = await create(rest.baseUrl, HAZARDOUS);
    const before = (await get(rest.baseUrl, card.id)).description;

    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('card_update', {
      id: String(card.shortId), descriptionAppend: '\n\nappended via MCP.', by: 'ada',
    });
    assert.ok(res.result?.content?.[0]?.text, `unexpected tool result: ${JSON.stringify(res).slice(0, 200)}`);

    const after = (await get(rest.baseUrl, card.id)).description;
    assert.ok(
      after.startsWith(before),
      'the MCP path must be byte-preserving too, or the inequality this card exists '
      + 'to close is still there with a nicer name',
    );
    assert.ok(after.endsWith('appended via MCP.'), 'and the append must have landed');
    assert.equal((after.match(/\\"/g) || []).length, 0, 'no escaped quotes introduced');
  } finally { await mcp.stop(); await rest.stop(); }
});
