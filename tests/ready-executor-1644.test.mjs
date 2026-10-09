/**
 * #1644, THE EXECUTOR-BACKED `board_ready`: the test author's rows, written BEFORE the build (2026-10-09). The switch under test is `SCRUM_GRAPH_READY_SOURCE=executor` on REST; GET /api/ready
 * (and its `explain`) must answer from the EXECUTOR with the answer the in-process copy gives today, for the same board, and must fail LOUDLY when the executor cannot be read.
 * This file is the functional family (R0-R6). The two heavy rows, the mid-read SNAPSHOT row and the LATENCY row, are in ready-executor-1644-snapshot.test.mjs.
 *
 * WHAT MAKES A ROW HERE ABLE TO FAIL (read this before trusting a green): with the switch UNSET, REST answers from the in-process copy, so "flag on == flag off" is true of a build that
 * ignores the flag. Every flag-on row therefore requires a PRECONDITION that the request really reached the executor (the proxy in front of it counted /query requests during the call);
 * a build that does not read the executor fails there, not in the comparison.
 *
 * COUNTING: "the executor was asked" means a /query whose text reads the parking predicate (only a readiness read needs it), NOT any query: the first run of these rows (14:17Z) passed 5 of 8 on a build with no switch, because with the cards unit on every /api/ready call makes one unrelated currency query even with the switch off.
 *
 * Fixture (hand-derived, from ready-api.test.mjs): #1 free p2 READY . #2 held p0 claimed by ada EXCLUDED claimed-by:ada . #3 waiting p1 blockedBy #4 EXCLUDED open-blocker:4 . #4 blocker p3
 * in-progress READY . #5 finished p0 done EXCLUDED column:done. READY ORDER = [1, 4]. The cards are copied into a real executor with scripts/migrate-cards-1598.mjs and REST runs with the cards unit ON.
 *
 *   R0  CONTROL, switch UNSET: GET /api/ready gives the hand-derived verdicts, and the executor is NOT asked (the proxy counts 0 queries): the oracle is the old path.
 *   R1  PARITY, switch ON: the executor IS asked (>= 1 query), and ready, readyTotal and excluded equal R0's answer; the response has the same keys.
 *   R2  the queue is LIVE: closing the blocker through the API admits the waiter on the next call with the switch on: hand-derived [3, 1]; #4 leaves with column:done.
 *   R3  `explain` with the switch on: a ready card, an excluded card and an unknown card answer exactly as the switch-off path does (same status, same body, the replica `watermark` aside as in R1 and R6).
 *   R4  the executor CANNOT BE READ: the answer is a loud failure (HTTP 503 with an error code), never a 200 with an empty or partial `ready`. CONTROL: the same call with the executor up is 200 with ready [1, 4].
 *   R5  an executor that answers GARBAGE or times out (a proxy returning a truncated body / holding the request) is also a loud failure, not a partial queue.
 *   R7  AUTHORITY (the executor's verdict is USED, not only contacted): the proxy rewrites the executor's answer so that card #1 reads column done; with the switch ON the queue must exclude #1
 *       (column:done) and be [4]; CONTROL with the switch off the same rewrite changes nothing ([1, 4]). A build that makes a dummy executor call and answers from the in-process copy passes R1 and
 *       fails here: this is the pinned mutant "dummy call, then replica fallback".
 *   R8  A DAMAGED BUT PARSEABLE answer is rejected loudly (review of 9489d4c, 15:58Z): the proxy adds a row that belongs to no branch of the executor's answer; the call must be a non-200 with a string
 *       code and no queue, never a 200 built from the rest. (The reader may not silently drop a row it cannot place: a dropped row is a successful empty or partial queue.)
 *   R8c The same for a tag with an UNKNOWN value (a renamed kind): the proxy rewrites the value of `readyKind` on two real rows to a name no branch uses.
 *   R8b The same for the row's own tag removed: the proxy deletes the `readyKind` variable from two real rows (named here because the review names it; a builder who renames the tag renames it here).
 *   R8d A readyKind that is the NAME OF AN OBJECT PROTOTYPE PROPERTY ('constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf') is an unknown kind like any other: a lookup in a plain object finds it, so it
 *       must be refused by an own-property check or a Map; 503 with a code, no queue (the reviewer's 16:12Z catch: a plain-object `by[tag]` is truthy for these and then dies at `.push` without the 503 code).
 *   SOURCE IDENTITY (the retro's adopted guard, applied to this file's differentials R1 and R9): each leg's source is established from an independent observation, the counting proxy, never from the
 *   flag that was set: the oracle leg must have asked the executor for NO readiness facts, the switched leg for at least one, and both counts are printed before anything is compared. /api/ready itself
 *   returns no `source` field (graph_query does); whether it should is left to the builder, and a `source` field would need R1/R9's whole-object compare to ignore it.
 *   R9  A RICHER BOARD, full parity (found by asking which mutants my 5-card fixture could not kill): parked, superseded, a blocker on a card that does not exist, related and derived-from members. The WHOLE queue object
 *       (every ready item with its context, every excluded item), the replica watermark aside, equals the old path's; and the verdicts that only these kinds can produce are asserted, taken from the OLD PATH'S OWN
 *       behaviour (my first hand-derivation said 'dangling-blocker:999' for a blocker on a card that does not exist; the old path says 'open-blocker:999', and the row now says what the code does):
 *       parked-by:..., superseded-by:7, open-blocker:999, and person-blocker for a named person and for any human. Human blockers and release conditions ARE card fields (blockers / acceptance);
 *       cards 11-14 carry them (a person, any human, a condition blocked by an open card, a condition with evidence), and the whole-object compare covers them. (An earlier cut of this header said the format
 *       could not express them; that was wrong, the reviewer asked for them at 16:13Z.)
 *   R6  FLIP BACK: restarting REST without the switch on the same executor and board gives the R0 answer byte for byte (the replica `watermark` aside, which must be back).
 *
 * NOT covered, by name: `limit` and paging arguments beyond what R3 touches; the shipped-commits argument (#1020); the MCP tool path (it calls the same endpoint); a switch value other than
 * `executor` (the other readers treat anything else as off; no row pins that here); the replica's other consumers (checks); what happens to a read that is IN FLIGHT when REST restarts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, READY_ENV, smallBoard, richBoard, world } from './helpers/ready-world-1644.mjs';
import { killExecutor } from './helpers/graph-executor-proc.mjs';

/** One /api/ready call, with the number of READY-reading executor /query requests it caused (see startProxy: a call makes one unrelated currency query even with the switch off). */
async function readyCounted(w, route = '/api/ready') { const before = w.proxy.readyQueries; const r = await w.get(route); return { ...r, queries: w.proxy.readyQueries - before }; }
const verdicts = (j) => ({ ready: j.ready.map((c) => c.shortId), readyTotal: j.readyTotal, excluded: Object.fromEntries(j.excluded.map((c) => [c.shortId, c.reason])) });
const HAND = { ready: [1, 4], readyTotal: 2, excluded: { 2: 'claimed-by:ada', 3: 'open-blocker:4', 5: 'column:done' } };

