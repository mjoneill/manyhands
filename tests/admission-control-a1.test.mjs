/**
 * ADMISSION CONTROL ON EXECUTOR WORK (#1574 attempt 2, #1605 v15 item 1; contract owner's correction 00:45Z: "bound executor work, not HTTP promises. A timed-out request must
 * not release its concurrency slot while its query still runs ... Bound the waiting queue too; coalescing alone isn't admission control"). Written by the separate test
 * author, before the build, from the contract text and the measured failure of attempt 1 (00:25Z: 150-300 % executor CPU, persistent 503s, abandoned queries still running with no
 * client connected, BrokenPipe in the executor's log).
 *
 * THE INSTRUMENT. A forwarding proxy between REST and a REAL executor that models the live executor's behaviour: it does NOT cancel a query when its caller goes away. It holds each
 * /query for `holdMs` before forwarding, and keeps the query "outstanding" until the executor's own answer is finished, whatever REST did in the meantime. What the proxy counts is
 * therefore what the executor is doing, the quantity the contract bounds. (It sees /query only; writes and checkpoints pass through uncounted.) All load is DISTINCT reads
 * (`?limit=10&author=<unique>`: each needs its own query, so coalescing cannot collapse them; single-flight coalescing is a mechanism the contract lists but these rows do not
 * pin, because identical reads collapsing would hide whether the cap works).
 *
 *   A0 CONTROL  No hold: 40 concurrent distinct reads all answer 200 (admission control must not break ordinary load: a queue serves them), the executor's peak is at least 1, and a
 *               healthy single card read's queries are counted for A3.
 *   A1 CAP      Hold 12 s, 60 distinct reads at once. Two seconds in, before any 3 s read bound has fired, the executor's outstanding queries are between 1 and 16 ("a small cap").
 *               Unbounded, this was 120 on bfb74d0 (a read sends two queries at once). THE NUMBER 16 IS MY READING OF "small", not a ruling: a builder with a larger cap asks the contract owner; the row is not edited to fit.
 *   A2 SLOT     Hold 8 s. Wave one, 20 distinct reads at once, fills the cap; its peak P1 is read at 1.5 s. After the 3 s read bound has fired for wave one (some of wave one has been
 *               answered 503, asserted so the row proves something), wave two, 20 more distinct reads, arrives. The executor's outstanding queries never exceed P1: a request
 *               that timed out did NOT free its slot while its query still ran. A cap counted on HTTP requests would admit wave two beside wave one's running queries (up to 2 x P1).
 *   A3 NO RETRY A single card read with the executor held 6 s: it is refused when the read bound fires, and the executor then receives no query body twice (no blind retry) and no more
 *               queries than the healthy read of the same card sent (no re-issue).
 *   A3b NO RETRY AFTER A LOST CONNECTION: the build has no abort timer, so a held executor alone never FAILS a read and A3 cannot see a retry. The same row, but the proxy drops the caller's
 *               connection 300 ms after dispatch: that is a failed read. The executor must still receive no query body twice and no more queries than the healthy read sent.
 *   A4 SHED     Hold 10 s, 300 distinct reads at once. The waiting queue is bounded: at least one read is refused with a 503 inside 1.5 s (a fast refusal, not a wait for the read bound),
 *               every answer is a 200 or a 503 (any other status is a rollback trigger on its own), and a route that needs no graph (GET /api/columns) still answers 200 within 2 s
 *               while the flood is in. ASSUMES the queue bound is below 300 outstanding requests; a larger bound is a decision for the contract owner, not an edit to this row.
 *   A5 DRAIN    Hold 6 s, 80 distinct reads, every caller gone (answered or refused). Then within 60 s the executor's outstanding queries reach 0 and the count of queries it has
 *               RECEIVED stops moving for 4 s (abandoned work drains and nothing keeps being issued for callers who left), and with no hold a card read answers 200 inside 3 s.
 *
 *   A4b BOUNDED QUEUE (added after the contract owner's 00:58Z tightening: "a fast 503 proves shedding exists, not that the queue is bounded; once the builder declares cap C and
 *               queue bound Q, pin a minimum number of promptly shed excess requests, or observe that queued work never exceeds Q"). Same flood as A4. With the builder's declared
 *               cap C and queue bound Q (environment ADMISSION_CAP and ADMISSION_QUEUE, integers, read from the build's own declaration, never chosen here): the executor's peak
 *               outstanding queries never exceed C, and at least 300 - C - Q reads are refused with a 503 inside 2 s (each admitted request needs at least one slot or queue place,
 *               so no more than C + Q can be admitted). UNTIL C AND Q ARE DECLARED this row runs as a TODO and fails with that message: visible, never a pass and never a skip.
 *   A5b NOTHING IS ISSUED AFTER FAILED READS: the same drain row with the callers' connections dropped after dispatch (a failed read; a retry leaked later would show here). Within 60 s the
 *               executor's outstanding queries reach 0 and the count of queries it has RECEIVED stops moving for 8 s. (No recovery claim: lost slots stay occupied by design.)
 *   A6 COLD START The held-ids read (REST's once-per-process question to the executor, "which document posts does the graph hold") is behind the same admission control. A REST that
 *               has not read anything yet, with the document holding 300 posts and the executor held 12 s, meets 60 distinct reads at once: the executor's peak outstanding queries
 *               never exceed the declared C, the held-ids query included. The other rows warm the fixture on purpose and prove nothing about cold start. A TODO until C is declared, as A4b.
 *
 *   A6b GATE FULL, THEN THE COLD BUILD: a REST that has read nothing yet, its gate filled with unlimited-list reads (they need no held-ids build): the first targeted read then needs the build.
 *               The build's query waits its turn: the executor's peak outstanding queries never exceed C (a first version of A6 could not see a build that bypassed the gate, because on a cold
 *               start every read waits for the build and nothing else is running when it is sent). A TODO until C is declared.
 *   A11 THE FEED IS BEHIND THE GATE (found by the kill checks on e263d6e and traced by the contract owner at 01:49Z: the commit-ordered discovery feed, `?afterCommit=`, which the unread badge
 *               polls, reads through the 15 s write client and so around the gate). The executor is held 12 s; the gate is filled with unlimited-list reads; then 20 DISTINCT feed reads
 *               (`?afterCommit=start&limit=<unique>`) arrive. The executor's outstanding queries never exceed C: the feed's reads wait their turn or are refused. Only the executor's peak is
 *               pinned (the feed's own identity and failure shapes belong to its R3 rows). A TODO until C is declared. NOT PINNED HERE: the `/api/changes` first feed query on the log-born
 *               path: that unit supervises its own executor, so no proxy can stand in front of it; observing it needs a counter from the build (the gate's own stats, exposed), not a row.
 *   A7 CONNECTION LOST AFTER DISPATCH (the contract owner's 01:01Z and 01:04Z corrections: "a timer is not evidence that executor work stopped"; "a connection failure after dispatch is not
 *               completion: a broken connection can leave the executor computing, the original BrokenPipe case"; the build declared NO hard timer, a slot lost to such a failure is kept
 *               until explicit recovery, and a gate with every slot lost fails closed). The proxy dispatches each query, then DROPS the REST-side socket 300 ms later while the executor
 *               goes on for 20 s. Cap-many reads fill the gate and are answered 503 (their connection is lost); at 3 s, with the executor still computing, 12 more distinct reads
 *               arrive. Not one is served; and the executor's outstanding queries NEVER exceed C: the gate did not take a lost connection for a finished query. After that no claim is made
 *               (the build clears lost slots by a REST restart; recovery is not pinned here). A TODO until C and Q are declared.
 *   A7b PREMATURE EOF, NOT FINISHED (the contract owner's 01:05Z: "a truncated response is not proof of completion; premature EOF or connection loss after headers remains ambiguous"). The same row, but the
 *               proxy sends a status line and the start of a body with NO length and then closes the connection cleanly: the client sees a short body and no transport error (the case a
 *               dropped socket does not reach: a first version of this row destroyed the socket mid-body, and a mutant that treated a short body as complete survived it). The executor's
 *               work still goes on, and the same outcomes hold.
 *   A8 NOTHING DISPATCHED, NOTHING LOST (the build's stated exception: "a refused connection frees its slot, because nothing was ever dispatched"). The executor goes down (new
 *               connections are REFUSED); 30 distinct reads, more queries than C, are all answered 503; the executor comes back on the same port; a card read answers 200 inside 3 s, with
 *               no REST restart. A gate that kept those slots would be full of nothing and refuse forever. A TODO until C is declared.
 *
 *   A10 AN ANSWER IS COMPLETION (the build's stated rule: "an ANSWER from the executor, including its own error status, proves the work ended, so it frees the slot"; the contract owner:
 *               "a fully received executor response, even an error response, can release the slot"). The executor answers every query with a complete HTTP 500; 30 distinct reads (more queries
 *               than C) are all refused; the executor then answers normally and a card read answers 200 inside 3 s. A gate that kept a slot per error answer would be full of finished work.
 *
 * REAL executor, REAL REST with the unit on; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 * NOT COVERED, by name: RECOVERY OF LOST SLOTS. The contract owner's 01:05Z rule is that a REST restart alone is not recovery (it forgets the lost slots while the executor may still be computing; drain must be confirmed, or the executor restarted, BEFORE lost slots are cleared and new reads admitted). A row for that needs the executor to report its in-flight work, which the build does not have; it is a RUNBOOK SEQUENCE (drain or restart the executor, then restart REST), to be rehearsed and recorded, not asserted here. Also: the cap's and the queue's operating values (A1 and A4 pin only "small" and "shed"; A4b and A6 pin the BUILDER'S declared numbers, whatever they are, and say nothing about whether they are the right ones: that is the checkpoint-copy run's job); coalescing (a mechanism, not pinned); what a shed answer's code is
 * (any 503 JSON); write paths (R2's rows own them, and the contract is about reads); the MCP server's own limits; the live store's real latency (this models non-cancellation with
 * a fixed hold, it does not reproduce the live executor's CPU behaviour: the checkpoint-copy concurrency run is item 4 of the proposal and is another instrument); fairness between
 * route kinds in the queue; the outcome after the cap and queue are both exhausted by a flood that never stops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'adm-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = Number(process.env.ADMISSION_CAP); const QUEUE = Number(process.env.ADMISSION_QUEUE);
const DECLARED = Number.isInteger(CAP) && CAP > 0 && Number.isInteger(QUEUE) && QUEUE >= 0;
const NEEDS_DECLARATION = DECLARED ? false : 'cap C and queue bound Q are not declared yet (ADMISSION_CAP, ADMISSION_QUEUE): this row is a TODO, not a pass';
const needDeclared = () => { if (!DECLARED) assert.fail('cap C and queue bound Q are not declared (set ADMISSION_CAP and ADMISSION_QUEUE from the build\'s own declaration)'); };
const ROSTER_FILE = path.join(os.tmpdir(), `adm-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const call = async (base, method, route, body) => {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json, text, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, body: null, text: String(e.message), ms: Date.now() - t0 }; }
};
/** A forwarding proxy that models an executor which does NOT cancel abandoned queries. */
async function startHoldProxy(execUrl) {
  const p = { holdMs: 0, dropAfterMs: 0, eofAfterMs: 0, errorStatus: 0, outstanding: 0, peak: 0, received: 0, bodies: [], resetCounts() { p.peak = p.outstanding; p.received = 0; p.bodies = []; } };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const isQ = req.method === 'POST' && req.url === '/query';
    req.socket.on('error', () => {});
    if (isQ) { p.received++; p.outstanding++; p.peak = Math.max(p.peak, p.outstanding); p.bodies.push(crypto.createHash('sha1').update(buf).digest('hex')); }
    if (isQ && p.dropAfterMs) setTimeout(() => { try { req.socket.destroy(); } catch { /* gone */ } }, p.dropAfterMs);   // the caller's connection is lost AFTER dispatch; the executor's work goes on
    if (isQ && p.errorStatus) { try { res.statusCode = p.errorStatus; res.end('{"error":"executor refused"}'); } catch { /* gone */ } p.outstanding--; return; }   // a COMPLETE answer: the executor's own error response
    if (isQ && p.eofAfterMs) setTimeout(() => { try { req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"head":{"vars":['); req.socket.end(); } catch { /* gone */ } }, p.eofAfterMs);   // a premature EOF: a status line, a short body, NO length, then a clean close; the client reads a short body without any transport error
    try {
      if (isQ && p.holdMs) await sleep(p.holdMs);
      const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: buf } : {}) });
      const t = await f.text();
      try { res.statusCode = f.status; res.end(t); } catch { /* the caller left; the executor still did the work */ }
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
    finally { if (isQ) p.outstanding--; }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.port = p.server.address().port;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  /** the executor goes DOWN (nothing listens: a new connection is REFUSED) and comes back on the same port */
  p.down = () => p.stop();
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function stack(body) {
  const exec = await startExecutor({ store: tmpStore('adm-store-'), datasetId: DSID, create: true });
  const proxy = await startHoldProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  try {
    const card = await call(rest.baseUrl, 'POST', '/api/cards', { title: 'admission card', description: 'x', createdBy: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    for (let i = 0; i < 12; i++) { const w = await call(rest.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: `admission post ${i}`, attachedTo: card.body.id }); assert.equal(w.status, 201, w.text); }
    const warm = await call(rest.baseUrl, 'GET', '/api/conversations?limit=10'); assert.equal(warm.status, 200, warm.text.slice(0, 200));   // the first reads after boot may do one-off work
    await sleep(300); proxy.resetCounts();
    return await body({ base: rest.baseUrl, proxy, cardId: card.body.id });
  } finally { await rest.stop(); await proxy.stop(); await killExecutor(exec); }
}
async function coldStack(body) {
  const exec = await startExecutor({ store: tmpStore('adm-cold-'), datasetId: DSID, create: true });
  const proxy = await startHoldProxy(exec.baseUrl);
  const docPosts = Array.from({ length: 300 }, (_, i) => ({ id: `adm-cold-${String(i + 1).padStart(3, '0')}`, body: `cold post ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], postSeq: i + 1, createdAt: new Date(Date.UTC(2026, 6, 1) + (i + 1) * 60000).toISOString() }));
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  const graphPosts = [...docPosts.slice(0, 100), ...Array.from({ length: 20 }, (_, i) => ({ ...docPosts[0], id: `adm-cold-g${i}`, body: `graph only ${i}`, postSeq: 301 + i }))];
  for (const p of graphPosts) { const r = await gc.update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: 'https://scrumboard.local/person/board', post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); }
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: 321 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  try { proxy.resetCounts(); return await body({ base: rest.baseUrl, proxy }); } finally { await rest.stop(); await proxy.stop(); await killExecutor(exec); }
}
let uniq = 0;
const distinctReads = (base, n, tag) => Array.from({ length: n }, () => call(base, 'GET', `/api/conversations?limit=10&author=${tag}-${++uniq}`));
async function until(fn, ms, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return fn(); }

test('A0 CONTROL: with no hold, 40 concurrent distinct reads all answer 200, and the healthy card read\'s queries are counted', { skip: SKIP, timeout: 120000 }, async () => {
  await stack(async ({ base, proxy, cardId }) => {
    const rs = await Promise.all(distinctReads(base, 40, 'a0'));
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [200], `ordinary load is served, a queue included: ${rs.filter((r) => r.status !== 200).slice(0, 2).map((r) => `${r.status} ${r.text.slice(0, 120)}`).join(' | ')}`);
    assert.ok(proxy.peak >= 1, 'the executor really did the work (the instrument sees it)');
    proxy.resetCounts();
    const card = await call(base, 'GET', `/api/cards/${cardId}`); assert.equal(card.status, 200, card.text.slice(0, 200));
    assert.ok(proxy.received >= 1, 'a healthy card read sends the executor at least one query');
  });
});

test('A1 CAP: with the executor held 12 s, 60 distinct reads at once leave between 1 and 16 queries outstanding at the executor two seconds in', { skip: SKIP, timeout: 150000 }, async () => {
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 12000; proxy.resetCounts();
    const flood = distinctReads(base, 60, 'a1');
    await sleep(2000);
    const p1 = proxy.peak;
    assert.ok(p1 >= 1, `CONTROL: the held reads reached the executor (peak ${p1})`);
    assert.ok(p1 <= 16, `the executor has ${p1} queries outstanding after 2 s: bfb74d0 had 120 (two queries per read, nothing capped); executor work is capped`);
    await Promise.all(flood);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 60000);
  });
});

test('A2 SLOT: a request that timed out does not free its slot while its query still runs: wave two never lifts the executor\'s outstanding queries above wave one\'s peak', { skip: SKIP, timeout: 150000 }, async () => {
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 8000; proxy.resetCounts();
    const t0 = Date.now(); const wave1 = distinctReads(base, 20, 'a2w1'); const done1 = []; wave1.forEach((p) => p.then((r) => done1.push(r)));
    await sleep(1500 - (Date.now() - t0));
    const p1 = proxy.peak; assert.ok(p1 >= 1, `CONTROL: wave one reached the executor (peak ${p1})`);
    await sleep(4000 - (Date.now() - t0));
    assert.ok(done1.some((r) => r.status === 503), `CONTROL: by 4 s the read bound has fired for wave one (${done1.length} answered: ${[...new Set(done1.map((r) => r.status))].join(',') || 'none'}), so a slot COULD have been wrongly released`);
    const wave2 = distinctReads(base, 20, 'a2w2');
    await Promise.all([...wave1, ...wave2]);
    await until(() => proxy.outstanding === 0, 60000);
    assert.ok(proxy.peak <= p1, `the executor's outstanding queries peaked at ${proxy.peak} after wave two against ${p1} for wave one: a timed-out request must keep its slot until its query is done`);
  });
});

test('A3 NO RETRY: a card read with the executor held 6 s is refused and the executor receives no query body twice and no more queries than the healthy read sent', { skip: SKIP, timeout: 150000 }, async () => {
  await stack(async ({ base, proxy, cardId }) => {
    proxy.resetCounts(); const healthy = await call(base, 'GET', `/api/cards/${cardId}`); assert.equal(healthy.status, 200, healthy.text.slice(0, 200));
    const q = proxy.received; assert.ok(q >= 1, 'CONTROL: the healthy card read sends queries');
    proxy.holdMs = 6000; proxy.resetCounts();
    const slow = await call(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(slow.status, 503, `CONTROL: the held read is refused at the bound: ${slow.status} ${slow.text.slice(0, 150)}`);
    await sleep(9000);
    assert.equal(new Set(proxy.bodies).size, proxy.bodies.length, `no query body is sent to the executor twice after an abort (${proxy.bodies.length} received, ${new Set(proxy.bodies).size} distinct)`);
    assert.ok(proxy.received <= q, `the executor received ${proxy.received} queries for the refused read against ${q} for the healthy one: nothing is re-issued`);
  });
});

test('A4 SHED: with the executor held 10 s, 300 distinct reads at once: a fast 503 exists, every answer is a 200 or a 503, and a route that needs no graph still answers', { skip: SKIP, timeout: 180000 }, async () => {
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 10000; proxy.resetCounts();
    const flood = distinctReads(base, 300, 'a4');
    await sleep(1000);
    const cols = await call(base, 'GET', '/api/columns');
    const rs = await Promise.all(flood);
    const statuses = [...new Set(rs.map((r) => r.status))].sort();
    assert.ok(statuses.every((s) => s === 200 || s === 503), `every answer is a 200 or a 503: got ${statuses.join(',')} (${rs.filter((r) => r.status !== 200 && r.status !== 503).slice(0, 2).map((r) => r.text.slice(0, 100)).join(' | ')})`);
    const fast = rs.filter((r) => r.status === 503 && r.ms < 1500).length;
    assert.ok(fast >= 1, `the waiting queue is bounded: at least one of 300 reads is refused inside 1.5 s (fastest 503: ${Math.min(...rs.filter((r) => r.status === 503).map((r) => r.ms), Infinity)} ms; ${rs.filter((r) => r.status === 503).length} refusals)`);
    assert.equal(cols.status, 200, 'a route that needs no graph answers during the flood');
    assert.ok(cols.ms < 2000, `and promptly (${cols.ms} ms): the server's event loop is not held by queued graph work`);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 90000);
  });
});

test('A5 DRAIN: after the callers have gone the executor\'s outstanding queries reach 0 within 60 s, nothing more is issued, and a card read then answers 200', { skip: SKIP, timeout: 180000 }, async () => {
  await stack(async ({ base, proxy, cardId }) => {
    proxy.holdMs = 6000; proxy.resetCounts();
    await Promise.all(distinctReads(base, 80, 'a5'));
    const drained = await until(() => proxy.outstanding === 0, 60000);
    assert.ok(drained, `CONTROL FOR THE ROW: ${proxy.outstanding} queries still outstanding 60 s after the last caller left`);
    const r0 = proxy.received; await sleep(4000);
    assert.equal(proxy.received, r0, `nothing keeps being issued for callers who left (${proxy.received - r0} more queries in the last 4 s)`);
    proxy.holdMs = 0;
    const after = await call(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(after.status, 200, `recovery: a card read answers once the work has drained: ${after.status} ${after.text.slice(0, 150)}`);
    assert.ok(after.ms < 3000, `and inside the read bound (${after.ms} ms)`);
  });
});

test('A4b BOUNDED QUEUE: with the declared cap C and queue bound Q, the executor never has more than C queries outstanding and at least 300 - C - Q of 300 distinct reads are refused with a 503 inside 2 s', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 10000; proxy.resetCounts();
    const rs = await Promise.all(distinctReads(base, 300, 'a4b'));
    const shed = rs.filter((r) => r.status === 503 && r.ms < 2000).length;
    assert.ok(proxy.peak <= CAP, `the executor peaked at ${proxy.peak} outstanding queries against the declared cap C=${CAP}`);
    assert.ok(shed >= 300 - CAP - QUEUE, `${shed} of 300 reads were refused inside 2 s; with C=${CAP} and Q=${QUEUE} at most ${CAP + QUEUE} can be admitted, so at least ${300 - CAP - QUEUE} must be refused promptly`);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 90000);
  });
});

