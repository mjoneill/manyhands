/**
 * #1762 S2 — a REFUSAL is a content-free graph record, not an event-log row. The test author's independent RED rows, written
 * BLACK-BOX against the "#1762 S2 CONTRACT" (the builder's message of 2026-10-27 00:01Z) before any S2 code exists. The builder
 * does not write these rows; the row author does not build S2. They stack on S1b (PR #134).
 *
 * THE WORLD: as the S1b rows: the whole-board fixture in a real executor, REST under all six units and the four executor
 * sources, the board document off, the allocator seeded, the reference index backfilled, SCRUM_AUTH required, TWO seats with
 * tokens (ada, bob), and a test-owned event-log directory (SCRUM_EVENT_LOG_DIR) so "nothing was written to the event log" is
 * a comparison of bytes. The flag is SCRUM_HISTORY_NATIVE=1.
 *
 * THE CONTRACT (one table, so a rename is one edit): with the flag on, both refusal paths (the server's response chokepoint
 * `logRefused` and the adapter's POST /api/refusals) write ONE scrum:RefusalRecord to the graph and NOTHING to the event log.
 * Allowlisted predicates only, no free text anywhere: scrum:route (the TEMPLATE), scrum:status (xsd:integer), scrum:code (from
 * the registry, else scrum:unlisted), scrum:rule (adapter only, from the registry, else scrum:unlisted), scrum:entityKind,
 * scrum:entityId (only a short-safe id), scrum:requestId (only the id pattern), prov:wasAssociatedWith (the authenticated seat,
 * else a declared actor on the roster, else scrum:unknown), prov:startedAtTime. Never a ChangeActivity. Flag off: the event log
 * row as today and no graph record. Graph unavailable: the refusal response unchanged, refusalAuditUnavailable on /api/health,
 * never an event-log append.
 *
 * ROWS:
 *   F0  CONTROL, flag unset: a refused claim (409) writes ONE refused row to the event log, as today, and NO graph record
 *   R1  a refused claim (409), flag on: ONE record, every field, the template route, the authenticated seat, a time inside the
 *       call; typed RefusalRecord and NOT a ChangeActivity; no predicate outside the allowlist; the event log's bytes unchanged
 *   R2  a refused conversation POST whose body, attachedTo and reason carry a unique marker: the marker is in NO literal,
 *       subject or predicate anywhere in the graph, and the event log is unchanged
 *   R3  an ADAPTER report (POST /api/refusals) with the marker in its rule, reason, entity id, route, request and actor: ONE
 *       record, the marker nowhere, the rule stored as scrum:unlisted, the event log unchanged
 *   R4  the same requestId refused twice: ONE record
 *   R5  a requestId outside the pattern is not stored, and its text is nowhere; the refusal is still recorded
 *   R6  the authenticated seat wins over a declared actor (bob's token, body naming ada: the record is bob's); an
 *       unauthenticated refusal whose declared actor is not on the roster records scrum:unknown and the text is nowhere

 *   R6c the declared actor with no credential bound (auth not required): a roster seat is recorded as itself, a stranger as
 *       scrum:unknown, and the stranger's name is nowhere
 *   R7  a path segment that is free text (a space in it): the stored route is the template, no entityId, the marker nowhere
 *   R8  the executor down: five refusals answer exactly as one did before it went down, /api/health counts each failed audit and
 *       says since when, stderr gets exactly one audit line for the burst, and the event log's bytes do not move
 *   R9  a path segment far outside a safe id (300 characters): no scrum:entityId, the marker nowhere
 *   R10 a registered code is stored verbatim; a response that names no code is stored as unlisted
 *   R11 an adapter label that names no tool is stored as unmatched (the review found adapter routes are not closed-listed)
 *   R12 the same requestId from a different actor, or on a different route template, is a DISTINCT record
 *   R13 the same actor, template and requestId refused again with CHANGED facts: the business refusal is unchanged, the first record
 *       stands, and the audit conflict is visible (confirmed by the reviewer: /api/health's refusalAuditUnavailable.count rises by one)
 *   D1  (pure, no executor) the compiler, called directly, refuses a code, rule or adapter label that is not registered
 *   R14 forty concurrent refusals: every one answers as before, and each is recorded or COUNTED (none vanishes)
 *   R14b with the executor STALLED, a server refusal still answers promptly (the audit is not on the response path)
 *   R15 entityId at the boundary: 64 characters stored, 65 or a dot absent
 *   R16 free text in the path of a route no router entry matches: nowhere; a record, if made, is scrum:unlisted
 *   R17 the record names its audit op with scrum:recordedBy (v2.2 section 8); the compiler's bookkeeping predicate is urn:ex:recordedBy
 *
 * CONTRACT v2.2 (commons/card #1762, 2026-10-27 00:45Z) is the reference: unknown code, rule, label or unmatched route is the IRI
 * scrum:unlisted; a missing code is ABSENT; scrum:refusedAction and scrum:recordedBy (bookkeeping graph, its own APPLIED receipt) are in
 * the closed predicate set; the audit op id is urn:ex:op/refused/<sha256(actor, template, requestId)[:32]>.
 *
 * RETAINED-DATA EXCEPTIONS, stated plainly: "no free text" is true of messages, bodies, mentions and attachments. Two BOUNDED
 * identifiers are kept by design and can carry text a client chose: scrum:requestId (8-64 of [A-Za-z0-9-]) and scrum:entityId (1-64
 * of [A-Za-z0-9_-]). An adapter label is NOT an exception: only a registered label survives, and any other becomes the fixed
 * sentinel `unmatched` (R3, R11, D1). R2, R5, R7 and R9 pin where the identifier line is.
 *
 *
 * NOT COVERED, BY NAME: the receipt clause ("never under an APPLIED receipt"; the reviewer's reading is that the audit insertion
 * may have its own APPLIED receipt, so no row asserts otherwise); the cost of a refusal flood on the REST process (question 3); the MCP adapter's own call into
 * /api/refusals (R3 sends the report directly).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, killExecutor } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL = path.join(HERE, '..', 'scripts', 'card-ref-index-1744.mjs');
const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PERSON = 'https://scrumboard.local/person/';
const ENTITY = 'https://scrumboard.local/entity/';
const ACT_NS = 'https://scrumboard.local/activity/';
const UNKNOWN = `${RS}unknown`;

// ── THE CONTRACT ──
const FLAG = { SCRUM_HISTORY_NATIVE: '1' };
const C = {
  ChangeActivity: `${RS}ChangeActivity`, Activity: `${PROV}Activity`,
  op: `${RS}op`, entityKind: `${RS}entityKind`, used: `${PROV}used`, actor: `${PROV}wasAssociatedWith`, at: `${PROV}startedAtTime`,
  part: `${RS}part`, recordedBy: `${RS}recordedBy`, versionAfter: `${RS}versionAfter`,
};
const CARD_ONLY = [`${RS}holderAtWrite`, `${RS}columnBefore`, `${RS}columnAfter`, `${RS}shortId`];
const activityIri = (opId, part) => `${ACT_NS}op-${crypto.createHash('sha256').update(opId).digest('hex').slice(0, 32)}-${part}`;
const RX = { outcome: 'urn:ex:outcome', commitSeq: 'urn:ex:commitSeq', at: 'urn:ex:at' };

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const ROSTER = path.join(os.tmpdir(), `hn2-1762-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bob: { name: 'Bob', glyph: 'b', color: '#a07cc4' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKBOB = mintToken();
const TOKENS = path.join(os.tmpdir(), `hn2-1762-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }, bob: { credentials: [{ tokenHash: hashToken(TOKBOB), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
process.once('exit', () => { for (const f of [ROSTER, TOKENS]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } } });

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

async function world(flag, body, opts = {}) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'hn2-1762' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  let rest = null;
  const evdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hn2-1762-events-'));
  try {
    const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
    const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-hn2-1762';
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hn2-1762-allocator-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
    assert.equal(seed.status, 200, `PRECONDITION: the allocator is seeded (${await seed.text()})`);
    const b = await runNode([BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
    assert.equal(b.status, 0, `PRECONDITION: the reference index is backfilled (exit ${b.status}: ${(b.err || b.out).slice(-300)})`);
    fs.chmodSync(w.boardFile, 0o000);
    rest = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_SEAT_TOKENS: TOKENS, ...((opts.auth ?? 'required') === 'required' ? { SCRUM_AUTH: 'required' } : {}), SCRUM_EVENT_LOG_DIR: evdir, ...(flag ? FLAG : {}) } });
    // `as`: the bearer token to send (ada's by default), or null for NO credential at all
    const call = async (method, route, payload, as = TOK) => {
      const headers = { ...(as ? { authorization: `Bearer ${as}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
      const x = await fetch(`${rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    await body({ q, call, gc, exec: w.exec, rest, evdir });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    if (rest) await rest.stop().catch(() => {});
    try { fs.rmSync(evdir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    await w.stop();
  }
}

// ── THE S2 CONTRACT, one table ──
const RR = {
  type: `${RS}RefusalRecord`, refusedAction: `${RS}refusedAction`, recordedBy: `${RS}recordedBy`, route: `${RS}route`, status: `${RS}status`, code: `${RS}code`, rule: `${RS}rule`,
  entityKind: `${RS}entityKind`, entityId: `${RS}entityId`, requestId: `${RS}requestId`, actor: `${PROV}wasAssociatedWith`, at: `${PROV}startedAtTime`,
};
const EX_RECORDED_BY = 'urn:ex:recordedBy';   // the compiler's bookkeeping predicate for every record kind
const ALLOWED = new Set([RDF_TYPE, RR.refusedAction, RR.recordedBy, EX_RECORDED_BY, RR.route, RR.status, RR.code, RR.rule, RR.entityKind, RR.entityId, RR.requestId, RR.actor, RR.at]);
// v2.2: an unknown code, rule, label or unmatched route is the IRI scrum:unlisted; a MISSING code or rule is ABSENT; the route placeholder is `:p`
const UNLISTED = `${RS}unlisted`;
const OPREF = (actorIri, template, requestId) => `urn:ex:op/refused/${crypto.createHash('sha256').update(`${actorIri}\u0000${template}\u0000${requestId}`).digest('hex').slice(0, 32)}`;   // v2.2 section 2
const CLAIM_ROUTE = 'POST /api/cards/:p/claim';
/** a lowercase marker no fixture, route or message contains; any trace of it in the graph or the event log is free text */
const MARK = `qz${crypto.randomBytes(5).toString('hex')}kx`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── reads ──
async function refusalRecords(q) {
  const rows = await q(`SELECT DISTINCT ?a ?p ?o WHERE { { ?a <${RDF_TYPE}> <${RR.type}> } UNION { GRAPH ?g0 { ?a <${RDF_TYPE}> <${RR.type}> } } { ?a ?p ?o } UNION { GRAPH ?g { ?a ?p ?o } } }`);
  const m = new Map();
  for (const r of rows) {
    const a = r.a.value; if (!m.has(a)) m.set(a, {});
    (m.get(a)[r.p.value] ||= []).push({ type: r.o.type, value: r.o.value, datatype: r.o.datatype ?? null });
  }
  return m;
}
/** the op a record names as its audit write, whichever namespace carries the link (R17 pins which) */
const opOf = (n, label) => { const v = [...(n[RR.recordedBy] || []), ...(n[EX_RECORDED_BY] || [])]; assert.equal(v.length, 1, `${label}: the record names exactly one audit op (got ${JSON.stringify(v)})`); return v[0].value; };
const one = (node, p, label) => { const v = node[p] || []; assert.equal(v.length, 1, `${label}: exactly one ${p} (got ${JSON.stringify(v)})`); return v[0]; };
/** every subject, predicate or object, in any graph, that holds `needle` (case-insensitively): the free-text trace */
async function traces(q, needle) {
  const n = JSON.stringify(String(needle).toLowerCase());
  return q(`SELECT ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } FILTER(CONTAINS(LCASE(STR(?s)), ${n}) || CONTAINS(LCASE(STR(?p)), ${n}) || CONTAINS(LCASE(STR(?o)), ${n})) }`);
}
/** the audit write's own receipt: the op the record names, in the bookkeeping graph */
async function auditReceipt(q, opIri) {
  const r = await q(`SELECT ?o WHERE { GRAPH <${BK}> { <${opIri}> <urn:ex:outcome> ?o } }`);
  return r.map((x) => x.o.value);
}
const showTrace = (rows) => JSON.stringify(rows.slice(0, 3).map((r) => [r.s.value, r.p.value, r.o.value.slice(0, 80)]));
async function changeActivities(q) {
  const rows = await q(`SELECT DISTINCT ?a WHERE { ?a <${RDF_TYPE}> <${RS}ChangeActivity> }`);
  return new Set(rows.map((r) => r.a.value));
}