test('R0 CONTROL, switch unset: the hand-derived verdicts, and the executor is NOT asked', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start();
    const r = await readyCounted(w); assert.equal(r.status, 200); assert.deepEqual(verdicts(r.json), HAND);
    assert.equal(r.queries, 0, 'the old path answers from the in-process copy: no executor query');
  });
});

test('R1 PARITY, switch on: the executor IS asked, and the answer equals the old path\'s', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start(); const oracle = await readyCounted(w); assert.deepEqual(verdicts(oracle.json), HAND, 'CONTROL: the oracle is the hand-derived answer');
    assert.equal(oracle.queries, 0, 'SOURCE OF THE ORACLE LEG, read from the proxy and never from the flag: the old path asked the executor for no readiness facts');
    await w.start({ ready: true }); const r = await readyCounted(w);
    console.log(`R1 sources read: oracle leg ${oracle.queries} readiness queries to the executor (in-process copy); switched leg ${r.queries} (executor)`);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.queries >= 1, `the switch must make /api/ready read the EXECUTOR (the proxy counted ${r.queries} queries): a build that ignores the switch passes every comparison below`);
    assert.deepEqual(verdicts(r.json), verdicts(oracle.json), 'ready, readyTotal and excluded equal the old path\'s');
    const keys = (j) => Object.keys(j).filter((k) => k !== 'watermark').sort();
    assert.deepEqual(keys(r.json), keys(oracle.json), 'the response has the same keys (the replica\'s `watermark` is a statement about the replica projection; the builder may drop or replace it, and that choice is not pinned here)');
  });
});

