/**
 * #1852 (supply, review follow-up) — a run whose linking was REFUSED is retried by the tick, bounded. The refusal is not
 * rare: the embedding model is evicted whenever another local model loads (#1530), so "search unavailable at that moment"
 * recurs, and it recurs when the room is busy. Linking is idempotent (existing span keys are skipped) and free (the board's
 * own search), so a retry costs almost nothing, and without one the run stays unlinked until someone runs link-run.mjs.
 *
 * WHAT IS PINNED HERE:
 *   - the state file gains `pendingLinks: [{ runId, url, tries, lastReason, firstRefusedAt }]`, written only while it is not
 *     empty; a file without it loads as before, and the fields the older reader takes are untouched
 *   - a tick FIRST retries pending runs, oldest first, at most MAX_LINK_RETRIES_PER_TICK (2); MAX_LINK_TRIES (3) in total per
 *     run, the first attempt being try 1. A try is counted when it BEGINS, so a tick that dies inside one cannot loop
 *   - every pending run ends with exactly ONE follow-up post: its links (or "none matched" / "no new ones"), or one line
 *     saying they were not made after 3 tries and how to make them by hand. The entry leaves the state file BEFORE that post
 *     is sent, so a tick that dies between the two posts nothing twice
 *   - a config refusal is never retried: it does not fix itself
 *
 *   B1  the three new post forms, as text
 *   P1  refused: the run is published and complete, the entry is in the state file, the finish post is sent in the same tick
 *       and says "not made yet … retry", the JSON summary says so
 *   P2  the next tick retries and succeeds: ONE follow-up post, the links on the graph, the entry gone; a later tick does nothing
 *   P3  three refusals: nothing is posted on try 2, ONE final line on try 3, the entry gone, and no fourth try
 *   P4  a config refusal is never pending, and its finish line is the one it was
 *   P5  a state file from before this change loads and ticks; one written now keeps every older field as it was
 *   P6  the per-tick cap: three pending runs are retried two, then one, oldest first
 *   P7  the links were written but the entry was not removed (the tick died between): the retry proposes nothing new, posts
 *       the "no new ones" form ONCE, and the next tick posts nothing
 *   P8  a tick that died INSIDE a try: the try is already counted. Two begun: one more is made. Three begun: none is made,
 *       and the one post says the links are not CONFIRMED, because that try may have written them
 *   P9  the named-file path has no state file and no tick, so it does not retry: its finish line says how to make them by hand
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
import { createIntake, MAX_LINK_TRIES, MAX_LINK_RETRIES_PER_TICK } from '../core/knowledge-extraction-intake.mjs';
import { extractFile } from '../core/knowledge-extraction-file.mjs';
import { finishBody, linksBody, linksGaveUpBody, createAnnouncer } from '../core/knowledge-extraction-report.mjs';
import { createRunLinker } from '../core/knowledge-linking-supply.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const ARTICLE = ['What is a harness?', 'A harness is the layer between a model and the world.', 'Tools are how it acts.'].join('\n');
const SPAN1 = 'A harness is the layer between a model and the world.';
const SPAN2 = 'Tools are how it acts.';
const GIST1 = 'a harness sits between the model and the world';
const RUN = 'https://scrumboard.local/activity/run-44d706e1-16af-4a45-8671-d4baef63563b';
const URL1 = 'https://example.test/articles/harness';

// ── the post forms, as text ──

test('B1 the three new post forms', async () => {
  const result = { runId: RUN, outcome: 'complete', published: [{ iri: 'a1', block: 1, type: 'definition', predicate: 'scrum:relatedTo', subject: 'harness', object: 'model' }], rejected: [] };
  // 1. the finish post of a run whose first attempt was refused and will be retried
  const waiting = finishBody({ url: URL1, result, links: { made: false, reason: 'search unavailable for a1: embedder unavailable', retryable: true, retry: { max: 3 } } });
  assert.ok(waiting.split('\n').includes('links: not made yet (search unavailable for a1: embedder unavailable); the next ticks retry, up to 3 tries'), waiting);
  // … and of one nobody will retry (the named-file path): how to make them by hand
  const byHand = finishBody({ url: URL1, result, links: { made: false, reason: 'search unavailable for a1: embedder unavailable', retryable: true, minScore: 0.6 } });
  assert.ok(byHand.split('\n').includes(`links: not made (search unavailable for a1: embedder unavailable); make them with scripts/link-run.mjs --run ${RUN} --min-score 0.6`), byHand);
  // 2. the follow-up when a retry made them
  const links = { made: true, minScore: 0.6, assertions: 2, proposed: 2, skipped: 0, links: [
    { card: 'u1', shortId: 41, title: 'Keep the harness layer thin', score: 0.8, gist: GIST1 }, { card: 'u2', shortId: 42, title: 'Tools a seat can reach', score: 0.7, gist: SPAN2 }] };
  assert.equal(linksBody({ url: URL1, runId: RUN, links, tries: 2, max: 3 }), [
    `🔗 links, on try 2 of 3: ${URL1}`,
    `🔗 may bear on #41 Keep the harness layer thin: "${GIST1}"`,
    `🔗 may bear on #42 Tools a seat can reach: "${SPAN2}"`,
    '2 proposed links to 2 cards (machine guesses; answer them with link_decide)',
    'read it on the board: /reading.html?run=run-44d706e1-16af-4a45-8671-d4baef63563b',
    '(#1852)',
  ].join('\n'));
  assert.equal(linksBody({ url: URL1, runId: RUN, links: { made: true, minScore: 0.6, assertions: 2, proposed: 0, skipped: 2, links: [] }, tries: 3, max: 3 }), [
    `🔗 links, on try 3 of 3: ${URL1}`,
    'links: no new ones; 2 matches at or above 0.6 already had a link (proposed, confirmed or dismissed)',
    'read it on the board: /reading.html?run=run-44d706e1-16af-4a45-8671-d4baef63563b',
    '(#1852)',
  ].join('\n'));
  // 3. the one line when the last try was refused too
  assert.equal(linksGaveUpBody({ url: URL1, runId: RUN, reason: 'search unavailable for a1:\n embedder unavailable', tries: 3, minScore: 0.6 }),
    `⚠️ links not made after 3 tries: ${URL1} (search unavailable for a1: embedder unavailable); make them by hand: scripts/link-run.mjs --run ${RUN} --min-score 0.6 (#1852)`);
  // … and when the last try did not finish: it may have written them, so the line does not say "not made"
  assert.equal(linksGaveUpBody({ url: URL1, runId: RUN, reason: 'r', tries: 3, unfinished: true }),
    `⚠️ links not confirmed after 3 tries: ${URL1} (try 3 did not finish, so its links may already be written); make sure by hand: scripts/link-run.mjs --run ${RUN} (it skips links that exist) (#1852)`);
  // the announcer posts both kinds
  const seen = [];
  const announce = createAnnouncer({ post: async (body) => { seen.push(body); return { id: 'p' }; } });
  assert.equal((await announce({ kind: 'links', url: URL1, runId: RUN, links, tries: 2, max: 3 })).ok, true);
  assert.equal((await announce({ kind: 'links-gave-up', url: URL1, runId: RUN, reason: 'r', tries: 3 })).ok, true);
  assert.match(seen[0], /^🔗 links, on try 2 of 3/); assert.match(seen[1], /^⚠️ links not made after 3 tries/);
});

// ── against a real executor and REST test server ──

let exec, client, SRV, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-retry-1852-'));
  STORE = tmpStore('kl-retry-');
  exec = await startExecutor({ store: STORE, datasetId: 'kl-retry', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kl-retry', timeoutMs: 30000 });
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
function fakeModel() {
  return { async send() { return { status: 200, json: { title: 'Harness', synopsis: 'About harnesses.', items: [
    { block: 1, type: 'definition', span: SPAN1, subject: 'harness', predicate: 'scrum:relatedTo', object: 'model', gist: GIST1 },
    { block: 2, type: 'empirical', span: SPAN2, subject: 'tools', predicate: 'acts_through', object: 'harness' },
  ] } }; } };
}
function fakeRuns() {
  return { async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; },
    async createRun() { return `https://scrumboard.local/activity/run-${crypto.randomUUID()}`; }, async generated() { return { recorded: false }; } };
}
const configFile = (doc) => { const f = path.join(DIR, `linking-${crypto.randomUUID()}.json`); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
const GOOD = { minScore: 0.6, perAssertion: 3, k: 8 };

/** Two fresh cards, and a search that is DOWN until `search.down = false`; `search.asked` counts every question, answered or not. */
async function cardsAndFlakySearch() {
  const cards = [crypto.randomUUID(), crypto.randomUUID()];
  await raw(`INSERT DATA { ${cards.map((id) => `<${cardIriOf(id)}> <${RDF}type> <${RS}Card> .`).join(' ')} }`);
  const table = { [GIST1]: [{ id: cards[0], shortId: 41, title: 'Keep the harness layer thin', score: 0.8 }], [SPAN2]: [{ id: cards[1], shortId: 42, title: 'Tools a seat can reach', score: 0.7 }] };
  const search = async (text) => { search.asked += 1; return search.down ? { ok: false, reason: 'embedder unavailable' } : { ok: true, hits: table[text] ?? [] }; };
  search.down = true; search.asked = 0;
  return { cards, search };
}
const linkerFor = (w, extra = {}) => createRunLinker({ graphClient: client, boardUrl: SRV.baseUrl, actor: 'extractor', configFile: configFile(GOOD), search: w.search, model: 'fake-embed', ...extra });
/** An intake over fresh shared links (one post), with a recorder for everything it reports. */
async function intakeWith({ link, urls = [`https://example.test/kl-retry/${crypto.randomUUID()}`], state = null } = {}) {
  const stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ cursor: await cursorNow(), ...(state ?? {}) }));
  const events = [];
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model: fakeModel(), registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const intake = createIntake({ boardUrl: SRV.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource: async () => ({ text: ARTICLE, encodingFormat: 'text/plain' }),
    extractor, modelKey: 'fake-a', prompt: 'extract v1', sharers: new Set(['person-a']), report: async (e) => { events.push(e); return { ok: true }; }, ...(link ? { link } : {}) });
  if (urls.length) await post('person-a', `worth a read ${urls.join(' ')}`);
  const stateNow = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { intake, events, urls, url: urls[0], stateFile, stateNow };
}
const linksOfRun = (runId) => count(`?l <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> ?a . ?a <${RS}ofRun> <${runId}>`);
const linksToCard = (id) => count(`?l <${RDF}type> <${RS}BearsOn> ; <${RS}bearsOnCard> <${cardIriOf(id)}>`);
const REFUSED = /^search unavailable for https:\/\/scrumboard\.local\/assertion\/[0-9a-f-]+: embedder unavailable$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test('the bounds are the ones the card names', () => { assert.equal(MAX_LINK_TRIES, 3); assert.equal(MAX_LINK_RETRIES_PER_TICK, 2); });

