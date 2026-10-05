/**
 * D1 FAN-OUT (#1574, decision 3dc9df18, rubric #1602): WHAT A SEAT'S CHANNEL STREAM RECEIVES WHEN THE SERVER ANNOUNCES A GRAPH POST BY ID ONLY. Pre-registered by the
 * separate test author BEFORE the fan-out is built. Copy unchanged into tests/. REAL executor, REAL REST server with the unit on, REAL MCP adapter, REAL MCP sessions
 * with open channel streams (what a `claude --channels` seat holds); without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
 *
 * THE GAP (read from the source at 1aacd95, to be settled by the RED run): with the unit on the server's push to the adapter is `{conversation:{id}}` and nothing
 * else (pinned by R2 W37). `broadcastFanout` (mcp-server.mjs) builds `content` from `conversation.author` and `conversation.body` and decides who is the author's
 * own stream by comparing `conversation.author` with each session's author. With an id-only hint both are undefined: I expect a read-only session (no author
 * tag) to compare equal to `undefined` and be skipped as "self", and a session that has posted to receive "undefined: undefined". Neither errors; the room just
 * goes quiet or reads garbage. The fan-out has to RESOLVE the id first (one routing read), then build a CONTENT-FREE envelope from what the read says.
 *
 * WHAT IS PINNED is behaviour at the seat's stream, not the mechanism, and the audience is pinned as PARITY WITH TODAY'S PUSH, not as a new rule (the builder
 * withdrew "talk posts reach only their participants": talk posts are room-visible today and the receiver decides, #1409):
 *   F1 ENVELOPE  a room post by one seat reaches each other seat's stream exactly once as a notification that names the post (meta.message_id is its id), carries
 *                NO text of the post, contains no "undefined" or "null", has only scalar string meta (#206: a non-scalar value makes the renderer drop the block)
 *                and a non-empty string `content`; and the adapter's own log lines carry no text either (a retained copy of what the push left out).
 *   F2 AUDIENCE  the set of seats that receive a room post is IDENTICAL with the unit on (id-only hint) and with it off (today's full-body push): the author's own
 *                stream is skipped (#258), a read-only session that has never posted is NOT skipped (it fails toward an extra echo, never a missing message), and
 *                nothing is broadened or narrowed. The baseline is first shown to be {the other seat, the reader}, so a vacuous parity cannot pass.
 *   F3 TALK      the same parity for a post tagged into a talk, and the envelope keeps `meta.conversation` (the talk id) and `meta.talk_with` (the partner), both
 *                scalar strings, because a seat answers inside a talk by them (#1440, #1409).
 *   F4 TOMBSTONE a hint for a REDACTED post reaches no one (the hint was in flight when the redaction landed), and the stream still works afterwards (a control
 *                post is delivered). A hint for an id that names no post reaches no one either.
 *   F5 FAILED READ  a hint whose routing read FAILS (the graph is down) reaches no one: nothing is delivered to everyone as a fallback, no author-skip is
 *                bypassed. After the graph is back the same hint delivers to the right audience (a failure is not a permanent latch).
 *
 * NOT COVERED, by name: token-ring mode (the ring builds its own envelopes from `conversation.body`: a separate row set once the builder says how it resolves ids);
 * the seven producers of notify (only the server's post announcement is exercised); the seat-side read (`conversation_get` mounted in a real wake, owed under #1600);
 * the resident runners and the presence plugin receive; reply dispatch; attachments markers; a hint arriving twice (not pinned: today a duplicate is not suppressed either);
 * the staggered/soft/hard modes (the harness runs the adapter unstaggered).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer, startMcpServer, mcpSession, openChannelStream, freePort } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'd1f-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const SECRET = 'd1f-secret-text';
const CH = 'notifications/claude/channel';
const QUIET_MS = 1500;

const ROSTER_FILE = path.join(os.tmpdir(), `d1f-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' }, cy: { name: 'Cy', glyph: 'c', color: '#e0b060' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

/** REST (unit on or off) cross-wired to a real MCP adapter, three sessions with open streams: `ada` and `bea` have each posted under their own name (the
 *  adapter tags a session by the author it posts as), `reader` has never posted. Streams are opened AFTER the tagging posts, and settled, so every count below
 *  is "since the scenario began". */