test('R2 the queue is live with the switch on: closing the blocker admits the waiter on the next call', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start({ ready: true });
    const first = await readyCounted(w); assert.ok(first.queries >= 1, 'CONTROL: this call reads the executor'); assert.deepEqual(verdicts(first.json).ready, [1, 4]);
    assert.equal(await w.patch(4, { column: 'done' }), 200);
    const r = await readyCounted(w); assert.ok(r.queries >= 1);
    assert.deepEqual(verdicts(r.json).ready, [3, 1], 'hand-derived: #3 (p1) now leads; #4 left the queue'); assert.equal(verdicts(r.json).excluded[4], 'column:done');
  });
});

test('R3 explain with the switch on answers exactly as the old path does: a ready card, an excluded card, an unknown card', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start(); const old = {}; for (const id of [1, 3, 999]) old[id] = await w.get(`/api/ready?explain=${id}`);
    assert.equal(old[1].status, 200); assert.equal(old[3].status, 200); assert.notEqual(old[999].status, 200, 'CONTROL: the old path refuses an unknown card');
    await w.start({ ready: true });
    for (const id of [1, 3, 999]) { const r = await readyCounted(w, `/api/ready?explain=${id}`); assert.equal(r.status, old[id].status, `explain ${id}: same status`); const noWm = (j) => { if (!j || typeof j !== 'object') return j; const { watermark, ...rest } = j; return rest; };
      assert.deepEqual(noWm(r.json), noWm(old[id].json), `explain ${id}: same body, the replica watermark aside (a statement about the replica projection; the executor path may drop or replace it, as R1 and R6 allow)`); if (id !== 999) assert.ok(r.queries >= 1, `explain ${id} read the executor`); }
  });
});

test('R4 the executor cannot be read: a loud failure (503 + code), never a 200 with an empty or partial queue', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start({ ready: true });
    const up = await readyCounted(w); assert.equal(up.status, 200); assert.deepEqual(verdicts(up.json).ready, [1, 4]); assert.ok(up.queries >= 1, 'CONTROL: with the executor up the call reads it and answers');
    await killExecutor(w.exec);
    const down = await w.get('/api/ready');
    assert.equal(down.status, 503, `the failure must be loud (got ${down.status}: ${down.text.slice(0, 200)})`);
    assert.ok(down.json && typeof down.json.code === 'string' && down.json.code.length, 'and it names a code');
    assert.ok(!Array.isArray(down.json?.ready), 'and it carries no queue at all');
  });
});

test('R5 an executor that answers garbage or never answers is also a loud failure, not a partial queue', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start({ ready: true });
    w.proxy.mode = 'garbage'; const g = await w.get('/api/ready');
    assert.notEqual(g.status, 200, `a half-answered query must not become a queue (got ${g.status}: ${g.text.slice(0, 160)})`); assert.ok(!Array.isArray(g.json?.ready), 'garbage: no queue');
    w.proxy.mode = 'hold'; const t0 = Date.now(); const h = await w.get('/api/ready');
    assert.notEqual(h.status, 200, `a held request must end in a failure (got ${h.status})`); assert.ok(!Array.isArray(h.json?.ready), 'held: no queue'); assert.ok(Date.now() - t0 < 35000, 'and in a bounded time');
    w.proxy.mode = 'pass'; const back = await w.get('/api/ready'); assert.equal(back.status, 200, 'CONTROL: when the executor answers again so does the call'); assert.deepEqual(verdicts(back.json).ready, [1, 4]);
  });
});

