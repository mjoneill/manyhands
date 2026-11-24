/**
 * #1659 — a slow card write says WHERE its time went. Rows written BEFORE the build, against the contract on the card (amended with the phase map of
 * a locked card write: lockWait → refresh → closure → executorUpdate → postCommit). REST with the cards unit on and a REAL executor behind a proxy that can
 * hold ONE chosen call for a known time; the postCommit stall uses the existing test seam (a FIFO named `after-events` under SCRUM_TEST_BARRIER_DIR), so no
 * production code is touched to cause it.
 *
 * THE LINE (stderr, one per slow card-WRITE request, never per executor call):
 *     <iso time> card-write slow: <total>ms rid=<rid> lockWait=<ms> refresh=<ms> executorUpdate=<ms> postCommit=<ms> attempts=<n> ...
 * phases are integers >= 0 in ms, and their SUM IS <= <total> (the rest is `closure`, the handler staging, deliberately unnamed); `rid` is the same id the executor
 * meter's own slow line carries for that request; `attempts` is 2 when a CARD_WRITE_CONFLICT re-ran refresh -> commit -> postCommit, and each phase is then
 * the SUM over attempts. Threshold: SCRUM_CARD_WRITE_SLOW_MS, default 1000. No card content, no query text; bounded length; a write below the threshold writes NO line.
 *
 *   P0 CONTROL     a normal write under a 300 ms threshold: 200, the executor saw its update, and NO `card-write slow:` line
 *   P1             a held executor update lands in executorUpdate and in no other phase; ONE line; attempts=1; sum <= total
 *   P2             a write queued behind a held one carries the wait in lockWait, and the held one carries its own time in executorUpdate
 *   P3             a forced CARD_WRITE_CONFLICT (a second REST wrote the card first) gives attempts=2, and a held cache reload lands in refresh (sum over attempts)
 *   P3-CONTROL     the same conflict with nothing held: attempts=2 and refresh is small (so refresh is not simply always large)
 *   P4             a stall AFTER the events are appended (the FIFO seam) lands in postCommit and in no other phase
 *   P5             default threshold: a 500 ms write writes no line; a 1400 ms write writes one
 *   P6             the line joins the executor meter's slow line by rid, and rid is not '-'
 *   P7             no card content in the line, and the line is bounded (< 400 chars)
 *   P8             a client that gives up while the write is held (its socket closes before the response) still gets its line: the slow writes an impatient client abandons are the ones that matter most
 *
 * #1680 — COUNTING ONLY THE ROW'S OWN LINES. A row's setup write can cross the threshold by itself on a loaded host, and CI went red that way at
 * P0, P2, P3, P7 and P8. So (a) every setup write is now held just past the row's threshold, making that the DEFAULT condition, not a 1-in-30 one,
 * and (b) every row counts only the lines after its FENCE (`fence()`: a stderr line REST writes before it answers, so lines before it are the
 * setup's). P0 and P5's "no line" halves now say what the contract says: no line for a write that FINISHED under the threshold, and any line
 * that is written reports at least the threshold (a changed test contract for those two rows, not a change to the server).
 *
 * NOT covered, by name: the readGate state field (the harness REST may run without a read gate), reads, the executor meter's own lines (unchanged), a conflict that survives its retry
 * (the write is refused: attempts would be 2 on a refused write; no row), COLLECTIONS/COLUMNS-only writes (they share the phases but have no row), what the 6-15 s turns out to be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `cwp-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

/** A proxy in front of the executor that can HOLD one call: the next `/update`, or the next cache load (the query that reads every card's stored JSON). */
async function holdProxy(execUrl) {
  const state = { holdUpdate: 0, holdLoad: 0, updates: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      let hold = 0;
      if (req.url === '/update') { state.updates++; hold = state.holdUpdate; state.holdUpdate = 0; }
      else if (state.holdLoad && /entityJson/.test(body.toString()) && /Card/.test(body.toString())) { hold = state.holdLoad; state.holdLoad = 0; }
      if (hold) await sleep(hold);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      try {
        const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
        const t = await f.text();
        res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
      } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

const ENV = (extra) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'cwp', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...extra });
/** opts: cardSlow / meterSlow (ms, absent = unset), barrier (a dir for the FIFO seam). The body gets startSecond(): a second REST on the same executor. */
async function world(opts, body) {
  const exec = await startExecutor({ store: tmpStore('cwp-'), datasetId: 'cwp', create: true });
  const proxy = await holdProxy(exec.baseUrl);
  const thresholds = { ...(opts.cardSlow != null ? { SCRUM_CARD_WRITE_SLOW_MS: String(opts.cardSlow) } : {}), ...(opts.meterSlow != null ? { SCRUM_EXECUTOR_METER_SLOW_MS: String(opts.meterSlow) } : {}) };
  const barrier = opts.barrier ? { SCRUM_TEST_BARRIER_DIR: opts.barrier } : {};
  const rest = await startRestServer({ board: makeBoardFixture(), env: ENV({ SCRUM_GRAPH_EXECUTOR_URL: proxy.url, ...thresholds, ...barrier }) });
  let second = null;   // started LATE by the row (after the card exists), so its boot-time cache holds the card
  const startSecond = async () => { second = await startRestServer({ board: makeBoardFixture(), env: ENV({ SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl }) }); return second; };
  // #1680 — EVERY SETUP WRITE IS SLOW, ON PURPOSE: the row's setup card write is held just past the row's threshold, so it ALWAYS writes
  // a card-write line of its own. On a loaded host that happens by itself (P0, P2, P3, P7, P8 went red in CI that way); here it is the
  // default condition, so a row that counts a line it did not mean to count fails on every run, not one run in thirty.
  WORLD = { proxy, setupHold: (opts.cardSlow ?? 1000) + 150 };
  try { return await body({ rest, base: rest.baseUrl, proxy, startSecond }); } finally { WORLD = null; await rest.stop(); if (second) await second.stop(); proxy.close(); await killExecutor(exec); }
}
let WORLD = null;
const mkCard = async (base, title) => {
  WORLD.proxy.state.holdUpdate = WORLD.setupHold;
  const r = await api(base, 'POST', '/api/cards', { title, createdBy: 'ada' });
  assert.equal(WORLD.proxy.state.holdUpdate, 0, 'CONTROL: the setup write reached the executor and its hold fired (no hold is left over for the row)');
  return r.body;
};
const patch = (base, id, fields) => api(base, 'PATCH', `/api/cards/${id}`, { by: 'ada', ...fields });
const lines = (rest) => rest.stderr().split('\n').filter((l) => /card-write slow:/.test(l));
const parse = (line) => {
  const m = line.match(/card-write slow:\s+(\d+)ms\b(.*)$/); assert.ok(m, `a line shaped "card-write slow: <n>ms key=value ...": ${line.slice(0, 200)}`);
  const kv = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map(([, k, v]) => [k, v]));
  return { total: Number(m[1]), kv, num: (k) => { assert.match(String(kv[k]), /^\d+$/, `${k} is a non-negative integer (got ${kv[k]})`); return Number(kv[k]); } };
};
const phases = (p) => ({ lockWait: p.num('lockWait'), refresh: p.num('refresh'), executorUpdate: p.num('executorUpdate'), postCommit: p.num('postCommit'), attempts: p.num('attempts') });
const sumOf = (ph) => ph.lockWait + ph.refresh + ph.executorUpdate + ph.postCommit;
/** #1680 — THE FENCE. A row's own lines are the card-write lines written AFTER its fence: an unsupported list parameter makes REST write
 *  `[card-query] … unsupported=<tag>` to stderr before it answers, and one process's lines reach one pipe in order, so once the fence line
 *  is SEEN every line written before it (the setup's) has arrived and lies before it. Counting by position, not by time: no sleep can race it. */
