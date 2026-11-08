/**
 * #1810 PR B — R9, the intake: a share in the commons queues ONE job, and no seat touches it.
 *
 * Production creates posts through the graph unit, so REST's post handler is the wrong seam. The service POLLS: one
 * tick reads the posts since its cursor (seq mode: afterSeq=start|<cursor>, limit), finds https:// links in bodies by
 * people (never by `board`/`system`), and for each URL it has not seen starts a LangGraph job whose thread id is
 * derived from the URL. The saver's state is the queue and the dedupe; the cursor persists in a state file.
 *
 *   R9   four posts land: p1 (person-a) with link U, p2 with the same U, p3 with no link, p4 by `board` with ANOTHER link.
 *        tick() → exactly ONE job, for U, its Source wasDerivedFrom p1's post IRI; the cursor advanced and persisted; a
 *        second tick() starts nothing; p3 and p4 start nothing. No POST /api/conversations happened in the path.
 *   R9b  a URL whose fetch fails is a failed job (provider failure), recorded, not retried within the tick; the cursor
 *        still advances past the post.
 *   R9c  linksOf: https only (http:// is not a source), trailing punctuation stripped, duplicates within one post
 *        collapsed, markdown link targets found.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { createExtractor } from '../core/knowledge-extraction.mjs';
import { createIntake, linksOf } from '../core/knowledge-extraction-intake.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ARTICLE = ['What is a harness?', 'A harness is the layer between a model and the world.', 'Tools are how it acts.'].join('\n');
const U = 'https://example.test/articles/harness';

let exec, client, SRV, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-intake-1810-'));
  STORE = tmpStore('kx-intake-');   // retained so after() can remove it, whether or not the executor started
  exec = await startExecutor({ store: STORE, datasetId: 'kx-intake', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kx-intake', timeoutMs: 30000 });
  SRV = await startRestServer({});
});
after(async () => { await SRV?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); if (STORE) fs.rmSync(STORE, { recursive: true, force: true }); });   // #1672: this file's own temp only, store included

const post = async (author, body) => (await fetch(`${SRV.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author, body }) })).json();
const postCount = async () => (await (await fetch(`${SRV.baseUrl}/api/conversations`)).json()).length;
const q = async (s) => { const r = await client.query(s); assert.ok(r.ok, r.reason); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);

function fakeModel() {
  return { bodies: [], async send(body) { this.bodies.push(body); return { status: 200, json: { items: [{ block: 1, type: 'definition', span: 'A harness is the layer between a model and the world.', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' }] } }; } };
}
function fakeRuns() {
  const runs = [];
  return { runs, async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; },
    async createRun({ op, by, performedUsing, used }) { const iri = `https://scrumboard.local/activity/run-${crypto.randomUUID()}`; runs.push({ iri, op, by, performedUsing, used }); return iri; },
    async generated() { return { recorded: false }; } };
}
/** The post-sequence cursor at the current end: an intake seeded with it reads only posts made after this call. */
async function cursorNow() {
  const j = await (await fetch(`${SRV.baseUrl}/api/conversations?afterSeq=start&limit=200`)).json();
  return j.nextAfterSeq;
}
/** A fetch stub that serves ONE url and refuses every other, so a row's stub never answers for another row's link. */
const serves = (url, text = ARTICLE) => async (u) => { if (u !== url) throw new Error(`fetch: not this row's url (${u})`); return { text, encodingFormat: 'text/plain' }; };
function intakeWith({ fetchSource, model = fakeModel(), stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`), sharers = ['person-a', 'person-b', 'person-c', 'person-d'], graphClient = client, cursor = null } = {}) {
  if (cursor) fs.writeFileSync(stateFile, JSON.stringify({ cursor }));
  const runs = fakeRuns();
  const extractor = createExtractor({ graphClient, runs, model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const intake = createIntake({ boardUrl: SRV.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource, extractor, modelKey: 'fake-a', prompt: 'extract v1', sharers: new Set(sharers) });
  return { intake, runs, model, stateFile };
}
/** A graph client whose FIRST extraction.publish fails: the job dies mid-run, after the model was asked. */
function publishFailsOnce(base) {
  let armed = true;
  return { ...base, async update(intention, opts) { if (armed && intention?.kind === 'extraction.publish') { armed = false; throw new Error('injected: executor unreachable at publish'); } return base.update(intention, opts); } };
}

test('#1810 R9 — a share queues ONE job for its URL, derived from the post, with no seat in the path; the same link twice is one job; no link or a board author is nothing', { skip: SKIP }, async () => {
  const cursorBeforeR9 = await cursorNow();   // a fresh install starts at the head (R9d/R9e), so this row seeds just before its own posts
  const p1 = await post('person-a', `A colleague wrote this up, worth a read: ${U}`);
  await post('person-b', `Same one as above ${U} — I'll read it tonight.`);
  await post('person-c', 'No link here, just a thought about harnesses.');
  await post('board', `MAINTENANCE: see ${U}-by-the-board`);   // a DIFFERENT url, so "board authors are never sources" is its own rule, not the dedupe
  const fetched = [];
  const { intake, runs, model, stateFile } = intakeWith({ cursor: cursorBeforeR9, fetchSource: async (url) => { fetched.push(url); return { text: ARTICLE, encodingFormat: 'text/plain' }; } });
  const before = await postCount();
  const t1 = await intake.tick();
  assert.deepEqual(t1.started.map((j) => j.url), [U], `one job, for U (${JSON.stringify(t1)})`);
  assert.equal(t1.started[0].jobId, `job-${sha256(U)}`, 'the job id is derived from the URL');
  assert.equal(fetched.length, 1, 'fetched once');
  assert.equal(model.bodies.length, 1, 'the model was asked once');
  assert.equal(runs.runs.length, 1, 'one run');
  const src = await q(`SELECT ?s ?from WHERE { ?s <${RS}contentHash> ${JSON.stringify(`sha256:${sha256(ARTICLE)}`)} ; <${PROV}wasDerivedFrom> ?from }`);
  assert.equal(src.length, 1, 'one SourceVersion for the fetched bytes');
  assert.equal(src[0].from.value, `https://scrumboard.local/entity/${p1.id}`, 'derived from the FIRST post that shared it');
  assert.ok(fs.existsSync(stateFile), 'the cursor persisted');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.match(String(st.cursor), /^ps1\./, 'a post-sequence cursor, not a timestamp');
  assert.equal(await postCount(), before, 'no post was made: no seat spoke');

  const t2 = await intake.tick();
  assert.deepEqual(t2.started, [], 'a second tick starts nothing: the cursor moved and the job is known');
  assert.equal(model.bodies.length, 1); assert.equal(runs.runs.length, 1);

  // the same link shared AGAIN later is still the same job: known by the saver, not re-run
  await post('person-d', `Reposting ${U} for the record.`);
  const t3 = await intake.tick();
  assert.deepEqual(t3.started, []);
  assert.ok(t3.skipped.some((s) => s.url === U && /known|done|complete/.test(s.reason)), `the repeat is skipped and says why (${JSON.stringify(t3.skipped)})`);
  assert.equal(model.bodies.length, 1);
});

