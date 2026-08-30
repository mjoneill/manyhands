/**
 * #927 / #1037 — the query this tool is WORST at is the one a seat most needs.
 *
 * ⛔ MEASURED (#927): four OR'd disjuncts WITH `LCASE()` in the FILTER never
 * returned and were killed at 309 seconds. The same four WITHOUT LCASE ran in
 * 6ms. Disjunct count is free; LCASE is the multiplier. And the engine is
 * SYNCHRONOUS, so it cannot be timed out (#885) — a hung query takes the shared
 * event loop with it.
 *
 * ⭐ The cruelty is the aim: LCASE is exactly what you reach for when you do not
 * know how a card was titled — which is the definition of a prior-art search.
 * The tool is fast where you already know the wording and fatal for the one
 * query whose whole purpose is that you don't.
 *
 * ⛔ SECOND HAZARD, same search (#962): `?c a scrum:Card` returns ZERO ROWS with
 * NO ERROR. Cards are `schema:CreativeWork`. The wrong spelling is the one a
 * reasonable person guesses, so the seat doing the sensible thing gets a
 * confident, silent, well-formed lie.
 *
 * #1037 measured what these cost: four re-derivations in one session, ~80
 * minutes, where every search that would have prevented them took 3-5 seconds.
 * #927's ask is one line — "document the working shape in the tool description"
 * — and its server-side-bound recommendation was WITHDRAWN in favour of it.
 *
 * ── WHY THE LAST TEST IS THE IMPORTANT ONE ──────────────────────────────────
 * A description is prose, and prose goes stale silently — this room has paid
 * for that repeatedly. So the `scrum:Card` claim is COUPLED to the world: if
 * #962 lands and cards become dual-typed, that test FAILS and forces the
 * description to be corrected. A documented hazard that has quietly stopped
 * being true is worse than an undocumented one, because it teaches a seat to
 * avoid something harmless while trusting the rest of the paragraph.
 *
 * ⚠️ NOTHING HERE EXECUTES AN LCASE FILTER. Doing so would hang the run for
 * ~309s and block the shared loop. The LCASE hazard is asserted as DOCUMENTED,
 * never as reproduced — #927 already paid for that measurement once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-08-01T00:00:00.000Z';
/**
 * ⚠️ A fixture with CARDS in it, not the empty default. The anti-vacuity guard in
 * the coupling test caught that: an empty board makes the right query and the
 * wrong query BOTH return 0, and "0 vs 0" is not a trap — it is two nothings.
 */
const boardWithCards = () => makeBoardFixture({
  cards: [1, 2, 3].map((n) => ({
    id: `c${n}`, shortId: n, title: `card ${n}`, description: '', type: 'task',
    assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
    createdAt: ts, updatedAt: ts,
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
  })),
  nextShortId: 4,
});

const describeGraphQuery = async (session) => {
  const tools = (await session.listTools()).result?.tools ?? [];
  const t = tools.find((x) => x.name === 'graph_query');
  assert.ok(t, 'graph_query must be registered — otherwise every assertion below is vacuous');
  return t.description || '';
};

