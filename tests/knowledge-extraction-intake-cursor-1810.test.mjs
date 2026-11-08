/**
 * #1810 — the intake's CURSOR on a graph-served board (found by the first live tick, 2026-11-08, #1837).
 *
 * Production serves posts from the graph (SCRUM_GRAPH_UNIT_CONVERSATIONS=1) and the document-path cursor (afterSeq,
 * #1592) mints a new epoch on every read there, so a saved `ps1.` token is stale by the next call and the board's own
 * advice ("resync from afterSeq=start") would page the whole commons and pay for every link ever shared. The graph
 * path has its own cursor, afterCommit (#1574): fenced by the executor's incarnation, `tip` = the live head.
 *
 *   R9d  GRAPH-SERVED board, no state file: the first tick seeds from afterCommit=tip, reads nothing, persists a
 *        `gc1.` cursor in commit mode; a link posted AFTER that is one job on the next tick; the tick after reads
 *        nothing; no request in the whole path used afterSeq.
 *   R9e  DOCUMENT-SERVED board, no state file, posts with links ALREADY on the board: the first tick seeds from
 *        tail=1 and starts nothing for them (never afterSeq=start); a link posted after is one job on the next tick.
 *   R9f  DOCUMENT path, the saved cursor is refused (409, the board advising "resync from afterSeq=start"): the advice
 *        is NOT taken; the intake re-seeds at the head (tail=1), records the skipped window in the state file, and says
 *        so: one stderr line and one commons post by the service's own seat naming the window, so a share made in it
 *        can be re-shared. Nothing is paid.
 *   R9g  GRAPH path, the saved token is FENCED (another executor incarnation, exactly the #1832 restart): same rule,
 *        re-seed at tip, record, announce; a share after the re-seed is one job. Never afterCommit=start.
 *   R9h  the tip probe fails with anything but GRAPH_DISCOVERY_OFF (a 500): the tick throws, no state file is written,
 *        and the document path is NOT tried — a server error never degrades onto the cursor we left.
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
import { createIntake } from '../core/knowledge-extraction-intake.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const DSID = 'kx-cursor';
const ARTICLE = ['What is a cursor?', 'A cursor is a position the reader can resume from.', 'A stale one is a resync.'].join('\n');

let exec, client, DOC, GRAPH, DIR, STORE;
before(async () => {
  if (SKIP) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-cursor-1810-'));
  STORE = tmpStore('kx-cursor-');   // retained so after() can remove it, whether or not the executor started (#1672)
  exec = await startExecutor({ store: STORE, datasetId: DSID, create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000 });
  DOC = await startRestServer({});   // the document-served board: afterSeq works, afterCommit is GRAPH_DISCOVERY_OFF
  GRAPH = await startRestServer({ env: { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });   // posts live in the graph
});
after(async () => { await DOC?.stop(); await GRAPH?.stop(); await killExecutor(exec); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); if (STORE) fs.rmSync(STORE, { recursive: true, force: true }); });

const post = async (srv, author, body) => {
  const r = await fetch(`${srv.baseUrl}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author, body }) });
  const text = await r.text();
  assert.equal(r.status, 201, `post → ${r.status} ${text}`);
  return JSON.parse(text);
};
function fakeModel() {
  return { bodies: [], async send(body) { this.bodies.push(body); return { status: 200, json: { items: [{ block: 1, type: 'definition', span: 'A cursor is a position the reader can resume from.', subject: 'cursor', predicate: 'scrum:relatedTo', object: 'position' }] } }; } };
}
function fakeRuns() {
  const runs = [];
  return { runs, async ensureProcedureVersion() { return 'https://scrumboard.local/procedure-version/pv1'; },
    async createRun({ op, by, performedUsing, used }) { const iri = `https://scrumboard.local/activity/run-${crypto.randomUUID()}`; runs.push({ iri, op, by, performedUsing, used }); return iri; },
    async generated() { return { recorded: false }; } };
}
/** A fetch that records every board URL it was asked for, so a row can assert which cursor family was used. */
function recordingFetch(impl = fetch) {
  const urls = [];
  const f = (url, init) => { urls.push(String(url)); return impl(url, init); };
  f.urls = urls;
  return f;
}
const serves = (url) => async (u) => { if (u !== url) throw new Error(`fetch: not this row's url (${u})`); return { text: ARTICLE, encodingFormat: 'text/plain' }; };
function intakeWith({ srv, fetchSource, fetchImpl = recordingFetch(), stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`), model = fakeModel(), sharers = ['person-a'], log }) {
  const runs = fakeRuns();
  const extractor = createExtractor({ graphClient: client, runs, model, registry: new Set(['scrum:relatedTo']), actor: 'extractor' });
  const intake = createIntake({ boardUrl: srv.baseUrl, stateFile, sourcesDir: path.join(DIR, 'sources'), fetchSource, extractor, modelKey: 'fake-a', prompt: 'extract v1', sharers: new Set(sharers), fetchImpl, ...(log ? { log } : {}) });
  return { intake, runs, model, stateFile, fetchImpl };
}
const state = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('#1810 R9d — graph-served board, no state: the first tick seeds at the live head (afterCommit=tip), a later share is one job, and afterSeq is never requested', { skip: SKIP }, async () => {
  const U = 'https://example.test/articles/cursor-graph';
  await post(GRAPH, 'person-a', `Posted BEFORE the service existed: ${U}-earlier`);   // must not be read: tip is the head
  const { intake, model, stateFile, fetchImpl } = intakeWith({ srv: GRAPH, fetchSource: serves(U) });
  const t0 = await intake.tick();
  assert.deepEqual(t0.started, [], `a fresh install starts at now, not at post 1 (${JSON.stringify(t0)})`);
  assert.equal(t0.read, 0, 'nothing before the seed is read');
  const s0 = state(stateFile);
  assert.equal(s0.mode, 'commit', `the graph path's cursor family is recorded (${JSON.stringify(s0)})`);
  assert.match(String(s0.cursor), /^gc1\./, `a live commit cursor, from tip (${s0.cursor})`);

  await post(GRAPH, 'person-a', `Now that it runs: ${U}`);
  const t1 = await intake.tick();
  assert.deepEqual(t1.started.map((j) => j.url), [U], `the share after the seed is one job (${JSON.stringify(t1)})`);
  assert.equal(model.bodies.length, 1, 'the model was asked once');
  const s1 = state(stateFile);
  assert.match(String(s1.cursor), /^gc1\./); assert.notEqual(s1.cursor, s0.cursor, 'the cursor advanced past the post');

  const t2 = await intake.tick();
  assert.deepEqual(t2.started, []); assert.equal(t2.read, 0, 'nothing new: the cursor is the last delivered commit');
  assert.equal(model.bodies.length, 1);
  assert.ok(fetchImpl.urls.length >= 3, `the board was read (${fetchImpl.urls.length} requests)`);
  assert.ok(fetchImpl.urls.every((u) => !/[?&]afterSeq=/.test(u)), `no request used the document-path cursor on a graph-served board: ${fetchImpl.urls.join(' | ')}`);
});