test('P1 refused: the run stays published, the entry is in the state file, and the finish post says the links are not made YET', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  const t = await intakeWith({ link: linkerFor(w) });
  const s = await t.intake.tick();
  assert.equal(s.started.length, 1, JSON.stringify(s)); assert.deepEqual(s.failed, []);
  const job = s.started[0];
  assert.equal(job.outcome, 'complete'); assert.equal(job.published, 2);
  assert.equal(job.links.made, false); assert.match(job.links.reason, REFUSED); assert.equal(job.links.willRetry, true);
  assert.equal(s.pendingLinks, 1); assert.deepEqual(s.linkRetries, []);
  const pl = t.stateNow().pendingLinks;
  assert.equal(pl.length, 1);
  assert.deepEqual(Object.keys(pl[0]).sort(), ['firstRefusedAt', 'lastReason', 'runId', 'tries', 'url']);
  assert.equal(pl[0].runId, job.runId); assert.equal(pl[0].url, t.url); assert.equal(pl[0].tries, 1);
  assert.match(pl[0].lastReason, REFUSED); assert.match(pl[0].firstRefusedAt, ISO);
  assert.deepEqual(t.events.map((e) => e.kind), ['start', 'finish'], 'the finish post is not held back for the retry');
  const line = finishBody(t.events[1]).split('\n').find((l) => l.startsWith('links:'));
  assert.match(line, /^links: not made yet \(search unavailable for .*: embedder unavailable\); the next ticks retry, up to 3 tries$/);
  assert.equal(await linksOfRun(job.runId), 0);
});

