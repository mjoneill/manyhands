/**
 * #1296 slice 1 — THE CACHE LEVER HAD NO GAUGE ON OUR SIDE OF THE WIRE.
 *
 * The largest affordability lever anyone identified this sprint is caching:
 * measured at a ~20% hit rate, meaning ~80% of every prompt is re-read at full
 * price, and prompt is 78–88% of every bill. It is worth more than any
 * participation change, because the same money buys more seats.
 *
 * ⛔ AND WE COULD NOT MEASURE WHETHER A CHANGE TO IT WORKED. Cached and
 * uncached prompt tokens were indistinguishable in our rows — the hit rate
 * existed on the provider's dashboard and NOWHERE in our own data. So "did the
 * caching work pay off" was a question exactly one human could answer, by
 * logging in and looking, once per change. That is not a metering gap. It is a
 * lever with no gauge attached.
 *
 * ⭐ AND UNLIKE #1294, THE HOLE STARTS AT THE ADAPTER. Reasoning was already
 * being read and died downstream; `prompt_tokens_details.cached_tokens` was
 * read by nothing, anywhere, so the number never entered the process at all.
 * That is why the first test here is an adapter test and the last is the whole
 * chain: a field the adapter never reads cannot be dropped by a later layer,
 * because there was never anything there to drop.
 *
 * ⚠️ SEMANTICS, because getting this wrong would corrupt the meter it builds:
 * cached_tokens is a SUBSET of prompt_tokens, not a fourth addend. The uncached
 * remainder is `tokensIn - cachedPromptTokens`, and it is NOT stored — a stored
 * difference cannot be audited back to the two figures the provider reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../core/model-adapter.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const MSGS = [{ role: 'user', content: 'what did the room decide' }];
const transportOf = (res) => async () => res;

const openaiRes = (usage) => ({
  status: 200,
  body: { choices: [{ message: { content: 'an answer' }, finish_reason: 'stop' }], usage },
  rawBody: '{}',
});

const OPENAI = { model: 'm', protocol: 'openai-completions', baseUrl: 'http://x' };

test('#1296 the ADAPTER reads the cached portion of the prompt', async () => {
  const out = await callModel(OPENAI, MSGS, {
    transport: transportOf(openaiRes({
      prompt_tokens: 10000, completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 8500 },
    })),
  });
  assert.equal(out.usage.promptTokens, 10000);
  assert.equal(out.usage.cachedPromptTokens, 8500,
    'the number exists on the wire and nothing was reading it');
  assert.equal(out.usage.promptTokens - out.usage.cachedPromptTokens, 1500,
    'the UNCACHED remainder is derivable — which is the figure a cache change moves');
});

test('#1296 ⛔ A PROVIDER THAT DOES NOT REPORT CACHING RECORDS null, NEVER 0', async () => {
  // Acceptance 3, and it is #1294's lesson carried forward: a 0 here would
  // read as "nothing was cached" — a perfect cache miss — when the truth is
  // "this provider never told us". Those are opposite conclusions about the
  // lever, and a zero is the one that would make a working cache look broken.
  const out = await callModel(OPENAI, MSGS, {
    transport: transportOf(openaiRes({ prompt_tokens: 10000, completion_tokens: 400 })),
  });
  assert.equal(out.usage.promptTokens, 10000, 'the categories it DID report still arrive');
  assert.equal(out.usage.cachedPromptTokens, null,
    'an uncounted category stays ABSENT — a 0 would claim a perfect cache miss the provider never reported');
});

test('#1296 a FULLY cached prompt records its zero-uncached remainder honestly', async () => {
  // ⭐ THE OTHER END, and it is the case a null/0 confusion destroys: here 0 IS
  // the right answer for the uncached remainder, and it must be reachable.
  const out = await callModel(OPENAI, MSGS, {
    transport: transportOf(openaiRes({
      prompt_tokens: 10000, completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 10000 },
    })),
  });
  assert.equal(out.usage.cachedPromptTokens, 10000);
  assert.equal(out.usage.promptTokens - out.usage.cachedPromptTokens, 0);
});

const api = async (base, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ROW = {
  by: 'ada', agent: 'gizmo', model: 'fake-9b', protocol: 'openai-completions',
  provider: 'https://openrouter.ai/api/v1', ok: true, at: '2026-09-07T22:00:00.000Z',
  tokensIn: 10000, tokensOut: 400, reasoningTokens: 1200,
};

test('#1296 SEAM: the cache figure survives POST, the wire, and the GRAPH', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, cachedPromptTokens: 8500 });
    assert.equal(made.status, 201, `the route must ACCEPT the field by name: ${JSON.stringify(made.body)}`);

    const list = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo');
    const row = (list.body.calls || list.body)[0];
    assert.equal(row.cachedPromptTokens, 8500, 'the READ side — the layer #1254 missed');
    assert.equal(row.tokensIn, 10000, 'and the cached figure is stored BESIDE tokensIn, never subtracted from it');

    // ⭐ THE QUESTION THE WHOLE CARD EXISTS FOR, asked of our OWN data:
    // what fraction of the prompt did we pay full price for?
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?c ?in ?cached WHERE {
        ?c a scrum:ModelCall ; scrum:tokensIn ?in ; scrum:cachedPromptTokens ?cached .
      }`,
      by: 'ada',
    });
    assert.equal(q.status, 200, `the query must run: ${JSON.stringify(q.body).slice(0, 300)}`);
    const rows = q.body.rows || q.body.bindings || [];
    assert.equal(rows.length, 1, 'the hit rate is now answerable from the ledger, not from a vendor login');
    const inTok = Number(rows[0].in?.value ?? rows[0].in);
    const cached = Number(rows[0].cached?.value ?? rows[0].cached);
    assert.equal(cached / inTok, 0.85);
  } finally { await srv.stop(); }
});

test('#1296 ⛔ a row from a provider that never reported caching reads back null', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/model-calls', ROW);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const list = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo');
    const row = (list.body.calls || list.body)[0];
    assert.equal(row.cachedPromptTokens, null,
      'absent must stay absent all the way to the reader — a 0 here would report a perfect cache miss nobody measured');

    // and a REPORTED zero must still be findable, or the genuine miss is invisible
    const zero = await api(srv.baseUrl, 'POST', '/api/model-calls', { ...ROW, agent: 'miss', cachedPromptTokens: 0 });
    assert.equal(zero.status, 201, JSON.stringify(zero.body));
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?c ?cached WHERE {
        ?c a scrum:ModelCall ; scrum:cachedPromptTokens ?cached .
        FILTER(?cached = 0)
      }`,
      by: 'ada',
    });
    const rows = q.body.rows || q.body.bindings || [];
    assert.equal(rows.length, 1,
      'a genuine 0% hit rate must be FOUND BY FILTERING ON ZERO — it is the reading that most demands action, and it must not be a query by absence');
  } finally { await srv.stop(); }
});

/**
 * ⛔ THE ONE THAT PROVES THE CHAIN. Everything above is reachable by calling
 * the adapter directly or hand-posting a row — and the chain between them is
 * exactly where #1294 broke, twice, in two different layers.
 *
 * A wake is N model calls (maxHops 8, ~2–4 measured), so the cached figure must
 * SUM across hops like the other three. Last-hop-wins would under-report the
 * cache by the number of hops — and would look perfectly correct in every
 * single-hop test above.
 */
