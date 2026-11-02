/**
 * #1762 S3 — the facts-only BACKFILL (`scripts/history-backfill-1762.mjs`), black-box, rows first.
 *
 * ROW AUTHOR's rows for the builder's script, written to the "S3 CONTRACT v2", its v2.1 corrections, the v2.2 pins and v2.3 (the whole non-post bucket) on
 * #1762 (section 4, the v2.1 points, the v2.2 pins) before the script exists. mismatch[].fields are the PREFIXED predicate names (the reviewer's 07:01Z
 * ruling, which supersedes v2.2 pin 3's local names). Every row is a REAL executor, the REAL projector (`scripts/activity-projector.mjs --once`) over a
 * hand-built log, and the script as a child process. Nothing here imports the builder's code.
 *
 *   BF-P  the script exists                        (until it does, every row says so, not "exit 1")
 *   BF0   CONTROL: the projected nodes carry NO column, holder or logRecordedAt — the gap the backfill closes
 *   BF1   dry run (the default) writes NOTHING, to any graph, `written` stays 0, `wouldWrite` is what --apply will do, and the report
 *         echoes the dataset, epoch and incarnation it read from the MARKER
 *   BF2   --apply: judged per node against the log, not by count. EVERY served legacy seq-node (card, refused card, column) gets
 *         logRecordedAt = the event's recorded_at as an xsd:dateTime (not occurred_at) and shortId where missing; only a SUCCESSFUL card
 *         event also gets columnAfter = the event's column and holderAtWrite = the holder BEFORE the write (replaying only successful
 *         state-bearing events). A refusal changed no state, so it gets no column or holder. A conversation gets nothing.
 *   BF3   it writes nothing else: only those four predicates, only on seq-nodes, nothing removed, no title/description/body stored
 *   BF4   a second --apply writes nothing (every graph byte-identical) and reports the nodes alreadyCurrent
 *   BF5   a node the projection left without a shortId gets it from the log; a refusal the log gives none stays without one
 *   BF6   the contradictions, one row each: LISTED, UNTOUCHED, NEVER OVERWRITTEN, exit 3, every OTHER verified node still written
 *         mismatch: prov:used · scrum:op · entityKind · startedAtTime · actor · shortId · a pre-existing column · holder · logRecordedAt
 *         missingEvent · missingNode (an event with no node: the direction v1 missed) · duplicate (a seq twice in the log; a
 *         single-valued predicate holding two values) · badIri
 *   BF7   the typed exclusion: a run-<uuid> node carrying performedUsing AND generated is skippedNonSeq (an array of IRIs), not badIri;
 *         the same IRI WITHOUT them is badIri (a malformed IRI cannot hide there); a seq-node carrying performedUsing is still a seq-node
 *   BF8   usage and preflight failures exit 2 and write NOTHING: no --log, unknown flag, a log dir that is not there, a --dataset that
 *         is not the MARKER's
 *   BF9   the event log is read, never written
 *   BF10  the dry run and --apply classify identically, and a dry run that found refusals still writes nothing
 *   BF11  exit 4: a lost ACK on the FIRST write is exit 4 with `apply.uncertain` (exactly the one node in flight: one update per node),
 *         never exit 2 and never "0 written"; uncertainty wins over the refusal buckets; the re-run reconciles (no fact twice). A failure
 *         AFTER some writes landed: `confirmed` = the nodes before it, `uncertain` = the one in flight, the rest unattempted
 *   BF13  the STORE IDENTITY changing during apply (the reviewer's ruling, commons 47679): when the marker's dataset, epoch or incarnation differs
 *         from the plan, at the first update or after confirmed progress: the WHOLE run stops, exit 4, `apply.stopped` {code: STORE_IDENTITY_CHANGED,
 *         fields}, nothing added to the fenced node, no later update, confirmed kept, `uncertain` empty (the update is proven not applied), and a
 *         restart is a NEW explicit plan. Only isolated throwaway stores are changed.
 *   BF14  UPDATE_REFUSED (approved, commons 47685): a COMPLETE refusal on a stable store PROVEN not applied is exit 4, `apply.stopped` {code: UPDATE_REFUSED,
 *         status}, later writes stopped, prior confirmations kept, `uncertain` empty. A non-200 ALONE is not that proof: an update the executor applied and then
 *         answered 500 is never reported as proven-not-applied (the node is confirmed or uncertain, never silently absent)
 *   BF15  the fence covers PRE-EXISTING validated facts too: a node that already has the right column (or holder, or timestamp) and needs the others, whose
 *         existing fact changes between plan and write, gets NOTHING added (all-or-nothing), and is refused naming the changed fact
 *   BF16  term KIND is validated, not text: prov:used / prov:wasAssociatedWith as a plain literal with the IRI's text, a holder as a literal, a
 *         logRecordedAt as an xsd:string, are mismatches, never accepted by lexical equality
 *   BF17  timestamps compare at FULL precision: a microsecond difference is a mismatch (logRecordedAt and startedAtTime), never rounded away
 *   BF18  a NONCANONICAL alias (activity/seq-04 beside seq-4) is reported by its IRI in badIri, never collapsed into the canonical node and never counted in
 *         scanned.nodes (canonical seq-nodes only; the contract author's pin); scanned.nodes + |badIri| + |skippedNonSeq| is every activity subject; the canonical node is still completed
 *   BF19  the readback does NOT scale with the node count: an apply makes exactly ONE whole-population activity enumeration (the preflight), whatever the world size (the contract author's pin)
 *   BF12  the apply-time FENCE: a fact that appears on a node between plan and write, OR a validated identity term that changes (prov:used,
 *         scrum:op, scrum:entityKind, prov:startedAtTime, prov:wasAssociatedWith, scrum:shortId; replaced, or a second value added, or newly
 *         present where preflight saw none), makes that node's guarded update change nothing; the node is refused as `mismatch` naming the
 *         changed term, never retried blind and never overwritten; the others are written
 *
 * ── NOT PINNED / NOT WRITTEN ───────────────────────────────────────────────────────────────────────────────────────────────────
 *   · the fence's dataset / epoch / incarnation half (a store restored between plan and write): no seam changes the marker at that instant
 *   · the order in which nodes are written (the rows never assume one: they pick the in-flight node from what the script reports)
 *
 * ── Assumptions, each one line to correct ─────────────────────────────────────────────────────────────────────────────────────
 *   A1  `written`, `alreadyCurrent`, `wouldWrite` count NODES; `scanned` is {events, nodes} (contract v2: confirmed).
 *   A2  encodings are the native S1 nodes': holder = IRI person/<encodeURIComponent seat> or scrum:none; backfill-only scrum:unknown.
 *   A3  `apply.confirmed` lists the N of every node that was written or verified already current.
 *   A4  the report echoes the marker as {dataset, epoch, incarnation}; epoch compared as text, incarnation without dashes.
 *   A6  the script sends ONE guarded /update per node and identifies a node's update by its seq-node IRI appearing in the request body (v2.2 pin 2).
 *   A5  an xsd:dateTime fact is compared as an INSTANT, never as text: the executor canonicalizes the lexical form ('...:00.000Z' reads back
 *       as '...:00Z'), so a text compare reports a false mismatch on the script's own re-run (BF4 catches that; BF6o pins it).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnExecutor, killExecutor, HAVE_PY, PY, ROOT } from './helpers/graph-executor-proc.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';

const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 180000 };
const BACKFILL = path.join(ROOT, 'scripts', 'history-backfill-1762.mjs');
const PROJECTOR = path.join(ROOT, 'scripts', 'activity-projector.mjs');
const DATASET = 'bf-1762';

const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ACT = 'https://scrumboard.local/activity/';
const ENT = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const COLUMN_AFTER = `${RS}columnAfter`, HOLDER = `${RS}holderAtWrite`, SHORT = `${RS}shortId`, LOGAT = `${RS}logRecordedAt`;
const NONE = `${RS}none`, UNKNOWN = `${RS}unknown`;
const BK = 'urn:scrum:bookkeeping:executor';
const FACTS = new Set([COLUMN_AFTER, HOLDER, SHORT, LOGAT]);
const BUCKETS = ['mismatch', 'missingNode', 'missingEvent', 'duplicate', 'badIri'];
const node = (seq) => `${ACT}seq-${seq}`;

const owned = { dirs: new Set(), children: new Set(), servers: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const s of owned.servers) await new Promise((r) => s.close(r));
  for (const d of owned.dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); owned.dirs.add(d); return d; };

// ── the hand-built log: card create / update / delete, a column, a conversation, two refusals ──
const SECRETS = ['SECRET-TITLE-A', 'SECRET-DESC-A', 'SECRET-TITLE-B', 'SECRET-POST-BODY'];
const AT = (n) => `2026-10-20T10:${String(n).padStart(2, '0')}:00.000Z`;
function cardEv(seq, op, id, shortId, state, actor = 'ada', extra = {}) {
  return { seq, op, actor, recorded_at: AT(seq), ...extra, entity: { kind: 'card', id, shortId }, state: { id, shortId, ...state } };
}
const EVENTS = [
  cardEv(1, 'create', 'uuid-a', 101, { column: 'backlog', claimedBy: null, title: 'SECRET-TITLE-A', description: 'SECRET-DESC-A' }),
  cardEv(2, 'update', 'uuid-a', 101, { column: 'in-progress', claimedBy: 'ada', title: 'SECRET-TITLE-A' }),
  cardEv(3, 'create', 'uuid-b', 102, { column: 'planned', claimedBy: null, title: 'SECRET-TITLE-B' }, 'bob'),
  cardEv(4, 'update', 'uuid-a', 101, { column: 'done', claimedBy: 'ada', title: 'SECRET-TITLE-A' }, 'ada', { occurred_at: '2026-10-20T09:59:00.000Z' }),   // occurred_at is NOT recorded_at
  cardEv(5, 'delete', 'uuid-b', 102, { column: 'planned', claimedBy: 'bob', title: 'SECRET-TITLE-B' }, 'bob'),     // a tombstone keeps its last column
  { seq: 6, op: 'create', actor: 'ada', recorded_at: AT(6), entity: { kind: 'column', id: 'col-x' }, state: { id: 'col-x', name: 'Extra' } },
  { seq: 7, op: 'create', actor: 'ada', recorded_at: AT(7), entity: { kind: 'conversation', id: 'conv-1' }, state: { id: 'conv-1', body: 'SECRET-POST-BODY' } },
  { seq: 8, op: 'refused', actor: 'ada', recorded_at: AT(8), entity: { kind: 'card', id: 'uuid-c' }, state: null, reason: 'REFUSED-REASON-FIXTURE', status: 409 },   // no shortId
  cardEv(9, 'update', 'uuid-a', 101, { column: 'review', claimedBy: 'a b', title: 'SECRET-TITLE-A' }),                 // a CLAIM by a holder that needs encoding
  cardEv(10, 'update', 'uuid-a', 101, { column: 'review', claimedBy: null, title: 'SECRET-TITLE-A' }),                // a RELEASE: before = 'a b', after = nobody
  cardEv(11, 'update', 'uuid-e', 105, { column: 'backlog', claimedBy: 'ada', title: 'SECRET-TITLE-E' }),              // an update whose entity has NO earlier event and no create in the log
  cardEv(12, 'create', 'uuid-g', 107, { column: 'backlog', claimedBy: null, title: 'SECRET-TITLE-G' }),
  cardEv(13, 'update', 'uuid-g', 107, { column: 'in-progress', claimedBy: 'ada', title: 'SECRET-TITLE-G' }),          // ada claims it
  { seq: 14, op: 'refused', actor: 'mallory', recorded_at: AT(14), entity: { kind: 'card', id: 'uuid-g', shortId: 107 }, state: null, reason: 'REFUSED-REASON-FIXTURE', status: 409 },   // a refused write carries NO state
  cardEv(15, 'update', 'uuid-g', 107, { column: 'in-progress', claimedBy: null, title: 'SECRET-TITLE-G' }),          // ada releases: the holder before is ada, not unknown and not the refused writer
];
/** what each CARD node must carry after the backfill, read off the log above, per node */
const EXPECT = {
  1: { column: 'backlog', holder: NONE, why: 'a CREATE: nobody held a card that did not exist' },
  2: { column: 'in-progress', holder: NONE, why: 'a CLAIM by ada: BEFORE the write nobody held it (her post-state claimedBy must not leak in)' },
  3: { column: 'planned', holder: NONE, why: 'a create' },
  4: { column: 'done', holder: `${PERSON}ada`, why: 'a move: ada held it before (seq 2 claimed it); its logRecordedAt is recorded_at, not occurred_at' },
  5: { column: 'planned', holder: NONE, why: 'a DELETE whose tombstone says claimedBy bob: the holder BEFORE it was nobody, the tombstone is not history' },
  9: { column: 'review', holder: `${PERSON}ada`, why: 'a claim by "a b": before it, ada held it' },
  10: { column: 'review', holder: `${PERSON}a%20b`, why: 'a RELEASE: before it "a b" held it, in the encoding of a person IRI' },
  11: { column: 'backlog', holder: UNKNOWN, why: 'no earlier event and no create in the retained log: scrum:unknown, never a guess' },
  12: { column: 'backlog', holder: NONE, why: 'a create' },
  13: { column: 'in-progress', holder: NONE, why: 'a claim by ada: before it nobody held it' },
  15: { column: 'in-progress', holder: `${PERSON}ada`, why: 'a RELEASE after a REFUSED write: the refusal (state null) must not touch the replayed holder, so before the release ada still held it (not unknown, not mallory)' },
};
const CARD_SEQS = Object.keys(EXPECT).map(Number);
const COLUMN_SEQS = [6];               // a column event: served from the graph, so it gets logRecordedAt, but no column or holder
const CONVERSATION_SEQS = [7];         // a conversation: not history S3 serves, so it gets NOTHING
const REFUSAL_SEQS = [8, 14];          // card-kind refusals: logRecordedAt (+ shortId where missing) only
/** every served legacy seq-node: what `written` counts (v2.2 pin 4, and the reviewer's correction: logRecordedAt covers every served legacy row) */
const SERVED_SEQS = [...CARD_SEQS, ...REFUSAL_SEQS, ...COLUMN_SEQS].sort((a, b) => a - b);
const LOCAL = { used: 'prov:used', op: 'scrum:op', entityKind: 'scrum:entityKind', time: 'prov:startedAtTime', actor: 'prov:wasAssociatedWith', shortId: 'scrum:shortId', column: 'scrum:columnAfter', holder: 'scrum:holderAtWrite', logAt: 'scrum:logRecordedAt' };   // the reviewer's 07:01Z ruling: PREFIXED predicate names (it supersedes v2.2 pin 3's local names)
const recordedAtOf = (s) => EVENTS[s - 1].recorded_at;

