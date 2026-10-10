/**
 * #1643 — the card checks (GET /api/checks, ticked every minute; its verdicts feed the digest and the stale-claim ask) move from the in-process replica to the executor behind
 * SCRUM_GRAPH_CHECKS_SOURCE=executor. Rows written BEFORE the build, as the verdict-diff harness the card asks for ("run the evaluator against both sources on a fixed board and diff the FULL
 * verdict list; zero differences, or each one on a named list with a reason").
 *
 * THE SHAPE: ONE real executor, two real REST processes on the SAME data, one with the flag unset (today: the replica answers) and one with it on (the executor answers). The fixture is made through the API on the
 * first, so the cards, their edges and their authored tripwires are in the graph and in the first REST's document. Both are asked `GET /api/checks?fresh=1` and their payloads are NORMALISED and compared
 * IN FULL (every per-card check row, every standing check, the counters). As in #1658, a leg's source is READ from its own payload, never assumed from a flag: the harness refuses to compare unless the replica
 * leg says `source: "replica"` and the executor leg says `source: "executor"` (this is a contract I am asking for: every checks payload names the store that answered, like /api/ready and /api/graph).
 *
 * THE FIXTURE (one watcher card carries the authored tripwires): a holding ASK; a stale ASK; a broken ASK (error); a wildcard ASK over the default graph (the card's named hazard: it WILL change verdict if
 * bookkeeping were in the default graph; #1638 moved it out); a `compare` tripwire with the dateTime cast (holds) and the same without the cast (error: the datatype is the contract); and ONE tripwire that can only
 * hold on the executor, because its fact was seeded into the executor's default graph and the replica never saw it. That one is the NAMED DIFFERENCE and the proof that the flag moved the reads. A phantom-block
 * situation (an open card blocked by a done card) makes a standing check return a row on both sides, so "same rows" is not "both empty".
 *
 *   V0 CONTROL      two REST processes with the flag UNSET agree on the whole normalised list; the list carries every verdict kind (holds, stale, error) and a non-empty standing row; so the diff is not noise and the fixture can fail
 *   V1 SOURCES      the flag-unset payload says `source: "replica"`; the flag-on payload says `source: "executor"` and states the executor's currency as `executorPosition` (present, not null)
 *   V2 VERDICT DIFF flag-on vs flag-unset, FULL normalised lists: the ONLY difference is the named one (the executor-only probe: stale on the replica, holds on the executor); every other check, standing check and counter is equal
 *   V3 HAZARDS      on the executor leg the wildcard ASK holds; the cast compare holds; the uncast compare is an error (status only; the engines word their errors differently); the phantom-block standing check returns its row
 *   V4 COST         every per-card check row and every standing row on the executor leg carries an integer `ms` >= 0 (network plus engine, "reported", not bounded: the one-minute-tick bound is a load figure, see NOT covered)
 *   V5 FAILURE      with the flag on and the executor unable to answer queries, the endpoint never reports a verdict it did not read: not 200 with any holds/stale, and no standing check with empty rows and no error
 *
 * Normalisation (stated so no row hides a difference behind it): dropped = per-row `ms` and `slow`, `evaluatedAt`, `evaluationMs`, `passes`, `generation`, `watermark`, `storeMeter`, `executorPosition`, `source`,
 * `servedFrom`/`ageMs`, `note`, `checkCeilingMs`, `shaIntegrity` (git, same on both), the TEXT of an `error` (replaced by "error: <non-empty>"), and the ORDER of a standing check's rows (its queries have no ORDER BY;
 * the two engines order them differently, so rows are compared as a set). Everything else is compared.
 *
 * NOT covered, by name: boot refusal when the flag is on without SCRUM_GRAPH_EXECUTOR_URL (the builder copies #1644's pattern; no row here); the one-minute tick bound for a ~60-check pass (a load figure for the
 * deployed board, not this 8-check fixture); the MCP checks tick, the digest and the stale-claim ask (consumers: the card's live gate); `role-expiry` and `stale-claims` beyond "equal on this fixture" (stale-claims is
 * disabled under the conversations unit on both sides); a `unregistered-kinds` row that is non-empty (this fixture has none; equality of two empty answers is weak for that one check, which is why it is named); the real
 * board's data distribution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `cvd-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' }, wiki: { name: 'Wiki', glyph: 'w', color: '#aa8899', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROBE = 'urn:ex:probe1643';
const PROBE_CLAIM = 'v8 executor-only probe: a fact that exists only in the executor';

/** A proxy in front of the executor that can answer every query with a 503 (for V5). */
async function failProxy(execUrl) {
  const state = { failQueries: false };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (state.failQueries && req.method === 'POST' && req.url.startsWith('/query')) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'test: executor cannot answer' })); }
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

