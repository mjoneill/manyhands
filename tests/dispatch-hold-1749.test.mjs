/**
 * #1749 A8 — THE DISPATCH HOLD: the B-rows for the frozen A8 text on the card (the AUTHORITATIVE SCHEMA block binds; the A8 PINS,
 * the A8 DRAFT A8-1..A8-6 and the CORRECTIONS block amend it; A8-7 is withdrawn). Drafted for the B-row author's review; nothing
 * here builds A8. Against the current build every D row is meant to be RED at its own first contract assertion.
 *
 * HARNESS, COPIED (not imported) and adapted:
 *   - from tests/origin-lifecycle-1629-l.test.mjs: the whole-board world in mode off with an explicitly seeded allocator, holdAt()
 *     on a FIFO test barrier (after-document leaves a claim's obligation pending; after-executor-apply leaves its post written and
 *     nothing dispatched), the discriminator, publishOnce() running the REAL scripts/announce-publisher.mjs --once, the roster,
 *     the origin readers' claim records, and the entry -> postCreateIntention shape of its GD row.
 *   - from tests/recovery-hold-1749.test.mjs: holdOf/holdBlock, the reconcile-file shape, plantOffline, stateOffline, rg().
 *   Changes: the executor is REPLACEABLE (REST is always started against the current one), executors are spawned with their stderr
 *   kept for their whole life (so a serving start's log can be read), and the notify sink is a SEPARATE PROCESS that appends one
 *   line per request of any kind (P8-6). The fs recorder of the 1629 rows is not used: these rows do not assert document reads.
 *
 * THE WORLD (restore-after-dispatch): a claim's obligation is left pending at after-document; the store is stopped and COPIED
 * (the backup); the live store then really dispatches it (--once: one post, one notify request) and is lost; the backup is started
 * with --promote-epoch. Variants: `pending` (never dispatched, no post in the backup) and `post-written` (the backup is taken
 * after --once wrote the post and BEFORE it dispatched: post present, zero notify requests, ever).
 *
 *   D1   restore-after-dispatch: an AmbiguousObligation is written; the publisher and the after-write path make ZERO requests and
 *        no post; compiled post.create and obligation.settle refuse PRECONDITION_FAILED code DISPATCH_HELD
 *   D2   after a valid --reconcile-postseq: the obligation is STILL held (gate b): zero requests, no post, compiled DISPATCH_HELD
 *   D3   settle-published, post present and matching: published, zero requests ever; the DispositionRecord as given
 *   D3b  settle-published, post absent: POST_UNVERIFIED, store unchanged
 *   D4   retire-unsent-unknown: retired, never published, zero requests; notification "unknown" preserved
 *   D5   each binding field off by one value: WRONG_OBLIGATION, store unchanged (then the exact file is admitted: a control)
 *   D6   the same file again: ALREADY, unchanged; a different file for the disposed obligation: NOT_AMBIGUOUS
 *   D7   re-restore: the old file against a later promotion: WRONG_OBLIGATION; the later ambiguity is not cleared
 *   D8   a malformed AmbiguousObligation (planted OFFLINE): the start refuses HOLD_UNSOUND, unchanged (reverted: it starts)
 *   D9   /update deleting or rewriting an AmbiguousObligation or a DispositionRecord, with and without the protocol header:
 *        409 HOLD_PROTECTED, the recovery graph unchanged
 *   D10  BAD_FILE: delivered-evidenced without evidence; unknown WITH evidence; an unknown key; no currentStore
 *   C1   CONTROL: pending at the backup and NEVER dispatched is held as well
 *   C2   CONTROL: a promotion with NO allocator writes no AmbiguousObligation
 *   C3   CONTROL (green today): on the unpromoted live store --once DOES dispatch to the sink, and the "normal write" these rows
 *        use makes no request of its own (so the sink can see what D1/D2 assert absent)
 *
 * ASSUMED, one table (the contract names the subject and the field names, not their IRIs or representation):
 *   - every A8 record lives in <urn:ex:postseq/recovery>; a record's TYPE and FIELDS are matched by LOCAL NAME (the text after the
 *     last '/' or '#'): AmbiguousObligation {obligationIri, obligationId, mutationId, slot, payloadSha256, holdEpoch,
 *     holdIncarnation, state}; DispositionRecord {decision, notification, evidenceAuthenticated, postVerified, ...}; one triple per
 *     scalar field, its literal's lexical value as the value (evidenceAuthenticated reads "false").
 *   - "the obligation's stored payload" (P8-1) is the stored reservation's draft as the origin reader returns it.
 *   - the dispose start, like --reconcile-postseq, serves after success and REFUSES TO START with the code on stderr; a replay of
 *     the same file is ALREADY as a SERVING start that logs ALREADY, A2's form (ruled by the contract author).
 *   - a retired obligation's status triple reads "retired" (the origin reader admits only pending|published|blocked today, so it is
 *     read directly).
 *   - REST in mode off refuses to BOOT while the allocator reads RECOVERY_HOLD (today's G1(a) boot check). RULED by the contract
 *     author: that stays, fail closed until a human reconciles. D1 REQUIRES the refusal, by name; the REST paths are then driven
 *     after reconcile (D2, C1), where the AmbiguousObligation gate is what must hold.
 *
 * NOT COVERED, by name: the cutover candidate (A8-6, out of scope); the authenticity of notificationEvidence (recorded, not
 * authenticated, by contract); a crash inside the dispose transaction; the publisher's long-running loop (only --once).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, PY, EXEC, killExecutor } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { enumerateOriginRecords, readCommittedOrigin, readPreparedOrigin } from '../core/origin-commit.mjs';
import { announcePostId, opIdFor, postCreateIntention } from '../core/announce-outbox.mjs';
import { settleOpId } from '../core/graph-compiler.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 600000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHER = path.join(HERE, '..', 'scripts', 'announce-publisher.mjs');
const DSID = WB_DATASET;
const BK = 'urn:scrum:bookkeeping:executor';
const RG = 'urn:ex:postseq/recovery';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const HOLD = { subject: 'urn:ex:postseq/recovery-hold', type: 'urn:ex:postseq/RecoveryHold', epoch: 'urn:ex:postseq/epoch', incarnation: 'urn:ex:postseq/incarnation', restoredHighWater: 'urn:ex:postseq/restoredHighWater', restoredCommitSeq: 'urn:ex:postseq/restoredCommitSeq' };
const HELD = 'DISPATCH_HELD';
const APPROVER = 'https://scrumboard.local/person/approver';
const BOARD_PERSON = 'https://scrumboard.local/person/board';
const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const ROSTER = path.join(os.tmpdir(), `a8-1749-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch { /* best effort */ } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const canonicalJson = (v) => JSON.stringify(canon(v));   // P8-1: keys sorted recursively, arrays and scalars as stored, one stringify
const localName = (iri) => String(iri).replace(/^.*[/#]/, '');
const aoSubject = (obligationId) => `urn:ex:postseq/ambiguous/${sha256(obligationId)}`;
const postIri = (postId) => `https://scrumboard.local/entity/${postId}`;
/** the refusal's own words: the last lines of the start's stderr (the message repeats stderr, so its tail is not the reason) */
const why = (e) => String(e?.stderr || e?.message || '').trim().split('\n').slice(-2).join(' / ').slice(-300);
const offByOne = (v) => (/^\d+$/.test(String(v)) ? String(Number(v) + 1) : `${v}-other`);
const lastHexOff = (h) => h.slice(0, -1) + (h.at(-1) === '0' ? '1' : '0');   // still a well-formed lowercase hex value

/** #1671's startup contract (copied from tests/helpers/graph-executor-proc.mjs spawnExecutor), keeping stderr for the process's life. */
function spawnExec(args, { readyTimeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const fail = (e) => {
      if (done) return; done = true; clearTimeout(timer);
      if (p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return reject(e);
      p.once('exit', () => reject(e)); p.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(Object.assign(new Error(`executor printed no ready line within ${readyTimeoutMs} ms: ${err}`), { stderr: err })), readyTimeoutMs);
    p.stdout.on('data', (d) => {
      out += d;
      if (!done && out.includes('\n')) {
        let ready;
        try { ready = JSON.parse(out.split('\n')[0]); } catch (e) { return fail(e); }
        if (ready === null || typeof ready !== 'object' || !Number.isInteger(ready.port) || ready.port <= 0) return fail(new Error(`not a ready line: ${out.split('\n')[0].slice(0, 200)}`));
        done = true; clearTimeout(timer);
        resolve({ proc: p, ready, port: ready.port, baseUrl: `http://127.0.0.1:${ready.port}`, stderr: () => err });
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fail(e));
    p.on('exit', (code, sig) => { if (!done) { done = true; clearTimeout(timer); reject(Object.assign(new Error(`executor exited ${code ?? sig}: ${err}`), { code, stderr: err })); } });
  });
}

/** The notify sink: a SEPARATE PROCESS that appends one JSON line per request it receives, whatever its path or body (P8-6). */
const SINK_SRC = `const http=require('http'),fs=require('fs');const log=process.argv[1];const s=http.createServer((q,r)=>{let b='';q.on('data',d=>{b+=d});q.on('end',()=>{fs.appendFileSync(log,JSON.stringify({method:q.method,url:q.url,body:b})+'\\n');r.statusCode=200;r.setHeader('content-type','application/json');r.end('{}')})});s.listen(0,'127.0.0.1',()=>{process.stdout.write(s.address().port+'\\n')});`;
async function startSink(dir) {
  const log = path.join(dir, 'notify-requests.jsonl'); fs.writeFileSync(log, '');
  const p = spawn(process.execPath, ['-e', SINK_SRC, log], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let o = ''; p.stdout.on('data', (d) => { o += d; if (o.includes('\n')) resolve(Number(o.split('\n')[0])); });
    p.on('exit', (c) => reject(new Error(`the notify sink exited ${c}`)));
  });
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    url: `http://127.0.0.1:${port}/internal/notify`, calls,
    forPost: (id) => calls().filter((c) => { try { return JSON.parse(c.body)?.conversation?.id === id; } catch { return false; } }),
    stop: () => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once('exit', () => r()); p.kill('SIGKILL'); }),
  };
}

