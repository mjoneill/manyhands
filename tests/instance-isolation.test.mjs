/**
 * Two boards on one machine must not talk to each other.
 *
 * This exists because it happened. A scratch board was started with
 * `SCRUM_PORT=3199` — which isolates the REST server and nothing else — and its
 * commons posts were still notifying the MCP server on the hardcoded port 3001,
 * which belonged to the REAL board. A test message written in the scratch room
 * was delivered to everyone in the live one.
 *
 * Nothing in the suite could have caught it: every existing test starts its own
 * pair on free ports, so there is never a second instance nearby to leak into.
 * The bug only exists when two boards share a loopback, which is exactly the
 * situation anyone gets into the first time they want a place to experiment.
 *
 * So the test below builds that situation deliberately: a fake "other instance"
 * that records anything it receives, and a board configured to look like a
 * second one. The assertion is about where a request DIDN'T go, which is the
 * only kind of assertion that can catch this class.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort, waitForHttp, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

/**
 * Start a board with the env under test, WITHOUT the shared harness.
 *
 * `startRestServer` forces `SCRUM_MCP_NOTIFY_URL=''` last, on purpose (#218), so
 * an ordinary test run can never nudge a real room. That safety default is right
 * and stays — but it also means the harness can't be used to test how the notify
 * target is DERIVED, because it overwrites the answer. A test about defaults has
 * to own the whole environment.
 */
async function startBoard(extraEnv = {}) {
  const port = await freePort();
  const boardFile = path.join(os.tmpdir(), `iso-board-${process.pid}-${port}.json`);
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const proc = spawn('node', ['server.js'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      SCRUM_MCP_NOTIFY_URL: undefined, // let the default derive; see above
      ...extraEnv,
      SCRUM_PORT: String(port),
      SCRUM_BOARD_FILE: boardFile,
      SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `iso-cfg-${process.pid}-${port}.json`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/api/board`);
  return {
    baseUrl,
    async stop() {
      proc.kill('SIGKILL');
      try { fs.unlinkSync(boardFile); } catch { /* gone */ }
    },
  };
}

const post = (baseUrl, body) => fetch(`${baseUrl}/api/conversations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body, author: 'ada' }),
});

/** A stand-in for another instance's MCP server; records every hit. */
async function eavesdropper() {
  const hits = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return {
    port,
    hits,
    url: `http://127.0.0.1:${port}/internal/notify`,
    stop: () => new Promise((r) => srv.close(r)),
  };
}

/** Give a fire-and-forget notify a fair chance to arrive before asserting absence. */
const settle = () => new Promise((r) => setTimeout(r, 350));

test('a board notifies the MCP server on ITS OWN MCP_PORT', async () => {
  // The positive half. Without this, "nothing was notified" would pass just as
  // well if notification were broken outright — and the point is that a board
  // still nudges its own room.
  const mine = await eavesdropper();
  const server = await startBoard({ MCP_PORT: String(mine.port) });
  try {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'hello my own room', author: 'ada' }),
    });
    await settle();
    assert.equal(mine.hits.length, 1, 'the board notified its own MCP port');
    assert.match(mine.hits[0].body, /hello my own room/);
  } finally {
    await server.stop();
    await mine.stop();
  }
});

test('a SECOND board does not notify the first board\'s MCP server', async () => {
  // The regression. Both instances exist at once, as they do on a real machine.
  const live = await eavesdropper();     // "the real room"
  const scratch = await eavesdropper();  // "the scratch room"
  const server = await startBoard({ MCP_PORT: String(scratch.port) });
  try {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'this must stay in the scratch room', author: 'ada' }),
    });
    await settle();
    assert.equal(scratch.hits.length, 1, 'the scratch board notified its own MCP');
    assert.equal(
      live.hits.length, 0,
      'THE LEAK: a post in one board reached the other board\'s room',
    );
  } finally {
    await server.stop();
    await live.stop();
    await scratch.stop();
  }
});

test('an empty SCRUM_MCP_NOTIFY_URL disables notification entirely', async () => {
  // The documented escape hatch. It has to keep working: it is the one thing
  // someone can reach for when they want a board that nudges nobody at all.
  const listener = await eavesdropper();
  const server = await startBoard({
    MCP_PORT: String(listener.port), SCRUM_MCP_NOTIFY_URL: '',
  });
  try {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'silence please', author: 'ada' }),
    });
    await settle();
    assert.equal(listener.hits.length, 0, 'no notification when explicitly disabled');
  } finally {
    await server.stop();
    await listener.stop();
  }
});

test('posting still succeeds when the MCP server is not there at all', async () => {
  // A board must never depend on its MCP adapter being up. Notification is
  // best-effort by design; if that ever regressed, a stranger running only the
  // board would find posting broken for a reason they cannot see.
  const dead = await freePort(); // nothing is listening here
  const server = await startBoard({ MCP_PORT: String(dead) });
  try {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'nobody is listening', author: 'ada' }),
    });
    assert.equal(res.status, 201, 'the post succeeded regardless');
    await settle();
    const all = await (await fetch(`${server.baseUrl}/api/conversations`)).json();
    assert.equal(all.length, 1, 'and it persisted');
  } finally {
    await server.stop();
  }
});
