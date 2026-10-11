/**
 * #1642 — graph_neighbors (GET /api/graph/neighbors) is built on `store.match` over the in-process copy; it moves to the executor behind SCRUM_GRAPH_NEIGHBORS_SOURCE=executor. Rows written BEFORE the build:
 * the parity row and the isolation row the card asks for ("for a fixed node set the answer from the executor equals the old copy's; differences only on a named list, each with a reason; control: an
 * executor-only probe edge shows on the executor side only; `properties=all` returns no bookkeeping").
 *
 * THE SHAPE (as #1643's verdict-diff): ONE real executor, two real REST processes on the SAME data, the flag unset (today: the replica answers) and the flag on (the executor answers). The fixture is made through the
 * API on the first REST: a parent card with three children, a subject card with every edge kind (relatedTo, blockedBy, parent, a `#N` mention in its text), a retitle (so it has write history), a decision, a memory; the
 * REAL activity projector (core/activity-projector.mjs projectBatch, production code) then copies the history into the executor. One node exists ONLY in the executor (a probe person seeded into its default graph).
 * Each leg's source is READ from its own payload: every neighbours answer must say `source: "replica" | "executor"` (the contract I am asking for, as on /api/ready and /api/graph).
 *
 *   N0 CONTROL     two flag-unset REST processes agree on every query in the node set; the fixture reaches the shapes that can differ (several edge groups in both directions, a truncated group, history, a decision, a seat)
 *   N1 SOURCES     the flag-unset payload names the replica; the flag-on payload names the executor
 *   N1b CURRENCY   the executor leg states `executorPosition` as `epoch:commitSeq` (digits) on every 200 answer; the replica leg states none (added after the PR #44 review: N1 checked `source` only and the normaliser drops this key)
 *   N2 PARITY      flag-on vs flag-unset, every query in the set, normalised (below): EQUAL. The named differences are exactly the ones listed in NAMED below, each with its reason; there are none besides the probe row
 *   N3 PROBE       the executor-only probe person answers 200 on the executor leg and 404 UNKNOWN_NODE on the replica leg: the flag moved the reads (the control the card asks for)
 *   N4 ISOLATION   `properties=all` and the edge lists on the executor leg carry no bookkeeping vocabulary (entityJson, recordedBy, receipts, `urn:ex:` predicates, a version stamp) for the card, the decision and the seat
 *   N5 ERRORS      an unknown card, a bad direction and a memory addressed by its uuid get the SAME status, code and `tried` list on both legs (a memory is NOT addressable today: the accepted forms reach cards, persons, decisions and
 *                  `entity:`; this row pins that as current behaviour, and says so, rather than "fixing" it in the move)
 *   N6 TRUNCATION  a group cut at limit=2 shows the SAME members on both legs (sorted by id), `total` 3, `truncated` true
 *   N7 FAILURE     with the flag on and the executor unable to answer queries, the endpoint reports no neighbours it did not read: a 5xx with a code, never a 200 with `exists: true`
 *
 * Normalisation (so no row hides a difference behind it): dropped = `rebuiltMs`, `watermark`, `source`, `executorPosition`; `kinds` and `edges` are compared AS LISTS, in the order each leg returned them (PO ruling on #1642: groups by total descending then predicate ascending within a direction, `kinds` sorted lexically, on BOTH legs;
 * each leg's own order is asserted in norm()). Members inside a group keep their order (the code sorts them by id). Everything else is compared as is. NOTE: the ruling says 'predicate IRI'; the payload shows the compact name, so the rows assert on that.
 *
 * NOT covered, by name: label aliases (#1640 has not moved: the card's named difference for `sameAs` edges is not exercised because the fixture has no alias); conversation posts as in-edges (`schema:about`) and the
 * `Comment` label rule; the real board's data distribution and the 1000+-child apex (the live cost of labelling); AMBIGUOUS_NODE (two cards with one identifier); blank-node list cells; the MCP tool's own argument.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { projectBatch } from '../core/activity-projector.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `npar-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' }, wiki: { name: 'Wiki', glyph: 'w', color: '#aa8899', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the log-born unit (decisions, memories, seat state in the executor, as in production) refuses a write with no credential: one admin token for the seat `ada`
const TOKEN = mintToken();
const TOKENS_FILE = (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'npar-tok-')); const f = path.join(d, 'seat-tokens.json'); const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(f, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOKEN), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); return f; })();
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const PROBE = 'person:probe1642';
const PROBE_IRI = 'https://scrumboard.local/person/probe1642';
const NAMED = [
  { query: PROBE, reason: 'seeded into the executor only: the replica cannot know it (the control that the flag moved the reads)' },
  { query: 'person:ada (a seat that authored a log-born decision and memory)', reason: 'the same blindness seen from the other end: the executor has THREE more in-edge groups on the seat (scrum:decidedBy from the decision, scrum:owner and schema:author from the memory and its version); the replica has none of them. Everything else on the seat is equal' },
  { query: 'decision:<a decision made through the log-born unit>', reason: 'the replica is BLIND to decisions (and memories, and seat state) created since the log-born cutover: they live only in the executor, so the replica answers 404 UNKNOWN_NODE where the executor answers. Read on the live board 10-10: the 08-19 decision resolves, tonight\'s 53fe6fef gives 404. The flag FIXES this; it is a difference in the executor\'s favour, named so it is not mistaken for a regression' },
];

async function failProxy(execUrl) {
  const state = { failQueries: false };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (state.failQueries && req.method === 'POST' && req.url !== '/update' && !/entityJson|BIND\(1 AS|urn:ex:|urn:scrum:bookkeeping/.test(Buffer.concat(chunks).toString()) /* the READ doors a neighbours answer uses (SELECT and ASK), NOT the cards unit's own machinery (its cache load, counter and currency ping): otherwise REST's own 503 gate answers first and the row would pass for any build */) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'test: executor cannot answer' })); }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      try {
        const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
        const t = await f.text(); res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
      } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