// ── the world ──
const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 150000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

async function world(body, { events = EVENTS } = {}) {
  const store = tmp('bf1762-store-'); fs.rmSync(store, { recursive: true });
  const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', DATASET, '--create']); owned.children.add(x);
  const logDir = tmp('bf1762-log-');
  fs.writeFileSync(path.join(logDir, 'events-2026-10-20.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const p = await runNode([PROJECTOR, '--log', logDir, '--executor', x.baseUrl, '--once']);
  assert.equal(p.status, 0, `PRECONDITION: the real projector projected the hand-built log (exit ${p.status}: ${(p.err || p.out).slice(-300)})`);
  const health = await (await fetch(`${x.baseUrl}/health`)).json();
  const q = async (sparql) => {
    const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: sparql });
    assert.equal(r.status, 200, `the executor answered the query (${r.status})`);
    return (await r.json()).results.bindings;
  };
  const upd = async (sparql) => {
    const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'content-type': 'application/sparql-update', 'x-op-id': `urn:ex:op/test/bf1762/${crypto.randomUUID()}`, ...(health.epoch != null ? { 'x-epoch': String(health.epoch) } : {}), [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL }, body: sparql });
    assert.equal(r.status, 200, `the planted update applied (${r.status} ${(await r.text()).slice(0, 200)})`);
  };
  /** every quad of every graph, as sorted lines: two equal snapshots mean NOTHING was written anywhere */
  const quads = async () => (await q('SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }'))
    .map((b) => `${b.g?.value ?? '-'}\u0000${b.s.value}\u0000${b.p.value}\u0000${b.o.type}:${b.o.datatype ?? ''}:${b.o.value}`).sort();
  const factsOf = async (iri) => {
    const m = {};
    for (const b of await q(`SELECT ?p ?o WHERE { <${iri}> ?p ?o }`)) (m[b.p.value] ||= []).push(b.o);
    return m;
  };
  const cliVia = async (executor, args) => {
    const r = await runNode([BACKFILL, ...args.map((a) => (a === '@EXECUTOR' ? executor : a))]);
    if (r.status === 1 && /Cannot find module/.test(r.err)) assert.fail('PRECONDITION: scripts/history-backfill-1762.mjs does not exist yet — the contract names it, so these rows are RED until it does');
    return r;
  };
  const cli = (args) => cliVia(x.baseUrl, args);
  const base = ['--executor', '@EXECUTOR', '--dataset', DATASET, '--log', logDir];
  const report = (r, label) => {
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* reported below */ }
    assert.ok(j && typeof j === 'object' && !Array.isArray(j), `${label}: stdout is ONE JSON object (got ${JSON.stringify(r.out.slice(0, 200))}; stderr ${JSON.stringify(r.err.slice(0, 200))})`);
    return j;
  };
  try { await body({ x, health, q, upd, quads, factsOf, cli, cliVia, base, logDir, report }); } finally { await killExecutor(x); owned.children.delete(x); }
}

const one = (m, p, label) => { const v = m[p] || []; assert.equal(v.length, 1, `${label}: exactly one ${p} (got ${JSON.stringify(v)})`); return v[0]; };
const noFacts = (m, label, which = [COLUMN_AFTER, HOLDER, LOGAT]) => { for (const p of which) assert.equal(m[p], undefined, `${label}: untouched — it carries no ${p.replace(RS, 'scrum:')}`); };
const sorted = (a) => [...a].sort();
/** the report's refused buckets, flattened to the identities this file asserts on (mismatch -> its seqs) */
function flat(j, label) {
  assert.ok(j.refused && typeof j.refused === 'object', `${label}: the report has a refused object`);
  for (const b of BUCKETS) assert.ok(Array.isArray(j.refused[b]), `${label}: refused.${b} is a list (contract v2), got ${JSON.stringify(j.refused[b])}`);
  const ALLOWED = new Set(Object.values(LOCAL));
  for (const m of j.refused.mismatch) {
    assert.ok(Number.isInteger(m.seq), `${label}: a mismatch entry names its seq (got ${JSON.stringify(m)})`);
    assert.ok(Array.isArray(m.fields) && m.fields.length >= 1 && m.fields.every((f) => ALLOWED.has(f)), `${label}: and the fields that differ, by the PREFIXED predicate name (the reviewer's 07:01Z ruling, which supersedes v2.2 pin 3): ${[...ALLOWED].join(', ')}); got ${JSON.stringify(m)}`);
  }
  return { mismatchFields: Object.fromEntries(j.refused.mismatch.map((m) => [m.seq, [...m.fields].sort()])), mismatch: j.refused.mismatch.map((m) => m.seq).sort((a, b) => a - b), missingNode: [...j.refused.missingNode].sort((a, b) => a - b), missingEvent: [...j.refused.missingEvent].sort((a, b) => a - b), duplicate: j.refused.duplicate, badIri: sorted(j.refused.badIri) };
}
const emptyBuckets = { mismatch: [], missingNode: [], missingEvent: [], duplicate: [], badIri: [], mismatchFields: {} };
function evState(dir) {
  const h = crypto.createHash('sha256'); let bytes = 0;
  for (const f of fs.readdirSync(dir).sort()) { const b = fs.readFileSync(path.join(dir, f)); h.update(f); h.update(b); bytes += b.length; }
  return { bytes, sha: h.digest('hex') };
}
const planted = (iri, { used = 'uuid-a', op = 'update', kind = 'card', extra = '' } = {}) =>
  `INSERT DATA { <${iri}> <${RDF_TYPE}> <${PROV}Activity> ; <${RS}op> "${op}" ; <${PROV}used> <${ENT}${used}> ; <${RS}entityKind> "${kind}" ${extra} . }`;
