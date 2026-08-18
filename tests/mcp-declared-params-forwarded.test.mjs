/**
 * #831/#656 — AN MCP TOOL MUST FORWARD EVERY PARAMETER IT ADVERTISES.
 *
 * ⚰️ FOUND BY USING THE BOARD, NOT BY READING IT. Searching for a card via
 * `card_list(q: "synonym")` returned 795 cards. The REST route returned 4, and
 * a negative control returned 0 — so the search worked and the adapter did not.
 *
 *     mcp-server.mjs, card_list:
 *       inputSchema: { …, q: z.string().optional() }          ⇐ ADVERTISED
 *       async ({ limit, before, fields, column, label, … })   ⇐ NEVER DESTRUCTURED
 *       const q = new URLSearchParams(…)                      ⇐ and the name is SHADOWED
 *
 * ⇒ ⛔ THE ANSWER WAS WRONG AND FLUENT. A dropped filter does not error, does
 * not warn, and does not appear in `ignoredFields` — zod ACCEPTS `q`, so it
 * never reaches the unknown-field diagnostic (#823) that exists for exactly
 * this. The caller gets a complete-looking list of everything and no reason to
 * doubt it. That is the failure mode #655/#844 ranked as worse than refusing.
 *
 * ⭐⭐ AND THE BENEFICIARY IS THE POINT. `q` was built because the retrieval
 * miss log (#801) recorded seats asking for it — and seats reach this board
 * through MCP. The feature shipped, the demand was real, and the population
 * that generated the demand still could not use it. That is #619's finding
 * ("a REST-only surface leaves the primary beneficiary standing at a door they
 * cannot open"), which is quoted in a comment ELEVEN LINES BELOW the defect.
 *
 * ── WHY THIS FILE IS STRUCTURAL AND NOT A TEST FOR `q` ────────────────────
 *
 * Fixing `q` fixes one parameter. The defect is a CLASS: the three-list
 * invariant (#831) — schema declares ∧ handler forwards ∧ route accepts —
 * failing at the second list, on a surface where failure is silent. So the
 * assertion below walks EVERY registered tool and compares what it advertises
 * against what its handler actually passes on.
 *
 * ⚠️ It reads the source rather than calling the tools, deliberately: a
 * behavioural probe would need a fixture that distinguishes "filtered" from
 * "unfiltered" for every parameter of every tool, and the ones it could not
 * construct would silently go unchecked — which is the same shape as the bug.
 * Reading the source cannot skip a tool without saying so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(PROJECT_DIR, 'mcp-server.mjs'), 'utf8');

/**
 * Each tool's HANDLER text, keyed by tool name.
 *
 * ⚠️ Split on registration boundaries rather than brace/paren matched. The
 * first version of this walked paren depth from `registerTool(` — and every
 * tool description in this file contains parentheses ("(#628)", "(use \"null\"
 * string…)"), so the depth counter closed early, silently dropped most tools,
 * and reported three findings from the wreckage. ⭐ The CONTROL below is the
 * only reason that was caught rather than published: a broken parser and a
 * clean codebase produce the same empty list.
 *
 * The SCHEMA half is not parsed at all — it is read from the running server's
 * `tools/list`, which is the authoritative surface a caller actually sees.
 */
function handlerTexts(src) {
  const out = new Map();
  const sites = [...src.matchAll(/mcp\.registerTool\(\s*'([^']+)'/g)];
  sites.forEach((m, i) => {
    const end = i + 1 < sites.length ? sites[i + 1].index : src.length;
    const block = src.slice(m.index, end);
    // The handler is everything after the schema object closes: `}, async (…`.
    const at = block.indexOf('}, async');
    out.set(m[1], at >= 0 ? block.slice(at) : '');
  });
  return out;
}

const HANDLERS = handlerTexts(SRC);

// ⭐ Parameters a handler deliberately does not forward as a query/body key,
// with the reason. An allowlist rather than a heuristic: a heuristic that
// guessed "probably fine" would re-open the hole this file closes.
const NOT_FORWARDED = {
  // (empty today — every declared parameter is used. Add entries WITH a reason.)
};

/** The live tool list, which is what a caller's client actually reads. */
async function liveTools() {
  const mcp = await startMcpServer();
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const listed = await session.listTools();
    return listed.result.tools.map((t) => ({
      name: t.name,
      schemaKeys: Object.keys(t.inputSchema?.properties || {}),
    }));
  } finally { await mcp.stop(); }
}