/** every quad of every graph of a STOPPED store, read offline and read-only (from the hold rows), canonical and sorted */
const stateOffline = (dir) => {
  const r = spawnSync(PY, ['-I', '-c', 'import sys, pyoxigraph as px\nfor q in sorted(str(x) for x in px.Store.read_only(sys.argv[1])): print(q)', dir], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `PRECONDITION: read offline (${r.stderr})`);
  return r.stdout;
};
/** write straight into a STOPPED store with pyoxigraph (from the hold rows): malformed state is planted offline, never by /update */
const plantOffline = (dir, sparql) => {
  const r = spawnSync(PY, ['-I', '-c', 'import sys, pyoxigraph as px; s = px.Store(sys.argv[1]); s.update(sys.argv[2]); s.flush()', dir, sparql], { encoding: 'utf8' });
  assert.equal(r.status, 0, `PRECONDITION: planted offline (${r.stderr})`);
};
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
let opN = 0;
const rows = async (x, sparql) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/a8q-${process.pid}-${opN++}` }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the executor answered a query (${r.status})`);
  return (await r.json()).results.bindings;
};
const askQ = async (x, sparql) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/a8a-${process.pid}-${opN++}` }, body: sparql });
  return (await r.json()).boolean;
};
const lineOf = (b) => [b.s, b.p, b.o].map((t) => `${t.type}:${t.value}:${t.datatype || ''}`).join(' ');
/** the recovery graph, read online, sorted (from the hold rows) */
const rg = async (x) => (await rows(x, `SELECT ?s ?p ?o WHERE { GRAPH <${RG}> { ?s ?p ?o } }`)).map(lineOf).sort();
async function holdOf(x) {
  const bs = await rows(x, `SELECT ?s ?p ?o WHERE { GRAPH <${RG}> { ?s a <${HOLD.type}> ; ?p ?o } }`);
  const get = (p) => bs.filter((b) => b.p.value === p).map((b) => b.o.value);
  return { subjects: [...new Set(bs.map((b) => b.s.value))], get };
}
const holdBlock = async (x) => {
  const h = await holdOf(x);
  return { datasetId: DSID, epoch: h.get(HOLD.epoch)[0], incarnation: h.get(HOLD.incarnation)[0], restoredCommitSeq: Number(h.get(HOLD.restoredCommitSeq)[0]), restoredHighWater: Number(h.get(HOLD.restoredHighWater)[0]) };
};
/** one record in the recovery graph by subject: its types and fields, matched by LOCAL NAME (the assumed-names table) */
async function recordAt(x, subject) {
  const bs = await rows(x, `SELECT ?p ?o WHERE { GRAPH <${RG}> { <${subject}> ?p ?o } }`);
  const fields = {};
  for (const b of bs) (fields[localName(b.p.value)] ??= []).push(b.o.value);
  return { exists: bs.length > 0, types: (fields.type || []).map(localName), get: (k) => fields[k] || [], fields };
}
/** every subject in the recovery graph whose type's local name is `typeName` */
const subjectsOfType = async (x, typeName) => (await rows(x, `SELECT DISTINCT ?s ?t WHERE { GRAPH <${RG}> { ?s a ?t } }`)).filter((b) => localName(b.t.value) === typeName).map((b) => b.s.value).sort();
/** the obligation's status, read directly (a retired one is not admitted by the origin reader today) */
const obligationStatus = async (x, obligationId) => (await rows(x, `SELECT ?st WHERE { GRAPH <${BK}> { ?s a ?t ; ?pid ?id ; ?pst ?st . FILTER(STRENDS(STR(?t), "/Obligation") || STRENDS(STR(?t), "#Obligation")) FILTER(STR(?id) = ${JSON.stringify(obligationId)} && (STRENDS(STR(?pid), "/obligationId") || STRENDS(STR(?pid), "#obligationId"))) FILTER(STRENDS(STR(?pst), "/status") || STRENDS(STR(?pst), "#status")) } }`)).map((b) => b.st.value);
/** every triple at the post's IRI, in every graph */
const postTriples = async (x, postId) => (await rows(x, `SELECT ?g ?p ?o WHERE { { <${postIri(postId)}> ?p ?o } UNION { GRAPH ?g { <${postIri(postId)}> ?p ?o } } }`)).map((b) => `${b.g?.value ?? ''} ${b.p.value} ${b.o.value}`).sort();

/** One whole-board world in mode off, its allocator seeded explicitly (copied from the 1629 L rows' world()), with a replaceable
 *  executor. Everything started here is stopped and every temp dir removed in `finally`. */
async function world(body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const own = { execs: new Set([w.exec]), dirs: new Set(), rests: [] };
  let cur = w.exec, rest = null, sink = null;
  const restoreBoardFile = () => { try { if (!fs.existsSync(w.boardFile)) fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ } };
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'a8-1749-')); own.dirs.add(scratch);
    const barrierDir = path.join(scratch, 'barriers'); fs.mkdirSync(barrierDir);
    sink = await startSink(scratch);
    const client = () => createGraphClient({ baseUrl: cur.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'a8-1749-rows' });
    // G1(c) (45075): ONE allocator, seeded by the fixture above every existing postSeq (the 1629 L world's seeding, verbatim in effect)
    const xu = async (sparql, label) => { const r = await fetch(`${cur.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/a8-${label}-${process.pid}-${opN++}` }, body: sparql }); assert.equal(r.status, 200, `PRECONDITION: ${label} (${await r.text()})`); };
    const seqs = (await rows(cur, `SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((b) => Number(b.n.value)).filter(Number.isSafeInteger);
    const epochName = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-a8-1749';
    await xu(`INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epochName)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }`, 'allocator-seeded');
    const liveHome = (await health(cur)).storeHome;
    assert.ok(typeof liveHome === 'string' && fs.existsSync(liveHome), `PRECONDITION: /health names the live store's home (${liveHome})`);

    const stopExec = async () => { await killExecutor(cur); };
    const startExec = async (dir, extra = []) => { const x = await spawnExec(['--store', dir, '--port', '0', '--dataset-id', DSID, ...extra]); own.execs.add(x); cur = x; return x; };
    /** a start that must REFUSE with `code` and leave the stopped store's every quad as it was */
    const refusedStart = async (dir, extra, code, what) => {
      const before = stateOffline(dir);
      let err = null;
      try { await startExec(dir, extra); } catch (e) { err = e; }
      if (!err) await stopExec();
      const text = String(err?.stderr ?? '') + String(err?.message ?? '');
      assert.ok(err && new RegExp(`\\b${code}\\b`).test(text), `${what}: the start refuses ${code} (${err ? `refused: ${why(err)}` : 'it SERVED'})`);
      assert.equal(stateOffline(dir), before, `${what}: every quad of the store is unchanged`);
    };
    const copyStore = (from, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fs.rmSync(d, { recursive: true }); fs.cpSync(from, d, { recursive: true }); own.dirs.add(d); return d; };
    const tmpFile = (name, content) => { const d = fs.mkdtempSync(path.join(scratch, 'f-')); const f = path.join(d, name); fs.writeFileSync(f, content); return f; };

    const startRest = async () => {
      restoreBoardFile();
      rest = await startRestServer({ boardFile: w.boardFile, mcpNotifyUrl: sink.url, env: { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: cur.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_TEST_BARRIER_DIR: barrierDir } });
      own.rests.push(rest);
      return rest;
    };
    const killRest = () => { rest?.kill('SIGKILL'); };
    const stopRest = async () => { await rest?.stop().catch(() => {}); restoreBoardFile(); fs.writeFileSync(w.boardFile, kept); };
    const call = async (method, route, payload) => {
      const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    /** the REAL publisher, one scan and one audit, against the current REST (from the 1629 L rows, without the fs recorder) */
    const publishOnce = () => new Promise((resolve) => {
      const dir = fs.mkdtempSync(path.join(scratch, 'pub-')); const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
      const ch = spawn(process.execPath, [PUBLISHER, '--board', rest.baseUrl, '--key-file', key, '--status', path.join(dir, 'st.json'), '--once'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; ch.stderr.on('data', (d) => { err += d; });
      ch.on('exit', (code) => resolve({ code, err }));
    });
    /** arm a FIFO barrier and wait until REST is held at it (from the 1629 L rows) */
    const holdAt = async (name, request) => {
      const fifo = path.join(barrierDir, name);
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0, `PRECONDITION: mkfifo ${name}`);
      let returned = false;
      const inflight = request().then((r) => { returned = true; return r; }, (e) => { returned = true; return { reset: String(e?.message || e) }; });
      let fh = null;
      const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), sleep(20000).then(() => false)]);
      if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
      const release = async () => { try { await fh?.close(); } catch { /* ignore */ } fs.rmSync(fifo, { force: true }); };
      return { reached, inflight, returned: () => returned, release };
    };
    /** every committed claim obligation, read from the executor (the 1629 L rows' originClaimRecords) */
    const claimRecords = async () => {
      const g = client();
      const e = await enumerateOriginRecords(g);
      assert.equal(e.ok, true, `PRECONDITION: the origin records are readable (${JSON.stringify(e).slice(0, 200)})`);
      const out = [];
      for (const mid of [...new Set(e.records.filter((r) => r.type === 'Origin' && r.mutationId).map((r) => r.mutationId))]) {
        const got = await readCommittedOrigin(g, mid);
        if (!got.ok || !got.committed) continue;
        for (const [i, ob] of got.committed.obligations.entries()) {
          if (ob.slot !== 'claim') continue;
          const res = got.committed.reservations[i];
          out.push({ mutationId: mid, slot: ob.slot, opId: opIdFor(mid, ob.slot), obligationId: ob.obligationId, postId: announcePostId(mid, ob.slot), postSeq: res?.postSeq, status: ob.status, payload: res?.draft, publicationAt: res?.createdAt });
        }
      }
      return out;
    };
    /** a claim killed at after-document: its obligation is durable and pending, nothing was posted or dispatched (the discriminator) */
    const pendingClaim = async (cardId) => {
      const before = new Set((await claimRecords()).map((x) => x.obligationId));
      const held = await holdAt('after-document', () => call('POST', `/api/cards/${cardId}/claim`, { by: 'ada' }));
      let snap;
      try {
        assert.equal(held.reached, true, `PRECONDITION: the claim of ${cardId} reached after-document`);
        assert.equal(held.returned(), false, 'PRECONDITION: blocked a different write (the claim had returned)');
        const fresh = (await claimRecords()).filter((x) => !before.has(x.obligationId));
        assert.equal(fresh.length, 1, `PRECONDITION: blocked a different write (${fresh.length} new claim records)`);
        snap = fresh[0];
        assert.equal(snap.status, 'pending', 'PRECONDITION: the obligation is pending');
      } finally { killRest(); await held.release(); await Promise.race([held.inflight, sleep(5000)]); }
      await sleep(300);
      await stopRest();
      return snap;
    };
    const s = { w, own, liveHome, sink, client, get cur() { return cur; }, startExec, stopExec, refusedStart, copyStore, tmpFile, startRest, killRest, stopRest, call, publishOnce, holdAt, claimRecords, pendingClaim, barrierDir };
    await body(s);
  } finally {
    for (const r of own.rests) await r.stop().catch(() => {});
    restoreBoardFile();
    for (const x of own.execs) await killExecutor(x);
    if (sink) await sink.stop();
    for (const d of own.dirs) fs.rmSync(d, { recursive: true, force: true });
    await w.stop();
  }
}