async function stack(body, { unit }) {
  let exec = null; const store = unit ? tmpStore('d1f-store-') : null;
  if (unit) exec = await startExecutor({ store, datasetId: DSID, create: true });
  const mcpPort = await freePort();
  const board = makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 });
  const rest = await startRestServer({ board, mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify`,
    env: { SCRUM_ROSTER_FILE: ROSTER_FILE, ...(unit ? { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) } });
  let mcp = null; const streams = []; let s = null;
  try {
    mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl });
    const sessions = {};
    for (const who of ['ada', 'bea', 'reader']) {
      sessions[who] = await mcpSession(mcp.mcpUrl);
      if (who !== 'reader') await sessions[who].callTool('conversation_post', { author: who, body: `${who} says hello` });
    }
    const open = {};
    for (const who of ['ada', 'bea', 'reader']) { open[who] = await openChannelStream(mcp.mcpUrl, sessions[who].sessionId); streams.push(open[who]); }
    await sleep(800);
    const base = Object.fromEntries(Object.entries(open).map(([w, s]) => [w, s.messages.filter((m) => m.method === CH).length]));
    s = {
      rest, mcp, exec, store, base: rest.baseUrl, restBase: rest.baseUrl,
      post: (author, text, extra = {}) => api(rest.baseUrl, 'POST', '/api/conversations', { author, body: text, ...extra }),
      /** the channel notifications each stream has received since the scenario began */
      got: () => Object.fromEntries(Object.entries(open).map(([w, st]) => [w, st.messages.filter((m) => m.method === CH).slice(base[w])])),
      /** who received at least one, sorted */
      audience: () => Object.entries(s.got()).filter(([, v]) => v.length > 0).map(([w]) => w).sort(),
      /** wait until `n` seats have received something, or the quiet window passes */
      settle: async (ms = QUIET_MS) => { await sleep(ms); },
      hint: (id) => fetch(`${mcp.baseUrl}/internal/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: { id } }) }),
      client: () => createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }),
    };
    return await body(s);
  } finally { for (const st of streams) st.close(); if (mcp) await mcp.stop(); await rest.stop(); if (s?.exec || exec) await killExecutor(s?.exec || exec); }
}

