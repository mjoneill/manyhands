/**
 * D1 / RESIDENT SLICE (#1574, #1603 demonstration finding, rubric #1602): A REDACTED POST REACHES A RESIDENT AS "THIS POST WAS REDACTED", NEVER AS GARBAGE.
 * Pre-registered by the separate test author BEFORE the runner is fixed. Copy unchanged into tests/. REAL executor, REAL REST server with the unit on, the REAL
 * runner (`scripts/guest-once.mjs`) in channel mode draining REAL deliveries, and a fake Ollama that records every prompt; without a python with pyoxigraph the
 * row is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: on the isolated copy (#1603, 19:44Z) a real wake of a resident was handed two delivery notices, one of them a redacted post, and the post read
 * `[unknown time] undefined: null`. No text leaked, but the seat saw garbage and reported "one blank/garbled". The runner's channel path reads each offered
 * post by id and pushes `{author: m.author, body: m.body, ...}`; a tombstone answers `{id, postSeq, redacted: true, body: null}` (decision dd472a5f), so author
 * is undefined and body is null, and `core/guest-loop.mjs` renders `${m.author}: ${m.body}`. A model that is handed "undefined: null" may reason about a
 * malformed system instead of "a post here was redacted", and a harness that only asserts "no marker text" passes it.
 *
 * THE ROW (one scenario, three posts, one runner pass):
 *   a visible graph-only post and a graph-only post that is OFFERED to the resident and then REDACTED before the runner reads it (an existing delivery outlives
 *   the redaction, ruling on DL11). One pass makes exactly one model call whose prompt (the whole request body):
 *     - carries the visible post's text, rendered as before (`ada: <text>`): the control that the runner read and rendered a post at all, and that the fix does
 *       not change how a visible post reads;
 *     - carries a redacted marker for the other, in the owner's words, "This post was redacted" (case-insensitive; the wording is the builder's to punctuate);
 *       exactly ONE such marker, for the one redacted post;
 *     - contains NO "undefined" and NO ": null" anywhere;
 *     - contains NONE of the redacted post's text.
 *   The delivery of the redacted post still ends settled like the other (the resident answered the digest): pinned only that BOTH deliveries leave the open
 *   list after the pass.
 *
 * NOT COVERED, by name: how the marker names or orders the post (not pinned); a talk-tagged tombstone (a tombstone carries no talk, by decision dd472a5f); the
 * non-channel wake path (a mention scan never lists a tombstone, T3c); the seat reading with `conversation_get` instead of the runner (a seat-side row, owed under
 * #1600); the runner's `/api/changes` context window (document-backed, a separate production gate).
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
const DSID = 'tb-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const VISIBLE = 'tb-visible-text';
const SECRET = 'tb-redacted-text';

const ROSTER_FILE = path.join(os.tmpdir(), `tb-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

function fakeOllama(reply = 'REPLY: Gizmo read both.') {
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

test('TB1 A REDACTED POST REACHES THE RESIDENT AS "THIS POST WAS REDACTED": one model call carries the visible post as before, one redacted marker, no "undefined", no ": null", none of the redacted text; both deliveries are settled', { skip: SKIP }, async () => {
  const exec = await startExecutor({ store: tmpStore('tb-store-'), datasetId: DSID, create: true });
  const ollama = await fakeOllama();
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }),
    env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')), 'gizmo.state.json');
  try {
    const made = await api(rest.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl },
      residency: 'resident', contextPolicy: 'artifact-only', by: 'ada', deliveryMode: 'channel' });
    assert.equal(made.status, 201, `the resident is created: ${made.text}`);
    const a = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `a visible post ${VISIBLE}` });
    const b = await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `a post that will be redacted ${SECRET}` });
    assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, b.text);
    assert.ok(!JSON.stringify(rest.readBoardFile()).includes(SECRET), 'CONTROL: the post to be redacted is graph-only (its text is nowhere in the document)');
    for (const p of [a, b]) {
      const d = await api(rest.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: p.body.id, source: 'fanout', by: 'board' });
      assert.equal(d.status, 201, `the offer: ${d.text}`);
    }
    const red = await createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${b.body.id}`, actor: `${PERSON}ada`, post: { id: b.body.id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() });
    assert.equal(red.outcome, 'APPLIED', JSON.stringify(red));
    assert.equal((await api(rest.baseUrl, 'GET', `/api/conversations/${b.body.id}`)).body.redacted, true, 'CONTROL: the read by id answers the tombstone');

    const run = await runOnce({ SCRUM_BOARD_URL: rest.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile });
    assert.equal(run.code, 0, `the runner ends clean: ${run.err}${run.out}`);
    assert.equal(ollama.calls.length, 1, `exactly one model call for the digest of both deliveries: ${ollama.calls.length}`);
    const prompt = ollama.calls[0].body;
    assert.ok(prompt.includes(VISIBLE), 'the prompt carries the visible post');
    assert.ok(prompt.includes(`ada: a visible post ${VISIBLE}`), 'and renders it as before (`author: body`)');
    const markers = prompt.match(/this post was redacted/gi) || [];
    assert.equal(markers.length, 1, `exactly ONE redacted marker, for the one redacted post: ${markers.length}\n${prompt.slice(prompt.indexOf('ada:') - 200, prompt.indexOf('ada:') + 400)}`);
    assert.ok(!/undefined/.test(prompt), `no "undefined" anywhere in the prompt: ${(prompt.match(/.{0,60}undefined.{0,60}/) || [''])[0]}`);
    assert.ok(!/: null/.test(prompt), `no ": null" anywhere in the prompt: ${(prompt.match(/.{0,60}: null.{0,60}/) || [''])[0]}`);
    assert.ok(!prompt.includes(SECRET), 'and none of the redacted post\'s text');
    const open = await api(rest.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1');
    assert.deepEqual((open.body.deliveries ?? []), [], `both deliveries are settled after the pass: ${open.text}`);
  } finally { await rest.stop(); await ollama.stop(); await killExecutor(exec); }
});