test('P2 the next tick retries and succeeds: one follow-up post, the links on the graph, the entry gone; a later tick does nothing', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  const t = await intakeWith({ link: linkerFor(w) });
  const job = (await t.intake.tick()).started[0];
  t.events.length = 0; w.search.down = false;
  const s2 = await t.intake.tick();
  assert.deepEqual(s2.linkRetries, [{ runId: job.runId, url: t.url, try: 2, made: true, proposed: 2, skipped: 0, cards: 2, assertions: 2, minScore: 0.6 }]);
  assert.equal(s2.pendingLinks, 0);
  assert.equal('pendingLinks' in t.stateNow(), false, 'an empty list is not written');
  assert.equal(await linksOfRun(job.runId), 2);
  assert.deepEqual(t.events.map((e) => e.kind), ['links']);
  assert.equal(linksBody(t.events[0]), [
    `🔗 links, on try 2 of 3: ${t.url}`,
    `🔗 may bear on #41 Keep the harness layer thin: "${GIST1}"`,
    `🔗 may bear on #42 Tools a seat can reach: "${SPAN2}"`,
    '2 proposed links to 2 cards (machine guesses; answer them with link_decide)',
    `read it on the board: /reading.html?run=${job.runId.split('/').pop()}`,
    '(#1852)',
  ].join('\n'));
  t.events.length = 0; const asked = w.search.asked;
  const s3 = await t.intake.tick();
  assert.deepEqual(s3.linkRetries, []); assert.deepEqual(t.events, []); assert.equal(w.search.asked, asked, 'nothing is searched again');
  assert.equal(await linksOfRun(job.runId), 2);
});

