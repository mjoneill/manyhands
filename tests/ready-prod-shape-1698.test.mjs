/**
 * #1698 — rows for the experiment "does a different query shape (or fewer rows) keep the readiness answer complete and one real moment?".
 * TEST AUTHOR's, written before any build. They do NOT ask for fewer rows: fewer rows with parity is not by itself a pass (the ratifiers' boundary on the card). They pin what any
 * candidate must still be, on a PRODUCTION-SHAPED board and not only the small L1 fixture:
 *
 *   PS0  the generated board really has the measured production shape, and is reproducible (same seed, same bytes). Pure, no executor.
 *   PS1  PARITY, shipped shas ABSENT: with the switch on, the WHOLE queue (every ready item with its context, every excluded item) equals the in-process answer's.
 *   PS2  PARITY, shipped shas PRESENT (a stamp file): the same, and the stamp really changes the answer (CONTROL, so PS2 cannot pass on a path that ignores the shas).
 *   PS3  EXPLAIN parity for the cards that stress the shape: the highest-degree card, a done card, a parked one, a superseded one, a person-blocked one, a card carrying commits.
 *   PS4  CONTROL: a state change to one card moves the answer, on both paths, and they still agree (so the parity comparison CAN fail).
 *   PS5  ACCOUNTING (BASELINE-ONLY, see below): the rows the executor returns for the readiness read, counted by `?readyKind`, equal what the board declares, and the kinds add up
 *        to the total. This pins the CURRENT query. A row-reducing candidate will legitimately change these counts; the builder changes PS5 only with the reason written on the card
 *        and reviewed. Everything else here must keep passing unchanged.
 *
 * NOT covered, by name: the one-snapshot controls (tests/ready-executor-1644-snapshot.test.mjs S1-S3 already run the injected-write sweep; a candidate must pass them unchanged, and that is
 * the snapshot half of the DONE WHEN); latency (the L1 test, unchanged bounds; no ceiling is extrapolated from row counts); the live board.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/ready-world-1644.mjs';
import { PROD_MEASURED, prodShapeBoard, withStampEnv, worldWithEnv } from './helpers/ready-prod-shape-1698.mjs';

const noWm = (j) => { const { watermark, source, ...rest } = j; return rest; };
const FULL = '/api/ready?limit=5000';

test('#1698 (PS0) the generated board has the measured production shape, and the same seed gives the same bytes', () => {
  const a = prodShapeBoard();
  const d = a.declared;
  const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol * want, `${what}: ${got} is not within ${tol * 100}% of the measured ${want}`);
  near(d.relatedToRows, PROD_MEASURED.relatedToRows, 0.03, 'relatedTo rows');
  assert.equal(d.derivedFromRows, PROD_MEASURED.derivedFromRows, 'derivedFrom rows');
  assert.equal(d.supersedesRows, PROD_MEASURED.supersedesRows, 'supersedes rows'); assert.equal(d.supersededByRows, PROD_MEASURED.supersededByRows, 'supersededBy rows');
  near(d.cardsWithContext, PROD_MEASURED.cardsWithContext, 0.15, 'cards with a context edge');
  assert.ok(d.maxDegree >= 30 && d.maxDegree <= PROD_MEASURED.maxDegree, `a heavy tail: the busiest card has ${d.maxDegree} relatedTo edges (production: ${PROD_MEASURED.maxDegree})`);
  assert.equal(d.humanBlockerCards, PROD_MEASURED.humanBlockerRows, 'human blockers'); assert.equal(d.blockedByEdges, PROD_MEASURED.blockersRows, 'card blockers');
  assert.equal(d.implementedByRows, PROD_MEASURED.implementedByRows, 'commit links');
  assert.equal(d.contextRows, d.relatedToRows + d.derivedFromRows + d.supersedesRows + d.supersededByRows, 'the declared context total is the sum of its four edge types');
  assert.equal(JSON.stringify(prodShapeBoard().board), JSON.stringify(a.board), 'the same seed gives the same board, byte for byte');
  assert.notEqual(JSON.stringify(prodShapeBoard({ seed: 7 }).board), JSON.stringify(a.board), 'CONTROL: another seed gives another board, so the comparison above can fail');
});

/** Run both paths on one world and return what each said. */
async function bothPaths(w, route) {
  await w.start(); const oracle = await w.get(route);
  await w.start({ ready: true }); const on = await w.get(route);
  assert.equal(oracle.status, 200, oracle.text.slice(0, 300)); assert.equal(on.status, 200, on.text.slice(0, 300));
  assert.equal(oracle.json.source, 'replica', 'the oracle leg REPORTS replica'); assert.equal(on.json.source, 'executor', 'the switched leg REPORTS executor');
  return { oracle, on };
}

for (const withStamp of [false, true]) {
  const tag = withStamp ? 'shipped shas PRESENT' : 'shipped shas ABSENT';
  test(`#1698 (${withStamp ? 'PS2' : 'PS1'}) PARITY on the production-shaped board, ${tag}: the whole queue equals the in-process answer`, { skip: SKIP, timeout: 1500000 }, async () => {
    const { board, shas } = prodShapeBoard();
    await withStampEnv(withStamp, shas, async (env) => {
      await worldWithEnv(board, env, async (w) => {
        const { oracle, on } = await bothPaths(w, FULL);
        assert.ok(oracle.json.readyTotal > 100, `PRECONDITION: a real queue (${oracle.json.readyTotal} ready) so an empty-equals-empty pass is impossible`);
        assert.ok(oracle.json.excluded.length > 100, `PRECONDITION: a real excluded list (${oracle.json.excluded.length})`);
        assert.ok(oracle.json.ready.some((c) => (c.context?.relatedTo?.total ?? 0) > 5), 'PRECONDITION: ready items carry related members');
        assert.deepEqual(noWm(on.json), noWm(oracle.json), 'every ready item with its context, and every excluded item, in the same order');
      });
    });
  });
}

