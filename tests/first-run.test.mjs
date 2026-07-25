/**
 * A brand-new board must be usable, and a card must never vanish.
 *
 * Both of these were live defects, found by walking a virgin board for the first
 * time — one of us in a browser, one through the API, arriving at the same root
 * from opposite directions.
 *
 * A fresh install had ZERO columns while new cards default to `column:
 * "backlog"`. The UI drew BACKLOG / IN PROGRESS / DONE as placeholders that did
 * not exist, and a card pointing at a missing column rendered nowhere. So a
 * first-timer followed the quickstart exactly — clone, run, create a card —
 * opened the browser, saw "No cards yet", and reasonably concluded the install
 * was broken. The card was in the API the whole time and unreachable.
 *
 * It never bit the project that this code came from, because that board has had
 * real columns since before anyone now working on it arrived. The empty-board
 * path had simply never been walked. Every existing test builds its own fixture
 * WITH columns already in it, so the whole suite was green throughout.
 *
 * That is why these tests start from genuinely empty state rather than a
 * fixture: a test that begins where the bug cannot occur proves nothing about it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort, waitForHttp, PROJECT_DIR } from './helpers/harness.mjs';

/** A server pointed at a data file that does not exist yet — a true first run. */
async function virginBoard() {
  const port = await freePort();
  const boardFile = path.join(os.tmpdir(), `virgin-${process.pid}-${port}.json`);
  try { fs.unlinkSync(boardFile); } catch { /* already absent */ }

  const proc = spawn('node', ['server.js'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      SCRUM_PORT: String(port),
      SCRUM_BOARD_FILE: boardFile,
      SCRUM_MCP_NOTIFY_URL: '',
      SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `virgin-cfg-${process.pid}-${port}.json`),
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

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('FIRST RUN: a brand-new board has real, usable columns', async () => {
  const s = await virginBoard();
  try {
    const columns = await (await fetch(`${s.baseUrl}/api/columns`)).json();
    assert.ok(columns.length >= 3, 'a fresh board is not empty of columns');
    const ids = columns.map((c) => c.id);
    // The ids matter, not just the count: `backlog` is the literal string a new
    // card defaults to. Columns named right but keyed wrong would look correct
    // in the UI and still swallow every card.
    assert.ok(ids.includes('backlog'), 'the column new cards default into exists');
  } finally {
    await s.stop();
  }
});

test('FIRST RUN: a card created immediately is VISIBLE on the board', async () => {
  // The actual first-timer experience, end to end. This is the assertion that
  // would have failed while the suite was green.
  const s = await virginBoard();
  try {
    const card = await (await postJson(`${s.baseUrl}/api/cards`, { title: 'my first card' })).json();
    const board = await (await fetch(`${s.baseUrl}/api/board`)).json();
    const columnIds = new Set(board.columns.map((c) => c.id));
    assert.ok(
      columnIds.has(card.column),
      `a new card must land in a column that EXISTS (got "${card.column}", have ${[...columnIds]})`,
    );
    assert.equal(board.cards.length, 1, 'and it is on the board');
  } finally {
    await s.stop();
  }
});

test('DELETING A COLUMN moves its cards rather than hiding them', async () => {
  // The same bug on a mature board: remove a column with cards in it and they
  // used to stay behind pointing at something absent — present in the API,
  // invisible in the only place anyone looks.
  const s = await virginBoard();
  try {
    const card = await (await postJson(`${s.baseUrl}/api/cards`, { title: 'do not lose me' })).json();
    assert.equal(card.column, 'backlog', 'precondition: it starts in backlog');

    const del = await fetch(`${s.baseUrl}/api/columns/backlog`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const board = await (await fetch(`${s.baseUrl}/api/board`)).json();
    const columnIds = new Set(board.columns.map((c) => c.id));
    assert.ok(!columnIds.has('backlog'), 'the column is gone');
    assert.equal(board.cards.length, 1, 'the card is not gone');
    assert.ok(
      columnIds.has(board.cards[0].column),
      'and it moved to a column that exists rather than dangling',
    );
  } finally {
    await s.stop();
  }
});

test('the LAST column cannot be deleted', async () => {
  // A board with no columns can display nothing, and every card on it would
  // point at something absent — the original defect, reachable on purpose.
  const s = await virginBoard();
  try {
    const before = await (await fetch(`${s.baseUrl}/api/columns`)).json();
    for (const c of before.slice(0, -1)) {
      await fetch(`${s.baseUrl}/api/columns/${c.id}`, { method: 'DELETE' });
    }
    const remaining = await (await fetch(`${s.baseUrl}/api/columns`)).json();
    assert.equal(remaining.length, 1, 'precondition: one column left');

    const res = await fetch(`${s.baseUrl}/api/columns/${remaining[0].id}`, { method: 'DELETE' });
    assert.equal(res.status, 400, 'refused');
    assert.match((await res.json()).error, /last column/i, 'and it says why');

    const after = await (await fetch(`${s.baseUrl}/api/columns`)).json();
    assert.equal(after.length, 1, 'the column is still there');
  } finally {
    await s.stop();
  }
});
