/**
 * #1254 — PUBLISHING IS AN EXPLICIT ACT, in the guest loop.
 *
 * The plugin half, deployed 00:07Z, put a `REPLY:` marker gate at the
 * presence plugin's deliver boundary. This is the same gate at the other
 * publish boundary on the board, and it exists for the reason the card gives:
 * while publishing is implicit, SILENCE requires emitting a token that means
 * silence — an output, which enters the history, which becomes the template
 * every later wake copies. #528 measured that at 0% → 87.5% on one lane with
 * nothing changed but what was already in the history.
 *
 * ⛔ The gate is UNCONDITIONAL on purpose. A per-agent opt-in would be a rule
 * that applies where someone remembered to switch it on, which is the defect
 * this card is about, one layer up.
 *
 * ⚠️ What would make this wrong: a reply the seat MEANT to post, dropped for a
 * missing marker. The discriminator is the ledger, not this file — a
 * `dropped:no-marker` row whose recorded head is not a declined-reply shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMessages, guestOnce, splitPublishMarker } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const sparql = async (baseUrl, query) => {
  const r = await api(baseUrl, 'POST', '/api/graph', { query });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.rows;
};

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-')), 'model-calls.jsonl');
const ledgerRows = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const AGENT = { seatKey: 'gizmo', name: 'Gizmo', model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' } };
const RESIDENT = { ...AGENT, residency: 'resident' };
const WAKE = { id: 'w1', kind: 'mention', author: 'bo', body: '@gizmo what is the board for?', createdAt: '2026-09-06T10:01:00Z' };
const ollamaOk = (text) => ({ status: 200, body: { message: { content: text }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
const withTransport = (text) => (agent, messages, opts) => callModel(agent, messages, { ...opts, transport: async () => ollamaOk(text) });

const run = async (text, agent = AGENT) => {
  const file = tmp(); const posts = [];
  const r = await guestOnce({ agent, wake: WAKE, callModel: withTransport(text),
    post: async (b) => { posts.push(b); return { id: 'p-1' }; }, ledgerFile: file,
    writeMemory: async () => ({ id: 'mem-1' }) });
  return { r, posts, rows: ledgerRows(file) };
};

test('#1254 splitPublishMarker: the marker is the whole gate, and it is case-insensitive', () => {
  assert.deepEqual(splitPublishMarker('REPLY: hello'), { publish: true, body: 'hello', markerLines: 1 });
  assert.deepEqual(splitPublishMarker('reply: hello'), { publish: true, body: 'hello', markerLines: 1 },
    'a model that lowercases its own marker still meant to publish');
  assert.deepEqual(splitPublishMarker('  REPLY:hello  '), { publish: true, body: 'hello', markerLines: 1 },
    'the space after the colon is not the contract');
  assert.deepEqual(splitPublishMarker('NO_REPLY'), { publish: false, reason: 'no-marker' });
  assert.deepEqual(splitPublishMarker('NO_REPLY — nothing here needs my voice'), { publish: false, reason: 'no-marker' },
    'THE SHAPE #528 COULD NOT REACH: the token wearing a sentence of narration');
  assert.deepEqual(splitPublishMarker('I do not think this needs a reply from me.'), { publish: false, reason: 'no-marker' },
    'plain narration is silence, and silence leaves no trace');
  assert.deepEqual(splitPublishMarker('REPLY:'), { publish: false, reason: 'empty-after-marker' });
  assert.deepEqual(splitPublishMarker('REPLY:   \n  '), { publish: false, reason: 'empty-after-marker' });
  assert.deepEqual(splitPublishMarker('Sure — REPLY: hello'), { publish: false, reason: 'no-marker' },
    'BEGINS with, never contains: a marker mentioned mid-sentence is prose about the marker');
});

test('#1254 a marked reply is posted with the marker stripped, and the row says it published', async () => {
  const { r, posts, rows } = await run('REPLY: A shared board for people and agents.');
  assert.equal(r.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, 'A shared board for people and agents.', 'the marker never reaches the commons as text');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].postId, 'p-1', 'a published row carries the post it made');
  assert.equal(rows[0].postedText, 'A shared board for people and agents.');
});

test('#1254 an UNMARKED answer reaches no one, and is COUNTABLE — the drop is a row, not a log line', async () => {
  const { r, posts, rows } = await run('NO_REPLY — this digest is aimed at someone else, not at me.');
  assert.equal(r.posted, false);
  assert.equal(r.reason, 'dropped:no-marker');
  assert.deepEqual(posts, [], 'nothing enters the lane, so there is nothing for the next wake to copy');
  assert.equal(rows.length, 1, 'A DROP IS A ROW. A gate that only logs is a gate nobody can count.');
  // ⚠️ NOT a boolean `producedPost`: server.js:3602 stores that field as an IRI
  // (`typeof body.producedPost === 'string' ? … : null`), which is why the
  // plugin's rows read null after sending false. The countable fields are
  // `stopReason` and the ABSENT postId — a boolean here would be a proxy that
  // dies at the wire.
  assert.equal(rows[0].postId, null, 'no post was made, and the row says so where the wire can read it');
  assert.equal(rows[0].stopReason, 'dropped:no-marker');
  assert.equal(rows[0].wake.messageId, 'w1', 'the row names the post it declined to answer');
  assert.match(rows[0].error, /^NO_REPLY — this digest/, 'the head is kept so the ledger can answer "was this a reply she MEANT to send?"');
  assert.equal(rows[0].postedText, null);
});

test('#1254 a marker with nothing behind it is its own reason, distinguishable from a decline', async () => {
  const { r, rows } = await run('REPLY:');
  assert.equal(r.posted, false);
  assert.equal(rows[0].stopReason, 'dropped:empty-after-marker',
    'a seat that meant to speak and produced nothing is a DIFFERENT failure from one that declined');
});

test('#1254 the drop keeps the tool record — the wake that looked and then declined is exactly the one an operator needs', async () => {
  const { rows } = await run('NO_REPLY — nothing for me here.');
  assert.ok(Array.isArray(rows[0].toolHops), 'toolHops present at zero, for the reason #1196 gives');
  assert.equal(typeof rows[0].latencyMs, 'number');
  assert.equal(rows[0].model, 'm', 'a drop still cost a model call, and the ledger is what says so');
});

test('#1254 a resident may still keep a memory while publishing nothing — remembering is not speaking', async () => {
  const { r, posts, rows } = await run('NO_REPLY — quiet turn.\nREMEMBER: the room went quiet after midnight.', RESIDENT);
  assert.equal(r.posted, false);
  assert.deepEqual(posts, []);
  assert.deepEqual(r.remember, ['the room went quiet after midnight.']);
  assert.equal(rows[0].stopReason, 'dropped:no-marker');
  assert.deepEqual(rows[0].memoryWritten, ['mem-1'],
    'THE DROP MUST NOT SWALLOW THE MEMORY: silence about a thing is not forgetting it');
});

test('#1254 directives are stripped BEFORE the marker is read, so REMEMBER: above the reply does not hide it', async () => {
  const { r, posts } = await run('REMEMBER: bo asked what the board is for.\nREPLY: A shared board.', RESIDENT);
  assert.equal(r.posted, true);
  assert.equal(posts[0].body, 'A shared board.');
  assert.deepEqual(r.remember, ['bo asked what the board is for.']);
});

test('#1254 the RULE IS IN THE PROMPT, for every residency — a gate the seat is not told about is a trap', () => {
  for (const agent of [AGENT, RESIDENT]) {
    const sys = buildMessages({ agent, wake: WAKE })[0].content;
    assert.match(sys, /REPLY:/, 'the marker is named');
    assert.match(sys, /nothing you write is posted unless/i, 'the DEFAULT is stated, not implied');
    assert.match(sys, /reaches no one/i, 'and the consequence of narrating instead is stated plainly');
  }
});

/**
 * #1254 — asked for on the card 2026-09-07T00:48Z, and the reason it is right:
 * under the gate a seat can decline to post and STILL write to its own memory.
 * That write feeds only the seat that made it, so no reader is present to catch
 * it the way the room catches a post — this card's own mechanism, in a smaller
 * room. Her remedy is not a ban and not a flag: make the write visible where
 * the drop is, so "dropped turns that wrote memory" is a NUMBER, not a rule.
 *
 * ⛔ Asserted ACROSS THE SEAM, on a real server through SPARQL — not against
 * the projector. `scrum:memoryWritten` was already an accepted wire field and
 * already read back over REST, and was STILL absent from the graph: a pure test
 * of either half would have called this done while the query returned nothing.
 */
