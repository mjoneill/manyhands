/**
 * #1852 (supply) — the extractor LINKS each run it publishes. Until now the linker (#1851) ran only by hand, so a new run got
 * no links and the feature that hands links to seats had nothing to hand over. The wiring is one helper shared by the tick
 * (core/knowledge-extraction-intake.mjs) and the named-file path (core/knowledge-extraction-file.mjs):
 *
 *   createRunLinker({ graphClient, boardUrl, token, actor, configFile?, search?, model? }) → link(result)
 *     { made:true, minScore, perAssertion, k, assertions, proposed, skipped, links:[{ card, shortId, title, score, gist, assertion }] }
 *     { made:false, reason, retryable, minScore? }   retryable:false is a refused config; true is a search or a graph that
 *                                  did not answer, a refused write, or no claim read (a tick tries those again: see
 *                                  knowledge-linking-retry-1852.test.mjs)
 *   linkPublished(link, result) → null when there is no linker or the run published nothing; else link's answer. NEVER throws.
 *   linkSummary(links) → the short form for the tick's JSON line
 *
 * The graph is a real scratch executor and the posts a real REST test server; the search is a fake, as in the linker's own rows.
 *
 *   W1  a tick that publishes a run links it BEFORE the finish post: the links are on the graph as proposed, at the config's
 *       threshold, by the extractor's own actor; the tick's summary carries the counts; the post shows card, title and gist
 *   W2  search refused: the run's outcome is unchanged, nothing is written, the summary and the post carry the reason
 *   W2b the graph could not be read for the linker: the same, with that reason
 *   W2c a linker that THROWS cannot fail a published run
 *   W3  the config file is missing or invalid: nothing is searched, and the reason names the file. No number stands in.
 *   W4  a RETRIED tick (the job is still pending in the state file, so it is resumed) links again and doubles nothing
 *   W5  a RE-EXTRACTION of the same text (a new run, new assertion IRIs, the same spans) doubles nothing either
 *   W6  a run that published nothing is not linked, and its post is the one #1862 wrote
 *   W7  no linker given: the tick is as before (no `links` on the summary or on the finish event)
 *   W8  a published run whose claims the graph does not return was not searched, and says so: never "none matched"
 *   X1  the named-file path links through the same helper: the summary and the finish event carry the links; a linker that
 *       throws does not fail the file's run; a file already extracted is not linked again
 *   S1  the live search keeps each card's title beside its hit, so the post can name the card
 *
 * Sabotage, 2026-11-14 (each run alone, then restored): the linker reading no existing links turns W4 and W5 red; linkPublished
 * rethrowing turns W2c and X1 red; a number standing in for a refused config turns W3 red.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { createExtractor } from '../core/knowledge-extraction.mjs';
import { createIntake } from '../core/knowledge-extraction-intake.mjs';
import { extractFile } from '../core/knowledge-extraction-file.mjs';
import { finishBody } from '../core/knowledge-extraction-report.mjs';
import { createRunLinker, linkPublished, linkSummary } from '../core/knowledge-linking-supply.mjs';
import { createRestSearch, proposeLinks } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const ARTICLE = ['What is a harness?', 'A harness is the layer between a model and the world.', 'Tools are how it acts.'].join('\n');
const SPAN1 = 'A harness is the layer between a model and the world.';
const SPAN2 = 'Tools are how it acts.';
const GIST1 = 'a harness sits between the model and the world';

let exec, client, SRV, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-supply-1852-'));
  STORE = tmpStore('kl-supply-');
  exec = await startExecutor({ store: STORE, datasetId: 'kl-supply', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kl-supply', timeoutMs: 30000 });
  SRV = await startRestServer({});
});
after(async () => { await SRV?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); if (STORE) fs.rmSync(STORE, { recursive: true, force: true }); });

const q = async (sparql) => { const r = await client.query(sparql); assert.ok(r.ok, `query failed: ${r.reason}`); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);
async function raw(body) {
  const res = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture applied (${res.status} ${await res.text()})`);
}
const post = async (author, body) => (await fetch(`${SRV.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author, body }) })).json();
const cursorNow = async () => (await (await fetch(`${SRV.baseUrl}/api/conversations?afterSeq=start&limit=200`)).json()).nextAfterSeq;

/** The first claim has a gist, the second has none (it is searched by its span). `items: []` is a run that publishes nothing. */
function fakeModel(items = [
  { block: 1, type: 'definition', span: SPAN1, subject: 'harness', predicate: 'scrum:relatedTo', object: 'model', gist: GIST1 },
  { block: 2, type: 'empirical', span: SPAN2, subject: 'tools', predicate: 'acts_through', object: 'harness' },
]) {
  return { async send() { return { status: 200, json: { title: 'Harness', synopsis: 'About harnesses.', items } }; } };
}
function fakeRuns() {
  return { async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; },
    async createRun() { return `https://scrumboard.local/activity/run-${crypto.randomUUID()}`; }, async generated() { return { recorded: false }; } };
}
const configFile = (doc) => { const f = path.join(DIR, `linking-${crypto.randomUUID()}.json`); fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc)); return f; };
const GOOD = { minScore: 0.6, perAssertion: 3, k: 8 };

