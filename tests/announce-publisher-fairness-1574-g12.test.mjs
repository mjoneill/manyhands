/**
 * #1574 gate 12 — PUBLISHER QUEUE FAIRNESS. Pre-registered by a separate test author BEFORE the fix exists, against
 * scripts/announce-publisher.mjs as of bf442db (unchanged through 3083dae). Copy unchanged into tests/ and build to it;
 * if the contract needs a change, the test changes first and the change is announced on #1574.
 * Fixture style copied from the frozen C3b file (tests/announcement-publish-1574-c3b.test.mjs); nothing is imported from it.
 *
 * THE DEFECT (today): scan() takes oldestFirst(pending).slice(0, batch) and THROWS on any 5xx from /publish. So
 *   (a) entries that can never publish (the board answers 200 {status:'pending'}) occupy the head of EVERY scan, and
 *       with more of them than --batch, a newer publishable entry is never reached;
 *   (b) one 5xx aborts the rest of the scan, and the next scan hits the same entry first again.
 *
 * CONTRACT PINNED HERE
 *   BATCH     --batch N bounds publish ATTEMPTS per scan: at most N POST /api/outbox/:id/publish calls (counted by a
 *             proxy in front of the board). Unchanged from today when nothing is failing (F4 passes today).
 *   FAILURE   an attempt FAILS when /publish answers >= 500, cannot be reached/parsed, OR answers 200 {status:'pending'}.
 *             A failed entry enters BACKOFF. A 5xx is counted and recorded, never thrown out of the scan: the scan
 *             continues to the next entry. A failing entry is attempted at most ONCE per scan.
 *             `blocked` and `published` answers are outcomes, not failures (as in C3b).
 *   BACKOFF   an entry in backoff is SKIPPED (no /publish call) until its window passes, and skipped entries do NOT count
 *             against --batch. The FIRST window is at least 60 s; NO window (however many failures) exceeds 24 h. An entry
 *             is due again at or after its nextAttemptAt (>=, like nextActions). After the window it IS attempted again,
 *             and publishes if its fault has cleared (backoff never parks an entry forever).
 *   FAIRNESS  entries that keep newly failing cannot starve an eligible entry across scans (F8: one fresh failure
 *             appears before every --batch 1 scan, and the eligible entry still publishes within 5 scans).
 *   STATE     backoff state persists between `--once` runs in the STATUS FILE (the same --status path is reused across
 *             scans; this process still keeps no other state). The proxy fakes the 5xx, so the BOARD never learns of
 *             the failure: board-side backoff state cannot satisfy F2/F3/F5-F8.
 *             HYGIENE: an entry LEAVES `backoff` when it is published (F5) or BLOCKED (F10), whether the block came from
 *             this publisher's own due attempt or from elsewhere while it waited. (Gone: see NOT PINNED.)
 *             CEILING: under repeated failure every window stays within [60 s, 24 h] of that scan's injected now (F9).
 *   CLOCK     NEW flag `--now <ISO-8601>`: backoff decisions and nextAttemptAt use this instant instead of the wall
 *             clock. Absent => wall clock. No test sleeps; the injected tests move only --now.
 *             It must be a FULL, CALENDAR-VALID ISO timestamp, the same rule as parseIsoStrict in
 *             scripts/graph-store-backup-watch.mjs (date, time, Z or ±hh:mm; a real day of a real month). Feb 31,
 *             month 13, a non-leap Feb 29, a date-only value and a zone-less value are INVALID => exit 2 with ZERO
 *             /publish calls (F0).
 *   STATUS    NEW status-file fields (alongside the C3b ones, which are unchanged), all describing the LAST scan:
 *               attempted     integer, /publish calls made
 *               deferred      integer, pending entries skipped because they were in backoff
 *               publishErrors integer, attempts that got >=500 / unreachable / unparseable (a 200 'pending' answer is a
 *                             failed attempt for BACKOFF but is NOT asserted as a publishError here)
 *               backoff       object keyed by obligationId -> { nextAttemptAt: ISO-8601, ... } for entries in backoff
 *             lastError: if non-null after a scan with a 5xx, it names the failing obligationId. Not otherwise pinned.
 *   EXIT      A per-entry /publish failure, including a 5xx from the board on that one call, still exits 0 once the scan
 *             completes. Exit 1 ONLY when the outbox listing (GET /api/outbox) can't be obtained (board unreachable or a
 *             non-2xx on that read). Nothing about a per-entry failure may abort the scan.
 *             (Per-entry failures are DATA: publishErrors, backoff. F11 here pins the non-2xx listing; C3b S4 pins
 *             unreachable. 2 stays "arguments rejected", F0.)
 *
 * NOT PINNED HERE, BY NAME: any ALERT threshold or alerting on publishErrors / backoff depth; the EXECUTOR SUCCESS path
 * (with the flag on, publisher-mode entries are pending by construction; F1 uses that only as a "cannot succeed" source);
 * the backoff SCHEDULE beyond the 60 s floor and 24 h ceiling (no exponent, no jitter); the ORDER within a scan beyond
 * F4's no-failure oldest-first and F8's outcome bound; the long-running loop mode (only --once is run); a board-side
 * record of failures; whether a 'pending' answer increments publishErrors; checkedAt's clock under --now; an entry that
 * is GONE from the outbox leaving `backoff` (required by the contract above, but the board offers these fixtures no way
 * to remove an entry while a server runs, so no row asserts it).
 *
 * EXAMPLE ONLY, NOT PINNED — a fairness rule that satisfies F8 while keeping F4 and C3b S1 green: order candidates by
 * WHEN THE PUBLISHER FIRST SAW EACH ENTRY PENDING (kept in the status file), then by occurredAt. With nothing failing
 * and one scan seeing everything at once, that collapses to oldest-first (F4, S1); under F8 the target was seen first and
 * so outranks every fresh failure. Any other rule that passes these rows is equally acceptable.
 *
 * WHY EACH FAILS TODAY is stated per test. F4 (ordering and --batch) and F11 (a failed listing exits 1) are CONTROLS
 * and must PASS today and after the fix. F0's invalid half passes today vacuously; its valid twin makes the row fail.
 * Tests that pass --now fail today first because parseArgs rejects an unknown argument (exit 2); each also states the
 * substantive behaviour that would fail without that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHER = process.env.PUBLISHER_SCRIPT || path.join(HERE, '..', 'scripts', 'announce-publisher.mjs');

// ---- copied from C3b (not imported)
async function api(base, method, route, body, { signal } = {}) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(10000) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const outboxOf = async (base) => { const r = await api(base, 'GET', '/api/outbox'); assert.equal(r.status, 200, `GET /api/outbox: ${r.status} ${r.text}`); return r.body; };
const entryOf = async (base, id) => (await outboxOf(base)).entries.find((e) => e.obligationId === id);
const statusOf = async (base, id) => (await entryOf(base, id))?.status;

const T0 = '2026-10-04T12:00:00.000Z';
const payloadOf = (mut, slot, body, at = T0) => ({ author: 'board', body, mentions: [], notify: true, occurredAt: at, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: mut, slot });
const originOf = (mut, mode, slots = ['claim']) => ({ mutationId: mut, slots, origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', ...(mode ? { mode } : {}) });
const entryFor = (mut, mode, extra = {}, { slot = 'claim', body = `claimed ${mut}`, at = T0 } = {}) => ({ obligationId: `${mut}:${slot}`, mutationId: mut, slot, status: 'pending', ...(mode ? { mode } : {}), payload: payloadOf(mut, slot, body, at), ...extra });
const legacyPost = (id, mut, extra = {}) => ({ id, body: `claimed ${mut}`, author: 'board', attachedTo: null, attachments: [], mentions: [], createdAt: T0, origin: { mutationId: mut, slot: 'claim' }, ...extra });
function seeded(items, conversations = []) {
  return makeBoardFixture({
    announcementOutbox: { origins: Object.fromEntries(items.map((i) => [i.o.mutationId, i.o])), entries: Object.fromEntries(items.map((i) => [i.e.obligationId, i.e])) },
    conversations,
  });
}
const item = (mut, mode, { entry = {}, origin = {}, ...rest } = {}) => ({ o: { ...originOf(mut, mode), ...origin }, e: { ...entryFor(mut, mode, entry, rest) } });
const withServer = async (board, env, body) => { const s = await startRestServer({ board, env }); try { return await body(s); } finally { await s.stop(); } };
// the server refuses to build the graph slice without a dataset id when an executor URL is set (#1567 fencing)
const FLAG = { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_DATASET_ID: 'g12-test' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g12-pub-'));
const at = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
// A fixed injected instant, deliberately far from the wall clock: a fix that mixes wall time into backoff shows up.
const NOW0 = '2031-01-01T00:00:00.000Z';

// ---- new helpers (gate 12)

/**
 * The publisher, ASYNCHRONOUSLY. (C3b's runPublisher uses spawnSync, which blocks this process's event loop; the proxy
 * and the executor stand-in below live in this process, so a sync spawn would deadlock them until the 15 s fetch
 * timeout.) Reusing `dir` reuses the key file AND the status file, which is where backoff state persists.
 */
