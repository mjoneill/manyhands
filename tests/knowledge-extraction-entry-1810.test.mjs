/**
 * #1810 PR B — R14: the service entry, `scripts/extract-once.mjs`, as launchd runs it.
 *
 * One tick per launch, in the shape of the board's existing guest-wake job: the key arrives in the ENVIRONMENT (the plist loads it from the
 * Keychain into OPENROUTER_API_KEY; no value in any file), the board url and the seat-token file in env, the model
 * resolved from the board's registry by key (its provider model id and base url), the cursor and the fetched bytes in
 * files the env names. It is spawned here as a CHILD against a real REST (with a seat token), a scratch executor, a
 * fake OpenRouter (an HTTP server) and a fake article server; nothing here reaches the network.
 *
 *   R14   one shared link → one tick processes it end to end: exit 0, a JSON summary on stdout naming the job, a
 *         run on the board, a model-call row, assertions in the graph for the Source, the cursor persisted; a second
 *         launch does nothing and exits 0
 *   R14b  without OPENROUTER_API_KEY the entry exits non-zero, names the VARIABLE on stderr (never a value), and no
 *         request reached the fake provider or the article server
 *   R14c  the launchd template names the Keychain item, the entry and the env variables, and carries no secret, no
 *         home path and no seat name
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRestServer } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'scripts', 'extract-once.mjs');
const TEMPLATE = path.join(ROOT, 'scripts', 'launchd', 'com.scrumboard.extractor.plist.template');
const RS = 'https://scrumboard.local/ns#';
const ARTICLE = ['What is a harness?', 'A harness is the layer between a model and the world.', 'Tools are how it acts.'].join('\n');

/** A server that answers like OpenRouter's chat/completions and counts what it saw. */
async function fakeProvider() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ? 'present' : 'absent', body: JSON.parse(raw || '{}') });
      const content = JSON.stringify({ title: 'What is a harness?', synopsis: 'An article on harnesses and the tools a model reaches through them.', items: [{ block: 1, type: 'definition', span: 'A harness is the layer between a model and the world.', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' }] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 30 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}/api/v1`, seen, stop: () => new Promise((r) => srv.close(r)) };
}
/** A server that serves the article at one path and counts fetches. */
async function fakeSite() {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits += 1; if (req.url === '/articles/harness') { res.setHeader('content-type', 'text/plain'); res.end(ARTICLE); } else { res.statusCode = 404; res.end('no'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/articles/harness`, hits: () => hits, stop: () => new Promise((r) => srv.close(r)) };
}
/** R14d: the same article behind a NAME. Bound to whatever `localhost` resolves to FIRST here, so the entry's real lookup path runs. */
async function fakeSiteByName() {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits += 1; if (req.url === '/articles/harness') { res.setHeader('content-type', 'text/plain'); res.end(ARTICLE); } else { res.statusCode = 404; res.end('no'); } });
  const [first] = await dns.lookup('localhost', { all: true, verbatim: true });
  await new Promise((r) => srv.listen(0, first.address, r));
  return { url: `http://localhost:${srv.address().port}/articles/harness`, hits: () => hits, stop: () => new Promise((r) => srv.close(r)) };
}

const TOK = mintToken();
let exec, client, SRV, provider, site, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-entry-1810-'));
  STORE = tmpStore('kx-entry-');   // retained so after() can remove it, whether or not the executor started
  exec = await startExecutor({ store: STORE, datasetId: 'kx-entry', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kx-entry', timeoutMs: 30000 });
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const tokens = path.join(DIR, 'seat-tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ seats: { extractor: { credentials: [{ tokenHash: hashToken(TOK), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  fs.writeFileSync(path.join(DIR, 'seat-token'), TOK);
  SRV = await startRestServer({ env: { SCRUM_SEAT_TOKENS: tokens } });
  provider = await fakeProvider(); site = await fakeSite();
  // the registry entry the entry resolves its key through (the board's model registry, #1197)
  const reg = await fetch(`${SRV.baseUrl}/api/models`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOK}` },
    body: JSON.stringify({ key: 'fake-flash', name: 'Fake Flash', model: 'fake/fake-flash-0001', provider: 'openrouter', baseUrl: provider.base, protocol: 'openai-completions', apiKeyRef: 'OPENROUTER_API_KEY', by: 'extractor' }) });
  assert.ok(reg.ok, `registry entry created (${reg.status} ${await reg.text()})`);
  // the writer's allow-list comes from the predicate registry; the generic relation must be registered on this board
  const pred = await fetch(`${SRV.baseUrl}/api/predicates`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOK}` },
    body: JSON.stringify({ name: 'scrum:relatedTo', definition: 'SEE ALSO (test registration for R14)', by: 'extractor' }) });
  assert.ok(pred.ok, `predicate registered (${pred.status} ${await pred.text()})`);
});
after(async () => { await SRV?.stop(); await provider?.stop(); await site?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); if (STORE) fs.rmSync(STORE, { recursive: true, force: true }); });   // #1672: store included

const baseEnv = () => ({
  PATH: process.env.PATH, HOME: process.env.HOME,
  SCRUM_BOARD_URL: SRV.baseUrl, SCRUM_SEAT_TOKEN_FILE: path.join(DIR, 'seat-token'),
  SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_DATASET_ID: 'kx-entry',
  SCRUM_EXTRACT_STATE_FILE: path.join(DIR, 'extract-state.json'), SCRUM_EXTRACT_SOURCES_DIR: path.join(DIR, 'sources'),
  SCRUM_EXTRACT_MODEL_KEY: 'fake-flash', SCRUM_EXTRACT_SHARERS: 'person-a',
  SCRUM_EXTRACT_ALLOW_HTTP_SOURCES: '1', SCRUM_EXTRACT_ALLOW_PRIVATE_SOURCES: '1',   // the fake article server is plain http on loopback; production never sets these
});
// ASYNC on purpose: the fake provider and article servers live in THIS process, and a spawnSync would block the event
// loop they answer on (measured: the child's fetch timed out against a server that never got to run)
const run = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
});
const q = async (s) => { const r = await client.query(s); assert.ok(r.ok, r.reason); return r.rows; };