// ── the event log, as bytes and as rows ──
function walk(dir) {
  const out = []; if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); }
  return out.sort();
}
function evState(dir) {
  const h = crypto.createHash('sha256'); let bytes = 0; const files = walk(dir);
  for (const f of files) { const b = fs.readFileSync(f); h.update(path.relative(dir, f)); h.update(b); bytes += b.length; }
  return { files: files.length, bytes, sha: h.digest('hex') };
}
const evRows = (dir) => walk(dir).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
/** two samples 1.2 s apart that agree: a quiet log to compare against */
async function settledEv(dir) {
  let prev = evState(dir);
  for (let i = 0; i < 20; i++) { await sleep(1200); const cur = evState(dir); if (cur.sha === prev.sha) return cur; prev = cur; }
  assert.fail('PRECONDITION: the event log never settled');
}
const sameLog = (a, b, label) => assert.deepEqual(b, a, `${label}: the event log's bytes did not move (before ${JSON.stringify(a)}, after ${JSON.stringify(b)})`);

/** a conversation POST the server refuses (it names a card that does not exist); the marker rides in the body, attachedTo and the error */
const refusedPost = (extra = {}) => ({ author: 'ada', body: `a secret ${MARK} text`, attachedTo: `no-such-card-${MARK}`, ...extra });
const isRefusal = (r) => r.status >= 400 && r.status < 500;
// one claim by ada so a second claim by bob is refused 409
async function claimThenRefuse(call) {
  const c1 = await call('POST', '/api/cards/uuid-1/claim', { by: 'ada' });
  assert.equal(c1.status, 200, `PRECONDITION: ada claims uuid-1 (${c1.status} ${c1.text.slice(0, 160)})`);
  return async () => {
    const c2 = await call('POST', '/api/cards/uuid-1/claim', { by: 'bob' }, TOKBOB);
    assert.equal(c2.status, 409, `PRECONDITION: bob's claim is refused 409 (${c2.status} ${c2.text.slice(0, 160)})`);
    return c2;
  };
}

