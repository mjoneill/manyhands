/**
 * #1762 S3 — the facts-only BACKFILL (`scripts/history-backfill-1762.mjs`), black-box, rows first.
 *
 * ROW AUTHOR's rows for the builder's script, written to the "S3 CONTRACT" on #1762 (sections 4, 6, 7) before the script
 * exists. Every row is a REAL executor, the REAL projector (`scripts/activity-projector.mjs --once`) over a hand-built log, and
 * the script as a child process. Nothing here imports the builder's code.
 *
 *   BF-P  the script exists                         (the contract names it; until it does, every row says so, not "exit 1")
 *   BF0   CONTROL: the projected nodes carry NO column, holder or title — the measured fact the backfill exists for
 *   BF1   dry run (the default) writes NOTHING, to any graph, and reports what --apply will then do
 *   BF2   --apply: every non-refused CARD node gets exactly one columnAfter (the log event's column) and one holderAtWrite (the holder
 *         BEFORE the write, from the ordered earlier events; unknown where none is retained), judged per node, not by count;
 *         columns, conversations and refusals get neither
 *   BF3   it writes nothing else: the only triples added are columnAfter / holderAtWrite / shortId on seq-nodes, none removed,
 *         and no title, description or body text is anywhere in the store afterwards
 *   BF4   a second --apply writes nothing (bytes of every graph identical) and reports the nodes alreadyCurrent
 *   BF5   a node whose shortId the projection lacks gets it from the log; a refusal the log gives no shortId stays without one
 *   BF6   refused buckets, one row each, every one LISTED, UNTOUCHED, exit 3, and every OTHER node that verified WAS written:
 *         mismatch (prov:used), mismatch (scrum:op), missingEvent, badIri
 *   BF7   a run-<uuid> activity is not card history: counted as skippedNonSeq, not badIri, untouched, exit 0
 *   BF8   usage and unreadable source exit 2 and write NOTHING: no --log, unknown flag, a log directory that is not there, a
 *         wrong --dataset
 *   BF9   the event log is read, never written (the bytes of every segment are identical after --apply)
 *   BF10  the dry run and --apply classify identically (same refused buckets)
 *
 * ── STATUS: a DRAFT of the SETTLED-interface controls (the reviewer's S3 contract review, 06:32Z, said to draft these and not freeze
 *    incomplete oracles). Rows whose oracle her review leaves open are `todo` with the reason, so they run and show but cannot block:
 *      BF7   skippedNonSeq as a real, typed report field with a closed Run exclusion (review §3: today it is prose only)
 *      BF8d  what --dataset binds to (review §4: the actual dataset/store/epoch/incarnation, not an echoed label)
 *    NOT YET WRITTEN, waiting on the amended contract (review §3, §4): a log event whose projected node is ABSENT (the bucket name),
 *    duplicate seq / duplicate term values (bucket names), the dry run's `wouldWrite`, and a mid-apply transport failure's report.
 *
 * ── Assumptions the contract does not spell out. Each is one line to correct, and each row that leans on one says so ───────────
 *   A1  `written`, `alreadyCurrent` and `scanned` count NODES (one activity = one), not triples; `scanned` is every
 *       `activity/seq-<digits>` node the pass looked at (the graph's own count of them).
 *   A2  the encodings are the NATIVE S1 nodes' (core/graph-compiler.mjs historyActivityQuads), because S3 reads both shapes through
 *       one mapper: holder = IRI person/<encodeURIComponent holder>, or the IRI scrum:none for no holder; column = plain literal.
 *   A3  a node is a CARD node when the log event's entity.kind is 'card' and its op is not 'refused'. Only those get column/holder.
 *   A4  column-after is the log event's state.column (a tombstone keeps its last column). HOLDER-AT-WRITE IS THE HOLDER BEFORE THE WRITE
 *       (S1 contract; the reviewer's ruling on option C: "not blindly the event's post-state claimedBy"): derived from the ORDERED earlier events of the
 *       same entity: a create has none (scrum:none); otherwise the earlier event's claimedBy (null = scrum:none); an entity with NO retained
 *       earlier event and no create is scrum:unknown, never a guess and never the live card.
 *   A5  a dry run reports `dryRun: true`; this file does not pin what its `written` means, only that it leaves every graph
 *       byte-identical and classifies the refusals as --apply does (BF10).
 *   A6  a run node is `activity/run-<uuid>`; any other `activity/` IRI that is not `seq-<digits>` is badIri.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const ACT = 'https://scrumboard.local/activity/';
const ENT = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const COLUMN_AFTER = `${RS}columnAfter`, HOLDER = `${RS}holderAtWrite`, SHORT = `${RS}shortId`, NONE = `${RS}none`;
const FACTS = new Set([COLUMN_AFTER, HOLDER, SHORT]);
const node = (seq) => `${ACT}seq-${seq}`;

const owned = { dirs: new Set(), children: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); owned.dirs.add(d); return d; };

// ── the hand-built log: card create / update / delete, a column, a conversation, a refusal ──
const SECRETS = ['SECRET-TITLE-A', 'SECRET-DESC-A', 'SECRET-TITLE-B', 'SECRET-POST-BODY'];
const AT = (n) => `2026-10-20T10:${String(n).padStart(2, '0')}:00.000Z`;
function cardEv(seq, op, id, shortId, state, actor = 'ada', extra = {}) {
  return { seq, op, actor, recorded_at: AT(seq), ...extra, entity: { kind: 'card', id, shortId }, state: { id, shortId, ...state } };
}
const EVENTS = [
  cardEv(1, 'create', 'uuid-a', 101, { column: 'backlog', claimedBy: null, title: 'SECRET-TITLE-A', description: 'SECRET-DESC-A' }),
  cardEv(2, 'update', 'uuid-a', 101, { column: 'in-progress', claimedBy: 'ada', title: 'SECRET-TITLE-A' }),
  cardEv(3, 'create', 'uuid-b', 102, { column: 'planned', claimedBy: null, title: 'SECRET-TITLE-B' }, 'bob'),
  cardEv(4, 'update', 'uuid-a', 101, { column: 'done', claimedBy: 'ada', title: 'SECRET-TITLE-A' }, 'ada', { occurred_at: '2026-10-20T09:59:00.000Z' }),   // the projected time is occurred_at, not recorded_at
  cardEv(5, 'delete', 'uuid-b', 102, { column: 'planned', claimedBy: 'bob', title: 'SECRET-TITLE-B' }, 'bob'),     // a tombstone keeps its last column
  { seq: 6, op: 'create', actor: 'ada', recorded_at: AT(6), entity: { kind: 'column', id: 'col-x' }, state: { id: 'col-x', name: 'Extra' } },
  { seq: 7, op: 'create', actor: 'ada', recorded_at: AT(7), entity: { kind: 'conversation', id: 'conv-1' }, state: { id: 'conv-1', body: 'SECRET-POST-BODY' } },
  { seq: 8, op: 'refused', actor: 'ada', recorded_at: AT(8), entity: { kind: 'card', id: 'uuid-c' }, reason: 'REFUSED-REASON-FIXTURE', status: 409 },   // no shortId
  cardEv(9, 'update', 'uuid-a', 101, { column: 'review', claimedBy: 'a b', title: 'SECRET-TITLE-A' }),                 // a CLAIM by a holder that needs encoding
  cardEv(10, 'update', 'uuid-a', 101, { column: 'review', claimedBy: null, title: 'SECRET-TITLE-A' }),                // a RELEASE: before = 'a b', after = nobody
  cardEv(11, 'update', 'uuid-e', 105, { column: 'backlog', claimedBy: 'ada', title: 'SECRET-TITLE-E' }),              // an update whose entity has NO earlier event and no create in the log
];
/** what each CARD node must carry after the backfill — read off the log above, per node (assumptions A2 to A4) */
const UNKNOWN = `${RS}unknown`;
const EXPECT = {
  1: { column: 'backlog', holder: NONE, why: 'a CREATE: nobody held a card that did not exist' },
  2: { column: 'in-progress', holder: NONE, why: 'a CLAIM by ada: BEFORE the write nobody held it (her post-state claimedBy must not leak in)' },
  3: { column: 'planned', holder: NONE, why: 'a create' },
  4: { column: 'done', holder: `${PERSON}ada`, why: 'a move: ada held it before (seq 2 claimed it)' },
  5: { column: 'planned', holder: NONE, why: 'a DELETE whose tombstone says claimedBy bob: the holder BEFORE it was nobody, the tombstone is not history' },
  9: { column: 'review', holder: `${PERSON}ada`, why: 'a claim by "a b": before it, ada held it' },
  10: { column: 'review', holder: `${PERSON}a%20b`, why: 'a RELEASE: before it "a b" held it, in the encoding of a person IRI' },
  11: { column: 'backlog', holder: UNKNOWN, why: 'no earlier event and no create in the retained log: scrum:unknown, never a guess' },
};
const CARD_SEQS = Object.keys(EXPECT).map(Number);
const NON_CARD_SEQS = [6, 7, 8];

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
  const q = async (sparql) => {
    const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: sparql });
    assert.equal(r.status, 200, `the executor answered the query (${r.status})`);
    return (await r.json()).results.bindings;
  };
  const epoch = (await (await fetch(`${x.baseUrl}/health`)).json()).epoch;
  const upd = async (sparql) => {
    const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'content-type': 'application/sparql-update', 'x-op-id': `urn:ex:op/test/bf1762/${crypto.randomUUID()}`, ...(epoch != null ? { 'x-epoch': String(epoch) } : {}), [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL }, body: sparql });
    assert.equal(r.status, 200, `the planted update applied (${r.status} ${(await r.text()).slice(0, 200)})`);
  };
  /** every quad of every graph, as sorted lines: two equal snapshots mean NOTHING was written anywhere */
  const quads = async () => (await q('SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }'))
    .map((b) => `${b.g?.value ?? '-'}\u0000${b.s.value}\u0000${b.p.value}\u0000${b.o.type}:${b.o.datatype ?? ''}:${b.o.value}`).sort();
  const hash = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
  const factsOf = async (iri) => {
    const m = {};
    for (const b of await q(`SELECT ?p ?o WHERE { <${iri}> ?p ?o }`)) (m[b.p.value] ||= []).push(b.o);
    return m;
  };
  const cli = async (args) => {
    const r = await runNode([BACKFILL, ...args]);
    if (r.status === 1 && /Cannot find module/.test(r.err)) assert.fail('PRECONDITION: scripts/history-backfill-1762.mjs does not exist yet — the contract names it, so these rows are RED until it does');
    return r;
  };
  const base = ['--executor', x.baseUrl, '--dataset', DATASET, '--log', logDir];
  const report = (r, label) => {
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* reported below */ }
    assert.ok(j && typeof j === 'object' && !Array.isArray(j), `${label}: stdout is ONE JSON object (got ${JSON.stringify(r.out.slice(0, 200))}; stderr ${JSON.stringify(r.err.slice(0, 200))})`);
    return j;
  };
  try { await body({ x, q, upd, quads, hash, factsOf, cli, base, logDir, report }); } finally { await killExecutor(x); owned.children.delete(x); }
}