test('#1810 R14 — one shared link, one launch: exit 0, a summary naming the job, a run on the board, a model-call row, assertions in the graph, the cursor persisted; a second launch does nothing', { skip: SKIP }, async () => {
  const p = await fetch(`${SRV.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'person-a', body: `worth a read: ${site.url}` }) }).then((r) => r.json());
  assert.ok(p.id);
  const r1 = await run({ ...baseEnv(), OPENROUTER_API_KEY: 'sk-or-test-not-a-real-key' });
  assert.equal(r1.status, 0, `exit 0 (stderr: ${r1.stderr.slice(0, 800)})`);
  const summary = JSON.parse(r1.stdout.trim().split('\n').pop());
  assert.equal(summary.started.length, 1, `one job started (${r1.stdout.slice(0, 400)})`);
  assert.equal(summary.started[0].url, site.url);
  assert.equal(summary.started[0].outcome, 'complete');
  assert.equal(site.hits(), 1, 'the article was fetched once');
  assert.equal(provider.seen.length, 1, 'the provider was asked once');
  assert.equal(provider.seen[0].auth, 'present', 'with the key in the header');
  assert.equal(provider.seen[0].body.model, 'fake/fake-flash-0001', 'the registry key resolved to the provider model id');
  assert.deepEqual(provider.seen[0].body.provider, { zdr: true, data_collection: 'deny' });
  assert.ok(!r1.stdout.includes('sk-or-test') && !r1.stderr.includes('sk-or-test'), 'the key is never printed');
  const runs = (await (await fetch(`${SRV.baseUrl}/api/runs`)).json()).filter((r) => r.op === 'extract');
  assert.equal(runs.length, 1, 'one run on the board');
  const calls = (await (await fetch(`${SRV.baseUrl}/api/model-calls`)).json()).calls.filter((c) => c.agent === 'extractor');
  assert.equal(calls.length, 1, 'one model-call row'); assert.equal(calls[0].tokensIn, 90);
  const hash = crypto.createHash('sha256').update(ARTICLE).digest('hex');
  assert.equal((await q(`SELECT ?a WHERE { ?a <${RS}expressedIn> <https://scrumboard.local/source/${hash}/block/1> }`)).length, 1, 'the assertion is in the graph, anchored to the fetched source');
  assert.ok(fs.existsSync(path.join(DIR, 'extract-state.json')), 'the cursor persisted');
  assert.ok(fs.existsSync(path.join(DIR, 'sources', `${hash}.txt`)), 'the bytes are kept on disk');

  const r2 = await run({ ...baseEnv(), OPENROUTER_API_KEY: 'sk-or-test-not-a-real-key' });
  assert.equal(r2.status, 0);
  const s2 = JSON.parse(r2.stdout.trim().split('\n').pop());
  assert.equal(s2.started.length, 0, 'a second launch starts nothing');
  assert.equal(provider.seen.length, 1, 'and asks the provider nothing');
});

test('#1810 R14d — a link by HOSTNAME (not an IP literal): the entry resolves it, checks the address and connects through the pinned lookup; the article is fetched and the job completes', { skip: SKIP }, async () => {
  const named = await fakeSiteByName();
  try {
  const p = await fetch(`${SRV.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'person-a', body: `and by name: ${named.url}` }) }).then((r) => r.json());
  assert.ok(p.id);
  const r = await run({ ...baseEnv(), OPENROUTER_API_KEY: 'sk-or-test-not-a-real-key' });
  assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr.slice(0, 800)})`);
  const summary = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(summary.started.length, 1, `one job started for the by-name link (${r.stdout.slice(0, 600)})`);
  assert.equal(summary.started[0].url, named.url);
  assert.equal(summary.started[0].outcome, 'complete', `fetched and extracted (${JSON.stringify(summary.started[0])})`);
  assert.equal(named.hits(), 1, 'the article was fetched once, by name');
  } finally { await named.stop(); }
});

test('#1810 R14b — without OPENROUTER_API_KEY the entry exits non-zero naming the variable, never a value, before any network call', { skip: SKIP }, async () => {
  const before = { provider: provider.seen.length, site: site.hits() };
  const r = await run({ ...baseEnv() });
  assert.notEqual(r.status, 0, 'non-zero exit');
  assert.match(r.stderr, /OPENROUTER_API_KEY/, 'names the variable');
  assert.match(r.stderr, /Keychain|environment/i, 'and says where it comes from');
  assert.equal(provider.seen.length, before.provider, 'no request to the provider');
  assert.equal(site.hits(), before.site, 'no fetch of any source');
});

test('#1810 R14c — the launchd template names the Keychain item, the entry and the env variables, and carries no secret, no home path and no seat name', () => {
  assert.ok(fs.existsSync(TEMPLATE), `template at ${TEMPLATE}`);
  const t = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(t, /security find-generic-password -s OPENROUTER_API_KEY -w/, 'the key is loaded from the Keychain at launch');
  assert.match(t, /scripts\/extract-once\.mjs/, 'runs the entry');
  for (const v of ['SCRUM_BOARD_URL', 'SCRUM_SEAT_TOKEN_FILE', 'SCRUM_GRAPH_EXECUTOR_URL', 'SCRUM_GRAPH_DATASET_ID', 'SCRUM_EXTRACT_STATE_FILE', 'SCRUM_EXTRACT_SOURCES_DIR', 'SCRUM_EXTRACT_MODEL_KEY', 'SCRUM_EXTRACT_SHARERS']) assert.ok(t.includes(v), `names ${v}`);
  assert.ok(!/SCRUM_EXTRACT_ALLOW_(HTTP|PRIVATE)_SOURCES/.test(t), 'the test-only knobs are NOT in the template');
  assert.match(t, /<key>StartInterval<\/key>/, 'runs on an interval, one tick per launch');
  assert.doesNotMatch(t, /sk-or-|\/Users\/[a-z]/, 'no secret, no home path');
  // no seat or person name, structurally: every <string> value is a placeholder, a system path, the loopback board url,
  // the job label, the Keychain shell line or the model key. Anything else is free text, and free text is where a
  // name or a value would hide. (No name is spelled here either: the gate refuses literals in tests too.)
  const values = [...t.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.ok(values.length >= 10, `the template has its values (${values.length})`);
  const allowed = [/^__[A-Z]+__(\/[A-Za-z0-9._-]+)*$/, /^\/(bin|usr|opt)\//, /^\/usr\/bin:/, /^http:\/\/127\.0\.0\.1:\d+$/, /^com\.scrumboard\.[a-z-]+$/,
    /^OPENROUTER_API_KEY="\$\(security find-generic-password -s OPENROUTER_API_KEY -w\)" exec "__NODE__" "__SERVE__\/scripts\/extract-once\.mjs"$/, /^-c$/, /^deepseek-v4-flash$/];
  for (const v of values) assert.ok(allowed.some((re) => re.test(v)), `a value that is not a placeholder, a system path, the loopback url, the label, the shell line or the model key: ${JSON.stringify(v)}`);
});
