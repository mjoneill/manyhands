/**
 * #1440 — a post tagged into a Talk must reach a channel seat WITH its talk id.
 *
 * INCIDENT 2026-09-22 16:56:30Z: the owner asked a seat a question inside a
 * talk. The store held the post's `conversation` tag, but the push meta carried
 * only `chat_id: attachedTo || 'commons'`, so the seat saw a plain room post,
 * answered untagged, and the talk view stayed silent (16:58:29Z: "maybe Talk
 * with... isn't working...").
 *
 * The id rides as a SCALAR meta key (`conversation`) — the #206 invariant: a
 * non-scalar meta value makes Claude Code's renderer drop the whole block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpSession, startPair, openChannelStream } from './helpers/harness.mjs';

const json = (baseUrl, method, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function withStream(fn) {
  const pair = await startPair();
  let stream;
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
    await fn(pair, stream);
  } finally {
    if (stream) stream.close();
    await pair.stop();
  }
}

async function openTalk(baseUrl) {
  // the fixture's roster is not ours to assume: ask with a probe seat, and on
  // UNKNOWN_SEAT take the first seat the refusal names
  let talk = await json(baseUrl, 'POST', '/api/talks', { by: 'alex', title: 'stuff', with: 'alex' });
  if (talk.status === 400 && talk.body.code === 'UNKNOWN_SEAT') {
    const seat = talk.body.error.split('known: ')[1].split(', ')[0];
    talk = await json(baseUrl, 'POST', '/api/talks', { by: 'alex', title: 'stuff', with: seat });
  }
  assert.equal(talk.status, 201, `talk opened (${JSON.stringify(talk.body)})`);
  return { id: talk.body.id, with: talk.body.with };
}

test('#1440 — a talk-tagged post arrives with meta.conversation = the talk id, as a scalar string', async () => {
  await withStream(async (pair, stream) => {
    const { id: talkId, with: partner } = await openTalk(pair.rest.baseUrl);
    const post = await json(pair.rest.baseUrl, 'POST', '/api/conversations', { author: 'alex', body: 'so, you have questions for me?', conversation: talkId });
    assert.equal(post.body.conversation, talkId, 'the STORE tags it (the half that already worked)');
    const notif = await stream.next('notifications/claude/channel');
    const m = notif.params?.meta || {};
    assert.equal(m.conversation, talkId, 'the PUSH carries the talk id, so the seat can answer inside the talk');
    assert.equal(typeof m.conversation, 'string', '#206: scalar meta only');
    assert.equal(m.chat_id, 'commons', 'a talk post is still board-level: chat_id unchanged');
    assert.ok(partner, 'the talk has a partner (guard is not vacuous)');
    assert.equal(m.talk_with, partner, 'the PUSH names the seat the talk is WITH — every seat receives it, only the partner answers inside (#1409)');
    assert.equal(typeof m.talk_with, 'string', '#206: scalar meta only');
  });
});

test('#1440 — an untagged post carries NO conversation key (absence, not a constant)', async () => {
  await withStream(async (pair, stream) => {
    await openTalk(pair.rest.baseUrl);
    await json(pair.rest.baseUrl, 'POST', '/api/conversations', { author: 'alex', body: 'room post' });
    const notif = await stream.next('notifications/claude/channel');
    assert.equal('conversation' in (notif.params?.meta || {}), false, 'no talk → no key');
    assert.equal('talk_with' in (notif.params?.meta || {}), false, 'no talk → no partner key');
  });
});

test('#1440 — the server instructions tell a seat what the key means and how to answer inside the talk', async () => {
  await withStream(async (pair) => {
    const init = await fetch(pair.mcp.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'talk-id-1440', version: '1.0.0' } } }),
    });
    const text = await init.text();
    const dataLine = text.split('\n').find((l) => l.trimStart().startsWith('data:'));
    const instructions = JSON.parse((dataLine ?? text).replace(/^\s*data:\s*/, '')).result?.instructions ?? '';
    assert.ok(instructions.length > 0, 'instructions present (guard is not vacuous)');
    assert.match(instructions, /conversation="/, 'instructions name the conversation attribute on a channel block');
    assert.match(instructions, /talk_with is YOUR seat[^.]*conversation_post[^.]*conversation/, 'the PARTNER replies inside the talk with the same id');
    assert.match(instructions, /talk_with is another seat[^.]*untagged/, 'a NON-partner answers in the room untagged (#1409 — the talk must not become the room)');
  });
});
