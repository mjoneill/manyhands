/**
 * #1810 PR B — the service's adapters: the board's run record over REST (R12) and the OpenRouter model with the
 * model-call ledger (R13). Rows from the card (ROWS v2).
 *
 *   R12  the REST run-record adapter, against a REAL REST with a seat token: one procedure version per
 *        (chain, model key, prompt sha), one run per call with op "extract", performedUsing and used, the bearer
 *        header on every write and `by` the service actor; `generated` is a documented no-op (REST's route records
 *        artifacts, the run↔assertion link is scrum:ofRun in the graph); no token → the adapter refuses to start
 *   R13  the OpenRouter adapter: POSTs chat/completions with the key in the Authorization header (asserted present,
 *        never read), passes the body through so the ZDR fields reach the wire, parses choices[0].message.content as
 *        JSON, returns a non-200 untouched; every call lands ONE model-call row through the board adapter
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createRestBoard, createOpenRouterModel } from '../core/knowledge-extraction-adapters.mjs';

const TOK = mintToken();
let SRV, DIR;
before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-svc-1810-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const tokens = path.join(DIR, 'seat-tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ seats: { extractor: { credentials: [{ tokenHash: hashToken(TOK), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  SRV = await startRestServer({ env: { SCRUM_SEAT_TOKENS: tokens } });
});
after(async () => { await SRV?.stop(); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); });   // #1672: this file's own temp only

/** A fetch that records every request it saw and forwards to the real one. */
function recordingFetch(real = fetch) {
  const seen = [];
  const f = async (url, opts = {}) => { seen.push({ url: String(url), method: opts.method ?? 'GET', headers: { ...(opts.headers || {}) }, body: opts.body }); return real(url, opts); };
  return { seen, fetch: f };
}
const get = async (p) => (await fetch(`${SRV.baseUrl}${p}`)).json();

test('#1810 R12 — the REST run-record adapter: one version per (chain, model key, prompt sha), one run per call with op/performedUsing/used, bearer + by on every write; generated is a documented no-op; no token → refused to start', async () => {
  const rec = recordingFetch();
  const board = createRestBoard({ baseUrl: SRV.baseUrl, token: TOK, by: 'extractor', fetchImpl: rec.fetch });
  const v1 = await board.ensureProcedureVersion({ chain: 'kx-slice1', modelKey: 'deepseek-v4-flash', promptSha: 'a'.repeat(64) });
  const v1again = await board.ensureProcedureVersion({ chain: 'kx-slice1', modelKey: 'deepseek-v4-flash', promptSha: 'a'.repeat(64) });
  const v2 = await board.ensureProcedureVersion({ chain: 'kx-slice1', modelKey: 'fake-b', promptSha: 'a'.repeat(64) });
  assert.match(v1, /^https:\/\/scrumboard\.local\/procedure-version\//, 'a ProcedureVersion IRI');
  assert.equal(v1again, v1, 'the same (chain, model key, prompt sha) is the same version, not a second one');
  assert.notEqual(v2, v1, 'a different model key is a different version');
  const procs = await get('/api/procedures');
  const mine = procs.filter((p) => /kx-slice1/.test(p.name));
  assert.equal(mine.length, 1, `one procedure for the chain (${procs.map((p) => p.name)})`);
  assert.equal(mine[0].versions.length, 2, 'with two versions');
  assert.ok(mine[0].versions.every((v) => /model=/.test(v.body) && /prompt=sha256:a{64}/.test(v.body)), 'each version names its model key and prompt sha');

  const r1 = await board.createRun({ op: 'extract', by: 'extractor', performedUsing: v1, used: ['https://scrumboard.local/source/abc'] });
  const r2 = await board.createRun({ op: 'extract', by: 'extractor', performedUsing: v1, used: ['https://scrumboard.local/source/abc'] });
  assert.match(r1, /^https:\/\/scrumboard\.local\/activity\/run-/); assert.notEqual(r1, r2, 'two runs');
  const runs = (await get('/api/runs')).filter((r) => r.op === 'extract');
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.performedUsing, v1);
    assert.deepEqual(r.used, ['https://scrumboard.local/source/abc'], 'the source IRI is kept (as a literal: the run record does not hold the graph node)');
    assert.ok(r.wasAssociatedWith?.includes?.('extractor') || r.by === 'extractor' || JSON.stringify(r).includes('extractor'), `the run names the actor (${JSON.stringify(r).slice(0, 200)})`);
  }
  const writes = rec.seen.filter((x) => x.method === 'POST');
  assert.ok(writes.length >= 4, `procedures + versions + runs were written (${writes.length})`);
  for (const w of writes) {
    assert.match(w.headers.Authorization ?? w.headers.authorization ?? '', /^Bearer \S+$/, `every write carries the bearer (${w.url})`);
    assert.equal(JSON.parse(w.body).by, 'extractor', `every write declares by (${w.url})`);
  }
  const g = await board.generated({ run: r1, iris: ['https://scrumboard.local/assertion/x'] });
  assert.equal(g.recorded, false, 'generated is a no-op on REST');
  assert.match(g.reason, /ofRun|artifact/i, 'and says why');

  assert.throws(() => createRestBoard({ baseUrl: SRV.baseUrl, token: '', by: 'extractor' }), /token/, 'no token: refused to start, never an anonymous write');
  assert.throws(() => createRestBoard({ baseUrl: SRV.baseUrl, token: TOK, by: '' }), /by/, 'no actor: refused to start');
});

