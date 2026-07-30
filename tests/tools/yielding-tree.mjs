/**
 * #558 — build a server tree whose `handleSave` has ONE yield in its critical
 * section, and nothing else changed.
 *
 * This is the fault injection both halves of the #558 evidence depend on, so it
 * lives in one place: `tests/api-write-lock.test.mjs` uses it for the automated
 * RED/GREEN behavior test, and `tests/tools/interleave-probe.mjs --inject-yield`
 * uses it for the many-round positive control. Two copies would drift, and the
 * whole point of the pair is that they inject the SAME thing.
 *
 * Committed because @minimo caught the gap: the probe's header cited a 60/60
 * positive control while the only injector was private to the test file and
 * deleted its own temp copy. A receipt that cannot be re-run is a memory of a
 * receipt.
 *
 * Why the seam is where it is: `const existing = readBoard();` is the one line
 * present in BOTH the pre-fix and post-fix handleSave. Inserting the pause
 * immediately after it therefore lands OUTSIDE the lock on baseline and INSIDE
 * it on the fix — which is the entire difference the tests measure. Nothing
 * else in the tree is copied: everything but server.js is symlinked, so the
 * server under test is the real server.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The one line present in both baseline and fixed `handleSave`. */
export const SEAM = 'const existing = readBoard();';

/** Long enough to schedule a competing request inside it, short enough for a suite. */
export const DEFAULT_PAUSE_MS = 400;

/**
 * @param {string} serverDir  a checkout to mirror (its server.js is patched)
 * @param {{pauseMs?: number}} [opts]
 * @returns {{dir: string, pauseMs: number, cleanup: () => void}}
 */
export function makeYieldingTree(serverDir, { pauseMs = DEFAULT_PAUSE_MS } = {}) {
  const src = fs.readFileSync(path.join(serverDir, 'server.js'), 'utf8');

  const at = src.indexOf(SEAM);
  if (at === -1) {
    throw new Error(`could not find the read→write seam (${SEAM}) in ${serverDir}/server.js`);
  }
  if (src.indexOf(SEAM, at + 1) !== -1) {
    throw new Error('the seam anchor is not unique; the patch would be ambiguous');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-558-yield-'));
  for (const entry of fs.readdirSync(serverDir)) {
    if (entry === 'server.js' || entry === '.git') continue;
    fs.symlinkSync(path.join(serverDir, entry), path.join(dir, entry));
  }

  const cut = src.indexOf('\n', at) + 1;
  const patched = src.slice(0, cut)
    + `\n      // ── #558 FAULT INJECTION (test only): the one yield production\n`
    + `      // code does not have yet, and will the moment the store goes async.\n`
    + `      await new Promise((r) => setTimeout(r, ${pauseMs}));\n\n`
    + src.slice(cut);
  fs.writeFileSync(path.join(dir, 'server.js'), patched);

  return {
    dir,
    pauseMs,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