test('R6 FLIP BACK: restarting without the switch on the same executor and board gives the old answer byte for byte', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start(); const a = await w.get('/api/ready');
    await w.start({ ready: true }); const on = await readyCounted(w); assert.ok(on.queries >= 1, 'CONTROL: the middle run really used the executor');
    await w.start(); const b = await readyCounted(w);
    assert.equal(b.queries, 0, 'flipped back: the executor is not asked');
    const strip = (t) => { const j = JSON.parse(t); const wm = j.watermark; delete j.watermark; return { rest: JSON.stringify(j), hasWatermark: wm != null }; };
    assert.equal(strip(b.text).rest, strip(a.text).rest, 'and the response is identical to the first, byte for byte, apart from the replica watermark');
    assert.ok(strip(b.text).hasWatermark, 'and the old path\'s currency statement (the watermark) is back');
  });
});

test('R7 AUTHORITY: the executor\'s verdict is used, not only contacted (a dummy call followed by the in-process answer must fail)', { skip: SKIP, timeout: 300000 }, async () => {
  await world(smallBoard(), async (w) => {
    const done = (j) => { for (const b of j?.results?.bindings ?? []) if (b.id?.value === '1' && b.col) b.col.value = b.col.value.replace(/[^/]+$/, 'done'); };
    w.proxy.rewrite = done;
    await w.start(); const off = await readyCounted(w); assert.deepEqual(verdicts(off.json).ready, [1, 4], 'CONTROL: with the switch off the rewrite changes nothing');
    await w.start({ ready: true }); const probe = []; const orig = w.proxy.rewrite; w.proxy.rewrite = (j) => { orig(j); probe.push(JSON.stringify(j).includes('"id"')); };
    const on = await readyCounted(w); assert.equal(on.status, 200, on.text.slice(0, 200));
    assert.ok(on.queries >= 1 && probe.some(Boolean), `PRECONDITION: the executor was asked and its facts answer passed through the rewrite (${on.queries} queries)`);
    assert.deepEqual(verdicts(on.json).ready, [4], 'the executor said #1 is done: the queue is [4], not the in-process [1, 4]');
    assert.equal(verdicts(on.json).excluded[1], 'column:done');
  });
});

const readyShaped = (j) => Array.isArray(j?.head?.vars) && j.head.vars.includes('parkedUntil');   // the readiness answer: its variables name the parking predicate's variable
async function damaged(damage) {
  await world(smallBoard(), async (w) => {
    await w.start({ ready: true });
    const ok = await readyCounted(w); assert.equal(ok.status, 200, 'CONTROL: undamaged, the call answers'); assert.deepEqual(verdicts(ok.json).ready, [1, 4]); assert.ok(ok.queries >= 1, 'CONTROL: it read the executor');
    let applied = 0; w.proxy.rewrite = (j) => { if (readyShaped(j)) { damage(j); applied++; } };
    const r = await w.get('/api/ready');
    assert.ok(applied >= 1, 'PRECONDITION: the damage was applied to the readiness answer');
    assert.notEqual(r.status, 200, `a damaged answer must not become a queue (got ${r.status}: ${r.text.slice(0, 200)})`);
    assert.ok(r.json && typeof r.json.code === 'string' && r.json.code.length, 'and it names a code');
    assert.ok(!Array.isArray(r.json?.ready), 'and carries no queue');
  });
}
test('R8 a row that belongs to no branch of the executor answer is rejected loudly, not dropped', { skip: SKIP, timeout: 300000 }, async () => {
  await damaged((j) => { j.head.vars.push('zzzStray'); j.results.bindings.push({ zzzStray: { type: 'literal', value: 'nothing claims this row' } }); });
});
test('R8b a real row whose readyKind tag is missing is rejected loudly, not dropped', { skip: SKIP, timeout: 300000 }, async () => {
  await damaged((j) => { for (const b of j.results.bindings.slice(0, 2)) delete b.readyKind; });
});
test('R8c a real row whose readyKind names no branch (a renamed kind) is rejected loudly, not dropped', { skip: SKIP, timeout: 300000 }, async () => {
  await damaged((j) => { for (const b of j.results.bindings.slice(0, 2)) if (b.readyKind) b.readyKind = { ...b.readyKind, value: `${b.readyKind.value}-renamed` }; });
});

