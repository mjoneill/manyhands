/**
 * #831 RELEASE CONDITION 0b — RUN THE DIRECTION THAT CAN FALSIFY YOU.
 *
 * The card's rule: "Each direction is BLIND to one failure by construction, not
 * by oversight. Name which blindness you accept." Precedent: a link-integrity
 * check run links→files reported "every entry kept" and could not, even in
 * principle, see a DELETED entry. The forward direction only confirms.
 *
 * ⚠️ THE BLINDNESS IN THE RC0a AUDITOR, STATED PLAINLY:
 *
 *   Its probe list is HAND-WRITTEN. So it can only find disagreements among
 *   fields someone already thought of. A field nobody thought of is not
 *   reported as a gap — it is reported as nothing at all, and the audit comes
 *   back clean. That is the confirming direction wearing a green tick.
 *
 * This file runs the other direction: enumerate the field universe from
 * artifacts NOT under the probe author's control, then assert the probe list
 * covers it. A field in either enumeration with no probe is a hole in the
 * audit, and the audit must fail rather than quietly not look.
 *
 *   schema → consumer   what is DECLARED but never stored  (the usual direction)
 *   consumer → schema   what is STORED but never declared  (the skipped one)
 *
 * Both counts appear in the output, per RC0b.
 *
 * ⚠️ Enumeration 2 reads the LIVE board when it is reachable, because that is
 * the only source that can surface a field written by some path nobody
 * remembers. It degrades to the fixture board when it is not, and SAYS SO —
 * a coverage check that silently shrinks its own universe when the interesting
 * source is unavailable is worse than one that fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRestServer } from './helpers/harness.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Keys the SERVER assigns. A caller cannot meaningfully probe these, so they
 * are excluded from the coverage universe — but the exclusion list is written
 * out rather than filtered inline, because an over-broad exclusion is how a
 * coverage check quietly stops covering things.
 */
const SERVER_ASSIGNED = new Set([
  'shortId',      // minted by the server from nextShortId
  'createdAt',    // stamped at create
  'updatedAt',    // stamped on every write
  'claimedBy',    // set only via the claim endpoint, never a card write
  'claimedAt',    // ditto
  'ignoredFields', // the diagnostic itself, not a stored field
]);

/** Meta keys that travel WITH a write but are not fields OF the card. */
const WRITE_META = new Set(['by']);

/** Enumeration 1 — every key declared in the MCP card tool schemas. */
function declaredInMcpSchemas() {
  const src = fs.readFileSync(path.join(REPO, 'mcp-server.mjs'), 'utf8');
  const out = new Map();
  for (const tool of ['card_create', 'card_update']) {
    const start = src.indexOf(`mcp.registerTool('${tool}'`);
    assert.notEqual(start, -1, `could not locate ${tool} in mcp-server.mjs — the extractor is stale`);
    const shapeAt = src.indexOf('inputSchema: {', start);
    assert.notEqual(shapeAt, -1, `no inputSchema for ${tool}`);
    let depth = 0, end = -1;
    for (let i = src.indexOf('{', shapeAt + 13); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    assert.notEqual(end, -1, `unbalanced braces walking ${tool}'s inputSchema`);
    const keys = [...src.slice(shapeAt, end).matchAll(/^ {6}([a-zA-Z_][a-zA-Z0-9_]*):/gm)].map((m) => m[1]);
    // ⚠️ A zero-key extraction means the source shape changed, not that the
    // tool declares nothing. Saturation in the other direction.
    assert.ok(keys.length > 0, `extracted 0 keys from ${tool} — the extractor broke, this is not a finding`);
    out.set(tool, keys);
  }
  return out;
}

/** Enumeration 2 — every key actually present on stored cards. */
async function storedOnRealCards(fallbackUrl) {
  const LIVE = 'http://127.0.0.1:3141/api/cards';
  for (const [url, source] of [[LIVE, 'LIVE board'], [`${fallbackUrl}/api/cards`, 'fixture board']]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const cards = await res.json();
      if (!Array.isArray(cards) || cards.length === 0) continue;
      const counts = new Map();
      for (const c of cards) for (const k of Object.keys(c)) counts.set(k, (counts.get(k) ?? 0) + 1);
      return { source, cardCount: cards.length, counts };
    } catch { /* try the next source */ }
  }
  return null;
}