test('#927 the tool description names the LCASE hazard AND the shape that works', async () => {
  const pair = await startPair({ board: boardWithCards() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const d = await describeGraphQuery(session);

    assert.match(d, /LCASE/,
      'the hazard must be named in the description a seat actually reads — #927\'s entire ask');
    assert.match(d, /309|hang|never returned/i,
      'naming LCASE without its COST reads as style advice; the number is why anyone obeys it');

    // ⭐ A refusal that does not teach is a refusal people route around (#885).
    // The working alternative has to be here, or the warning just blocks the search.
    assert.match(d, /CONTAINS\(\?name,"[^"]+"\)\s*\|\|/,
      'the description must show the WORKING case-insensitive shape — spelled-out cases — '
      + 'not merely forbid the broken one');
  } finally { await pair.stop(); }
});

test('#962 the tool description warns that `?c a scrum:Card` returns ZERO, silently', async () => {
  const pair = await startPair({ board: boardWithCards() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const d = await describeGraphQuery(session);

    // ⚠️ The literal spelling is NOT asserted, and the reason is a live collision
    // between two safety mechanisms: `scrum:Card` is one of the board-data
    // signatures the #561 publication gate refuses in source, so the description
    // CANNOT quote the trap it warns about. (This test file can — *.test.mjs is
    // excluded from that scan — which is why the coupling test below still runs
    // the real query.) The description must therefore identify the trap by
    // DESCRIPTION rather than by string, and say why.
    assert.match(d, /guess/i,
      'the description must identify the trap as the spelling a seat would GUESS — '
      + 'it cannot quote the literal, so it has to be recognisable from the reader\'s own typing');
    assert.match(d, /scrum namespace/i,
      'and it must name the namespace, or "the type everyone guesses" is unresolvable');
    assert.match(d, /zero|0 rows|no error|silent/i,
      'and it must say the failure is SILENT — a seat who sees an error investigates; '
      + 'a seat who sees 0 rows concludes the board is empty');
    assert.match(d, /schema:CreativeWork/,
      'the correct type must sit beside the wrong one');
  } finally { await pair.stop(); }
});

test('#927/#962 ⭐ THE COUPLING — the documented hazard is still TRUE of the live engine', async () => {
  // ⛔ THE TEST THAT KEEPS THE PROSE HONEST. If #962 lands and `scrum:Card`
  // starts resolving, this FAILS — which is the signal to correct the
  // description rather than leave a warning about a hazard that no longer
  // exists. A stale warning is worse than none: it spends a seat's trust on a
  // paragraph whose other claims may still matter.
  const pair = await startPair({ board: boardWithCards() });
  try {
    const ask = async (type) => {
      const r = await fetch(`${pair.rest.baseUrl}/api/graph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `SELECT (COUNT(?c) AS ?n) WHERE { ?c a ${type} }` }),
      });
      const b = await r.json();
      return { status: r.status, code: b.code, n: Number(b.rows?.[0]?.n ?? -1), error: b.error };
    };

    // ⭐ ANTI-VACUITY FIRST. "0 vs 0" would prove nothing at all — the trap is
    // only a trap because the RIGHT query returns rows on the same board.
    const right = await ask('schema:CreativeWork');
    assert.equal(right.status, 200, `the control query must ANSWER, got ${right.status} ${right.error}`);
    assert.ok(right.n > 0, `the control query must return rows, got ${right.n} — otherwise the fixture is empty and this test is meaningless`);

    // ⭐⭐⭐ UPDATED BY #1104, AND THIS TEST IS WHY THE UPDATE IS HONEST.
    //
    // It used to assert `scrum:Card` returns 0 ROWS — the SILENT failure. That
    // is no longer what happens: the unknown-term guard REFUSES it with a 400
    // naming the term, which is this test's own stated wish ("a seat who sees
    // an error investigates; a seat who sees 0 rows concludes the board is
    // empty") arriving as behaviour instead of prose.
    //
    // ⛔ WHAT HAS **NOT** CHANGED, and the distinction is the whole point:
    // `scrum:Card` still does not exist. #962 has NOT landed. The hazard was
    // MITIGATED, not retired — so the description must still warn about the
    // guess, and the assertions above this one still hold it to that.
    //
    // ⚠️ If some future change makes `scrum:Card` a real class, THIS assertion
    // fails too (a real term is answered, not refused) and the same instruction
    // applies: correct the description in the same commit.
    const wrong = await ask('scrum:Card');
    assert.equal(wrong.status, 400,
      `\`?c a scrum:Card\` returned ${wrong.status}/${wrong.n} rows — the documented hazard has CHANGED. `
      + 'If #962 has landed this is good news and the graph_query description must be '
      + 'corrected in the same commit; it currently warns seats away from a working query.');
    assert.equal(wrong.code, 'UNKNOWN_TERM',
      'and the refusal must be the #1104 guard, not an incidental parse failure — '
      + `got ${JSON.stringify(wrong.error).slice(0, 160)}`);
  } finally { await pair.stop(); }
});