/** The restore. `at`: 'dispatched' (pending in the backup, then really dispatched on the live store), 'pending' (never dispatched),
 *  'post-written' (the backup is taken after --once wrote the post and before it dispatched). Leaves the PROMOTED backup serving. */
async function restore(s, at, { removeAllocator = false } = {}) {
  await s.startRest();
  const snap = await s.pendingClaim('uuid-1');
  if (at === 'post-written') {
    await s.startRest();
    const fifo = path.join(s.barrierDir, 'after-executor-apply');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'PRECONDITION: mkfifo after-executor-apply');
    const runP = s.publishOnce();
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), sleep(20000).then(() => false)]);
    s.killRest();
    try { await fh?.close(); } catch { /* ignore */ }
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    fs.rmSync(fifo, { force: true });
    await runP; await s.stopRest();
    assert.equal(reached, true, 'PRECONDITION: --once reached after-executor-apply (the post written, nothing dispatched)');
    assert.ok((await postTriples(s.cur, snap.postId)).length > 0, 'PRECONDITION: the reserved post exists in the store');
    assert.equal(s.sink.calls().length, 0, 'PRECONDITION: nothing was dispatched');
  }
  await s.stopExec();
  const backup = s.copyStore(s.liveHome, 'a8-1749-backup-');
  if (removeAllocator) plantOffline(backup, `DELETE WHERE { GRAPH <${BK}> { <urn:ex:postseq/allocator> ?p ?o } }`);
  let dispatched = 0;
  if (at === 'dispatched') {
    await s.startExec(s.liveHome);
    await s.startRest();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `PRECONDITION: the live --once completed (${run.code}) ${run.err.slice(0, 200)}`);
    assert.ok(await until(async () => s.sink.forPost(snap.postId).length >= 1, 20000), `PRECONDITION: the live store DISPATCHED it (${s.sink.calls().length} requests)`);
    assert.ok((await postTriples(s.cur, snap.postId)).length > 0, 'PRECONDITION: the live store holds the post');
    await sleep(1000);
    dispatched = s.sink.calls().length;
    await s.stopRest();
    await s.stopExec();   // the live store is lost
  }
  const x = await s.startExec(backup, ['--promote-epoch']);
  const hh = await health(x);
  const hold = await holdOf(x);
  if (!removeAllocator) assert.equal(hold.subjects.length, 1, 'PRECONDITION: the promotion wrote its RecoveryHold');
  return { snap, backup, dispatched, hold: { epoch: hold.get(HOLD.epoch)[0], incarnation: hold.get(HOLD.incarnation)[0] }, store: { epoch: String(hh.epoch), incarnation: String(hh.incarnation) }, payloadSha256: sha256(canonicalJson(snap.payload)) };
}