const ENV = (extra) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'npar', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1' /* decisions, memories and seat state live in the executor, as in production */, SCRUM_SEAT_TOKENS: TOKENS_FILE, ...extra });

/** The executor, started, stopped, SEEDED with the probe person in its default graph (the replica never sees it), and started again. */
async function seededExecutor() {
  const store = tmpStore('npar-');
  const first = await startExecutor({ store, datasetId: 'npar', create: true }); await killExecutor(first);
  const seed = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <${PROBE_IRI}> a <https://schema.org/Person> ; <https://schema.org/name> "probe 1642" ; <https://schema.org/knows> <urn:ex:probe-target-1642> }')\ns.flush()`]);
  assert.equal(seed.status, 0, `the probe was seeded: ${String(seed.stderr)}`);
  return startExecutor({ store, datasetId: 'npar', create: false });
}
async function mkCard(base, fields) { const r = await api(base, 'POST', '/api/cards', { createdBy: 'ada', ...fields }); assert.equal(r.status, 201, `create ${fields.title}: ${r.status} ${r.text.slice(0, 200)}`); return r.body; }

async function world(body) {
  const exec = await seededExecutor(); const proxy = await failProxy(exec.baseUrl); const rests = []; const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npar-work-')); fs.writeFileSync(path.join(work, 'work-objects.jsonl'), '');
  let everyLeg = {};   // env every leg gets once the columns have been migrated (production runs the columns unit; the executor must hold the Column nodes a card's `scrum:column` edge points at)
  const start = async (extra = {}) => { const r = await startRestServer({ ...(rests.length ? { boardFile: rests[0].boardFile } : { board: makeBoardFixture() }), env: ENV({ SCRUM_GRAPH_EXECUTOR_URL: proxy.url, ...everyLeg, ...extra }) }); rests.push(r); return r; };   // every REST after the first SHARES its document (and event log), so the only difference between legs is the flag
  try {
    const A0 = await start();   // builds the fixture, with the columns still in the document
    const A = A0;
    const P = await mkCard(A.baseUrl, { title: 'n parent card' }); await sleep(10);
    const Y = await mkCard(A.baseUrl, { title: 'n related card', parent: P.id }); await sleep(10);
    const Z = await mkCard(A.baseUrl, { title: 'n blocker card', parent: P.id }); await sleep(10);
    const X = await mkCard(A.baseUrl, { title: 'n subject card', description: `see #${Y.shortId} for the measurement`, parent: P.id, relationships: { relatedTo: [Y.shortId], blockedBy: [Z.shortId] } }); await sleep(10);
    const dec = await api(A.baseUrl, 'POST', '/api/decisions', { statement: 'n decision for the neighbours rows', decidedBy: 'ada', constrains: ['neighbors-1642'], reopensIf: 'the rows say otherwise' }); assert.ok(dec.status === 201 || dec.status === 200, `decision: ${dec.status} ${dec.text.slice(0, 160)}`);
    const mem = await api(A.baseUrl, 'POST', '/api/memories', { title: 'n memory', body: 'a memory for the neighbours rows', by: 'ada', tags: ['n1642'] }); assert.ok(mem.status === 201 || mem.status === 200, `memory: ${mem.status} ${mem.text.slice(0, 160)}`);
    assert.equal((await api(A.baseUrl, 'PATCH', `/api/cards/${X.id}`, { by: 'ada', title: 'n subject card, retitled' })).status, 200);   // LAST: a document write marks the replica dirty, so it re-syncs the log-born decision and memory too
    await sleep(300);
    const projected = await projectBatch({ logDir: `${A.boardFile.replace(/\.json$/, '')}-events`, workDir: work, executorUrl: exec.baseUrl, batchSize: 500 });
    assert.ok(projected.projected > 0, `PRECONDITION: the real projector copied history into the executor (${JSON.stringify(projected).slice(0, 160)})`);
    const decisionId = dec.body.id ?? dec.body.decision?.id; const memoryId = mem.body.id ?? mem.body.memory?.id;
    assert.ok(decisionId && memoryId, `ids: ${JSON.stringify({ decisionId, memoryId })}`);
    const QUERIES = {
      'subject, both': `node=${X.shortId}`, 'subject, out': `node=${X.shortId}&direction=out`, 'subject, in': `node=${X.shortId}&direction=in`,
      'subject, properties=all': `node=${X.shortId}&properties=all`, 'subject, with history': `node=${X.shortId}&includeHistory=true`,
      'subject, one predicate': `node=${X.shortId}&predicates=scrum:relatedTo`, 'parent, limit 2 (cut)': `node=${P.shortId}&limit=2`, 'parent, default': `node=${P.shortId}`,
      'related card': `node=${Y.shortId}`, 'by uuid': `node=${X.id}`, 'seat': 'node=person:ada', 'decision': `node=decision:${decisionId}`, 'decision, properties=all': `node=decision:${decisionId}&properties=all`,
    };
    const mig = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'migrate-columns-1639.mjs'), '--board-data', A0.boardFile, '--executor', exec.baseUrl, '--dataset', 'npar', '--apply'], { encoding: 'utf8' });
    assert.equal(mig.status, 0, `PRECONDITION: the columns were copied into the executor: ${mig.stdout.slice(-300)} ${mig.stderr.slice(-300)}`);
    everyLeg = { SCRUM_GRAPH_UNIT_COLUMNS: '1' }; const Aleg = await start();   // the flag UNSET leg: today's behaviour, with the columns unit on as in production
    await body({ A: Aleg, start, proxy, QUERIES, ids: { P, Y, Z, X, decisionId, memoryId } });
  } finally { for (const r of rests) { try { await r.stop(); } catch { /* gone */ } } proxy.close(); await killExecutor(exec); }
}