test('#1296 SEAM: the REAL RUNNER sums the cache figure across hops and lands it on the board', async () => {
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  let turn = 0;
  const vendor = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      turn += 1;
      // Two paid turns: a tool hop, then the answer. Each reports its own
      // cached portion, and the ledger must carry the SUM (3000), not the last
      // one (2000) — the failure mode that hides behind every single-hop test.
      const message = turn === 1
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'card_get', arguments: '{"shortId":1}' } }] }
        : { role: 'assistant', content: 'REPLY: Card #1 is the one you asked about.' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }],
        usage: {
          prompt_tokens: turn === 1 ? 5000 : 6000,
          completion_tokens: turn === 1 ? 20 : 200,
          prompt_tokens_details: { cached_tokens: turn === 1 ? 1000 : 2000 },
        },
      }));
    });
  });
  await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cache-')), 'state.json');

  try {
    const call = (method, p, body) => api(srv.baseUrl, method, p, body);
    const card = await call('POST', '/api/cards', { title: 'a card worth reading', by: 'ada' });
    assert.equal(card.status, 201);
    const made = await call('POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Look things up before answering.',
      model: { model: 'fake', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${vendor.address().port}` },
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
    assert.equal(turn, 2, 'a tool call means a second paid turn');

    const rows = await call('GET', '/api/model-calls?agent=gizmo');
    const row = (rows.body.calls || rows.body)[0];
    assert.ok(row, 'a ledger row reached the board');
    assert.equal(row.tokensIn, 11000, 'prompt is summed across hops');
    assert.equal(row.cachedPromptTokens, 3000,
      `the cached portion must be SUMMED across hops, not last-hop-wins; got ${JSON.stringify(row.cachedPromptTokens)} `
      + '— 2000 means the last hop overwrote, null means it never left the process');
    assert.equal(row.tokensIn - row.cachedPromptTokens, 8000,
      'and the number a cache change actually moves — the full-price remainder — is derivable from our own ledger');
  } finally {
    await new Promise((r) => vendor.close(r));
    await srv.stop();
  }
});

/**
 * ⛔ AND THE LAYER THE MUTATION PASS CAUGHT UNCOVERED, which is the reason this
 * test exists at all.
 *
 * `sumUsage` in core/guest-loop.mjs adds the narration retry's usage to the
 * first call's. Deleting `cachedPromptTokens` from its key list left EVERY test
 * in this file green, and every existing guest-loop and tool-loop test too —
 * the same hole was already there for `reasoningTokens` from #1294 slice 2.
 *
 * The retry (#1246b) is a SECOND PAID TURN, taken on exactly the wakes that
 * cost most: the ones that announced a lookup, got nudged, and then went and
 * did the work. Dropping its usage under-bills the expensive tail specifically,
 * which is the worst possible place for a meter to be blind.
 */
test('#1296 ⛔ THE NARRATION RETRY IS A SECOND PAID TURN and its cache figure is summed too', async () => {
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  let turn = 0;
  const vendor = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      turn += 1;
      // Turn 1 ANNOUNCES a lookup and calls nothing — the #1246b trigger.
      // Turn 2 is the nudged retry, which answers. Both are billed.
      const message = turn === 1
        ? { role: 'assistant', content: 'REPLY: I will look up card 1 and get back to you.' }
        : { role: 'assistant', content: 'REPLY: Card #1 is the one you asked about.' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: turn === 1 ? 5000 : 7000,
          completion_tokens: turn === 1 ? 30 : 150,
          prompt_tokens_details: { cached_tokens: turn === 1 ? 1500 : 4500 },
        },
      }));
    });
  });
  await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-retry-')), 'state.json');

  try {
    const call = (method, p, body) => api(srv.baseUrl, method, p, body);
    assert.equal((await call('POST', '/api/cards', { title: 'a card worth reading', by: 'ada' })).status, 201);
    const made = await call('POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Look things up before answering.',
      model: { model: 'fake', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${vendor.address().port}` },
      residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'], by: 'ada',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call('POST', '/api/conversations', { author: 'ada', body: '@gizmo what does card 1 say?' })).status, 201);

    const run = await new Promise((resolve) => {
      const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', 'gizmo'], {
        env: { ...process.env, SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = ''; let err = '';
      p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
      p.on('close', (code) => resolve({ code, out, err }));
    });
    assert.equal(run.code, 0, run.err + run.out);

    const rows = await call('GET', '/api/model-calls?agent=gizmo');
    const row = (rows.body.calls || rows.body)[0];
    assert.ok(row, 'a ledger row reached the board');
    // ⭐ ANTI-VACUITY: if the nudge never fired there is only one turn, and the
    // sums below would be trivially satisfiable by a loop that never retried.
    assert.equal(turn, 2, 'precondition: the announced lookup must have triggered the nudge');
    // ⚠️ The nudge is confirmed from the runner's own log line, NOT from the
    // row — because `narrationRetry` never reaches the board at all. That is
    // [#1297], found by this precondition when it refused to pass: the loop
    // builds the field, the route accepts it, the graph projects it, and the
    // same row builder this card just widened does not send it. Deliberately
    // not fixed here; a card is not a licence to widen the diff.
    assert.match(run.err, /\[#1246b\].*nudged/,
      'precondition: the runner must report that it nudged — without this the sums below are satisfiable by a loop that never retried');

    assert.equal(row.tokensIn, 12000, 'the retry\'s prompt is billed');
    assert.equal(row.cachedPromptTokens, 6000,
      `the retry's cached portion must be summed; got ${JSON.stringify(row.cachedPromptTokens)} `
      + '— 1500 means only the first turn counted, 4500 means the retry overwrote it');
    assert.equal(row.reasoningTokens, null,
      'and a category neither turn reported is still ABSENT after summing — a sum must not manufacture a zero');
  } finally {
    await new Promise((r) => vendor.close(r));
    await srv.stop();
  }
});