const importAnnounceless = async (s, p) => { const r = await s.client().update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: new Date().toISOString(), attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redact = async (s, id) => { const r = await s.client().update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

test('F1 ENVELOPE: a room post reaches each other seat\'s stream once, names the post, carries none of its text, has no "undefined"/"null", only scalar string meta; the adapter\'s logs carry no text', { skip: SKIP }, async () => {
  await stack(async (s) => {
    const p = await s.post('ada', `a room post ${SECRET}`);
    assert.equal(p.status, 201, p.text);
    await s.settle();
    const got = s.got();
    assert.deepEqual(Object.fromEntries(Object.entries(got).map(([w, v]) => [w, v.length])), { ada: 0, bea: 1, reader: 1 }, `one notification for each seat that is not the author: ${JSON.stringify(Object.entries(got).map(([w, v]) => [w, v.map((m) => m.params)]))}`);
    for (const who of ['bea', 'reader']) {
      const m = got[who][0].params;
      assert.equal(m.meta.message_id, p.body.id, `${who}: the notification names the post`);
      assert.equal(typeof m.content, 'string', `${who}: content is a string`);
      assert.ok(m.content.length > 0, `${who}: content is not empty`);
      const wire = JSON.stringify(got[who][0]);
      assert.ok(!wire.includes(SECRET), `${who}: no text of the post on the wire: ${wire}`);
      assert.ok(!/undefined|null/.test(wire), `${who}: no "undefined" or "null" on the wire: ${wire}`);
      assert.ok(Object.values(m.meta).every((v) => typeof v === 'string'), `${who}: every meta value is a scalar string (#206): ${JSON.stringify(m.meta)}`);
    }
    assert.ok(!(s.mcp.stdoutText() + s.mcp.stderrText()).includes(SECRET), 'the adapter\'s logs carry no text of the post');
  }, { unit: true });
});

test('F2 AUDIENCE: a room post reaches the SAME seats with the unit on (id-only hint) as with it off (today\'s full-body push): the author is skipped, a read-only session is not, nothing is broadened or narrowed', { skip: SKIP }, async () => {
  let baseline;
  await stack(async (s) => {
    assert.equal((await s.post('ada', 'baseline room post')).status, 201);
    await s.settle();
    baseline = s.audience();
  }, { unit: false });
  assert.deepEqual(baseline, ['bea', 'reader'], `CONTROL: today's push reaches the other seat and the reader, not the author: ${JSON.stringify(baseline)}`);
  await stack(async (s) => {
    assert.equal((await s.post('ada', 'room post under the unit')).status, 201);
    await s.settle();
    assert.deepEqual(s.audience(), baseline, `the audience under the unit equals today's: ${JSON.stringify(Object.entries(s.got()).map(([w, v]) => [w, v.length]))}`);
  }, { unit: true });
});

test('F3 TALK: a post tagged into a talk reaches the SAME seats with the unit on as with it off, and the envelope keeps the talk id and the partner as scalar strings', { skip: SKIP }, async () => {
  const openTalk = async (s) => { const t = await api(s.base, 'POST', '/api/talks', { by: 'ada', title: 'a talk', with: 'cy' }); assert.equal(t.status, 201, t.text); return t.body; };
  let baseline;
  await stack(async (s) => {
    const talk = await openTalk(s);
    assert.equal((await s.post('ada', 'baseline talk post', { conversation: talk.id })).status, 201);
    await s.settle();
    baseline = s.audience();
  }, { unit: false });
  assert.deepEqual(baseline, ['bea', 'reader'], `CONTROL: today's push reaches every seat but the author, talk or not: ${JSON.stringify(baseline)}`);
  await stack(async (s) => {
    const talk = await openTalk(s);
    const p = await s.post('ada', `talk post under the unit ${SECRET}`, { conversation: talk.id });
    assert.equal(p.status, 201, p.text);
    await s.settle();
    assert.deepEqual(s.audience(), baseline, 'the same audience under the unit');
    for (const who of ['bea', 'reader']) {
      const m = s.got()[who][0].params.meta;
      assert.equal(m.conversation, talk.id, `${who}: the envelope carries the talk id`);
      assert.equal(m.talk_with, 'cy', `${who}: and the seat the talk is WITH`);
      assert.ok(Object.values(m).every((v) => typeof v === 'string'), `${who}: scalar string meta only: ${JSON.stringify(m)}`);
      assert.ok(!JSON.stringify(s.got()[who][0]).includes(SECRET), `${who}: no text on the wire`);
    }
  }, { unit: true });
});

test('F4 TOMBSTONE: a hint for a redacted post reaches no one; a hint for an id that names no post reaches no one; the stream still works (a control post is delivered)', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await importAnnounceless(s, { id: 'imp-redacted', body: `redacted text ${SECRET}`, author: 'ada', postSeq: 100 });   // written straight to the graph: the server never announced it
    await redact(s, 'imp-redacted');
    assert.equal((await s.hint('imp-redacted')).status, 204, 'the adapter accepts the hint');
    assert.equal((await s.hint('no-such-post-anywhere')).status, 204, 'and a hint for nothing');
    await s.settle();
    assert.deepEqual(s.audience(), [], `a tombstone and an unknown id reach NO ONE: ${JSON.stringify(Object.entries(s.got()).map(([w, v]) => [w, v.map((m) => m.params)]))}`);
    const c = await s.post('ada', 'a control post, visible');
    assert.equal(c.status, 201, c.text);
    await s.settle();
    assert.deepEqual(s.audience(), ['bea', 'reader'], 'CONTROL: the streams were alive the whole time (a visible post is delivered)');
    assert.ok(!JSON.stringify(s.got()).includes(SECRET), 'and nothing carries the tombstone\'s text');
  }, { unit: true });
});

test('F5 FAILED READ: a hint whose routing read fails (the graph is down) reaches no one, nothing falls back to everyone; once the graph is back the same hint reaches the right audience', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await importAnnounceless(s, { id: 'imp-visible', body: `visible text ${SECRET}`, author: 'ada', postSeq: 100 });
    const port = s.exec.port;
    await killExecutor(s.exec);
    assert.equal((await s.hint('imp-visible')).status, 204, 'the adapter accepts the hint');
    await s.settle();
    assert.deepEqual(s.audience(), [], `with the read failing NO ONE receives anything (not everyone, not the author): ${JSON.stringify(Object.entries(s.got()).map(([w, v]) => [w, v.length]))}`);
    s.exec = await startExecutor({ store: s.store, datasetId: DSID, create: false, port });
    assert.equal((await s.hint('imp-visible')).status, 204);
    await s.settle();
    assert.deepEqual(s.audience(), ['bea', 'reader'], 'after the graph is back the same hint delivers to the seats that are not the author (a failure is not a latch)');
    assert.ok(!JSON.stringify(s.got()).includes(SECRET), 'and still no text on the wire');
  }, { unit: true });
});
