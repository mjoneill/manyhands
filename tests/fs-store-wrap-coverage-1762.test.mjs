/**
 * #1152 recorder coverage — every name a runtime module imports BY NAME from `node:fs` / `node:fs/promises` must be a named export of the recording wrapper.
 *
 * Why this is a gate and not a nicety: the wrapper declares its exports explicitly (an `export *` would hide the wrap from exactly the named-import form).
 * The price is that a new named import is a SyntaxError under the recorder at boot, in a test that does not name the import as its subject (found when
 * `chmodSync` was added to core/cursors.mjs and the fs-recorder rows could no longer start the server). Reaching for the default export instead would
 * make the call invisible to the recorder, which is the false green the wrapper exists to prevent. So the list is held here, against the source tree.
 *
 * Population: the tracked runtime sources (not tests/, scripts/, tools/, docs/, agents/, graph-executor/): the files the recorded server can load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as wrapFs from './helpers/fs-store-wrap.mjs';
import * as wrapPromises from './helpers/fs-store-wrap-promises.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](?:node:)?(fs|fs\/promises)['"]/g;

/** names imported by name, per module specifier: { fs: Set, 'fs/promises': Set } */
export function namedFsImports(source) {
  const out = { fs: new Set(), 'fs/promises': new Set() };
  for (const m of source.matchAll(IMPORT)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) out[m[2]].add(name);
    }
  }
  return out;
}
export function missingFromWrapper(source, exportsFs, exportsPromises) {
  const got = namedFsImports(source);
  return [
    ...[...got.fs].filter((n) => !(n in exportsFs)).map((n) => `node:fs ${n}`),
    ...[...got['fs/promises']].filter((n) => !(n in exportsPromises)).map((n) => `node:fs/promises ${n}`),
  ];
}

const runtimeSources = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(mjs|js|cjs)$/.test(f) && !/^(tests|scripts|tools|docs|agents|graph-executor)\//.test(f));

test('#1152 coverage CONTROL — the detector sees a missing name, a name from the promises face, an aliased and a multi-line import, and passes a covered one', () => {
  const src = `import { readFileSync, chmodSync as chmod,\n  notAFsThing } from 'node:fs';\nimport fs, { stat, noSuchPromise } from 'node:fs/promises';\nimport { statSync } from 'fs';`;
  const missing = missingFromWrapper(src, { readFileSync: 1, statSync: 1 }, { stat: 1 });
  assert.deepEqual(missing.sort(), ['node:fs chmodSync', 'node:fs notAFsThing', 'node:fs/promises noSuchPromise'].sort(), 'the aliased name is judged by its ORIGINAL name; the multi-line import is read; the covered ones pass');
});

test('#1152 coverage CONTROL — the scan reads real imports (the population is not empty, and a known named import is in it)', () => {
  const files = runtimeSources();
  assert.ok(files.length > 20, `PRECONDITION: the runtime source set is not empty (got ${files.length})`);
  const eventLog = namedFsImports(fs.readFileSync(path.join(ROOT, 'core', 'event-log.mjs'), 'utf8'));
  assert.ok(eventLog.fs.has('appendFileSync'), 'core/event-log.mjs imports appendFileSync by name: the detector must see it');
});

test('#1152 coverage — every name a runtime module imports by name from node:fs / node:fs/promises is a named export of the recording wrapper', () => {
  const problems = [];
  for (const f of runtimeSources()) {
    const miss = missingFromWrapper(fs.readFileSync(path.join(ROOT, f), 'utf8'), wrapFs, wrapPromises);
    if (miss.length) problems.push(`${f}: ${miss.join(', ')}`);
  }
  assert.deepEqual(problems, [], 'add `export const <name> = wrap(real.<name>)` (and the name to `patched`) in tests/helpers/fs-store-wrap.mjs for path-taking calls; never route the call through the default export, which the recorder cannot see');
});
