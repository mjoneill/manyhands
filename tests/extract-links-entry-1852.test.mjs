/**
 * #1852 (supply) — the two extractor ENTRIES, as they are launched, link the run they publish. Each is spawned as a child
 * against a real REST server (seat token, cards, a fake embedder behind its search), a scratch executor, a fake OpenRouter
 * and a fake article server; nothing here reaches the network. The threshold the children read is the SHIPPED
 * knowledge-linking.json: no variable and no flag carries it, which is the point of the file.
 *
 * STATED LIMIT: the embedder is the search tests' fake (a count of five axis words), so these rows show that the entry
 * searches each claim, thresholds at the tracked number, writes the links and reports them. They are not a claim about
 * meaning; that is the live run on the card.
 *
 *   E1  extract-once.mjs, one shared link, one launch: exit 0; the tick's JSON line carries the link counts; the graph holds
 *       the run's proposed links at the shipped threshold (0.6), by the extractor; the finish post in the commons names
 *       each card with the claim's gist, the total, and the run's page. The claim no card matches gets no link.
 *   E2  the same entry against a board whose search cannot answer (no embedder): exit 0, the run is published and complete,
 *       the JSON line and the finish post both say the links were NOT made and why, and no link is written
 *   E3  extract-file.mjs, one named PDF: the same linking, through the same helper, in its summary and its finish post
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const havePdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONCE = path.join(ROOT, 'scripts', 'extract-once.mjs');
const FILE = path.join(ROOT, 'scripts', 'extract-file.mjs');
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';

// the search tests' fake embedder: a count of five axis words, so rank follows the text and nothing else
const AXES = ['deploy', 'search', 'gate', 'presence', 'banana'];
const fakeVec = (text) => { const t = text.toLowerCase(); const v = AXES.map((w) => (t.match(new RegExp(w, 'g')) || []).length); return v.some((x) => x > 0) ? v : [0.01, 0.01, 0.01, 0.01, 0.01]; };
async function fakeEmbedder() {
  const srv = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { const b = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: b.model, embeddings: b.input.map(fakeVec) })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/api/embed`, stop: () => new Promise((r) => srv.close(r)) };
}
/** Answers like OpenRouter's chat/completions with whatever `items` is set to, and counts the calls. */
async function fakeProvider() {
  const p = { items: [], seen: 0 };
  const srv = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      p.seen += 1;
      const content = JSON.stringify({ title: 'Notes on shipping', synopsis: 'Plain notes about how work reaches the server.', items: p.items });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 30 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  p.base = `http://127.0.0.1:${srv.address().port}/api/v1`; p.stop = () => new Promise((r) => srv.close(r));
  return p;
}
const GATE = 'A gate checks every push before it lands.';
const DEPLOY = 'A deploy copies the tracked files to the server.';
const FRUIT = 'Bananas are yellow.';
const ARTICLE = ['Notes on shipping.', GATE, DEPLOY, FRUIT].join('\n');
const item = (block, span, gist) => ({ block, type: 'empirical', span, subject: 'work', predicate: 'scrum:relatedTo', object: 'server', ...(gist ? { gist } : {}) });
async function fakeSite() {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(ARTICLE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: (slug) => `http://127.0.0.1:${srv.address().port}/articles/${slug}`, stop: () => new Promise((r) => srv.close(r)) };
}
const CARDS = [{ id: crypto.randomUUID(), shortId: 1, title: 'The push gate reads pushed objects', description: 'gate gate gate' },
  { id: crypto.randomUUID(), shortId: 2, title: 'Deploy script', description: 'deploy deploy' }];
// the cards' dates are the run's own clock: a fixed calendar date handed to a served board is a time bomb (#1696)
const card = (c) => { const now = new Date().toISOString(); return { ...c, type: 'task', assignees: [], labels: [], for: '', priority: null, column: 'backlog', createdAt: now, updatedAt: now }; };