const get = (rest, qs) => api(rest.baseUrl, 'GET', `/api/graph/neighbors?${qs}`);
const DROP = new Set(['rebuiltMs', 'watermark', 'source', 'executorPosition']);
function norm(r) {
  if (r.status !== 200) return { status: r.status, code: r.body?.code ?? null, tried: r.body?.tried ?? null };
  const b = r.body;
  for (const dir of ['out', 'in']) { const k = (b.edges ?? []).filter((g) => g.direction === dir).map((g) => [g.total, g.predicate]); const want = [...k].sort((x, y) => (y[0] - x[0]) || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)); assert.deepEqual(k, want, `the documented key holds on this leg (#1642 ruling): within "${dir}", total descending, ties by predicate ascending (${JSON.stringify(k)})`); }
  assert.deepEqual(b.kinds ?? [], [...(b.kinds ?? [])].sort(), 'kinds are sorted lexically on this leg (#1642 ruling)');
  const o = Object.fromEntries(Object.entries(b).filter(([k]) => !DROP.has(k)));
  return { status: 200, ...o, kinds: b.kinds ?? [], edges: b.edges ?? [] };
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const firstDiff = (a, b, p = '$') => { if (JSON.stringify(canon(a)) === JSON.stringify(canon(b))) return null; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; } } return `${p}: replica ${JSON.stringify(a)?.slice(0, 160)} | executor ${JSON.stringify(b)?.slice(0, 160)}`; };
const sources = async (A, B, qs) => [(await get(A, qs)).body?.source, (await get(B, qs)).body?.source];