const swap = (seq, p, newObj) => `DELETE { <${node(seq)}> <${p}> ?o } INSERT { <${node(seq)}> <${p}> ${newObj} } WHERE { <${node(seq)}> <${p}> ?o }`;

// ── BF-P, BF0 ──
test('#1762 S3 BF-P — scripts/history-backfill-1762.mjs exists', () => {
  assert.ok(fs.existsSync(BACKFILL), 'the contract names scripts/history-backfill-1762.mjs; it is not there yet, so every other backfill row is RED for that one reason');
});

test('#1762 S3 BF0 CONTROL — the real projector leaves seq-nodes with NO column, holder or logRecordedAt: the gap the backfill closes (green on main by design)', T, async () => {
  await world(async ({ q, factsOf }) => {
    const seqNodes = (await q(`SELECT ?a WHERE { ?a <${RDF_TYPE}> <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`)).map((b) => b.a.value);
    assert.deepEqual(sorted(seqNodes), sorted(EVENTS.map((e) => node(e.seq))), 'PRECONDITION: one projected node per log event, the IRI carrying the event\'s own seq');
    for (const s of CARD_SEQS) {
      const m = await factsOf(node(s));
      noFacts(m, `seq ${s}`);
      assert.equal(one(m, `${RS}op`, `seq ${s}`).value, EVENTS[s - 1].op, `seq ${s}: the projection carries the op`);
      assert.equal(one(m, `${PROV}used`, `seq ${s}`).value, `${ENT}${EVENTS[s - 1].entity.id}`, `seq ${s}: and the entity`);
    }
    assert.equal(one(await factsOf(node(4)), `${PROV}startedAtTime`, 'seq 4').value, '2026-10-20T09:59:00.000Z', 'PRECONDITION: the projector stores occurred_at as startedAtTime, so recorded_at is the fact the backfill must ADD');
  });
});

// ── BF1 ──
test('#1762 S3 BF1 — the default is a DRY RUN: exit 0, `written` 0, `wouldWrite` what --apply will do, the marker echoed, and NOTHING written to any graph', T, async () => {
  await world(async ({ cli, base, quads, report, health }) => {
    const before = await quads();
    const r = await cli(base);
    assert.equal(r.status, 0, `a clean dry run exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'dry run');
    assert.equal(j.dryRun, true, 'the report says it was a dry run');
    assert.equal(j.written, 0, 'a dry run writes nothing, so `written` is 0 always');
    assert.equal(j.wouldWrite, SERVED_SEQS.length, 'and `wouldWrite` is the nodes --apply would write: every served legacy node (A1)');
    assert.equal(j.dataset, DATASET, 'it echoes the dataset it read from the marker');
    assert.equal(String(j.epoch), String(health.epoch), 'and the epoch');
    assert.equal(String(j.incarnation).replace(/-/g, '').toLowerCase(), String(health.incarnation).replace(/-/g, '').toLowerCase(), 'and the incarnation');
    assert.deepEqual(await quads(), before, 'every graph is byte-identical after the dry run');
  });
});

// ── BF2 ──
test('#1762 S3 BF2 — --apply: every served legacy node gets logRecordedAt; only a SUCCESSFUL card event also gets its column and the holder BEFORE the write; a refusal, a column and a conversation do not', T, async () => {
  await world(async ({ cli, base, report, factsOf, q }) => {
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `a clean --apply exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, '--apply');
    assert.equal(j.dryRun, false, 'the report says it applied');
    const total = Number((await q(`SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`))[0].n.value);
    assert.deepEqual(j.scanned, { events: EVENTS.length, nodes: total }, 'scanned counts both directions: the log\'s eligible events and the graph\'s seq-nodes (A1)');
    assert.equal(j.written, SERVED_SEQS.length, `written = the nodes it completed (A1): ${CARD_SEQS.length} cards + ${REFUSAL_SEQS.length} refusals + ${COLUMN_SEQS.length} column = ${SERVED_SEQS.length} of the log's ${EVENTS.length} events; the conversation is not served history`);
    assert.equal(j.alreadyCurrent, 0, 'nothing was current before the first run');
    assert.deepEqual(flat(j, '--apply'), emptyBuckets, 'nothing is refused when every node verifies');
    assert.deepEqual(j.skippedNonSeq, [], 'and nothing was skipped');
    assert.deepEqual(sorted((j.apply?.confirmed ?? []).map(Number)), sorted(SERVED_SEQS.map(Number)), 'every written node is ACK-confirmed (A3)');
    assert.deepEqual(j.apply?.uncertain, [], 'and none is uncertain');
    const checkAt = (m, s, label) => {
      const at = one(m, LOGAT, `${label} seq ${s}`);
      assert.equal(Date.parse(at.value), Date.parse(recordedAtOf(s)), `${label} seq ${s}: logRecordedAt is the event's recorded_at, as an INSTANT (the store canonicalizes an xsd:dateTime's text, so '...:00.000Z' reads back as '...:00Z'); not occurred_at`);
      assert.equal(at.datatype, `${XSD}dateTime`, `${label} seq ${s}: and an xsd:dateTime`);
    };
    for (const s of CARD_SEQS) {
      const m = await factsOf(node(s));
      assert.equal(one(m, COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s}: column equals the log's state.column`);
      assert.equal(one(m, HOLDER, `seq ${s}`).value, EXPECT[s].holder, `seq ${s}: holder is the holder BEFORE the write — ${EXPECT[s].why} (A2)`);
      checkAt(m, s, 'card');
    }
    for (const s of REFUSAL_SEQS) { const m = await factsOf(node(s)); checkAt(m, s, 'refusal'); noFacts(m, `seq ${s} (a refusal changed no state)`, [COLUMN_AFTER, HOLDER]); }
    for (const s of COLUMN_SEQS) { const m = await factsOf(node(s)); checkAt(m, s, 'column'); noFacts(m, `seq ${s} (a column event)`, [COLUMN_AFTER, HOLDER]); }
    for (const s of CONVERSATION_SEQS) noFacts(await factsOf(node(s)), `seq ${s} (a conversation: not served history, scanned and never written)`);
  });
});

// ── BF2c (contract v2.3, approved): the WHOLE non-post bucket is served, so every non-conversation kind gets logRecordedAt ──
test('#1762 S3 BF2c — every NON-CONVERSATION kind the log path serves gets logRecordedAt and no column or holder; a conversation still gets nothing (contract v2.3: the whole non-post bucket is served)', T, async () => {
  const kinds = ['delivery', 'board-meta', 'model-call', 'memory', 'seat-state'];
  const evs = [
    ...kinds.map((k, i) => ({ seq: i + 1, op: 'create', actor: 'ada', recorded_at: AT(i + 1), occurred_at: '2026-10-20T08:00:00.000Z', entity: { kind: k, id: `${k}-1` }, state: { id: `${k}-1`, column: 'SHOULD-NOT-BE-COPIED' } })),
    { seq: 6, op: 'create', actor: 'ada', recorded_at: AT(6), entity: { kind: 'conversation', id: 'conv-9' }, state: { id: 'conv-9', body: 'SECRET-POST-BODY' } },
  ];
  await world(async ({ cli, base, report, factsOf }) => {
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'non-card kinds');
    assert.equal(j.written, kinds.length, 'one node per non-conversation event');
    for (let i = 1; i <= kinds.length; i++) {
      const m = await factsOf(node(i));
      assert.equal(Date.parse(one(m, LOGAT, `${kinds[i - 1]} seq ${i}`).value), Date.parse(AT(i)), `${kinds[i - 1]}: logRecordedAt is the recorded time, not the occurrence time`);
      noFacts(m, `${kinds[i - 1]} seq ${i}`, [COLUMN_AFTER, HOLDER]);
    }
    noFacts(await factsOf(node(6)), 'the conversation');
  }, { events: evs });
});

// ── BF3 ──
test('#1762 S3 BF3 — it writes NOTHING else: only the four facts on seq-nodes, nothing removed, no title, description or body text stored', T, async () => {
  await world(async ({ cli, base, quads, q }) => {
    const before = await quads();
    assert.equal((await cli([...base, '--apply'])).status, 0);
    const after = await quads();
    const added = after.filter((l) => !before.includes(l)), removed = before.filter((l) => !after.includes(l));
    assert.deepEqual(removed, [], 'no triple is removed or rewritten');
    const dflt = added.filter((l) => l.startsWith('-\u0000'));
    for (const l of dflt) {
      const [, s, p] = l.split('\u0000');
      assert.ok(FACTS.has(p), `the default graph gains only the four facts, not ${p}`);
      assert.ok(s.startsWith(`${ACT}seq-`), `and only on seq-nodes, not ${s}`);
    }
    assert.ok(dflt.length >= CARD_SEQS.length * 3 + (REFUSAL_SEQS.length + COLUMN_SEQS.length), 'PRECONDITION: it did write (a vacuous "added nothing" would pass the checks above)');
    const dump = (await q('SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }')).map((b) => b.o.value).join('\n');
    for (const s of SECRETS) assert.ok(!dump.includes(s), `no stored value contains "${s}": the backfill carries facts, never content`);
  });
});