const ENV = (extra) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'cvd', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...extra });

/** The executor, started, stopped, SEEDED with the probe fact in its default graph (the replica never sees it), and started again. */
async function seededExecutor() {
  const store = tmpStore('cvd-');
  const first = await startExecutor({ store, datasetId: 'cvd', create: true }); await killExecutor(first);
  const seed = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <${PROBE}> <http://schema.org/name> "probe" }')\ns.flush()`]);
  assert.equal(seed.status, 0, `the probe fact was seeded: ${String(seed.stderr)}`);
  return startExecutor({ store, datasetId: 'cvd', create: false });
}

async function mkCard(base, fields) { const r = await api(base, 'POST', '/api/cards', { createdBy: 'ada', ...fields }); assert.equal(r.status, 201, `create ${fields.title}: ${r.status} ${r.text.slice(0, 200)}`); return r.body; }

/** One world: the seeded executor behind a fail-able proxy, REST #1 (flag unset) with the fixture made through it. Each leg is started on demand. */
async function world(body) {
  const exec = await seededExecutor(); const proxy = await failProxy(exec.baseUrl); const rests = [];
  const start = async (extra = {}) => { const r = await startRestServer({ board: makeBoardFixture(), env: ENV({ SCRUM_GRAPH_EXECUTOR_URL: proxy.url, ...extra }) }); rests.push(r); return r; };
  try {
    const A = await start();   // the flag UNSET: today's behaviour, the replica answers
    const anchor = await mkCard(A.baseUrl, { title: 'v anchor card' }); await sleep(15);
    const newer = await mkCard(A.baseUrl, { title: 'v newer card' }); await sleep(15);
    const blocker = await mkCard(A.baseUrl, { title: 'v blocker, shipped' }); assert.equal((await api(A.baseUrl, 'PATCH', `/api/cards/${blocker.id}`, { by: 'ada', column: 'done' })).status, 200);
    await sleep(15); await mkCard(A.baseUrl, { title: 'v blocked by a done card', relationships: { blockedBy: [blocker.shortId] } });
    await sleep(15); await mkCard(A.baseUrl, { title: 'v also blocked by the done card', relationships: { blockedBy: [blocker.shortId] } });   // TWO rows, so a truncated or collapsed row set differs
    const D = (s) => `<${XSD}dateTime>(${s})`;
    const checks = [
      { claim: 'v1 holds: the anchor exists', ask: `ASK { ?c schema:identifier "${anchor.shortId}" }`, expect: true },
      { claim: 'v2 stale: no card has this id', ask: 'ASK { ?c schema:identifier "999999" }', expect: true },
      { claim: 'v3 error: a broken ASK', ask: `ASK { ?c schema:identifier "${anchor.shortId}"`, expect: true },
      { claim: 'v4 wildcard: no bookkeeping predicate in the default graph', ask: 'ASK { ?s ?p ?o FILTER(CONTAINS(STR(?p), "entityJson")) }', expect: false },
      { claim: 'v5 compare with the cast: the oldest card is older than the newest', compare: { left: `SELECT (MIN(${D('?d')}) AS ?v) WHERE { ?c a schema:CreativeWork ; schema:dateCreated ?d }`, op: '<', right: `SELECT (MAX(${D('?e')}) AS ?v) WHERE { ?x a schema:CreativeWork ; schema:dateCreated ?e }` }, expect: true },
      { claim: 'v6 compare without the cast: strings are refused', compare: { left: 'SELECT (MIN(?d) AS ?v) WHERE { ?c a schema:CreativeWork ; schema:dateCreated ?d }', op: '<', right: 'SELECT (MAX(?e) AS ?v) WHERE { ?x a schema:CreativeWork ; schema:dateCreated ?e }' }, expect: true },
      { claim: 'v7 holds: another ASK that is true on both', ask: `ASK { ?c schema:identifier "${newer.shortId}" }`, expect: true },
      { claim: PROBE_CLAIM, ask: `ASK { <${PROBE}> ?p ?o }`, expect: true },
    ];
    await mkCard(A.baseUrl, { title: 'v watcher card', checks });
    await sleep(300);
    await body({ A, start, proxy, claims: checks.map((c) => c.claim) });
  } finally { for (const r of rests) { try { await r.stop(); } catch { /* gone */ } } proxy.close(); await killExecutor(exec); }
}