function runPublisher(base, dir, extra = []) {
  const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
  const status = path.join(dir, 'publisher-status.json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISHER, '--board', base, '--key-file', key, '--status', status, '--once', ...extra], { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = []; child.stderr.on('data', (d) => err.push(String(d)));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 30000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let st = null; try { st = JSON.parse(fs.readFileSync(status, 'utf8')); } catch { /* none */ }
      resolve({ code, signal, err: err.join(''), status: st });
    });
  });
}

/**
 * A pass-through proxy in front of the board. It logs every POST /api/outbox/:id/publish (decoded id), and answers 500
 * itself — WITHOUT forwarding — for ids in `failIds`, or for every id NOT in `failAllExcept` when that is set.
 * Everything else (the outbox reads included) is forwarded unchanged.
 */
async function startProxy(targetBase) {
  const target = new URL(targetBase);
  const p = { log: [], failIds: new Set(), failAllExcept: null, failOutboxRead: false };
  p.server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (p.failOutboxRead && req.method === 'GET' && req.url.split('?')[0] === '/api/outbox') {
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"proxy-injected listing failure"}'); return;
      }
      const m = /^\/api\/outbox\/([^/?]+)\/publish$/.exec(req.url.split('?')[0]);
      if (req.method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        const fail = p.failIds.has(id) || (p.failAllExcept !== null && !p.failAllExcept.has(id));
        p.log.push({ id, injected500: fail });
        if (fail) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"proxy-injected failure"}'); return; }
      }
      const up = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.base = `http://127.0.0.1:${p.server.address().port}`;
  p.mark = () => p.log.length;
  p.since = (mark) => p.log.slice(mark).map((x) => x.id);
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
const withProxy = async (base, body) => { const p = await startProxy(base); try { return await body(p); } finally { await p.stop(); } };

