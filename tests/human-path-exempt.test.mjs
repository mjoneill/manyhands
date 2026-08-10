/**
 * #755 — THE HUMAN PATH IS EXEMPT BY CONSTRUCTION, asserted as a PROPERTY.
 *
 * ── THE DEFECT THIS CLOSES, found before it fired ───────────────────────────
 * `tests/work-gate.test.mjs` has asserted since slice 2b:
 *
 *     assert.equal(serverSrc.includes('work-gate'), false)
 *
 * ⚠️ That is keyed to a NAME. The property it exists to protect is "the owner's
 * requests never reach a refusal path." Those coincided while there was exactly
 * one refusal-capable rail. Branch E adds a second — `core/claim-throttle.mjs` —
 * and the moment it exists, wiring it into server.js leaves that assertion
 * GREEN while the property is gone.
 *
 * ⇒ Fourth instance in one day of a check matching a SURFACE rather than the
 *   property it claims to measure, and this one was the guard on the guard.
 *
 * ── WHY THE PROPERTY MATTERS MORE THAN ANY ONE RAIL ─────────────────────────
 * The board UI posts to server.js:3141; only agents arrive via mcp-server.mjs.
 * So a refusal that lives only in MCP cannot reach the owner AT ALL — there is
 * no `if (actor === null) allow` to invert, misread, or refactor away.
 *
 * ⚠️ Move any refusal into server.js and that single line becomes the only
 * thing between the owner and being refused in his own board. 375 of 500 cards
 * carry `createdBy: null` — every one of them his. The exemption must not
 * depend on a branch someone can delete without knowing why it is there.
 *
 * ── KEYED TO ABSENCE, SO IT CAN ACTUALLY FAIL ───────────────────────────────
 * ⭐ The set of refusal-capable modules is COMPUTED from core/, not listed here.
 * A new rail that can say no is discovered automatically and must then be
 * deliberately excluded to pass — which is the moment somebody looks.
 *
 * A hand-written list would have the same defect as the assertion it replaces:
 * it would go stale silently, and the next rail would be the one it missed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CORE_DIR = fileURLToPath(new URL('../core/', import.meta.url));

/**
 * A module is REFUSAL-CAPABLE if it can return a denial. Detected by the shapes
 * this codebase actually uses for one: `allow: false` and `refused: true`.
 *
 * ⚠️ Deliberately over-broad. A false positive costs one line in the exclusion
 * list and a moment's thought; a false negative is the defect this file exists
 * to prevent.
 */
function refusalCapableModules() {
  return readdirSync(CORE_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /allow:\s*false|refused:\s*true/.test(readFileSync(CORE_DIR + f, 'utf8')));
}

test('#755 ⭐⭐ SERVER.JS REFERENCES NO REFUSAL-CAPABLE MODULE — the property, not a name', () => {
  const serverSrc = read('../server.js');
  const capable = refusalCapableModules();

  // Sanity: if this ever finds nothing, the detector broke and the test below
  // would pass vacuously — the exact false-zero that shipped in race-corpus
  // earlier today. A rail that cannot fail is not a rail.
  assert.ok(capable.length > 0, 'no refusal-capable core module found — the detector is broken, not the code');

  for (const mod of capable) {
    const base = mod.replace(/\.mjs$/, '');
    assert.equal(
      serverSrc.includes(base),
      false,
      `server.js references core/${mod} — the human path is no longer exempt BY CONSTRUCTION. `
      + 'The owner reaches server.js on every browser request; a refusal there is guarded only by a '
      + 'runtime actor check that a refactor can remove. Move it to mcp-server.mjs, or delete this '
      + 'test deliberately and say why on #755.',
    );
  }
});

test('#755 the detector actually SEES the modules it is meant to police', () => {
  // Names the current members so a future reader can tell whether the set is
  // plausible, rather than trusting a count. A count is a pointer.
  const capable = refusalCapableModules();
  assert.ok(capable.includes('work-gate.mjs'), `work-gate.mjs not detected as refusal-capable; found: ${capable.join(', ')}`);
  assert.ok(capable.includes('claim-throttle.mjs'), `claim-throttle.mjs not detected as refusal-capable; found: ${capable.join(', ')}`);
});

test('#755 the narrow original assertion still holds too', () => {
  // Kept rather than replaced. It is still true, it is cheap, and it names the
  // specific rail that motivated the property in the first place.
  const serverSrc = read('../server.js');
  assert.equal(serverSrc.includes('work-gate'), false);
  assert.equal(serverSrc.includes('decideCoveredAction'), false);
});

test('#755 ⚠️ and the MCP server is where refusals ARE allowed to live', () => {
  // The mirror of the property: this is not "no refusals anywhere", it is
  // "refusals live only where the owner cannot arrive". If mcp-server stopped
  // carrying the gate, the rail would be gone and every assertion above would
  // still pass — so the positive half is asserted too.
  const mcpSrc = read('../mcp-server.mjs');
  assert.match(mcpSrc, /core\/work-gate\.mjs/, 'the gate is no longer wired into mcp-server — the rail is gone, not merely relocated');
});
