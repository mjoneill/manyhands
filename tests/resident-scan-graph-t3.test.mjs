/**
 * T3 (#1574, rubric #1602): THE RESIDENT MENTION SCAN SEES A GRAPH POST, ONCE, AND NEVER A TOMBSTONE. Pre-registered by the separate test author BEFORE any build
 * work on T3. Copy unchanged into tests/. REAL executor, REAL REST server with the unit on, the REAL runner (`scripts/guest-once.mjs`, the process launchd starts
 * every minute) and a fake Ollama that records every prompt; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY T3 IS A DECISION-MAKER (rows owed, not "learn in the rehearsal"): the scan decides WHEN A SEAT IS WOKEN, and a failure is silent in both directions. A
 * graph post the scan cannot see is a mention nobody ever answers (nothing errors; the seat just never hears). A graph post seen twice, or a tombstoned post
 * still seen, is a wake that spends a model call and, for the tombstone, hands redacted text to a model. The runner reads `GET /api/conversations?attachedTo=
 * null&since=<cursor>&limit=500` (core/guest-loop.mjs `mentionScanPath`) and reads each row's `mentions` field, never the body (#1410), so what is pinned is the
 * WHOLE PATH, ending at the model call and the reply, not the list route alone (R1 pins that).
 *
 * THREE ROWS:
 *   T3a  A MENTION THAT LIVES ONLY IN THE GRAPH WAKES THE RESIDENT EXACTLY ONCE. Precondition control: the mention is NOT in the document. Then one runner pass
 *        makes one model call whose prompt carries the mention, posts one reply, and moves the cursor to that mention's id and createdAt; a second pass does
 *        nothing (no call, no post). The row the runner reads carries `mentions: ['gizmo']` (a graph post whose mention was resolved against the roster alone
 *        would be a resident that is never woken).
 *   T3b  NO DUPLICATE WAKE ACROSS SUBSTRATES. Three mentions in time order: held by the document only, held by BOTH the document and the graph (the live board's
 *        shape during a migration), and graph-only. Three passes make exactly three model calls, one per mention, in order, each prompt carrying its own mention
 *        and not a later one; a fourth pass makes none. The one in both substrates is NOT woken twice.
 *   T3c  A TOMBSTONE WAKES NO ONE AND LEAKS NOTHING. Two mentions are redacted before the first pass: one graph-only, one held by both substrates (the document
 *        still has its plain text). Then a control mention, graph-only. One pass makes exactly ONE model call (the control, not a redacted one) and no prompt
 *        contains the graph-only tombstone's text. The control proves the runner would have woken for a visible mention.
 *
 * NOT COVERED, by name: the runner's CONTEXT window (`/api/changes`, document-backed: it can carry a redacted post's plain text from the document until the
 * physical redaction work P1-P6, and a graph post is absent from it; the first is the retained-copy surface already named, the second is a projection learned
 * in the rehearsal), pinned here only is that the tombstone does not WAKE and that the graph-only tombstone's text reaches no prompt; posts attached to a card
 * (the scan asks `attachedTo=null`); the pair cap between two residents; a model that declines to reply; the reply being dispatched anywhere (that is D1); the
 * scan window beyond the first-run ten minutes; and the Desktop-bridge seat's mode and the presence plugin's receive behaviour (inventory items before production clearance).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 't3-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const MIN = 60000;

const ROSTER_FILE = path.join(os.tmpdir(), `t3-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

/** A fake Ollama: one fixed reply, records every request body. The marker is on the fixture: it stands in for a model that INTENDED to publish. */
function fakeOllama(reply = 'REPLY: Gizmo here.') {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { calls.push({ url: req.url, body: raw }); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ calls, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}

function runOnce(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'guest-once.mjs'), '--seat', 'gizmo'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const docMention = (id, seq, body, ageMin, mentions = ['gizmo']) => ({ id, body, author: 'ada', attachedTo: null, attachments: [], mentions, postSeq: seq, createdAt: new Date(Date.now() - ageMin * MIN).toISOString() });
const gc = (s) => createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID });
const importFull = async (s, p) => { const r = await gc(s).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: p.attachedTo, mentions: p.mentions, postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redactPost = async (s, id) => { const r = await gc(s).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

/** The unit ON with a real executor, a resident `gizmo` pointed at the fake model, and the document holding `docPosts`. */
async function stack(docPosts, body) {
  const exec = await startExecutor({ store: tmpStore('t3-store-'), datasetId: DSID, create: true });
  const ollama = await fakeOllama();
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: docPosts.length + 1 }),
    env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't3-')), 'gizmo.state.json');
  try {
    const made = await api(rest.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'guest', contextPolicy: 'artifact-only', by: 'ada' });
    assert.equal(made.status, 201, `the resident is created: ${made.text}`);
    const s = {
      base: rest.baseUrl, exec, ollama, rest, stateFile,
      post: (text) => api(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: text }),
      pass: async () => { const r = await runOnce({ SCRUM_BOARD_URL: rest.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }); assert.equal(r.code, 0, `the runner ends clean: ${r.err}${r.out}`); return r; },
      replies: async () => { const r = await api(rest.baseUrl, 'GET', '/api/conversations?attachedTo=null&limit=500'); return (Array.isArray(r.body) ? r.body : r.body.conversations).filter((m) => m.author === 'gizmo'); },
      state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
      inDocument: (text) => JSON.stringify(rest.readBoardFile()).includes(text),
    };
    return await body(s);
  } finally { await rest.stop(); await ollama.stop(); await killExecutor(exec); }
}