/** Two fresh cards on the graph, and a search that finds card 0 for the first claim's gist and card 1 for the second's span. */
async function cardsAndSearch() {
  const cards = [crypto.randomUUID(), crypto.randomUUID()];
  await raw(`INSERT DATA { ${cards.map((id) => `<${cardIriOf(id)}> <${RDF}type> <${RS}Card> .`).join(' ')} }`);
  const table = {
    [GIST1]: [{ id: cards[0], shortId: 41, title: 'Keep the harness layer thin', score: 0.8 }, { id: cards[1], shortId: 42, title: 'Tools a seat can reach', score: 0.55 }],
    [SPAN2]: [{ id: cards[1], shortId: 42, title: 'Tools a seat can reach', score: 0.7 }],
  };
  const asked = [];
  const search = async (text) => { asked.push(text); return { ok: true, hits: table[text] ?? [] }; };
  return { cards, search, asked };
}
const linkerFor = (w, extra = {}) => createRunLinker({ graphClient: client, boardUrl: SRV.baseUrl, actor: 'extractor', configFile: configFile(GOOD), search: w.search, model: 'fake-embed', ...extra });

/** An intake over one fresh shared link, with a recorder for the run reports. */
async function intakeWith({ link, model = fakeModel(), url = `https://example.test/kl-1852/${crypto.randomUUID()}` } = {}) {
  const stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ cursor: await cursorNow() }));
  const events = [];
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const intake = createIntake({ boardUrl: SRV.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource: async () => ({ text: ARTICLE, encodingFormat: 'text/plain' }),
    extractor, modelKey: 'fake-a', prompt: 'extract v1', sharers: new Set(['person-a']), report: async (e) => { events.push(e); return { ok: true }; }, ...(link ? { link } : {}) });
  const shared = await post('person-a', `worth a read ${url}`);
  return { intake, events, url, stateFile, postId: shared.id };
}
const linksOfRun = (runId) => count(`?l <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> ?a . ?a <${RS}ofRun> <${runId}>`);
const linksToCard = (id) => count(`?l <${RDF}type> <${RS}BearsOn> ; <${RS}bearsOnCard> <${cardIriOf(id)}>`);

test('W1 a tick that publishes a run links it before the finish post: proposed links on the graph, counts in the summary, card and gist in the post', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const t = await intakeWith({ link: linkerFor(w) });
  const s = await t.intake.tick();
  assert.equal(s.started.length, 1, JSON.stringify(s));
  const job = s.started[0];
  assert.equal(job.outcome, 'complete');
  assert.deepEqual(job.links, { made: true, proposed: 2, skipped: 0, cards: 2, assertions: 2, minScore: 0.6 });
  assert.deepEqual([...w.asked].sort(), [GIST1, SPAN2].sort(), 'each claim was searched once: by its gist, or by its span when it has none');

  assert.equal(await linksOfRun(job.runId), 2);
  const rows = await q(`SELECT ?c ?st ?min ?sc ?by ?m WHERE { ?l <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> ?a ; <${RS}bearsOnCard> ?c ; <${RS}status> ?st ; <${RS}minScore> ?min ; <${RS}score> ?sc ; <${PROV}wasAssociatedWith> ?by ; <${RS}model> ?m . ?a <${RS}ofRun> <${job.runId}> } ORDER BY DESC(?sc)`);
  assert.deepEqual(rows.map((r) => [r.c.value, r.st.value, Number(r.min.value), Number(r.sc.value)]), [[cardIriOf(w.cards[0]), 'proposed', 0.6, 0.8], [cardIriOf(w.cards[1]), 'proposed', 0.6, 0.7]],
    'the 0.55 hit is below the config threshold and is not a link');
  assert.deepEqual([...new Set(rows.map((r) => r.by.value))], ['https://scrumboard.local/person/extractor'], 'proposed by the same actor that published the run');
  assert.deepEqual([...new Set(rows.map((r) => r.m.value))], ['fake-embed']);

  assert.deepEqual(t.events.map((e) => e.kind), ['start', 'finish'], 'still two posts per run: linking adds none');
  const fin = t.events[1];
  assert.equal(fin.links.made, true);
  // the linker reads claims in IRI order and an IRI is a fresh UUID, so the list's order is not the article's: compare by score
  assert.deepEqual([...fin.links.links].sort((x, y) => y.score - x.score).map((l) => [l.shortId, l.title, l.score, l.gist]), [[41, 'Keep the harness layer thin', 0.8, GIST1], [42, 'Tools a seat can reach', 0.7, SPAN2]]);
  const body = finishBody(fin);
  assert.ok(body.includes(`🔗 may bear on #41 Keep the harness layer thin: "${GIST1}"`), body);
  assert.ok(body.includes(`🔗 may bear on #42 Tools a seat can reach: "${SPAN2}"`), 'a claim with no gist is shown by its verbatim span');
  assert.ok(body.includes('2 proposed links to 2 cards (machine guesses; answer them with link_decide)'));
  assert.ok(body.includes(`read it on the board: /reading.html?run=${job.runId.split('/').pop()}`));
});

