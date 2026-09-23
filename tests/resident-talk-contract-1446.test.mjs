/**
 * #1446 — a resident keeps the talk contract (decision c86896b0) because it can
 * SEE it, not because a wall stops it. Talks are readable by the room; the seat
 * the talk is WITH answers inside; everyone else answers in the room.
 *
 * Measured 2026-09-23 12:55Z and 13:04Z: the resident's reply was filed into a
 * talk that was with ANOTHER seat — the runner tagged it from the waking posts
 * and never asked whose talk it was; the wake showed talk posts as plain
 * "author: body"; and the rule lived only in instructions residents never get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotateTalks, replyTalkFor, buildMessages, guestOnce } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const TALKS = [{ id: 't-mine', with: 'pip' }, { id: 't-other', with: 'ada' }];

test('#1446 replyTalkFor — into the seat\'s OWN talk only; another seat\'s or an unknown partner answers in the room; an un-annotated wake keeps the old behaviour', () => {
  assert.equal(replyTalkFor(annotateTalks({ conversation: 't-mine' }, TALKS), 'pip'), 't-mine');
  assert.equal(replyTalkFor(annotateTalks({ conversation: 't-other' }, TALKS), 'pip'), null, 'someone else\'s talk: the room');
  assert.equal(replyTalkFor(annotateTalks({ conversation: 't-gone' }, TALKS), 'pip'), null, 'an unknown partner: the room, never a guess');
  assert.equal(replyTalkFor({ conversation: 't-other' }, 'pip'), 't-other', 'a caller that never annotated keeps the legacy behaviour');
  assert.equal(replyTalkFor({}, 'pip'), null);
});

test('#1446 the wake SHOWS which posts are in whose talk, and states the contract', () => {
  const wake = annotateTalks({ kind: 'channel', posts: [
    { author: 'bo', body: 'room post', createdAt: 't1' },
    { author: 'bo', body: 'to ada, in her talk', createdAt: 't2', conversation: 't-other' },
    { author: 'bo', body: 'to pip, in pip\'s talk', createdAt: 't3', conversation: 't-mine' },
  ] }, TALKS);
  const text = JSON.stringify(buildMessages({ agent: { seatKey: 'pip', residency: 'resident', model: { model: 'm', protocol: 'x' } }, wake }));
  assert.match(text, /bo \[in a 1:1 talk with ada\]: to ada/, 'someone else\'s talk is named');
  assert.match(text, /bo \[in a 1:1 talk with YOU\]: to pip/, 'the seat\'s own talk is marked as its own');
  assert.match(text, /bo: room post/, 'a room post is unmarked');
  assert.match(text, /only the seat the talk is WITH answers inside it/, 'the contract rides the wake');
  const plain = JSON.stringify(buildMessages({ agent: { seatKey: 'pip', residency: 'resident', model: { model: 'm', protocol: 'x' } }, wake: { kind: 'channel', posts: [{ author: 'bo', body: 'hi', createdAt: 't' }] } }));
  assert.doesNotMatch(plain, /only the seat the talk is WITH/, 'no talk posts, no contract line');
});

test('#1446 guestOnce files the reply by the contract: another seat\'s talk -> untagged; own talk -> tagged', async () => {
  const run = async (conv) => {
    const posts = [];
    const wake = annotateTalks({ kind: 'channel', id: 'w', posts: [{ id: 'p', author: 'bo', body: 'hello', createdAt: 't', conversation: conv }], messageIds: ['p'], conversation: conv }, TALKS);
    await guestOnce({ agent: { seatKey: 'pip', name: 'Pip', systemPrompt: 'x', residency: 'guest', model: { model: 'm', protocol: 'ollama-native' } }, wake,
      callModel: async () => ({ text: 'REPLY: a useful answer', toolCalls: [], stopReason: 'stop', usage: {} }),
      post: async (b) => { posts.push(b); return { id: 'r' }; }, ledgerFile: `/tmp/never-used-1446-${process.pid}.jsonl` });
    return posts[0];
  };
  assert.equal((await run('t-other')).conversation, undefined, 'someone else\'s talk: posted to the room');
  assert.equal((await run('t-mine')).conversation, 't-mine', 'its own talk: answered inside');
});

function fakeOllama(reply) {
  const srv = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
const runOnce = (env, seat) => new Promise((resolve) => {
  const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code, out, err }));
});

test('#1446 SERVED — the REAL runner, woken by a post in ANOTHER seat\'s talk, answers in the ROOM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-1446-'));
  const ollama = await fakeOllama('REPLY: seen it — answering here in the room.');
  const rosterFile = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: { ada: { name: 'Ada', color: '#7cc4a0' }, pip: { name: 'Pip', color: '#c47c7c' } } }));
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_ROSTER_FILE: rosterFile } });
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const c = await api('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are Pip.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'guest', contextPolicy: 'artifact-only', deliveryMode: 'channel', by: 'ada' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    // a talk with some OTHER seat (the fixture's roster decides which exist)
    const talk = await api('POST', '/api/talks', { by: 'ada', title: 'focused', with: 'ada' });
    assert.equal(talk.status, 201, JSON.stringify(talk.body));
    assert.notEqual(talk.body.with, 'pip', 'the talk is NOT with the resident');
    const msg = (await api('POST', '/api/conversations', { author: 'ada', body: 'a thought for my talk partner', conversation: talk.body.id })).body;
    const offer = await api('POST', '/api/deliveries', { to: 'pip', conversation: msg.id, source: 'fanout', by: 'board' });
    assert.equal(offer.status, 201, JSON.stringify(offer.body));
    const r = await runOnce({ SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, 'pip.state.json') }, 'pip');
    assert.equal(r.code, 0, r.err + r.out);
    const all = (await api('GET', '/api/conversations')).body; const list = Array.isArray(all) ? all : all.conversations;
    const reply = list.find((m) => m.author === 'pip');
    assert.ok(reply, `the resident answered: ${r.out}${r.err}`);
    assert.equal(reply.conversation ?? null, null, 'and it answered in the ROOM, not inside another seat\'s talk');
  } finally { await srv.stop(); await ollama.stop(); }
});
