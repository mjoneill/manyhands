/**
 * #1259 — THE READINESS POLL MUST PROVE THE PROCESS IT SPAWNED IS THE ONE
 * ANSWERING.
 *
 * #1140 fixed the diagnosis and the retry for a lost port race, and its own
 * third-shape follow-up named the hole that fix leaves open: `freePort()` hands
 * the number back unheld, so a STRANGER can already be listening on it when our
 * child is spawned. The old `waitForHttp` returned on ANY answer, so the
 * stranger's 200 satisfied readiness before our child even reached bind(); the
 * retry (which lives in the catch) never armed; the child's EADDRINUSE went into
 * a stderr buffer discarded on success; and the test was handed the stranger's
 * baseUrl. Every read it then made was answered correctly — by the wrong board.
 * That is a clean, authoritative `[]` with status 200, which is the exact shape
 * of three CI-only failures on 2026-09-06/07 (#656 control, #210, #1010), one of
 * which cost #715 its place in production.
 *
 * Now each spawn attempt mints a nonce, the child echoes it as
 * X-Scrum-Instance, and readiness means THAT answer. A stranger fails NOW, is
 * named, and counts as a lost allocation race — retried when the harness chose
 * the port, refused when the caller did.
 *
 * ⚠️ Per #1140: the acceptance is a RED that reproduces the collision, never a
 * green suite. #1140's squatter accepts and never answers, which exercises the
 * timeout path; the stranger here ANSWERS, which is the path that used to read
 * as success. Each test occupies the port first — the losing side of the race
 * made deterministic — and the allocator counts its calls, because a test that
 * never met the stranger is a test that never ran the bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, waitForHttp, startRestServer, startMcpServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

/**
 * A stranger that ANSWERS: a real HTTP server on a real port, 200 + JSON on any
 * path, with no instance header — what another worker's server.js or
 * mcp-server.mjs looks like from the readiness poll's side. It counts hits so
 * a test can prove the poll actually met it.
 */
async function answeringStranger() {
  const port = await freePort();
  const sockets = new Set();
  const state = { hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cards: [], columns: [] }));
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
  return {
    port,
    state,
    release: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }),
  };
}

/** Hands out `first` once, then real free ports; counts, so the seam proves it was used (#1140). */
function countingAllocator(first) {
  const state = { calls: 0, handed: [] };
  const fn = async () => {
    state.calls += 1;
    const p = state.calls === 1 ? first : await freePort();
    state.handed.push(p);
    return p;
  };
  fn.state = state;
  return fn;
}

test('#1259 CURE — a REST port answered by a stranger is rejected and retried; the server that comes up is OURS and serves OUR board', async () => {
  const stranger = await answeringStranger();
  const alloc = countingAllocator(stranger.port);
  let s = null;
  try {
    s = await startRestServer({ board: makeBoardFixture(), allocatePort: alloc });
    // The seam must prove it was used, and the stranger must prove it was met.
    assert.equal(alloc.state.handed[0], stranger.port, 'the first port handed out was the stranger\'s');
    assert.ok(alloc.state.calls >= 2, `a second port was allocated after the stranger answered (calls=${alloc.state.calls})`);
    assert.ok(stranger.state.hits >= 1, 'the readiness poll actually reached the stranger before rejecting it');
    assert.notEqual(s.port, stranger.port, 'the harness did not hand back the stranger\'s port');

    // ⛔ THE THING THAT USED TO HAPPEN: the test reads its own board and finds
    // nothing it wrote. Write, then read, on the baseUrl the harness returned.
    const w = await fetch(`${s.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'written to the server I started', by: 'sage' }) });
    assert.equal(w.status, 201, await w.text());
    const r = await fetch(`${s.baseUrl}/api/cards`);
    assert.ok(r.headers.get('x-scrum-instance'), 'our server identifies itself on every JSON response');
    const cards = await r.json();
    assert.ok(cards.some((c) => c.title === 'written to the server I started'), 'the rows I wrote are on the server I read — not a stranger\'s empty board');
  } finally {
    if (s) await s.stop();
    await stranger.release();
  }
});

test('#1259 CURE — same for the MCP adapter: /health answered by a stranger is not "up"', async () => {
  const stranger = await answeringStranger();
  const alloc = countingAllocator(stranger.port);
  let m = null;
  try {
    m = await startMcpServer({ allocatePort: alloc });
    assert.equal(alloc.state.handed[0], stranger.port);
    assert.ok(alloc.state.calls >= 2, `retried past the stranger (calls=${alloc.state.calls})`);
    assert.ok(stranger.state.hits >= 1, 'the poll met the stranger');
    assert.notEqual(m.port, stranger.port);
    const h = await fetch(`${m.baseUrl}/health`);
    assert.ok(h.headers.get('x-scrum-instance'), 'the adapter that came up is the one we spawned');
  } finally {
    if (m) await m.stop();
    await stranger.release();
  }
});

test('#1259 an EXPLICIT port answered by a stranger is refused, named, and never silently swapped', async () => {
  const stranger = await answeringStranger();
  try {
    const t0 = Date.now();
    await assert.rejects(
      async () => { const s = await startRestServer({ port: stranger.port }); await s.stop(); },
      (e) => {
        assert.match(e.message, /answered by a server I did not start \(#1259\)/, e.message);
        assert.match(e.message, /requested explicitly, so it is not retried/, e.message);
        assert.doesNotMatch(e.message, /timed out waiting/, 'the headline is the stranger, not a timeout');
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 6000, 'a stranger fails fast, not at the 8 s deadline');
  } finally {
    await stranger.release();
  }
});

test('#1259 CONTROL — production shape: no SCRUM_INSTANCE_ID ⇒ no X-Scrum-Instance header, no new surface', async () => {
  // The harness always sets the nonce now, so this spawns server.js by hand the
  // way launchd does: no instance id in the environment.
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-test-board-'));
  const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const env = { ...process.env, SCRUM_PORT: String(port), SCRUM_BOARD_FILE: boardFile, SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-test-attach-')), SCRUM_MCP_NOTIFY_URL: '' };
  delete env.SCRUM_INSTANCE_ID;
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/board`);
    const r = await fetch(`http://127.0.0.1:${port}/api/board`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-scrum-instance'), null, 'unset in production ⇒ the header does not exist');
  } finally {
    child.kill('SIGKILL');
  }
});