test('N0 CONTROL: two flag-unset REST processes agree on every query, and the node set reaches the shapes that can differ', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, QUERIES }) => {
    const A2 = await start(); const diffs = [];
    for (const [name, qs] of Object.entries(QUERIES)) { const [a, b] = [norm(await get(A, qs)), norm(await get(A2, qs))]; try { assert.deepEqual(b, a); } catch { diffs.push(name); } }
    assert.deepEqual(diffs, [], 'the diff is quiet when nothing differs: the normalisation leaves no noise');
    const subj = norm(await get(A, QUERIES['subject, both'])); const preds = subj.edges.map((g) => `${g.direction} ${g.predicate}`);
    assert.ok(subj.status === 200 && subj.edges.length >= 4, `the subject has several edge groups, in both directions: ${preds}`); assert.ok(preds.some((p) => p.startsWith('in ')) && preds.some((p) => p.startsWith('out ')), preds.join(' | '));
    const cut = norm(await get(A, QUERIES['parent, limit 2 (cut)'])); const g = cut.edges.find((x) => x.truncated); assert.ok(g && g.total === 3 && g.members.length === 2, `a group is cut at limit 2: ${JSON.stringify(cut.edges.map((x) => [x.predicate, x.total, x.truncated]))}`);
    const hist = norm(await get(A, QUERIES['subject, both'])).history; assert.ok(hist && hist.count >= 1 && hist.latest, `the subject has write history: ${JSON.stringify(hist)}`);
    const dr = await get(A, QUERIES.decision); assert.equal(dr.status, 404, `CONTROL: the replica is blind to a log-born decision (the first named difference): ${dr.status} ${dr.text.slice(0, 160)}`); const sr = await get(A, QUERIES.seat); assert.equal(sr.status, 200, `the seat resolves on the replica: ${sr.status} ${sr.text.slice(0, 200)}`);
  });
});

test('N1 SOURCES: the flag-unset payload names the replica; the flag-on payload names the executor', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const [sa, sb] = await sources(A, B, QUERIES['subject, both']);
    assert.equal(sa, 'replica', 'each leg names the store that answered, read from the response'); assert.equal(sb, 'executor', `the flag moved the reads (a build that ignores it still says replica or nothing): ${String(sb)}`);
  });
});

test('N1b CURRENCY: the executor leg states executorPosition (epoch:commitSeq, digits) on every 200 answer; the replica leg states none', { skip: SKIP, timeout: 900000 }, async () => {
  // the accepted contract on #1642 (PO, 07:07Z 10-10): "source + executorPosition on every answer, the same as #1643". A reader of an executor answer must be able to tell how current it is.
  await world(async ({ A, start, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); let n200 = 0;
    for (const [name, qs] of Object.entries(QUERIES)) {
      const [ra, rb] = [await get(A, qs), await get(B, qs)];
      if (rb.status !== 200) continue;
      n200++;
      assert.ok(!('executorPosition' in (ra.body ?? {})), `${name}: the replica leg states no executor position (it did not read the executor)`);
      assert.match(String(rb.body.executorPosition), /^\d+:\d+$/, `${name}: the executor leg states executorPosition as epoch:commitSeq, digits only (got ${JSON.stringify(rb.body.executorPosition)})`);
    }
    assert.ok(n200 >= 10, `CONTROL: the check ran over the node set (${n200} executor answers were 200)`);
  });
});

