/**
 * #868 — THE BOARD SERVER BOOTS WITH NO node_modules. The README promises it.
 *
 * README, Quickstart — the first command a stranger runs:
 *   "node server.js … That's it — no install step. The board server has no
 *    dependencies at all."
 *
 * ⛔ THAT WAS FALSE WHEN THIS TEST WAS WRITTEN. Measured in a clean room (a
 * directory with no `node_modules` at any ancestor, precondition asserted):
 *
 *   node server.js
 *   → Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'oxigraph'
 *     imported from <clean>/core/graph-replica.mjs
 *
 * A stranger's entire first experience of the project was an unhandled stack
 * trace under a heading that said there was nothing to install.
 *
 * ⚠️ WHY THIS TEST IS STRUCTURAL RATHER THAN A CLEAN-ROOM SIMULATION.
 * The obvious test — clone to a temp dir and run it — is the one that caught
 * this, but it is a bad regression test: it is slow, it needs network or a
 * working tree copy, and (measured, painfully) it passes for the wrong reason
 * whenever a `node_modules` exists ANYWHERE up-tree from the temp directory.
 * A test whose green depends on where the runner's temp files live is not a
 * test. So this asserts the PROPERTY that makes the clean room pass: nothing
 * reachable from server.js's static import graph is a bare package specifier.
 *
 * ⭐ It also catches the reintroduction, which the clean-room run cannot do
 * cheaply: a future contributor adding `import x from 'some-pkg'` to any module
 * server.js statically imports fails here in under a second, with the chain
 * that reintroduced it named.
 *
 * ⚠️ Deliberately NOT asserted: that mcp-server.mjs is dependency-free. It uses
 * the official MCP SDK and the README says so plainly — "this part does need one
 * install". The promise is about the BOARD, and the test is scoped to the claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every specifier in a module's STATIC import statements. */
function staticImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  // Static `import … from '…'` and side-effect `import '…'` only.
  // Dynamic `import('…')` is deliberately excluded: deferring a dependency to
  // first use is exactly the fix this test exists to protect.
  return [...src.matchAll(/^\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

const isRelative = (s) => s.startsWith('./') || s.startsWith('../');
const isBuiltin = (s) => s.startsWith('node:');

/**
 * Walk the static import graph from `entry`, returning every bare (npm)
 * specifier found and the chain that reached it.
 */
function bareSpecifiersReachableFrom(entry) {
  const found = [];
  const seen = new Set();

  const walk = (file, chain) => {
    const real = fs.realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);

    for (const spec of staticImports(real)) {
      if (isBuiltin(spec)) continue;
      if (!isRelative(spec)) {
        found.push({ spec, chain: [...chain, path.relative(PROJECT_DIR, real)] });
        continue;
      }
      const target = path.resolve(path.dirname(real), spec);
      if (fs.existsSync(target)) walk(target, [...chain, path.relative(PROJECT_DIR, real)]);
    }
  };

  walk(entry, []);
  return found;
}

test('#868 server.js boots with no npm dependencies — nothing in its static import graph is a bare specifier', () => {
  const entry = path.join(PROJECT_DIR, 'server.js');
  const bare = bareSpecifiersReachableFrom(entry);

  const detail = bare
    .map((b) => `    '${b.spec}'  via  ${b.chain.join(' → ')}`)
    .join('\n');

  assert.equal(
    bare.length, 0,
    'The README promises "no install step" for the board server. A bare specifier in\n'
    + 'server.js\'s STATIC import graph breaks `node server.js` on a fresh clone with\n'
    + `ERR_MODULE_NOT_FOUND before anything listens. Found ${bare.length}:\n${detail}\n\n`
    + '  Fix: make the import DYNAMIC at the point of use (await import(...)), so the\n'
    + '  dependency is required only by the feature that needs it — not by boot.\n',
  );
});

test('#868 the test can actually see a bare specifier — control', () => {
  // ⭐ Without this, a walker that silently returns nothing would make the test
  // above pass forever. mcp-server.mjs genuinely does import the MCP SDK, and
  // the README says so, which makes it the honest positive control.
  const bare = bareSpecifiersReachableFrom(path.join(PROJECT_DIR, 'mcp-server.mjs'));
  assert.ok(
    bare.length > 0,
    'control failed: the walker found no bare specifier in mcp-server.mjs, which is '
    + 'known to import the MCP SDK. The walker is broken, so the assertion above '
    + 'proves nothing.',
  );
});