/** a --dispose-obligation file per the AUTHORITATIVE SCHEMA, bound to this restore; `over` replaces keys (undefined deletes one) */
function disposeFile(s, r, over = {}) {
  const f = {
    obligationId: r.snap.obligationId, mutationId: r.snap.mutationId, slot: r.snap.slot, payloadSha256: r.payloadSha256,
    lineage: { holdEpoch: r.hold.epoch, holdIncarnation: r.hold.incarnation },
    currentStore: { datasetId: DSID, epoch: r.store.epoch, incarnation: r.store.incarnation },
    decision: 'retire-unsent-unknown', notification: 'unknown',
    approvedBy: APPROVER, approvalRef: 'decision:00000000-0000-4000-8000-0000000017b8', note: 'a #1749 A8 row disposition',
  };
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete f[k]; else f[k] = v; }
  return s.tmpFile('dispose.json', JSON.stringify(f));
}
const EVIDENCE = [{ kind: 'operator-statement', location: 'test://a8-1749/row', sha256: '0'.repeat(64), observedAt: '2026-10-25T15:00:00.000Z' }];
const reconcileFile = (s, hb, gap = 10) => s.tmpFile('reconcile.json', JSON.stringify({ nextPostSeq: hb.restoredHighWater + gap + 1, declaredGap: gap, approvedBy: APPROVER, approvalRef: 'decision:00000000-0000-4000-8000-0000000017a9', evidence: [], hold: hb }));
/** the reconcile maintenance start (the hold rows' file shape); serves with the hold cleared */
async function reconcile(s, dir) {
  const hb = await holdBlock(s.cur);
  await s.stopExec();
  const x = await s.startExec(dir, ['--reconcile-postseq', reconcileFile(s, hb)]);
  assert.deepEqual((await holdOf(x)).subjects, [], 'PRECONDITION: the valid reconcile cleared the RecoveryHold');
  return x;
}
/** the two compiled dispatch intentions for this obligation, as the server builds them (the 1629 GD row's entry shape) */
async function compiledDispatch(s, snap) {
  const entry = { mutationId: snap.mutationId, slot: snap.slot, postSeq: snap.postSeq, publicationAt: snap.publicationAt, payload: snap.payload };
  const P = await readPreparedOrigin(s.client(), snap.mutationId);
  assert.ok(P.ok && P.prepared, `PRECONDITION: the Prepared origin reads (${JSON.stringify(P).slice(0, 160)})`);
  const p = snap.payload;
  const settle = { kind: 'obligation.settle', opId: settleOpId(snap.obligationId, 'publish'), actor: BOARD_PERSON, obligationId: snap.obligationId, transition: 'publish',
    publication: { payload: { author: p.author, body: p.body, originActor: p.originActor, occurredAt: p.occurredAt, mentions: p.mentions, notify: p.notify }, postSeq: snap.postSeq, publicationAt: snap.publicationAt },
    origin: { descriptor: JSON.parse(P.prepared.descriptorJson), plan: JSON.parse(P.prepared.planJson), occurredAt: P.prepared.occurredAt } };
  return { post: postCreateIntention(entry), settle };
}
const dispatchHeld = (r) => r.outcome === 'PRECONDITION_FAILED' && (r.code === HELD || r.reason === HELD);
async function assertCompiledHeld(s, snap, label) {
  const { post, settle } = await compiledDispatch(s, snap);
  const a = await durableUpdate(s.client(), post);
  assert.ok(dispatchHeld(a), `${label}: a direct compiled post.create refuses PRECONDITION_FAILED code ${HELD} (${JSON.stringify(a).slice(0, 240)})`);
  const b = await durableUpdate(s.client(), settle);
  assert.ok(dispatchHeld(b), `${label}: a direct compiled obligation.settle refuses PRECONDITION_FAILED code ${HELD} (${JSON.stringify(b).slice(0, 240)})`);
  assert.deepEqual(await postTriples(s.cur, snap.postId), [], `${label}: and no announcement post exists`);
}
/** the AmbiguousObligation for this obligation, bound as A8-1 says */
async function assertAmbiguousHeld(s, r, label, { lineage = r.hold } = {}) {
  const ao = await recordAt(s.cur, aoSubject(r.snap.obligationId));
  assert.ok(ao.exists && ao.types.includes('AmbiguousObligation'), `${label}: an AmbiguousObligation exists at ${aoSubject(r.snap.obligationId)} in <${RG}> (${JSON.stringify(ao.fields).slice(0, 240)})`);
  assert.deepEqual(ao.get('state'), ['held'], `${label}: its state is "held"`);
  assert.deepEqual([ao.get('obligationId'), ao.get('mutationId'), ao.get('slot')], [[r.snap.obligationId], [r.snap.mutationId], [r.snap.slot]], `${label}: it names the obligation`);
  assert.deepEqual(ao.get('payloadSha256'), [r.payloadSha256], `${label}: bound to the canonical payload's sha256`);
  assert.deepEqual([ao.get('holdEpoch'), ao.get('holdIncarnation')], [[lineage.epoch], [lineage.incarnation]], `${label}: bound to the hold's lineage`);
}
/** a card PATCH: a normal write that makes no notify request of its own (C3 measures that) */
async function normalWrite(s, label) {
  const c = (await s.call('GET', '/api/cards/uuid-2')).json;
  const r = await s.call('PATCH', '/api/cards/uuid-2', { title: `card 2, ${label}`, ifVersion: c?.version, by: 'ada' });
  assert.equal(r.status, 200, `PRECONDITION: ${label}: the normal write applied (${r.status} ${r.text.slice(0, 200)})`);
}

