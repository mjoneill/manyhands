/**
 * #1138 — the restart plan is computed from the import closure of each server
 * entry point, never from a hand-written list. These are the card's acceptance
 * conditions plus a control against the real tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importClosure, restartPlan, MANIFESTS } from '../scripts/deploy-restart-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A tiny fake tree: two entry points sharing one core module, a root module
// only MCP loads, a dynamic import, and a static page nothing imports.
const FIXTURE = {
  'server.js': "import { a } from './core/shared.mjs';\nimport x from './core/rest-only.mjs';\n",
  'mcp-server.mjs': "import { a } from './core/shared.mjs';\nimport { w } from './whisper.mjs';\nconst lazy = await import('./core/lazy.mjs');\n",
  'core/shared.mjs': "import { deep } from './deep/leaf.mjs';\nexport const a = 1;\n",
  'core/deep/leaf.mjs': "import fs from 'node:fs';\nexport const deep = 1;\n",
  'core/rest-only.mjs': 'export default 1;\n',
  'core/lazy.mjs': 'export const l = 1;\n',
  'whisper.mjs': 'export const w = 1;\n',
  'index.html': '<html></html>',
  'tests/x.test.mjs': "import { a } from '../core/shared.mjs';\n",
};
const read = (rel) => (Object.hasOwn(FIXTURE, rel) ? FIXTURE[rel] : null);

test('#1138 the closure follows static AND dynamic relative imports, transitively, and ignores node: builtins', () => {
  assert.deepEqual([...importClosure('mcp-server.mjs', read)].sort(),
    ['core/deep/leaf.mjs', 'core/lazy.mjs', 'core/shared.mjs', 'mcp-server.mjs', 'whisper.mjs']);
  assert.deepEqual([...importClosure('server.js', read)].sort(),
    ['core/deep/leaf.mjs', 'core/rest-only.mjs', 'core/shared.mjs', 'server.js']);
});

test('#1138 a tests-only diff restarts NOTHING, and says so', () => {
  const p = restartPlan({ changed: ['tests/x.test.mjs', 'tools/probe.mjs', 'docs/a.md'], readFile: read });
  assert.deepEqual(p, { rest: false, mcp: false, reason: { rest: null, mcp: null }, unknown: false });
});

test('#1138 mcp-server.mjs → MCP only; server.js → REST only; a shared core module → both; a root module only MCP loads → MCP only', () => {
  assert.deepEqual([restartPlan({ changed: ['mcp-server.mjs'], readFile: read })].map((p) => [p.rest, p.mcp])[0], [false, true]);
  assert.deepEqual([restartPlan({ changed: ['server.js'], readFile: read })].map((p) => [p.rest, p.mcp])[0], [true, false]);
  const both = restartPlan({ changed: ['core/deep/leaf.mjs'], readFile: read });
  assert.deepEqual([both.rest, both.mcp, both.reason.rest, both.reason.mcp], [true, true, 'core/deep/leaf.mjs', 'core/deep/leaf.mjs']);
  assert.deepEqual([restartPlan({ changed: ['whisper.mjs'], readFile: read })].map((p) => [p.rest, p.mcp])[0], [false, true]);
  const lazy = restartPlan({ changed: ['core/lazy.mjs'], readFile: read });
  assert.deepEqual([lazy.rest, lazy.mcp], [false, true], 'a dynamically imported module counts');
});

test('#1138 a static page served per request restarts nothing; a package manifest restarts both', () => {
  assert.deepEqual([restartPlan({ changed: ['index.html', 'core/theme.css'], readFile: read })].map((p) => [p.rest, p.mcp])[0], [false, false]);
  for (const m of MANIFESTS) {
    const p = restartPlan({ changed: [m], readFile: read });
    assert.deepEqual([p.rest, p.mcp, p.reason.rest], [true, true, m]);
  }
});

test('#1138 ⛔ NEGATIVE CONTROL — an UNKNOWN previous sha restarts BOTH: no inputs must not read as "nothing changed"', () => {
  const p = restartPlan({ changed: null, readFile: read });
  assert.equal(p.unknown, true);
  assert.deepEqual([p.rest, p.mcp], [true, true]);
  assert.match(p.reason.mcp, /unknown/);
});

test('#1138 CONTROL against the real tree — the MCP closure holds its known modules and no test file', () => {
  const readReal = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };
  const mcp = importClosure('mcp-server.mjs', readReal);
  const rest = importClosure('server.js', readReal);
  assert.ok(mcp.has('core/seat-binding.mjs') && mcp.has('whisper-store.mjs'), 'mcp closure carries its real imports');
  assert.ok(rest.has('core/event-log.mjs') && rest.has('core/store.mjs'), 'rest closure carries its real imports');
  assert.ok(![...mcp, ...rest].some((p) => p.startsWith('tests/')), 'no server loads a test');
  assert.ok(!rest.has('index.html') && !mcp.has('index.html'), 'the pages are served, not imported');
  // Today's four deploys, replayed against the real closure (the card's table).
  const plans = {
    '7ac421d': ['tests/acceptance-evidence.test.mjs', 'tests/helpers/versioned-patch.mjs', 'tools/field-triple.mjs'],
    'a35c8f5': ['tests/commons-e2e.test.mjs'],
    '9bc06bd': ['mcp-server.mjs', 'server.js', 'tests/array-upsert-verbs.test.mjs', 'tools/field-probes.mjs'],
    '250b6c1': ['commons.html', 'core/conversation-view.css', 'core/conversation-view.mjs', 'server.js', 'tests/commons-e2e.test.mjs'],
  };
  const out = Object.fromEntries(Object.entries(plans).map(([k, v]) => { const p = restartPlan({ changed: v, readFile: readReal }); return [k, [p.rest, p.mcp]]; }));
  assert.deepEqual(out, { '7ac421d': [false, false], 'a35c8f5': [false, false], '9bc06bd': [true, true], '250b6c1': [true, false] },
    'two of four restarts today were for nothing, and the fourth needed REST only');
});

// #1415 — a read that FAILS is not a read that found nothing. `gitReader` used
// to swallow every error as null, and importClosure reads null as "not a file
// in this tree", so an entry whose `git show` blew Node's 1 MiB maxBuffer
// (ENOBUFS — the #1414 mechanism) produced an EMPTY closure and a plan that
// said rest=0 for a change to server.js itself. server.js was 583 KB on
// 2026-09-18, growing ~16 KB/day.
import { gitReader } from '../scripts/deploy-restart-plan.mjs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('#1415 a reader that THROWS for the entry makes the plan UNKNOWN (both restart, the file named) — never a quiet rest=0', () => {
  const enobufs = (rel) => { if (rel === 'server.js') { const e = new Error('spawnSync git ENOBUFS'); e.code = 'ENOBUFS'; throw e; } return read(rel); };
  const p = restartPlan({ changed: ['server.js'], readFile: enobufs });
  assert.equal(p.unknown, true);
  assert.deepEqual([p.rest, p.mcp], [true, true]);
  assert.match(p.reason.rest, /server\.js/);
  assert.match(p.reason.rest, /ENOBUFS/);
});

test('#1415 GUARD — an import that is ABSENT (null) is still skipped, so a deleted module does not force a restart', () => {
  const absent = (rel) => (rel === 'core/lazy.mjs' ? null : read(rel));
  const p = restartPlan({ changed: ['core/lazy.mjs'], readFile: absent });
  assert.deepEqual([p.rest, p.mcp, p.unknown], [false, false, false]);
});

test('#1415 gitReader: a path NOT IN THE TREE is null; a read that fails for any other reason THROWS (a 1 KiB maxBuffer against the real server.js)', () => {
  const at = gitReader(ROOT, 'HEAD');
  assert.equal(at('core/this-module-does-not-exist.mjs'), null, 'absent in tree → null, as before');
  assert.ok(at('server.js').length > 100_000, 'the real entry reads whole with the raised buffer');
  const starved = gitReader(ROOT, 'HEAD', { maxBuffer: 1024 });
  assert.throws(() => starved('server.js'), (e) => e.code === 'ENOBUFS', 'the swallow is gone: ENOBUFS surfaces');
});

test('#1415 gitReader DEFAULT buffer reads a 2 MiB entry whole — the size server.js reaches in October (a throwaway repo, one commit)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drp-1415-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], { stdio: 'pipe' });
    g('init', '-q');
    const big = 'import { a } from \'./core/shared.mjs\';\n' + '// '.padEnd(80, 'x').concat('\n').repeat(26_000);   // > 2 MiB
    fs.writeFileSync(path.join(dir, 'server.js'), big);
    g('add', 'server.js'); g('commit', '-qm', 'big');
    assert.ok(big.length > 2 * 1024 * 1024, `fixture is ${big.length} bytes`);
    const text = gitReader(dir, 'HEAD')('server.js');
    assert.equal(text.length, big.length, 'read whole with the default buffer');
    assert.ok(importClosure('server.js', gitReader(dir, 'HEAD')).has('server.js'), 'the entry is in its own closure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
