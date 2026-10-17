/**
 * #1645 slice 1 — THE HEALTH-READINESS CONTRACT. TEST AUTHOR's, written before the build (RED on 5571451).
 *
 * Today (server.js handleHealth at 5571451) `graph.ready` means "the in-process replica exists and has synced once", and a health probe on a quiet box
 * kicks the replica build. deploy.sh waits up to 80 s, polling `curl --max-time 3`, for `"ready":true`. The replica is going (#1645), so readiness must
 * mean something that survives it. The contract (card thread: H1 to H5 proposed 43161, accepted by the PO 43165; design settled 43167 on the code
 * reviewer's recommendation 43164, with her qualification 43168 on H4):
 *
 *   H1  graph.ready is true exactly when the executor has answered a position read with a well-formed epoch:commitSeq; the replica does not enter into it
 *   H2  health states that position and when it was read: graph.position "E:S", graph.positionReadAt, graph.positionAgeMs
 *   H3  executor down, refusing or returning a malformed marker -> graph.ready false with a reason; it answers again -> true, with no REST restart
 *   H4  an executor that accepts the request and never answers does not hang health: each probe answers within 1 s (the hanging-executor case ONLY;
 *       no claim is made for a blocked REST event loop)
 *   H5  health builds no replica and reads no board document
 *   SF  probes that arrive together share one position read (the settled design: a fresh read per probe, bounded, single-flight)
 *
 * The bounds are written so that a cached design would pass too (the design was still open when they were drafted): ready turns false within 5 s of
 * the executor failing and true within 5 s of its recovery, a ready:true never carries a position older than 10 s, and a burst of concurrent probes
 * makes AT MOST one position read (P5 now pins EXACTLY one: the design settled on a fresh read per probe, 43167).
 *
 *   P1  H1+H2  reachable executor: ready, and the position equals the executor's own marker (read directly), with its read time and age
 *   P2  H3     the executor refuses connections: false with a reason; it comes back: true, same REST pid
 *   P3  H3     the marker read returns no row (malformed): false with a reason; it is well-formed again: true
 *   P4  H4     the executor hangs: every probe still answers within 1 s, and ready is false; released: true
 *   P5  SF     ten concurrent probes, the position read GATED until all ten are written (CI 034c761 showed an ungated read can finish before a slow
 *              runner's last probes arrive): every one says ready with the executor's position, and the executor saw EXACTLY one position read
 *   P6a H5     every file attempt recorded (tests/helpers/fs-store-recorder.mjs with SCRUM_FS_RECORD_ALL=1): ten probes after boot, then ten with the
 *              executor refusing, make ZERO attempts on the board document FILE, caught errors included (43169). RED at 5571451 once its window opens
 *              before the first probe (an earlier draft opened it after a precondition probe and passed there: the first probe's attempts fell outside
 *              the count). The executor-refusing half also covers the fallback the design rules out (43164): reading the file when the executor fails.
 *   P6b H5     the board document made unreadable after boot: health still says ready, and no replica build is logged (the red row for H5)
 *
 * NOT covered, by name: what the reason says (only that one is given); a blocked REST event loop; the deploy loop itself (its grep for
 * `"ready":true` is unchanged by this contract); the other #1645 consumers (vocabulary, shapes, census, meter, snapshots); a cold start with
 * board-data.json absent (the card's DONE WHEN, later); how the position read is implemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Q_POSITION } from '../core/logborn-unit.mjs';
import { SKIP, DSID, ROSTER_FILE, smallBoard, migrate, withOwned, startExecutor, killExecutor, startRestServer } from './helpers/ready-world-1644.mjs';

const isPositionRead = (body) => /commitSeq/.test(body);

/** A proxy in front of the executor. mode: 'pass' | 'refuse' (every connection destroyed) | 'hold' (nothing is answered) | 'malformed' (a position read answers zero rows) | 'gate' (a position read waits for openGate(), then is answered normally). Counts position reads. */
async function startExecProxy(execUrl) {
  const p = { mode: 'pass', positionReads: 0, held: [], gateWaiters: [] };
  p.server = http.createServer(async (req, res) => {
    if (p.mode === 'refuse') { req.socket.destroy(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const pos = req.method === 'POST' && req.url.startsWith('/query') && isPositionRead(body);
    if (pos) p.positionReads += 1;
    if (p.mode === 'hold') { p.held.push(res); return; }
    if (p.mode === 'gate' && pos) await new Promise((r) => p.gateWaiters.push(r));   // in flight until the row opens the gate
    if (p.mode === 'malformed' && pos) { res.writeHead(200, { 'content-type': 'application/sparql-results+json' }); res.end(JSON.stringify({ head: { vars: ['e', 'seq'] }, results: { bindings: [] } })); return; }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const out = Buffer.from(await f.arrayBuffer());
      res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/octet-stream' }); res.end(out);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.openGate = () => { p.mode = 'pass'; for (const r of p.gateWaiters.splice(0)) r(); };
  p.release = () => { const hs = p.held.splice(0); for (const r of hs) { try { r.destroy(); } catch { /* gone */ } } };
  p.down = () => new Promise((r) => { p.release(); p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

/** The executor's own position, read directly (not through the proxy, not through REST). */
async function executorMarker(execUrl) {
  const r = await fetch(`${execUrl}/query`, { method: 'POST', body: Q_POSITION, signal: AbortSignal.timeout(10000) });
  const b = JSON.parse(await r.text())?.results?.bindings;
  assert.equal(b?.length, 1, 'PRECONDITION: the executor has exactly one commit marker');
  return `${b[0].e.value}:${b[0].seq.value}`;
}

const RECORDER = path.resolve(import.meta.dirname, 'helpers/fs-store-recorder.mjs');

async function setup(body, { record = false } = {}) {
  return withOwned(async (own) => {
    const store = own.dir('h45-store-');
    const exec = await startExecutor({ store, datasetId: DSID, create: true }); own.adopt(() => killExecutor(exec));
    const dir = own.dir('h45-board-'); const boardFile = path.join(dir, 'board.json');
    fs.writeFileSync(boardFile, JSON.stringify(smallBoard(), null, 2));
    const m = await migrate(boardFile, exec.baseUrl); assert.equal(m.code, 0, `PRECONDITION: the cards are in the executor (exit ${m.code}): ${m.out.slice(0, 300)}`);
    const proxy = await startExecProxy(exec.baseUrl); own.adopt(async () => { try { await proxy.down(); } catch { /* down */ } });
    own.adopt(async () => { try { fs.chmodSync(boardFile, 0o644); } catch { /* gone */ } });
    const rec = record ? path.join(own.dir('h45-rec-'), 'opened.txt') : null;
    if (rec) fs.writeFileSync(rec, '');
    const recEnv = rec ? { SCRUM_FS_RECORD: rec, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${RECORDER}` } : {};
    const rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...recEnv } });
    own.adopt(() => rest.stop());
    const health = async () => {
      const t0 = Date.now();
      const r = await fetch(`${rest.baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });   // deploy's curl gives up at 3 s
      return { ms: Date.now() - t0, status: r.status, j: await r.json() };
    };
    const until = async (pred, ms, what) => {
      const end = Date.now() + ms; let last = null;
      while (Date.now() < end) { last = await health(); if (pred(last.j)) return last; await new Promise((r) => setTimeout(r, 200)); }
      assert.fail(`${what} within ${ms} ms; last health graph was ${JSON.stringify(last?.j?.graph)}`);
    };
    return body({ exec, proxy, rest, boardFile, rec, health, until });
  });
}
const reasonOf = (g) => g?.reason ?? g?.notReadyReason ?? g?.why ?? g?.error;

test('#1645 (P1, H1+H2) a reachable executor: ready, with the executor\'s own position, when it was read, and its age', { skip: SKIP, timeout: 180000 }, async () => {
  await setup(async ({ exec, until }) => {
    const want = await executorMarker(exec.baseUrl);
    const { j } = await until((x) => x?.graph?.ready === true, 5000, 'health says graph.ready true');
    assert.match(String(j.graph.position), /^\d+:\d+$/, `graph.position is a well-formed epoch:commitSeq (got ${JSON.stringify(j.graph.position)})`);
    assert.equal(j.graph.position, want, 'and it is the executor\'s own marker, read directly');
    assert.ok(!Number.isNaN(Date.parse(j.graph.positionReadAt)), `graph.positionReadAt is a time (got ${JSON.stringify(j.graph.positionReadAt)})`);
    assert.ok(Number.isFinite(j.graph.positionAgeMs) && j.graph.positionAgeMs >= 0 && j.graph.positionAgeMs <= 10000, `graph.positionAgeMs is present and at most 10 s (got ${JSON.stringify(j.graph.positionAgeMs)})`);
  });
});

for (const [row, mode, what] of [['P2', 'refuse', 'refuses connections'], ['P3', 'malformed', 'returns no marker row']]) {
  test(`#1645 (${row}, H3) the executor ${what}: ready false with a reason; when it answers again, ready true with no REST restart`, { skip: SKIP, timeout: 180000 }, async () => {
    await setup(async ({ proxy, until }) => {
      const first = await until((x) => x?.graph?.ready === true, 5000, 'PRECONDITION: ready while the executor answers');
      proxy.mode = mode;
      const down = await until((x) => x?.graph?.ready === false, 5000, `graph.ready false once the executor ${what}`);
      const why = reasonOf(down.j.graph);
      assert.ok(typeof why === 'string' && why.trim().length > 0, `and a reason is given (graph was ${JSON.stringify(down.j.graph)})`);
      proxy.mode = 'pass';
      const back = await until((x) => x?.graph?.ready === true, 5000, 'graph.ready true again once the executor answers');
      assert.equal(back.j.pid, first.j.pid, 'the same REST process: no restart was needed');
    });
  });
}

test('#1645 (P4, H4) an executor that never answers does not hang health: every probe answers within 1 s, ready is false; released, ready is true', { skip: SKIP, timeout: 180000 }, async () => {
  await setup(async ({ proxy, health, until }) => {
    await until((x) => x?.graph?.ready === true, 5000, 'PRECONDITION: ready while the executor answers');
    proxy.mode = 'hold';
    const times = []; let sawFalse = false;
    for (let i = 0; i < 8; i++) {
      const h = await health(); times.push(h.ms);
      assert.equal(h.status, 200, 'health still answers 200');
      if (h.j?.graph?.ready === false) sawFalse = true;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(times.every((ms) => ms < 1000), `every probe answered within 1 s while the executor hung (ms: ${times.join(', ')})`);
    assert.equal(sawFalse, true, 'and ready turned false while it hung');
    // probes that join a read in flight share ITS deadline, never a fresh one each (43169): a staggered burst all answers within 1 s of the FIRST
    const t0 = Date.now();
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((r) => setTimeout(r, i * 100)).then(() => health())));
    const lastDone = Date.now() - t0;
    assert.ok(burst.every((h) => h.status === 200 && h.j?.graph?.ready === false), `every probe of a staggered burst said ready false (got ${JSON.stringify(burst.map((h) => h.j?.graph?.ready))})`);
    // 1150 ms (was 1500; the builder's note, 43199): one SHARED 800 ms read ends the whole burst near 800 ms; a fresh 800 ms read per joiner
    // (staggered over 500 ms) ends near 1300 ms. 1500 could not tell them apart; 1150 can, with room either side.
    assert.ok(lastDone < 1150, `and the whole burst (started over 500 ms) finished within 1.15 s of its first probe: joiners shared the first read's deadline (${lastDone} ms)`);
    proxy.mode = 'pass'; proxy.release();
    await until((x) => x?.graph?.ready === true, 5000, 'graph.ready true once the executor answers again');
  });
});

test('#1645 (P5, SF) ten concurrent probes share one position read, and each says ready with the executor\'s position', { skip: SKIP, timeout: 180000 }, async () => {
  await setup(async ({ exec, proxy, rest, until }) => {
    await until((x) => x?.graph?.ready === true, 5000, 'PRECONDITION: ready');
    const want = await executorMarker(exec.baseUrl);
    await new Promise((r) => setTimeout(r, 1500));   // let any read already under way finish
    // the position read is GATED, so it stays in flight while all ten probes arrive (CI 034c761 failed this row with the read answered in a
    // few ms: a slow runner's later probes came after it finished and correctly started a second one; the row measured runner timing,
    // not the join). The gate opens 400 ms after the first read reaches the executor, well inside health's 800 ms bound, so a correct
    // join makes exactly one read on any runner, and no single-flight still makes up to ten.
    // The gate opens once every probe has been fully WRITTEN to its socket (the client-side edge of "arrived at REST", 43353), plus 100 ms
    // for REST to parse them, and never later than 700 ms after the first read, so always inside the 800 ms bound.
    const before = proxy.positionReads;
    proxy.mode = 'gate';
    const t0 = Date.now(); let written = 0;
    const probe = () => new Promise((resolve, reject) => {
      const rq = http.request(`${rest.baseUrl}/api/health`, { method: 'GET', agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve({ j: JSON.parse(b) }); } catch (e) { reject(e); } }); });
      rq.on('finish', () => { written += 1; }); rq.on('error', reject); rq.end();
    });
    const burst = Promise.all(Array.from({ length: 10 }, probe));
    while (written < 10 && Date.now() - t0 < 600) await new Promise((r) => setTimeout(r, 5));
    assert.equal(written, 10, `PRECONDITION: all ten probes were written within 600 ms (${written})`);
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(100, 700 - (Date.now() - t0)))));
    proxy.openGate();
    const hs = await burst;
    const reads = proxy.positionReads - before;
    assert.ok(hs.every((h) => h.j?.graph?.ready === true && h.j.graph.position === want), `every concurrent probe says ready at ${want} (got ${JSON.stringify(hs.map((h) => [h.j?.graph?.ready, h.j?.graph?.position]))})`);
    assert.equal(reads, 1, `a burst of 10 concurrent probes made exactly one position read on the executor (made ${reads})`);
  });
});