// ───────────────────────────── CONTROLS ─────────────────────────────

test('#1749 A8 (C3) CONTROL: on the unpromoted live store --once DOES dispatch a pending obligation to the sink; the normal write makes no request of its own', T, async () => {
  await world(async (s) => {
    await s.startRest();
    const snap = await s.pendingClaim('uuid-1');
    assert.equal(s.sink.calls().length, 0, 'C3: nothing dispatched while the claim was held');
    await s.startRest();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `C3: --once completed (${run.code}) ${run.err.slice(0, 200)}`);
    assert.ok(await until(async () => s.sink.forPost(snap.postId).length >= 1, 20000), `C3: the sink received the dispatch for ${snap.postId} (${s.sink.calls().length} requests)`);
    assert.ok((await postTriples(s.cur, snap.postId)).length > 0, 'C3: and the post exists');
    await sleep(1500);
    const n = s.sink.calls().length;
    await normalWrite(s, 'C3');
    await sleep(3000);
    assert.equal(s.sink.calls().length, n, 'C3: the normal write made no notify request of its own');
  });
});

test('#1749 A8 (C2) CONTROL: a promotion of a store with NO allocator writes no AmbiguousObligation (and no RecoveryHold)', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending', { removeAllocator: true });
    assert.equal((await readCommittedOrigin(s.client(), r.snap.mutationId)).committed?.obligations?.[0]?.status, 'pending', 'C2 PRECONDITION: the obligation is pending in the promoted store');
    console.log(`# C2 promoted ${r.backup} obligation ${r.snap.obligationId} epoch ${r.store.epoch}`);
    assert.deepEqual((await holdOf(s.cur)).subjects, [], 'C2: no RecoveryHold (H3)');
    assert.deepEqual(await subjectsOfType(s.cur, 'AmbiguousObligation'), [], 'C2: no AmbiguousObligation');
    assert.equal((await recordAt(s.cur, aoSubject(r.snap.obligationId))).exists, false, 'C2: nothing at the obligation\'s ambiguous subject');
  });
});

test('#1749 A8 (C1) CONTROL: an obligation pending at the backup and NEVER dispatched is held as well: zero requests, compiled DISPATCH_HELD, still held after reconcile', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    await assertAmbiguousHeld(s, r, 'C1');
    await assertCompiledHeld(s, r.snap, 'C1 under the RecoveryHold');
    await reconcile(s, r.backup);
    await s.startRest();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `C1: --once completed (${run.code})`);
    await sleep(3000);
    assert.equal(s.sink.calls().length, 0, `C1: ZERO notify requests (${JSON.stringify(s.sink.calls()).slice(0, 200)})`);
    assert.deepEqual(await postTriples(s.cur, r.snap.postId), [], 'C1: no announcement post');
  });
});