test('W2 search refused: the run stays published and complete, nothing is written, and the summary and the post carry the reason', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const t = await intakeWith({ link: linkerFor(w, { search: async () => ({ ok: false, reason: 'embedder unavailable' }) }) });
  const s = await t.intake.tick();
  assert.equal(s.started.length, 1); assert.deepEqual(s.failed, [], 'a refused search is not a failed job');
  assert.equal(s.started[0].outcome, 'complete'); assert.equal(s.started[0].published, 2);
  assert.equal(s.started[0].links.made, false);
  assert.match(s.started[0].links.reason, /search unavailable.*embedder unavailable/);
  assert.equal(s.pending, 0); assert.equal(s.reportErrors, 0);
  assert.equal(await linksOfRun(s.started[0].runId), 0);
  assert.deepEqual(t.events.map((e) => e.kind), ['start', 'finish']);
  const line = finishBody(t.events[1]).split('\n').find((l) => l.startsWith('links:'));
  assert.match(line, /^links: not made yet \(search unavailable for .*embedder unavailable\); the next ticks retry, up to 3 tries$/, 'a refused search is retried by later ticks (the retry rows are in knowledge-linking-retry-1852)');
  assert.match(finishBody(t.events[1]), /^✅ extraction finished \(complete\)/, 'the run is reported as the run it was');
});

test('W2b the graph could not be read for the linker: not made, with that reason, and the run is unchanged', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const blind = { ...client, query: async () => ({ ok: false, reason: 'executor not answering' }) };
  const t = await intakeWith({ link: linkerFor(w, { graphClient: blind }) });
  const s = await t.intake.tick();
  assert.equal(s.started[0].outcome, 'complete');
  assert.deepEqual(s.started[0].links, { made: false, reason: 'the run\'s claims could not be read: executor not answering', willRetry: true });
  assert.deepEqual(w.asked, [], 'nothing was searched');
});

test('W2c a linker that throws cannot fail a published run', { skip: SKIP }, async () => {
  const t = await intakeWith({ link: async () => { throw new Error('boom'); } });
  const s = await t.intake.tick();
  assert.equal(s.started.length, 1); assert.deepEqual(s.failed, []);
  assert.equal(s.started[0].outcome, 'complete');
  assert.deepEqual(s.started[0].links, { made: false, reason: 'the linking step failed: boom', willRetry: true });
  assert.match(finishBody(t.events[1]), /^links: not made yet \(the linking step failed: boom\); the next ticks retry, up to 3 tries$/m);
});

test('W3 a missing or invalid config: nothing is searched, the reason names the file, and no number stands in', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const absent = path.join(DIR, 'no-such-linking.json');
  const t = await intakeWith({ link: linkerFor(w, { configFile: absent }) });
  const s = await t.intake.tick();
  assert.equal(s.started[0].outcome, 'complete');
  assert.equal(s.started[0].links.made, false);
  assert.match(s.started[0].links.reason, /no-such-linking\.json cannot be read/);
  assert.deepEqual(w.asked, [], 'no config, no search');
  assert.equal(await linksOfRun(s.started[0].runId), 0);
  assert.match(finishBody(t.events[1]), /^links: not made \(no-such-linking\.json cannot be read \(ENOENT\)\)$/m);

  const t2 = await intakeWith({ link: linkerFor(w, { configFile: configFile({ perAssertion: 3, k: 8 }) }) });
  const s2 = await t2.intake.tick();
  assert.match(s2.started[0].links.reason, /minScore is missing \(it has no default\)/);
  assert.deepEqual(w.asked, []);
});