test('#1810 R9e — document-served board, no state, links already on the board: the first tick seeds from tail=1 and starts nothing for them; afterSeq=start is never requested', { skip: SKIP }, async () => {
  const OLD = 'https://example.test/articles/cursor-doc-old';
  const NEW = 'https://example.test/articles/cursor-doc-new';
  await post(DOC, 'person-a', `An old share: ${OLD}`);
  await post(DOC, 'person-a', `Another old share: ${OLD}/2`);
  const { intake, model, stateFile, fetchImpl } = intakeWith({ srv: DOC, fetchSource: serves(NEW) });
  const t0 = await intake.tick();
  assert.deepEqual(t0.started, [], `old shares are not paid for on a fresh install (${JSON.stringify(t0)})`);
  assert.deepEqual(t0.failed, [], 'and not even attempted');
  const s0 = state(stateFile);
  assert.equal(s0.mode, 'seq', `the document path's cursor family is recorded (${JSON.stringify(s0)})`);
  assert.match(String(s0.cursor), /^ps1\./, 'a post-sequence cursor, from tail');

  await post(DOC, 'person-a', `A new share: ${NEW}`);
  const t1 = await intake.tick();
  assert.deepEqual(t1.started.map((j) => j.url), [NEW]);
  assert.equal(model.bodies.length, 1);
  assert.ok(fetchImpl.urls.every((u) => !/afterSeq=start/.test(u)), `never from the beginning: ${fetchImpl.urls.join(' | ')}`);
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const announcements = async (srv) => (await (await fetch(`${srv.baseUrl}/api/conversations?author=extractor`)).json()).filter((c) => c.author === 'extractor');

test('#1810 R9f — document path, the saved cursor is refused with "resync from start": the advice is refused, the intake re-seeds at the head, records the skipped window and announces it', { skip: SKIP }, async () => {
  const stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`);
  const STALE = 'ps1.00000000-0000-4000-8000-000000000000.41';
  fs.writeFileSync(stateFile, JSON.stringify({ cursor: STALE, mode: 'seq', pending: [], updatedAt: '2026-11-08T13:43:00.000Z' }));
  const posted = [];
  // a board whose epoch changed: the saved cursor is a 409 with the expensive advice; the head is still served; posts are accepted
  const stub = recordingFetch(async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'POST') { posted.push(JSON.parse(init.body)); return json(201, { id: `p-${posted.length}`, ...posted.at(-1) }); }
    if (/[?&]afterCommit=tip/.test(u)) return json(400, { error: 'afterCommit is served only with the graph conversations unit on', code: 'GRAPH_DISCOVERY_OFF' });   // a document-served board, as the real one answers
    if (/[?&]tail=1/.test(u)) return json(200, { conversations: [], nextAfterSeq: 'ps1.11111111-1111-4111-8111-111111111111.900' });
    if (/[?&]afterSeq=/.test(u)) return json(409, { error: 'the post numbering changed', code: 'POST_CURSOR_EPOCH_CHANGED', resync: 'afterSeq=start' });
    throw new Error(`unexpected request ${u}`);
  });
  const errs = [];
  const { intake, model } = intakeWith({ srv: DOC, fetchSource: serves('https://example.test/never'), fetchImpl: stub, stateFile, log: (line) => errs.push(line) });
  const t = await intake.tick();
  assert.deepEqual(t.started, []); assert.equal(model.bodies.length, 0, 'nothing paid');
  assert.ok(stub.urls.every((u) => !/(afterSeq|afterCommit)=start/.test(u)), `the board's resync advice was refused: ${stub.urls.join(' | ')}`);
  const s = state(stateFile);
  assert.equal(s.cursor, 'ps1.11111111-1111-4111-8111-111111111111.900', 'the cursor is the head, not start');
  assert.equal(s.mode, 'seq');
  assert.equal(s.resyncs?.length, 1, `one resync recorded (${JSON.stringify(s)})`);
  assert.equal(s.resyncs[0].from, STALE); assert.match(s.resyncs[0].reason, /409|EPOCH/);
  assert.equal(s.resyncs[0].skippedSince, '2026-11-08T13:43:00.000Z', 'the window starts at the last good read');
  assert.equal(t.resync?.from, STALE, `the tick's summary carries it (${JSON.stringify(t)})`);
  assert.ok(errs.some((l) => /re-?seed|resync/i.test(l) && /2026-11-08T13:43/.test(l)), `one log line names the window (${JSON.stringify(errs)})`);
  assert.equal(posted.length, 1, 'one commons post');
  assert.equal(posted[0].author, 'extractor');
  assert.match(posted[0].body, /2026-11-08T13:43/, 'the post names the start of the skipped window');
  assert.match(posted[0].body, /re-?share/i, 'and asks for a re-share');
});

test('#1810 R9g — graph path, the saved token is fenced by another executor incarnation: re-seed at tip, record, announce; a share after it is one job; never afterCommit=start', { skip: SKIP }, async () => {
  const U = 'https://example.test/articles/cursor-after-fence';
  const tip = (await (await fetch(`${GRAPH.baseUrl}/api/conversations?afterCommit=tip&limit=1`)).json()).nextAfterCommit;
  assert.match(tip, /^gc1\./);
  const FENCED = tip.replace(/^gc1\.[0-9a-f-]+\./, 'gc1.00000000-0000-4000-8000-000000000000.');   // a token from another incarnation, same shape
  const stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ cursor: FENCED, mode: 'commit', pending: [], updatedAt: '2026-11-08T15:00:00.000Z' }));
  const before = (await announcements(GRAPH)).length;
  const { intake, model, fetchImpl } = intakeWith({ srv: GRAPH, fetchSource: serves(U), stateFile });
  const t0 = await intake.tick();
  assert.deepEqual(t0.started, []); assert.equal(model.bodies.length, 0);
  const s0 = state(stateFile);
  assert.match(String(s0.cursor), /^gc1\./); assert.notEqual(s0.cursor, FENCED, 'the fenced token was replaced');
  assert.equal(s0.resyncs?.length, 1, JSON.stringify(s0)); assert.equal(s0.resyncs[0].from, FENCED); assert.equal(s0.resyncs[0].skippedSince, '2026-11-08T15:00:00.000Z');
  const ann = await announcements(GRAPH);
  assert.equal(ann.length, before + 1, 'one commons post by the service seat');
  assert.match(ann.at(-1).body, /2026-11-08T15:00/);
  assert.ok(fetchImpl.urls.every((u) => !/(afterSeq|afterCommit)=start/.test(u)), fetchImpl.urls.join(' | '));

  await post(GRAPH, 'person-a', `After the restart: ${U}`);
  const t1 = await intake.tick();
  assert.deepEqual(t1.started.map((j) => j.url), [U], `the re-seeded cursor is live (${JSON.stringify(t1)})`);
  assert.equal(model.bodies.length, 1);
});

test('#1810 R9h — the tip probe fails with a server error (not GRAPH_DISCOVERY_OFF): the tick throws, writes no state, and does not fall back to the document path', { skip: SKIP }, async () => {
  const stateFile = path.join(DIR, `state-${crypto.randomUUID()}.json`);
  const stub = recordingFetch(async (url) => { if (/afterCommit=tip/.test(String(url))) return json(500, { error: 'boom' }); throw new Error(`unexpected request ${url}`); });
  const { intake } = intakeWith({ srv: GRAPH, fetchSource: serves('https://example.test/never'), fetchImpl: stub, stateFile });
  await assert.rejects(intake.tick(), /500/);
  assert.ok(!fs.existsSync(stateFile), 'no state written on a failed probe');
  assert.ok(stub.urls.every((u) => !/afterSeq|tail=/.test(u)), `the document path was not tried: ${stub.urls.join(' | ')}`);
});