// ───────────────────────────── D ROWS ─────────────────────────────

test('#1749 A8 (D1) restore-after-dispatch: an AmbiguousObligation is written; the publisher and the after-write path make ZERO requests; compiled dispatch → DISPATCH_HELD', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'dispatched');
    await assertAmbiguousHeld(s, r, 'D1');
    const base = s.sink.calls().length;
    let booted = true;
    try { await s.startRest(); } catch (e) {
      booted = false;
      assert.match(String(e?.message), /RECOVERY_HOLD/, `D1: a REST that does not boot on the held store refuses BY NAME (${String(e?.message).slice(-300)})`);
      console.log('# D1: REST refused to boot on the held store (allocator RECOVERY_HOLD); the REST legs are driven after reconcile in D2');
    }
    // contract author's ruling: REST does NOT boot while a RecoveryHold exists (fail closed until a human reconciles), so no REST
    // dispatch path is open during the hold; the publisher and after-write legs are driven after reconcile (D2, C1)
    assert.equal(booted, false, 'D1: REST refuses to boot while the RecoveryHold exists');
    if (booted) {
      const run = await s.publishOnce();
      assert.equal(run.code, 0, `D1: --once completed (${run.code}) ${run.err.slice(0, 200)}`);
      await sleep(3000);
      assert.equal(s.sink.calls().length, base, `D1: the publisher made ZERO notify requests (${s.sink.calls().length - base})`);
      await s.stopRest();
      await s.startRest();   // a FRESH boot, then a normal write: the after-write path
      await normalWrite(s, 'D1');
      await sleep(3000);
      assert.equal(s.sink.calls().length, base, `D1: the after-write path made ZERO notify requests (${s.sink.calls().length - base})`);
      await s.stopRest();
    }
    assert.deepEqual(await postTriples(s.cur, r.snap.postId), [], 'D1: no announcement post exists in the restored store');
    await assertCompiledHeld(s, r.snap, 'D1');
    assert.equal(s.sink.calls().length, base, 'D1: ZERO notify requests since the promotion');
  });
});

test('#1749 A8 (D2) after a valid --reconcile-postseq the obligation is STILL held: zero requests, no post, compiled DISPATCH_HELD', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'dispatched');
    await reconcile(s, r.backup);
    await assertAmbiguousHeld(s, r, 'D2 after reconcile');
    const base = s.sink.calls().length;
    await s.startRest();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `D2: --once completed (${run.code}) ${run.err.slice(0, 200)}`);
    await sleep(3000);
    assert.equal(s.sink.calls().length, base, `D2: the publisher made ZERO notify requests (${s.sink.calls().length - base})`);
    await s.stopRest();
    await s.startRest();
    await normalWrite(s, 'D2');
    await sleep(3000);
    assert.equal(s.sink.calls().length, base, `D2: the after-write path made ZERO notify requests (${s.sink.calls().length - base})`);
    await s.stopRest();
    assert.deepEqual(await postTriples(s.cur, r.snap.postId), [], 'D2: no announcement post exists');
    await assertCompiledHeld(s, r.snap, 'D2 (gate b alone: the RecoveryHold is gone)');
    assert.equal((await recordAt(s.cur, aoSubject(r.snap.obligationId))).get('state')[0], 'held', 'D2: still held at the end');
  });
});

test('#1749 A8 (D3) settle-published with the post present and matching: published, zero notify requests ever; the DispositionRecord as given, evidenceAuthenticated false', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'post-written');
    const post0 = await postTriples(s.cur, r.snap.postId);
    const hb = await holdBlock(s.cur);
    await s.stopExec();
    const file = disposeFile(s, r, { decision: 'settle-published', notification: 'not-delivered-evidenced', notificationEvidence: EVIDENCE });
    let x = null, err = null;
    try { x = await s.startExec(r.backup, ['--dispose-obligation', file]); } catch (e) { err = e; }
    assert.ok(x, `D3: the dispose start succeeds and serves (${why(err)})`);
    assert.equal((await readCommittedOrigin(s.client(), r.snap.mutationId)).committed?.obligations?.[0]?.status, 'published', 'D3: the obligation reads published');
    assert.deepEqual((await recordAt(x, aoSubject(r.snap.obligationId))).get('state'), ['disposed'], 'D3: the AmbiguousObligation is disposed');
    const drs = await subjectsOfType(x, 'DispositionRecord');
    assert.equal(drs.length, 1, `D3: exactly one DispositionRecord (${JSON.stringify(drs)})`);
    const dr = await recordAt(x, drs[0]);
    assert.deepEqual(dr.get('decision'), ['settle-published'], 'D3: the record names the decision');
    assert.deepEqual(dr.get('notification'), ['not-delivered-evidenced'], 'D3: notification exactly as given');
    assert.deepEqual(dr.get('evidenceAuthenticated'), ['false'], 'D3: evidenceAuthenticated false');
    assert.deepEqual(dr.get('postVerified'), ['true'], 'D3: postVerified true (the executor checked the post)');
    assert.deepEqual(await postTriples(x, r.snap.postId), post0, 'D3: the post is untouched');
    // and nothing re-dispatches it afterwards
    const h = await holdOf(x);
    assert.equal(h.subjects.length, 1, 'PRECONDITION: the RecoveryHold is still there (disposition does not reconcile)');
    await s.stopExec();
    x = await s.startExec(r.backup, ['--reconcile-postseq', reconcileFile(s, hb)]);
    await s.startRest();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `D3: --once completed (${run.code})`);
    await sleep(3000);
    assert.equal(s.sink.calls().length, 0, `D3: ZERO notify requests, ever (${JSON.stringify(s.sink.calls()).slice(0, 200)})`);
    assert.deepEqual(await postTriples(s.cur, r.snap.postId), post0, 'D3: still exactly the one post');
  });
});

test('#1749 A8 (D3b) settle-published when the post was lost with the store → POST_UNVERIFIED; the store unchanged', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'dispatched');
    await s.stopExec();
    await s.refusedStart(r.backup, ['--dispose-obligation', disposeFile(s, r, { decision: 'settle-published', notification: 'delivered-evidenced', notificationEvidence: EVIDENCE })], 'POST_UNVERIFIED', 'D3b settle-published, post absent');
  });
});