test('#1698 (PS2-CONTROL) the stamp changes the answer: with shipped shas the queue differs from without, so PS2 cannot pass on a path that ignores them', { skip: SKIP, timeout: 1500000 }, async () => {
  const { board, shas } = prodShapeBoard();
  let without, withShas;
  await worldWithEnv(board, {}, async (w) => { await w.start(); without = (await w.get(FULL)).json; });
  await withStampEnv(true, shas, async (env) => { await worldWithEnv(board, env, async (w) => { await w.start(); withShas = (await w.get(FULL)).json; }); });
  assert.notDeepEqual(noWm(withShas), noWm(without), 'shipped shas must change at least one verdict on this board (cards whose commits are not all deployed)');
});

test('#1698 (PS3, PS4) explain parity on the cards that stress the shape, and a state change moves the answer on both paths and they still agree', { skip: SKIP, timeout: 1500000 }, async () => {
  const { board, cardsList, shas } = prodShapeBoard();
  const busiest = cardsList.reduce((m, c) => (c.relationships.relatedTo.length > m.relationships.relatedTo.length ? c : m));
  const pickBy = (f) => cardsList.find(f);
  const sample = [busiest, pickBy((c) => c.column === 'done'), pickBy((c) => c.parkedBy), pickBy((c) => c.relationships.supersededBy.length), pickBy((c) => c.blockers?.length), pickBy((c) => c.implementedBy?.length)];
  assert.ok(sample.every(Boolean), 'PRECONDITION: the board has a card of every stressing kind');
  await withStampEnv(true, shas, async (env) => {
    await worldWithEnv(board, env, async (w) => {
      await w.start(); const oracleExplain = []; for (const c of sample) { const r = await w.get(`/api/ready?explain=${c.shortId}`); assert.equal(r.status, 200, r.text.slice(0, 200)); oracleExplain.push(noWm(r.json)); }
      const before = (await w.get(FULL)).json;
      await w.start({ ready: true }); const onExplain = []; for (const c of sample) { const r = await w.get(`/api/ready?explain=${c.shortId}`); assert.equal(r.status, 200, r.text.slice(0, 200)); onExplain.push(noWm(r.json)); }
      assert.deepEqual(onExplain, oracleExplain, 'explain for the busiest, done, parked, superseded, person-blocked and commit-carrying cards equals the in-process answer');
      // PS4: close a plain ready card; both paths must move, and agree
      const target = noWm(before).ready.find((c) => !c.context?.relatedTo?.total)?.shortId ?? before.ready[0].shortId;
      const beforeOn = (await w.get(FULL)).json;
      assert.deepEqual(noWm(beforeOn), noWm(before), 'PRECONDITION: the two paths agreed before the change');
      const p = await w.patch(target, { column: 'done' }); assert.ok(p.status === 200, `the state change applied (${p.status}): ${p.text.slice(0, 200)}`);
      const afterOn = (await w.get(FULL)).json;
      await w.start(); const afterOracle = (await w.get(FULL)).json;
      assert.notDeepEqual(noWm(afterOn), noWm(beforeOn), 'CONTROL: closing a ready card changes the executor path\'s answer');
      assert.deepEqual(noWm(afterOn), noWm(afterOracle), 'and the two paths still agree after the change');
    });
  });
});

test('#1698 (PS5, BASELINE-ONLY) the readiness read\'s rows, counted by ?readyKind, equal what the board declares and add up to the total', { skip: SKIP, timeout: 1500000 }, async () => {
  const { board, declared, shas } = prodShapeBoard();
  for (const withStamp of [false, true]) {
    await withStampEnv(withStamp, shas, async (env) => {
      await worldWithEnv(board, env, async (w) => {
        const counts = {}; let total = 0; let seen = 0;
        w.proxy.rewrite = (j) => { const rows = j?.results?.bindings; if (!Array.isArray(rows) || !rows.some((r) => r.readyKind)) return; seen++; for (const r of rows) { const k = r.readyKind.value; counts[k] = (counts[k] ?? 0) + 1; total++; } };
        await w.start({ ready: true }); const r = await w.get(FULL); assert.equal(r.status, 200, r.text.slice(0, 200));
        assert.equal(seen, 1, `PRECONDITION: exactly one readiness UNION was read (${seen})`);
        assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), total, 'the kinds add up to the total rows');
        assert.equal(counts.facts, declared.cards, 'facts: one row per card');
        assert.equal(counts.context, declared.contextRows, 'context: one row per relatedTo / derivedFrom / supersedes / supersededBy edge');
        assert.equal(counts.blockers, declared.blockedByEdges, 'blockers: one row per blockedBy edge');
        assert.equal(counts.implementedBy ?? 0, withStamp ? declared.implementedByRows : 0, `implementedBy: ${withStamp ? 'one row per commit link' : 'the branch is absent without a stamp'}`);
        console.log(`PS5 ${withStamp ? 'stamp' : 'no stamp'}: ${total} rows ${JSON.stringify(counts)}`);
      });
    });
  }
});