test('A6 COLD START: a REST that has read nothing yet, the document holding 300 posts, the executor held 12 s, 60 distinct reads at once: the executor never has more than the declared C queries outstanding, the held-ids read included', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await coldStack(async ({ base, proxy }) => {
    proxy.holdMs = 12000;
    const flood = distinctReads(base, 60, 'a6');
    await sleep(2500);
    const peak = proxy.peak;
    assert.ok(peak >= 1, `CONTROL: the cold reads reached the executor (peak ${peak})`);
    assert.ok(peak <= CAP, `the executor peaked at ${peak} outstanding queries against the declared cap C=${CAP}: the once-per-process held-ids read must be admitted like any other`);
    await Promise.all(flood);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 60000);
  });
});

const connectionLost = (mode) => async () => {
  needDeclared();
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 20000; if (mode === 'drop') proxy.dropAfterMs = 300; else proxy.eofAfterMs = 300; proxy.resetCounts();
    const t0 = Date.now();
    const fill = await Promise.all(distinctReads(base, CAP, 'a7fill'));
    assert.ok(fill.every((r) => r.status === 503), `CONTROL: the lost connections surface as refusals: ${fill.map((r) => r.status).join(',')}`);
    assert.ok(proxy.outstanding >= 1, `CONTROL: the executor is STILL computing the abandoned queries (outstanding ${proxy.outstanding}): a lost or truncated connection is not a finished query`);
    await sleep(3000 - (Date.now() - t0));
    const peak0 = proxy.peak; assert.ok(peak0 <= CAP, `CONTROL: the first wave stayed within the cap (peak ${peak0})`);
    const late = await Promise.all(distinctReads(base, 12, 'a7late'));
    assert.ok(late.every((r) => r.status === 503), `no late read is served while the executor still computes the lost ones: ${late.map((r) => `${r.status}/${r.ms}ms`).slice(0, 6).join(' ')}`);
    assert.ok(proxy.peak <= CAP, `the executor peaked at ${proxy.peak} outstanding queries against the declared cap C=${CAP}: the gate freed a slot on a lost or truncated connection`);
    proxy.dropAfterMs = 0; proxy.eofAfterMs = 0; proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 60000);
  });
};
test('A7 CONNECTION LOST AFTER DISPATCH: with the executor still computing, no further read is served and the executor never exceeds C', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 240000 }, connectionLost('drop'));
test('A7b PREMATURE EOF, NOT FINISHED: a response that ends early with no length (a short body, no transport error) keeps the slot: no further read is served while the executor computes and it never exceeds C', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 240000 }, connectionLost('truncate'));