// ── BF4 ──
test('#1762 S3 BF4 — a SECOND --apply writes nothing (every graph byte-identical) and reports the nodes alreadyCurrent', T, async () => {
  await world(async ({ cli, base, quads, report }) => {
    assert.equal((await cli([...base, '--apply'])).status, 0);
    const before = await quads();
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `the re-run exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 're-run');
    assert.equal(j.written, 0, 'the re-run writes nothing');
    assert.equal(j.alreadyCurrent, SERVED_SEQS.length, `and counts the ${SERVED_SEQS.length} nodes that are already current (A1)`);
    assert.deepEqual(await quads(), before, 'no graph moved — not even a receipt for a run that did nothing');
  });
});

// ── BF5 ──
test('#1762 S3 BF5 — a node the projection left without a shortId gets it from the log; a refusal whose log event has none stays without one', T, async () => {
  await world(async ({ cli, base, upd, factsOf }) => {
    await upd(`DELETE WHERE { <${node(4)}> <${SHORT}> ?o }`);
    assert.equal((await factsOf(node(4)))[SHORT], undefined, 'PRECONDITION: the planted node lacks its shortId');
    assert.equal((await cli([...base, '--apply'])).status, 0);
    assert.equal(one(await factsOf(node(4)), SHORT, 'seq 4').value, '101', 'seq 4 has the log\'s shortId, as a string literal like the projector writes');
    assert.equal((await factsOf(node(8)))[SHORT], undefined, 'seq 8 (a refusal the log gives no shortId) stays without one: nothing is invented');
  });
});
test('#1762 S3 BF5b — a REFUSED node the projection left without a shortId gets it from the log too (v2.2 pin 4: logRecordedAt and shortId, nothing else)', T, async () => {
  await world(async ({ cli, base, upd, factsOf }) => {
    await upd(`DELETE WHERE { <${node(14)}> <${SHORT}> ?o }`);
    assert.equal((await factsOf(node(14)))[SHORT], undefined, 'PRECONDITION: the planted refusal lacks its shortId');
    assert.equal((await cli([...base, '--apply'])).status, 0);
    const m = await factsOf(node(14));
    assert.equal(one(m, SHORT, 'seq 14').value, '107', 'seq 14 has the log\'s shortId');
    noFacts(m, 'seq 14 (a refusal)', [COLUMN_AFTER, HOLDER]);
  });
});

// ── BF6 the refused buckets ──
async function refusedCase(label, plant, expected, { survivors = CARD_SEQS, held = [], gone = [], events } = {}) {
  await world(async ({ cli, base, upd, factsOf, report, logDir }) => {
    await plant(upd, { logDir });
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `${label}: some refused → exit 3, the rest written (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, label);
    const got = flat(j, label);
    assert.deepEqual(got.mismatch, expected.mismatch ?? [], `${label}: mismatch bucket`);
    for (const [seq, f] of Object.entries(expected.mismatchFields ?? {})) assert.deepEqual(got.mismatchFields[seq], f, `${label}: seq ${seq} names the field(s) that differ, by prefixed predicate name`);
    assert.deepEqual(got.missingNode, expected.missingNode ?? [], `${label}: missingNode bucket`);
    assert.deepEqual(got.missingEvent, expected.missingEvent ?? [], `${label}: missingEvent bucket`);
    assert.deepEqual(got.badIri, expected.badIri ?? [], `${label}: badIri bucket`);
    if (expected.duplicate) expected.duplicate(got.duplicate); else assert.deepEqual(got.duplicate, [], `${label}: duplicate bucket`);
    for (const s of survivors) {
      const m = await factsOf(node(s));
      assert.equal(one(m, COLUMN_AFTER, `${label}: seq ${s}`).value, EXPECT[s].column, `${label}: seq ${s} verified, so it WAS written`);
    }
    for (const s of held) noFacts(await factsOf(node(s)), `${label}: seq ${s}`);
    assert.equal(j.written, SERVED_SEQS.filter((s) => !held.includes(s) && !gone.includes(s)).length, `${label}: written counts only the served nodes that verified (A1)`);
    return j;
  }, { events });
}
test('#1762 S3 BF6a — a node whose prov:used is NOT its event\'s entity is refused as `mismatch`, listed, untouched; the others are written', T, async () => {
  await refusedCase('mismatch (used)', (upd) => upd(swap(3, `${PROV}used`, `<${ENT}uuid-zzz>`)), { mismatch: [3], mismatchFields: { 3: [LOCAL.used] } }, { survivors: CARD_SEQS.filter((s) => s !== 3), held: [3] });
});
test('#1762 S3 BF6b — a node whose scrum:op is NOT its event\'s op is refused as `mismatch`, listed, untouched; the others are written', T, async () => {
  await refusedCase('mismatch (op)', (upd) => upd(swap(2, `${RS}op`, '"delete"')), { mismatch: [2], mismatchFields: { 2: [LOCAL.op] } }, { survivors: CARD_SEQS.filter((s) => s !== 2), held: [2] });
});
test('#1762 S3 BF6c — a seq-node the log has NO event for is refused as `missingEvent`, listed by its N, untouched; the others are written', T, async () => {
  await refusedCase('missingEvent', (upd) => upd(planted(node(999))), { missingEvent: [999] }, { held: [999] });
});
test('#1762 S3 BF6d — an activity IRI that is not seq-<digits> is refused as `badIri`, listed by IRI, untouched; the others are written', T, async () => {
  await refusedCase('badIri', async (upd) => { await upd(planted(`${ACT}seq-abc`)); await upd(planted(`${ACT}seq-`)); },
    { badIri: [`${ACT}seq-`, `${ACT}seq-abc`] });
});

// BF6e..k: what a pair is validated AGAINST, and the pre-existing facts that must agree. A contradiction is a `mismatch`, listed and NEVER overwritten.
const mismatchCase = (name, seq, field, plant) => test(`#1762 S3 BF6${name}`, T, async () => {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    await plant(upd, { factsOf });
    const before = await factsOf(node(seq));
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `a contradicted node exits 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, name);
    const got = flat(j, name);
    assert.deepEqual({ ...got, mismatchFields: undefined }, { ...emptyBuckets, mismatch: [seq], mismatchFields: undefined }, `seq ${seq} is listed as mismatch, alone`);
    assert.deepEqual(got.mismatchFields[seq], [field], `and names the predicate that differs, by its prefixed name`);
    assert.deepEqual(await factsOf(node(seq)), before, `seq ${seq}: NOTHING about it changed — a contradiction is refused, never overwritten`);
    for (const s of CARD_SEQS.filter((x) => x !== seq)) assert.equal(one(await factsOf(node(s)), COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s} verified, so it WAS written`);
  });
});
mismatchCase('e — a node whose entityKind is not its event\'s kind is refused as mismatch, untouched', 4, LOCAL.entityKind, (upd) => upd(swap(4, `${RS}entityKind`, '"column"')));
mismatchCase('f — a node whose startedAtTime is not its event\'s time is refused as mismatch, untouched', 4, LOCAL.time, (upd) => upd(swap(4, `${PROV}startedAtTime`, '"2001-01-01T00:00:00.000Z"')));
mismatchCase('g — a node whose actor is not its event\'s actor is refused as mismatch, untouched', 4, LOCAL.actor, (upd) => upd(swap(4, `${PROV}wasAssociatedWith`, `<${PERSON}mallory>`)));
mismatchCase('h — a node whose shortId is not its event\'s shortId is refused as mismatch, untouched', 4, LOCAL.shortId, (upd) => upd(swap(4, SHORT, '"999"')));
mismatchCase('i — a node that ALREADY carries a column the log contradicts is refused as mismatch; the wrong value is not overwritten', 4, LOCAL.column,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${COLUMN_AFTER}> "not-the-logs-column" . }`));
mismatchCase('j — a node that ALREADY carries a holder the log contradicts is refused as mismatch; the wrong value is not overwritten', 4, LOCAL.holder,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${HOLDER}> <${PERSON}mallory> . }`));
mismatchCase('k — a node that ALREADY carries a logRecordedAt the log contradicts is refused as mismatch; the wrong value is not overwritten', 4, LOCAL.logAt,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${LOGAT}> "2001-01-01T00:00:00.000Z"^^<${XSD}dateTime> . }`));

test('#1762 S3 BF6o — a node whose logRecordedAt is the SAME INSTANT as the event\'s in another lexical form is current, not a mismatch', T, async () => {
  await world(async ({ cli, base, upd, report, factsOf }) => {
    await upd(`INSERT DATA { <${node(4)}> <${LOGAT}> "2026-10-20T11:04:00+01:00"^^<${XSD}dateTime> . }`);   // seq 4 was recorded 10:04Z
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `an equal instant is not a contradiction (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'same instant');
    assert.deepEqual(flat(j, 'same instant'), emptyBuckets, 'nothing is refused');
    assert.equal(one(await factsOf(node(4)), LOGAT, 'seq 4').value.length > 0, true, 'and it still carries exactly one logRecordedAt (not a second, not replaced)');
  });
});

mismatchCase('p — a REFUSAL node that already carries a logRecordedAt the log contradicts is refused as mismatch, untouched (a refusal is served history too)', 8, LOCAL.logAt,
  (upd) => upd(`INSERT DATA { <${node(8)}> <${LOGAT}> "2001-01-01T00:00:00.000Z"^^<${XSD}dateTime> . }`));
mismatchCase('q — a COLUMN node that already carries a logRecordedAt the log contradicts is refused as mismatch, untouched', 6, LOCAL.logAt,
  (upd) => upd(`INSERT DATA { <${node(6)}> <${LOGAT}> "2001-01-01T00:00:00.000Z"^^<${XSD}dateTime> . }`));