const TOK = mintToken();
let exec, client, SRV, DEAF, provider, site, emb, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-entry-1852-'));
  STORE = tmpStore('kl-entry-');
  exec = await startExecutor({ store: STORE, datasetId: 'kl-entry', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kl-entry', timeoutMs: 30000 });
  // the cards as the graph knows them: a link names a scrum:Card, and the compiler refuses one that is not there
  const seeded = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body: `INSERT DATA { ${CARDS.map((c) => `<${cardIriOf(c.id)}> <${RDF}type> <${RS}Card> .`).join(' ')} }`,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(seeded.status, 200, `cards seeded (${seeded.status} ${await seeded.text()})`);
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const tokens = path.join(DIR, 'seat-tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ seats: { extractor: { credentials: [{ tokenHash: hashToken(TOK), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  fs.writeFileSync(path.join(DIR, 'seat-token'), TOK);
  provider = await fakeProvider(); site = await fakeSite(); emb = await fakeEmbedder();
  const board = () => makeBoardFixture({ cards: CARDS.map(card), conversations: [], nextShortId: 3 });
  SRV = await startRestServer({ board: board(), env: { SCRUM_SEAT_TOKENS: tokens, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_DATASET_ID: 'kl-entry', SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake-embed' } });
  DEAF = await startRestServer({ board: board(), env: { SCRUM_SEAT_TOKENS: tokens } });   // no embedder: its search answers available:false
  for (const s of [SRV, DEAF]) {
    const auth = { 'content-type': 'application/json', Authorization: `Bearer ${TOK}` };
    const reg = await fetch(`${s.baseUrl}/api/models`, { method: 'POST', headers: auth, body: JSON.stringify({ key: 'fake-flash', name: 'Fake Flash', model: 'fake/fake-flash-0001', provider: 'openrouter', baseUrl: provider.base, protocol: 'openai-completions', apiKeyRef: 'OPENROUTER_API_KEY', by: 'extractor' }) });
    assert.ok(reg.ok, `registry entry created (${reg.status} ${await reg.text()})`);
    const pred = await fetch(`${s.baseUrl}/api/predicates`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'scrum:relatedTo', definition: 'SEE ALSO (test registration)', by: 'extractor' }) });
    assert.ok(pred.ok, `predicate registered (${pred.status} ${await pred.text()})`);
  }
});
after(async () => { await SRV?.stop(); await DEAF?.stop(); await provider?.stop(); await site?.stop(); await emb?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); if (STORE) fs.rmSync(STORE, { recursive: true, force: true }); });

const envFor = (srv, name) => ({
  PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY: 'sk-or-test-not-a-real-key',
  SCRUM_BOARD_URL: srv.baseUrl, SCRUM_SEAT_TOKEN_FILE: path.join(DIR, 'seat-token'),
  SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_DATASET_ID: 'kl-entry',
  SCRUM_EXTRACT_STATE_FILE: path.join(DIR, `state-${name}.json`), SCRUM_EXTRACT_SOURCES_DIR: path.join(DIR, 'sources'),
  SCRUM_EXTRACT_MODEL_KEY: 'fake-flash', SCRUM_EXTRACT_SHARERS: 'person-a',
  SCRUM_EXTRACT_ALLOW_HTTP_SOURCES: '1', SCRUM_EXTRACT_ALLOW_PRIVATE_SOURCES: '1',   // the fake article server is plain http on loopback; production never sets these
});
// async on purpose: the fake servers live in this process, and a spawnSync would block the loop they answer on
const run = (script, args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
});
const q = async (s) => { const r = await client.query(s); assert.ok(r.ok, r.reason); return r.rows; };
const share = (srv, body) => fetch(`${srv.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'person-a', body }) }).then((r) => r.json());
const posts = async (srv) => (await (await fetch(`${srv.baseUrl}/api/conversations`)).json());
const linksOf = (runId) => q(`SELECT ?c ?st ?min ?by ?m WHERE { ?l <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> ?a ; <${RS}bearsOnCard> ?c ; <${RS}status> ?st ; <${RS}minScore> ?min ; <${PROV}wasAssociatedWith> ?by ; <${RS}model> ?m . ?a <${RS}ofRun> <${runId}> } ORDER BY ?c`);
/** One launch to seat the cursor at the head, then the share, then the launch that does the work. */
async function tickOver(srv, name, slug) {
  const env = envFor(srv, name);
  const r0 = await run(ONCE, [], env);
  assert.equal(r0.status, 0, `first launch exit 0 (stderr: ${r0.stderr.slice(0, 800)})`);
  await share(srv, `worth a read: ${site.url(slug)}`);
  const r = await run(ONCE, [], env);
  assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr.slice(0, 800)})`);
  assert.ok(!r.stdout.includes('sk-or-test') && !r.stderr.includes('sk-or-test') && !r.stdout.includes(TOK) && !r.stderr.includes(TOK), 'no key and no token is printed');
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('E1 extract-once links the run it publishes: counts in the JSON line, proposed links on the graph at the shipped threshold, cards and gists in the finish post', { skip: SKIP }, async () => {
  provider.items = [item(1, GATE, 'a gate checks each push'), item(2, DEPLOY), item(3, FRUIT, 'bananas are yellow')];
  const summary = await tickOver(SRV, 'e1', 'shipping');
  assert.equal(summary.started.length, 1, JSON.stringify(summary));
  const job = summary.started[0];
  assert.equal(job.outcome, 'complete'); assert.equal(job.published, 3);
  assert.deepEqual(job.links, { made: true, proposed: 2, skipped: 0, cards: 2, assertions: 3, minScore: 0.6 });

  const rows = await linksOf(job.runId);
  assert.deepEqual(rows.map((r) => r.c.value).sort(), CARDS.map((c) => cardIriOf(c.id)).sort(), 'one link to each card; the claim about bananas matched neither');
  assert.deepEqual([...new Set(rows.map((r) => `${r.st.value} ${Number(r.min.value)} ${r.by.value} ${r.m.value}`))], ['proposed 0.6 https://scrumboard.local/person/extractor fake-embed']);

  const mine = (await posts(SRV)).filter((p) => p.author === 'extractor');
  assert.deepEqual(mine.map((p) => p.body.split(' ').slice(0, 3).join(' ')), ['🧪 extraction started:', '✅ extraction finished'], 'still two posts per run');
  const body = mine[1].body;
  assert.ok(body.includes('🔗 may bear on #1 The push gate reads pushed objects: "a gate checks each push"'), body);
  assert.ok(body.includes(`🔗 may bear on #2 Deploy script: "${DEPLOY}"`), 'a claim with no gist is shown by its span');
  assert.ok(body.includes('2 proposed links to 2 cards (machine guesses; answer them with link_decide)'), body);
  assert.ok(body.includes(`read it on the board: /reading.html?run=${job.runId.split('/').pop()}`), body);
  assert.doesNotMatch(body, /banana/i, 'the claim that matched no card is not shown as a link');
});