test('#1749 A8 (D4) retire-unsent-unknown: retired, never published, zero requests; notification "unknown" preserved', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'dispatched');
    const base = s.sink.calls().length;
    const hb = await holdBlock(s.cur);
    await s.stopExec();
    let x = null, err = null;
    try { x = await s.startExec(r.backup, ['--dispose-obligation', disposeFile(s, r)]); } catch (e) { err = e; }
    assert.ok(x, `D4: the dispose start succeeds and serves (${why(err)})`);
    assert.deepEqual(await obligationStatus(x, r.snap.obligationId), ['retired'], 'D4: the obligation reads retired');
    assert.deepEqual((await recordAt(x, aoSubject(r.snap.obligationId))).get('state'), ['disposed'], 'D4: the AmbiguousObligation is disposed');
    const drs = await subjectsOfType(x, 'DispositionRecord');
    assert.equal(drs.length, 1, 'D4: exactly one DispositionRecord');
    const dr = await recordAt(x, drs[0]);
    assert.deepEqual(dr.get('decision'), ['retire-unsent-unknown'], 'D4: the decision');
    assert.deepEqual(dr.get('notification'), ['unknown'], 'D4: "unknown" is preserved verbatim');
    assert.deepEqual(dr.get('evidenceAuthenticated'), ['false'], 'D4: evidenceAuthenticated false');
    await s.stopExec();
    await s.startExec(r.backup, ['--reconcile-postseq', reconcileFile(s, hb)]);
    await s.startRest();
    const run = await s.publishOnce();
    assert.equal(run.code, 0, `D4: --once completed (${run.code})`);
    await sleep(3000);
    assert.equal(s.sink.calls().length, base, `D4: ZERO notify requests since the promotion (${s.sink.calls().length - base})`);
    assert.deepEqual(await postTriples(s.cur, r.snap.postId), [], 'D4: never published: no post');
    assert.deepEqual(await obligationStatus(s.cur, r.snap.obligationId), ['retired'], 'D4: still retired');
  });
});

test('#1749 A8 (D5) every binding field off by one value → WRONG_OBLIGATION, the store unchanged; the exact file is then admitted (control)', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    await s.stopExec();
    const lin = { holdEpoch: r.hold.epoch, holdIncarnation: r.hold.incarnation };
    const cs = { datasetId: DSID, epoch: r.store.epoch, incarnation: r.store.incarnation };
    const mid = r.snap.mutationId;
    // the identity fields move TOGETHER (obligationId is "<mutationId>:<slot>"), so each names another, consistent obligation;
    // a file that is internally inconsistent is a schema error (BAD_FILE), pinned separately below (contract author's ruling)
    const slot = r.snap.slot;
    const variants = [
      ['mutationId (with obligationId)', { mutationId: lastHexOff(mid), obligationId: `${lastHexOff(mid)}:${slot}` }],
      ['slot (with obligationId)', { slot: 'claimx', obligationId: `${mid}:claimx` }],
      ['payloadSha256', { payloadSha256: lastHexOff(r.payloadSha256) }],
      ['lineage.holdEpoch', { lineage: { ...lin, holdEpoch: offByOne(lin.holdEpoch) } }],
      ['lineage.holdIncarnation', { lineage: { ...lin, holdIncarnation: offByOne(lin.holdIncarnation) } }],
      ['currentStore.datasetId', { currentStore: { ...cs, datasetId: offByOne(cs.datasetId) } }],
      ['currentStore.epoch', { currentStore: { ...cs, epoch: offByOne(cs.epoch) } }],
      ['currentStore.incarnation', { currentStore: { ...cs, incarnation: offByOne(cs.incarnation) } }],
    ];
    for (const [what, over] of variants) await s.refusedStart(r.backup, ['--dispose-obligation', disposeFile(s, r, over)], 'WRONG_OBLIGATION', `D5 ${what} off by one`);
    await s.refusedStart(r.backup, ['--dispose-obligation', disposeFile(s, r, { obligationId: `${mid}:claimx` })], 'BAD_FILE', 'D5 an obligationId that is not its own mutationId:slot');
    const x = await s.startExec(r.backup, ['--dispose-obligation', disposeFile(s, r)]);
    assert.deepEqual(await obligationStatus(x, r.snap.obligationId), ['retired'], 'D5 CONTROL: the exact file is admitted');
  });
});

test('#1749 A8 (D6) the same file again → ALREADY, unchanged; a different file for the disposed obligation → NOT_AMBIGUOUS', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    await s.stopExec();
    const file = disposeFile(s, r);
    let x = null, err = null;
    try { x = await s.startExec(r.backup, ['--dispose-obligation', file]); } catch (e) { err = e; }
    assert.ok(x, `D6: the first disposition serves (${why(err)})`);
    await s.stopExec();
    const s0 = stateOffline(r.backup);
    await s.startExec(r.backup); await s.stopExec();
    assert.equal(stateOffline(r.backup), s0, 'D6 CONTROL: a plain start and stop changes no quad (so the comparison below is fair)');
    let again = null; err = null;
    try { again = await s.startExec(r.backup, ['--dispose-obligation', file]); } catch (e) { err = e; }
    if (again) await sleep(500);
    const text = again ? again.stderr() : String(err?.stderr ?? err?.message);
    if (again) await s.stopExec();
    // ALREADY has A2's form (contract author's ruling): a SERVING start that logs ALREADY, never a refusal
    assert.ok(again, `D6: the replay is a serving start (${text.slice(-300)})`);
    assert.match(text, /\bALREADY\b/, `D6: the replay logs ALREADY (${text.slice(-300)})`);
    assert.equal(stateOffline(r.backup), s0, 'D6: the replay changed no quad');
    await s.refusedStart(r.backup, ['--dispose-obligation', disposeFile(s, r, { note: 'a second, different disposition' })], 'NOT_AMBIGUOUS', 'D6 a different file');
  });
});

test('#1749 A8 (D7) re-restore: the old disposition file against a later promotion → WRONG_OBLIGATION; the later ambiguity is not cleared', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    await s.stopExec();
    const old = disposeFile(s, r);
    let x = null, err = null;
    try { x = await s.startExec(r.backup, ['--dispose-obligation', old]); } catch (e) { err = e; }
    assert.ok(x, `D7: the disposition on the first restore serves (${why(err)})`);
    const ao1 = await recordAt(x, aoSubject(r.snap.obligationId));
    await reconcile(s, r.backup);
    await s.startRest();
    const snap2 = await s.pendingClaim('uuid-2');   // a NEW obligation, pending at the next backup
    await s.stopExec();
    const second = s.copyStore(r.backup, 'a8-1749-backup2-');
    x = await s.startExec(second, ['--promote-epoch']);
    const hold2 = await holdOf(x), hh2 = await health(x);
    const r2 = { snap: snap2, hold: { epoch: hold2.get(HOLD.epoch)[0], incarnation: hold2.get(HOLD.incarnation)[0] }, payloadSha256: sha256(canonicalJson(snap2.payload)) };
    await assertAmbiguousHeld(s, r2, 'D7 the later promotion');
    assert.deepEqual((await recordAt(x, aoSubject(r.snap.obligationId))).fields, ao1.fields, 'D7: the earlier AmbiguousObligation is byte-unchanged by the re-promotion');
    assert.notEqual(String(hh2.incarnation), r.store.incarnation, 'PRECONDITION: the later promotion is a different store identity');
    await s.stopExec();
    await s.refusedStart(second, ['--dispose-obligation', old], 'WRONG_OBLIGATION', 'D7 the old file');
    x = await s.startExec(second);
    assert.deepEqual((await recordAt(x, aoSubject(snap2.obligationId))).get('state'), ['held'], 'D7: the later ambiguity is still held');
  });
});

