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

test('#962 the description says BOTH types match, and states the projection-only divergence', async () => {
  // ✅ INVERTED 2026-08-24 when #962 landed. It read "warns that the guessed type
  // returns ZERO, silently" — and it FAILED the moment the alias started
  // resolving, which is what it was written to do. Not deleted: inverted, per
  // the #923 precedent, because deleting removes the only test that ever tied
  // this paragraph to the engine's actual behaviour.
  const pair = await startPair({ board: boardWithCards() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const d = await describeGraphQuery(session);

    assert.match(d, /scrum:Card/, 'the working spelling must be quotable now that it works');
    assert.match(d, /schema:CreativeWork/, 'and its sibling, since both match');

    // ⛔ THE REVIEWER'S CONDITION, and it is the half most likely to be dropped.
    // A reader who sees "scrum:Card now works" will assume the export changed
    // too. It did not — the stored document types a card as CreativeWork alone.
    assert.match(d, /PROJECTION-ONLY|projection-only/,
      'the description MUST say the type is projection-only, or it invites exactly '
      + 'the wrong inference about the stored document');
    assert.match(d, /stored document|board-data/i,
      'and it must name the surface that does NOT carry it');
  } finally { await pair.stop(); }
});

test('#962 ⭐ THE COUPLING, INVERTED — the alias RESOLVES, and the DOCUMENT still does not carry it', async () => {
  // ⛔ THE DIVERGENCE IS THE RISK, so it is the thing under test. Two surfaces,
  // one name: if someone later dual-types the stored document (option 4a), this
  // fails and forces the description's "projection-only" claim to be corrected
  // in the same commit — the same mechanism that caught #962 itself.
  const pair = await startPair({ board: boardWithCards() });
  try {
    const ask = async (type) => {
      const r = await fetch(`${pair.rest.baseUrl}/api/graph`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `SELECT (COUNT(?c) AS ?n) WHERE { ?c a ${type} }` }),
      });
      const b = await r.json();
      return { status: r.status, code: b.code, n: Number(b.rows?.[0]?.n ?? -1), error: b.error };
    };

    // ⭐ ANTI-VACUITY FIRST. "0 vs 0" would prove nothing at all — the trap is
    // only a trap because the RIGHT query returns rows on the same board.
    const creative = await ask('schema:CreativeWork');
    assert.equal(creative.status, 200, `the control query must ANSWER, got ${creative.status} ${creative.error}`);
    assert.ok(creative.n > 0, `the control query must return rows, got ${creative.n} — otherwise the fixture is empty and this test is meaningless`);

    // ⭐⭐⭐ #962 HAS LANDED, AND THIS IS THE ASSERTION #1104 ASKED FOR IN ADVANCE.
    //
    // The history is the point and is kept: this test once asserted `scrum:Card`
    // returns 0 ROWS — the SILENT failure this card was filed about. #1104 replaced
    // that with a LOUD refusal, a 400 naming the unknown term. Both were true of a
    // graph where the alias did not exist. #1104's own comment left the instruction:
    // "if some future change makes scrum:Card a real class, THIS assertion fails too
    // ... correct the description in the same commit." THIS is that commit.
    //
    // ⛔ THE HAZARD IS RETIRED, NOT MITIGATED: the guessable name now ANSWERS.
    // The #1104 guard still protects every OTHER unminted term — `scrum:Card` is
    // declared in GRAPH_VOCABULARY because it is emitted, and the undeclared-terms
    // reconciliation at the foot of graph-replica.mjs is what keeps those in step.
    const alias = await ask('scrum:Card');
    assert.equal(alias.status, 200,
      `\`?c a scrum:Card\` returned ${alias.status} — #962 has landed, so the guessable `
      + `name must ANSWER rather than be refused. Got ${JSON.stringify(alias.error ?? null).slice(0, 160)}`);
    assert.equal(alias.n, creative.n,
      `the guessable type must match EVERY card, not some — got ${alias.n} vs ${creative.n}`);

    // ⭐ AND THE OTHER HALF: the stored document is unchanged.
    const load = await (await fetch(`${pair.rest.baseUrl}/api/load`)).json();
    const types = new Set((load.cards || []).map((c) => JSON.stringify(c['@type'] ?? null)));
    assert.equal(types.has('"scrum:Card"'), false,
      'the STORED document must not carry the alias — this build is projection-only, '
      + 'and if that changed, the description is now wrong');
  } finally { await pair.stop(); }
});