let FENCES = 0;
const fence = async (rest, base) => {
  const tag = `cwpfence${process.pid}n${++FENCES}`;
  await api(base, 'GET', `/api/cards?${tag}=1`);
  await rest.waitForStderr(new RegExp(`unsupported=${tag}\\b`), 8000);
  return tag;
};
const linesAfter = (rest, tag) => { const s = rest.stderr(); const i = s.indexOf(`unsupported=${tag}`); assert.ok(i >= 0, `the fence ${tag} is in stderr`); return s.slice(i).split('\n').filter((l) => /card-write slow:/.test(l)); };
const waitLines = async (rest, tag, n, ms = 4000) => { const t0 = Date.now(); while (linesAfter(rest, tag).length < n && Date.now() - t0 < ms) await sleep(50); return linesAfter(rest, tag); };
const SMALL = 250;   // a phase nobody stalled stays under this, even on a loaded host

test('P0 CONTROL: a normal write under a 300 ms threshold answers 200, the executor saw its update, and no card-write line is written', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy }) => {
    const c = await mkCard(base, 'p0 control'); const f = await fence(rest, base); const before = proxy.state.updates;
    const t0 = performance.now(); const r = await patch(base, c.id, { title: 'p0 control renamed' }); const took = performance.now() - t0;
    assert.equal(r.status, 200, r.text.slice(0, 160)); assert.ok(proxy.state.updates > before, 'CONTROL: the write reached the executor through the proxy');
    await sleep(600); const mine = linesAfter(rest, f);
    // #1680 — the contract is "a write BELOW the threshold writes no line". On a loaded host the row's own unheld write can itself take 300 ms
    // (CI: 334 ms with executorUpdate=23); then a line is RIGHT. So: a write the client saw finish under the threshold writes none, and any line
    // that is written says the write took at least the threshold. An always-log regression still fails on the common, fast run.
    if (took < 300) assert.equal(mine.length, 0, `no line for a write that finished in ${Math.round(took)} ms: ${mine.join(' | ').slice(0, 300)}`);
    assert.ok(mine.length <= 1, `at most one line for one request: ${mine.join(' | ').slice(0, 300)}`);
    for (const l of mine) assert.ok(parse(l).total >= 300, `a line is written only for a write that took the threshold: ${l.slice(0, 200)}`);
  });
});

