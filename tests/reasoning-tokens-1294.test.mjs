/**
 * #1294 slice 3 — REASONING IS A BILLED CATEGORY AND THE LEDGER HAD NO COLUMN
 * FOR IT.
 *
 * The vendor's own invoice for this board's one metered seat lists THREE
 * billed categories — Prompt, Completion, Reasoning — and the ledger carried
 * two. `core/model-adapter.mjs` reads `reasoningTokens` from both protocols
 * (ollama's `thinking`, OpenAI's `completion_tokens_details.reasoning_tokens`),
 * slice 2 taught `runToolLoop` to sum it across hops, and then
 * `rowToBoard` in scripts/guest-once.mjs built the POST body without it.
 *
 * ⇒ So every reasoning model on this board ledgered as if it did not think,
 * and the only way anyone could talk about reasoning volume was to DEDUCE it
 * from a blended vendor rate exceeding the completion rate. That deduction was
 * sound and it should not have been necessary: it is a column.
 *
 * ⛔ THE SHAPE OF THE DEFECT IS #1254's, THE THIRD TIME. A field is read by the
 * adapter, summed by the loop, dropped by the builder, unknown to the route,
 * and absent from the graph — and every layer in isolation is correct. So this
 * file asserts the JOIN and nothing else: the number the MODEL produced has to
 * come back out of the GRAPH, through the real runner, or it is not recorded.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: price it. Whether the vendor counts
 * reasoning INSIDE completionTokens or beside it is not established here, and
 * guessing would put a wrong number in the one place people trust. The row now
 * carries both figures, which is what makes that question answerable against
 * an invoice instead of arguable from a blended average.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (base, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ROW = {
  by: 'ada', agent: 'gizmo', model: 'fake-9b', protocol: 'ollama-native',
  provider: 'http://localhost:11434', ok: true, at: '2026-09-07T21:00:00.000Z',
  tokensIn: 1000, tokensOut: 500,
};

test('#1294 SEAM: reasoningTokens survives POST, the wire, and the GRAPH', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, reasoningTokens: 4096 });
    assert.equal(made.status, 201, `the route must ACCEPT the field by name — an unknown field is REFUSED here, so a builder that starts sending it would 400: ${JSON.stringify(made.body)}`);

    const list = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo');
    const row = (list.body.calls || list.body)[0];
    assert.ok(row, 'the row reads back');
    assert.equal(row.reasoningTokens, 4096, 'the READ side is the layer #1254 missed: accepted, projected, never returned');

    // and it must be QUERYABLE beside the other two, because the whole point is
    // to compare the three categories against a bill.
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?c ?in ?out ?reasoning WHERE {
        ?c a scrum:ModelCall ; scrum:tokensIn ?in ; scrum:tokensOut ?out ; scrum:reasoningTokens ?reasoning .
      }`,
      by: 'ada',
    });
    assert.equal(q.status, 200, `the query must run: ${JSON.stringify(q.body).slice(0, 300)}`);
    const rows = q.body.rows || q.body.bindings || [];
    assert.equal(rows.length, 1, 'the row is findable by the new predicate');
    assert.equal(Number(rows[0].reasoning?.value ?? rows[0].reasoning), 4096);
    assert.equal(Number(rows[0].out?.value ?? rows[0].out), 500,
      'and reasoning is stored BESIDE completion, never summed into it — a reader handed a pre-added number can never get the two back');
  } finally { await srv.stop(); }
});

test('#1294 ⛔ A MODEL THAT THOUGHT NOTHING RECORDS 0, AND THAT 0 IS FINDABLE', async () => {
  // The #1202/#1294 distinction, applied to the third category: "didn't think"
  // and "we didn't record whether it thought" are different facts. The adapter
  // already keeps them apart (0 when the protocol reported a thinking field,
  // null when it did not), so the projection must not collapse them — a zero
  // that can only be found by asking for a MISSING predicate is a zero nobody
  // finds, which is #1196's negation trap.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const zero = await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, reasoningTokens: 0 });
    assert.equal(zero.status, 201, JSON.stringify(zero.body));
    const unknown = await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, agent: 'nothink' });
    assert.equal(unknown.status, 201, JSON.stringify(unknown.body));

    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?c ?reasoning WHERE {
        ?c a scrum:ModelCall ; scrum:reasoningTokens ?reasoning .
        FILTER(?reasoning = 0)
      }`,
      by: 'ada',
    });
    assert.equal(q.status, 200, `the query must run: ${JSON.stringify(q.body).slice(0, 300)}`);
    const rows = q.body.rows || q.body.bindings || [];
    assert.equal(rows.length, 1, 'a reported zero must be FOUND BY FILTERING ON ZERO — and only the reported one, not the unrecorded one');

    const nothink = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=nothink')).body;
    const row = (nothink.calls || nothink)[0];
    assert.equal(row.reasoningTokens, null,
      'a row that never reported reasoning must read back null, not a 0 it never measured');
  } finally { await srv.stop(); }
});

/**
 * ⛔ THE TEST THAT WOULD HAVE CAUGHT IT, and the two above would not have.
 *
 * Everything above asserts the BOARD's layers, and every one of them was
 * reachable by hand-posting a row. The actual defect was one line further out:
 * the runner's `rowToBoard` built the POST body from `row.usage` and never
 * named this field, so the number the model produced died in the process that
 * measured it. A ledger the server accepts and the runner never sends is
 * indistinguishable from a model that never thought.
 *
 * So this spawns the REAL runner the way launchd does, against a real board and
 * a fake model that DOES report thinking, and asserts the only thing that
 * matters: what the model produced is on the board afterwards.
 */
test('#1294 SEAM: the REAL RUNNER carries the model\'s reasoning to the board', async () => {
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  // ~30 words of "thinking" — the ollama adapter approximates from the text, so
  // the assertion below is > 0, never an exact count: the point is that a
  // non-zero reached the board, not that we reproduced its tokeniser.
  const THINKING = 'The question asks about card one. I should answer directly rather than looking anything up, because the mention already contains what I need to say back to them here.';
  const seen = [];
  const ollama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'fake', done: true, done_reason: 'stop',
        message: { role: 'assistant', content: 'REPLY: Card #1 is the one you asked about.', thinking: THINKING },
        prompt_eval_count: 120, eval_count: 40,
      }));
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reasoning-')), 'state.json');

  try {
    const call = (method, p, body) => api(srv.baseUrl, method, p, body);
    const made = await call('POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Answer the room.',
      model: { model: 'fake', protocol: 'ollama-native', baseUrl: `http://127.0.0.1:${ollama.address().port}`, thinking: true },
      residency: 'guest', contextPolicy: 'artifact-only', by: 'ada',
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
    assert.ok(seen.length >= 1, 'the model was called');

    const rows = await call('GET', '/api/model-calls?agent=gizmo');
    const row = (rows.body.calls || rows.body)[0];
    assert.ok(row, 'a ledger row reached the board');
    assert.equal(row.tokensIn, 120, 'the two categories that already worked still work');
    assert.equal(row.tokensOut, 40);
    assert.ok(row.reasoningTokens > 0,
      `the model reported thinking and the row must say so; got ${JSON.stringify(row.reasoningTokens)} — a null here is the defect this card is about, and it is INDISTINGUISHABLE from a model that never thought`);
  } finally {
    await new Promise((r) => ollama.close(r));
    await srv.stop();
  }
});
