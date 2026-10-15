/**
 * #1643 — the two Done gates the verdict-diff rows (checks-verdict-diff-1643.test.mjs, V0 to V6) do not cover. TEST AUTHOR's. The checks source is ALREADY on the executor in production, so these rows
 * protect behaviour that is live; they were written after the build, on scratch copies, and the live board was not touched.
 *
 *   K1  DIGEST      the daily digest is rendered from the `standing[]` of /api/checks. Fed the payload of the flag-unset REST and of the flag-on REST over the same data, with each check's rows put in one
 *                   fixed order, `renderDigest` (core/digest.mjs) produces the same body: the same checks, items, counts and wording.
 *   K1b KNOWN DIFFERENCE (characterisation, not a gate)  the digest prints rows in the order the store returned them and shows the first six, and the standing queries have no ORDER BY. The replica's
 *                   order is stable; the executor's is arbitrary and differs between runs (measured), so the printed order, and which six rows are shown, can differ with the source. The first-seen keys do not.
 *   K2  STALE ASK   with the graph conversations unit on (production's setting) the `stale-claims` standing check answers `disabled` with its reason on BOTH sources, which the MCP tick reads as
 *                   "ask nothing, forget nothing" (mcp-server.mjs, staleClaimAskOnce). So under #1643 the ask is neither started nor stopped by the source. NOTE: this also means the stale-claim ask does not
 *                   fire in production at all while that unit is on; that is #1574's doing, not #1643's.
 *   K3  STALE ASK   with the unit OFF, where the check is enabled, an old claim yields the same `stale-claims` rows on both sources and `staleClaimAskTick` posts the same asks from each
 *                   (the check reads the document and the clock, not the store, so this pins that the executor pass does not disturb it).
 *   F1  FLIP BACK   RETIRE THIS ROW WITH #1645: once the old in-process copy is removed there is nothing to flip back to. Run flag-unset, then flag-on, then flag-unset again on the SAME
 *                   executor and data: the third payload names the replica again, carries no `executorPosition`, has the same keys as the first, and its whole normalised list equals the first's.
 *
 * NOT covered, by name: the plist restore and the REST restart themselves (an operations step); the live MCP process (the consumers' decision functions are exercised, not the running tick); the real
 * board's data distribution; `emitterTick`'s `unregistered-kinds` consumer beyond the V rows' equality of two empty answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { renderDigest } from '../core/digest.mjs';
import { staleClaimAskTick } from '../core/stale-claim-ask.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `cc-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER_FILE, { force: true }); } catch { /* best effort */ } });

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const mkCard = async (base, fields) => { const r = await api(base, 'POST', '/api/cards', { createdBy: 'ada', ...fields }); assert.equal(r.status, 201, `create ${fields.title}: ${r.status} ${r.text.slice(0, 200)}`); return r.body; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checksOf = async (rest) => { const r = await api(rest.baseUrl, 'GET', '/api/checks?fresh=1'); assert.equal(r.status, 200, r.text.slice(0, 300)); return r.body; };
const NOW = '2026-10-15T12:00:00.000Z';

/** One executor; REST processes started on demand against it. `units` is the env that selects the conversations unit (on = production's setting). */
async function world({ conversations }, body) {
  const store = tmpStore('cc-'); const exec = await startExecutor({ store, datasetId: 'cc', create: true }); const rests = [];
  const env = (extra) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'cc', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CARDS: '1', ...(conversations ? { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}), ...extra });
  const start = async (extra = {}, board = makeBoardFixture()) => { const r = await startRestServer({ board, env: env(extra) }); rests.push(r); return r; };
  try { await body({ start, exec }); } finally { for (const r of rests) { try { await r.stop(); } catch { /* gone */ } } await killExecutor(exec); try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* best effort: this file made it, this file removes it */ } }
}

/** The fixture, made through the API on a flag-unset REST: two cards blocked by a done card (so the phantom-block standing check returns two rows) and a watcher card with a broken tripwire. */
async function seed(A) {
  const blocker = await mkCard(A.baseUrl, { title: 'cc blocker, shipped' });
  assert.equal((await api(A.baseUrl, 'PATCH', `/api/cards/${blocker.id}`, { by: 'ada', column: 'done' })).status, 200);
  await sleep(15); await mkCard(A.baseUrl, { title: 'cc blocked by a done card', relationships: { blockedBy: [blocker.shortId] } });
  await sleep(15); await mkCard(A.baseUrl, { title: 'cc also blocked by the done card', relationships: { blockedBy: [blocker.shortId] } });
  await sleep(15); await mkCard(A.baseUrl, { title: 'cc watcher', checks: [{ claim: 'cc broken ASK', ask: 'ASK { ?c schema:identifier "1"', expect: true }, { claim: 'cc holds', ask: 'ASK { ?c a schema:CreativeWork }', expect: true }] });
  await sleep(300);
}

const T = { skip: SKIP, timeout: 900000 };