test('P1 a held executor update lands in executorUpdate and in no other phase; ONE line; attempts=1; the sum is <= the total', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy }) => {
    const c = await mkCard(base, 'p1'); const f = await fence(rest, base); proxy.state.holdUpdate = 700;
    const r = await patch(base, c.id, { title: 'p1 renamed' }); assert.equal(r.status, 200, r.text.slice(0, 160));
    const ls = await waitLines(rest, f, 1); assert.equal(ls.length, 1, `exactly ONE line for the request, not one per executor call: ${ls.join(' | ').slice(0, 300)}`);
    const p = parse(ls[0]); const ph = phases(p);
    assert.ok(ph.executorUpdate >= 600, `the held update is in executorUpdate (${JSON.stringify(ph)})`);
    assert.ok(ph.lockWait < SMALL && ph.refresh < SMALL && ph.postCommit < SMALL, `and in no other phase (${JSON.stringify(ph)})`);
    assert.equal(ph.attempts, 1); assert.ok(p.total >= 700, `total covers the stall (${p.total})`); assert.ok(sumOf(ph) <= p.total, `the four phases sum to <= total (${sumOf(ph)} vs ${p.total})`);
  });
});

test('P2 a write queued behind a held one carries the wait in lockWait; the held one carries its own time in executorUpdate', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy }) => {
    const a = await mkCard(base, 'p2 a'); const b = await mkCard(base, 'p2 b'); const f = await fence(rest, base); proxy.state.holdUpdate = 800;
    const ra = patch(base, a.id, { title: 'p2 a renamed' }); await sleep(150); const rb = patch(base, b.id, { title: 'p2 b renamed' });
    assert.equal((await ra).status, 200); assert.equal((await rb).status, 200);
    const ls = await waitLines(rest, f, 2); assert.equal(ls.length, 2, `two slow requests, two lines: ${ls.join(' | ').slice(0, 400)}`);
    const all = ls.map((l) => ({ p: parse(l), ph: phases(parse(l)) })); const held = all.find((x) => x.ph.executorUpdate >= 700); const queued = all.find((x) => x.ph.lockWait >= 500);
    assert.ok(held, `one line carries the held update in executorUpdate (${JSON.stringify(all.map((x) => x.ph))})`); assert.ok(queued, `one line carries the queue wait in lockWait (${JSON.stringify(all.map((x) => x.ph))})`);
    assert.notEqual(held, queued, 'and they are two different requests');
    assert.ok(held.ph.lockWait < SMALL, `the held request did not wait for the lock (${JSON.stringify(held.ph)})`);
    assert.ok(queued.ph.executorUpdate < SMALL && queued.ph.refresh < SMALL && queued.ph.postCommit < SMALL, `the queued request's own phases are small (${JSON.stringify(queued.ph)})`);
    for (const x of all) assert.ok(sumOf(x.ph) <= x.p.total, `sum <= total (${JSON.stringify(x.ph)} vs ${x.p.total})`);
  });
});

