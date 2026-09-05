/**
 * #1197 — A MODEL IS A GRAPH NODE, AND THE PROBE MEASURES ITS STATUS CLASS.
 *
 * Done-when, verbatim: a model registered from Settings appears as
 * `?m a scrum:Model` with every field, and the probe distinguishes the four
 * status classes on a live provider with the fake-id control in the same
 * output. The "live provider" here is a stub HTTP server that answers the
 * four classes by model id — the classes are what #840 verified on the real
 * one, and the point under test is that the probe READS them, not that the
 * provider emits them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { probeModel } from '../core/model-adapter.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const sparql = async (baseUrl, query) => { const r = await api(baseUrl, 'POST', '/api/graph', { query }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.rows; };

/** A provider that answers by MODEL ID: the four classes #840 measured, plus a real answer. */
async function startProvider() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ model: body.model, auth: req.headers.authorization ?? null, path: req.url });
      const m = String(body.model);
      if (m.startsWith('retired')) { res.writeHead(410, { 'Content-Type': 'text/plain' }); return res.end('model retired 2026-01-01'); }
      if (m.startsWith('locked')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('invalid api key'); }
      if (m.startsWith('gated')) { res.writeHead(404, { 'Content-Type': 'application/problem+json' }); return res.end(JSON.stringify({ title: 'not entitled', detail: 'your tier cannot use this model' })); }
      if (m.startsWith('no-such-model')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end(`model "${m}" not found`); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'pong' }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, stop: () => new Promise((r) => srv.close(r)) };
}

const FIELDS = {
  key: 'gemma3-12b', name: 'Gemma 3 12B', model: 'gemma3:12b', provider: 'ollama', protocol: 'ollama-native', baseUrl: 'http://localhost:11434',
  apiKeyRef: null, contextWindow: 131072, numCtx: 32768, thinking: false, maxOutputTokens: 800, timeoutMs: 120000,
  costIn: 0, costOut: 0, freeTier: true, capabilities: ['jsonSchema', 'images'], deprecatesOn: '2027-01-01', by: 'ada',
};

test('#1197 register → `?m a scrum:Model` returns it with EVERY field; a duplicate key is refused; a key VALUE is refused', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(srv.baseUrl, 'POST', '/api/models', FIELDS);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.key, 'gemma3-12b'); assert.deepEqual(c.body.capabilities, ['jsonSchema', 'images']); assert.equal(c.body.freeTier, true);
    const dup = await api(srv.baseUrl, 'POST', '/api/models', FIELDS);
    assert.equal(dup.status, 409, 'registering it again would fork its probe history');
    const leak = await api(srv.baseUrl, 'POST', '/api/models', { ...FIELDS, key: 'leaky', apiKey: 'sk-live-abc' });
    assert.equal(leak.status, 400); assert.match(leak.body.error, /snapshotted/);
    const badRef = await api(srv.baseUrl, 'POST', '/api/models', { ...FIELDS, key: 'badref', apiKeyRef: 'sk-live-abc' });
    assert.equal(badRef.status, 400, 'a value-shaped apiKeyRef is a key in a hat');
    const badProto = await api(srv.baseUrl, 'POST', '/api/models', { ...FIELDS, key: 'badproto', protocol: 'carrier-pigeon' });
    assert.equal(badProto.status, 400);

    const rows = await sparql(srv.baseUrl, `SELECT ?m ?p ?o WHERE { ?m a scrum:Model ; ?p ?o }`);
    const got = Object.fromEntries(rows.map((r) => [r.p, r.o]));
    const want = {
      'scrum:modelKey': 'gemma3-12b', 'schema:name': 'Gemma 3 12B', 'scrum:model': 'gemma3:12b', 'scrum:provider': 'ollama', 'scrum:protocol': 'ollama-native',
      'scrum:baseUrl': 'http://localhost:11434', 'scrum:contextWindow': '131072', 'scrum:numCtx': '32768', 'scrum:thinking': 'false', 'scrum:maxOutputTokens': '800',
      'scrum:timeoutMs': '120000', 'scrum:costIn': '0', 'scrum:costOut': '0', 'scrum:freeTier': 'true', 'scrum:deprecatesOn': '2027-01-01',
    };
    for (const [p, v] of Object.entries(want)) assert.equal(got[p], v, `${p} should be ${v}, got ${got[p]} (all: ${JSON.stringify(got)})`);
    const caps = rows.filter((r) => r.p === 'scrum:capability').map((r) => r.o).sort();
    assert.deepEqual(caps, ['images', 'jsonSchema']);
    assert.equal(got['scrum:apiKeyRef'], undefined, 'no ref was given, so none is projected');
  } finally { await srv.stop(); }
});