test('P3 three refusals: nothing is posted on try 2, one final line on try 3, the entry gone, and no fourth try', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  const t = await intakeWith({ link: linkerFor(w) });
  const job = (await t.intake.tick()).started[0];
  t.events.length = 0;
  const s2 = await t.intake.tick();
  assert.equal(s2.linkRetries.length, 1);
  assert.deepEqual({ ...s2.linkRetries[0], reason: null }, { runId: job.runId, url: t.url, try: 2, made: false, reason: null, gaveUp: false });
  assert.match(s2.linkRetries[0].reason, REFUSED);
  assert.equal(s2.pendingLinks, 1); assert.equal(t.stateNow().pendingLinks[0].tries, 2);
  assert.deepEqual(t.events, [], 'a refused retry that will be tried again posts nothing');
  const s3 = await t.intake.tick();
  assert.deepEqual({ ...s3.linkRetries[0], reason: null }, { runId: job.runId, url: t.url, try: 3, made: false, reason: null, gaveUp: true });
  assert.equal(s3.pendingLinks, 0); assert.equal('pendingLinks' in t.stateNow(), false);
  assert.deepEqual(t.events.map((e) => e.kind), ['links-gave-up']);
  const body = linksGaveUpBody(t.events[0]);
  assert.match(body, /^⚠️ links not made after 3 tries: /);
  assert.equal(body, `⚠️ links not made after 3 tries: ${t.url} (${s3.linkRetries[0].reason}); make them by hand: scripts/link-run.mjs --run ${job.runId} --min-score 0.6 (#1852)`);
  assert.equal(body.includes('\n'), false, 'one line');
  t.events.length = 0; const asked = w.search.asked;
  const s4 = await t.intake.tick();
  assert.deepEqual(s4.linkRetries, []); assert.deepEqual(t.events, []); assert.equal(w.search.asked, asked, 'no fourth try');
  assert.equal(asked, 3, 'three tries, each stopped at its first refused search');
  assert.equal(await linksOfRun(job.runId), 0);
});

