/**
 * #1196 slice B — THE SEAM. Every tool must reach a route that EXISTS.
 *
 * ⛔ THIS FILE EXISTS BECAUSE THE PURE TESTS PASSED WHILE TWO OF THREE TOOLS
 * COULD NOT REACH THE BOARD AT ALL. The unit tests inject a fake `get`/`post`,
 * so they certify the executor's contract with the loop and never once look at
 * the path string. Seven sabotages and a green suite coexisted with a surface
 * that would have returned "error: 404" on its first live wake — and a model
 * that narrates over an empty result would have narrated over that too.
 *
 * The rule this encodes: test what CROSSES into the consumer, and make the
 * check GENERIC so it fails for the NEXT tool somebody adds with a wrong path.
 * Every entry in BOARD_TOOLS is driven against a REAL server here; nothing is
 * listed by hand, so a new tool is covered the moment it is declared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TOOLS, makeExecutor } from '../core/board-tools.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** The minimal valid arguments for each tool, by name. */
const ARGS = {
  card_get: { shortId: 1 },
  board_search: { q: 'anything', k: 2 },
  graph_query: { query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1' },
};

test('#1196B SEAM: every declared tool reaches a real route — no tool 404s', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await fetch(`${srv.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a card to read', by: 'ada' }),
    });
    assert.equal(c.status, 201);

    // The real transport: no fakes, no injected shapes, no path strings in the
    // test. Whatever the executor asks for is what the server is asked for.
    const seen = [];
    const call = async (method, path, body) => {
      const r = await fetch(`${srv.baseUrl}${path}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      seen.push({ method, path, status: r.status });
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      if (r.status === 404) {
        throw new Error(`route does not exist: ${method} ${path} → 404. `
          + 'A tool pointed at a missing route reaches the model as "error: 404" and gets narrated over.');
      }
      return parsed;
    };
    const exec = makeExecutor({
      get: (p) => call('GET', p),
      post: (p, b) => call('POST', p, b),
      by: 'ada',
    });

    const failures = [];
    for (const t of BOARD_TOOLS) {
      const name = t.function.name;
      const args = ARGS[name];
      assert.ok(args, `#1196B: tool ${name} has no arguments in this seam test — add them, or it ships untested against a real route`);
      try { await exec(name, args); }
      catch (e) { failures.push(`${name}: ${e.message}`); }
    }
    assert.deepEqual(failures, [], `tools that cannot reach the board:\n${failures.join('\n')}`);

    // And the actor travels: a search that logs a null actor cannot answer
    // "who asked this", which is the only question the search log is for.
    const searchCalls = seen.filter((s) => s.path.startsWith('/api/search'));
    assert.ok(searchCalls.length, 'the search tool must have hit /api/search');
  } finally { await srv.stop(); }
});