// The digest prints a standing check's rows in the order the store gave them, and shows only the first six. The standing queries have no ORDER BY, so the ORDER is the store's: stable within one replica,
// but arbitrary on the executor and different between runs (measured: the same four phantom-block rows came out 5,4,3,2 on the replica and 3,5,4,2 or 2,5,4,3 on the executor, run to run). K1 therefore
// compares the digest with each check's rows put in one fixed order, which pins CONTENT (the same items, counts and wording); K1b records the order dependence, which is a known difference and not a gate.
const sorted = (standing) => (standing ?? []).map((s) => (Array.isArray(s.rows) ? { ...s, rows: [...s.rows].sort((x, y) => JSON.stringify(x, Object.keys(x).sort()).localeCompare(JSON.stringify(y, Object.keys(y).sort()))) } : s));

test('#1643 (K1) the digest rendered from the executor\'s standing checks has the same content as the one from the replica\'s: the same checks, items, counts and wording', T, async () => {
  await world({ conversations: true }, async ({ start }) => {
    const A = await start(); await seed(A); const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' });
    const [a, b] = [await checksOf(A), await checksOf(B)];
    assert.equal(a.source, 'replica', 'the first leg names the replica'); assert.equal(b.source, 'executor', 'the second leg names the executor');
    const da = renderDigest({ standing: sorted(a.standing), now: NOW, firstSeen: {} }); const db = renderDigest({ standing: sorted(b.standing), now: NOW, firstSeen: {} });
    assert.ok(da.body && /phantom-block/.test(da.body), `PRECONDITION: the digest has a body that names a failing standing check (it is not "nothing wrong" twice): ${String(da.body).slice(0, 200)}`);
    assert.ok(/2 phantom-block/.test(da.body), 'PRECONDITION: the failing check has TWO rows, so a dropped row changes the count');
    assert.equal(db.body, da.body, 'with the rows in one order, the digest body is the same whichever store answered');
    assert.deepEqual(db.firstSeen, da.firstSeen, 'and so is the first-seen map it carries to the next day (its keys do not depend on row order)');
    assert.equal(db.items, da.items);
  });
});

test('#1643 (K1b, CHARACTERISATION) the digest\'s row order, and which six rows it shows, follow the order the store returned them', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ blocked: i + 1, blocker: 99 }));
  const mk = (rs) => renderDigest({ standing: [{ id: 'phantom-block', claim: 'c', rows: rs }], now: NOW, firstSeen: {} });
  const fwd = mk(rows); const rev = mk([...rows].reverse());
  assert.notEqual(rev.body, fwd.body, 'reversing the rows changes the digest text');
  assert.match(fwd.body, /blocked=1 blocker=99 · blocked=2/, 'the rows are printed in the given order');
  assert.match(fwd.body, /\+2 more/, 'only six are shown, with a count of the rest');
  assert.ok(!/blocked=8 /.test(fwd.body) && /blocked=8 /.test(rev.body), 'so WHICH six are shown depends on the order too');
  assert.deepEqual(rev.firstSeen, fwd.firstSeen, 'the first-seen keys do not depend on the order: only the printed text does');
});

test('#1643 (K2) with the conversations unit on, stale-claims answers "disabled" on both sources, which the ask consumer reads as: ask nothing, forget nothing', T, async () => {
  await world({ conversations: true }, async ({ start }) => {
    const A = await start(); await seed(A); const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' });
    const [a, b] = [await checksOf(A), await checksOf(B)];
    const sa = a.standing.find((s) => s.id === 'stale-claims'); const sb = b.standing.find((s) => s.id === 'stale-claims');
    assert.ok(sa && sb, 'PRECONDITION: both payloads carry a stale-claims entry');
    assert.equal(sa.disabled, true, 'replica: disabled'); assert.equal(sb.disabled, true, 'executor: disabled');
    assert.equal(sb.reason, sa.reason, 'with the same reason'); assert.ok(sa.reason && sa.reason.length > 10, 'and a reason is stated (never an empty "nothing found")');
    assert.equal(Object.hasOwn(sb, 'rows') && sb.rows?.length > 0, false, 'no rows are offered to the ask consumer from either source');
    // the consumer's contract for an entry that is not readable (mcp-server.mjs staleClaimAskOnce): rows = null, and staleClaimAskTick then does nothing
    const posts = []; const r = await staleClaimAskTick({ now: NOW, rows: null, post: async (m) => posts.push(m), file: path.join(os.tmpdir(), `cc-ask-${process.pid}-k2.json`) });
    assert.equal(r.asked, 0); assert.equal(posts.length, 0, 'CONTROL: unreadable rows post nothing');
    fs.rmSync(path.join(os.tmpdir(), `cc-ask-${process.pid}-k2.json`), { force: true });
  });
});