test('#1762 S3 BF6r — a startedAtTime that is the SAME INSTANT as the event\'s time in another lexical form is not a mismatch: times compare as instants, never as text', T, async () => {
  await world(async ({ cli, base, upd, report, factsOf }) => {
    await upd(swap(4, `${PROV}startedAtTime`, '"2026-10-20T10:59:00+01:00"'));   // seq 4 occurred at 09:59:00.000Z
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `an equal instant is not a contradiction (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.deepEqual(flat(report(r, 'same instant'), 'same instant'), emptyBuckets, 'nothing is refused');
    assert.equal(one(await factsOf(node(4)), COLUMN_AFTER, 'seq 4').value, EXPECT[4].column, 'and the node was completed like any other');
  });
});

test('#1762 S3 BF6l — an eligible log event whose seq-node is ABSENT is refused as `missingNode`, listed by its N: the direction a node-to-event pass alone cannot see', T, async () => {
  await refusedCase('missingNode', (upd) => upd(`DELETE WHERE { <${node(5)}> ?p ?o }`), { missingNode: [5] }, { survivors: CARD_SEQS.filter((s) => s !== 5), gone: [5] });
});

test('#1762 S3 BF6m — a seq that appears TWICE in the log is refused as `duplicate`, listed, its node untouched; the others are written', T, async () => {
  await refusedCase('duplicate (event)', (upd, { logDir }) => {
    fs.writeFileSync(path.join(logDir, 'events-2026-10-21.jsonl'), `${JSON.stringify(cardEv(4, 'update', 'uuid-a', 101, { column: 'cancelled', claimedBy: 'bob' }, 'bob'))}\n`);   // a second seq 4, written AFTER the projection
  }, {
    duplicate: (d) => {
      assert.ok(d.length >= 1, 'one duplicate entry');
      assert.ok(d.some((e) => e.seq === 4 || e.iri === node(4)), `it names seq 4 (got ${JSON.stringify(d)})`);
      assert.ok(d.every((e) => typeof e.what === 'string' && e.what), 'and says what is duplicated');
    },
  }, { survivors: CARD_SEQS.filter((s) => s !== 4), held: [4] });
});

test('#1762 S3 BF6n — a single-valued predicate holding TWO values on one node is refused as `duplicate`, listed, the node untouched', T, async () => {
  await refusedCase('duplicate (term)', (upd) => upd(`INSERT DATA { <${node(3)}> <${PROV}used> <${ENT}uuid-b2> . }`), {
    duplicate: (d) => {
      assert.ok(d.some((e) => e.seq === 3 || e.iri === node(3)), `it names seq 3 (got ${JSON.stringify(d)})`);
      assert.ok(d.every((e) => typeof e.what === 'string' && e.what), 'and says what is duplicated');
    },
  }, { survivors: CARD_SEQS.filter((s) => s !== 3), held: [3] });
});

// ── BF7 the typed exclusion ──
const runIri = () => `${ACT}run-${crypto.randomUUID()}`;
const runExtra = `; <${RS}performedUsing> <urn:ex:procedure/p1> ; <${PROV}generated> <urn:ex:artifact/a1>`;
test('#1762 S3 BF7a — a run-<uuid> activity carrying performedUsing AND generated is skippedNonSeq (an array of IRIs), not badIri, untouched, and it does not make the run exit 3', T, async () => {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    const runs = [runIri(), runIri(), runIri()];
    for (const r of runs) await upd(planted(r, { op: 'run', kind: 'run', extra: runExtra }));
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `run nodes are not refusals, so a clean run still exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'runs');
    assert.deepEqual(sorted(j.skippedNonSeq), sorted(runs), 'the three run nodes are listed by IRI, separately');
    assert.deepEqual(flat(j, 'runs'), emptyBuckets, 'and are not in any refused bucket');
    for (const iri of runs) noFacts(await factsOf(iri), iri);
  });
});
test('#1762 S3 BF7b — the same IRI WITHOUT performedUsing and generated is `badIri`: a malformed activity cannot hide in the exclusion', T, async () => {
  const bare = runIri();
  await refusedCase('run without its predicates', (upd) => upd(planted(bare, { op: 'run', kind: 'run' })), { badIri: [bare] }, { held: [] });
});
test('#1762 S3 BF7c — a seq-node that carries performedUsing is still a seq-node: processed and written, never skipped', T, async () => {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    await upd(`INSERT DATA { <${node(4)}> <${RS}performedUsing> <urn:ex:procedure/p1> . }`);
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'seq with performedUsing');
    assert.deepEqual(j.skippedNonSeq, [], 'it is not skipped');
    assert.equal(one(await factsOf(node(4)), COLUMN_AFTER, 'seq 4').value, EXPECT[4].column, 'and it was written like any other');
  });
});

