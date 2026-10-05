/**
 * `/api/changes`, GRAPH-BACKED: THE ONE CONSUMER CHECK (#1574, #1602; the contract owner's 20:04Z ask). Pre-registered by the separate test author. Copy unchanged
 * into tests/. REAL executor, REAL REST server with the conversations unit on, the REAL runner (`scripts/guest-once.mjs`) and a fake Ollama that records every
 * prompt; without a python with pyoxigraph the row is SKIPPED, and a skip is NOT a pass. Synthetic content only. Companion to changes-graph-posts-c1.test.mjs,
 * which pins the HTTP answer; this pins what the MODEL is handed from it.
 *
 * WHY: the runner builds a wake's "What changed on the board recently" section from `GET /api/changes` (`fetchBoundedChanges`, then one line per row from its
 * `title`), whenever the agent's context policy is not `artifact-only`. Text handed to a model cannot be taken back, so the answer's projection has to reach the
 * model: a new graph post must be IN that section (otherwise a resident's context misses every post written under the unit), and a redacted post's text must be
 * NOWHERE in the prompt, whether the post lives only in the graph or its text is also in the event log from before the unit was on.
 *
 * THE ROW (one scenario, one runner pass, one model call). Written with the unit OFF: a visible old post and a soon-to-be-redacted old post (event-log rows WITH
 * their text). Both are imported into the graph and the second is redacted there. With the unit ON: a visible graph-only post, a graph-only post that is then
 * redacted, and a mention of the resident. The one model call's whole request body:
 *     - carries the visible old post and the visible graph post, in the changes section (the feed reaches the model; the control that the section is there at all);
 *     - carries the mention;
 *     - carries NEITHER redacted post's text, anywhere (the stale log row, and the graph-only post).
 *
 * NOT COVERED, by name: the rendering of a tombstone row in that section (the rows give a null `title`, which the line renders as the bare id; not pinned
 * beyond "no text"); the `artifact-only` policy (it hands no changes at all); channel-mode digests (their posts are read by id, pinned by the tombstone-render row);
 * a changes read that fails (the runner then says so and answers from the mention alone, pinned by an existing test); the memory block.
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
const DSID = 'ctx-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROSTER_FILE = path.join(os.tmpdir(), `ctx-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
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
const client = (exec) => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
const importPost = async (exec, p) => { const r = await client(exec).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redact = async (exec, id) => { const r = await client(exec).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

test('C2a THE RESIDENT\'S CONTEXT IS THE PROJECTED FEED: one model call carries the visible old post, the visible graph post and the mention in its changes section, and carries neither redacted post\'s text anywhere', { skip: SKIP }, async () => {
  // the unit-OFF history: two posts, event-log rows with their text
  const off = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const old = [];
  for (const [a, t] of [['ada', 'old visible post ctx-old-visible'], ['bea', 'old post to be redacted ctx-secret-log']]) { const r = await api(off.baseUrl, 'POST', '/api/conversations', { author: a, body: t }); assert.equal(r.status, 201, r.text); old.push({ ...r.body, body: t }); await sleep(15); }
  off.kill(); await sleep(400);
  const exec = await startExecutor({ store: tmpStore('ctx-store-'), datasetId: DSID, create: true });
  const ollama = await fakeOllama();
  const rest = await startRestServer({ boardFile: off.boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')), 'gizmo.state.json');
  try {
    for (const p of old) await importPost(exec, p);
    await redact(exec, old[1].id);
    const made = await api(rest.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'guest', contextPolicy: 'thread', by: 'ada' });
    assert.equal(made.status, 201, made.text);
    const vis = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'bea', body: 'new graph post ctx-new-visible' }); await sleep(15);
    const sec = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'new graph post to be redacted ctx-secret-graph' }); await sleep(15);
    const men = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@gizmo what changed? ctx-mention' });
    for (const r of [vis, sec, men]) assert.equal(r.status, 201, r.text);
    await redact(exec, sec.body.id);
    assert.ok(!JSON.stringify(rest.readBoardFile()).includes('ctx-secret-graph'), 'CONTROL: the graph-only post is not in the document');

    const run = await runOnce({ SCRUM_BOARD_URL: rest.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile });
    assert.equal(run.code, 0, `the runner ends clean: ${run.err}${run.out}`);
    assert.equal(ollama.calls.length, 1, `exactly one model call: ${ollama.calls.length}\n${run.out}${run.err}`);
    const prompt = ollama.calls[0].body;
    assert.ok(prompt.includes('ctx-mention'), 'the prompt carries the mention');
    const at = prompt.indexOf('What changed on the board recently');
    assert.ok(at >= 0, `CONTROL: the prompt has a changes section at all: ${run.err}`);
    const section = prompt.slice(at);
    assert.ok(section.includes('ctx-old-visible'), 'the visible old post (an event-log row) is in the changes section');
    assert.ok(section.includes('ctx-new-visible'), `the visible GRAPH post is in the changes section: ${section.slice(0, 700)}`);
    assert.ok(!prompt.includes('ctx-secret-log'), 'the stale log row\'s text (redacted in the graph) is nowhere in the prompt');
    assert.ok(!prompt.includes('ctx-secret-graph'), 'the redacted graph-only post\'s text is nowhere in the prompt');
  } finally { await rest.stop(); await ollama.stop(); await killExecutor(exec); }
});