test('#1810 R9b — a URL whose fetch fails is a failed job, recorded, not retried in the tick; the cursor still advances', { skip: SKIP }, async () => {
  const BAD = 'https://example.test/articles/gone';
  let tries = 0;
  const cursor = await cursorNow();
  await post('person-a', `Try ${BAD}`);
  const { intake, model } = intakeWith({ cursor, fetchSource: async () => { tries += 1; throw new Error('fetch: 404'); } });
  const t1 = await intake.tick();
  assert.equal(tries, 1, 'one fetch attempt');
  assert.equal(t1.started.length, 0);
  assert.ok(t1.failed.some((f) => f.url === BAD && /404/.test(f.reason)), `the failure is recorded with its reason (${JSON.stringify(t1.failed)})`);
  assert.equal(model.bodies.length, 0, 'no model call without a source');
  const t2 = await intake.tick();
  assert.equal(tries, 1, 'not retried on the next tick either: the cursor moved past the post');
  assert.deepEqual(t2.started, []);
});

test('#1810 R9c — linksOf: https only, trailing punctuation stripped, duplicates collapsed, markdown targets found', () => {
  assert.deepEqual(linksOf(`see ${U}.`), [U]);
  assert.deepEqual(linksOf(`${U} and again ${U}`), [U]);
  assert.deepEqual(linksOf('plain http://example.test/x is not a source'), []);
  assert.deepEqual(linksOf(`[the article](${U}) (${U})`), [U]);
  assert.deepEqual(linksOf('nothing here'), []);
  assert.deepEqual(linksOf(`${U}, then https://example.test/other?x=1&y=2;`), [U, 'https://example.test/other?x=1&y=2']);
});

test('#1810 R9d — a job that dies mid-run is completed on the NEXT tick, from its checkpoint, with no new share and no second model call', { skip: SKIP }, async () => {
  const U2 = 'https://example.test/articles/resume-me';
  const cursor = await cursorNow();
  await post('person-a', `and this ${U2}`);
  const model = fakeModel();
  const { intake, runs, stateFile } = intakeWith({ model, cursor, fetchSource: serves(U2), graphClient: publishFailsOnce(client) });
  const t1 = await intake.tick();
  assert.equal(t1.started.length, 0, `the job did not finish (${JSON.stringify(t1)})`);
  assert.ok(t1.failed.some((f) => f.url === U2 && /injected/.test(f.reason)), `the death is recorded (${JSON.stringify(t1.failed)})`);
  assert.equal(model.bodies.length, 1, 'the model was asked once');
  const st1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(st1.pending?.some((p) => p.url === U2), 'the job is PENDING in the state, not forgotten');
  const t2 = await intake.tick();   // no new post: the cursor has nothing new to read
  assert.equal(t2.read, 0, 'nothing new was read');
  assert.ok(t2.resumed?.some((r) => r.url === U2 && r.outcome === 'complete'), `the pending job was resumed and completed (${JSON.stringify(t2.resumed)})`);
  assert.equal(model.bodies.length, 1, 'and the model was NOT asked again');
  assert.equal(runs.runs.length, 1, 'one run record');
  const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!(st2.pending ?? []).some((p) => p.url === U2), 'no longer pending');
  // the ExtractionReport carries ofRun too, so count ASSERTIONS of the run, not everything that points at it
  assert.equal(await count(`?a <${RS}ofRun> <${runs.runs[0].iri}> ; <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RS}Assertion>`), 1, 'its assertion is in the graph');
});