test('T3a A MENTION THAT LIVES ONLY IN THE GRAPH WAKES THE RESIDENT EXACTLY ONCE: one model call carrying the mention, one reply, the cursor on that mention; a second pass does nothing', { skip: SKIP }, async () => {
  await stack([], async (s) => {
    const m = await s.post('@gizmo what is the board for? t3a-marker');
    assert.equal(m.status, 201, `the mention is written: ${m.text}`);
    assert.equal(s.inDocument('t3a-marker'), false, 'CONTROL: the mention is graph-only (if it is in the document this row tests nothing about T3)');
    const feed = (await api(s.base, 'GET', '/api/conversations?attachedTo=null&limit=500')).body;
    const row = (Array.isArray(feed) ? feed : feed.conversations).find((c) => c.id === m.body.id);
    assert.ok(row, 'the list the runner reads holds the graph post');
    assert.deepEqual(row.mentions, ['gizmo'], `the row the runner reads names the resident (the runner reads this field, not the body): ${JSON.stringify(row.mentions)}`);

    await s.pass();
    assert.equal(s.ollama.calls.length, 1, `exactly ONE model call: ${s.ollama.calls.length}`);
    assert.ok(s.ollama.calls[0].body.includes('t3a-marker'), 'and its prompt carries the mention');
    assert.equal((await s.replies()).length, 1, 'exactly one reply is posted');
    assert.equal(s.state().lastAnsweredId, m.body.id, 'the cursor names the answered mention');
    assert.equal(s.state().lastAnsweredAt, m.body.createdAt, 'and is its createdAt');

    await s.pass();
    assert.equal(s.ollama.calls.length, 1, 'a second pass with nothing new makes no model call');
    assert.equal((await s.replies()).length, 1, 'and posts nothing');
  });
});

test('T3b NO DUPLICATE WAKE ACROSS SUBSTRATES: a mention in the document only, one in BOTH, and one in the graph only are each woken exactly once, in order; a fourth pass wakes nothing', { skip: SKIP }, async () => {
  const m1 = docMention('m1', 1, '@gizmo first, document only. t3b-one', 4);
  const m2 = docMention('m2', 2, '@gizmo second, both substrates. t3b-two', 3);
  await stack([m1, m2], async (s) => {
    await importFull(s, m2);                                            // the SAME post, in the graph too
    const m3 = await s.post('@gizmo third, graph only. t3b-three');
    assert.equal(m3.status, 201, m3.text);
    assert.equal(s.inDocument('t3b-three'), false, 'CONTROL: the third is graph-only');
    const seen = [];
    for (let i = 0; i < 3; i++) { await s.pass(); seen.push(s.ollama.calls.length); }
    assert.deepEqual(seen, [1, 2, 3], `one model call per pass, three in all (the post held by both substrates is NOT woken twice): ${JSON.stringify(seen)}`);
    const bodies = s.ollama.calls.map((c) => c.body);
    for (const [i, tag] of ['t3b-one', 't3b-two', 't3b-three'].entries()) assert.ok(bodies[i].includes(tag), `call ${i + 1} carries its own mention (${tag})`);
    assert.ok(!bodies[0].includes('t3b-three'), 'and the first call carries no later mention');
    assert.equal((await s.replies()).length, 3, 'three replies');
    assert.equal(s.state().lastAnsweredId, m3.body.id, 'the cursor ends on the last mention');
    await s.pass();
    assert.equal(s.ollama.calls.length, 3, 'a fourth pass wakes nothing');
    assert.equal((await s.replies()).length, 3, 'and posts nothing');
  });
});

test('T3c A TOMBSTONE WAKES NO ONE AND LEAKS NOTHING: a redacted graph-only mention and a redacted mention the document still holds in plain text cause no model call; one pass answers only the visible control, and no prompt carries the graph-only tombstone\'s text', { skip: SKIP }, async () => {
  const held = docMention('h1', 1, '@gizmo held by both, redacted. t3c-held', 5);
  await stack([held], async (s) => {
    await importFull(s, held);
    const g = await s.post('@gizmo graph only, redacted. t3c-graph');
    assert.equal(g.status, 201, g.text);
    assert.equal(s.inDocument('t3c-graph'), false, 'CONTROL: the graph-only mention is not in the document');
    await redactPost(s, 'h1');
    await redactPost(s, g.body.id);
    const c = await s.post('@gizmo the visible one. t3c-control');
    assert.equal(c.status, 201, c.text);
    await s.pass();
    assert.equal(s.ollama.calls.length, 1, `exactly ONE model call, for the visible mention: ${s.ollama.calls.length}`);
    assert.ok(s.ollama.calls[0].body.includes('t3c-control'), 'and it is the control (the runner would have woken for a visible mention)');
    assert.ok(!s.ollama.calls.some((x) => x.body.includes('t3c-graph')), 'no prompt carries the graph-only tombstone\'s text');
    assert.equal(s.state().lastAnsweredId, c.body.id, 'the cursor is on the control, not on a redacted post');
    await s.pass();
    assert.equal(s.ollama.calls.length, 1, 'a second pass wakes nothing');
  });
});