test('#1197 the probe distinguishes the four status classes, each beside its fake-id CONTROL, and the last class rides the node', async () => {
  const provider = await startProvider();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const reg = async (key, model) => { const r = await api(srv.baseUrl, 'POST', '/api/models', { key, model, protocol: 'ollama-native', baseUrl: provider.url, by: 'ada' }); assert.equal(r.status, 201, JSON.stringify(r.body)); };
    await reg('live', 'gemma3:12b'); await reg('old', 'retired-1'); await reg('auth', 'locked-1'); await reg('tier', 'gated-1'); await reg('typo', 'no-such-model-typo');
    const expect = { live: ['answers', 200], old: ['retired', 410], auth: ['exists-auth-gated', 401], tier: ['entitlement', 404], typo: ['no-such-id', 404] };
    for (const [key, [klass, status]] of Object.entries(expect)) {
      const p = await api(srv.baseUrl, 'POST', `/api/models/${key}/probe`, { by: 'ada' });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.real.klass, klass, `${key}: ${JSON.stringify(p.body.real)}`);
      assert.equal(p.body.real.status, status);
      assert.equal(p.body.control.klass, 'no-such-id', 'the control is in the SAME output and reads as absence');
      assert.match(p.body.control.model, /^no-such-model-/);
      assert.equal(p.body.controlReadable, true);
      assert.equal(typeof p.body.real.bodyHead, 'string', 'the body head travels — #838 was a discarded 410 body');
    }
    // 410's body carries the EOL date; a probe that dropped it would re-create #838.
    const old = await api(srv.baseUrl, 'POST', '/api/models/old/probe', {});
    assert.match(old.body.real.bodyHead, /2026-01-01/);
    // The probe was a ONE-token request, so it cannot bill a real answer.
    const live = provider.seen.find((s) => s.model === 'gemma3:12b');
    assert.ok(live, 'the live id was actually sent');
    const rows = await sparql(srv.baseUrl, `SELECT ?k ?c ?s WHERE { ?m a scrum:Model ; scrum:modelKey ?k ; scrum:lastProbeClass ?c ; scrum:lastProbeStatus ?s }`);
    const byKey = Object.fromEntries(rows.map((r) => [r.k, [r.c, r.s]]));
    assert.deepEqual(byKey.old, ['retired', '410']); assert.deepEqual(byKey.live, ['answers', '200']);
    assert.equal(Object.keys(byKey).length, 5, '"which models answered, last time anyone asked" is one query');
    const missing = await api(srv.baseUrl, 'POST', '/api/models/nope/probe', {});
    assert.equal(missing.status, 404);
  } finally { await srv.stop(); await provider.stop(); }
});

test('#1197 probeModel sends the REFERENCED key as a bearer and never echoes it; an unreachable base is a class, not a throw', async () => {
  const provider = await startProvider();
  try {
    const r = await probeModel({ model: 'x', protocol: 'ollama-native', baseUrl: provider.url }, { apiKey: 'sk-test-value' });
    assert.equal(r.klass, 'answers');
    assert.equal(provider.seen[0].auth, 'Bearer sk-test-value');
    assert.ok(!JSON.stringify(r).includes('sk-test-value'), 'the probe result must not carry the key');
    const dead = await probeModel({ model: 'x', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:9' }, { timeoutMs: 2000 });
    assert.equal(dead.klass, 'unreachable'); assert.equal(dead.status, null);
    const bad = await probeModel({ model: 'x', protocol: 'smoke-signal' });
    assert.equal(bad.klass, 'unknown-protocol');
  } finally { await provider.stop(); }
});

test('#1197 an agent may name a registered model by KEY: its spec is derived from the node and `scrum:usesModel` links them; an unregistered key is refused', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(srv.baseUrl, 'POST', '/api/models', { ...FIELDS, apiKeyRef: 'GEMMA_KEY' });
    const bad = await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'p', modelKey: 'nope', by: 'ada' });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /not a registered model/);
    const a = await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'p', modelKey: 'gemma3-12b', by: 'ada' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.modelId, 'gemma3:12b'); assert.equal(a.body.model.protocol, 'ollama-native'); assert.equal(a.body.model.apiKeyRef, 'GEMMA_KEY');
    assert.equal(a.body.model.sampling.maxTokens, 800); assert.equal(a.body.model.timeoutMs, 120000);
    assert.match(a.body.usesModel, /\/model\/gemma3-12b$/);
    const rows = await sparql(srv.baseUrl, `SELECT ?k ?ctx WHERE { ?a a scrum:Agent ; scrum:seatKey "gizmo" ; scrum:usesModel ?m . ?m scrum:modelKey ?k ; scrum:contextWindow ?ctx }`);
    assert.equal(rows.length, 1, 'the agent → model join answers in ONE query'); assert.equal(rows[0].k, 'gemma3-12b'); assert.equal(rows[0].ctx, '131072');
    const patched = await api(srv.baseUrl, 'PATCH', '/api/models/gemma3-12b', { contextWindow: 65536, by: 'ada' });
    assert.equal(patched.status, 200); assert.equal(patched.body.contextWindow, 65536);
  } finally { await srv.stop(); }
});