const get = async (rest) => { const r = await api(rest.baseUrl, 'GET', '/api/checks?fresh=1'); return r; };
const NOISE = new Set(['ms', 'slow']);
const strip = (o) => (Array.isArray(o) ? o.map(strip) : (o && typeof o === 'object') ? Object.fromEntries(Object.entries(o).filter(([k]) => !NOISE.has(k)).map(([k, v]) => [k, strip(v)])) : o);
const normRow = (row) => { const r = strip(row); if (r.status === 'error') { r.error = r.error ? 'error: <non-empty>' : 'error: <EMPTY>'; } return r; };
function norm(payload) {
  const byCard = (payload.results ?? []).map((x) => ({ title: x.title, checks: (x.checks ?? []).map(normRow).sort((a, b) => a.claim.localeCompare(b.claim)) })).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const standing = (payload.standing ?? []).map((s) => ({ ...strip(s), ...(s.error ? { error: 'error: <non-empty>' } : {}), ...(Array.isArray(s.rows) ? { rows: s.rows.map((r) => JSON.stringify(strip(r))).sort().map((j) => JSON.parse(j)) } : {}) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));   // an unordered standing query's row ORDER is the engine's, not a verdict: rows are compared as a set (found by this very harness: two engines, two orders, same rows)
  const counters = Object.fromEntries(['cardsWatched', 'cardsUnwatched', 'checksTotal', 'checksReferencingOnlyCardIdentity', 'stale', 'errors', 'unwatchedByType', 'unwatchedGoals'].map((k) => [k, payload[k]]));
  return { byCard, standing, counters };
}
const flat = (n) => Object.fromEntries(n.byCard.flatMap((c) => c.checks).map((c) => [c.claim, c]));
const withoutProbe = (n) => ({ ...n, byCard: n.byCard.map((c) => ({ ...c, checks: c.checks.filter((r) => r.claim !== PROBE_CLAIM) })), counters: {} });

test('V0 CONTROL: two flag-unset REST processes agree on the whole normalised list, and the list holds every verdict kind and a non-empty standing row', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start }) => {
    const A2 = await start(); const [a, b] = [await get(A), await get(A2)];
    assert.equal(a.status, 200, a.text.slice(0, 200)); assert.equal(b.status, 200, b.text.slice(0, 200));
    const [na, nb] = [norm(a.body), norm(b.body)]; assert.deepEqual(nb, na, 'the diff is quiet when nothing differs: normalisation does not leave noise behind');
    const rows = flat(na); const statuses = new Set(Object.values(rows).map((r) => r.status));
    for (const s of ['holds', 'stale', 'error']) assert.ok(statuses.has(s), `the fixture produces a ${s} verdict (so the diff can fail): ${[...statuses]}`);
    assert.equal(rows[PROBE_CLAIM]?.status, 'stale', 'CONTROL: on the replica the executor-only probe is stale (it cannot see it)');
    const phantom = na.standing.find((s) => s.id === 'phantom-block'); assert.ok(phantom?.rows?.length >= 2, `a standing check returns TWO rows, so "same rows" is neither "both empty" nor "both one": ${JSON.stringify(phantom)}`);
  });
});

test('V1 SOURCES: the flag-unset payload names the replica; the flag-on payload names the executor and states its currency as executorPosition', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start }) => {
    const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }); const [a, b] = [await get(A), await get(B)];
    assert.equal(a.status, 200); assert.equal(b.status, 200, b.text.slice(0, 300));
    assert.equal(a.body.source, 'replica', 'each leg names the store that answered, read from the response');
    assert.equal(b.body.source, 'executor', `the flag moved the reads (a build that ignores it still says replica): ${String(b.body.source)}`);
    assert.ok(b.body.executorPosition != null, `the executor's currency is stated as executorPosition: ${JSON.stringify(b.body.executorPosition)}`);
  });
});

