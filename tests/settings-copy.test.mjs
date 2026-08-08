/**
 * #711 regression — the operator-facing TokenRing copy must assert the geometry
 * the code actually implements.
 *
 * WHY THIS IS NOT A PHRASE MATCHER (#711's own lesson, learned twice).
 *
 * `0046661` fixed the false fallback claim at the TokenRing radio (:105) and left
 * the same proposition, in different words, seventeen lines below it (:122). A grep
 * for the fixed wording came back clean because the two lines share no phrasing —
 * which is the failure mode, not an accident of it.
 *
 * The obvious guard is a regex over the known-bad phrasings. That guard was written,
 * and it fails the same way: given `/behaves?\s+like\s+soft/i`, the string "behaves
 * the way Soft does" passes clean. Two function words. A writer smoothing that
 * sentence for readability clears the guard by accident AND receives a green suite
 * as confirmation they did not reintroduce the falsehood — which is worse than no
 * guard, because it manufactures assurance at the exact moment of the mistake.
 *
 * A proposition can shed its wording for free. So this file is keyed to two things
 * a false claim CANNOT shed:
 *
 *   1. WHERE IT LIVES.  The surface is selected structurally — the token-ring radio
 *      label and the #token-ring-fields fieldset — not by searching for words. Copy
 *      cannot leave the panel the operator is reading while remaining the copy the
 *      operator is reading.
 *   2. THE EXACT BYTES.  The surface is content-locked by digest. Any edit at all —
 *      a rewording, an addition, a "clarification" — fails until a human re-verifies
 *      the new text against broadcastTokenRing and re-pins it. Rewording is the
 *      bypass, so rewording is what has to trip the wire.
 *
 * Test 1 says the true propositions are PRESENT (diagnostic: names which one went
 * missing). Test 2 says nothing else changed (catches a falsehood ADDED alongside
 * the true ones, which presence-checking alone cannot see).
 *
 * ⚠️ Scope, stated so it is not over-read: this covers settings.html's operator copy.
 * The same proposition also lives in source comments — #721 found it in
 * mcp-server.mjs:838, the first instance outside this file. A copy-surface test does
 * not reach those and is not evidence about them.
 *
 * Ground truth for every proposition below is broadcastTokenRing in mcp-server.mjs:
 *   nSeats === 0 && !tokenRingArmed  → broadcastFanout: everyone, immediately.
 *                                      That is Off's geometry. Soft is "one seat now,
 *                                      the rest after a random delay" — a different
 *                                      behaviour, and the geometry is exactly what the
 *                                      operator is choosing between.
 *   nSeats === 0 &&  tokenRingArmed  → return 0. Delivery stops. The room IS silenced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_HTML = path.join(PROJECT_DIR, 'settings.html');

/**
 * The operator-visible TokenRing surface, selected by STRUCTURE.
 *
 * Two regions: the radio label the operator clicks, and the timings fieldset that is
 * open while they configure it. Both are located by markup identity (`data-mode` and
 * the fieldset id), never by the words inside them — a false claim can rewrite its
 * sentence but cannot rewrite which panel it is displayed in.
 *
 * Throws rather than returning empty if a region is missing: a selector that silently
 * matches nothing is how a guard passes vacuously, and this file exists because of a
 * guard that passed when it should not have.
 */
function tokenRingSurface(html) {
  const regions = [];

  const label = html.match(/<label\s+data-mode="token-ring"[\s\S]*?<\/label>/i);
  if (!label) {
    throw new Error('token-ring radio label not found — the selector is stale, not the page clean');
  }
  regions.push(label[0]);

  const fieldset = html.match(/<fieldset\s+id="token-ring-fields"[\s\S]*?<\/fieldset>/i);
  if (!fieldset) {
    throw new Error('#token-ring-fields not found — the selector is stale, not the page clean');
  }
  regions.push(fieldset[0]);

  // Visible text only: drop tags, collapse whitespace. Attribute values and markup
  // churn (a class rename, a style tweak) must not trip the content lock — only what
  // the operator actually reads.
  return regions
    .map((r) => r.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .join('\n');
}

/**
 * The propositions the copy must assert, each traced to the branch that makes it true.
 * `witness` is a token the claim cannot drop while still making the claim — not an
 * attempt to recognise paraphrases. If a rewrite loses the witness, that is a real
 * signal: the sentence no longer says this, and someone must re-verify it.
 */
const REQUIRED = [
  {
    id: 'pre-registration geometry is Off\'s, not Soft\'s',
    why: 'nSeats === 0 && !tokenRingArmed → broadcastFanout: everyone immediately',
    witness: /Off's geometry/i,
  },
  {
    id: 'an armed, empty ring HOLDS — delivery stops',
    why: 'nSeats === 0 && tokenRingArmed → return 0; the room is silenced, deliberately',
    witness: /HOLDS/,
  },
  {
    id: 'the hold is named as a stop, not a slowdown',
    why: 'return 0 is zero deliveries, not a delayed fan-out — the operator must not read it as latency',
    witness: /delivery stops rather than fanning out/i,
  },
];

/**
 * Digest of the surface above, pinned deliberately.
 *
 * TO UPDATE: read the new copy against broadcastTokenRing in mcp-server.mjs, confirm
 * every claim in it is true of the code, then paste the digest the failure prints.
 * Re-pinning without that read is the only way this guard fails, and it is a choice
 * someone has to make on purpose rather than a wording it can slip past.
 *
 * Pinned 2026-08-06 against 74cbeca (the :122 correction), verified by a second seat
 * against broadcastTokenRing the same day.
 */
const PINNED_DIGEST = '79b685245587c42661c2bdb766444c9df2aea85fc73fca4053d049e1ddd1f742';

test('#711: the TokenRing copy asserts every proposition the code implements', () => {
  const surface = tokenRingSurface(fs.readFileSync(SETTINGS_HTML, 'utf8'));

  assert.ok(surface.length > 0, 'token-ring surface extracted as empty — detector broken, not page clean');

  for (const { id, why, witness } of REQUIRED) {
    assert.ok(
      witness.test(surface),
      `TokenRing copy no longer asserts: ${id}\n` +
        `  ground truth: ${why}\n` +
        `  looked for:   ${witness}\n` +
        `  surface was:  ${surface}\n` +
        `  ⇒ the copy was reworded and dropped a true claim, or the claim was replaced ` +
        `with a false one. Re-verify against broadcastTokenRing before changing this test.`
    );
  }
});

test('#711: the TokenRing copy is content-locked — any edit needs a human re-verify', () => {
  const surface = tokenRingSurface(fs.readFileSync(SETTINGS_HTML, 'utf8'));
  const digest = crypto.createHash('sha256').update(surface, 'utf8').digest('hex');

  assert.equal(
    digest,
    PINNED_DIGEST,
    `TokenRing operator copy changed.\n\n` +
      `This is not a failure by itself — it is the re-verification gate. A safety claim ` +
      `about delivery geometry cannot be edited silently, because the last two times it ` +
      `was, it came back false in new words and every test stayed green.\n\n` +
      `  1. Read the new copy against broadcastTokenRing in mcp-server.mjs\n` +
      `  2. Confirm each claim is true of the branch it describes\n` +
      `  3. Re-pin PINNED_DIGEST to: ${digest}\n\n` +
      `Current surface:\n${surface}\n`
  );
});
