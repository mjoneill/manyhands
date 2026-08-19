/**
 * #906 — THE MISSING MIRROR: a byte-preserving write that lands at the TOP.
 *
 * ⛔ THE DEFECT IS A GRADIENT, NOT A BUG. Both existing verbs work correctly:
 *
 *     description        full replacement — to fix one paragraph you resend 26KB,
 *                        and every byte is a chance to lose text you meant to keep
 *     descriptionAppend  byte-preserving (#864) — and can ONLY add to the END
 *
 * ⇒ ⭐ So the SAFE verb produces the unusable card, and the USABLE shape requires
 * the DANGEROUS verb. The API does not merely permit the anti-pattern named on
 * #857 — it is the path of least risk toward it:
 *
 *   "it seems to require a lot of scrolling and a willingness to read things that
 *    were appended at the bottom to correct for things at the top."
 *
 * Measured when this card was filed — four cards, four authors, one shape,
 * nobody chose it: #857 (48KB, §IV rotted 4×), #894, #902, #905 (four
 * corrections in 90 minutes, its own author flagging the defect while committing
 * it). A fifth landed the same afternoon: #768 took three corrections from ME,
 * each appended below the text it corrects, while I held this card.
 *
 * ── WHY THE CONTROL IS THE FIRST TEST AND NOT THE LAST ────────────────────
 *
 * ⚠️ `assert(after.length > before.length)` PASSES for an implementation that
 * mangles the middle. So does `assert(after.includes(before))` on short inputs.
 * The property is not "the prepend worked" — it is NOTHING ELSE MOVED, which for
 * a prepend means the original survives as a byte-exact SUFFIX.
 *
 * ⇒ #864 learned this the expensive way: a re-composition of a 9,770-byte card
 * came back 99.98% byte-identical with prose and formatting untouched, and four
 * backslashes inserted inside SPARQL literals — breaking both runnable queries
 * while every layer reported success. The fixture below therefore carries the
 * things that actually break (quoted literals, fences, JSON, regex, backslashes,
 * non-ASCII) rather than describing them, because a fixture that only TALKS
 * about quoting cannot detect a quoting bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

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
  "An apostrophe's worth of prose, and a \"quoted phrase\".",
  '⇒ ⭐ non-ASCII, because the room writes in it and a byte-length bug hides here.',
].join('\n');

const CORRECTION = '# ⛔ CORRECTED 2026-08-19 — read this first\n\nThe section below is superseded.\n\n---\n\n';

const create = async (baseUrl, description) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'prepend probe', description, createdBy: 'ada' }),
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

test('#906 ⛔ THE PROPERTY: prepending leaves every prior byte identical', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, HAZARDOUS);
    const before = (await get(s.baseUrl, card.id)).description;
    assert.equal(before, HAZARDOUS, 'setup: the fixture must survive CREATE unchanged');

    const res = await patch(s.baseUrl, card.id, { descriptionPrepend: CORRECTION });
    assert.equal(res.status, 200, `prepend must be accepted: ${JSON.stringify(res.body).slice(0, 200)}`);

    const after = (await get(s.baseUrl, card.id)).description;
    assert.ok(
      after.endsWith(before),
      'THE WHOLE CARD. The original must be a byte-exact SUFFIX of the result — you '
      + 'cannot mangle text you never retyped. Divergence begins at offset '
      + `${after.length - before.length} of the result.`,
    );
    // ⭐ PAIRED CONTROL: suffix-preservation is satisfied by a no-op. "Nothing
    // moved" and "nothing happened" are identical to the assertion above.
    assert.ok(after.startsWith(CORRECTION), 'and the prepended text must actually be at the TOP');
    assert.equal(after.length, before.length + CORRECTION.length, 'exact — no separator invented, none lost');
    assert.equal(after, CORRECTION + before, 'the whole result, stated as one equality');
  } finally { await s.stop(); }
});

test('#906 the quoting survives — the bytes that broke on the live card in #864', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, HAZARDOUS);
    await patch(s.baseUrl, card.id, { descriptionPrepend: 'top.\n\n' });
    const after = (await get(s.baseUrl, card.id)).description;

    // ⭐ ANCHOR FIRST: without it, every "still intact" assertion below would also
    // pass against a server that returned the fixture and ignored the write.
    assert.ok(after.startsWith('top.\n\n'), 'anchor: the write landed at all');
    assert.ok(after.includes('schema:identifier "805"'), 'SPARQL literal quotes unescaped');
    assert.ok(after.includes('C:\\Users\\x'), 'backslashes not doubled');
    assert.ok(after.includes('{"alias": "schema-org"'), 'inline JSON intact');
    assert.ok(after.includes('/^[0-9a-f]{8}-[0-9a-f]{4}$/i'), 'regex intact');
    assert.ok(after.includes('⇒ ⭐ non-ASCII'), 'non-ASCII intact');
    assert.equal((after.match(/\\"/g) || []).length, 0, 'no escaped quotes introduced');
  } finally { await s.stop(); }
});

test('#906 ⛔ description + descriptionPrepend together is REFUSED, not silently ordered', async () => {
  // Same reasoning as #864's pairing rule: "replace it" and "add to the front of
  // it" are DIFFERENT edits to one field, so any precedence makes the result
  // depend on a convention the caller cannot see.
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'original');
    const res = await patch(s.baseUrl, card.id, { description: 'replaced', descriptionPrepend: 'top ' });
    assert.equal(res.status, 400, 'two contradictory edits to one field must be refused');
    assert.equal((await get(s.baseUrl, card.id)).description, 'original', 'and a refused write changes nothing');
  } finally { await s.stop(); }
});

test('#906 ⭐ prepend + append together IS allowed — the one pairing that is unambiguous', async () => {
  // ⚠️ A DECISION, recorded because the card did not specify it. `description`
  // conflicts with both because it destroys what they build on. But prepend and
  // append touch DISJOINT ends and compose to exactly one result: pre + old + post.
  // There is no ordering question, so refusing it would be an over-refusal — and
  // a rail whose failure mode is "the board stops accepting truth" is worse than
  // the defect it prevents (the work gate spent an afternoon proving that).
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'MIDDLE');
    const res = await patch(s.baseUrl, card.id, { descriptionPrepend: 'top ', descriptionAppend: ' tail' });
    assert.equal(res.status, 200, 'disjoint ends compose; this is not the contradictory case');
    assert.equal((await get(s.baseUrl, card.id)).description, 'top MIDDLE tail',
      'and the original is still bounded by both, unmodified');
  } finally { await s.stop(); }
});

test('#906 a non-string prepend is refused rather than coerced', async () => {
  // Coercing turns a caller's mistake into a permanent edit: String({}) writes
  // "[object Object]" at the TOP of the card, where it is maximally visible and
  // nothing downstream would ever flag it as an error.
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'original');
    for (const bad of [42, { a: 1 }, ['x'], true, null]) {
      const res = await patch(s.baseUrl, card.id, { descriptionPrepend: bad });
      assert.equal(res.status, 400, `descriptionPrepend: ${JSON.stringify(bad)} must be refused, not String()-ed`);
    }
    assert.equal((await get(s.baseUrl, card.id)).description, 'original', 'nothing was written');
  } finally { await s.stop(); }
});

test('#906 prepending to a card with NO description starts it, rather than writing "undefined"', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, '');
    await patch(s.baseUrl, card.id, { descriptionPrepend: 'first words' });
    assert.equal((await get(s.baseUrl, card.id)).description, 'first words');
  } finally { await s.stop(); }
});

test('#906 the field is CONSUMED, not reported as discarded (#823)', async () => {
  const s = await startRestServer();
  try {
    const card = await create(s.baseUrl, 'x');
    const res = await patch(s.baseUrl, card.id, { descriptionPrepend: 'y' });
    assert.ok(
      !(res.body.ignoredFields || []).includes('descriptionPrepend'),
      `a consumed field must not be named as ignored. got ${JSON.stringify(res.body.ignoredFields)}`,
    );
    // ⭐ ANCHOR: without this the assertion passes on a server that reports
    // nothing at all, measuring its own silence.
    const anchored = await patch(s.baseUrl, card.id, { descriptionPrepend: 'z', nosuchfield: 1 });
    assert.ok((anchored.body.ignoredFields || []).includes('nosuchfield'), 'anchor: #823 still reports unknown keys');
  } finally { await s.stop(); }
});

test('#906 CREATE does not advertise it — #830, and #831 caught this exact class on append', async () => {
  // A create-surface prepend is not an operation: there is nothing to prepend TO,
  // and create already takes `description`. Validating it on create would produce
  // #830's three-state mess — the route refusing malformed values for a field it
  // then silently discards, so a caller reading the 400 and a caller reading
  // ignoredFields get opposite answers.
  const s = await startRestServer();
  try {
    const r = await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', createdBy: 'ada', description: 'body', descriptionPrepend: 'top ' }),
    });
    assert.equal(r.status, 201, 'create is not refused for carrying it');
    const body = await r.json();
    assert.equal(body.description, 'body', 'and it did NOT silently take effect');
    assert.ok((body.ignoredFields || []).includes('descriptionPrepend'),
      `create must SAY it discarded it (#823). got ${JSON.stringify(body.ignoredFields)}`);
  } finally { await s.stop(); }
});

// ── the beneficiary: the seat that cannot use REST ─────────────────────────

test('#906 ⭐ THE POINT: an MCP-only seat can prepend a correction without re-composing', async () => {
  // ⚠️ #904, filed this morning: #651 shipped a node type whose write path
  // excluded the seats it was built for, and nobody noticed until someone tried.
  // Acceptance item 4 exists so this is not that again.
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const card = await create(rest.baseUrl, HAZARDOUS);
    const before = (await get(rest.baseUrl, card.id)).description;

    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('card_update', {
      id: String(card.shortId), descriptionPrepend: CORRECTION, by: 'ada',
    });
    assert.ok(res.result?.content?.[0]?.text, `unexpected tool result: ${JSON.stringify(res).slice(0, 200)}`);

    const after = (await get(rest.baseUrl, card.id)).description;
    assert.ok(
      after.endsWith(before),
      'the MCP path must be byte-preserving too, or the inequality this card exists '
      + 'to close is still there with a nicer name',
    );
    assert.ok(after.startsWith(CORRECTION), 'and the correction must be at the TOP, which is the whole point');
    assert.equal((after.match(/\\"/g) || []).length, 0, 'no escaped quotes introduced');
  } finally { await mcp.stop(); await rest.stop(); }
});