test('W4 a retried tick resumes the job, links again, and doubles nothing', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const t = await intakeWith({ link: linkerFor(w) });
  const s1 = await t.intake.tick();
  const job = s1.started[0];
  assert.equal(job.links.proposed, 2);
  // the tick died after the links were written and before its state was saved: the job is still on the pending list
  const st = JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
  fs.writeFileSync(t.stateFile, JSON.stringify({ ...st, pending: [{ jobId: job.jobId, url: t.url, postId: t.postId, since: st.updatedAt, attempts: 1 }] }));
  t.events.length = 0;
  const s2 = await t.intake.tick();
  assert.equal(s2.resumed.length, 1, JSON.stringify(s2));
  assert.equal(s2.resumed[0].runId, job.runId, 'the same run, resumed from its checkpoint');
  assert.deepEqual(s2.resumed[0].links, { made: true, proposed: 0, skipped: 2, cards: 0, assertions: 2, minScore: 0.6 });
  assert.equal(await linksOfRun(job.runId), 2, 'still two links, not four');
  const fin = t.events.find((e) => e.kind === 'finish');
  assert.match(finishBody(fin), /^links: no new ones; 2 matches at or above 0\.6 already had a link \(proposed, confirmed or dismissed\)$/m);
});

test('W5 a re-extraction of the same text (a new run, new assertion IRIs, the same spans) doubles nothing', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const link = linkerFor(w);
  const a = await intakeWith({ link });
  const first = (await a.intake.tick()).started[0];
  assert.equal(first.links.proposed, 2);
  const b = await intakeWith({ link });   // another link to the same article: a new job, a new run, fresh assertion IRIs
  const second = (await b.intake.tick()).started[0];
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.published, 2);
  assert.deepEqual(second.links, { made: true, proposed: 0, skipped: 2, cards: 0, assertions: 2, minScore: 0.6 });
  assert.equal(await linksToCard(w.cards[0]), 1); assert.equal(await linksToCard(w.cards[1]), 1);
  assert.equal(await linksOfRun(second.runId), 0, 'the same claim under a new IRI is the same claim: its link already exists');
});

test('W6 a run that published nothing is not linked, and its post is the one #1862 wrote', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const t = await intakeWith({ link: linkerFor(w), model: fakeModel([]) });
  const s = await t.intake.tick();
  assert.equal(s.started[0].outcome, 'failed'); assert.equal(s.started[0].published, 0);
  assert.equal('links' in s.started[0], false);
  assert.deepEqual(w.asked, []);
  const fin = t.events.find((e) => e.kind === 'finish');
  assert.equal('links' in fin, false);
  assert.equal(finishBody(fin), finishBody({ url: fin.url, result: fin.result }));
  assert.doesNotMatch(finishBody(fin), /links|reading\.html/);
});

test('W7 no linker given: the tick is as before', { skip: SKIP }, async () => {
  const t = await intakeWith({});
  const s = await t.intake.tick();
  assert.equal(s.started[0].outcome, 'complete');
  assert.equal('links' in s.started[0], false);
  assert.equal('links' in t.events[1], false);
  assert.equal(await linksOfRun(s.started[0].runId), 0);
});

test('W8 a published run whose claims the graph does not return was not searched, and says so', { skip: SKIP }, async () => {
  const w = await cardsAndSearch();
  const link = linkerFor(w);
  const r = await linkPublished(link, { runId: `https://scrumboard.local/activity/run-absent-${crypto.randomUUID()}`, outcome: 'complete', published: [{ iri: 'urn:x:1' }] });
  assert.deepEqual(r, { made: false, reason: 'the graph returned no claims for this run, so nothing was searched', retryable: true, minScore: 0.6 });
  assert.deepEqual(w.asked, []);
  // and the two cases where there is nothing to link at all
  assert.equal(await linkPublished(link, { runId: 'https://scrumboard.local/activity/run-x', outcome: 'failed', published: [] }), null);
  assert.equal(await linkPublished(null, { runId: 'https://scrumboard.local/activity/run-x', outcome: 'complete', published: [{ iri: 'urn:x:1' }] }), null);
  assert.deepEqual(linkSummary({ made: false, reason: 'r' }), { made: false, reason: 'r', willRetry: false });
});

// ── the named-file path (#1854): the same helper, so the rows are about the wiring, with a fake extractor as in its own tests ──

const havePdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const NOPDF = !havePdftotext && 'pdftotext is not installed';
function onePagePdf(dir) {
  const text = 'The only page makes one claim plainly.';
  const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
    + '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 9 0 R >> >> >> endobj\n'
    + `4 0 obj << /Length ${text.length + 30} >> stream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream endobj\n`
    + '9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
  const f = path.join(dir, 'one.pdf'); fs.writeFileSync(f, pdf); return f;
}
function fakeExtractor() {
  const jobs = new Map(); const runs = [];
  return { runs, promptVersion: () => 'v1',
    async state({ jobId }) { const j = jobs.get(jobId); return { jobId, outcome: j?.outcome ?? null, runId: j?.runId ?? null, next: [] }; },
    async run({ jobId }) {
      const r = { runId: `https://scrumboard.local/activity/run-file-${runs.length + 1}`, outcome: 'complete', rejected: [],
        published: [{ iri: 'urn:x:1', block: 0, type: 'empirical', predicate: 'scrum:relatedTo', subject: 'page', object: 'claim' }] };
      runs.push(jobId); jobs.set(jobId, r); return { ...r, jobId };
    } };
}
const LINKED = { made: true, minScore: 0.6, perAssertion: 3, k: 8, assertions: 1, proposed: 1, skipped: 0,
  links: [{ card: 'uuid-7', shortId: 7, title: 'A card about pages', score: 0.9, gist: 'the page makes one claim', assertion: 'urn:x:1' }] };

test('X1 a named file is linked through the same helper; a throwing linker does not fail its run; a known file is not linked again', { skip: NOPDF }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-supply-file-'));
  try {
    const ex = fakeExtractor(); const events = []; const linked = [];
    const args = { file: onePagePdf(d), extractor: ex, sourcesDir: path.join(d, 's'), modelKey: 'm', prompt: 'p', askedIn: 'post-1',
      report: async (e) => { events.push(e); return { ok: true }; }, link: async (r) => { linked.push(r.runId); return LINKED; } };
    const out = await extractFile(args);
    assert.equal(out.outcome, 'complete');
    assert.deepEqual(linked, ['https://scrumboard.local/activity/run-file-1']);
    assert.deepEqual(out.links, { made: true, proposed: 1, skipped: 0, cards: 1, assertions: 1, minScore: 0.6 });
    assert.deepEqual(events.map((e) => e.kind), ['start', 'finish']);
    const body = finishBody(events[1]);
    assert.ok(body.includes('🔗 may bear on #7 A card about pages: "the page makes one claim"'), body);
    assert.match(body, /page 1, block 0/, 'the file\'s own page citation is still there');
    assert.ok(body.includes('read it on the board: /reading.html?run=run-file-1'));

    const again = await extractFile(args);
    assert.equal(again.skipped, 'known: complete');
    assert.equal(linked.length, 1, 'a file already extracted is not linked again');

    const d2 = path.join(d, 'other'); fs.mkdirSync(d2);
    const out2 = await extractFile({ ...args, extractor: fakeExtractor(), sourcesDir: path.join(d2, 's'), link: async () => { throw new Error('boom'); } });
    assert.equal(out2.outcome, 'complete');
    assert.deepEqual(out2.links, { made: false, reason: 'the linking step failed: boom', willRetry: false }, 'a named file has no tick to retry it');

    const out3 = await extractFile({ ...args, extractor: fakeExtractor(), sourcesDir: path.join(d2, 's3'), link: undefined });
    assert.equal('links' in out3, false, 'no linker: the summary is as before');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('S1 the live search keeps each card\'s title beside its hit, and a proposal carries it', async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ available: true, model: 'm', partial: false, results: [
    { id: 'uuid-1', shortId: 1319, title: 'Keep the top layer small', column: 'backlog', score: 0.7 }, { id: 'uuid-2', shortId: 5, score: 0.65 }] }) });
  const search = createRestSearch({ base: 'http://board', token: 't', by: 'extractor', k: 8, fetchImpl });
  const r = await search('q');
  assert.deepEqual(r.hits.map((h) => h.title), ['Keep the top layer small', null]);
  const p = await proposeLinks({ assertions: [{ iri: 'https://scrumboard.local/assertion/a1', span: 's', gist: 'q' }], search, existing: [], minScore: 0.6, perAssertion: 3 });
  assert.deepEqual(p.proposals.map((x) => [x.shortId, x.title ?? null]), [[1319, 'Keep the top layer small'], [5, null]]);
});