test('P4 a config refusal is never pending, and its finish line is the one it was', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch(); w.search.down = false;
  const t = await intakeWith({ link: linkerFor(w, { configFile: path.join(DIR, 'no-such-linking.json') }) });
  const s = await t.intake.tick();
  assert.equal(s.started[0].outcome, 'complete');
  assert.deepEqual(s.started[0].links, { made: false, reason: 'no-such-linking.json cannot be read (ENOENT)', willRetry: false });
  assert.equal(s.pendingLinks, 0); assert.equal('pendingLinks' in t.stateNow(), false);
  assert.match(finishBody(t.events[1]), /^links: not made \(no-such-linking\.json cannot be read \(ENOENT\)\)$/m);
  t.events.length = 0;
  const s2 = await t.intake.tick();
  assert.deepEqual(s2.linkRetries, []); assert.deepEqual(t.events, []); assert.equal(w.search.asked, 0);
});

test('P5 a state file from before this change loads and ticks; one written now keeps every older field as it was', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  // the older shape, exactly: no pendingLinks key at all
  const t = await intakeWith({ link: linkerFor(w), state: { mode: 'seq', pending: [], resyncs: [] } });
  assert.equal('pendingLinks' in t.stateNow(), false);
  assert.deepEqual(t.intake.readState().pendingLinks, [], 'absent reads as none');
  const s = await t.intake.tick();
  assert.equal(s.started.length, 1); assert.equal(s.pendingLinks, 1);
  const now = t.stateNow();
  // what the reader before this change takes from the file: every one of these is still there, in the shape it had
  assert.equal(typeof now.cursor, 'string'); assert.equal(now.mode, 'seq'); assert.deepEqual(now.pending, []); assert.deepEqual(now.resyncs, []);
  assert.match(now.updatedAt, ISO); assert.match(now.lastReadAt, ISO);
  assert.deepEqual(Object.keys(now).sort(), ['cursor', 'lastReadAt', 'mode', 'pending', 'pendingLinks', 'resyncs', 'updatedAt'], 'one new key, nothing renamed');
  // junk in the new field is dropped on read, never thrown on
  fs.writeFileSync(t.stateFile, JSON.stringify({ ...now, pendingLinks: [null, 7, { runId: 5 }, { runId: 'https://scrumboard.local/activity/run-x', url: 'u', tries: 'two' }, now.pendingLinks[0]] }));
  assert.deepEqual(t.intake.readState().pendingLinks, [now.pendingLinks[0]]);
  fs.writeFileSync(t.stateFile, JSON.stringify({ ...now, pendingLinks: 'nope' }));
  assert.deepEqual(t.intake.readState().pendingLinks, []);
});