// ── F0 ──
test('#1762 S2 F0 CONTROL, flag unset — a refused claim writes ONE refused row to the event log, as today, and NO graph record', T, async () => {
  await world(false, async ({ q, call, evdir }) => {
    const refuse = await claimThenRefuse(call);
    const state0 = await settledEv(evdir);
    const before = evRows(evdir).filter((r) => r.op === 'refused').length;
    await refuse();
    await sleep(1500);
    const rows = evRows(evdir).filter((r) => r.op === 'refused');
    assert.equal(rows.length, before + 1, `F0: exactly one new refused row in the event log (before ${before}, after ${rows.length})`);
    const last = rows[rows.length - 1];
    assert.equal(last.status, 409, 'F0: the row carries the status');
    assert.equal(last.route, 'POST /api/cards/uuid-1/claim', 'F0: today\'s row carries the RAW route');
    assert.equal((await refusalRecords(q)).size, 0, 'F0: flag unset, no graph record');
    assert.notEqual(evState(evdir).sha, state0.sha, 'F0: CONTROL for the byte comparison the other rows rely on: it MOVES when the log gains a row');
  });
});

// ── C0 ──
test('#1762 S2 C0 CONTROL — the trace scan finds a marker that IS in the graph, so an empty scan in R2/R3/R5/R6/R7 means absence', T, async () => {
  await world(true, async ({ q, call }) => {
    const ok = await call('POST', '/api/conversations', { author: 'ada', body: `a legitimate post ${MARK}`, requestId: `rid-${MARK}-c0` });
    assert.ok(ok.status === 200 || ok.status === 201, `PRECONDITION: a valid post is accepted (${ok.status} ${ok.text.slice(0, 160)})`);
    await sleep(1500);
    assert.ok((await traces(q, MARK)).length > 0, 'C0: the scan finds the marker in the accepted post');
  });
});

