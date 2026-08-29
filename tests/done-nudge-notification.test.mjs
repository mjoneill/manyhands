/**
 * #1081 — the card-completion nudge must ring the doorbell, not just be stored.
 *
 * A card entering `done` emits a commons post asking the room for the next pull
 * (#665). That post was persisted, versioned and written to the event log — and
 * never handed to `notifyMcpOfPost`, the call its two sibling handlers (claim at
 * :3649, release at :3687) both make eleven lines away. So the prompt reached no
 * seat at all: three seats across two toolchains confirmed zero live receipts on
 * 2026-08-29, and only noticed because @michael screenshotted the board.
 *
 * ⚠️ WHY THIS IS A BEHAVIOUR TEST AND NOT A SPY ON THE EMITTER: it asserts that
 * a real notification arrives at a real listener carrying the real post. A test
 * that checked "notifyMcpOfPost was called" would pass against a call whose
 * payload was wrong, and the payload is the whole point — a doorbell that rings
 * with nobody at the door is the defect we already have.
 *
 * ⛔ THE NEGATIVE CONTROLS ARE THE LOAD-BEARING HALF. Without them, "a
 * notification arrived" would pass just as well if the server notified on EVERY
 * card PATCH — which would be a different bug wearing this fix's green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRestServer, makeBoardFixture, freePort } from './helpers/harness.mjs';

/** Records every hit, standing in for the MCP server's /internal/notify. */
async function doorbell() {
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
    hits,
    url: `http://127.0.0.1:${port}/internal/notify`,
    stop: () => new Promise((r) => srv.close(r)),
  };
}

/**
 * `notifyMcpOfPost` is fire-and-forget by contract — unawaited, errors swallowed,
 * so a down MCP server can never break posting. An assertion of ABSENCE must
 * therefore give a notification that would have arrived a fair chance to land,
 * or it proves only that the test was faster than the network.
 */
const settle = () => new Promise((r) => setTimeout(r, 350));

function boardWith(column) {
  return makeBoardFixture({
    cards: [{
      id: 'card-uuid-1',
      shortId: 42,
      title: 'A card that is about to finish',
      description: '',
      type: 'task',
      assignees: ['sage'],
      labels: [],
      priority: null,
      column,
      order: 0,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      relationships: { relatedTo: [], blockedBy: [] },
      claimedBy: null,
      claimedAt: null,
    }],
    nextShortId: 43,
  });
}

const patch = (baseUrl, id, patchBody) =>
  fetch(`${baseUrl}/api/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  });

async function withServer(column, fn) {
  const bell = await doorbell();
  const server = await startRestServer({ board: boardWith(column), mcpNotifyUrl: bell.url });
  try {
    await fn(server, bell);
  } finally {
    await server.stop();
    await bell.stop();
  }
}

test('a card ENTERING done notifies the MCP server with the done-nudge post', async () => {
  await withServer('backlog', async (server, bell) => {
    const res = await patch(server.baseUrl, 42, { column: 'done' });
    assert.equal(res.status, 200, 'the PATCH itself must succeed');
    await settle();

    assert.equal(bell.hits.length, 1, 'exactly one notification — not zero, not two');

    // The payload is the point: a notification carrying the wrong thing is
    // indistinguishable from no notification, to a seat.
    const payload = JSON.parse(bell.hits[0].body);
    assert.ok(payload.conversation, 'the notification must carry a conversation');
    assert.match(
      payload.conversation.body,
      /#42 done/,
      'the notified post must be the done-nudge for THIS card',
    );
  });
});

test('a card ALREADY in done, patched again, notifies nobody', async () => {
  // NEGATIVE CONTROL. #665 fires on the TRANSITION (`!wasDone && done`), so a
  // no-op re-PATCH must stay silent. Without this, a fix that notified on every
  // PATCH of a done card would pass the positive test and spam the room.
  await withServer('done', async (server, bell) => {
    const res = await patch(server.baseUrl, 42, { column: 'done' });
    assert.equal(res.status, 200);
    await settle();
    assert.equal(bell.hits.length, 0, 'no transition, no nudge, no notification');
  });
});

test('a PATCH that never touches the column notifies nobody', async () => {
  // NEGATIVE CONTROL. The narrowest failure this fix could cause is notifying on
  // ordinary card edits — which would make every description tweak wake the room.
  await withServer('backlog', async (server, bell) => {
    const res = await patch(server.baseUrl, 42, { title: 'renamed, still not done' });
    assert.equal(res.status, 200);
    await settle();
    assert.equal(bell.hits.length, 0, 'an edit is not a completion');
  });
});