const one = (m, p, label) => { const v = m[p] || []; assert.equal(v.length, 1, `${label}: exactly one ${p} (got ${JSON.stringify(v)})`); return v[0]; };
const nodeFacts = (m) => ({ column: m[COLUMN_AFTER]?.map((t) => t.value), holder: m[HOLDER]?.map((t) => t.value) });
const untouched = (m, label) => { for (const p of FACTS) if (p !== SHORT) assert.equal(m[p], undefined, `${label}: untouched — it carries no ${p}`); };
function evState(dir) {
  const h = crypto.createHash('sha256'); let bytes = 0;
  for (const f of fs.readdirSync(dir).sort()) { const b = fs.readFileSync(path.join(dir, f)); h.update(f); h.update(b); bytes += b.length; }
  return { bytes, sha: h.digest('hex') };
}
const planted = (iri, { used = 'uuid-a', op = 'update', kind = 'card' } = {}) =>
  `INSERT DATA { <${iri}> <${RDF_TYPE}> <${PROV}Activity> ; <${RS}op> "${op}" ; <${PROV}used> <${ENT}${used}> ; <${RS}entityKind> "${kind}" . }`;
const sorted = (a) => [...a].sort();

// ── BF-P, BF0 ──
test('#1762 S3 BF-P — scripts/history-backfill-1762.mjs exists', () => {
  assert.ok(fs.existsSync(BACKFILL), 'the contract names scripts/history-backfill-1762.mjs; it is not there yet, so every other backfill row is RED for that one reason');
});