// ── R1 ──
test('#1762 S2 R1 — a refused claim: ONE content-free record with every field in the closed set, the template route and the authenticated seat; the audit has its own APPLIED receipt; the event log is unchanged', T, async () => {
  await world(true, async ({ q, call, evdir }) => {
    const refuse = await claimThenRefuse(call);
    const evBefore = await settledEv(evdir);
    const acts = await changeActivities(q);
    const t0 = Date.now() - 2000;
    const c2 = await refuse();
    const t1 = Date.now() + 2000;
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).entries()];
    assert.equal(recs.length, 1, `R1: exactly one RefusalRecord (got ${recs.length})`);
    const [iri, n] = recs[0];
    assert.deepEqual((n[RDF_TYPE] || []).map((x) => x.value), [RR.type], 'R1: typed RefusalRecord and nothing else (never a ChangeActivity, never a prov:Activity)');
    assert.equal(one(n, RR.route, 'R1').value, CLAIM_ROUTE, 'R1: scrum:route is the TEMPLATE, never the raw path');
    assert.equal(one(n, RR.refusedAction, 'R1').value, 'claim', 'R1: scrum:refusedAction is the template\'s last fixed segment after a capture');
    assert.equal(one(n, RR.entityId, 'R1').value, 'uuid-1', 'R1: scrum:entityId, because uuid-1 has a safe id\'s shape');
    const c2code = c2.json && typeof c2.json.code === 'string' ? c2.json.code : null;
    if (c2code) assert.equal(one(n, RR.code, 'R1').value, c2code, 'R1: scrum:code is the response\'s registered code');
    else assert.equal((n[RR.code] || []).length, 0, 'R1: the response names no code, so scrum:code is ABSENT');
    assert.equal((n[RR.rule] || []).length, 0, 'R1: a server refusal has no scrum:rule');
    const st = one(n, RR.status, 'R1'); assert.equal(st.value, '409', 'R1: scrum:status'); assert.equal(st.datatype, `${XSD}integer`, 'R1: scrum:status is xsd:integer');
    assert.equal(one(n, RR.entityKind, 'R1').value, 'card', 'R1: scrum:entityKind');
    assert.equal(one(n, RR.actor, 'R1').value, `${PERSON}bob`, 'R1: prov:wasAssociatedWith is the AUTHENTICATED seat (bob\'s token)');
    const at = one(n, RR.at, 'R1'); assert.equal(at.datatype, `${XSD}dateTime`, 'R1: prov:startedAtTime is xsd:dateTime');
    const ms = Date.parse(at.value); assert.ok(ms >= t0 && ms <= t1, `R1: the time is inside the call (${at.value})`);
    const extra = Object.keys(n).filter((p) => !ALLOWED.has(p));
    assert.deepEqual(extra, [], `R1: no predicate outside the closed set (record ${iri} also has ${extra.join(', ')})`);
    const op = opOf(n, 'R1');
    assert.ok(/^urn:ex:op\/refused\//.test(op), `R1: scrum:recordedBy names the audit's own op (${op})`);
    const outcomes = await auditReceipt(q, op);
    assert.equal(outcomes.length, 1, `R1: the audit op has exactly one receipt (got ${outcomes.length})`);
    assert.ok(/APPLIED$/.test(outcomes[0]), `R1: and it is APPLIED (${outcomes[0]})`);
    assert.deepEqual([...(await changeActivities(q))].filter((a) => !acts.has(a)), [], 'R1: the refusal added no ChangeActivity');
    const usedBy = await q(`SELECT ?a WHERE { ?a <${RDF_TYPE}> <${RS}ChangeActivity> ; <${PROV}used> <${iri}> }`);
    assert.equal(usedBy.length, 0, 'R1: no ChangeActivity prov:used the record');
    sameLog(evBefore, evState(evdir), 'R1');
  });
});