test('#831 RC0b — every caller-settable field in the universe has a probe', async () => {
  const server = await startRestServer();
  let declared, stored;
  try {
    declared = declaredInMcpSchemas();
    stored = await storedOnRealCards(server.baseUrl);
  } finally {
    await server.stop();
  }
  // ⛔ #866 — THIS TEST ONLY EVER PASSED BECAUSE A PRODUCTION BOARD WAS RUNNING
  // ON THE SAME MACHINE. `makeBoardFixture()` returns `cards: []`, so the fixture
  // source always fell through and the LIVE board at :3141 answered every green
  // run this test has ever had. CI has no live board, and the first CI run failed
  // here — correctly.
  //
  // ⚠️ The stored side cannot be faked. Seeding a fixture from the MCP schema
  // would make `declared` and `stored` identical BY CONSTRUCTION, and the
  // "declared but never stored" direction could never fail again. And a fresh
  // fixture cannot carry the fields this direction exists to find: keys that sit
  // on OLD cards from before the schema tightened. The stored side is inherently
  // a measurement of history.
  //
  // ⇒ So the test now runs in two modes and SAYS WHICH. The declared-side
  //   coverage — the part that does not need a board — runs always. The stored
  //   side is reported as UNMEASURED when no board answered, never as clean.
  //   An unmeasurable direction must not be named agreement.
  const MODE = stored ? 'FULL (declared ∪ stored)' : 'PARTIAL — stored side UNMEASURED';
  if (!stored) {
    console.log(
      '\n⚠️  #831 RC0b running in PARTIAL mode: no board answered on :3141 and the\n'
      + '    fixture board is empty, so keys present on real cards could not be read.\n'
      + '    The declared-side universe is still checked. The stored-side directions\n'
      + '    (declared-but-never-stored, stored-but-never-declared) are NOT checked\n'
      + '    and are NOT clean — they are unmeasured. Run with a board to close them.\n',
    );
  }

  const { PROBED_FIELDS } = await import('../tools/field-probes.mjs');

  const declaredAll = new Set([...declared.values()].flat());
  const storedAll = new Set(stored ? stored.counts.keys() : []);

  const universe = [...new Set([...declaredAll, ...storedAll])]
    .filter((k) => !SERVER_ASSIGNED.has(k) && !WRITE_META.has(k))
    .sort();

  // ── the two directions, counted separately (RC0b requires both) ──
  // ⚠️ #866 — both of these directions REQUIRE the stored side. With no board they
  // are not empty-because-clean, they are empty-because-unread, and the report
  // below must say so rather than printing "none".
  const declaredNotStored = stored
    ? [...declaredAll].filter((k) => !storedAll.has(k)).sort() : null;
  const storedNotDeclared = stored
    ? [...storedAll].filter((k) => !declaredAll.has(k) && !SERVER_ASSIGNED.has(k)).sort() : null;
  const uncovered = universe.filter((k) => !PROBED_FIELDS.has(k));

  console.log(
    `\n#831 RC0b coverage — universe assembled from artifacts, not from memory\n`
    + `  MODE                  : ${MODE}\n`
    + `  source of stored keys : ${stored ? `${stored.source} (${stored.cardCount} cards)` : 'NONE — unmeasured'}\n`
    + `  declared in MCP schema: ${declaredAll.size}\n`
    + `  present on stored cards: ${storedAll.size}\n`
    + `  caller-settable universe: ${universe.length}\n`
    + `  probes written          : ${PROBED_FIELDS.size}\n`
    + `  ── schema → consumer ── declared but never stored (${declaredNotStored ? declaredNotStored.length : '?'}): `
    + `${declaredNotStored ? (declaredNotStored.join(', ') || 'none') : 'UNMEASURED'}\n`
    + `  ── consumer → schema ── stored but never declared (${storedNotDeclared ? storedNotDeclared.length : '?'}): `
    + `${storedNotDeclared ? (storedNotDeclared.join(', ') || 'none') : 'UNMEASURED'}\n`
    + `  ── UNCOVERED BY ANY PROBE (${uncovered.length}): ${uncovered.join(', ') || 'none'}\n`,
  );

  assert.deepEqual(
    uncovered, [],
    `${uncovered.length} field(s) in the universe have no probe, so the audit cannot see them:\n`
    + uncovered.map((k) => `  - ${k}`).join('\n')
    + '\n\nAdd a probe to tools/field-probes.mjs, or add the field to SERVER_ASSIGNED '
    + 'with a reason. Silently narrowing the universe is the failure this condition exists to prevent.',
  );
});
