/**
 * D1 FAN-OUT, ADDENDUM F6 (#1574, #1602): A POST WHOSE TALK CANNOT BE READ REACHES NO ONE. Pre-registered by the separate test author; a second file because the
 * first (mcp-fanout-d1.test.mjs, sha256 cb9635e5576f...) is frozen and committed. Copy unchanged into tests/. REAL executor, REAL REST with the unit on, REAL MCP,
 * REAL sessions on open channel streams; without a python with pyoxigraph the row is SKIPPED, and a skip is NOT a pass.
 *
 * WHY (found by mutation, adopted by the contract owner as one focused row): the fan-out reads the post once for routing and, for a talk-tagged post, reads the
 * talk once more to learn its partner. The builder's code delivers to no one when that second read fails. Nothing pinned it: the mutant that delivers anyway
 * survived F1-F5, because F3 only ever reads a talk that exists. The mechanism that makes it matter: a notification that arrives WITHOUT `talk_with` reads as a
 * plain room post, so a seat answers in the room where the talk's own view cannot see it (#1440, #1409), and the miss is silent.
 *
 * THE ROW: a post written straight to the graph and tagged into a talk id that no talk has (a dangling tag; REST refuses to write one, an import does not) is
 * announced by id. Its own read succeeds, its talk's read fails. NO seat receives anything, and nothing is delivered "without the partner". The control, in the
 * same stack and window: an untagged post announced by id is delivered to the seats that are not its author, so the streams were alive the whole time.
 *
 * NOT COVERED, by name: a talk whose read fails for a reason other than not existing (a transient 5xx from REST: the code path is the same catch); recovery after
 * a talk read fails (the hint is not retried by the server; F5 pins recovery for the post read).
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

const importAnnounceless = async (s, p) => { const r = await s.client().update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: new Date().toISOString(), attachedTo: null, mentions: [], postSeq: p.postSeq, ...(p.conversation ? { conversation: p.conversation } : {}) } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redact = async (s, id) => { const r = await s.client().update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

test('F6 A POST WHOSE TALK CANNOT BE READ REACHES NO ONE: the post reads, its talk does not, nothing is delivered (not even without the partner); a control post announced afterwards in the same stack is delivered', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await importAnnounceless(s, { id: 'imp-dangling', body: `dangling talk ${SECRET}`, author: 'ada', postSeq: 100, conversation: 'no-such-talk-anywhere' });
    const read = await api(s.base, 'GET', '/api/conversations/imp-dangling');
    assert.equal(read.status, 200, `CONTROL: the post itself reads: ${read.text}`);
    assert.equal(read.body.conversation, 'no-such-talk-anywhere', 'CONTROL: and carries the dangling talk tag');
    const talk = await api(s.base, 'GET', '/api/talks/no-such-talk-anywhere');
    assert.notEqual(talk.status, 200, `CONTROL: the talk itself cannot be read: ${talk.status}`);
    assert.equal((await s.hint('imp-dangling')).status, 204, 'the adapter accepts the hint');
    await s.settle();
    assert.deepEqual(s.audience(), [], `a post whose talk cannot be read reaches NO ONE: ${JSON.stringify(Object.entries(s.got()).map(([w, v]) => [w, v.map((m) => m.params)]))}`);
    await importAnnounceless(s, { id: 'imp-control', body: 'a control post', author: 'ada', postSeq: 101 });
    assert.equal((await s.hint('imp-control')).status, 204);
    await s.settle();
    assert.deepEqual(s.audience(), ['bea', 'reader'], 'CONTROL: the streams were alive (an untagged post is delivered to the seats that are not its author)');
    assert.equal(Object.values(s.got()).flat().length, 2, 'and only the control was delivered (two seats, one notification each)');
    assert.ok(!JSON.stringify(s.got()).includes(SECRET), 'no text on the wire');
  }, { unit: true });
});
