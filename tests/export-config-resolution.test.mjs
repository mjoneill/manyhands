/**
 * RED for the export-config resolution leak (B2 / W2 in the convergence sprint).
 *
 * export-wiki.mjs currently defaults its transform config to
 * join(HERE, 'EXPORT_TRANSFORMS.json') — HERE being where the CODE sits. That
 * default is correct only while code and data share a directory. The moment the
 * code runs from a clone (the whole point of running the published tree), the
 * CLI silently prefers the clone's EXAMPLE config over the instance's real one,
 * and the export "passes" its own scrub check against the wrong rule list.
 *
 * Contract pinned here: when SCRUM_BOARD_FILE is set and no --config is given,
 * the CLI must resolve EXPORT_TRANSFORMS.json from dirname(SCRUM_BOARD_FILE) —
 * the DATA root — never from the code directory. An explicit --config still
 * wins over everything.
 *
 * Every term below is synthetic (zephyrblatt/weather-widget); nothing in this
 * fixture exists in any real config.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, PROJECT_DIR } from './helpers/harness.mjs';

const CLI = path.join(PROJECT_DIR, 'export-wiki.mjs');

const SYNTH_NODE = {
  node: {
    identifier: 7,
    name: 'Synthetic wiki page',
    text: 'The zephyrblatt subsystem handles weather. zephyrblatt is beloved.',
    dateModified: '2026-07-26T00:00:00Z',
  },
  children: [],
  backlinks: [],
};

const DATA_ROOT_CONFIG = {
  rules: [{ find: 'zephyrblatt', replace: 'weather-widget', flags: 'g' }],
  forbidden: [{ pattern: 'zephyrblatt', flags: 'gi' }],
};

function makeDataRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-config-red-'));
  fs.writeFileSync(path.join(dir, 'board-data.json'), JSON.stringify({ nodes: [] }));
  fs.writeFileSync(
    path.join(dir, 'EXPORT_TRANSFORMS.json'),
    JSON.stringify(DATA_ROOT_CONFIG, null, 2),
  );
  return dir;
}

function startSyntheticApi() {
  return new Promise(async (resolve) => {
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/nodes/7') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(SYNTH_NODE));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: PROJECT_DIR,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('positive control: explicit --config applies the data-root rules end-to-end', async () => {
  const dataRoot = makeDataRoot();
  const { srv, port } = await startSyntheticApi();
  try {
    const out = path.join(dataRoot, 'explicit.html');
    const r = await runCli(
      ['7', '--out', out, '--config', path.join(dataRoot, 'EXPORT_TRANSFORMS.json')],
      { SCRUM_API: `http://127.0.0.1:${port}` },
    );
    assert.equal(r.code, 0, `CLI failed: ${r.stderr}`);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('weather-widget'), 'rule must have applied');
    assert.ok(!html.includes('zephyrblatt'), 'forbidden term must be gone');
  } finally {
    srv.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('no --config + SCRUM_BOARD_FILE set: transforms resolve from the DATA root, not the code dir', async () => {
  const dataRoot = makeDataRoot();
  const { srv, port } = await startSyntheticApi();
  try {
    const out = path.join(dataRoot, 'default.html');
    const r = await runCli(['7', '--out', out], {
      SCRUM_API: `http://127.0.0.1:${port}`,
      SCRUM_BOARD_FILE: path.join(dataRoot, 'board-data.json'),
    });
    assert.equal(r.code, 0, `CLI failed: ${r.stderr}`);
    const html = fs.readFileSync(out, 'utf8');
    // If the CLI read the CODE directory's config instead, the synthetic rule
    // never ran, the synthetic forbidden list never checked, and the term
    // below survives — which is exactly the leak, with a synthetic payload.
    assert.ok(
      !html.includes('zephyrblatt'),
      'LEAK: CLI ignored the data-root EXPORT_TRANSFORMS.json and used the code-dir config',
    );
    assert.ok(html.includes('weather-widget'), 'data-root rule must have applied');
  } finally {
    srv.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * Criterion 6 (#500 B2 re-grade). Failing closed is only defensible if the way
 * out is obvious: with data and code in separate directories — supported and
 * documented — the first export a stranger runs lands on this branch, and an
 * error that only says "file not found" turns one-time setup into a dead end.
 *
 * The sharpest assertion here is not that the message mentions a filename. It
 * is that the file the message tells you to copy ACTUALLY EXISTS. An error
 * naming a path that isn't there would be a broken instrument in the one place
 * a stranger meets this tool for the first time — and a string match against a
 * hardcoded name would pass right up until someone renamed the shipped file.
 */
test('missing data-root config: fails closed AND tells the operator how to fix it', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-noconfig-'));
  try {
    fs.writeFileSync(path.join(dataRoot, 'board-data.json'), '{}');
    // Deliberately NO EXPORT_TRANSFORMS.json here.
    const r = await runCli(['7', '--dry-run'], {
      SCRUM_BOARD_FILE: path.join(dataRoot, 'board-data.json'),
    });

    assert.notEqual(r.code, 0, 'must fail closed, never export with the wrong rules');
    assert.match(r.stderr, /--config/, 'must offer the explicit-config remedy');
    assert.match(r.stderr, /\bcp\b/, 'must offer the copy remedy');

    // The copy remedy must name a file that is really on disk.
    const cpLine = r.stderr.split('\n').find((l) => l.trim().startsWith('cp '));
    assert.ok(cpLine, 'the copy remedy must appear as a runnable command');
    const source = cpLine.trim().split(/\s+/)[1];
    assert.ok(
      fs.existsSync(source),
      `the error tells the operator to copy ${source}, which does not exist`,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