test('N2 PARITY: flag-on vs flag-unset, every query in the node set is equal after normalisation', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const [sa, sb] = await sources(A, B, QUERIES['subject, both']);
    assert.equal(sa, 'replica', 'REFUSED to compare: the replica leg does not say replica'); assert.equal(sb, 'executor', 'REFUSED to compare: the executor leg does not say executor');
    const diffs = [];
    for (const [name, qs] of Object.entries(QUERIES)) {
      if (name.startsWith('decision') || name === 'seat') continue;   // named differences (the replica is blind to log-born kinds), asserted in N3b
      const [a, b] = [norm(await get(A, qs)), norm(await get(B, qs))];
      try { assert.deepEqual(b, a); } catch (e) { diffs.push(`${name} -> ${firstDiff(a, b)} [replica groups ${JSON.stringify((a.edges ?? []).map((g) => [g.direction, g.predicate, g.total]))} | executor groups ${JSON.stringify((b.edges ?? []).map((g) => [g.direction, g.predicate, g.total]))}]`); }
    }
    assert.deepEqual(diffs, [], `no unexplained difference (the named list is ${JSON.stringify(NAMED.map((n) => n.query))}, tested in N3)`);
  });
});

test('N3 PROBE: the executor-only probe person answers 200 on the executor leg and 404 UNKNOWN_NODE on the replica leg', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const [a, b] = [await get(A, `node=${PROBE}`), await get(B, `node=${PROBE}`)];
    assert.equal(a.status, 404, `CONTROL: the replica has never seen the probe: ${a.text.slice(0, 160)}`); assert.equal(a.body?.code, 'UNKNOWN_NODE');
    assert.equal(b.status, 200, `the executor leg answers the probe (a build that ignores the flag cannot): ${b.status} ${b.text.slice(0, 200)}`);
    assert.ok(b.body.edges.some((g) => g.direction === 'out' && g.predicate === 'schema:knows' && g.members.some((m) => m.id === 'urn:ex:probe-target-1642')), `its seeded edge is in the answer: ${JSON.stringify(b.body.edges)}`);
  });
});

test('N3b NAMED DIFFERENCE: a decision made through the log-born unit is 404 on the replica leg and answers on the executor leg, with its author edge and its label', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, QUERIES, ids }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const [a, b] = [await get(A, QUERIES.decision), await get(B, QUERIES.decision)];
    assert.equal(a.status, 404, `CONTROL: the replica cannot see it: ${a.text.slice(0, 120)}`); assert.equal(b.status, 200, `the executor leg answers: ${b.status} ${b.text.slice(0, 200)}`); assert.equal(b.body.source, 'executor');
    assert.equal(b.body.node.id, `decision:${ids.decisionId}`); assert.ok(b.body.kinds.includes('scrum:Decision'), `kinds: ${b.body.kinds}`);
    assert.equal(b.body.node.label, `Decision: ${ids.decisionId}`, `the label rule gives "Decision: <id>" today (the statement is not among the label keys): ${b.body.node.label}`);
    assert.ok(b.body.edges.some((g) => g.direction === 'out' && g.predicate === 'scrum:decidedBy'), `its author edge: ${JSON.stringify(b.body.edges.map((g) => [g.direction, g.predicate]))}`);
  });
});

test('N3c NAMED DIFFERENCE: the seat\'s answer on the executor leg is the replica\'s PLUS exactly the log-born in-edges (decidedBy, owner, author), nothing else', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const [a, b] = [norm(await get(A, QUERIES.seat)), norm(await get(B, QUERIES.seat))];
    assert.equal(a.status, 200, 'CONTROL: the replica resolves the seat'); assert.equal(b.status, 200);
    const extra = ['schema:author', 'scrum:decidedBy', 'scrum:owner'].map((p) => `in ${p}`); const strip = (n) => n.edges.filter((g) => !extra.includes(`${g.direction} ${g.predicate}`));
    const got = b.edges.filter((g) => extra.includes(`${g.direction} ${g.predicate}`)); assert.deepEqual(got.map((g) => [g.predicate, g.total]).sort(), [['schema:author', 1], ['scrum:decidedBy', 1], ['scrum:owner', 1]], 'exactly the three log-born groups, one member each');
    assert.deepEqual(strip(b), strip(a), 'and every other group on the seat is equal');
    assert.deepEqual({ ...b, edges: undefined }, { ...a, edges: undefined }, 'as are the seat\'s own node, kinds and properties');
  });
});