// ── R2 ──
test('#1762 S2 R2 — a refused conversation POST: its text, its attachedTo and the error naming them are in NO literal anywhere, and the event log is unchanged', T, async () => {
  await world(true, async ({ q, call, evdir }) => {
    const evBefore = await settledEv(evdir);
    // the requestId is allowed in the graph (the contract stores it and derives the op IRI from it), so it must not carry the marker
    const r = await call('POST', '/api/conversations', refusedPost({ requestId: `rid-${crypto.randomBytes(6).toString('hex')}-02` }));
    assert.ok(isRefusal(r), `PRECONDITION: the post is refused with a 4xx (${r.status} ${r.text.slice(0, 200)})`);
    await sleep(1500);
    assert.equal((await refusalRecords(q)).size, 1, 'R2: the refusal WAS recorded (one record), so an empty scan below is not an absent audit');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R2: the marker is in no subject, predicate or literal in any graph (${showTrace(hit)})`);
    sameLog(evBefore, evState(evdir), 'R2');
    assert.ok(!walk(evdir).some((f) => fs.readFileSync(f, 'utf8').toLowerCase().includes(MARK)), 'R2: the marker is not in the event log either');
  });
});

// ── R3 ──
test('#1762 S2 R3 — an ADAPTER report: every string the adapter supplies is allowlisted; unknown rule and label are scrum:unlisted; registered ones are kept; the event log is unchanged', T, async () => {
  await world(true, async ({ q, call, evdir }) => {
    const evBefore = await settledEv(evdir);
    const r = await call('POST', '/api/refusals', {
      actor: `zed-${MARK}`, rule: `rule-${MARK}`, reason: `told ${MARK}`, entity: { kind: 'card', id: `id ${MARK}` },
      request: { secret: MARK }, route: `POST /api/${MARK}/anything`,
    });
    assert.equal(r.status, 201, `PRECONDITION: the report is accepted (${r.status} ${r.text.slice(0, 200)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).entries()];
    assert.equal(recs.length, 1, `R3: exactly one RefusalRecord (got ${recs.length})`);
    const n = recs[0][1];
    const rule = one(n, RR.rule, 'R3'); assert.equal(rule.value, UNLISTED, 'R3: a rule that is not registered is the IRI scrum:unlisted, never verbatim'); assert.equal(rule.type, 'uri', 'R3: and it is an IRI');
    assert.equal(one(n, RR.route, 'R3').value, UNLISTED, 'R3: a route the adapter supplies that is not on the closed label list is scrum:unlisted');
    assert.equal(one(n, RR.refusedAction, 'R3').value, UNLISTED, 'R3: and so is its refusedAction');
    assert.equal(one(n, RR.actor, 'R3').value, `${PERSON}ada`, 'R3: the authenticated seat (ada\'s token) wins over the declared actor in the body');
    assert.deepEqual(Object.keys(n).filter((p) => !ALLOWED.has(p)), [], 'R3: no predicate outside the closed set');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R3: the marker is in no subject, predicate or literal in any graph (${showTrace(hit)})`);
    sameLog(evBefore, evState(evdir), 'R3');
    // the two REGISTERED adapter labels and the two registered rules are kept verbatim, with their action
    for (const [rule2, label, action] of [['#755 work gate', 'mcp card_create', 'card_create'], ['#755 claim cooldown', 'mcp card-targeting gate', 'card-targeting']]) {
      const ok = await call('POST', '/api/refusals', { actor: 'ada', rule: rule2, reason: 'told', entity: { kind: 'card', id: 'uuid-1' }, request: null, route: label });
      assert.equal(ok.status, 201, `PRECONDITION: the report for ${label} is accepted (${ok.status} ${ok.text.slice(0, 160)})`);
    }
    await sleep(2000);
    const all = [...(await refusalRecords(q)).values()];
    assert.equal(all.length, 3, `R3: three records now (got ${all.length})`);
    for (const [rule2, label, action] of [['#755 work gate', 'mcp card_create', 'card_create'], ['#755 claim cooldown', 'mcp card-targeting gate', 'card-targeting']]) {
      const rec = all.find((x) => (x[RR.rule] || []).some((v) => v.value === rule2));
      assert.ok(rec, `R3: the registered rule "${rule2}" is stored verbatim`);
      assert.equal(one(rec, RR.route, 'R3b').value, label, `R3: the registered label ${label} is kept`);
      assert.equal(one(rec, RR.refusedAction, 'R3b').value, action, `R3: and its refusedAction is ${action}`);
      assert.equal(one(rec, RR.entityId, 'R3b').value, 'uuid-1', 'R3: a safe entity id is kept');
    }
  });
});

// ── R4 ──
test('#1762 S2 R4 — the same requestId, actor and template refused twice with identical facts is ONE record, under the scoped op id', T, async () => {
  await world(true, async ({ q, call }) => {
    const rid = `rid-${MARK}-04`;
    for (let i = 0; i < 2; i++) {
      const r = await call('POST', '/api/conversations', refusedPost({ requestId: rid }));
      assert.ok(isRefusal(r), `PRECONDITION: attempt ${i + 1} is refused (${r.status} ${r.text.slice(0, 160)})`);
    }
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, `R4: one record for one scope refused twice (got ${recs.length})`);
    assert.equal(one(recs[0], RR.requestId, 'R4').value, rid, 'R4: it carries the requestId');
    assert.equal(opOf(recs[0], 'R4'), OPREF(`${PERSON}ada`, 'POST /api/conversations', rid), 'R4: the audit op id is urn:ex:op/refused/<sha256(actor, template, requestId)[:32]> (v2.2 section 2)');
  });
});

// ── R5 ──
test('#1762 S2 R5 — a requestId outside the pattern is not stored and its text is nowhere; the refusal is still recorded', T, async () => {
  await world(true, async ({ q, call }) => {
    const r = await call('POST', '/api/conversations', refusedPost({ requestId: `not a valid id ${MARK} ✓` }));
    assert.ok(isRefusal(r), `PRECONDITION: the post is refused (${r.status} ${r.text.slice(0, 160)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, `R5: the refusal is recorded (got ${recs.length} records)`);
    assert.equal((recs[0][RR.requestId] || []).length, 0, 'R5: no scrum:requestId, because the id does not match the pattern');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R5: the marker is nowhere (${showTrace(hit)})`);
  });
});

// ── R6 ──
test('#1762 S2 R6 — the authenticated seat wins over a declared actor; an unauthenticated refusal naming a seat not on the roster records scrum:unknown and keeps the text nowhere', T, async () => {
  await world(true, async ({ q, call }) => {
    // bob's token, a body that names ada: the record is bob's
    const a = await call('POST', '/api/refusals', { actor: 'ada', rule: 'r', reason: 'x', entity: { kind: 'card', id: 'uuid-1' } }, TOKBOB);
    assert.equal(a.status, 201, `PRECONDITION: bob's report is accepted (${a.status} ${a.text.slice(0, 160)})`);
    await sleep(1500);
    let recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, 'R6: one record so far');
    assert.equal(one(recs[0], RR.actor, 'R6a').value, `${PERSON}bob`, 'R6a: the record is BOB\'s: the token binds the seat, the declared actor does not override it');
    // no credential, a declared actor that is not a roster seat
    const u = await call('POST', '/api/cards', { title: 't', by: `zed-${MARK}` }, null);
    assert.ok(u.status === 401 || u.status === 403, `PRECONDITION: an unauthenticated write is refused 401/403 (${u.status} ${u.text.slice(0, 160)})`);
    await sleep(1500);
    recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 2, `R6: the unauthenticated refusal is recorded too (got ${recs.length})`);
    const unk = recs.filter((n) => (n[RR.actor] || []).some((x) => x.value === `${RS}unknown`));
    assert.equal(unk.length, 1, 'R6b: exactly one record is associated with scrum:unknown');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R6b: the declared name is nowhere (${showTrace(hit)})`);
  });
});

// ── R6c ──
test('#1762 S2 R6c — with no credential bound (auth not required), the DECLARED actor is recorded only when it is a roster seat; any other name is scrum:unknown and nowhere', T, async () => {
  await world(true, async ({ q, call }) => {
    const c1 = await call('POST', '/api/cards/uuid-1/claim', { by: 'ada' }, null);
    assert.equal(c1.status, 200, `PRECONDITION: ada claims uuid-1 with no token (${c1.status} ${c1.text.slice(0, 160)})`);
    const roster = await call('POST', '/api/cards/uuid-1/claim', { by: 'bob' }, null);
    assert.equal(roster.status, 409, `PRECONDITION: bob's tokenless claim is refused 409 (${roster.status} ${roster.text.slice(0, 160)})`);
    const stranger = await call('POST', '/api/cards/uuid-1/claim', { by: `zed-${MARK}` }, null);
    assert.ok(isRefusal(stranger), `PRECONDITION: a claim by a name not on the roster is refused (${stranger.status} ${stranger.text.slice(0, 160)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 2, `R6c: two records (got ${recs.length})`);
    const actors = recs.map((n) => one(n, RR.actor, 'R6c').value).sort();
    assert.deepEqual(actors, [`${PERSON}bob`, `${RS}unknown`].sort(), 'R6c: the roster seat is recorded as itself, the stranger as scrum:unknown');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R6c: the stranger's name is nowhere (${showTrace(hit)})`);
  }, { auth: 'optional' });
});

