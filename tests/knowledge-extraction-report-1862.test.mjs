/**
 * #1862 — an extraction run reports itself in the room: one post when it starts on a source, one when it ends
 * (what it wrote, by type, and how to open it) or fails (and why). Two posts per run, never a stream.
 *
 *   B1  startBody names the source, the model key and the job; a resumed job says it is resuming.
 *   B2  finishBody counts what was written BY TYPE: assertions, distinct concepts, each assertion type, each predicate,
 *       and rejections by reason; it shows a few assertions as subject —predicate→ object with their block; it names the
 *       run and gives a graph_query that opens exactly that run's assertions.
 *   B3  a run that published nothing says so plainly (and still names the run and its rejections).
 *   B4  failBody names the source and the reason, and says whether the job will be retried.
 *   B5  createAnnouncer never throws: a post that fails is RETURNED as an error, so a report can never fail a job.
 *   I1  against a real executor + REST test server: with a `report` hook, a tick that runs one job reports start THEN
 *       finish; each published item carries its subject and object; and the graph_query the finish post hands a person
 *       RUNS (no triple term in a result column, #1846) and returns exactly that run's assertions.
 *   I2  a fetch failure reports one fail (not retried); a throwing reporter cannot fail a job (counted in reportErrors);
 *       with no hook the tick posts nothing new (R9's guarantee, unchanged).
 *   I3  a wrong span costs ONE repair call, and the run says how many it spent (`repairs`, kept out of R6's counters).
 *   Sabotage, 2026-11-09: dropping the repair count turns I3 red; dropping the finish report turns I1 and I2 red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after } from 'node:test';
import { startBody, finishBody, failBody, createAnnouncer, ofRunQuery } from '../core/knowledge-extraction-report.mjs';
import { createIntake } from '../core/knowledge-extraction-intake.mjs';
import { createExtractor } from '../core/knowledge-extraction.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';

const URL1 = 'https://example.test/articles/harness';
const RUN = 'https://scrumboard.local/activity/run-abc';

const result = {
  runId: RUN, outcome: 'partial', proposals: 5, counters: { spanInventions: 2, providerFailures: 0 }, repairs: 3,
  published: [
    { iri: 'a1', block: 1, type: 'definition', predicate: 'scrum:relatedTo', subject: 'harness', object: 'model' },
    { iri: 'a2', block: 2, type: 'empirical', predicate: 'scrum:relatedTo', subject: 'harness', object: 'tools' },
    { iri: 'a3', block: 4, type: 'recommendation', predicate: 'schema:about', subject: 'Tools', object: 'action' },
  ],
  rejected: [
    { iri: 'r1', reason: 'span-mismatch', detail: 'x' },
    { iri: 'r2', reason: 'span-mismatch', detail: 'y' },
  ],
};

test('B1: the start post names the source, the model and the job; a resume says so', () => {
  const b = startBody({ url: URL1, modelKey: 'deepseek-v4-flash', jobId: 'job-1' });
  assert.match(b, /^🧪 extraction started/);
  assert.ok(b.includes(URL1), 'names the source');
  assert.ok(b.includes('deepseek-v4-flash'), 'names the model key');
  assert.ok(b.includes('job-1'), 'names the job');
  const r = startBody({ url: URL1, modelKey: 'deepseek-v4-flash', jobId: 'job-1', resumed: true });
  assert.match(r, /resum/i);
});

test('B2: the finish post counts what was written BY TYPE, shows a few assertions, and opens the run', () => {
  const b = finishBody({ url: URL1, result });
  assert.match(b, /^✅ extraction finished \(partial\)/);
  assert.match(b, /3 assertions/);
  // harness, model, tools, action — "Tools" and "tools" are one concept (the IRI is a slug)
  assert.match(b, /4 concepts/);
  assert.match(b, /definition 1/); assert.match(b, /empirical 1/); assert.match(b, /recommendation 1/);
  assert.match(b, /scrum:relatedTo 2/); assert.match(b, /schema:about 1/);
  assert.match(b, /2 rejected: span-mismatch 2/);
  assert.match(b, /5 proposed · span repairs 3 · span inventions 2 · provider failures 0/, 'the cost side: how many model calls went to repairs');
  assert.ok(b.includes('harness —scrum:relatedTo→ model (definition, block 1)'), 'shows an assertion as an edge');
  assert.ok(b.includes(RUN), 'names the run');
  assert.ok(b.includes(ofRunQuery(RUN)), 'gives the query that opens this run');
  assert.ok(b.includes(URL1));
});

test('B2b: ofRunQuery selects exactly the run\'s assertions with their triple', () => {
  const q = ofRunQuery(RUN);
  assert.ok(q.includes(`<${RUN}>`));
  assert.match(q, /scrum:ofRun|ns#ofRun/);
  assert.match(q, /^SELECT/);
});

test('B2c: at most five assertions are shown, and the rest are counted, not listed', () => {
  const many = { ...result, published: Array.from({ length: 9 }, (_, k) => ({ iri: `a${k}`, block: k, type: 'definition', predicate: 'scrum:relatedTo', subject: `s${k}`, object: `o${k}` })), rejected: [] };
  const b = finishBody({ url: URL1, result: many });
  assert.equal((b.match(/—scrum:relatedTo→/g) || []).length, 5);
  assert.match(b, /and 4 more/);
});

test('B3: a run that published nothing says so, and still names the run and its rejections', () => {
  const b = finishBody({ url: URL1, result: { ...result, outcome: 'failed', published: [] } });
  assert.match(b, /^⚠️ extraction finished \(failed\)/);
  assert.match(b, /nothing was written/);
  assert.match(b, /2 rejected/);
  assert.ok(b.includes(RUN));
});

test('B4: the fail post names the source, the reason, and whether it will be retried', () => {
  const b = failBody({ url: URL1, reason: 'fetch: http 404', retry: false });
  assert.match(b, /^❌ extraction failed/);
  assert.ok(b.includes(URL1)); assert.ok(b.includes('fetch: http 404'));
  assert.match(b, /not retried/);
  assert.match(failBody({ url: URL1, reason: 'run: boom', retry: true }), /next tick resumes/);
});

test('B5: the announcer never throws; a failed post comes back as an error', async () => {
  const bad = createAnnouncer({ post: async () => { throw new Error('board down'); } });
  const r = await bad({ kind: 'start', url: URL1, modelKey: 'm', jobId: 'j' });
  assert.equal(r.ok, false); assert.match(r.error, /board down/);
  const seen = [];
  const good = createAnnouncer({ post: async (body) => { seen.push(body); return { id: 'p1' }; } });
  const g = await good({ kind: 'finish', url: URL1, result });
  assert.equal(g.ok, true); assert.equal(seen.length, 1); assert.match(seen[0], /extraction finished/);
  const u = await good({ kind: 'nonsense' });
  assert.equal(u.ok, false, 'an unknown kind is refused, not posted');
  assert.equal(seen.length, 1);
});

// ── against a real executor and REST test server: the wiring, and the query the finish post hands a person ──

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const ARTICLE = ['What is a harness?', 'A harness is the layer between a model and the world.', 'Tools are how it acts.'].join('\n');
let exec, client, SRV, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-report-1862-'));
  STORE = tmpStore('kx-report-');
  exec = await startExecutor({ store: STORE, datasetId: 'kx-report', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kx-report', timeoutMs: 30000 });
  SRV = await startRestServer({});
});
after(async () => { await SRV?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); if (STORE) fs.rmSync(STORE, { recursive: true, force: true }); });

const post = async (author, body) => (await fetch(`${SRV.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author, body }) })).json();
const cursorNow = async () => (await (await fetch(`${SRV.baseUrl}/api/conversations?afterSeq=start&limit=200`)).json()).nextAfterSeq;
function fakeModel() {
  return { async send() { return { status: 200, json: { title: 'Harness', synopsis: 'About harnesses.', items: [
    { block: 1, type: 'definition', span: 'A harness is the layer between a model and the world.', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' },
    { block: 2, type: 'empirical', span: 'Tools are how it acts.', subject: 'tools', predicate: 'acts_through', object: 'harness' },
  ] } }; } };
}
function fakeRuns() {
  return { async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; },
    async createRun() { return `https://scrumboard.local/activity/run-${crypto.randomUUID()}`; }, async generated() { return { recorded: false }; } };
}
async function intakeWith({ url, fetchSource, report }) {
  const stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ cursor: await cursorNow() }));
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model: fakeModel(), registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const intake = createIntake({ boardUrl: SRV.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource, extractor, modelKey: 'fake-a', prompt: 'extract v1', sharers: new Set(['person-a']), ...(report ? { report } : {}) });
  await post('person-a', `worth a read ${url}`);
  return intake;
}

test('I1: a tick that runs one job reports start THEN finish, and the finish post\'s query opens exactly what was written', { skip: SKIP }, async () => {
  const url = `https://example.test/kx-1862/${crypto.randomUUID()}`;
  const events = [];
  const intake = await intakeWith({ url, fetchSource: async () => ({ text: ARTICLE, encodingFormat: 'text/plain' }), report: async (e) => { events.push(e); return { ok: true }; } });
  const s = await intake.tick();
  assert.equal(s.started.length, 1, JSON.stringify(s));
  assert.deepEqual(events.map((e) => e.kind), ['start', 'finish']);
  assert.equal(events[0].url, url);
  const r = events[1].result;
  assert.equal(r.published.length, 2);
  assert.deepEqual(r.published.map((a) => [a.subject, a.object]), [['harness', 'model'], ['tools', 'harness']], 'each published item carries its names');

  // the body a person reads, and the query it hands them, run against the real store
  const body = finishBody({ url, result: r });
  assert.match(body, /wrote 2 assertions about 3 concepts/);
  assert.match(body, /scrum:relatedTo \(proposed acts_through\) 1/);
  const rows = await client.query(ofRunQuery(r.runId));
  assert.ok(rows.ok, `the query in the finish post must run (#1846 shape): ${rows.reason}`);
  assert.equal(rows.rows.length, 2, 'one row per assertion of THIS run');
  const subjects = rows.rows.map((x) => x.s.value).sort();
  assert.deepEqual(subjects, ['https://scrumboard.local/concept/harness', 'https://scrumboard.local/concept/tools']);
  assert.ok(rows.rows.every((x) => x.p && x.o && x.type && x.passage), 'type and passage come back too');
  assert.deepEqual(rows.rows.map((x) => x.proposed?.value).filter(Boolean), ['acts_through']);
});

test('I2: a fetch failure reports ONE fail, not retried; a throwing reporter cannot fail a job; no reporter posts nothing new', { skip: SKIP }, async () => {
  const events = [];
  const url = `https://example.test/kx-1862/${crypto.randomUUID()}`;
  const bad = await intakeWith({ url, fetchSource: async () => { throw new Error('http 404'); }, report: async (e) => { events.push(e); return { ok: true }; } });
  const s = await bad.tick();
  assert.equal(s.failed.length, 1);
  assert.deepEqual(events.map((e) => e.kind), ['fail']);
  assert.match(events[0].reason, /404/); assert.equal(events[0].retry, false);

  const url2 = `https://example.test/kx-1862/${crypto.randomUUID()}`;
  const loud = await intakeWith({ url: url2, fetchSource: async () => ({ text: ARTICLE }), report: async () => { throw new Error('board down'); } });
  const s2 = await loud.tick();
  assert.equal(s2.started.length, 1, 'the job still ran and finished');
  assert.equal(s2.reportErrors, 2, 'both lost posts are counted (start and finish)');

  const url3 = `https://example.test/kx-1862/${crypto.randomUUID()}`;
  const quiet = await intakeWith({ url: url3, fetchSource: async () => ({ text: ARTICLE }) });
  const before3 = (await (await fetch(`${SRV.baseUrl}/api/conversations`)).json()).length;
  const s3 = await quiet.tick();
  assert.equal(s3.started.length, 1);
  assert.equal((await (await fetch(`${SRV.baseUrl}/api/conversations`)).json()).length, before3, 'no reporter: the tick posts nothing');
  assert.equal('reportErrors' in s3, false);
});

test('I3: a span the model got wrong costs ONE repair call, and the run says how many it spent', { skip: SKIP }, async () => {
  let calls = 0;
  const model = { async send() {
    calls += 1;
    if (calls === 1) return { status: 200, json: { title: 'H', synopsis: 'S', items: [
      { block: 1, type: 'definition', span: 'A harness is the layer between a model and the world.', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' },
      { block: 2, type: 'empirical', span: 'Tools are how harnesses act in the world.', subject: 'tools', predicate: 'scrum:relatedTo', object: 'harness' },
    ] } };
    return { status: 200, json: { items: [{ block: 2, type: 'empirical', span: 'Tools are how it acts.', subject: 'tools', predicate: 'scrum:relatedTo', object: 'harness' }] } };
  } };
  const extractor = createExtractor({ graphClient: client, runs: fakeRuns(), model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const { ingestSource } = await import('../core/knowledge-extraction.mjs');
  const url = `https://example.test/kx-1862/${crypto.randomUUID()}`;
  const source = ingestSource({ text: ARTICLE, url, contentUrl: url });
  const r = await extractor.run({ source, modelKey: 'fake-a', prompt: 'p' });
  assert.equal(calls, 2, 'one first pass + one repair');
  assert.equal(r.repairs, 1);
  assert.equal(r.published.length, 2, 'the repaired item published');
  assert.match(finishBody({ url, result: r }), /span repairs 1 · span inventions 0/);
});