test('P3 a forced CARD_WRITE_CONFLICT gives attempts=2, and a held cache reload lands in refresh (summed over attempts), not in executorUpdate', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy, startSecond }) => {
    const c = await mkCard(base, 'p3'); const second = await startSecond();
    assert.equal((await patch(second.baseUrl, c.id, { title: 'p3 written first by the other REST' })).status, 200, 'CONTROL: the second REST wrote the card, so the first REST\'s cache is stale');
    const f = await fence(rest, base); proxy.state.holdLoad = 700;
    const r = await patch(base, c.id, { title: 'p3 written by the stale REST' }); assert.equal(r.status, 200, `the conflict is retried and lands: ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(proxy.state.holdLoad, 0, 'THE HOLD FIRED: the cache reload was held');
    const ls = await waitLines(rest, f, 1); assert.equal(ls.length, 1, ls.join(' | ').slice(0, 300));
    const p = parse(ls[0]); const ph = phases(p);
    assert.equal(ph.attempts, 2, `the retry is counted (${JSON.stringify(ph)})`); assert.ok(ph.refresh >= 600, `the held reload is in refresh (${JSON.stringify(ph)})`);
    assert.ok(ph.executorUpdate < 400 && ph.postCommit < SMALL && ph.lockWait < SMALL, `and in no other phase (${JSON.stringify(ph)})`); assert.ok(sumOf(ph) <= p.total, `sum <= total (${sumOf(ph)} vs ${p.total})`);
  });
});

test('P3-CONTROL the same conflict with nothing held: attempts=2 and refresh is small', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 1, meterSlow: 300 }, async ({ rest, base, startSecond }) => {
    const c = await mkCard(base, 'p3c'); const second = await startSecond();
    assert.equal((await patch(second.baseUrl, c.id, { title: 'p3c first' })).status, 200);
    const f = await fence(rest, base); const r = await patch(base, c.id, { title: 'p3c second' }); assert.equal(r.status, 200, r.text.slice(0, 160));
    await sleep(500); const fresh = linesAfter(rest, f); const mine = fresh.map(parse).map((p) => ({ p, ph: phases(p) })).find((x) => x.ph.attempts === 2);
    assert.ok(mine, `a line with attempts=2 for the retried write (lines: ${fresh.join(' | ').slice(0, 400)})`); assert.ok(mine.ph.refresh < 400, `an unheld reload is small (${JSON.stringify(mine.ph)})`);
  });
});

test('P4 a stall AFTER the events are appended (the FIFO seam) lands in postCommit and in no other phase', { skip: SKIP, timeout: 300000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwp-barrier-')); const fifo = path.join(dir, 'after-events');
  await world({ cardSlow: 300, meterSlow: 300, barrier: dir }, async ({ rest, base }) => {
    const c = await mkCard(base, 'p4'); const f = await fence(rest, base);
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'the FIFO exists');
    const pending = patch(base, c.id, { title: 'p4 renamed' }); await sleep(900);
    const fd = await fs.promises.open(fifo, 'w'); await fd.close(); fs.rmSync(fifo, { force: true });   // the reader (the REST) sees EOF and goes on
    const r = await pending; assert.equal(r.status, 200, r.text.slice(0, 160));
    const ls = await waitLines(rest, f, 1); assert.equal(ls.length, 1, ls.join(' | ').slice(0, 300)); const p = parse(ls[0]); const ph = phases(p);
    assert.ok(ph.postCommit >= 500, `the stall after the events is in postCommit (${JSON.stringify(ph)})`);
    assert.ok(ph.lockWait < SMALL && ph.refresh < SMALL && ph.executorUpdate < SMALL, `and in no other phase (${JSON.stringify(ph)})`); assert.ok(sumOf(ph) <= p.total);
  });
});

test('P5 the default threshold is 1000 ms: a 500 ms write writes no line, a 1400 ms write writes one', { skip: SKIP, timeout: 300000 }, async () => {
  await world({}, async ({ rest, base, proxy }) => {
    const c = await mkCard(base, 'p5'); const f = await fence(rest, base); proxy.state.holdUpdate = 500;
    const t0 = performance.now(); assert.equal((await patch(base, c.id, { title: 'p5 half second' })).status, 200); const took = performance.now() - t0;
    await sleep(500); const half = linesAfter(rest, f);   // #1680: as P0, a line is wrong only for a write that finished under the threshold
    if (took < 1000) assert.equal(half.length, 0, `${Math.round(took)} ms is under the default: ${half.join(' | ').slice(0, 200)}`);
    for (const l of half) assert.ok(parse(l).total >= 1000, `a line only for a write that took the default threshold: ${l.slice(0, 200)}`);
    const g = await fence(rest, base); proxy.state.holdUpdate = 1400; assert.equal((await patch(base, c.id, { title: 'p5 one point four' })).status, 200);
    const ls = await waitLines(rest, g, 1); assert.equal(ls.length, 1, 'and 1400 ms is over it'); assert.ok(parse(ls[0]).total >= 1400);
  });
});

test('P6 the card-write line joins the executor meter\'s slow line by rid, and the rid is real', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy }) => {
    const c = await mkCard(base, 'p6'); const f = await fence(rest, base); proxy.state.holdUpdate = 700;
    assert.equal((await patch(base, c.id, { title: 'p6 renamed' })).status, 200);
    const ls = await waitLines(rest, f, 1); assert.equal(ls.length, 1); const rid = parse(ls[0]).kv.rid;
    assert.ok(rid && rid !== '-', `a real rid (got ${rid})`);
    await rest.waitForStderr(new RegExp(`executor-meter slow:.*rid=${rid}\\b`), 4000);
    const meter = rest.stderr().split('\n').filter((l) => new RegExp(`executor-meter slow:.*rid=${rid}\\b`).test(l));
    assert.ok(meter.length >= 1, `the executor meter's own slow line carries the SAME rid (${rid}); meter lines seen: ${rest.stderr().split('\n').filter((l) => /executor-meter slow:/.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
  });
});