test('N4 ISOLATION: properties=all and the edge lists on the executor leg carry no bookkeeping vocabulary', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ start, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const BOOK = /entityJson|recordedBy|receipt|importedAt|sourceDigest|urn:ex:(?!probe)|(^|[:#/])ver$/i;
    for (const name of ['subject, properties=all', 'decision, properties=all', 'seat', 'subject, both', 'subject, with history']) {
      const r = await get(B, QUERIES[name]); assert.equal(r.status, 200, `${name}: ${r.text.slice(0, 160)}`); assert.equal(r.body.source, 'executor', `${name}: the flag is honoured`);
      const keys = [...Object.keys(r.body.properties ?? {}), ...(r.body.edges ?? []).map((g) => g.predicate), ...(r.body.kinds ?? [])];
      assert.deepEqual(keys.filter((k) => BOOK.test(k)), [], `${name}: no bookkeeping key (saw ${keys.join(', ')})`);
    }
  });
});

test('N5 ERRORS: an unknown card, a bad direction and a memory uuid get the SAME status, code and tried list on both legs', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, ids }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); assert.equal((await get(B, 'node=1')).body?.source ?? (await get(B, `node=${ids.X.shortId}`)).body?.source, 'executor', 'CONTROL: the flag is honoured');
    for (const [name, qs, status, code] of [['unknown card', 'node=999999', 404, 'UNKNOWN_NODE'], ['bad direction', `node=${ids.X.shortId}&direction=sideways`, 400, 'BAD_DIRECTION'], ['memory by uuid', `node=${ids.memoryId}`, 404, 'UNKNOWN_NODE'], ['memory as entity:', `node=entity:${ids.memoryId}`, 404, 'UNKNOWN_NODE']]) {
      const [a, b] = [await get(A, qs), await get(B, qs)];
      assert.equal(a.status, status, `${name}: the replica leg is the oracle (${a.status} ${a.text.slice(0, 120)})`); assert.equal(a.body?.code, code);
      assert.deepEqual(norm(b), norm(a), `${name}: the executor leg answers the same status, code and tried list`);
    }
  });
});

test('N6 TRUNCATION: a group cut at limit=2 shows the same members on both legs, total 3, truncated true', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const [a, b] = [await get(A, QUERIES['parent, limit 2 (cut)']), await get(B, QUERIES['parent, limit 2 (cut)'])];
    assert.equal(b.body?.source, 'executor'); const cut = (r) => r.body.edges.find((g) => g.truncated);
    assert.ok(cut(a) && cut(b), 'both legs cut the group'); assert.equal(cut(b).total, 3); assert.equal(cut(b).members.length, 2);
    assert.deepEqual(cut(b).members, cut(a).members, 'the SAME two members, in the same order (sorted by id: the store\'s iteration order is not a contract)');
  });
});

test('N7 FAILURE: with the flag on and the executor unable to answer queries, the endpoint reports no neighbours it did not read', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ start, proxy, QUERIES }) => {
    const B = await start({ SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' }); const ok = await get(B, QUERIES['subject, both']); assert.equal(ok.status, 200, `CONTROL: it answers while the executor is up: ${ok.text.slice(0, 160)}`); assert.equal(ok.body.source, 'executor', 'CONTROL: the flag is honoured');
    proxy.state.failQueries = true; const r = await get(B, QUERIES['subject, both']);
    assert.ok(r.status >= 500 && r.status <= 504 && r.status !== 500, `a refusal the caller can retry (502/503/504), never a 200 and never a bare 500 (got ${r.status} ${r.text.slice(0, 160)})`);
    assert.ok(r.body?.code, 'and it carries a code'); assert.ok(!r.body?.exists, 'and does not claim the node exists');
    const named = await get(B, QUERIES.seat);   // person:/decision:/entity: resolve by an existence check, a different code path from the card shortId's SELECT
    assert.ok(named.status >= 502 && named.status <= 504, `a node named person:<key> is a 5xx too when the executor cannot answer, NEVER a 404 "no such node" (a failed read reported as an absence): got ${named.status} ${named.text.slice(0, 160)}`); assert.notEqual(named.body?.code, 'UNKNOWN_NODE');
  });
});