test('#1749 A8 (D8) a malformed AmbiguousObligation planted OFFLINE (no payloadSha256; no lineage; an unknown state) → the start refuses HOLD_UNSOUND, unchanged', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    const S = aoSubject(r.snap.obligationId);
    const bs = await rows(s.cur, `SELECT ?p ?o WHERE { GRAPH <${RG}> { <${S}> ?p ?o } }`);
    assert.ok(bs.some((b) => localName(b.p.value) === 'state'), `D8 PRECONDITION: the promotion wrote an AmbiguousObligation to malform (${bs.length} triples at ${S})`);
    await s.stopExec();
    const term = (o) => (o.type === 'uri' ? `<${o.value}>` : o.datatype && o.datatype !== `${XSD}string` ? `${JSON.stringify(o.value)}^^<${o.datatype}>` : JSON.stringify(o.value));
    const triple = (b) => `<${S}> <${b.p.value}> ${term(b.o)} .`;
    const pick = (...names) => bs.filter((b) => names.includes(localName(b.p.value)));
    const pristine = stateOffline(r.backup);
    for (const [what, del, add] of [
      ['no payloadSha256', pick('payloadSha256'), []],
      ['no lineage (holdEpoch, holdIncarnation)', pick('holdEpoch', 'holdIncarnation'), []],
      ['an unknown state', pick('state'), pick('state').map((b) => ({ ...b, o: { ...b.o, value: 'bogus' } }))],
    ]) {
      assert.ok(del.length > 0, `PRECONDITION: D8 ${what}: there is a field to malform`);
      plantOffline(r.backup, `DELETE DATA { GRAPH <${RG}> { ${del.map(triple).join(' ')} } }${add.length ? ` ; INSERT DATA { GRAPH <${RG}> { ${add.map(triple).join(' ')} } }` : ''}`);
      await s.refusedStart(r.backup, [], 'HOLD_UNSOUND', `D8 ${what}`);
      plantOffline(r.backup, `${add.length ? `DELETE DATA { GRAPH <${RG}> { ${add.map(triple).join(' ')} } } ; ` : ''}INSERT DATA { GRAPH <${RG}> { ${del.map(triple).join(' ')} } }`);
      assert.equal(stateOffline(r.backup), pristine, `PRECONDITION: D8 ${what}: the plant was reverted exactly`);
    }
    await s.startExec(r.backup);   // CONTROL: the well-formed record starts, so each refusal was for its malformation
  });
});

test('#1749 A8 (D9) an /update deleting or rewriting an AmbiguousObligation or a DispositionRecord, with and without the protocol header → 409 HOLD_PROTECTED; the recovery graph unchanged', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    await s.stopExec();
    let x = null, err = null;
    try { x = await s.startExec(r.backup, ['--dispose-obligation', disposeFile(s, r)]); } catch (e) { err = e; }
    assert.ok(x, `D9: the disposition serves (${why(err)})`);
    const S = aoSubject(r.snap.obligationId);
    const drs = await subjectsOfType(x, 'DispositionRecord');
    assert.equal(drs.length, 1, 'PRECONDITION: D9: one DispositionRecord to tamper with');
    const g0 = await rg(x);
    const epoch = String((await health(x)).epoch);
    for (const [what, body] of [
      ['delete the AmbiguousObligation', `DELETE WHERE { GRAPH <${RG}> { <${S}> ?p ?o } }`],
      ['rewrite its state', `DELETE { GRAPH <${RG}> { <${S}> ?p ?v } } INSERT { GRAPH <${RG}> { <${S}> ?p "held" } } WHERE { GRAPH <${RG}> { <${S}> ?p ?v FILTER(STRENDS(STR(?p), "state")) } }`],
      ['delete the DispositionRecord', `DELETE WHERE { GRAPH <${RG}> { <${drs[0]}> ?p ?o } }`],
      ['rewrite its notification', `DELETE { GRAPH <${RG}> { <${drs[0]}> ?p ?v } } INSERT { GRAPH <${RG}> { <${drs[0]}> ?p "delivered-evidenced" } } WHERE { GRAPH <${RG}> { <${drs[0]}> ?p ?v FILTER(STRENDS(STR(?p), "notification")) } }`],
    ]) {
      for (const header of [{ 'x-manyhands-write-protocol': 'postseq-v1' }, {}]) {
        const res = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/a8-tamper-${process.pid}-${opN++}`, 'x-epoch': epoch, ...header }, body });
        const t = await res.text();
        const how = Object.keys(header).length ? 'WITH' : 'without';
        assert.equal(res.status, 409, `D9 ${what} (${how} the header): 409 (${res.status} ${t.slice(0, 160)})`);
        assert.match(t, /HOLD_PROTECTED/, `D9 ${what} (${how} the header): named HOLD_PROTECTED`);
        assert.deepEqual(await rg(x), g0, `D9 ${what} (${how} the header): the recovery graph is unchanged`);
      }
    }
  });
});

test('#1749 A8 (D10) BAD_FILE: delivered-evidenced without evidence; unknown WITH evidence; an unknown key; no currentStore → BAD_FILE, unchanged', T, async () => {
  await world(async (s) => {
    const r = await restore(s, 'pending');
    await s.stopExec();
    for (const [what, over] of [
      ['notification delivered-evidenced with no evidence', { notification: 'delivered-evidenced' }],
      ['notification unknown WITH evidence', { notification: 'unknown', notificationEvidence: EVIDENCE }],
      ['an unknown key', { approvedByy: APPROVER }],
      ['no currentStore', { currentStore: undefined }],
    ]) await s.refusedStart(r.backup, ['--dispose-obligation', disposeFile(s, r, over)], 'BAD_FILE', `D10 ${what}`);
  });
});