test('P7 the line holds no card content and is bounded', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy }) => {
    const secret = `SECRET-1659-${process.pid}`; const c = await mkCard(base, `title ${secret}`); const f = await fence(rest, base); proxy.state.holdUpdate = 600;
    assert.equal((await patch(base, c.id, { title: `retitled ${secret}`, description: `body text ${secret} and more`, ifVersion: (await (await fetch(`${base}/api/cards/${c.id}`)).json()).version ?? 0 })).status, 200);
    const ls = await waitLines(rest, f, 1); assert.equal(ls.length, 1);
    assert.ok(!ls[0].includes(secret), 'neither the title nor the description is in the line'); assert.ok(!/SELECT|INSERT|\{|\}/.test(ls[0]), 'and no query text or JSON');
    assert.ok(ls[0].length < 400, `bounded (${ls[0].length} chars)`);
  });
});

test('P8 a client that closes its socket while the write is held still gets its line, once, when the write completes', { skip: SKIP, timeout: 300000 }, async () => {
  await world({ cardSlow: 300, meterSlow: 300 }, async ({ rest, base, proxy }) => {
    const c = await mkCard(base, 'p8'); const f = await fence(rest, base); proxy.state.holdUpdate = 900;
    const gone = await fetch(`${base}/api/cards/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'ada', title: 'p8 abandoned' }), signal: AbortSignal.timeout(250) }).then(() => 'answered', (e) => e.name);
    assert.match(gone, /Abort|Timeout/, `CONTROL: the client gave up before the answer (${gone})`);
    let landed = null; for (let i = 0; i < 60 && landed !== 'p8 abandoned'; i++) { await sleep(100); const b = (await api(base, 'GET', `/api/cards/${c.id}`)).body; landed = b?.title ?? b?.card?.title ?? null; }
    assert.equal(landed, 'p8 abandoned', 'CONTROL: the write still landed server-side after the client left');
    const ls = await waitLines(rest, f, 1, 3000); assert.equal(ls.length, 1, `the abandoned slow write is still logged, once: ${ls.join(' | ').slice(0, 300)}`);
    const p = parse(ls[0]); const ph = phases(p); assert.ok(ph.executorUpdate >= 600, `and says where the time went (${JSON.stringify(ph)})`);
  });
});