test('#1645 (P6a, H5) health makes ZERO attempts on the board document after boot: every attempt is recorded, none falls in the probing window', { skip: SKIP, timeout: 180000 }, async () => {
  await setup(async ({ proxy, boardFile, rec, health }) => {
    // the window opens BEFORE the first health probe: a probe that triggers a read must not do so before the counting starts (the M5 lesson)
    await new Promise((r) => setTimeout(r, 1500));   // let boot's own reads settle first
    const attempts = () => fs.readFileSync(rec, 'utf8').split('\n').filter((l) => l.trim() === fs.realpathSync(boardFile) || l.trim() === boardFile).length;
    const before = attempts();
    // CONTROL: the recorder is live in this process. A recorder that records nothing would pass this row in any world. (Not "boot read the board
    // document": the card's goal is a boot that does not, and this row must not start failing when that lands.)
    assert.ok(fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).length > 0, 'CONTROL: the recorder recorded this process\'s file attempts');
    for (let i = 0; i < 10; i++) { await health(); await new Promise((r) => setTimeout(r, 400)); }
    const during = attempts() - before;
    assert.equal(during, 0, `ten health probes made ${during} attempt(s) on the board document (counted per attempt, caught errors included)`);
    // and with the executor DOWN: the place a "document fallback" would appear (ruled out, 43164)
    proxy.mode = 'refuse';
    for (let i = 0; i < 10; i++) { await health(); await new Promise((r) => setTimeout(r, 400)); }
    const whileDown = attempts() - before - during;
    assert.equal(whileDown, 0, `ten probes with the executor refusing made ${whileDown} attempt(s) on the board document: no fallback to the document`);
  }, { record: true });
});

test('#1645 (P6b, H5) with the board document unreadable after boot, health still says ready and logs no replica build', { skip: SKIP, timeout: 180000 }, async () => {
  await setup(async ({ rest, boardFile, health }) => {
    // the log window opens BEFORE the first health probe. Found by mutation (M5, the warm kick restored): with a precondition probe first, that
    // probe kicked the build and its lines landed before the mark, so the row passed a build that still constructs the replica.
    await new Promise((r) => setTimeout(r, 1500));
    const mark = rest.stderr().length;
    fs.chmodSync(boardFile, 0o000);
    assert.throws(() => fs.readFileSync(boardFile), /EACCES/, 'PRECONDITION: the board document is now unreadable to this user');
    let last = null;
    for (let i = 0; i < 10; i++) { last = await health(); await new Promise((r) => setTimeout(r, 400)); }
    assert.equal(last.j?.graph?.ready, true, `health says ready from the executor alone (graph was ${JSON.stringify(last.j?.graph)})`);
    const after = rest.stderr().slice(mark);
    const bad = after.split('\n').filter((l) => /graph-replica:|warm kick|EACCES|board\.json/.test(l));
    assert.deepEqual(bad, [], 'no replica build and no board-document read was logged while health was probed');
  });
});