test('#1643 (K3) with the unit off, an old claim gives the same stale-claims rows on both sources and the same asks', T, async () => {
  const claimedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const board = () => makeBoardFixture({ cards: [{ id: 'uuid-1', shortId: 1, title: 'held for ten days, silent', description: 'x', type: 'task', assignees: ['ada'], labels: [], for: '', priority: 'p2', column: 'in-progress', order: 0, createdAt: claimedAt, updatedAt: claimedAt, createdBy: 'ada', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] }, claimedBy: 'ada', claimedAt }], nextShortId: 2, conversations: [] });
  await world({ conversations: false }, async ({ start }) => {
    const A = await start({ SCRUM_GRAPH_UNIT_CARDS: '' }, board()); const B = await start({ SCRUM_GRAPH_UNIT_CARDS: '', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }, board());
    const [a, b] = [await checksOf(A), await checksOf(B)];
    assert.equal(a.source, 'replica'); assert.equal(b.source, 'executor');
    const sa = a.standing.find((s) => s.id === 'stale-claims'); const sb = b.standing.find((s) => s.id === 'stale-claims');
    assert.ok(sa && !sa.disabled && !sa.error, `PRECONDITION: the check is enabled with the unit off: ${JSON.stringify(sa)?.slice(0, 200)}`);
    assert.ok(Array.isArray(sa.rows) && sa.rows.length >= 1, 'PRECONDITION: the old claim produces a row (so equal is not "both empty")');
    const strip = (rows) => rows.map(({ ms, slow, ...r }) => r);
    assert.deepEqual(strip(sb.rows ?? []), strip(sa.rows), 'the same stale-claims rows from either source');
    const run = async (rows, tag) => { const posts = []; const file = path.join(os.tmpdir(), `cc-ask-${process.pid}-${tag}.json`); fs.rmSync(file, { force: true }); await staleClaimAskTick({ now: NOW, rows, post: async (m) => posts.push(m), file }); fs.rmSync(file, { force: true }); return posts; };
    const pa = await run(strip(sa.rows), 'a'); const pb = await run(strip(sb.rows), 'b');
    assert.ok(pa.length >= 1, 'PRECONDITION: the ask is actually posted from the replica leg');
    assert.deepEqual(pb, pa, 'and the asks posted are identical');
  });
});

// ---- F1: flip back ----
const NOISE = new Set(['ms', 'slow']);
const strip = (o) => (Array.isArray(o) ? o.map(strip) : (o && typeof o === 'object') ? Object.fromEntries(Object.entries(o).filter(([k]) => !NOISE.has(k)).map(([k, v]) => [k, strip(v)])) : o);
function norm(p) {
  const byCard = (p.results ?? []).map((x) => ({ title: x.title, checks: (x.checks ?? []).map((c) => { const r = strip(c); if (r.status === 'error') r.error = r.error ? 'error: <non-empty>' : 'error: <EMPTY>'; return r; }).sort((x1, y1) => x1.claim.localeCompare(y1.claim)) })).sort((x1, y1) => String(x1.title).localeCompare(String(y1.title)));
  const standing = (p.standing ?? []).map((s) => ({ ...strip(s), ...(s.error ? { error: 'error: <non-empty>' } : {}), ...(Array.isArray(s.rows) ? { rows: s.rows.map((r) => JSON.stringify(strip(r))).sort().map((j) => JSON.parse(j)) } : {}) })).sort((x1, y1) => x1.id.localeCompare(y1.id));
  const counters = Object.fromEntries(['cardsWatched', 'cardsUnwatched', 'checksTotal', 'stale', 'errors'].map((k) => [k, p[k]]));
  return { byCard, standing, counters };
}
const DROP = new Set(['evaluatedAt', 'evaluationMs', 'passes', 'generation', 'watermark', 'storeMeter', 'servedFrom', 'ageMs', 'note', 'checkCeilingMs']);

test('#1643 (F1) FLIP BACK (retire with #1645): flag-unset, then flag-on, then flag-unset again on the same executor and data gives the first answer again', T, async () => {
  await world({ conversations: true }, async ({ start }) => {
    const A = await start(); await seed(A); const first = await checksOf(A); await A.stop();
    const B = await start({ SCRUM_GRAPH_CHECKS_SOURCE: 'executor' }); const mid = await checksOf(B); await B.stop();
    const C = await start(); const third = await checksOf(C);
    assert.equal(first.source, 'replica'); assert.equal(mid.source, 'executor', 'PRECONDITION: the middle leg really ran on the executor (so the flip was a flip)'); assert.ok(mid.executorPosition, 'PRECONDITION: and stated a position');
    assert.equal(third.source, 'replica', 'flipped back: the replica answers again');
    assert.equal(third.executorPosition ?? null, first.executorPosition ?? null, 'and no executor position is carried over from the flagged run');
    const keys = (p) => Object.keys(p).filter((k) => !DROP.has(k)).sort();
    assert.deepEqual(keys(third), keys(first), 'the payload has the same top-level fields as before the flag was ever on');
    assert.deepEqual(norm(third), norm(first), 'the whole normalised list is the one the never-flagged run gave');
  });
});