test('V2 VERDICT DIFF: flag-on vs flag-unset, the FULL normalised lists are equal except the one named difference (the executor-only probe)', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ A, start }) => {
    const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }); const [a, b] = [await get(A), await get(B)];
    assert.equal(a.status, 200); assert.equal(b.status, 200, b.text.slice(0, 300));
    assert.equal(a.body.source, 'replica', 'REFUSED to compare: the replica leg does not say replica'); assert.equal(b.body.source, 'executor', 'REFUSED to compare: the executor leg does not say executor');
    const [na, nb] = [norm(a.body), norm(b.body)];
    assert.equal(flat(na)[PROBE_CLAIM]?.status, 'stale', 'the named difference, replica side: stale'); assert.equal(flat(nb)[PROBE_CLAIM]?.status, 'holds', 'the named difference, executor side: holds (only the executor has the fact)');
    assert.deepEqual(withoutProbe(nb), withoutProbe(na), 'EVERY other verdict, standing check and counter is equal (the named list has one entry, and it is not this)');
    assert.equal(nb.counters.stale, na.counters.stale - 1, 'the one named difference is the only thing that moved the stale count'); assert.equal(nb.counters.errors, na.counters.errors);
  });
});

test('V3 HAZARDS: on the executor leg the wildcard ASK holds, the cast compare holds, the uncast compare is an error, and phantom-block returns its row', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ start }) => {
    const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }); const b = await get(B); assert.equal(b.status, 200, b.text.slice(0, 300)); assert.equal(b.body.source, 'executor');
    const rows = flat(norm(b.body));
    assert.equal(rows['v4 wildcard: no bookkeeping predicate in the default graph']?.status, 'holds', 'bookkeeping is not in the executor\'s default graph (#1638): the wildcard ASK keeps its verdict');
    assert.equal(rows['v5 compare with the cast: the oldest card is older than the newest']?.status, 'holds', 'the dateTime DATATYPE survives the executor (the compare form reads typed terms)');
    assert.equal(rows['v6 compare without the cast: strings are refused']?.status, 'error', 'and a string that merely looks like a timestamp is still refused');
    const phantom = norm(b.body).standing.find((s) => s.id === 'phantom-block'); assert.ok(phantom?.rows?.length >= 2, `the standing check reads the executor and returns its rows: ${JSON.stringify(phantom)}`);
  });
});

test('V4 COST: every per-card check and standing row on the executor leg carries an integer ms >= 0', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ start }) => {
    const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }); const b = await get(B); assert.equal(b.status, 200); assert.equal(b.body.source, 'executor');
    const rows = [...(b.body.results ?? []).flatMap((x) => x.checks), ...(b.body.standing ?? []).filter((s) => !s.disabled)]; assert.ok(rows.length >= 8, `rows to check (${rows.length})`);
    for (const r of rows) assert.ok(Number.isInteger(r.ms) && r.ms >= 0, `${r.claim ?? r.id}: ms is an integer >= 0 (got ${r.ms})`);
  });
});

test('V5 FAILURE: with the flag on and the executor unable to answer queries, the endpoint reports no verdict it did not read', { skip: SKIP, timeout: 900000 }, async () => {
  await world(async ({ start, proxy }) => {
    const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }); const ok = await get(B); assert.equal(ok.status, 200, `CONTROL: it answers while the executor is up: ${ok.text.slice(0, 200)}`); assert.equal(ok.body.source, 'executor', 'CONTROL: the flag is honoured');
    proxy.state.failQueries = true; const r = await get(B);
    if (r.status === 200) {
      const rows = (r.body.results ?? []).flatMap((x) => x.checks);
      assert.ok(rows.length > 0 && rows.every((c) => c.status === 'error'), `a 200 may only carry errors, never a verdict it could not read: ${JSON.stringify(rows.map((c) => c.status))}`);
      for (const s of (r.body.standing ?? []).filter((x) => x.query)) assert.ok(s.disabled || s.error, `a standing check that reads the store and could not says so, never empty rows: ${JSON.stringify(s).slice(0, 200)}`);   // the file-reading checks (roster, claims) never touch the store
    } else { assert.ok([502, 503, 504].includes(r.status), `a refusal is a 5xx the caller can retry (got ${r.status})`); assert.ok(r.body?.code || r.body?.error, 'and says why'); }
  });
});