test('A8 NOTHING DISPATCHED, NOTHING LOST: with the executor down (connections refused) 30 reads are all refused, and when it is back a card read answers 200 with no REST restart', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy, cardId }) => {
    await proxy.down();
    const refused = await Promise.all(distinctReads(base, 30, 'a8'));
    assert.ok(refused.every((r) => r.status === 503), `CONTROL: with the executor down every read is refused: ${[...new Set(refused.map((r) => r.status))].join(',')}`);
    await proxy.up();
    await sleep(500);
    const after = await call(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(after.status, 200, `the executor is back and REST was not restarted; connections that never dispatched held no slot: ${after.status} ${after.text.slice(0, 150)}`);
    assert.ok(after.ms < 3000, `and the read is prompt (${after.ms} ms)`);
  });
});

test('A10 AN ANSWER IS COMPLETION: with the executor answering every query with a complete HTTP 500, 30 reads are refused, and once it answers normally a card read returns 200', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy, cardId }) => {
    proxy.errorStatus = 500;
    const rs = await Promise.all(distinctReads(base, 30, 'a10'));
    assert.ok(rs.every((r) => r.status === 503), `CONTROL: every read whose queries were answered with an error is refused: ${[...new Set(rs.map((r) => r.status))].join(',')}`);
    proxy.errorStatus = 0; await sleep(300);
    const after = await call(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(after.status, 200, `the executor answers again; finished work held no slot: ${after.status} ${after.text.slice(0, 150)}`);
    assert.ok(after.ms < 3000, `and the read is prompt (${after.ms} ms)`);
  });
});