test('P6 the per-tick cap: three pending runs are retried two, then one, oldest first', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  const urls = [1, 2, 3].map((n) => `https://example.test/kl-retry/${crypto.randomUUID()}-${n}`);
  const t = await intakeWith({ link: linkerFor(w), urls });
  const s1 = await t.intake.tick();
  assert.equal(s1.started.length, 3, JSON.stringify(s1)); assert.equal(s1.pendingLinks, 3);
  assert.deepEqual(t.stateNow().pendingLinks.map((p) => p.url), urls, 'in the order they were refused');
  t.events.length = 0; w.search.down = false;
  const s2 = await t.intake.tick();
  assert.deepEqual(s2.linkRetries.map((r) => [r.url, r.try, r.made]), [[urls[0], 2, true], [urls[1], 2, true]], 'two this tick, the oldest first');
  assert.equal(s2.pendingLinks, 1); assert.deepEqual(t.stateNow().pendingLinks.map((p) => [p.url, p.tries]), [[urls[2], 1]], 'the third has not been tried again');
  // the three runs read the same text, so the first run's links are every run's links: the second is "no new ones"
  assert.deepEqual(s2.linkRetries.map((r) => [r.proposed, r.skipped]), [[2, 0], [0, 2]]);
  const s3 = await t.intake.tick();
  assert.deepEqual(s3.linkRetries.map((r) => [r.url, r.try, r.made]), [[urls[2], 2, true]]);
  assert.equal(s3.pendingLinks, 0);
  assert.deepEqual(t.events.map((e) => [e.kind, e.url]), [['links', urls[0]], ['links', urls[1]], ['links', urls[2]]], 'one follow-up per run');
  assert.equal(await linksToCard(w.cards[0]), 1); assert.equal(await linksToCard(w.cards[1]), 1);
});

test('P7 the links were written but the entry was not removed: the retry proposes nothing new and posts "no new ones" once', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  const link = linkerFor(w);
  const t = await intakeWith({ link });
  const job = (await t.intake.tick()).started[0];
  assert.equal(t.stateNow().pendingLinks.length, 1);
  // a retry wrote the links and the tick died before it saved its state: the graph has them, the state file still lists the run
  w.search.down = false;
  const wrote = await link({ runId: job.runId });
  assert.equal(wrote.proposed, 2); assert.equal(await linksOfRun(job.runId), 2);
  assert.equal(t.stateNow().pendingLinks.length, 1);
  t.events.length = 0;
  const s2 = await t.intake.tick();
  assert.deepEqual(s2.linkRetries, [{ runId: job.runId, url: t.url, try: 2, made: true, proposed: 0, skipped: 2, cards: 0, assertions: 2, minScore: 0.6 }]);
  assert.equal(await linksOfRun(job.runId), 2, 'still two links');
  assert.deepEqual(t.events.map((e) => e.kind), ['links']);
  assert.equal(linksBody(t.events[0]), [
    `🔗 links, on try 2 of 3: ${t.url}`,
    'links: no new ones; 2 matches at or above 0.6 already had a link (proposed, confirmed or dismissed)',
    `read it on the board: /reading.html?run=${job.runId.split('/').pop()}`,
    '(#1852)',
  ].join('\n'));
  t.events.length = 0;
  const s3 = await t.intake.tick();
  assert.deepEqual(s3.linkRetries, []); assert.deepEqual(t.events, [], 'said once');
});

test('P7b the entry leaves the state file BEFORE its follow-up is posted, so a tick that dies in between posts nothing twice', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch();
  const t = await intakeWith({ link: linkerFor(w) });
  await t.intake.tick();
  w.search.down = false;
  let seenAtPost = null;
  const stateFile = t.stateFile;
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model: fakeModel(), registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const watching = createIntake({ boardUrl: SRV.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource: async () => ({ text: ARTICLE }), extractor, modelKey: 'fake-a', prompt: 'extract v1', sharers: new Set(['person-a']),
    link: linkerFor(w), report: async (e) => { if (e.kind === 'links') seenAtPost = 'pendingLinks' in JSON.parse(fs.readFileSync(stateFile, 'utf8')); throw new Error('the tick died here'); } });
  const s = await watching.tick();
  assert.equal(seenAtPost, false, 'when the follow-up is being posted, the state file no longer lists the run');
  assert.equal(s.linkRetries[0].made, true); assert.equal(s.reportErrors, 1, 'a lost follow-up is counted, never retried');
});

