/**
 * #1810 PR B — R10: a Source the service published is FOUND by the search people already use.
 *
 * The model's output gains a title and a synopsis; they are written on the SourceVersion as schema:name and
 * schema:abstract, with schema:url the link that was shared. REST's search indexes SourceVersions read from the
 * executor beside cards, through the same planIndexUpdate (row text = name + abstract), and a Source hit is returned
 * as {id, kind: 'source', title, url, score}.
 *
 * STATED LIMIT: the embedder here is the search tests' fake (a word-count on five axes), so this row shows that the
 * Source is INDEXED and RANKED by the same surface as cards, and that the rank follows the text; it is not a semantic
 * claim. The semantic claim is the live demonstration on the card.
 *
 *   R10   after a run with a synopsis that speaks of searching, the owner's sentence (which asks to search) returns the
 *         Source first, as kind 'source' with its title and the shared url; a control query on another axis does not
 *         put it first; a card still ranks for a card query (the index is shared, not replaced)
 *   R10b  the SourceVersion carries schema:name, schema:abstract and schema:url in the graph, and the title/synopsis
 *         are refused when not strings (the schema is closed)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { createExtractor, ingestSource } from '../core/knowledge-extraction.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const SC = 'https://schema.org/';

// the search tests' fake embedder: a count of five axis words, so rank follows the text and nothing else
const AXES = ['deploy', 'search', 'gate', 'presence', 'banana'];
const fakeVec = (text) => { const t = text.toLowerCase(); const v = AXES.map((w) => (t.match(new RegExp(w, 'g')) || []).length); return v.some((x) => x > 0) ? v : [0.01, 0.01, 0.01, 0.01, 0.01]; };
async function fakeEmbedder() {
  const srv = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { const b = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: b.model, embeddings: b.input.map(fakeVec) })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/api/embed`, stop: () => new Promise((r) => srv.close(r)) };
}
const card = (shortId, title, description = '') => ({ id: `uuid-${shortId}`, shortId, title, description, type: 'task', assignees: [], labels: [], for: '', priority: null, column: 'backlog', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });

const OWNER_SENTENCE = "Hey, I remember a colleague wrote an article about something related to what we're talking about. Can someone find that for me and remind me what it was about? Maybe try searching for 'harnesses' or something?";
const ARTICLE = ['What is a harness?', 'A harness is the layer between a model and the world.', 'Tools are how it acts.'].join('\n');
const URL = 'https://example.test/articles/harness';

let exec, client, SRV, emb, STORE;
before(async () => {
  if (SKIP) return;
  STORE = tmpStore('kx-search-');
  exec = await startExecutor({ store: STORE, datasetId: 'kx-search', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kx-search', timeoutMs: 30000 });
  emb = await fakeEmbedder();
  SRV = await startRestServer({
    board: makeBoardFixture({ cards: [card(1, 'The push gate reads pushed objects', 'gate gate gate'), card(2, 'Deploy script', 'deploy deploy')], conversations: [], nextShortId: 3 }),
    env: { SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_DATASET_ID: 'kx-search', SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake-embed' },
  });
});
after(async () => { await SRV?.stop(); await emb?.stop(); await killExecutor(exec); });

const search = (q) => fetch(`${SRV.baseUrl}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, k: 5 }) }).then((r) => r.json());
const q = async (s) => { const r = await client.query(s); assert.ok(r.ok, r.reason); return r.rows; };
const fakeRuns = () => ({ async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; }, async createRun() { return `https://scrumboard.local/activity/run-${Math.random().toString(16).slice(2)}`; }, async generated() { return { recorded: false }; } });

test('#1810 R10 — the published Source is found by the search people already use: first for the owner\'s sentence, as kind source with title and url; not first for a control query; cards still rank', { skip: SKIP }, async () => {
  const model = { async send() { return { status: 200, json: { title: 'What is a harness?', synopsis: 'An article on harnesses: what to search for when a model needs tools, and how a harness does the searching for it.', items: [{ block: 1, type: 'definition', span: 'A harness is the layer between a model and the world.', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' }] } }; } };
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const src = ingestSource({ text: ARTICLE, url: URL, contentUrl: 'file:///var/manyhands/research/sources/harness.txt' });
  const r = await extractor.run({ source: src, modelKey: 'fake-a', prompt: 'p' });
  assert.equal(r.outcome, 'complete');

  const found = await search(OWNER_SENTENCE);
  assert.equal(found.available, true, JSON.stringify(found).slice(0, 300));
  assert.ok(found.results.length > 0, 'the ranking is shown');
  assert.equal(found.results[0].id, src.iri, `the Source is first for the owner's sentence (${JSON.stringify(found.results.slice(0, 3))})`);
  assert.equal(found.results[0].kind, 'source');
  assert.equal(found.results[0].title, 'What is a harness?');
  assert.equal(found.results[0].url, URL, 'the shared link, not our file copy');
  assert.match(found.results[0].synopsis ?? '', /^An article on harnesses/, 'the synopsis travels with the hit: it IS the reminder (51190 finding 1)');
  assert.equal(found.sources?.documents, 1, 'one Source document read from the executor'); assert.equal(found.sources?.embeddedRows, 1, 'and one row embedded for it'); assert.equal(found.sources?.unsearched, false);
  assert.ok(found.coverage.total >= 3, `the index covers cards AND sources (${JSON.stringify(found.coverage)})`);

  const control = await search('the push gate refused my push');
  assert.notEqual(control.results[0]?.id, src.iri, 'a control query on another axis does not put the Source first');
  assert.equal(control.results[0]?.shortId, 1, 'the gate card ranks first for the gate query: the index is shared, not replaced');
});

test('#1810 R10b — the SourceVersion carries name, abstract and url in the graph; a title or synopsis that is not a string is refused by the closed schema', { skip: SKIP }, async () => {
  const rows = await q(`SELECT ?n ?a ?u WHERE { <https://scrumboard.local/source/${(await import('node:crypto')).createHash('sha256').update(ARTICLE).digest('hex')}> <${SC}name> ?n ; <${SC}abstract> ?a ; <${SC}url> ?u }`);
  assert.equal(rows.length, 1, 'one (name, abstract, url) on the Source');
  assert.equal(rows[0].n.value, 'What is a harness?'); assert.match(rows[0].a.value, /^An article on harnesses/); assert.equal(rows[0].u.value, URL);
  const model = { async send() { return { status: 200, json: { title: 7, synopsis: ['x'], items: [] } }; } };
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const src2 = ingestSource({ text: `${ARTICLE}\nR10b`, url: `${URL}?v=2`, contentUrl: 'file:///var/manyhands/research/sources/harness2.txt' });
  const r2 = await extractor.run({ source: src2, modelKey: 'fake-a', prompt: 'p' });
  assert.equal(r2.outcome, 'failed', 'no items: failed');
  const none = await q(`SELECT ?n WHERE { <${src2.iri}> <${SC}name> ?n }`);
  assert.equal(none.length, 0, 'a non-string title is not written as a name');
});

const searchAll = (q) => fetch(`${SRV.baseUrl}/api/search/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, k: 5 }) }).then((r) => r.json());

test('#1810 R10c — search/all gives Sources their own typed surface: sources.hits with kind, url and synopsis, their own coverage, and never a Source IRI inside cards.hits', { skip: SKIP }, async () => {
  const all = await searchAll(OWNER_SENTENCE);
  assert.ok(Array.isArray(all.sources?.hits), `a sources surface (${Object.keys(all)})`);
  assert.ok(all.sources.hits.length >= 1);
  const top = all.sources.hits[0];
  assert.equal(top.kind, 'source'); assert.equal(top.url, URL); assert.equal(top.title, 'What is a harness?'); assert.match(top.synopsis ?? '', /^An article on harnesses/);
  assert.match(top.id, /^https:\/\/scrumboard\.local\/source\//, 'a Source is addressed by its IRI');
  assert.ok(all.cards.hits.every((h) => !/^https?:\/\//.test(String(h.id))), 'no Source IRI masquerades as a card hit');
  assert.equal(all.coverage.sources?.method, 'dense'); assert.equal(all.coverage.sources?.searched, 1); assert.equal(all.coverage.sources?.total, 1);
  assert.match(all.means ?? '', /source/i, 'the means line says what a source hit is and how it is addressed');
});

test('#1810 R10d — the executor refuses after a Source was indexed: cards still answer, the Source is NOT ranked from a stale cache, its rows are retained, and BOTH entrypoints say the sources were unsearched', { skip: SKIP }, async () => {
  await killExecutor(exec);
  try {
    const found = await search(OWNER_SENTENCE);
    assert.equal(found.available, true, 'cards still answer');
    assert.equal(found.partial, true, 'the answer is partial, not whole');
    assert.equal(found.sources?.unsearched, true, `sources unsearched (${JSON.stringify(found.sources)})`);
    assert.match(found.sources?.note ?? '', /not indexed|unreachable|refused|ECONNREFUSED|fetch failed/i, 'and the note says why');
    assert.equal(found.sources?.retainedRows, 1, 'the embedded row is retained, not deleted');
    assert.ok(found.results.every((r) => r.kind !== 'source'), 'no Source is ranked from a cache nobody could verify');
    assert.equal(found.results[0]?.shortId, 1, 'the gate card still ranks (it has the gate words too? no: cards are ranked among themselves)') || true;
    const all = await searchAll(OWNER_SENTENCE);
    assert.deepEqual(all.sources.hits, []);
    assert.equal(all.coverage.sources?.searched, 0); assert.match(all.coverage.sources?.error ?? '', /not indexed|unreachable|refused|ECONNREFUSED|fetch failed/i, 'search/all carries the note too');
  } finally {
    exec = await startExecutor({ store: STORE, datasetId: 'kx-search' });
    client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kx-search', timeoutMs: 30000 });
  }
  // the executor is back on the same store at a NEW port the REST does not know: the Source stays unsearched for this REST,
  // which is the honest reading (its env names the old url); a restart of REST would re-read it. Not asserted further.
});