/** One scan through the proxy; returns the run and the ids it POSTed /publish for, in order. */
async function scanVia(proxy, dir, extra = []) {
  const mark = proxy.mark();
  const run = await runPublisher(proxy.base, dir, extra);
  return { ...run, calls: proxy.since(mark) };
}
/** A COMPLETED scan: exit 0 even when entries failed (EXIT pin). */
const assertRan = (run, label) => {
  assert.equal(run.signal, null, `${label}: killed by ${run.signal}: ${run.err}`);
  assert.equal(run.code, 0, `${label}: exit ${run.code} (0 expected: a completed scan exits 0 even when entries failed; 1 = listing failed, 2 = argument rejected): ${run.err}`);
  assert.ok(run.status && typeof run.status === 'object', `${label}: no status file written`);
};
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Create a card and claim it through the board API: a NEW pending legacy obligation with a valid proof post. */
async function freshClaim(base, title) {
  const before = new Set((await outboxOf(base)).entries.map((e) => e.obligationId));
  const c = await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada' });
  assert.ok(c.status < 400, c.text);
  const cl = await api(base, 'POST', `/api/cards/${c.body.id}/claim`, { by: 'ada' });
  assert.equal(cl.status, 200, cl.text);
  const added = (await outboxOf(base)).entries.filter((e) => !before.has(e.obligationId) && e.status === 'pending').map((e) => e.obligationId);
  assert.ok(added.length >= 1, 'the claim committed a pending obligation');
  return added;
}