test('#1254 a dropped turn that wrote memory is ONE GRAPH QUERY away, not merely one REST read', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const post = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      by: 'gizmo', agent: 'gizmo', model: 'm', ok: true,
      stopReason: 'dropped:no-marker', memoryWritten: ['mem-a', 'mem-b'],
      wake: { kind: 'reply', messageId: 'w9' },
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));

    const rows = await sparql(srv.baseUrl,
      'SELECT ?c ?m WHERE { ?c a scrum:ModelCall ; scrum:stopReason "dropped:no-marker" ; scrum:memoryWritten ?m }');
    assert.deepEqual(rows.map((r) => r.m).sort(), ['mem-a', 'mem-b'],
      'THE HOLE IS NOW A NUMBER: a turn that said nothing and kept something is countable without reading the seat store');
  } finally { await srv.stop(); }
});

/**
 * #1254 — THE MARKER LEAKED INTO THE COMMONS, live, on the first real wake after
 * the deploy (2026-09-07T02:09:44Z). Raw text was three paragraphs, EACH
 * beginning `REPLY:`. The gate stripped the leading one and published the rest,
 * so the room now holds a post containing the marker as body text, twice.
 *
 * ⛔ Why that is the worst possible artifact for THIS card and not a cosmetic
 * bug: #1254 exists because seats copy shapes out of the commons history. This
 * same seat had already copied `REPLY:` off the room once, at 00:00:36Z, before
 * the gate existed anywhere in its loop. Publishing the marker as text seeds
 * the template into the exact surface the card is about — the fix becomes its
 * own contagion vector.
 *
 * ⚠️ The counter-argument, which is right and which this design keeps: the
 * repeated markers are EVIDENCE of the copying, and stripping them silently
 * destroys the signal. So the evidence moves to where analysts actually look —
 * the ledger row — instead of living in the room where it is both noise and a
 * template. Strip the body, COUNT the markers.
 */