test('#1762 S3 BF0 CONTROL — the real projector leaves seq-nodes with NO column, holder or title: the gap the backfill closes (green on main by design)', T, async () => {
  await world(async ({ q, factsOf }) => {
    const seqNodes = (await q(`SELECT ?a WHERE { ?a <${RDF_TYPE}> <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`)).map((b) => b.a.value);
    assert.deepEqual(sorted(seqNodes), sorted(EVENTS.map((e) => node(e.seq))), 'PRECONDITION: one projected node per log event, the IRI carrying the event\'s own seq');
    for (const s of CARD_SEQS) {
      const m = await factsOf(node(s));
      assert.equal(m[COLUMN_AFTER], undefined, `seq ${s}: the projection carries no column`);
      assert.equal(m[HOLDER], undefined, `seq ${s}: the projection carries no holder`);
      assert.equal(one(m, `${RS}op`, `seq ${s}`).value, EVENTS[s - 1].op, `seq ${s}: the projection carries the op`);
      assert.equal(one(m, `${PROV}used`, `seq ${s}`).value, `${ENT}${EVENTS[s - 1].entity.id}`, `seq ${s}: and the entity`);
    }
  });
});

// ── BF1 dry run ──
test('#1762 S3 BF1 — the default is a DRY RUN: it exits 0, reports, and writes NOTHING to any graph', T, async () => {
  await world(async ({ quads, cli, base, report }) => {
    const before = await quads();
    const r = await cli(base);
    assert.equal(r.status, 0, `a clean dry run exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'dry run');
    assert.equal(j.dryRun, true, 'the report says it was a dry run');
    assert.deepEqual(await quads(), before, 'every graph is byte-identical after the dry run');
  });
});

// ── BF2 ──
test('#1762 S3 BF2 — --apply: every non-refused CARD node carries the column its LOG event left and the holder BEFORE the write; columns, conversations and refusals get neither', T, async () => {
  await world(async ({ cli, base, report, factsOf, q }) => {
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `a clean --apply exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, '--apply');
    assert.equal(j.dryRun, false, 'the report says it applied');
    const total = Number((await q(`SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a <${PROV}Activity> . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`))[0].n.value);
    assert.equal(j.scanned, total, 'scanned = the seq-nodes the graph holds (assumption A1)');
    assert.equal(j.written, CARD_SEQS.length, `written = the card nodes it completed, ${CARD_SEQS.length} of the log's ${EVENTS.length} events (A1) — judged against the log, per node, below`);
    assert.equal(j.alreadyCurrent, 0, 'nothing was current before the first run');
    assert.deepEqual(j.refused, { mismatch: [], missingEvent: [], badIri: [] }, 'nothing is refused when every node verifies');
    for (const s of CARD_SEQS) {
      const m = await factsOf(node(s));
      assert.equal(one(m, COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s}: column equals the log's state.column`);
      assert.equal(one(m, HOLDER, `seq ${s}`).value, EXPECT[s].holder, `seq ${s}: holder is the holder BEFORE the write — ${EXPECT[s].why} (A2, A4)`);
    }
    for (const s of NON_CARD_SEQS) untouched(await factsOf(node(s)), `seq ${s} (not card history)`);
  });
});

// ── BF3 ──
test('#1762 S3 BF3 — it writes NOTHING else: only columnAfter / holderAtWrite / shortId on seq-nodes, nothing removed, no title, description or body text stored', T, async () => {
  await world(async ({ cli, base, quads, q }) => {
    const before = await quads();
    assert.equal((await cli([...base, '--apply'])).status, 0);
    const after = await quads();
    const added = after.filter((l) => !before.includes(l)), removed = before.filter((l) => !after.includes(l));
    assert.deepEqual(removed, [], 'no triple is removed or rewritten');
    const dflt = added.filter((l) => l.startsWith('-\u0000'));
    for (const l of dflt) {
      const [, s, p] = l.split('\u0000');
      assert.ok(FACTS.has(p), `the default graph gains only the three facts, not ${p}`);
      assert.ok(s.startsWith(`${ACT}seq-`), `and only on seq-nodes, not ${s}`);
    }
    assert.ok(dflt.length >= CARD_SEQS.length * 2, 'PRECONDITION: it did write (a vacuous "added nothing" would pass the checks above)');
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

// ── BF6 refused buckets ──
async function refusedCase(label, plant, expectBuckets, { survivors = CARD_SEQS, held = [] } = {}) {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    await plant(upd);
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `${label}: some refused → exit 3, the rest written (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, label);
    assert.deepEqual(j.refused, expectBuckets, `${label}: the refused node is LISTED in its own bucket`);
    for (const s of survivors) {
      const m = await factsOf(node(s));
      assert.equal(one(m, COLUMN_AFTER, `${label}: seq ${s}`).value, EXPECT[s].column, `${label}: seq ${s} verified, so it WAS written`);
    }
    for (const s of held) untouched(await factsOf(node(s)), `${label}: seq ${s}`);
    assert.equal(j.written, survivors.length, `${label}: written counts only the nodes that verified (A1)`);
    return j;
  });
}
test('#1762 S3 BF6a — a node whose prov:used is NOT its event\'s entity is refused as `mismatch`, listed, untouched; the others are written', T, async () => {
  await refusedCase('mismatch (used)', (upd) => upd(`DELETE { <${node(3)}> <${PROV}used> ?o } INSERT { <${node(3)}> <${PROV}used> <${ENT}uuid-zzz> } WHERE { <${node(3)}> <${PROV}used> ?o }`),
    { mismatch: [3], missingEvent: [], badIri: [] }, { survivors: CARD_SEQS.filter((s) => s !== 3), held: [3] });
});
test('#1762 S3 BF6b — a node whose scrum:op is NOT its event\'s op is refused as `mismatch`, listed, untouched; the others are written', T, async () => {
  await refusedCase('mismatch (op)', (upd) => upd(`DELETE { <${node(2)}> <${RS}op> ?o } INSERT { <${node(2)}> <${RS}op> "delete" } WHERE { <${node(2)}> <${RS}op> ?o }`),
    { mismatch: [2], missingEvent: [], badIri: [] }, { survivors: CARD_SEQS.filter((s) => s !== 2), held: [2] });
});
test('#1762 S3 BF6c — a seq-node the log has NO event for is refused as `missingEvent`, listed by its N, untouched; the others are written', T, async () => {
  await refusedCase('missingEvent', (upd) => upd(planted(node(999))), { mismatch: [], missingEvent: [999], badIri: [] }, { held: [999] });
});
test('#1762 S3 BF6d — an activity IRI that is not seq-<digits> is refused as `badIri`, listed by IRI, untouched; the others are written', T, async () => {
  await refusedCase('badIri', async (upd) => { await upd(planted(`${ACT}seq-abc`)); await upd(planted(`${ACT}seq-`)); },
    { mismatch: [], missingEvent: [], badIri: [`${ACT}seq-`, `${ACT}seq-abc`] }, { held: [] });
});

// ── BF6e..i: the contract review's list of what a node is validated AGAINST (section 3: entity ID AND kind, raw op, projected time, available
//    actor and shortId, and conflicting pre-existing column/holder facts). A contradiction is refused as `mismatch` and NEVER overwritten. ──
const mismatchCase = (name, seq, plant, check = async () => {}) => test(`#1762 S3 BF6${name}`, T, async () => {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    await plant(upd);
    const before = await factsOf(node(seq));
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 3, `a contradicted node exits 3 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, name);
    assert.deepEqual(j.refused, { mismatch: [seq], missingEvent: [], badIri: [] }, `seq ${seq} is listed as mismatch`);
    const after = await factsOf(node(seq));
    assert.deepEqual(after, before, `seq ${seq}: NOTHING about it changed — a contradiction is refused, never overwritten`);
    for (const s of CARD_SEQS.filter((x) => x !== seq)) assert.equal(one(await factsOf(node(s)), COLUMN_AFTER, `seq ${s}`).value, EXPECT[s].column, `seq ${s} verified, so it WAS written`);
    await check({ factsOf });
  });
});
mismatchCase('e — a node whose entityKind is not its event\'s kind is refused as mismatch, untouched', 4,
  (upd) => upd(`DELETE { <${node(4)}> <${RS}entityKind> ?o } INSERT { <${node(4)}> <${RS}entityKind> "column" } WHERE { <${node(4)}> <${RS}entityKind> ?o }`));
mismatchCase('f — a node whose startedAtTime is not its event\'s time is refused as mismatch, untouched', 4,
  (upd) => upd(`DELETE { <${node(4)}> <${PROV}startedAtTime> ?o } INSERT { <${node(4)}> <${PROV}startedAtTime> "2001-01-01T00:00:00.000Z" } WHERE { <${node(4)}> <${PROV}startedAtTime> ?o }`));
mismatchCase('g — a node whose actor is not its event\'s actor is refused as mismatch, untouched', 4,
  (upd) => upd(`DELETE { <${node(4)}> <${PROV}wasAssociatedWith> ?o } INSERT { <${node(4)}> <${PROV}wasAssociatedWith> <${PERSON}mallory> } WHERE { <${node(4)}> <${PROV}wasAssociatedWith> ?o }`));
mismatchCase('h — a node whose shortId is not its event\'s shortId is refused as mismatch, untouched', 4,
  (upd) => upd(`DELETE { <${node(4)}> <${SHORT}> ?o } INSERT { <${node(4)}> <${SHORT}> "999" } WHERE { <${node(4)}> <${SHORT}> ?o }`));
mismatchCase('i — a node that ALREADY carries a column the log contradicts is refused as mismatch; the wrong value is not overwritten', 4,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${COLUMN_AFTER}> "not-the-logs-column" . }`));
mismatchCase('j — a node that ALREADY carries a holder the log contradicts is refused as mismatch; the wrong value is not overwritten', 4,
  (upd) => upd(`INSERT DATA { <${node(4)}> <${HOLDER}> <${PERSON}mallory> . }`));

// ── BF7 ──
test('#1762 S3 BF7 — a run-<uuid> activity is not card history: counted as skippedNonSeq (not badIri), untouched, and it does not make the run exit 3', { ...T, todo: 'pending contract amendment (reviewer 06:32Z, section 3): skippedNonSeq must be a typed report field with a closed Run exclusion' }, async () => {
  await world(async ({ cli, base, upd, factsOf, report }) => {
    const runs = [1, 2, 3].map(() => `${ACT}run-${crypto.randomUUID()}`);
    for (const r of runs) await upd(planted(r, { op: 'run', kind: 'run' }));
    const r = await cli([...base, '--apply']);
    assert.equal(r.status, 0, `run nodes are not refusals, so a clean run still exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    const j = report(r, 'runs');
    assert.equal(j.skippedNonSeq, runs.length, 'the three run nodes are counted, separately');
    assert.deepEqual(j.refused.badIri, [], 'and are not badIri');
    for (const iri of runs) untouched(await factsOf(iri), iri);
  });
});

// ── BF8 usage and unreadable source ──
for (const [label, args] of [
  ['no --log', (b) => b.filter((_, i, a) => a[i] !== '--log' && a[i - 1] !== '--log')],
  ['an unknown flag', (b) => [...b, '--no-such-flag']],
  ['a --log directory that is not there', (b) => b.map((v, i, a) => (a[i - 1] === '--log' ? path.join(os.tmpdir(), `bf1762-absent-${process.pid}`) : v))],
  ['a --dataset that is not the executor\'s (the wrong store must not be backfilled; assumption: the client\'s dataset check)', (b) => b.map((v, i, a) => (a[i - 1] === '--dataset' ? 'some-other-dataset' : v))],
]) {
  const pending = label.startsWith('a --dataset') ? { todo: 'pending contract amendment (reviewer 06:32Z, section 4): --dataset must bind the actual dataset/store/epoch/incarnation' } : {};
  test(`#1762 S3 BF8 — ${label}: exit 2 and NOTHING written, even with --apply`, { ...T, ...pending }, async () => {
    await world(async ({ cli, base, quads }) => {
      const before = await quads();
      const r = await cli([...args(base), '--apply']);
      assert.equal(r.status, 2, `usage or an unreadable source exits 2 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
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
test('#1762 S3 BF10 — the dry run and --apply classify identically: the same refused buckets for the same planted world', T, async () => {
  await world(async ({ cli, base, upd, report, quads }) => {
    await upd(planted(node(999)));
    await upd(planted(`${ACT}seq-abc`));
    await upd(`DELETE { <${node(3)}> <${PROV}used> ?o } INSERT { <${node(3)}> <${PROV}used> <${ENT}uuid-zzz> } WHERE { <${node(3)}> <${PROV}used> ?o }`);
    const before = await quads();
    const dry = await cli(base);
    assert.equal(dry.status, 3, 'a dry run that finds refusals exits 3 too: the exit code is the classification, not the write');
    assert.deepEqual(await quads(), before, 'and a dry run that found refusals still wrote NOTHING (review section 4: zero writes, including on refused cases)');
    const applied = await cli([...base, '--apply']);
    assert.equal(applied.status, 3);
    assert.deepEqual(report(dry, 'dry').refused, report(applied, 'apply').refused, 'identical buckets');
    assert.deepEqual(report(applied, 'apply').refused, { mismatch: [3], missingEvent: [999], badIri: [`${ACT}seq-abc`] });
  });
});
