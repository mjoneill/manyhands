/**
 * #1196 — THE TOOL RECORD MUST REACH THE BOARD, NOT A FILE BESIDE THE RUNNER.
 *
 * ⛔ THIS IS THE THIRD TIME TONIGHT THE SAME SEAM WENT UNCROSSED, each time one
 * layer up. A pure loop with pure tests; then a tool surface whose fakes never
 * looked at a path string while two of three tools 404'd; and then this — the
 * hops recorded to the runner's local JSONL, asserted there by my own tests,
 * while the board's ledger route REFUSED them by name and the graph had no
 * predicate to hold them. The record existed and nothing could read it.
 *
 * So this file asserts the JOIN, end to end and generically: a row carrying the
 * tool record is POSTed through a REAL server, read back on the wire, and then
 * read again THROUGH THE GRAPH — because a field that survives the first two
 * and dies at projection is still a field nobody can query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ROW = {
  by: 'ada', agent: 'gizmo', model: 'fake-9b', protocol: 'ollama-native', provider: 'http://localhost:11434',
  ok: true, at: '2026-09-06T12:40:00.000Z', latencyMs: 1234,
  toolsGranted: ['card_get', 'board_search'],
  modelCalls: 3,
  stoppedBecause: 'answered',
  postedText: 'Card #858 is about the vocabulary gap.',
  toolHops: [
    { id: 'c1', name: 'board_search', arguments: { q: 'vocabulary', k: 8 }, ok: true, rowCount: 8 },
    { id: 'c2', name: 'card_get', arguments: { shortId: 858 }, ok: true, rowCount: 1 },
  ],
};

async function api(base, method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('#1196 SEAM: the tool record survives POST, the wire, and the GRAPH', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', ROW);
    assert.equal(made.status, 201, `the route must ACCEPT the tool record: ${JSON.stringify(made.body)}`);

    // 1. the wire form carries it back
    const list = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo');
    const row = (list.body.calls || list.body)[0];
    assert.ok(row, 'the row reads back');
    assert.deepEqual(row.toolsGranted, ['card_get', 'board_search']);
    assert.equal(row.modelCalls, 3);
    assert.equal(row.stoppedBecause, 'answered');
    assert.equal(row.toolHops.length, 2);
    assert.equal(row.toolHops[1].name, 'card_get');
    assert.equal(row.toolHops[1].rowCount, 1, 'HOW MANY rows came back must survive: it is the number that makes a claim checkable');

    // 2. and the GRAPH can answer the question the whole epic is for
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?tool ?rows ?hops WHERE {
        ?c a scrum:ModelCall ; scrum:toolCalled ?tool ; scrum:toolRowsReturned ?rows ; scrum:toolHops ?hops .
      }`,
      by: 'ada',
    });
    assert.equal(q.status, 200, `graph query must run: ${JSON.stringify(q.body)}`);
    const bindings = q.body.rows || q.body.bindings || q.body.results?.bindings || [];
    assert.ok(bindings.length, `the tool record must be PROJECTED, not merely stored: ${JSON.stringify(q.body).slice(0, 300)}`);
    const tools = bindings.map((b) => String(b.tool?.value ?? b.tool)).sort();
    assert.deepEqual([...new Set(tools)], ['board_search', 'card_get']);
  } finally { await srv.stop(); }
});

test('#1196 SEAM: an unknown field is still REFUSED BY NAME — widening the record must not widen the door', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const bad = await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, toolHopz: [] });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body?.error), /toolHopz/, 'the refusal names the field');
  } finally { await srv.stop(); }
});

test('#1196 SEAM: zero rows and a posted answer land on ONE row, which is the pair nothing could see before', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      ...ROW,
      postedText: 'The migration finished last Tuesday.',
      toolHops: [{ id: 'c1', name: 'board_search', arguments: { q: 'migration' }, ok: true, rowCount: 0 }],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?rows WHERE { ?c a scrum:ModelCall ; scrum:toolRowsReturned ?rows . }',
      by: 'ada',
    });
    const bindings = q.body.rows || q.body.bindings || q.body.results?.bindings || [];
    assert.ok(bindings.length, 'a wake that fetched NOTHING must still be queryable — that is the case worth finding');
    assert.equal(Number(bindings[0].rows?.value ?? bindings[0].rows), 0, 'a wake that fetched nothing reads back as zero, not as absent');
  } finally { await srv.stop(); }
});

/**
 * ⛔ THE CHECK THAT WOULD HAVE CAUGHT IT. Reviewing the previous commit found
 * that the runner never passed an executor to the loop, so on the live path
 * `useTools` was false no matter what an agent was granted — the tools existed,
 * the grants existed, and nothing could run. Every test passed, because every
 * test called the loop directly and handed it an executor itself.
 *
 * This spawns the REAL runner the way launchd does, against a real board and a
 * fake model, and asserts what only the live path can prove: the tools were
 * offered on the wire, the tool actually ran, and the record reached the board.
 */
