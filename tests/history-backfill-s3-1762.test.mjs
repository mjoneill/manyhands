/**
 * #1762 S3 — the facts-only BACKFILL (`scripts/history-backfill-1762.mjs`), black-box, rows first.
 *
 * ROW AUTHOR's rows for the builder's script, written to the "S3 CONTRACT v2" and its v2.1 corrections on #1762 (section 4, and the four
 * v2.1 points) before the script exists. Every row is a REAL executor, the REAL projector (`scripts/activity-projector.mjs --once`) over a
 * hand-built log, and the script as a child process. Nothing here imports the builder's code.
 *
 *   BF-P  the script exists                        (until it does, every row says so, not "exit 1")
 *   BF0   CONTROL: the projected nodes carry NO column, holder or logRecordedAt — the gap the backfill closes
 *   BF1   dry run (the default) writes NOTHING, to any graph, `written` stays 0, `wouldWrite` is what --apply will do, and the report
 *         echoes the dataset, epoch and incarnation it read from the MARKER
 *   BF2   --apply: every non-refused CARD node gets the four facts, judged per node against the log, not by count:
 *           columnAfter = the event's column · holderAtWrite = the holder BEFORE the write (replaying only SUCCESSFUL state-bearing
 *           events) · shortId where missing · logRecordedAt = the event's recorded_at (xsd:dateTime), not occurred_at
 *         columns, conversations and refusals get none of them
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
 *   BF11  exit 4: a lost ACK on the FIRST write is exit 4 with `apply.uncertain`, never exit 2 and never "0 written"; uncertainty wins
 *         over the refusal buckets, which are still reported; and the re-run reconciles (insert-where-absent: no fact twice)
 *
 * ── NOT YET PINNED, so not written (each is a line in the contract away) ───────────────────────────────────────────────────────
 *   · apply-time fencing (a node changed, or a store restored, between plan and write): there is no seam to change a node at that instant
 *   · a failure AFTER some writes landed (needs the script's batch size, which the contract does not give)
 *   · what `mismatch[].fields` names (these rows assert it is a non-empty list of strings, one per planted contradiction)
 *   · whether a refused CARD node gets logRecordedAt (v2.1 says "card seq-nodes"; a refusal is a card-kind node): not asserted either way
 *
 * ── Assumptions, each one line to correct ─────────────────────────────────────────────────────────────────────────────────────
 *   A1  `written`, `alreadyCurrent`, `wouldWrite` count NODES; `scanned` is {events, nodes} (contract v2: confirmed).
 *   A2  encodings are the native S1 nodes': holder = IRI person/<encodeURIComponent seat> or scrum:none; backfill-only scrum:unknown.
 *   A3  `apply.confirmed` lists the N of every node that was written or verified already current.
 *   A4  the report echoes the marker as {dataset, epoch, incarnation}; epoch compared as text, incarnation without dashes.
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
const NON_CARD_SEQS = [6, 7];          // a column and a conversation: scanned for coverage, never written
const REFUSAL_SEQS = [8, 14];          // card-kind refusals: no column, no holder
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
  for (const m of j.refused.mismatch) {
    assert.ok(Number.isInteger(m.seq), `${label}: a mismatch entry names its seq (got ${JSON.stringify(m)})`);
    assert.ok(Array.isArray(m.fields) && m.fields.length >= 1 && m.fields.every((f) => typeof f === 'string' && f), `${label}: and the fields that differ (got ${JSON.stringify(m)})`);
  }
  return { mismatch: j.refused.mismatch.map((m) => m.seq).sort((a, b) => a - b), missingNode: [...j.refused.missingNode].sort((a, b) => a - b), missingEvent: [...j.refused.missingEvent].sort((a, b) => a - b), duplicate: j.refused.duplicate, badIri: sorted(j.refused.badIri) };
}
const emptyBuckets = { mismatch: [], missingNode: [], missingEvent: [], duplicate: [], badIri: [] };
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
    assert.equal(j.wouldWrite, CARD_SEQS.length, 'and `wouldWrite` is the nodes --apply would write (A1)');
    assert.equal(j.dataset, DATASET, 'it echoes the dataset it read from the marker');
    assert.equal(String(j.epoch), String(health.epoch), 'and the epoch');
    assert.equal(String(j.incarnation).replace(/-/g, '').toLowerCase(), String(health.incarnation).replace(/-/g, '').toLowerCase(), 'and the incarnation');
    assert.deepEqual(await quads(), before, 'every graph is byte-identical after the dry run');
  });
});

// ── BF2 ──
test('#1762 S3 BF2 — --apply: every non-refused CARD node carries its four facts, per node against the log; columns, conversations and refusals get none of them', T, async () => {
  await world(async ({ cli, base, report, factsOf, q }) => {
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `a clean --apply exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, '--apply');
    assert.equal(j.dryRun, false, 'the report says it applied');
    const total = Number((await q(`SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`))[0].n.value);
    assert.deepEqual(j.scanned, { events: EVENTS.length, nodes: total }, 'scanned counts both directions: the log\'s eligible events and the graph\'s seq-nodes (A1)');
    assert.equal(j.written, CARD_SEQS.length, `written = the card nodes it completed (A1), ${CARD_SEQS.length} of the log's ${EVENTS.length} events — judged against the log, per node, below`);
    assert.equal(j.alreadyCurrent, 0, 'nothing was current before the first run');
    assert.deepEqual(flat(j, '--apply'), emptyBuckets, 'nothing is refused when every node verifies');
    assert.deepEqual(j.skippedNonSeq, [], 'and nothing was skipped');
    assert.deepEqual(sorted((j.apply?.confirmed ?? []).map(Number)), sorted(CARD_SEQS.map(Number)), 'every written node is ACK-confirmed (A3)');
    assert.deepEqual(j.apply?.uncertain, [], 'and none is uncertain');
    for (const s of CARD_SEQS) {
      const m = await factsOf(node(s));
      assert.equal(one(m, COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s}: column equals the log's state.column`);
      assert.equal(one(m, HOLDER, `seq ${s}`).value, EXPECT[s].holder, `seq ${s}: holder is the holder BEFORE the write — ${EXPECT[s].why} (A2)`);
      const at = one(m, LOGAT, `seq ${s}`);
      assert.equal(Date.parse(at.value), Date.parse(recordedAtOf(s)), `seq ${s}: logRecordedAt is the event's recorded_at, as an INSTANT (the store canonicalizes an xsd:dateTime's text, so '...:00.000Z' reads back as '...:00Z'); not occurred_at`);
      assert.equal(at.datatype, `${XSD}dateTime`, `seq ${s}: and an xsd:dateTime`);
    }
    for (const s of NON_CARD_SEQS) noFacts(await factsOf(node(s)), `seq ${s} (not card history: scanned, never written)`);
    for (const s of REFUSAL_SEQS) noFacts(await factsOf(node(s)), `seq ${s} (a refusal)`, [COLUMN_AFTER, HOLDER]);
  });
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
    assert.ok(dflt.length >= CARD_SEQS.length * 3, 'PRECONDITION: it did write (a vacuous "added nothing" would pass the checks above)');
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
    assert.equal(j.alreadyCurrent, CARD_SEQS.length, `and counts the ${CARD_SEQS.length} nodes that are already current (A1)`);
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

// ── BF6 the refused buckets ──
async function refusedCase(label, plant, expected, { survivors = CARD_SEQS, held = [], events } = {}) {
  await world(async ({ cli, base, upd, factsOf, report, logDir }) => {
    await plant(upd, { logDir });
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `${label}: some refused → exit 3, the rest written (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, label);
    const got = flat(j, label);
    assert.deepEqual(got.mismatch, expected.mismatch ?? [], `${label}: mismatch bucket`);
    assert.deepEqual(got.missingNode, expected.missingNode ?? [], `${label}: missingNode bucket`);
    assert.deepEqual(got.missingEvent, expected.missingEvent ?? [], `${label}: missingEvent bucket`);
    assert.deepEqual(got.badIri, expected.badIri ?? [], `${label}: badIri bucket`);
    if (expected.duplicate) expected.duplicate(got.duplicate); else assert.deepEqual(got.duplicate, [], `${label}: duplicate bucket`);
    for (const s of survivors) {
      const m = await factsOf(node(s));
      assert.equal(one(m, COLUMN_AFTER, `${label}: seq ${s}`).value, EXPECT[s].column, `${label}: seq ${s} verified, so it WAS written`);
    }
    for (const s of held) noFacts(await factsOf(node(s)), `${label}: seq ${s}`);
    assert.equal(j.written, survivors.length, `${label}: written counts only the nodes that verified (A1)`);
    return j;
  }, { events });
}
test('#1762 S3 BF6a — a node whose prov:used is NOT its event\'s entity is refused as `mismatch`, listed, untouched; the others are written', T, async () => {
  await refusedCase('mismatch (used)', (upd) => upd(swap(3, `${PROV}used`, `<${ENT}uuid-zzz>`)), { mismatch: [3] }, { survivors: CARD_SEQS.filter((s) => s !== 3), held: [3] });
});
test('#1762 S3 BF6b — a node whose scrum:op is NOT its event\'s op is refused as `mismatch`, listed, untouched; the others are written', T, async () => {
  await refusedCase('mismatch (op)', (upd) => upd(swap(2, `${RS}op`, '"delete"')), { mismatch: [2] }, { survivors: CARD_SEQS.filter((s) => s !== 2), held: [2] });
});
test('#1762 S3 BF6c — a seq-node the log has NO event for is refused as `missingEvent`, listed by its N, untouched; the others are written', T, async () => {
  await refusedCase('missingEvent', (upd) => upd(planted(node(999))), { missingEvent: [999] }, { held: [999] });
});
test('#1762 S3 BF6d — an activity IRI that is not seq-<digits> is refused as `badIri`, listed by IRI, untouched; the others are written', T, async () => {
  await refusedCase('badIri', async (upd) => { await upd(planted(`${ACT}seq-abc`)); await upd(planted(`${ACT}seq-`)); },
    { badIri: [`${ACT}seq-`, `${ACT}seq-abc`] });
});

// BF6e..k: what a pair is validated AGAINST, and the pre-existing facts that must agree. A contradiction is a `mismatch`, listed and NEVER overwritten.
const mismatchCase = (name, seq, plant) => test(`#1762 S3 BF6${name}`, T, async () => {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    await plant(upd);
    const before = await factsOf(node(seq));
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `a contradicted node exits 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, name);
    assert.deepEqual(flat(j, name), { ...emptyBuckets, mismatch: [seq] }, `seq ${seq} is listed as mismatch, alone`);
    assert.deepEqual(await factsOf(node(seq)), before, `seq ${seq}: NOTHING about it changed — a contradiction is refused, never overwritten`);
    for (const s of CARD_SEQS.filter((x) => x !== seq)) assert.equal(one(await factsOf(node(s)), COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s} verified, so it WAS written`);
  });
});
mismatchCase('e — a node whose entityKind is not its event\'s kind is refused as mismatch, untouched', 4, (upd) => upd(swap(4, `${RS}entityKind`, '"column"')));
mismatchCase('f — a node whose startedAtTime is not its event\'s time is refused as mismatch, untouched', 4, (upd) => upd(swap(4, `${PROV}startedAtTime`, '"2001-01-01T00:00:00.000Z"')));
mismatchCase('g — a node whose actor is not its event\'s actor is refused as mismatch, untouched', 4, (upd) => upd(swap(4, `${PROV}wasAssociatedWith`, `<${PERSON}mallory>`)));
mismatchCase('h — a node whose shortId is not its event\'s shortId is refused as mismatch, untouched', 4, (upd) => upd(swap(4, SHORT, '"999"')));
mismatchCase('i — a node that ALREADY carries a column the log contradicts is refused as mismatch; the wrong value is not overwritten', 4,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${COLUMN_AFTER}> "not-the-logs-column" . }`));
mismatchCase('j — a node that ALREADY carries a holder the log contradicts is refused as mismatch; the wrong value is not overwritten', 4,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${HOLDER}> <${PERSON}mallory> . }`));
mismatchCase('k — a node that ALREADY carries a logRecordedAt the log contradicts is refused as mismatch; the wrong value is not overwritten', 4,
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

test('#1762 S3 BF6l — an eligible log event whose seq-node is ABSENT is refused as `missingNode`, listed by its N: the direction a node-to-event pass alone cannot see', T, async () => {
  await refusedCase('missingNode', (upd) => upd(`DELETE WHERE { <${node(5)}> ?p ?o }`), { missingNode: [5] }, { survivors: CARD_SEQS.filter((s) => s !== 5) });
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
    assert.deepEqual(b, { ...emptyBuckets, mismatch: [3], missingEvent: [999], badIri: [`${ACT}seq-abc`] });
  });
});

// ── BF11 exit 4: a lost ACK ──
/** A proxy to the executor that, on the FIRST /update, either forwards it and then cuts the connection WITHOUT answering (ack lost), or cuts it before forwarding (request lost). */
async function lossyProxy(executorUrl, mode) {
  const state = { updates: 0, forwarded: 0 };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const isUpdate = req.method === 'POST' && req.url.startsWith('/update');
    if (isUpdate) state.updates++;
    if (isUpdate && state.updates === 1 && mode === 'request-lost') { req.socket.destroy(); return; }
    const up = await fetch(`${executorUrl}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))), body: body.length ? body : undefined });
    const text = Buffer.from(await up.arrayBuffer());
    if (isUpdate) state.forwarded++;
    if (isUpdate && state.updates === 1 && mode === 'ack-lost') { req.socket.destroy(); return; }
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' }); res.end(text);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); owned.servers.add(srv);
  return { url: `http://127.0.0.1:${srv.address().port}`, state, close: () => new Promise((r) => { srv.close(r); owned.servers.delete(srv); }) };
}
for (const mode of ['ack-lost', 'request-lost']) {
  test(`#1762 S3 BF11 (${mode}) — the FIRST write's ${mode === 'ack-lost' ? 'ACK is lost after the executor applied it' : 'request is cut before the executor saw it'}: exit 4 with \`apply.uncertain\`, never exit 2, and the re-run reconciles with no fact written twice`, T, async () => {
    await world(async ({ cliVia, x, base, report, factsOf, cli }) => {
      const proxy = await lossyProxy(x.baseUrl, mode);
      try {
        const r = await cliVia(proxy.url, [...base, '--apply']);
        assert.ok(proxy.state.updates >= 1, 'PRECONDITION: the script sent an update through the proxy');
        assert.equal(r.status, 4, `a lost ACK on the first write is exit 4, not 2 and not 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
        const j = report(r, mode);
        assert.deepEqual(j.apply?.confirmed, [], 'nothing was ACKed, so nothing is confirmed');
        assert.ok(Array.isArray(j.apply?.uncertain) && j.apply.uncertain.length >= 1, `the nodes whose ACK was lost are LISTED, never counted as zero (got ${JSON.stringify(j.apply)})`);
        assert.ok(j.apply.uncertain.every((n) => CARD_SEQS.includes(Number(n))), 'and they are planned nodes');
      } finally { await proxy.close(); }
      const again = await cli([...base, '--apply']);
      assert.equal(again.status, 0, `the re-run is the reconciliation and ends clean (got ${again.status}: ${(again.err || again.out).slice(-300)})`);
      const j2 = report(again, 'reconcile');
      assert.equal(j2.written + j2.alreadyCurrent, CARD_SEQS.length, 'every planned node is accounted for, written now or already current');
      if (mode === 'ack-lost') assert.ok(j2.alreadyCurrent >= 1, 'a write the executor DID apply is recognised as current, not written again');
      for (const s of CARD_SEQS) {
        const m = await factsOf(node(s));
        for (const p of [COLUMN_AFTER, HOLDER, LOGAT]) one(m, p, `seq ${s} after the reconcile`);
        assert.equal(one(m, COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s}: and correct`);
      }
    });
  });
}
test('#1762 S3 BF11c — uncertainty WINS over refusal: a lost ACK with a bad IRI planted is exit 4, and the refused bucket is still reported', T, async () => {
  await world(async ({ cliVia, x, base, report, upd }) => {
    await upd(planted(`${ACT}seq-abc`));
    const proxy = await lossyProxy(x.baseUrl, 'ack-lost');
    try {
      const r = await cliVia(proxy.url, [...base, '--apply']);
      assert.equal(r.status, 4, `exit 4 beats exit 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      assert.deepEqual(report(r, 'precedence').refused.badIri, [`${ACT}seq-abc`], 'and the refusal is still reported');
    } finally { await proxy.close(); }
  });
});
