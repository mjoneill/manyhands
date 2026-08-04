/**
 * #670 half 2 — controls for the suite subscription.
 *
 * Exercised whole against fixture repos (the stub-harness rule): a green
 * universe is silent and clears state; a red universe posts once (DRYRUN);
 * the same red is muted inside the cooldown; a NEW failing file is a new
 * signature and fires through the mute. Sandboxed state + repo per test —
 * a positive control for an alarm must never touch the live one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = path.join(ROOT, 'scripts', 'suite-watch.mjs');

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

function makeUniverse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw670-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'run-tests.sh'), path.join(dir, 'scripts', 'run-tests.sh'));
  fs.chmodSync(path.join(dir, 'scripts', 'run-tests.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'tests', 'green.test.mjs'),
    'import { test } from "node:test"; test("g", () => {});\n');
  return { dir, state: path.join(dir, 'watch.state') };
}

function goRed(dir, name = 'red.test.mjs') {
  fs.writeFileSync(path.join(dir, 'tests', name),
    'import { test } from "node:test"; import a from "node:assert/strict"; test("r", () => a.equal(1, 2));\n');
}

async function tick({ dir, state }) {
  // NO_CLONE: fixture universes aren't git repos; the clone isolation is
  // covered by the live deployment, the logic under test here is the alarm's.
  const { stdout } = await run(process.execPath, [WATCH], {
    env: cleanEnv({
      SUITE_WATCH_REPO: dir, SUITE_WATCH_STATE: state,
      SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1',
    }),
  });
  return stdout;
}

const posted = (out) => /DRYRUN would post/.test(out);

test('green universe: silent, and state is cleared', async () => {
  const u = makeUniverse();
  const out = await tick(u);
  assert.equal(posted(out), false, 'green must not post');
  assert.match(out, /suite green — silent/);
  assert.deepEqual(JSON.parse(fs.readFileSync(u.state, 'utf8')).sigTimes, {});
});

test('red posts once, repeat red is muted, recovery clears, next red is news again', async () => {
  const u = makeUniverse();
  goRed(u.dir);
  const first = await tick(u);
  assert.equal(posted(first), true, 'fresh red must post');
  assert.match(first, /red\.test\.mjs/, 'the post names the failing file');
  assert.equal(posted(await tick(u)), false, 'same red inside cooldown is muted');

  fs.rmSync(path.join(u.dir, 'tests', 'red.test.mjs')); // recovery
  assert.equal(posted(await tick(u)), false, 'recovery is silent');
  goRed(u.dir);
  assert.equal(posted(await tick(u)), true, 'post-recovery red is a fresh signature');
});

test('a flake — red in the full run, green in isolation — is logged, never posted', async () => {
  // Reproduces the day's three hand-triages mechanically: the fixture fails
  // on its first execution (no marker) and passes on the isolated re-run
  // (marker present) — exactly the shape of a parallel-load flake.
  const u = makeUniverse();
  fs.writeFileSync(path.join(u.dir, 'tests', 'flaky.test.mjs'), `
    import fs from 'node:fs';
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    const marker = new URL('./flake.marker', import.meta.url);
    test('flaky once', () => {
      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'x'); assert.fail('first-run flake'); }
    });
  `);
  const out = await tick(u);
  assert.equal(posted(out), false, 'a flake must not alarm the room');
  assert.match(out, /did NOT survive isolation — flake, silent/, 'the flake is logged with its files');
});

test('a NEW failing file is a new signature and fires through the mute', async () => {
  const u = makeUniverse();
  goRed(u.dir, 'red-a.test.mjs');
  assert.equal(posted(await tick(u)), true, 'first red fires');
  goRed(u.dir, 'red-b.test.mjs'); // deepens: now two failing files
  const out = await tick(u);
  assert.equal(posted(out), true, 'a deeper red must fire through the standing mute');
  assert.match(out, /red-b\.test\.mjs/, 'the new file is named');
});