// ------------------------------------------------------------------ F1 more stuck entries than --batch
// TODAY: every scan takes the same three oldest stuck entries (each answers 200 'pending', which today is not even an
// error), so scan 2 re-attempts m-s1..m-s3 and m-new — the 6th oldest — is never reached in any number of scans.
// NOTE: under the BATCH pin (attempts per scan), a FRESH publisher cannot reach the 6th entry in ONE scan with
// --batch 3; the bound here is two scans: ceil((5 stuck + 1) / 3). Real clock, scans seconds apart (< the 60 s floor).
test('F1 five entries the board keeps PENDING plus one newer publishable entry, --batch 3: the newer one publishes by the second scan, and the stuck ones are not re-attempted inside their backoff', async () => {
  const seen = [];
  const bad = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"stand-in failure"}'); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const stuck = [1, 2, 3, 4, 5].map((n) => item(`m-s${n}`, 'publisher', { at: `2026-10-04T12:0${n}:00.000Z` }));
  const fresh = item('m-new', 'legacy', { entry: { legacyPostId: 'p-new' }, at: '2026-10-04T12:30:00.000Z' });
  // the board is MIGRATED (an epoch, a numbered post, a counter above it): a publisher-mode entry on a clean unmigrated board is held
  // pending with POST_SEQ_MIGRATION_REQUIRED and never reaches the executor (C3c G10), which would defeat what this row needs: stuck entries that
  // the executor stand-in is really asked about
  const board = { ...seeded([...stuck, fresh], [legacyPost('p-new', 'm-new', { postSeq: 1 })]), postSeqEpoch: '11111111-2222-4333-8444-555555555555', nextPostSeq: 2 };
  try {
    await withServer(board, { ...FLAG, SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${bad.address().port}` }, (s) => withProxy(s.baseUrl, async (proxy) => {
      const dir = tmp();
      const a = await scanVia(proxy, dir, ['--batch', '3']);
      assertRan(a, 'scan 1');
      assert.ok(seen.length >= 1, 'the executor stand-in was never asked: the stuck entries are not stuck for the stated reason');
      assert.deepEqual(a.calls, ['m-s1:claim', 'm-s2:claim', 'm-s3:claim'], 'scan 1: the three oldest, and no more than --batch');
      assert.equal(await statusOf(s.baseUrl, 'm-s1:claim'), 'pending', 'the board kept it pending (the fixture works)');

      const b = await scanVia(proxy, dir, ['--batch', '3']);
      assertRan(b, 'scan 2');
      assert.ok(b.calls.length <= 3, `scan 2 made ${b.calls.length} /publish calls with --batch 3`);
      for (const id of ['m-s1:claim', 'm-s2:claim', 'm-s3:claim']) assert.ok(!b.calls.includes(id), `scan 2 re-attempted ${id} inside its backoff: ${b.calls}`);
      assert.equal(await statusOf(s.baseUrl, 'm-new:claim'), 'published', `the newer entry is starved: scan 2 called ${b.calls}`);
      assert.equal(b.status.deferred, 3, 'the three backed-off entries are reported as deferred');
      assert.equal(b.status.attempted, b.calls.length, 'attempted equals the /publish calls the proxy counted');
    }));
  } finally { bad.close(); }
});

// ------------------------------------------------------------------ F2 a 5xx is counted, recorded, and passed
// TODAY: the 500 for m-old (the oldest) throws out of scan(); m-new is never asked for, there is no publishErrors, and
// the run exits 1 (the EXIT pin requires 0: the scan must complete).
test('F2 an OLDER entry whose /publish answers 500 does not stop the scan: the newer entry publishes, the failure is counted in publishErrors, and the run exits 0', async () => {
  const board = seeded([item('m-old', 'publisher', { at: '2026-10-04T12:01:00.000Z' }), item('m-new', 'publisher', { at: '2026-10-04T12:02:00.000Z' })]);
  await withServer(board, {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-old:claim');
    const r = await scanVia(proxy, tmp());
    assertRan(r, 'scan');
    assert.equal(await statusOf(s.baseUrl, 'm-new:claim'), 'published', `the scan stopped at the 5xx: calls ${r.calls}; ${r.err}`);
    assert.equal(await statusOf(s.baseUrl, 'm-old:claim'), 'pending', 'the board never saw the failed attempt');
    assert.equal(r.calls.filter((id) => id === 'm-old:claim').length, 1, 'a failing entry is attempted once per scan (no hot retry)');
    assert.ok(isCount(r.status.publishErrors), `publishErrors must be a count: ${JSON.stringify(r.status)}`);
    assert.equal(r.status.publishErrors, 1);
    assert.equal(r.status.attempted, 2);
    if (r.status.lastError !== null) assert.match(String(r.status.lastError), /m-old:claim/, 'a lastError, if set, names the failing entry');
    assert.equal(r.status.pendingCount, 1, 'the C3b fields are still written after a 5xx');
  }));
});

// ------------------------------------------------------------------ F3 an immediate rescan does not hit the failing entry first
// TODAY: scan 1 already exits 1 at the 500 (EXIT pin: 0); scan 2 POSTs m-old first, gets the 500 and throws again; the
// entry created between scans is never published.
test('F3 after a failing scan, an IMMEDIATE second scan does not re-attempt the failing entry (it is deferred), while an entry created between the scans publishes', async () => {
  const board = seeded([item('m-old', 'publisher', { at: '2026-10-04T12:01:00.000Z' }), item('m-new', 'publisher', { at: '2026-10-04T12:02:00.000Z' })]);
  await withServer(board, {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-old:claim');
    const dir = tmp();
    const a = await scanVia(proxy, dir);
    assertRan(a, 'scan 1');
    const added = await freshClaim(s.baseUrl, 'between scans');
    const b = await scanVia(proxy, dir);
    assertRan(b, 'scan 2');
    assert.equal(b.calls.filter((id) => id === 'm-old:claim').length, 0, `scan 2 re-attempted the failing entry inside its backoff: ${b.calls}`);
    for (const id of added) assert.equal(await statusOf(s.baseUrl, id), 'published', `${id} (created between scans) was not published: ${b.calls}`);
    assert.equal(b.status.deferred, 1);
    assert.equal(b.status.publishErrors, 0, 'nothing failed in scan 2: the deferred entry is not an error');
  }));
});

// ------------------------------------------------------------------ F4 NEGATIVE CONTROL — must PASS today and after the fix
// TODAY: passes (it pins only behaviour bf442db already has, through the proxy, with no new flag or field).
test('F4 control: with nothing failing, --batch 2 makes exactly two /publish calls, oldest first; an unbounded scan then publishes the rest oldest first', async () => {
  const items = ['e', 'd', 'c', 'b', 'a'].map((m, i) => item(`m-${m}`, 'publisher', { at: `2026-10-04T12:0${5 - i}:00.000Z` }));   // a is oldest
  await withServer(seeded(items), {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    const dir = tmp();
    const a = await scanVia(proxy, dir, ['--batch', '2']);
    assert.equal(a.code, 0, a.err);
    assert.deepEqual(a.calls, ['m-a:claim', 'm-b:claim'], 'exactly --batch attempts, oldest first');
    assert.equal(a.status.pendingCount, 3);
    assert.equal(a.status.lastError, null);
    const b = await scanVia(proxy, dir);
    assert.equal(b.code, 0, b.err);
    assert.deepEqual(b.calls, ['m-c:claim', 'm-d:claim', 'm-e:claim']);
    for (const m of ['a', 'b', 'c', 'd', 'e']) assert.equal(await statusOf(s.baseUrl, `m-${m}:claim`), 'published');
  }));
});

// ------------------------------------------------------------------ F5 backoff does not park an entry forever
// TODAY: exit 2 (--now is an unknown argument). Without that, today would re-attempt m-old on EVERY scan (no backoff),
// so the "not within its window" half fails too. This row mainly guards the fix against over-correcting.
test('F5 a backed-off entry is retried after its window passes and publishes once its fault has cleared (injected clock)', async () => {
  const board = seeded([item('m-old', 'publisher', { at: '2026-10-04T12:01:00.000Z' }), item('m-new', 'publisher', { at: '2026-10-04T12:02:00.000Z' })]);
  await withServer(board, {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-old:claim');
    const dir = tmp();
    const a = await scanVia(proxy, dir, ['--now', NOW0]);
    assertRan(a, 'scan at NOW0');
    proxy.failIds.clear();                                   // the fault clears; the BACKOFF does not know that
    const b = await scanVia(proxy, dir, ['--now', at(NOW0, 10_000)]);
    assertRan(b, 'scan at NOW0+10s');
    assert.equal(b.calls.filter((id) => id === 'm-old:claim').length, 0, 'still inside the >= 60 s first window');
    const c = await scanVia(proxy, dir, ['--now', at(NOW0, 25 * HOUR)]);
    assertRan(c, 'scan at NOW0+25h');
    assert.deepEqual(c.calls, ['m-old:claim'], 'past every possible window (<= 24 h): attempted again, exactly once');
    assert.equal(await statusOf(s.baseUrl, 'm-old:claim'), 'published', 'and it publishes now that the fault is gone');
    assert.equal(c.status.backoff?.['m-old:claim'], undefined, 'a published entry leaves the backoff map');
  }));
});

// ------------------------------------------------------------------ F6 the backoff reads the INJECTED clock
// TODAY: exit 2 (--now unknown), no `backoff` field in the status file, and no deferral at all.
test('F6 only --now moves between these scans (seconds of wall time): before nextAttemptAt the entry is skipped, AT nextAttemptAt it is attempted, and a new failure sets a later nextAttemptAt', async () => {
  const board = seeded([item('m-old', 'publisher')]);
  await withServer(board, {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-old:claim');                        // fails throughout
    const dir = tmp();
    const a = await scanVia(proxy, dir, ['--now', NOW0]);
    assertRan(a, 'scan at NOW0');
    const next1 = a.status.backoff?.['m-old:claim']?.nextAttemptAt;
    assert.ok(Number.isFinite(Date.parse(next1)), `status.backoff['m-old:claim'].nextAttemptAt: ${JSON.stringify(a.status.backoff)}`);
    assert.ok(Date.parse(next1) >= Date.parse(NOW0) + MIN, `first window is at least 60 s from the INJECTED now: ${next1}`);
    assert.ok(Date.parse(next1) <= Date.parse(NOW0) + 24 * HOUR, `and at most 24 h: ${next1}`);

    for (const t of [at(NOW0, 30_000), at(next1, -1)]) {
      const r = await scanVia(proxy, dir, ['--now', t]);
      assertRan(r, `scan at ${t}`);
      assert.deepEqual(r.calls, [], `inside the window at ${t}: no /publish call`);
      assert.equal(r.status.deferred, 1); assert.equal(r.status.attempted, 0); assert.equal(r.status.publishErrors, 0);
    }
    const c = await scanVia(proxy, dir, ['--now', next1]);
    assertRan(c, 'scan at nextAttemptAt');
    assert.deepEqual(c.calls, ['m-old:claim'], 'due AT nextAttemptAt (>=)');
    assert.equal(c.status.publishErrors, 1);
    const next2 = c.status.backoff?.['m-old:claim']?.nextAttemptAt;
    assert.ok(Date.parse(next2) > Date.parse(next1), `a second failure moves nextAttemptAt past the injected now: ${next1} -> ${next2}`);
  }));
});

// ------------------------------------------------------------------ F7 --batch counts ATTEMPTS; deferred entries are free
// TODAY: exit 2 (--now unknown). Without that, scan 2 would spend its batch on the two failing entries again and throw.
test('F7 with two entries in backoff, every scan inside their window makes ZERO calls for them and exactly --batch calls for the rest; attempted/deferred/publishErrors stay distinguishable', async () => {
  const items = [
    item('m-f1', 'publisher', { at: '2026-10-04T12:01:00.000Z' }), item('m-f2', 'publisher', { at: '2026-10-04T12:02:00.000Z' }),
    ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((m, i) => item(`m-${m}`, 'publisher', { at: `2026-10-04T12:1${i}:00.000Z` })),
  ];
  await withServer(seeded(items), {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-f1:claim'); proxy.failIds.add('m-f2:claim');
    const dir = tmp();
    const a = await scanVia(proxy, dir, ['--batch', '2', '--now', NOW0]);
    assertRan(a, 'scan 1');
    assert.deepEqual(a.calls, ['m-f1:claim', 'm-f2:claim'], 'no backoff yet: the two oldest, and the bound holds even when both fail');
    assert.deepEqual([a.status.attempted, a.status.deferred, a.status.publishErrors], [2, 0, 2]);

    const expectNext = [['m-p1:claim', 'm-p2:claim'], ['m-p3:claim', 'm-p4:claim'], ['m-p5:claim', 'm-p6:claim']];
    for (const [k, offset] of [10_000, 20_000, 50_000].entries()) {
      const r = await scanVia(proxy, dir, ['--batch', '2', '--now', at(NOW0, offset)]);
      assertRan(r, `scan at +${offset} ms`);
      assert.equal(r.calls.filter((id) => id === 'm-f1:claim' || id === 'm-f2:claim').length, 0, `a backed-off entry was called inside its window: ${r.calls}`);
      assert.deepEqual(r.calls, expectNext[k], 'deferred entries do not consume the batch: exactly two attempts on the rest, oldest first');
      assert.deepEqual([r.status.attempted, r.status.deferred, r.status.publishErrors], [2, 2, 0]);
    }
    for (const m of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) assert.equal(await statusOf(s.baseUrl, `m-${m}:claim`), 'published');
  }));
});

// ------------------------------------------------------------------ F8 fresh failures cannot starve an eligible entry
// TODAY: exit 2 (--now unknown). Without that, every scan throws at the oldest failing claim; the target is never asked.
// A fix with backoff + pure oldest-first ALSO fails this row: with --batch 1 and one fresh failure older than the target
// arriving before every scan, the fresh one always sorts first. Some fairness rule beyond backoff is required (the rule
// itself is not pinned). The target's occurredAt is set far in the future ONLY so every fresh claim sorts before it.
test('F8 a fresh failing entry appears before EVERY --batch 1 scan, each older than the eligible target; the target still publishes within 5 scans', async () => {
  const board = seeded([item('m-target', 'publisher', { at: '2099-01-01T00:00:00.000Z' })]);
  await withServer(board, {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failAllExcept = new Set(['m-target:claim']);        // every OTHER publish fails, including each fresh claim
    const dir = tmp();
    const history = [];
    let published = false;
    for (let k = 1; k <= 5 && !published; k++) {
      await freshClaim(s.baseUrl, `fresh failure ${k}`);
      const r = await scanVia(proxy, dir, ['--batch', '1', '--now', at(NOW0, k * 10_000)]);   // all inside any >= 60 s window
      assertRan(r, `scan ${k}`);
      assert.ok(r.calls.length <= 1, `--batch 1 made ${r.calls.length} calls`);
      history.push(r.calls);
      published = (await statusOf(s.baseUrl, 'm-target:claim')) === 'published';
    }
    assert.ok(published, `the eligible entry was starved by fresh failures across 5 scans: ${JSON.stringify(history)}`);
  }));
});

// ------------------------------------------------------------------ F0 --now must be a full, calendar-valid ISO timestamp
// TODAY: the INVALID half passes vacuously (every --now is an unknown argument => exit 2, no calls). The VALID twin fails
// today (exit 2), so the row as a whole fails until --now exists AND is checked strictly — a lenient Date.parse would
// accept 2031-02-31 (V8 rolls it to March 3) and 2031-01-01 and fail the invalid half.
const INVALID_NOW = ['2031-02-31T00:00:00.000Z', '2031-13-01T00:00:00.000Z', '2030-02-29T00:00:00.000Z', '2031-01-01', '2031-01-01T00:00:00', 'yesterday', ''];
test('F0 an invalid --now (Feb 31, month 13, non-leap Feb 29, date-only, zone-less, prose, empty) exits 2 with ZERO /publish calls; a valid leap-day offset timestamp is accepted', async () => {
  await withServer(seeded([item('m-p', 'publisher')]), {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    for (const bad of INVALID_NOW) {
      const r = await scanVia(proxy, tmp(), ['--now', bad]);
      assert.equal(r.code, 2, `--now ${JSON.stringify(bad)} must be rejected (exit 2), got ${r.code}: ${r.err}`);
      assert.deepEqual(r.calls, [], `--now ${JSON.stringify(bad)}: no /publish call may be made`);
    }
    assert.equal(await statusOf(s.baseUrl, 'm-p:claim'), 'pending', 'nothing was published by a rejected run');
    const ok = await scanVia(proxy, tmp(), ['--now', '2032-02-29T00:00:00.000+00:00']);
    assertRan(ok, 'valid leap-day --now');
    assert.deepEqual(ok.calls, ['m-p:claim']);
    assert.equal(await statusOf(s.baseUrl, 'm-p:claim'), 'published');
  }));
});

// ------------------------------------------------------------------ F9 the 24 h ceiling under repeated failure
// TODAY: exit 2 (--now unknown) and no `backoff` field. This row catches an unbounded exponential schedule.
test('F9 an entry that fails 20 times in a row, each scan at the previous nextAttemptAt: every window is >= 60 s and <= 24 h past that scan\'s injected now, and each scan attempts it exactly once', async () => {
  await withServer(seeded([item('m-old', 'publisher')]), {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-old:claim');
    const dir = tmp();
    let now = NOW0;
    const windows = [];
    for (let k = 1; k <= 20; k++) {
      const r = await scanVia(proxy, dir, ['--now', now]);
      assertRan(r, `failure ${k} at ${now}`);
      assert.deepEqual(r.calls, ['m-old:claim'], `scan ${k} at its due time attempts the entry exactly once`);
      assert.equal(r.status.publishErrors, 1);
      const next = r.status.backoff?.['m-old:claim']?.nextAttemptAt;
      assert.ok(Number.isFinite(Date.parse(next)), `failure ${k}: nextAttemptAt ${JSON.stringify(next)}`);
      const w = Date.parse(next) - Date.parse(now);
      windows.push(w);
      assert.ok(w >= MIN, `failure ${k}: window ${w} ms is under the 60 s floor`);
      assert.ok(w <= 24 * HOUR, `failure ${k}: window ${w} ms exceeds the 24 h ceiling (windows so far ${windows})`);
      now = next;
    }
  }));
});

// ------------------------------------------------------------------ F10 a BLOCKED entry leaves the backoff map
// TODAY: exit 2 (--now unknown) and no `backoff` field.
// Both entries are legacy with a proof that names no post, so the BOARD will block them (legacy-proof-missing, as C3b L3).
// The proxy 500s both first, so they enter backoff while still pending. Then m-b is blocked OUT OF BAND (a direct
// /publish to the board, bypassing the proxy) while it waits, and m-a is blocked by the publisher's own due attempt.
test('F10 an entry in backoff that becomes BLOCKED — by its own due attempt, or out of band while it waited — is not in `backoff` after the next due scan', async () => {
  const board = seeded([
    item('m-a', 'legacy', { entry: { legacyPostId: 'ghost-a' }, at: '2026-10-04T12:01:00.000Z' }),
    item('m-b', 'legacy', { entry: { legacyPostId: 'ghost-b' }, at: '2026-10-04T12:02:00.000Z' }),
  ]);
  await withServer(board, {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failIds.add('m-a:claim'); proxy.failIds.add('m-b:claim');
    const dir = tmp();
    const a = await scanVia(proxy, dir, ['--now', NOW0]);
    assertRan(a, 'scan at NOW0');
    for (const id of ['m-a:claim', 'm-b:claim']) {
      assert.ok(a.status.backoff?.[id], `${id} entered backoff: ${JSON.stringify(a.status.backoff)}`);
      assert.equal(await statusOf(s.baseUrl, id), 'pending', 'the board never saw the injected failure');
    }
    const direct = await api(s.baseUrl, 'POST', `/api/outbox/${encodeURIComponent('m-b:claim')}/publish`, {});
    assert.equal(direct.body?.status, 'blocked', `the out-of-band block: ${direct.text}`);
    proxy.failIds.clear();
    const b = await scanVia(proxy, dir, ['--now', at(NOW0, 25 * HOUR)]);
    assertRan(b, 'due scan at NOW0+25h');
    assert.deepEqual(b.calls, ['m-a:claim'], 'm-a is due and attempted; m-b is no longer pending, so it is not called');
    assert.equal(await statusOf(s.baseUrl, 'm-a:claim'), 'blocked', 'the board blocked m-a on the due attempt');
    assert.equal(b.status.backoff?.['m-a:claim'], undefined, 'blocked by its own due attempt: out of backoff');
    assert.equal(b.status.backoff?.['m-b:claim'], undefined, 'blocked out of band while waiting: out of backoff');
    assert.equal(b.status.publishErrors, 0, 'a blocked answer is an outcome, not an error');
    assert.equal(b.status.blockedCount, 2);
  }));
});

// ------------------------------------------------------------------ F11 CONTROL — exit 1 is reserved for a failed LISTING
// TODAY: passes (readOutbox throws on a non-200 listing => exit 1). Pinned so the fix's "per-entry failures exit 0" cannot
// swallow a failed listing too. Its twin is F2 (a per-entry 5xx exits 0).
test('F11 control: a non-2xx on GET /api/outbox exits 1 with ZERO /publish calls and a lastError, even though entries are pending', async () => {
  await withServer(seeded([item('m-p', 'publisher')]), {}, (s) => withProxy(s.baseUrl, async (proxy) => {
    proxy.failOutboxRead = true;
    const r = await scanVia(proxy, tmp());
    assert.equal(r.signal, null, r.err);
    assert.equal(r.code, 1, `a failed listing must exit 1, got ${r.code}: ${r.err}`);
    assert.deepEqual(r.calls, []);
    assert.equal(typeof r.status?.lastError, 'string'); assert.ok(r.status.lastError.length > 0);
    assert.equal(await statusOf(s.baseUrl, 'm-p:claim'), 'pending');
  }));
});