test('#1810 R9e (authors) — only a configured sharer\'s link becomes a job (the PO\'s ruling: what the owner shares, not what seats post); everyone else is skipped and says so', { skip: SKIP }, async () => {
  const U3 = 'https://example.test/articles/by-a-seat';
  const U4 = 'https://example.test/articles/by-the-owner';
  const cursor = await cursorNow();
  await post('seat-x', `CI is green: ${U3}`);
  await post('person-a', `read this: ${U4}`);
  const model = fakeModel();
  const { intake } = intakeWith({ model, cursor, sharers: ['person-a'], fetchSource: serves(U4) });
  const t = await intake.tick();
  assert.deepEqual(t.started.map((j) => j.url), [U4], `only the sharer's link (${JSON.stringify(t.started)})`);
  assert.ok(t.skipped.some((s) => s.url === U3 && /sharer/.test(s.reason)), `the seat's link is skipped with the reason (${JSON.stringify(t.skipped)})`);
  assert.equal(model.bodies.length, 1);
  assert.throws(() => createIntake({ boardUrl: SRV.baseUrl, stateFile: path.join(DIR, 'x.json'), sourcesDir: DIR, fetchSource: async () => null, extractor: {}, modelKey: 'k', prompt: 'p', sharers: new Set() }), /sharers/, 'no sharers configured: refused to construct, nothing runs for nobody');
});

test('#1841 R9l — a sharer\'s post saying "re-run" makes ONE fresh attempt at a link whose job FAILED, keyed .r1, naming the failed run; a plain repost is still skipped, and a link that succeeded is never re-run', { skip: SKIP }, async () => {
  const U5 = 'https://example.test/articles/failed-once';
  const base = `job-${sha256(U5)}`;
  const cursor = await cursorNow();
  const good = fakeModel();
  let calls = 0;
  // the first ask answers with nothing usable (a FAILED job); every later ask answers like the good model
  const model = { bodies: [], async send(body) { this.bodies.push(body); calls += 1; return calls === 1 ? { status: 200, json: { items: [] } } : good.send(body); } };
  const { intake, runs } = intakeWith({ model, cursor, fetchSource: serves(U5) });
  await post('person-a', `read ${U5}`);
  const t1 = await intake.tick();
  assert.equal(t1.started[0]?.outcome, 'failed', `the first job failed (${JSON.stringify(t1)})`);
  const failedRun = t1.started[0].runId;

  await post('person-b', `Reposting ${U5}`);
  const t2 = await intake.tick();
  assert.deepEqual(t2.started, [], 'a plain repost is still skipped');
  assert.ok(t2.skipped.some((s) => s.url === U5 && /known: failed/.test(s.reason)), JSON.stringify(t2.skipped));
  assert.equal(calls, 1, 'no model call for the plain repost');

  const p3 = await post('person-a', `Re-run ${U5} please, the validator is fixed`);
  const t3 = await intake.tick();
  assert.equal(t3.started.length, 1, `one fresh attempt (${JSON.stringify(t3)})`);
  assert.equal(t3.started[0].jobId, `${base}.r1`, 'keyed as the first re-run of the base job');
  assert.equal(t3.started[0].rerunOf, failedRun, 'it names the run that failed');
  assert.equal(t3.started[0].outcome, 'complete');
  assert.equal(calls, 2, 'the model was asked once more');
  assert.equal(runs.runs.length, 2, 'a NEW run, not the old one overwritten');
  const from = await q(`SELECT ?from WHERE { ?s <${RS}contentHash> ${JSON.stringify(`sha256:${sha256(ARTICLE)}`)} ; <${PROV}wasDerivedFrom> ?from }`);
  assert.ok(from.some((r) => r.from.value === `https://scrumboard.local/entity/${p3.id}`), 'the re-run\'s source is derived from the post that asked for it');

  await post('person-a', `re-run ${U5}`);
  const t4 = await intake.tick();
  assert.deepEqual(t4.started, [], 'a link whose re-run COMPLETED is not re-run again');
  assert.ok(t4.skipped.some((s) => s.url === U5 && /complete/.test(s.reason) && /only for a failed/.test(s.reason)), JSON.stringify(t4.skipped));
  assert.equal(calls, 2);
});