test('#1196 SEAM: the REAL RUNNER offers tools, runs them, and the record lands on the board', async () => {
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const seen = [];
  let turn = 0;
  const ollama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      turn += 1;
      const reply = turn === 1
        ? { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'card_get', arguments: { shortId: 1 } } }] }, done_reason: 'stop' }
        : { message: { role: 'assistant', content: 'REPLY: Card #1 is the one you asked about.' }, done_reason: 'stop' };   // #1254 — a fixture that means to publish says so
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', ...reply, done: true, prompt_eval_count: 10, eval_count: 5 }));
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-tools-')), 'state.json');

  try {
    const call = async (method, p, body) => {
      const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const card = await call('POST', '/api/cards', { title: 'a card worth reading', by: 'ada' });
    assert.equal(card.status, 201);
    const made = await call('POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Look things up before answering.',
      model: { model: 'fake', protocol: 'ollama-native', baseUrl: `http://127.0.0.1:${ollama.address().port}` },
      residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'], by: 'ada',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const mention = await call('POST', '/api/conversations', { author: 'ada', body: '@gizmo what does card 1 say?' });
    assert.equal(mention.status, 201);

    const run = await new Promise((resolve) => {
      const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', 'gizmo'], {
        env: { ...process.env, SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = ''; let err = '';
      p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
      p.on('close', (code) => resolve({ code, out, err }));
    });
    assert.equal(run.code, 0, run.err + run.out);

    // 1. tools were OFFERED on the wire — the failure that hid behind green tests
    assert.ok(seen.length >= 1, 'the model was called');
    assert.ok(Array.isArray(seen[0].tools) && seen[0].tools.length, `the runner must OFFER the granted tools; got ${JSON.stringify(seen[0].tools)}`);
    assert.equal(seen[0].tools[0].function.name, 'card_get');
    // 2. the tool actually RAN, so there was a second turn
    assert.equal(seen.length, 2, 'a tool call means a second model call');
    // 3. and the record reached the BOARD, not just a file beside the runner
    const rows = await call('GET', '/api/model-calls?agent=gizmo');
    const row = (rows.body.calls || rows.body)[0];
    assert.ok(row, 'a ledger row reached the board');
    assert.deepEqual(row.toolsGranted, ['card_get']);
    assert.equal(row.toolHops.length, 1);
    assert.equal(row.toolHops[0].name, 'card_get');
    assert.equal(row.toolHops[0].ok, true);
    assert.equal(row.modelCalls, 2);
    assert.match(String(row.postedText), /Card #1/);
  } finally {
    await new Promise((r) => ollama.close(r));
    await srv.stop();
  }
});

test('#1196 SEAM: a wake that NEVER LOOKED is queryable as zero, not as absence', async () => {
  // ⛔ Found in review, and it is the negation trap: the projection emitted
  // toolHops only when there were hops, so the single most important question
  // this record exists to answer — "which wakes answered WITHOUT looking" — was
  // a query by ABSENCE rather than by value. A reader would have to know to ask
  // for the missing predicate, and a zero that cannot be filtered on is a zero
  // nobody finds. The whole point of the record is the pair "no rows, confident
  // answer"; that pair lives in the rows with NO hops.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      ...ROW, toolHops: [], modelCalls: 1, stoppedBecause: 'answered',
      postedText: 'The apex card is #73.',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?c ?hops ?rows WHERE {
        ?c a scrum:ModelCall ; scrum:toolHops ?hops ; scrum:toolRowsReturned ?rows .
        FILTER(?hops = 0)
      }`,
      by: 'ada',
    });
    assert.equal(q.status, 200, `the query must run: ${JSON.stringify(q.body).slice(0, 300)}`);
    const rows = q.body.rows || q.body.bindings || [];
    assert.ok(rows.length, 'a wake with no hops must be FOUND BY FILTERING ON ZERO, not by asking for a missing predicate');
    assert.equal(Number(rows[0].hops?.value ?? rows[0].hops), 0);
    assert.equal(Number(rows[0].rows?.value ?? rows[0].rows), 0);
  } finally { await srv.stop(); }
});

/**
 * #1246 — the contradiction must cross the SAME seam. A detector whose verdict
 * lives only in the runner's log is a verdict nobody can query, which is the
 * failure this file was written for one card earlier.
 */
test('#1246 SEAM: a claimed lookup from a zero-hop wake survives POST, the wire, and the GRAPH', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      ...ROW,
      toolHops: [], modelCalls: 1, postedText: 'I have read the genesis prompt.',
      unbackedLookupClaims: [{ verb: 'read', phrase: 'I have read', index: 0 }],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const list = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo');
    const row = (list.body.calls || list.body)[0];
    assert.equal(row.unbackedLookupClaims.length, 1, 'the verdict reads back on the wire');
    assert.equal(row.unbackedLookupClaims[0].verb, 'read', 'and it reads back in the shape it was written');

    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?n ?verb WHERE {
        ?c a scrum:ModelCall ; scrum:unbackedLookupClaims ?n ; scrum:claimedLookup ?verb .
      }`,
      by: 'ada',
    });
    const bindings = q.body.rows || q.body.bindings || [];
    assert.ok(bindings.length, `the verdict must be PROJECTED, not merely stored: ${JSON.stringify(q.body).slice(0, 300)}`);
    assert.equal(Number(bindings[0].n?.value ?? bindings[0].n), 1);
    assert.equal(String(bindings[0].verb?.value ?? bindings[0].verb), 'read');
  } finally { await srv.stop(); }
});

test('#1246 SEAM: a CLEAN wake is queryable too — zero, not absent', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, unbackedLookupClaims: [] });
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?n WHERE { ?c a scrum:ModelCall ; scrum:unbackedLookupClaims ?n . }',
      by: 'ada',
    });
    const bindings = q.body.rows || q.body.bindings || [];
    // ⛔ Without this, "how often does this happen" has no denominator: only the
    // flagged rows would exist, and a rate needs the clean ones to be countable.
    assert.ok(bindings.length, 'a clean wake must be findable, or the flagged ones have nothing to be a rate OF');
    assert.equal(Number(bindings[0].n?.value ?? bindings[0].n), 0);
  } finally { await srv.stop(); }
});