test('R9 a richer board: the WHOLE queue (context members included) equals the old path\'s, and the parked / superseded / person-blocker / open-blocker-on-a-missing-card verdicts are the old path\'s own', { skip: SKIP, timeout: 300000 }, async () => {
  await world(richBoard(), async (w) => {
    const noWm = (j) => { const { watermark, ...rest } = j; return rest; };
    const ex = (j, n) => j.excluded.find((c) => c.shortId === n)?.reason;
    await w.start(); const oracle = await readyCounted(w, '/api/ready?limit=100'); assert.equal(oracle.status, 200);
    assert.equal(oracle.queries, 0, 'SOURCE OF THE ORACLE LEG, read from the proxy and never from the flag: the old path asked the executor for no readiness facts');
    assert.match(ex(oracle.json, 6) ?? '', /^parked-by:/, 'CONTROL: the oracle parks #6'); assert.equal(ex(oracle.json, 8), 'superseded-by:7', 'CONTROL: the oracle supersedes #8'); assert.equal(ex(oracle.json, 10), 'open-blocker:999', 'CONTROL: the oracle flags #10');
    assert.ok(oracle.json.ready.some((c) => (c.context?.relatedTo?.total ?? 0) > 0), 'CONTROL: the board really has related members in the queue');
    assert.match(ex(oracle.json, 11) ?? '', /^person-blocker:/, 'CONTROL: the oracle holds #11 on a person'); assert.match(ex(oracle.json, 12) ?? '', /^person-blocker:/, 'CONTROL: the oracle holds #12 on any human');
    const seen13 = oracle.json.ready.find((c) => c.shortId === 13) ?? oracle.json.excluded.find((c) => c.shortId === 13); assert.ok(seen13, 'CONTROL: the oracle has a verdict for #13 (the condition-scoped blocker card)'); console.log(`R9 oracle #13: ${JSON.stringify(seen13).slice(0, 220)}`);
    await w.start({ ready: true }); const on = await readyCounted(w, '/api/ready?limit=100');
    assert.equal(on.status, 200, on.text.slice(0, 300)); assert.ok(on.queries >= 1, 'PRECONDITION: the switched call read readiness facts from the executor');
    console.log(`R9 sources read: oracle leg ${oracle.queries} readiness queries to the executor (in-process copy); switched leg ${on.queries} (executor)`);
    assert.match(ex(on.json, 6) ?? '', /^parked-by:/); assert.equal(ex(on.json, 8), 'superseded-by:7'); assert.equal(ex(on.json, 10), 'open-blocker:999');
    assert.match(ex(on.json, 11) ?? '', /^person-blocker:/); assert.match(ex(on.json, 12) ?? '', /^person-blocker:/);
    assert.deepEqual(noWm(on.json), noWm(oracle.json), 'every ready item with its context, and every excluded item, equals the old path\'s');
  });
});

test('R8d a readyKind that names an object-prototype property is refused loudly like any unknown kind (503 + code, no queue)', { skip: SKIP, timeout: 600000 }, async () => {
  await world(smallBoard(), async (w) => {
    await w.start({ ready: true });
    const ok = await readyCounted(w); assert.equal(ok.status, 200, 'CONTROL: undamaged, the call answers'); assert.ok(ok.queries >= 1);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      let applied = 0; w.proxy.rewrite = (j) => { if (readyShaped(j)) { for (const b of j.results.bindings.slice(0, 2)) if (b.readyKind) b.readyKind = { ...b.readyKind, value: name }; applied++; } };
      const r = await w.get('/api/ready');
      assert.ok(applied >= 1, `PRECONDITION (${name}): the damage was applied to the readiness answer`);
      assert.equal(r.status, 503, `${name}: a prototype-name tag must be a 503 (got ${r.status}: ${r.text.slice(0, 160)})`);
      assert.equal(r.json?.code, 'READY_SOURCE_UNAVAILABLE', `${name}: with the room's 503 code`);
      assert.ok(!Array.isArray(r.json?.ready), `${name}: and carries no queue`);
    }
    w.proxy.rewrite = null; const back = await w.get('/api/ready'); assert.equal(back.status, 200, 'CONTROL: undamaged again, it answers');
  });
});