test('P8 a tick that died inside a try: the try is already counted', { skip: SKIP }, async () => {
  const w = await cardsAndFlakySearch(); w.search.down = false;
  const link = linkerFor(w);
  // a run with real claims, never linked
  const made = await intakeWith({});
  const job = (await made.intake.tick()).started[0];
  const entry = (tries) => ({ runId: job.runId, url: made.url, tries, lastReason: 'embedder unavailable', firstRefusedAt: new Date().toISOString(), trying: true });
  // two tries begun (the second never finished): one more is made, as try 3
  const a = await intakeWith({ link, urls: [], state: { pendingLinks: [entry(2)] } });
  const sa = await a.intake.tick();
  assert.deepEqual(sa.linkRetries.map((r) => [r.try, r.made, r.proposed]), [[3, true, 2]]);
  assert.equal(sa.pendingLinks, 0);
  // three tries begun: none is made, and the post does not claim the links are missing
  const asked = w.search.asked;
  const b = await intakeWith({ link, urls: [], state: { pendingLinks: [entry(3)] } });
  const sb = await b.intake.tick();
  assert.equal(w.search.asked, asked, 'no fourth try');
  assert.deepEqual(sb.linkRetries, [{ runId: job.runId, url: made.url, try: 3, made: false, reason: 'try 3 did not finish', gaveUp: true }]);
  assert.equal(sb.pendingLinks, 0); assert.equal('pendingLinks' in b.stateNow(), false);
  assert.deepEqual(b.events.map((e) => e.kind), ['links-gave-up']);
  assert.match(linksGaveUpBody(b.events[0]), /^⚠️ links not confirmed after 3 tries: .*\(try 3 did not finish, so its links may already be written\); make sure by hand: scripts\/link-run\.mjs --run /);
  // and the try is counted in the file BEFORE it is made: a linker that never returns leaves tries at 2, not 1
  const c = await intakeWith({ link: async () => { stuck.tries = c.stateNow().pendingLinks[0].tries; stuck.trying = c.stateNow().pendingLinks[0].trying; throw new Error('killed'); }, urls: [], state: { pendingLinks: [{ ...entry(1), trying: undefined }] } });
  const stuck = {};
  await c.intake.tick();
  assert.deepEqual(stuck, { tries: 2, trying: true });
});

const havePdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('P9 the named-file path does not retry: its finish line says how to make the links by hand', { skip: !havePdftotext && 'pdftotext is not installed' }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-retry-file-'));
  try {
    const text = 'The only page makes one claim plainly.';
    const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
      + '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 9 0 R >> >> >> endobj\n'
      + `4 0 obj << /Length ${text.length + 30} >> stream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream endobj\n`
      + '9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
    const file = path.join(d, 'one.pdf'); fs.writeFileSync(file, pdf);
    const runId = 'https://scrumboard.local/activity/run-file-1';
    const ex = { promptVersion: () => 'v1', async state({ jobId }) { return { jobId, outcome: null, runId: null, next: [] }; },
      async run({ jobId }) { return { jobId, runId, outcome: 'complete', rejected: [], published: [{ iri: 'urn:x:1', block: 0, type: 'empirical', predicate: 'scrum:relatedTo', subject: 'page', object: 'claim' }] }; } };
    const events = [];
    const out = await extractFile({ file, extractor: ex, sourcesDir: path.join(d, 's'), modelKey: 'm', prompt: 'p', askedIn: 'post-1', report: async (e) => { events.push(e); return { ok: true }; },
      link: async () => ({ made: false, reason: 'search unavailable for urn:x:1: embedder unavailable', retryable: true, minScore: 0.6 }) });
    assert.equal(out.outcome, 'complete');
    assert.deepEqual(out.links, { made: false, reason: 'search unavailable for urn:x:1: embedder unavailable', willRetry: false });
    const line = finishBody(events[1]).split('\n').find((l) => l.startsWith('links:'));
    assert.equal(line, `links: not made (search unavailable for urn:x:1: embedder unavailable); make them with scripts/link-run.mjs --run ${runId} --min-score 0.6`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