test('#1810 R13 — the OpenRouter adapter: chat/completions with the key in the header (present, never read), the body passed through, content parsed as JSON, a non-200 returned untouched', async () => {
  const wire = [];
  const fakeFetch = async (url, opts) => {
    wire.push({ url: String(url), headers: { ...(opts.headers || {}) }, body: JSON.parse(opts.body) });
    if (wire.length === 2) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    const content = JSON.stringify({ items: [{ block: 1, type: 'definition', span: 'A harness is the layer', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' }] });
    return new Response(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const rec = recordingFetch();
  const board = createRestBoard({ baseUrl: SRV.baseUrl, token: TOK, by: 'extractor', fetchImpl: rec.fetch });
  const model = createOpenRouterModel({ apiKey: 'sk-or-test-not-a-real-key', baseUrl: 'https://openrouter.test/api/v1', modelId: 'deepseek/deepseek-v4-flash-0731', fetchImpl: fakeFetch, ledger: board });

  const body = { model: 'deepseek-v4-flash', provider: { zdr: true, data_collection: 'deny' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } } };
  const r1 = await model.send(body);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json.items[0].subject, 'harness', 'content parsed as JSON');
  assert.equal(wire.length, 1);
  assert.equal(wire[0].url, 'https://openrouter.test/api/v1/chat/completions');
  assert.match(wire[0].headers.Authorization ?? wire[0].headers.authorization ?? '', /^Bearer \S+$/, 'the key travels in the header');
  assert.equal(wire[0].body.model, 'deepseek/deepseek-v4-flash-0731', 'the registry key is translated to the provider\'s model id');
  assert.deepEqual(wire[0].body.provider, { zdr: true, data_collection: 'deny' }, 'the ZDR fields reach the wire untouched');
  assert.deepEqual(wire[0].body.messages, body.messages);
  assert.ok(wire[0].body.response_format, 'the JSON schema travels too');

  const r2 = await model.send(body);
  assert.equal(r2.status, 429, 'a non-200 comes back as its status, not as an exception and not as a 200 with empty items');
  assert.equal(r2.json, null);

});

test('#1867 R13d — the OpenRouter adapter hands the provider\'s finish_reason back as stopReason (null when the provider sends none)', async () => {
  const finishes = ['error', 'stop', undefined];
  let n = 0;
  const fakeFetch = async () => {
    const finish_reason = finishes[n++];
    const content = JSON.stringify({ items: [] });
    return new Response(JSON.stringify({ id: `gen-${n}`, choices: [{ message: { role: 'assistant', content }, ...(finish_reason ? { finish_reason } : {}) }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const model = createOpenRouterModel({ apiKey: 'sk-or-test-not-a-real-key', baseUrl: 'https://openrouter.test/api/v1', modelId: 'm/x', fetchImpl: fakeFetch, ledger: null });
  const body = { model: 'm', messages: [{ role: 'user', content: 'u' }] };
  assert.equal((await model.send(body)).stopReason, 'error', 'the d530379c shape: a 200 that ended "error" says so');
  assert.equal((await model.send(body)).stopReason, 'stop');
  assert.equal((await model.send(body)).stopReason, null, 'no finish_reason → null, never invented');
});

test('#1810 R13b — every OpenRouter call, refused ones included, lands ONE model-call row with the usage, and the key never reaches the board', async () => {
  let n = 0;
  const fakeFetch = async () => {
    n += 1;
    if (n === 2) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: '{"items":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const rec = recordingFetch();
  const board = createRestBoard({ baseUrl: SRV.baseUrl, token: TOK, by: 'extractor', fetchImpl: rec.fetch });
  const model = createOpenRouterModel({ apiKey: 'sk-or-test-not-a-real-key', baseUrl: 'https://openrouter.test/api/v1', modelId: 'deepseek/deepseek-v4-flash-0731', fetchImpl: fakeFetch, ledger: board, by: 'extractor-r13b' });
  const body = { model: 'deepseek-v4-flash', provider: { zdr: true, data_collection: 'deny' }, messages: [{ role: 'user', content: 'u' }] };
  await model.send(body); await model.send(body);
  const calls = (await get('/api/model-calls')).calls.filter((c) => c.agent === 'extractor-r13b');
  assert.equal(calls.length, 2, `two ledger rows, one per call including the refused one (${calls.length})`);
  const ok = calls.find((c) => c.ok !== false && c.tokensIn === 120);
  assert.ok(ok, 'the 200 row carries the usage');
  assert.equal(ok.tokensOut, 40); assert.equal(ok.model, 'deepseek/deepseek-v4-flash-0731'); assert.equal(ok.provider, 'openrouter');
  const bad = calls.find((c) => c.ok === false);
  assert.ok(bad, 'the 429 is a row too, marked not ok'); assert.match(String(bad.error ?? ''), /429/);
  const ledgerWrites = rec.seen.filter((x) => /\/api\/model-calls$/.test(x.url) && x.method === 'POST');
  assert.equal(ledgerWrites.length, 2);
  for (const w of ledgerWrites) assert.ok(!JSON.stringify(w.body).includes('sk-or-test'), 'the key never reaches the board');
});

// #1843: production stores model calls in the graph (#1582), which REFUSES a row without a requestId. The document-mode
// server above accepts one, so R13b could not see the gap. This ledger refuses exactly as the graph path does.
test('#1843 R13c — every OpenRouter ledger row carries ONE requestId in the shape the graph ledger requires, distinct per call', async () => {
  const { REQUEST_ID_RE } = await import('../core/unit3-graph.mjs');
  const rows = []; const refused = [];
  const ledger = { async recordModelCall(row) {
    if (row.requestId == null || !REQUEST_ID_RE.test(row.requestId)) { refused.push(row); throw new Error('POST /api/model-calls → 400: requestId is required'); }
    rows.push(row);
  } };
  let n = 0;
  const fakeFetch = async () => {
    n += 1;
    if (n === 2) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: '{"items":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const model = createOpenRouterModel({ apiKey: 'sk-or-test-not-a-real-key', baseUrl: 'https://openrouter.test/api/v1', modelId: 'm/x', fetchImpl: fakeFetch, ledger });
  const body = { model: 'k', messages: [{ role: 'user', content: 'u' }] };
  await model.send(body); await model.send(body);
  assert.equal(refused.length, 0, `no row refused (${JSON.stringify(refused)})`);
  assert.equal(rows.length, 2, 'one row per call, the refused 429 included');
  assert.notEqual(rows[0].requestId, rows[1].requestId, 'two calls are two requestIds');
});