test('E2 a board whose search cannot answer: the run is published and complete, and the JSON line and the finish post say the links were not made and why', { skip: SKIP }, async () => {
  provider.items = [item(1, GATE, 'a gate checks each push, said again')];
  const summary = await tickOver(DEAF, 'e2', 'shipping-again');
  assert.equal(summary.started.length, 1, JSON.stringify(summary));
  assert.deepEqual(summary.failed, []);
  const job = summary.started[0];
  assert.equal(job.outcome, 'complete'); assert.equal(job.published, 1);
  assert.equal(job.links.made, false);
  assert.match(job.links.reason, /search unavailable.*no embedder is configured/);
  assert.deepEqual(await linksOf(job.runId), []);
  const fin = (await posts(DEAF)).filter((p) => p.author === 'extractor').pop().body;
  assert.match(fin, /^✅ extraction finished \(complete\)/);
  const line = fin.split('\n').find((l) => l.startsWith('links:'));
  assert.match(line, /^links: not made \(search unavailable for .*no embedder is configured/);
  assert.doesNotMatch(fin, /🔗|proposed links/);
});

test('E3 extract-file links the run it publishes, through the same helper', { skip: SKIP || (!havePdftotext && 'pdftotext is not installed') }, async () => {
  const text = 'The gate at the door checks each push twice.';
  const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
    + '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 9 0 R >> >> >> endobj\n'
    + `4 0 obj << /Length ${text.length + 30} >> stream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream endobj\n`
    + '9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
  const file = path.join(DIR, 'door.pdf'); fs.writeFileSync(file, pdf);
  const asked = await share(SRV, 'please extract door.pdf');
  provider.items = [item(0, text, 'the door gate checks a push twice')];
  const r = await run(FILE, [file, '--asked-in', asked.id], envFor(SRV, 'e3'));
  assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr.slice(0, 800)})`);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.outcome, 'complete');
  assert.deepEqual(summary.links, { made: true, proposed: 1, skipped: 0, cards: 1, assertions: 1, minScore: 0.6 });
  const rows = await linksOf(summary.runId);
  assert.deepEqual(rows.map((x) => [x.c.value, x.st.value, Number(x.min.value)]), [[cardIriOf(CARDS[0].id), 'proposed', 0.6]]);
  const fin = (await posts(SRV)).filter((p) => p.author === 'extractor').pop().body;
  assert.match(fin, /^✅ extraction finished \(complete\): door\.pdf/);
  assert.ok(fin.includes('🔗 may bear on #1 The push gate reads pushed objects: "the door gate checks a push twice"'), fin);
  assert.ok(fin.includes('1 proposed link to 1 card (machine guesses; answer them with link_decide)'), fin);
});
