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

let exec, client, SRV, DIR;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-intake-1810-'));
  exec = await startExecutor({ store: tmpStore('kx-intake-'), datasetId: 'kx-intake', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kx-intake', timeoutMs: 30000 });
  SRV = await startRestServer({});
});
after(async () => { await SRV?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); });

const post = async (author, body) => (await fetch(`${SRV.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author, body }) })).json();
const postCount = async () => (await (await fetch(`${SRV.baseUrl}/api/conversations`)).json()).length;
const q = async (s) => { const r = await client.query(s); assert.ok(r.ok, r.reason); return r.rows; };

function fakeModel() {
  return { bodies: [], async send(body) { this.bodies.push(body); return { status: 200, json: { items: [{ block: 1, type: 'definition', span: 'A harness is the layer between a model and the world.', subject: 'harness', predicate: 'scrum:relatedTo', object: 'model' }] } }; } };
}
function fakeRuns() {
  const runs = [];
  return { runs, async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; },
    async createRun({ op, by, performedUsing, used }) { const iri = `https://scrumboard.local/activity/run-${crypto.randomUUID()}`; runs.push({ iri, op, by, performedUsing, used }); return iri; },
    async generated() { return { recorded: false }; } };
}
function intakeWith({ fetchSource, model = fakeModel(), stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`) } = {}) {
  const runs = fakeRuns();
  const extractor = createExtractor({ graphClient: client, runs, model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const intake = createIntake({ boardUrl: SRV.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource, extractor, modelKey: 'fake-a', prompt: 'extract v1' });
  return { intake, runs, model, stateFile };
}

test('#1810 R9 — a share queues ONE job for its URL, derived from the post, with no seat in the path; the same link twice is one job; no link or a board author is nothing', { skip: SKIP }, async () => {
  const p1 = await post('person-a', `A colleague wrote this up, worth a read: ${U}`);
  await post('person-b', `Same one as above ${U} — I'll read it tonight.`);
  await post('person-c', 'No link here, just a thought about harnesses.');
  await post('board', `MAINTENANCE: see ${U}-by-the-board`);   // a DIFFERENT url, so "board authors are never sources" is its own rule, not the dedupe
  const fetched = [];
  const { intake, runs, model, stateFile } = intakeWith({ fetchSource: async (url) => { fetched.push(url); return { text: ARTICLE, encodingFormat: 'text/plain' }; } });
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
  await post('person-a', `Try ${BAD}`);
  let tries = 0;
  const { intake, model } = intakeWith({ fetchSource: async () => { tries += 1; throw new Error('fetch: 404'); } });
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