test('A3b NO RETRY AFTER A LOST CONNECTION: a card read whose connection is dropped after dispatch is refused; the executor receives no query body twice and no more queries than the healthy read sent', { skip: SKIP, timeout: 150000 }, async () => {
  await stack(async ({ base, proxy, cardId }) => {
    proxy.resetCounts(); const healthy = await call(base, 'GET', `/api/cards/${cardId}`); assert.equal(healthy.status, 200, healthy.text.slice(0, 200));
    const q = proxy.received; assert.ok(q >= 1, 'CONTROL: the healthy card read sends queries');
    proxy.holdMs = 4000; proxy.dropAfterMs = 300; proxy.resetCounts();
    const lost = await call(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(lost.status, 503, `CONTROL: the read whose connection was lost is refused: ${lost.status} ${lost.text.slice(0, 150)}`);
    await sleep(8000);
    assert.equal(new Set(proxy.bodies).size, proxy.bodies.length, `no query body is sent to the executor twice after a lost connection (${proxy.bodies.length} received, ${new Set(proxy.bodies).size} distinct)`);
    assert.ok(proxy.received <= q, `the executor received ${proxy.received} queries for the lost read against ${q} for the healthy one: nothing is re-issued`);
  });
});

test('A5b NOTHING IS ISSUED AFTER FAILED READS: with the callers\' connections dropped after dispatch the executor drains and then receives nothing more for 8 s', { skip: SKIP, timeout: 180000 }, async () => {
  await stack(async ({ base, proxy }) => {
    proxy.holdMs = 6000; proxy.dropAfterMs = 300; proxy.resetCounts();
    await Promise.all(distinctReads(base, 40, 'a5b'));
    const drained = await until(() => proxy.outstanding === 0, 60000);
    assert.ok(drained, `CONTROL FOR THE ROW: ${proxy.outstanding} queries still outstanding 60 s after the callers' connections were lost`);
    const r0 = proxy.received; await sleep(8000);
    assert.equal(proxy.received, r0, `nothing keeps being issued after failed reads (${proxy.received - r0} more queries in the last 8 s)`);
  });
});

test('A6b GATE FULL, THEN THE COLD BUILD: with a cold REST and the gate filled by unlimited-list reads, the first targeted read\'s held-ids build waits its turn and the executor never exceeds C', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await coldStack(async ({ base, proxy }) => {
    proxy.holdMs = 12000;
    const fillers = Array.from({ length: 12 }, () => call(base, 'GET', '/api/conversations'));   // bulk reads: two gated queries each, no held-ids build needed
    await sleep(1500);
    assert.ok(proxy.peak >= 1 && proxy.peak <= CAP, `CONTROL: the gate is full of the bulk reads' queries and within the cap (peak ${proxy.peak})`);
    const targeted = call(base, 'GET', `/api/conversations?limit=10&author=a6b-${++uniq}`);   // cold: needs the held-ids build first
    await sleep(2500);
    assert.ok(proxy.peak <= CAP, `the executor peaked at ${proxy.peak} outstanding queries against the declared cap C=${CAP}: the held-ids build went around the gate`);
    await Promise.all([...fillers, targeted]);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 60000);
  });
});

