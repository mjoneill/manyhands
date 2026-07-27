/**
 * #513 — the boot gate's controls, encoded. The gate landed in a6c6fe7 with
 * its four controls watched in shells; a rail with no test is one refactor
 * away from being prose again — the exact failure #513 exists to end. These
 * four tests are the grader's controls made permanent (Wren, non-author).
 *
 * The discriminator matters and is asserted, not implied: exit 2 + the refuse
 * banner = the gate fired; exit 1 + a bind error = the gate LET IT THROUGH
 * and the port was simply taken. Reading "nonzero exit" as "refused" fails
 * the brick guard for the wrong reason (Indigo nearly did, twice, watched).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, waitForHttp, PROJECT_DIR } from './helpers/harness.mjs';

function scratchBoard() {
  const p = path.join(os.tmpdir(), `gate-board-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({ cards: [], columns: [], conversations: [], nextShortId: 1 }));
  return p;
}

function runServer(env, { waitExit = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['server.js'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, ...env },
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => (stdout += d));
    if (waitExit) {
      child.on('close', (code) => resolve({ code, stderr, stdout, child: null }));
      // A gated refusal exits immediately; a booted server would hang here.
      setTimeout(() => { child.kill(); }, 4000);
    } else {
      resolve({ child, stderrRef: () => stderr });
    }
  });
}

test('#513 negative control: undeclared second instance refuses with exit 2 and runnable remedies', async () => {
  const board = scratchBoard();
  try {
    const port = await freePort();
    const r = await runServer({ SCRUM_PORT: String(port), SCRUM_BOARD_FILE: board, SCRUM_MCP_NOTIFY_URL: undefined, MCP_PORT: undefined });
    assert.equal(r.code, 2, `the phantom class must refuse with exit 2, got ${r.code}; stderr: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /refuses to start/, 'the refusal must say so');
    assert.match(r.stderr, /SCRUM_MCP_NOTIFY_URL=''/, 'must offer the isolation remedy, runnable');
    assert.match(r.stderr, /on purpose/, 'must offer the intentional-second-room remedy');
  } finally {
    fs.rmSync(board, { force: true });
  }
});

test('#513 positive control: declared isolation (notify empty) boots and serves', async () => {
  const board = scratchBoard();
  const port = await freePort();
  const { child } = await runServer(
    { SCRUM_PORT: String(port), SCRUM_BOARD_FILE: board, SCRUM_MCP_NOTIFY_URL: '' },
    { waitExit: false },
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/config`, 8000);
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(res.status, 200, 'isolated instance must serve');
  } finally {
    child.kill();
    fs.rmSync(board, { force: true });
  }
});

test('#513 positive control: MCP_PORT counts as a declaration (naming the port names the room)', async () => {
  const board = scratchBoard();
  const port = await freePort();
  const mcpPort = await freePort();
  const { child } = await runServer(
    { SCRUM_PORT: String(port), SCRUM_BOARD_FILE: board, MCP_PORT: String(mcpPort), SCRUM_MCP_NOTIFY_URL: undefined },
    { waitExit: false },
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/config`, 8000);
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(res.status, 200, 'MCP_PORT-declaring instance must serve');
  } finally {
    child.kill();
    fs.rmSync(board, { force: true });
  }
});

/**
 * The brick guard, machine-independent form: on the DEFAULT port the gate
 * never fires, whatever else the env says. On a machine where the live
 * service holds 3141 the run exits 1 with a bind error (gate passed, port
 * taken); on a machine where 3141 is free it boots (gate passed, serving).
 * BOTH prove the gate let it through; only exit 2 with the refuse banner
 * fails — which is the outcome that would brick a kickstart.
 */
test('#513 brick guard: the gate never fires on the default port', async () => {
  const board = scratchBoard();
  try {
    const child = spawn('node', ['server.js'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, SCRUM_BOARD_FILE: board, SCRUM_PORT: '3141', SCRUM_MCP_NOTIFY_URL: undefined, MCP_PORT: undefined },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const outcome = await new Promise((resolve) => {
      child.on('close', (code) => resolve({ kind: 'exit', code }));
      waitForHttp('http://127.0.0.1:3141/api/config', 5000)
        .then(() => resolve({ kind: 'serving' }))
        .catch(() => {});
      setTimeout(() => resolve({ kind: 'timeout' }), 6000);
    });
    child.kill();
    assert.ok(!/refuses to start/.test(stderr),
      `the gate fired on the DEFAULT port — this is the config a launchd kickstart uses; stderr: ${stderr.slice(0, 300)}`);
    if (outcome.kind === 'exit') {
      assert.notEqual(outcome.code, 2, 'exit 2 on the default port means the gate bricked the kickstart path');
    }
  } finally {
    fs.rmSync(board, { force: true });
  }
});