// ── R7 ──
test('#1762 S2 R7 — a path segment that is free text: the stored route is the template, no entityId is stored, the marker is nowhere', T, async () => {
  await world(true, async ({ q, call }) => {
    // not id-shaped (it has a space): an id-shaped segment is stored as scrum:entityId by design (R9 says how much)
    const r = await call('POST', `/api/cards/${encodeURIComponent(`${MARK} free text`)}/claim`, { by: 'ada' });
    assert.ok(isRefusal(r), `PRECONDITION: a claim on a card that does not exist is refused (${r.status} ${r.text.slice(0, 160)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, `R7: one record (got ${recs.length})`);
    const route = one(recs[0], RR.route, 'R7').value;
    assert.equal(route, CLAIM_ROUTE, `R7: the stored route is the template, not the raw path (${route})`);
    assert.equal((recs[0][RR.entityId] || []).length, 0, 'R7: no scrum:entityId, because the segment is not a safe id');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R7: the marker is in no subject, predicate or literal in any graph (${showTrace(hit)})`);
  });
});

// ── R8 ──
test('#1762 S2 R8 — the executor down: five refusals answer exactly as one did before; /api/health counts the failed audits and says since when; stderr gets one audit line; the event log does not move', T, async () => {
  await world(true, async ({ call, evdir, exec, rest }) => {
    const pre = await call('POST', '/api/cards', { title: 't', by: 'ada' }, null);
    assert.ok(pre.status === 401 || pre.status === 403, `PRECONDITION: an unauthenticated write is refused (${pre.status} ${pre.text.slice(0, 160)})`);
    const evBefore = await settledEv(evdir);
    await killExecutor(exec);
    const health = async () => { const h = await fetch(`${rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(20000) }); assert.equal(h.status, 200, 'R8: /api/health still answers'); return (await h.json()).refusalAuditUnavailable; };
    const errMark = rest.stderr().length;
    const t0 = Date.now() - 2000;
    let c1 = null;
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/cards', { title: 't', by: 'ada' }, null);
      assert.equal(r.status, pre.status, `R8: refusal ${i + 1} answers ${pre.status} with the executor away (got ${r.status})`);
      assert.equal(r.text, pre.text, `R8: refusal ${i + 1}'s body is unchanged`);
      if (i === 0) { await sleep(800); c1 = await health(); }
    }
    await sleep(1500);
    const c5 = await health();
    assert.ok(c1 && Number(c1.count) >= 1, `R8: after one refusal /api/health carries refusalAuditUnavailable with a count of at least 1 (got ${JSON.stringify(c1)})`);
    assert.equal(Number(c5.count) - Number(c1.count), 4, `R8: each failed audit is counted once (${c1.count} after one, ${c5.count} after five)`);
    const since = Date.parse(c5.since);
    assert.ok(Number.isFinite(since) && since >= t0 && since <= Date.now() + 1000, `R8: since is the time of the first failure (${c5.since})`);
    const lines = rest.stderr().slice(errMark).split('\n').filter((l) => l.includes('[#1762 S2] refusal audit unavailable'));
    assert.equal(lines.length, 1, `R8: stderr gets exactly one "[#1762 S2] refusal audit unavailable" line for a burst inside a minute (got ${lines.length}: ${JSON.stringify(lines.slice(0, 3))})`);
    sameLog(evBefore, evState(evdir), 'R8');
  });
});

// ── R9 ──
test('#1762 S2 R9 — a path segment far outside a safe id (300 characters, the marker inside) is not stored as scrum:entityId and the marker is nowhere', T, async () => {
  await world(true, async ({ q, call }) => {
    const long = `${MARK}${'a'.repeat(300)}`;
    const r = await call('POST', `/api/cards/${long}/claim`, { by: 'ada' });
    assert.ok(isRefusal(r), `PRECONDITION: a claim on a card that does not exist is refused (${r.status} ${r.text.slice(0, 160)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, `R9: one record (got ${recs.length})`);
    assert.equal((recs[0][RR.entityId] || []).length, 0, 'R9: no scrum:entityId');
    const hit = await traces(q, MARK);
    assert.equal(hit.length, 0, `R9: the marker is nowhere (${showTrace(hit)})`);
  });
});

// ── R10 ──
test('#1762 S2 R10 — a registered code is stored verbatim; a refusal whose response names no code has NO scrum:code', T, async () => {
  await world(true, async ({ q, call }) => {
    const named = await call('POST', '/api/conversations', refusedPost({ requestId: `rid-${crypto.randomBytes(6).toString('hex')}-10` }));
    assert.ok(isRefusal(named) && typeof named.json?.code === 'string', `PRECONDITION: the post is refused with a code (${named.status} ${named.text.slice(0, 160)})`);
    const bare = await call('POST', '/api/cards/uuid-nope/claim', { by: 'ada' });
    assert.ok(isRefusal(bare) && !(bare.json && bare.json.code), `PRECONDITION: a claim on a missing card is refused WITHOUT a code (${bare.status} ${bare.text.slice(0, 160)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 2, `R10: two records (got ${recs.length})`);
    const a = recs.find((n) => (n[RR.route] || []).some((v) => v.value === 'POST /api/conversations'));
    const b = recs.find((n) => (n[RR.route] || []).some((v) => v.value === CLAIM_ROUTE));
    assert.ok(a && b, 'R10: one record per route');
    assert.equal(one(a, RR.code, 'R10a').value, named.json.code, 'R10: the response\'s registered code is stored verbatim');
    assert.equal((b[RR.code] || []).length, 0, 'R10: no code in the response, so scrum:code is absent');
  });
});

// ── R11 ──
test('#1762 S2 R11 — an adapter label that names no registered tool is scrum:unlisted, so a letters-only word cannot ride in on the route', T, async () => {
  await world(true, async ({ q, call }) => {
    // letters only: an adapter label is `mcp ` plus lowercase words, and a marker with digits would fail a shape check for the wrong reason
    const word = Array.from({ length: 14 }, () => 'bcdfghjklmnpqrstvwxz'[crypto.randomInt(0, 20)]).join('');
    const r = await call('POST', '/api/refusals', { actor: 'ada', rule: '#755 work gate', reason: 'told', entity: { kind: 'card', id: 'uuid-1' }, request: null, route: `mcp ${word}` });
    assert.equal(r.status, 201, `PRECONDITION: the report is accepted (${r.status} ${r.text.slice(0, 160)})`);
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, `R11: one record (got ${recs.length})`);
    assert.equal(one(recs[0], RR.route, 'R11').value, UNLISTED, 'R11: a label that is not on the closed list is scrum:unlisted');
    assert.equal(one(recs[0], RR.refusedAction, 'R11').value, UNLISTED, 'R11: and so is its refusedAction');
    assert.equal((await traces(q, word)).length, 0, 'R11: the word is nowhere in the graph');
  });
});

// ── R12: same requestId, different actor or template → DISTINCT records ──
test('#1762 S2 R12 — the same requestId from a different actor, or on a different route template, is a DISTINCT record', T, async () => {
  await world(true, async ({ q, call }) => {
    const rid = `rid-${crypto.randomBytes(6).toString('hex')}-12`;
    const a = await call('POST', '/api/conversations', refusedPost({ requestId: rid }));                    // ada, conversations
    const b = await call('POST', '/api/conversations', refusedPost({ requestId: rid }), TOKBOB);            // bob, conversations (a different actor)
    const c = await call('POST', '/api/cards/uuid-nope/claim', { by: 'ada', requestId: rid });             // ada, the claim template (a different route)
    for (const [n, r] of [['ada conversations', a], ['bob conversations', b], ['ada claim', c]]) assert.ok(isRefusal(r), `PRECONDITION: ${n} is refused (${r.status} ${r.text.slice(0, 120)})`);
    await sleep(2000);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 3, `R12: three distinct records for one requestId (got ${recs.length}; actors and routes: ${JSON.stringify(recs.map((n) => [(n[RR.actor] || [])[0]?.value?.split('/').pop(), (n[RR.route] || [])[0]?.value]))})`);
    const keys = new Set(recs.map((n) => `${one(n, RR.actor, 'R12').value}|${one(n, RR.route, 'R12').value}`));
    assert.equal(keys.size, 3, 'R12: and they differ in actor or template');
  });
});

// ── R13: same scope, CHANGED facts → the business refusal is unchanged, the first record stands, and the conflict is visible ──
test('#1762 S2 R13 — the same actor, template and requestId refused again with CHANGED facts: the business refusal is unchanged, the first record stands, and the audit conflict is visible on /api/health', T, async () => {
  await world(true, async ({ q, call, rest }) => {
    const rid = `rid-${crypto.randomBytes(6).toString('hex')}-13`;
    const health = async () => ((await (await fetch(`${rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(20000) })).json()).refusalAuditUnavailable) || { count: 0 };
    const first = await call('POST', '/api/conversations', refusedPost({ requestId: rid }));                // 400 NO_SUCH_CARD
    assert.ok(isRefusal(first) && first.json?.code, `PRECONDITION: the first refusal names a code (${first.status} ${first.text.slice(0, 140)})`);
    await sleep(1500);
    const before = Number((await health()).count);
    // a control: what this second request answers on its own, with a fresh requestId
    const ctl = await call('POST', '/api/conversations', { author: 'ada', requestId: `rid-${crypto.randomBytes(6).toString('hex')}-ctl` });
    assert.ok(isRefusal(ctl) && ctl.json?.code !== first.json.code, `PRECONDITION: the second request is a DIFFERENT refusal (${ctl.status} ${ctl.text.slice(0, 140)})`);
    await sleep(1500);
    const mid = Number((await health()).count);
    const second = await call('POST', '/api/conversations', { author: 'ada', requestId: rid });             // same scope as `first`, different facts
    await sleep(2000);
    assert.equal(second.status, ctl.status, 'R13: the business refusal is unchanged (same status as its control)');
    assert.equal(second.text, ctl.text, 'R13: and the same body');
    const recs = [...(await refusalRecords(q)).values()].filter((n) => (n[RR.requestId] || []).some((v) => v.value === rid));
    assert.equal(recs.length, 1, `R13: one record for the scope (got ${recs.length})`);
    assert.equal(one(recs[0], RR.code, 'R13').value, first.json.code, 'R13: it still carries the FIRST refusal\'s facts');
    assert.equal(Number((await health()).count) - mid, 1, `R13: the conflict is visible: /api/health's failure count rose by one for it (before ${before}, control ${mid})`);
  });
});

// ── D1: the compiler, called directly, checks the registries itself ──
test('#1762 S2 D1 (pure) — the compiler refuses a refusal.record whose code, rule or adapter label is not registered, even from a caller that skips core/refusal-record.mjs', async () => {
  // imported here, not at the top, so the REST rows above still LOAD on a head that has no S2 module
  const { compile } = await import('../core/graph-compiler.mjs');
  const { refusalIntention, refusalSeat } = await import('../core/refusal-record.mjs');
  const BOARD = 'https://scrumboard.local/person/board';
  const base = { actor: BOARD, route: 'POST /api/cards/:p/claim', status: 409, code: 'WRITE_CONFLICT', rule: null, entityKind: 'card', entityId: '17', requestId: 'req-00000001', seat: refusalSeat({ authSeat: 'ada' }) };
  const built = (over = {}) => refusalIntention({ ...base, ...over });                                 // the builder's own path: derives refusedAction and the op id
  const tampered = (over) => { const i = built(); i.refusal = { ...i.refusal, ...over }; return i; };   // a caller that skips the module and sets ONE field itself
  const accepts = (i) => { try { compile(i); return true; } catch { return false; } };
  assert.ok(accepts(built()), 'D1 CONTROL: a registered code on a registered template compiles');
  assert.ok(accepts(built({ route: 'mcp card_create', rule: '#755 work gate', code: null })), 'D1 CONTROL: a registered rule and adapter label compile');
  assert.ok(accepts(built({ route: 'mcp card-targeting gate', rule: '#755 claim cooldown', code: null })), 'D1 CONTROL: the second registered rule and label compile');
  assert.ok(!accepts(tampered({ code: 'NOT_A_REGISTERED_CODE_ZZ' })), 'D1: a code that merely LOOKS like a code (upper snake) but is not registered is refused');
  assert.ok(!accepts(tampered({ rule: '#755 an invented rail' })), 'D1: a rule that merely looks like a rule is refused');
  assert.ok(!accepts(tampered({ route: 'mcp invented_tool' })), 'D1: an adapter label that names no tool is refused');
});

// ── R14: the audit never loses a refusal silently, and never sits on the response path ──
test('#1762 S2 R14 — forty concurrent refusals while the executor is STALLED: every one answers as before, at most 16 audits are in flight so at least 24 are COUNTED as dropped, and none vanishes', T, async () => {
  await world(true, async ({ q, call, rest, exec }) => {
    const pre = await call('POST', '/api/cards', { title: 't', by: 'ada' }, null);
    assert.ok(pre.status === 401 || pre.status === 403, `PRECONDITION: an unauthenticated write is refused (${pre.status} ${pre.text.slice(0, 120)})`);
    await sleep(2500);
    const baseRecs = (await refusalRecords(q)).size;
    const health = async () => ((await (await fetch(`${rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(20000) })).json()).refusalAuditUnavailable) || { count: 0 };
    const baseCount = Number((await health()).count);
    const N = 40;
    process.kill(exec.proc.pid, 'SIGSTOP');   // audits in flight cannot finish, so the cap of 16 must engage
    let rs;
    try {
      rs = await Promise.all(Array.from({ length: N }, () => call('POST', '/api/cards', { title: 't', by: 'ada' }, null)));
      await sleep(1500);
    } finally { process.kill(exec.proc.pid, 'SIGCONT'); }
    for (const [i, r] of rs.entries()) { assert.equal(r.status, pre.status, `R14: refusal ${i + 1} answers ${pre.status} (got ${r.status})`); assert.equal(r.text, pre.text, `R14: refusal ${i + 1}'s body is unchanged`); }
    await sleep(6000);
    const recs = (await refusalRecords(q)).size - baseRecs;
    const dropped = Number((await health()).count) - baseCount;
    assert.ok(dropped >= N - 16, `R14: at most 16 audits in flight, so at least ${N - 16} of ${N} are counted as dropped (got ${dropped}; ${recs} recorded)`);
    assert.equal(recs + dropped, N, `R14: ${N} refusals = ${recs} recorded + ${dropped} counted (an audit that is neither recorded nor counted is lost silently)`);
  });
});

test('#1762 S2 R14b — with the executor STALLED (not dead), a server refusal still answers promptly: the audit is not on the response path', T, async () => {
  await world(true, async ({ call, exec }) => {
    const pre = await call('POST', '/api/cards', { title: 't', by: 'ada' }, null);
    assert.ok(pre.status === 401 || pre.status === 403, `PRECONDITION: an unauthenticated write is refused (${pre.status} ${pre.text.slice(0, 120)})`);
    process.kill(exec.proc.pid, 'SIGSTOP');
    try {
      const t0 = Date.now();
      const r = await call('POST', '/api/cards', { title: 't', by: 'ada' }, null);
      const took = Date.now() - t0;
      assert.equal(r.status, pre.status, `R14b: the refusal answers ${pre.status} with the executor stalled (got ${r.status})`);
      assert.equal(r.text, pre.text, 'R14b: and its body is unchanged');
      assert.ok(took < 3000, `R14b: it answers promptly, not after the audit's timeout (took ${took} ms)`);
    } finally { process.kill(exec.proc.pid, 'SIGCONT'); }
  });
});

// ── R15: the entityId boundary (v2.2 section 5) ──
test('#1762 S2 R15 — entityId at the boundary: 64 characters is stored, 65 characters or a dot is absent', T, async () => {
  await world(true, async ({ q, call }) => {
    const inside = 'a'.repeat(64), outside = 'a'.repeat(65);
    for (const id of [inside, outside, 'a.b']) {
      const r = await call('POST', `/api/cards/${id}/claim`, { by: 'ada' });
      assert.ok(isRefusal(r), `PRECONDITION: a claim on ${id.length} characters is refused (${r.status} ${r.text.slice(0, 100)})`);
    }
    await sleep(2500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 3, `R15: three records (got ${recs.length})`);
    const withId = recs.filter((n) => (n[RR.entityId] || []).length);
    assert.equal(withId.length, 1, `R15: exactly one record kept an entityId (got ${withId.length})`);
    assert.equal(one(withId[0], RR.entityId, 'R15').value, inside, 'R15: it is the 64-character id');
  });
});

// ── R16: free text in the PATH of an unmatched route (v2.2 section 1) ──
test('#1762 S2 R16 — a refused write to a route no router entry matches: the marker in the path is nowhere, and a record, if one is made, says scrum:unlisted', T, async () => {
  await world(true, async ({ q, call, evdir }) => {
    const evBefore = await settledEv(evdir);
    const r = await call('PATCH', `/api/${MARK}-nothing-here`, { x: 1 });
    assert.ok(isRefusal(r), `PRECONDITION: a write to a route that does not exist is refused (${r.status} ${r.text.slice(0, 160)})`);
    await sleep(1500);
    assert.equal((await traces(q, MARK)).length, 0, 'R16: the marker in the path is nowhere in the graph');
    for (const n of (await refusalRecords(q)).values()) assert.equal(one(n, RR.route, 'R16').value, UNLISTED, 'R16: a record for an unmatched route says scrum:route scrum:unlisted, never the raw path');
    sameLog(evBefore, evState(evdir), 'R16');
  });
});

// ── R17: the audit link's namespace (v2.2 section 8 says scrum:recordedBy) ──
test('#1762 S2 R17 — the record names its audit op with scrum:recordedBy, as v2.2 section 8 says', T, async () => {
  await world(true, async ({ q, call }) => {
    const refuse = await claimThenRefuse(call);
    await refuse();
    await sleep(1500);
    const recs = [...(await refusalRecords(q)).values()];
    assert.equal(recs.length, 1, `R17: one record (got ${recs.length})`);
    assert.equal((recs[0][RR.recordedBy] || []).length, 1, `R17: scrum:recordedBy is present (the record carries ${Object.keys(recs[0]).filter((p) => /recordedBy/.test(p)).join(', ') || 'no recordedBy at all'})`);
  });
});

// T4 was split into R12/R13 (identity and changed facts, per the review); T5 became R15. No todo rows remain.