test('A11 THE FEED IS BEHIND THE GATE: with the gate full, 20 distinct commit-ordered feed reads never lift the executor\'s outstanding queries above C', { skip: SKIP, todo: NEEDS_DECLARATION, timeout: 180000 }, async () => {
  needDeclared();
  await stack(async ({ base, proxy }) => {
    const feed = await call(base, 'GET', '/api/conversations?afterCommit=start&limit=50');
    assert.equal(feed.status, 200, `CONTROL: the feed answers on a healthy executor: ${feed.status} ${feed.text.slice(0, 150)}`);
    proxy.holdMs = 12000; proxy.resetCounts();
    const fillers = Array.from({ length: 12 }, () => call(base, 'GET', '/api/conversations'));
    await sleep(1500);
    assert.ok(proxy.peak >= 1 && proxy.peak <= CAP, `CONTROL: the gate is full and within the cap (peak ${proxy.peak})`);
    const feeds = Array.from({ length: 20 }, (_, i) => call(base, 'GET', `/api/conversations?afterCommit=start&limit=${60 + i}`));
    await sleep(2500);
    assert.ok(proxy.peak <= CAP, `the executor peaked at ${proxy.peak} outstanding queries against the declared cap C=${CAP}: the discovery feed's reads went around the gate`);
    await Promise.all([...fillers, ...feeds]);
    proxy.holdMs = 0; await until(() => proxy.outstanding === 0, 60000);
  });
});