// ── BF8 usage and preflight ──
for (const [label, args] of [
  ['no --log', (b) => b.filter((_, i, a) => a[i] !== '--log' && a[i - 1] !== '--log')],
  ['an unknown flag', (b) => [...b, '--no-such-flag']],
  ['a --log directory that is not there', (b) => b.map((v, i, a) => (a[i - 1] === '--log' ? path.join(os.tmpdir(), `bf1762-absent-${process.pid}`) : v))],
  ['a --dataset that is not the MARKER\'s (the wrong store must never be backfilled)', (b) => b.map((v, i, a) => (a[i - 1] === '--dataset' ? 'some-other-dataset' : v))],
]) {
  test(`#1762 S3 BF8 — ${label}: exit 2 and NOTHING written, even with --apply`, T, async () => {
    await world(async ({ cli, base, quads }) => {
      const before = await quads();
      const r = await cli([...args(base), '--apply']);
      assert.equal(r.status, 2, `usage or a preflight failure exits 2 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      assert.deepEqual(await quads(), before, 'and no graph moved');
    });
  });
}

// ── BF9 ──
test('#1762 S3 BF9 — the event log is READ, never written: its segments are byte-identical after --apply', T, async () => {
  await world(async ({ cli, base, logDir }) => {
    const before = evState(logDir);
    assert.equal((await cli([...base, '--apply'])).status, 0);
    assert.deepEqual(evState(logDir), before, 'no segment gained, lost or changed a byte');
  });
});

// ── BF10 ──
test('#1762 S3 BF10 — the dry run and --apply classify identically, and a dry run that found refusals still writes NOTHING', T, async () => {
  await world(async ({ cli, base, upd, report, quads }) => {
    await upd(planted(node(999)));
    await upd(planted(`${ACT}seq-abc`));
    await upd(swap(3, `${PROV}used`, `<${ENT}uuid-zzz>`));
    const before = await quads();
    const dry = await cli(base);
    assert.equal(dry.status, 3, 'a dry run that finds refusals exits 3 too: the exit code is the classification, not the write');
    assert.deepEqual(await quads(), before, 'and a dry run that found refusals still wrote NOTHING (zero writes, including on refused cases)');
    const applied = await cli([...base, '--apply']);
    assert.equal(applied.status, 3);
    const a = flat(report(dry, 'dry'), 'dry'), b = flat(report(applied, 'apply'), 'apply');
    assert.deepEqual(a, b, 'identical buckets');
    assert.deepEqual(b, { ...emptyBuckets, mismatch: [3], mismatchFields: { 3: [LOCAL.used] }, missingEvent: [999], badIri: [`${ACT}seq-abc`] });
  });
});

// ── BF11 exit 4, and BF12 the fence: a proxy in front of the executor that faults ONE update ──
/**
 * Counts the script's /update requests and, on the `nth`, either forwards it and then cuts the connection WITHOUT answering (`ack-lost`: the
 * executor applied it, the script cannot know), or cuts it before forwarding (`request-lost`: it never arrived). `beforeForward(bodyText)` runs
 * before the nth is forwarded (the fence rows change a node there). The script sends ONE guarded update per node (v2.2 pin 2, A6).
 */
async function lossyProxy(executorUrl, { mode = null, nth = 1, beforeForward = null, when = (b, n) => true } = {}) {
  const state = { updates: 0, forwarded: 0, bodies: [], queries: [] };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const isUpdate = req.method === 'POST' && req.url.startsWith('/update');
    let faulted = false;
    if (isUpdate) { state.updates++; state.bodies.push(body.toString('utf8')); faulted = state.updates === nth; }
    if (req.method === 'POST' && req.url.startsWith('/query')) state.queries.push(body.toString('utf8'));
    if (faulted && mode === 'request-lost') { req.socket.destroy(); return; }
    const refuseWith = /^refuse-(\d{3})$/.exec(mode || '');
    if (faulted && refuseWith) { res.writeHead(Number(refuseWith[1]), { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'refused by the test proxy', code: 'TEST_REFUSED' })); return; }   // never forwarded: proven not applied
    if (isUpdate && beforeForward && when(body.toString('utf8'), state.updates)) await beforeForward(body.toString('utf8'));
    const up = await fetch(`${executorUrl}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))), body: body.length ? body : undefined });
    const text = Buffer.from(await up.arrayBuffer());
    if (isUpdate) state.forwarded++;
    if (faulted && mode === 'ack-lost') { req.socket.destroy(); return; }
    if (faulted && mode === 'applied-then-500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'the proxy answered 500 AFTER the executor applied it' })); return; }
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' }); res.end(text);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); owned.servers.add(srv);
  return { url: `http://127.0.0.1:${srv.address().port}`, state, close: () => new Promise((r) => { srv.close(r); owned.servers.delete(srv); }) };
}
const servedWithLogAt = async (q) => (await q(`SELECT DISTINCT ?a WHERE { ?a <${LOGAT}> ?o . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`)).map((b) => Number(b.a.value.slice(ACT.length + 4))).sort((a, b) => a - b);
async function reconciled({ cli, base, report, factsOf }, expectedCurrent, label) {
  const again = await cli([...base, '--apply']);
  assert.equal(again.status, 0, `${label}: the re-run is the reconciliation and ends clean (got ${again.status}: ${(again.err || again.out).slice(-300)})`);
  const j2 = report(again, `${label} reconcile`);
  assert.equal(j2.written + j2.alreadyCurrent, SERVED_SEQS.length, `${label}: every planned node is accounted for, written now or already current`);
  assert.equal(j2.alreadyCurrent, expectedCurrent, `${label}: exactly the nodes that had landed are recognised as current, not written again`);
  for (const s of CARD_SEQS) {
    const m = await factsOf(node(s));
    for (const p of [COLUMN_AFTER, HOLDER, LOGAT]) one(m, p, `${label}: seq ${s} after the reconcile`);
    assert.equal(one(m, COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `${label}: seq ${s} correct`);
  }
  for (const s of [...REFUSAL_SEQS, ...COLUMN_SEQS]) one(await factsOf(node(s)), LOGAT, `${label}: seq ${s} after the reconcile`);
}
for (const mode of ['ack-lost', 'request-lost']) {
  test(`#1762 S3 BF11 (${mode}) — the FIRST write's ${mode === 'ack-lost' ? 'ACK is lost after the executor applied it' : 'request is cut before the executor saw it'}: exit 4 with exactly the node in flight in \`apply.uncertain\`, never exit 2, and the re-run reconciles with no fact written twice`, T, async () => {
    await world(async (w) => {
      const { cliVia, x, base, report, q } = w;
      const proxy = await lossyProxy(x.baseUrl, { mode, nth: 1 });
      try {
        const r = await cliVia(proxy.url, [...base, '--apply']);
        assert.ok(proxy.state.updates >= 1, 'PRECONDITION: the script sent an update through the proxy');
        assert.equal(r.status, 4, `a lost ACK on the first write is exit 4, not 2 and not 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
        const j = report(r, mode);
        assert.deepEqual(j.apply?.confirmed, [], 'nothing was ACKed, so nothing is confirmed');
        assert.ok(Array.isArray(j.apply?.uncertain) && j.apply.uncertain.length === 1, `exactly the ONE node in flight is uncertain (one update per node), never counted as zero (got ${JSON.stringify(j.apply)})`);
        assert.ok(SERVED_SEQS.includes(Number(j.apply.uncertain[0])), 'and it is a planned node');
        assert.equal(proxy.state.updates, 1, 'and the script STOPPED at the first uncertainty: nothing after it was attempted');
        assert.equal((await servedWithLogAt(q)).length, mode === 'ack-lost' ? 1 : 0, `the store holds ${mode === 'ack-lost' ? 'the one write the executor applied' : 'nothing: the request never arrived'}`);
      } finally { await proxy.close(); }
      await reconciled(w, mode === 'ack-lost' ? 1 : 0, mode);
    });
  });
  test(`#1762 S3 BF11d (${mode}) — a failure AFTER some writes landed (the 3rd node): \`confirmed\` is the nodes before it, \`uncertain\` the one in flight, the rest are unattempted, exit 4; the re-run finishes the job`, T, async () => {
    await world(async (w) => {
      const { cliVia, x, base, report, q } = w;
      const proxy = await lossyProxy(x.baseUrl, { mode, nth: 3 });
      try {
        const r = await cliVia(proxy.url, [...base, '--apply']);
        assert.equal(r.status, 4, `a transport failure after some writes is exit 4 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
        const j = report(r, mode);
        const conf = (j.apply?.confirmed ?? []).map(Number), unc = (j.apply?.uncertain ?? []).map(Number);
        assert.equal(conf.length, 2, `the two nodes written and ACKed before the failure are confirmed (got ${JSON.stringify(j.apply)})`);
        assert.equal(unc.length, 1, 'and exactly the one in flight is uncertain');
        assert.ok(!conf.includes(unc[0]), 'a node is never both');
        assert.equal(proxy.state.updates, 3, 'the script stopped at the failure: the other nodes were never attempted');
        assert.equal((await servedWithLogAt(q)).length, mode === 'ack-lost' ? 3 : 2, `the store holds the two confirmed${mode === 'ack-lost' ? ' and the one the executor applied before its ACK was lost' : ''}, and none of the rest`);
        for (const n of conf) assert.ok((await servedWithLogAt(q)).includes(n), `confirmed node ${n} really is in the store`);
      } finally { await proxy.close(); }
      await reconciled(w, mode === 'ack-lost' ? 3 : 2, `${mode} @3`);
    });
  });
}
test('#1762 S3 BF11c — uncertainty WINS over refusal: a lost ACK with a bad IRI planted is exit 4, and the refused bucket is still reported', T, async () => {
  await world(async ({ cliVia, x, base, report, upd }) => {
    await upd(planted(`${ACT}seq-abc`));
    const proxy = await lossyProxy(x.baseUrl, { mode: 'ack-lost', nth: 1 });
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 4, `exit 4 beats exit 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      assert.deepEqual(report(r, 'precedence').refused.badIri, [`${ACT}seq-abc`], 'and the refusal is still reported');
    } finally { await proxy.close(); }
  });
});

// ── BF12 the apply-time fence ──
test('#1762 S3 BF12 — a fact that appears on a node BETWEEN plan and write fences that node: its guarded update changes nothing, it is refused as `mismatch` naming the field, never overwritten and never retried blind; the others are written', T, async () => {
  await world(async ({ cliVia, x, base, report, upd, factsOf }) => {
    const proxy = await lossyProxy(x.baseUrl, {
      beforeForward: () => upd(`INSERT DATA { <${node(4)}> <${COLUMN_AFTER}> "written-by-someone-else" . }`),   // after the plan, just before node 4's update is applied
      when: (body) => body.includes(node(4)),
    });
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 3, `a fenced node is a refusal, exit 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      const j = report(r, 'fence');
      const got = flat(j, 'fence');
      assert.deepEqual(got.mismatch, [4], 'node 4 is listed as mismatch');
      assert.ok(got.mismatchFields[4].includes(LOCAL.column), `naming the fact that changed under it (got ${JSON.stringify(got.mismatchFields[4])})`);
      const m = await factsOf(node(4));
      assert.deepEqual((m[COLUMN_AFTER] || []).map((t) => t.value), ['written-by-someone-else'], 'the value that appeared is NOT overwritten');
      assert.equal(m[HOLDER], undefined, 'and the guarded update was all-or-nothing: none of the node\'s other facts were written either');
      assert.equal(m[LOGAT], undefined);
      assert.equal(proxy.state.updates, SERVED_SEQS.length, 'it was never retried blind: one update per node, once each');
      for (const s of CARD_SEQS.filter((n) => n !== 4)) assert.equal(one(await factsOf(node(s)), COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s}: the other nodes were written`);
      assert.ok(!(j.apply?.confirmed ?? []).map(Number).includes(4), 'and node 4 is not confirmed');
    } finally { await proxy.close(); }
  });
});

// ── BF12b the fence covers every identity term preflight validated, not only a newly appearing destination fact ──
const FENCE_TERMS = [
  ['prov:used is replaced', LOCAL.used, `${PROV}used`, (iri) => `DELETE { <${iri}> <${PROV}used> ?o } INSERT { <${iri}> <${PROV}used> <${ENT}someone-elses-card> } WHERE { <${iri}> <${PROV}used> ?o }`],
  ['scrum:op is replaced', LOCAL.op, `${RS}op`, (iri) => `DELETE { <${iri}> <${RS}op> ?o } INSERT { <${iri}> <${RS}op> "delete" } WHERE { <${iri}> <${RS}op> ?o }`],
  ['scrum:entityKind is replaced', LOCAL.entityKind, `${RS}entityKind`, (iri) => `DELETE { <${iri}> <${RS}entityKind> ?o } INSERT { <${iri}> <${RS}entityKind> "column" } WHERE { <${iri}> <${RS}entityKind> ?o }`],
  ['prov:startedAtTime is replaced', LOCAL.time, `${PROV}startedAtTime`, (iri) => `DELETE { <${iri}> <${PROV}startedAtTime> ?o } INSERT { <${iri}> <${PROV}startedAtTime> "2001-01-01T00:00:00.000Z" } WHERE { <${iri}> <${PROV}startedAtTime> ?o }`],
  ['prov:wasAssociatedWith is replaced', LOCAL.actor, `${PROV}wasAssociatedWith`, (iri) => `DELETE { <${iri}> <${PROV}wasAssociatedWith> ?o } INSERT { <${iri}> <${PROV}wasAssociatedWith> <${PERSON}mallory> } WHERE { <${iri}> <${PROV}wasAssociatedWith> ?o }`],
  ['scrum:shortId is replaced', LOCAL.shortId, `${RS}shortId`, (iri) => `DELETE { <${iri}> <${RS}shortId> ?o } INSERT { <${iri}> <${RS}shortId> "999" } WHERE { <${iri}> <${RS}shortId> ?o }`],
  ['a SECOND value is added to prov:used (nothing may be added to a term preflight validated)', LOCAL.used, `${PROV}used`, (iri) => `INSERT DATA { <${iri}> <${PROV}used> <${ENT}an-extra-entity> . }`],
];
for (const [label, field, predicate, change] of FENCE_TERMS) {
  test(`#1762 S3 BF12b — the fence covers identity terms: ${label} between plan and write ⇒ refused as mismatch naming ${field}, never written through, never retried`, T, async () => {
    await world(async ({ cliVia, x, base, report, upd, factsOf }) => {
      const proxy = await lossyProxy(x.baseUrl, { beforeForward: () => upd(change(node(4))), when: (body) => body.includes(node(4)) });
      let after = null;
      try {
        const r = await cliVia(proxy.url, [...base, '--apply']);
        assert.equal(r.status, 3, `a node whose identity changed under it is a refusal, exit 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
        const got = flat(report(r, 'identity fence'), 'identity fence');
        assert.deepEqual(got.mismatch, [4], 'node 4 is listed as mismatch');
        assert.ok(got.mismatchFields[4].includes(field), `naming the term that changed (${field}); got ${JSON.stringify(got.mismatchFields[4])}`);
        after = await factsOf(node(4));
      } finally { await proxy.close(); }
      assert.equal(after[COLUMN_AFTER], undefined, 'the guarded update changed NOTHING: no column was written onto a node whose identity moved');
      assert.equal(after[HOLDER], undefined, '(nor a holder)');
      assert.equal(after[LOGAT], undefined, '(nor a logRecordedAt)');
      assert.equal(proxy.state.updates, SERVED_SEQS.length, 'and it was not retried blind');
      for (const s of CARD_SEQS.filter((n) => n !== 4)) assert.equal(one(await factsOf(node(s)), COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s}: the other nodes were written`);
    });
  });
}
test('#1762 S3 BF12b — a SECOND scrum:shortId value of another datatype added between plan and write fences the node: nothing is added to it, it is refused as mismatch, never retried', T, async () => {
  await world(async ({ cliVia, x, base, report, upd, factsOf }) => {
    const sid = EVENTS.find((e) => e.seq === 4).entity.shortId;
    const proxy = await lossyProxy(x.baseUrl, { beforeForward: () => upd(`INSERT DATA { <${node(4)}> <${SHORT}> "${sid}"^^<${XSD}integer> . }`), when: (body) => body.includes(node(4)) });
    let after = null;
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 3, `a node that gained a second identity term is a refusal, exit 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      const got = flat(report(r, 'second shortId'), 'second shortId');
      assert.deepEqual(got.mismatch, [4], 'node 4 is listed as mismatch');
      assert.ok(got.mismatchFields[4].includes(LOCAL.shortId), `naming the term that gained a value (${LOCAL.shortId}); got ${JSON.stringify(got.mismatchFields[4])}`);
      after = await factsOf(node(4));
      assert.equal(proxy.state.updates, SERVED_SEQS.length, 'and it was not retried blind');
    } finally { await proxy.close(); }
    assert.equal((after[SHORT] || []).length, 2, 'PRECONDITION: the second term really is a second term (the same lexical value in another datatype), and it was not removed');
    assert.equal(after[COLUMN_AFTER], undefined, 'the guarded update changed NOTHING: no column');
    assert.equal(after[HOLDER], undefined, '(nor a holder)');
    assert.equal(after[LOGAT], undefined, '(nor a logRecordedAt)');
  });
});
test('#1762 S3 BF12b — a term preflight saw ABSENT (an event with no actor has no prov:wasAssociatedWith) and then newly present fences the node, never written through', T, async () => {
  const noActor = EVENTS.map((e) => (e.seq === 4 ? { ...e, actor: null } : e));       // the projector omits wasAssociatedWith for an event with no actor: preflight legitimately sees none
  await world(async ({ cliVia, x, base, report, upd, factsOf }) => {
    assert.equal((await factsOf(node(4)))[`${PROV}wasAssociatedWith`], undefined, 'PRECONDITION: the projected node has no actor term');
    const proxy = await lossyProxy(x.baseUrl, { beforeForward: () => upd(`INSERT DATA { <${node(4)}> <${PROV}wasAssociatedWith> <${PERSON}mallory> . }`), when: (body) => body.includes(node(4)) });
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 3, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      const got = flat(report(r, 'newly present'), 'newly present');
      assert.deepEqual(got.mismatch, [4]);
      assert.ok(got.mismatchFields[4].includes(LOCAL.actor), `naming prov:wasAssociatedWith (got ${JSON.stringify(got.mismatchFields[4])})`);
      const m = await factsOf(node(4));
      assert.deepEqual((m[`${PROV}wasAssociatedWith`] || []).map((t) => t.value), [`${PERSON}mallory`], 'the value that appeared is not overwritten, and no second one was added');
      assert.equal(m[COLUMN_AFTER], undefined, 'and nothing else was written onto the node');
      assert.equal(m[LOGAT], undefined);
    } finally { await proxy.close(); }
  }, { events: noActor });
});

// ── BF13 the store identity changes DURING apply (isolated throwaway store only; the proxy changes the marker itself and verifies it did) ──
const MARKER_CHANGES = [
  ['dataset', 'urn:ex:datasetId', () => '"other-dataset"'],
  ['epoch', 'urn:ex:epoch', (cur) => `"${Number(cur) + 7}"^^<${XSD}integer>`],
  ['incarnation', 'urn:ex:incarnation', () => '"11111111-2222-3333-4444-555555555555"'],
];
for (const [field, pred, newLit] of MARKER_CHANGES) {
  for (const nth of [1, 3]) {
    test(`#1762 S3 BF13 — the ${field} changes ${nth === 1 ? 'at the FIRST update' : 'after TWO confirmed nodes'}: the whole run stops, exit 4, apply.stopped STORE_IDENTITY_CHANGED naming ${field}, the fenced node untouched, no later update, a restart is a NEW explicit plan`, T, async () => {
      await world(async ({ cliVia, cli, x, base, report, q, factsOf, health }) => {
        const markerOf = async () => Object.fromEntries((await q(`SELECT ?p ?o WHERE { GRAPH <${BK}> { <urn:ex:dataset> ?p ?o } }`)).map((b) => [b.p.value, b.o.value]));
        const before = await markerOf();
        let proven = null;
        const proxy = await lossyProxy(x.baseUrl, {
          when: (body, n) => n === nth,
          beforeForward: async (body) => {
            const cur = (await (await fetch(`${x.baseUrl}/health`)).json()).epoch;
            const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'content-type': 'application/sparql-update', 'x-op-id': `urn:ex:op/test/bf1762-marker/${crypto.randomUUID()}`, 'x-epoch': String(cur), [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
              body: `DELETE { GRAPH <${BK}> { <urn:ex:dataset> <${pred}> ?o } } INSERT { GRAPH <${BK}> { <urn:ex:dataset> <${pred}> ${newLit(cur)} } } WHERE { GRAPH <${BK}> { <urn:ex:dataset> <${pred}> ?o } }` });
            assert.equal(r.status, 200, `PRECONDITION: the proxy changed the marker (${r.status} ${(await r.text()).slice(0, 160)})`);
            const after = await markerOf();
            assert.notEqual(after[pred], before[pred], `PRECONDITION (independent check): the marker's ${field} really differs now (${before[pred]} -> ${after[pred]})`);
            proven = { before: before[pred], after: after[pred] };
          },
        });
        let touched = null;
        try {
          const r = await cliVia(proxy.url, [...base, '--apply']);
          assert.ok(proven, 'PRECONDITION: the marker was changed before the update was forwarded');
          assert.equal(r.status, 4, `an identity change during apply is exit 4 (interrupted apply), not 3 and not 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
          const j = report(r, `${field}@${nth}`);
          assert.equal(j.apply?.stopped?.code, 'STORE_IDENTITY_CHANGED', `apply.stopped names the code (got ${JSON.stringify(j.apply)})`);
          assert.deepEqual(j.apply?.stopped?.fields, [field], `and the field that changed, and only it`);
          assert.equal(j.apply.confirmed.length, nth - 1, `confirmed keeps exactly the nodes confirmed against the ORIGINAL plan (${nth - 1})`);
          assert.deepEqual(j.apply.uncertain, [], 'uncertain is empty: the guarded update is PROVEN not to have applied, so no uncertain node is manufactured');
          assert.deepEqual(flat(j, 'stopped'), emptyBuckets, 'and the store change is NOT reported as a per-node mismatch');
          assert.equal(proxy.state.updates, nth, `the run stopped at the fenced update: nothing after it was dispatched (${proxy.state.updates} updates)`);
          assert.equal((await servedWithLogAt(q)).length, nth - 1, `the store holds exactly the ${nth - 1} confirmed node(s) and nothing for the fenced one`);
          touched = await servedWithLogAt(q);
          for (const n of j.apply.confirmed) assert.ok(touched.includes(Number(n)), `confirmed node ${n} really is in the store`);
        } finally { await proxy.close(); }
        // a restart is a NEW explicit plan against whatever the store is now: it names the store as it is, and finishes what is left
        const m = await markerOf();
        const restart = await cliVia(x.baseUrl, ['--executor', '@EXECUTOR', '--dataset', m['urn:ex:datasetId'], '--log', base[base.indexOf('--log') + 1], '--apply']);
        assert.equal(restart.status, 0, `a NEW run that names the store as it now is completes (got ${restart.status}: ${(restart.err || restart.out).slice(-300)})`);
        const j2 = report(restart, 'restart');
        assert.equal(j2.written + j2.alreadyCurrent, SERVED_SEQS.length, 'and accounts for every node: written now or already current');
        assert.equal(j2.alreadyCurrent, nth - 1, `the ${nth - 1} node(s) confirmed before the change are recognised as current, not written twice`);
        assert.equal((await servedWithLogAt(q)).length, SERVED_SEQS.length, 'every served node ends with its logRecordedAt, once');
      });
    });
  }
}

// ── BF14 UPDATE_REFUSED ──
for (const [status, nth] of [[409, 1], [409, 3], [403, 1], [403, 3]]) {
  test(`#1762 S3 BF14a — a COMPLETE ${status} refusal on a stable store, proven not applied (${nth === 1 ? 'the first update' : 'after two confirmed nodes'}): exit 4, apply.stopped UPDATE_REFUSED with its status, later writes stopped, confirmed kept, uncertain EMPTY`, T, async () => {
    await world(async ({ cliVia, x, base, report, q, factsOf }) => {
      const proxy = await lossyProxy(x.baseUrl, { mode: `refuse-${status}`, nth });
      try {
        const r = await cliVia(proxy.url, [...base, '--apply']);
        assert.equal(r.status, 4, `an interrupted apply is exit 4 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
        const j = report(r, 'update refused');
        assert.equal(j.apply?.stopped?.code, 'UPDATE_REFUSED', `apply.stopped names the code (got ${JSON.stringify(j.apply)})`);
        assert.equal(j.apply.stopped.status, status, 'and the status the executor answered (not a constant)');
        assert.equal(j.apply.confirmed.length, nth - 1, 'confirmed keeps exactly the nodes confirmed before it');
        assert.deepEqual(j.apply.uncertain, [], 'uncertain is EMPTY: the store is stable and the update is proven not applied');
        assert.equal(proxy.state.updates, nth, 'nothing after the refused update was dispatched');
        assert.deepEqual(flat(j, 'refused'), emptyBuckets, 'and it is not a per-node mismatch');
        assert.equal((await servedWithLogAt(q)).length, nth - 1, 'the store holds only the confirmed nodes');
      } finally { await proxy.close(); }
    });
  });
}
test('#1762 S3 BF14b — a non-200 ALONE is not proof: an update the executor APPLIED and then answered 500 is never reported proven-not-applied; its node is confirmed or uncertain, never absent', T, async () => {
  await world(async ({ cliVia, x, base, report, q }) => {
    const proxy = await lossyProxy(x.baseUrl, { mode: 'applied-then-500', nth: 2 });
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 4, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      const j = report(r, 'applied then 500');
      const inStore = await servedWithLogAt(q);
      const accounted = new Set([...(j.apply?.confirmed ?? []), ...(j.apply?.uncertain ?? [])].map(Number));
      for (const n of inStore) assert.ok(accounted.has(n), `node ${n} IS in the store, so it must be confirmed or uncertain, not silently absent from the report (got ${JSON.stringify(j.apply)})`);
      assert.equal(proxy.state.updates, 2, 'and the run stopped there');
    } finally { await proxy.close(); }
  });
});

// ── BF15 the fence covers pre-existing validated facts ──
const EXISTING = [
  ['columnAfter', LOCAL.column, `<${node(4)}> <${COLUMN_AFTER}> "done" .`, `DELETE { <${node(4)}> <${COLUMN_AFTER}> ?o } INSERT { <${node(4)}> <${COLUMN_AFTER}> "changed-under-it" } WHERE { <${node(4)}> <${COLUMN_AFTER}> ?o }`, [HOLDER, LOGAT]],
  ['holderAtWrite', LOCAL.holder, `<${node(4)}> <${HOLDER}> <${PERSON}ada> .`, `DELETE { <${node(4)}> <${HOLDER}> ?o } INSERT { <${node(4)}> <${HOLDER}> <${PERSON}mallory> } WHERE { <${node(4)}> <${HOLDER}> ?o }`, [COLUMN_AFTER, LOGAT]],
  ['logRecordedAt', LOCAL.logAt, `<${node(4)}> <${LOGAT}> "${recordedAtOf(4)}"^^<${XSD}dateTime> .`, `DELETE { <${node(4)}> <${LOGAT}> ?o } INSERT { <${node(4)}> <${LOGAT}> "2001-01-01T00:00:00.000Z"^^<${XSD}dateTime> } WHERE { <${node(4)}> <${LOGAT}> ?o }`, [COLUMN_AFTER, HOLDER]],
];
for (const [label, field, plant, change, missing] of EXISTING) {
  test(`#1762 S3 BF15 — a node that ALREADY has the right ${label} and needs the others: if that existing fact changes between plan and write, NOTHING is added to the node and it is refused naming ${field}`, T, async () => {
    await world(async ({ cliVia, x, base, report, upd, factsOf }) => {
      await upd(`INSERT DATA { ${plant} }`);
      const proxy = await lossyProxy(x.baseUrl, { beforeForward: () => upd(change), when: (body) => body.includes(node(4)) });
      let m = null;
      try {
        const r = await cliVia(proxy.url, [...base, '--apply']);
        assert.equal(r.status, 3, `a node whose existing fact changed is a refusal, exit 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
        const got = flat(report(r, 'existing fact'), 'existing fact');
        assert.deepEqual(got.mismatch, [4], 'node 4 is listed');
        assert.ok(got.mismatchFields[4].includes(field), `naming the existing fact that changed (${field}); got ${JSON.stringify(got.mismatchFields[4])}`);
        m = await factsOf(node(4));
      } finally { await proxy.close(); }
      for (const p of missing) assert.equal(m[p], undefined, `all-or-nothing: the fact ${p.replace(RS, 'scrum:')} that the plan would have ADDED is not on the node (the refused pair is untouched)`);
    });
  });
}

// ── BF16 term KIND, not text ──
const lit = (v) => JSON.stringify(v);
mismatchCase('s — (BF16, term kind) prov:used as a PLAIN LITERAL with the IRI\'s text (an event names an IRI, not a string that looks like one) is refused as mismatch, untouched', 4, LOCAL.used,
  (upd) => upd(swap(4, `${PROV}used`, lit(`${ENT}uuid-a`))));
mismatchCase('t — (BF16, term kind) prov:wasAssociatedWith as a plain literal with the IRI\'s text is refused as mismatch, untouched', 4, LOCAL.actor,
  (upd) => upd(swap(4, `${PROV}wasAssociatedWith`, lit(`${PERSON}ada`))));
mismatchCase('u — (BF16, term kind) an existing holderAtWrite that is a literal with the right IRI text (not an IRI) is refused as mismatch, untouched', 4, LOCAL.holder,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${HOLDER}> ${lit(`${PERSON}ada`)} . }`));
mismatchCase('v — (BF16, term kind) an existing logRecordedAt that is an xsd:string (not an xsd:dateTime) with the right instant is refused as mismatch, untouched', 4, LOCAL.logAt,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${LOGAT}> ${lit(recordedAtOf(4))} . }`));

// ── BF17 full precision ──
mismatchCase('w — (BF17, precision) a logRecordedAt that differs from the event\'s by ONE MICROSECOND is refused as mismatch (the executor keeps the microsecond literal; a millisecond compare would miss it)', 4, LOCAL.logAt,
  async (upd, { factsOf }) => {
    await upd(`INSERT DATA { <${node(4)}> <${LOGAT}> "2026-10-20T10:04:00.000001Z"^^<${XSD}dateTime> . }`);
    assert.match((await factsOf(node(4)))[LOGAT][0].value, /00\.000001Z$/, 'PRECONDITION (independent check): the store really keeps the microsecond, so the two instants differ');
  });
mismatchCase('x — (BF17, precision) a startedAtTime that differs from the event\'s time by ONE MICROSECOND is refused as mismatch', 4, LOCAL.time,
  (upd) => upd(swap(4, `${PROV}startedAtTime`, '"2026-10-20T09:59:00.000001Z"')));

// ── BF18 a noncanonical alias ──
test('#1762 S3 BF18 — a NONCANONICAL alias (activity/seq-04 beside seq-4) is reported by its IRI, never collapsed into the canonical node, and the canonical node is still completed', T, async () => {
  await world(async ({ cli, base, upd, q, factsOf, report }) => {
    const alias = `${ACT}seq-04`;
    await upd(`INSERT { <${alias}> ?p ?o } WHERE { <${node(4)}> ?p ?o }`);
    const subjects = Number((await q(`SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`))[0].n.value);
    assert.equal(subjects, EVENTS.length + 1, 'PRECONDITION: the alias is a separate node beside the canonical one');
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `an alias is a refusal: coverage is not bijective (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'alias');
    // PINNED (the contract author): scanned.nodes counts canonical seq-nodes only; every other IRI under the activity namespace is in exactly one of badIri / skippedNonSeq.
    assert.equal(j.scanned.nodes, subjects - 1, `scanned.nodes is the canonical seq-nodes only (${subjects - 1}); the alias is never counted, and the two IRIs are never collapsed (got ${j.scanned.nodes})`);
    assert.ok(j.refused.badIri.includes(alias), `the alias is named by its IRI in badIri (got ${JSON.stringify(j.refused)})`);
    const allActivity = Number((await q(`SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}")) }`))[0].n.value);
    assert.equal(j.scanned.nodes + j.refused.badIri.length + j.skippedNonSeq.length, allActivity, `scanned.nodes + |badIri| + |skippedNonSeq| accounts for every activity subject (${allActivity})`);
    const canonical = await factsOf(node(4));
    for (const p of [COLUMN_AFTER, HOLDER, LOGAT]) one(canonical, p, 'the CANONICAL seq 4');
    for (const p of [COLUMN_AFTER, HOLDER, LOGAT]) assert.equal((await factsOf(alias))[p], undefined, `the alias gets no ${p.replace(RS, 'scrum:')}`);
  });
});

// ── BF19 the readback does not scale with the node count ──
async function wholePopulationScans(events) {
  let count = 0, written = 0;
  await world(async ({ cliVia, x, base, report }) => {
    const proxy = await lossyProxy(x.baseUrl, {});
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 0, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      written = report(r, 'scale').written;
      // a bounded readback names its node (activity/seq-<N>); a whole-population enumeration names only the namespace
      count = proxy.state.queries.filter((qq) => qq.includes(`${ACT}`) && !/activity\/seq-\d+/.test(qq)).length;
    } finally { await proxy.close(); }
  }, { events });
  return { count, written };
}
test('#1762 S3 BF19 — the readback does NOT scale with the node count: the apply makes exactly ONE whole-population activity enumeration (the preflight), for the 15-event world and a larger one', T, async () => {
  const extra = Array.from({ length: 12 }, (_, i) => cardEv(16 + i, 'update', `uuid-x${i}`, 200 + i, { column: 'backlog', claimedBy: null, title: `extra ${i}` }));
  const small = await wholePopulationScans(EVENTS);
  const large = await wholePopulationScans([...EVENTS, ...extra]);
  assert.ok(large.written > small.written, `PRECONDITION: the larger world writes more nodes (${large.written} vs ${small.written})`);
  assert.ok(small.count >= 1, `PRECONDITION: the proxy counts the census enumeration it can see (${small.count})`);
  assert.equal(small.count, 1, `exactly ONE whole-population enumeration per run, the preflight, in the small world (got ${small.count} for ${small.written} written nodes)`);
  assert.equal(large.count, 1, `and exactly one in the larger world (got ${large.count} for ${large.written} written nodes): a per-node readback that rescans every activity is quadratic over ~89k nodes, and a constant 2 or 5 is a count nobody designed`);
});