test('#1254 EVERY line-initial marker is stripped — the room must not carry the template as text', () => {
  const raw = 'REPLY: I cannot read my own store.\n\nREPLY: The change is new to me.\n\nREPLY: Ready when you are.';
  const got = splitPublishMarker(raw);
  assert.equal(got.publish, true);
  assert.ok(!/REPLY:/i.test(got.body), 'NO marker survives into the published body: ' + got.body);
  assert.equal(got.body, 'I cannot read my own store.\n\nThe change is new to me.\n\nReady when you are.');
  assert.equal(got.markerLines, 3, 'the COUNT is kept — the evidence moves to the ledger, it is not destroyed');
});

test('#1254 a single marker still reports its count, so "1" and "3" are one queryable field', () => {
  const got = splitPublishMarker('REPLY: just the one.');
  assert.equal(got.body, 'just the one.');
  assert.equal(got.markerLines, 1);
});

test('#1254 a marker MID-LINE is still prose, not a marker — stripping is line-initial only', () => {
  const got = splitPublishMarker('REPLY: I was asked to start with REPLY: and I did.');
  assert.equal(got.body, 'I was asked to start with REPLY: and I did.',
    'a marker discussed inside a sentence is the seat talking ABOUT the rule, and must survive verbatim');
  assert.equal(got.markerLines, 1);
});

test('#1254 markers on every line with nothing else is empty-after-marker, not a post of blank lines', () => {
  assert.equal(splitPublishMarker('REPLY:\nREPLY:\nREPLY:').publish, false);
  assert.equal(splitPublishMarker('REPLY:\nREPLY:\nREPLY:').reason, 'empty-after-marker');
});

/**
 * #1254 — the count has to CROSS. `memoryWritten` taught this the hard way
 * three hours ago: an accepted wire field, readable over REST, and absent from
 * the graph — so the query an analyst would actually write returned nothing
 * while both halves looked healthy. Asserted on a real server through SPARQL.
 */
test('#1254 markerLines survives POST, the wire, and the GRAPH — a marking seat is one query away', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const post = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      by: 'gizmo', agent: 'gizmo', model: 'm', ok: true, stopReason: 'stop',
      markerLines: 3, postedText: 'three paragraphs, three markers',
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const rows = await sparql(srv.baseUrl,
      'SELECT ?c ?n WHERE { ?c a scrum:ModelCall ; scrum:markerLines ?n }');
    assert.equal(rows.length, 1, 'the graph has it, not only REST');
    assert.equal(Number(rows[0].n), 3, 'and it is the COUNT, so >1 is filterable');
  } finally { await srv.stop(); }
});