test('#831 every MCP tool forwards every parameter it advertises', async () => {
  const tools = await liveTools();

  // ⭐ CONTROLS FIRST, in the same test, so the assertion below can never be a
  // measurement of an empty list. Both halves must be demonstrably present.
  assert.ok(tools.length > 20, `control: expected the adapter's full tool set, listed ${tools.length}`);
  const cardList = tools.find((t) => t.name === 'card_list');
  assert.ok(cardList, 'control: card_list must be listed');
  for (const k of ['q', 'column', 'label', 'assignee', 'limit']) {
    assert.ok(cardList.schemaKeys.includes(k),
      `control: card_list must ADVERTISE ${k}, got ${JSON.stringify(cardList.schemaKeys)}`);
  }
  assert.ok((HANDLERS.get('card_list') || '').length > 50,
    'control: the source parser must find card_list\'s handler, or every "not referenced" '
    + 'result below is the parser being broken rather than a finding');

  const missing = [];
  let destructuring = 0, passThrough = 0;
  for (const t of tools) {
    const handler = HANDLERS.get(t.name);
    assert.ok(handler !== undefined, `control: no handler text parsed for ${t.name}`);

    // ⚠️ TWO HANDLER SHAPES, and only one of them can drop a parameter.
    //
    //   PASS-THROUGH   async (args) => apiCall('POST', '/api/cards', args)
    //                  async ({ id, ...patch }) => apiCall('PATCH', …, patch)
    //                  forwards the remainder and NAMES nothing else. Checking
    //                  for each key here reports every parameter as missing —
    //                  which is what the first two versions of this test did,
    //                  on card_create and then on card_update.
    //   EXHAUSTIVE     async ({ limit, before, fields, … }) => …
    //                  forwards exactly what it lists and NOTHING ELSE, so a
    //                  key absent from the list is a key silently dropped.
    //
    // ⭐⭐ THE STRUCTURAL LESSON, which is worth more than the bug: a REST
    // ELEMENT makes this defect UNREPRESENTABLE. `{ id, ...patch }` cannot
    // drop a parameter, because it never enumerates them. `q` was lost in the
    // one handler that enumerates — where forwarding a new field is a second
    // edit nobody is reminded to make. Prefer unrepresentable to policed; this
    // test exists for the handlers that cannot take that shape.
    const sig = handler.slice(handler.indexOf('async') + 5, handler.indexOf('=>'));
    if (!sig.includes('{') || sig.includes('...')) { passThrough += 1; continue; }
    destructuring += 1;

    // ⛔ MATCH THE DESTRUCTURE LIST, NOT THE HANDLER BODY.
    //
    // A body-wide `\bq\b` search passes on the broken adapter, because the
    // handler contains `const q = new URLSearchParams(…)` — the local that
    // SHADOWS the dropped parameter. ⭐⭐⭐ The shadowing that hid this bug from
    // every reader hid it from the detector too, in exactly the same way, and
    // the check reported green on the code it was written to catch. A search
    // for a NAME cannot tell which binding it found.
    const names = new Set([...sig.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[,}:=])/g)].map((m) => m[1]));
    for (const key of t.schemaKeys) {
      if (NOT_FORWARDED[`${t.name}.${key}`]) continue;
      if (!names.has(key)) missing.push(`${t.name}.${key}`);
    }
  }

  // ⭐ Both shapes must actually occur, or the branch above is untested and one
  // whole population is silently exempt — the defect this file exists to catch,
  // reintroduced inside its own instrument.
  assert.ok(destructuring > 3, `control: expected several destructuring handlers, saw ${destructuring}`);
  assert.ok(passThrough > 0, `control: expected at least one pass-through handler, saw ${passThrough}`);

  assert.deepEqual(
    missing, [],
    'These parameters are ADVERTISED in an MCP tool\'s inputSchema and never referenced by its\n'
    + 'handler. zod accepts them, so the caller gets NO error and NO ignoredFields entry — just a\n'
    + 'silently unfiltered answer that looks complete. Found:\n'
    + missing.map((m) => `    ${m}`).join('\n')
    + '\n\n  Fix: destructure it and put it on the outgoing request — or, if it genuinely should not\n'
    + '  be forwarded, add it to NOT_FORWARDED in this file WITH the reason.\n',
  );
});

// ── and the behaviour, through the door an agent actually uses ─────────────

test('#656 card_list(q:) FILTERS — the search reaches the surface agents call', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const mk = (title) => fetch(`${rest.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, createdBy: 'ada' }),
    });
    await mk('a card about voiceprints');
    await mk('an unrelated card');
    await mk('another unrelated card');

    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('card_list', { q: 'voiceprint' });
    // The JSON-RPC envelope: { result: { content: [{ text }] } }. Probed, not
    // assumed — the first version read `res.content` and died on undefined,
    // which at least fails loudly rather than measuring the wrong thing.
    assert.ok(res.result?.content?.[0]?.text, `unexpected tool-result shape: ${JSON.stringify(res).slice(0, 200)}`);
    const payload = JSON.parse(res.result.content[0].text);
    const titles = (payload.cards || payload).map((c) => c.title);

    // ⭐ ANCHOR: three cards exist, so an UNFILTERED answer is 3. Asserting
    // "contains the match" would pass on the broken adapter, which returned
    // everything and therefore contained it.
    assert.equal(
      titles.length, 1,
      'q must FILTER, not decorate. The broken adapter returned every card and the '
      + `match was among them, which is how this went unnoticed. got ${JSON.stringify(titles)}`,
    );
    assert.match(titles[0], /voiceprint/);
  } finally { await mcp.stop(); await rest.stop(); }
});
