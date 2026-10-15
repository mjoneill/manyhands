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
 *   PS5  ACCOUNTING: the rows the executor returns for the readiness read, counted by `?readyKind`, equal what the board declares for facts, blockers and implementedBy, and the kinds
 *        add up to the total. The context kind is NOT pinned here: it is the one kind a row-reducing candidate may change, and PS6 owns it.
 *   PS6  THE DESIGN (posted before the build): the normal path reads the context edges of cards that are not done and no others, and a request for one card's explanation reads all of
 *        them. RED on today's code, which reads every context edge on both paths. Done cards are never offered and their context is dropped from the page, so none of the 2,000+ rows
 *        read for them is part of the answer. Everything else here must keep passing unchanged.
 *
 * SHAPE OF THE FILE (revision after the first CI run): every row that needs an executor shares ONE world, restarted behind REST with or without a stamp file and with the switch on or off. The
 * first version built nine worlds and was killed by the suite runner's 300 s bound on the CI runner (about 8 to 10 times slower than a laptop at building a world). The rows that change the board (PS4, PS8) run last.
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
  near(d.doneCards, PROD_MEASURED.doneCards, 0.08, 'done cards');
  const doneShare = (d.contextRows - d.contextRowsOpen) / d.contextRows; const prodShare = PROD_MEASURED.doneContextRows / (PROD_MEASURED.relatedToRows + PROD_MEASURED.derivedFromRows + PROD_MEASURED.supersedesRows + PROD_MEASURED.supersededByRows);
  assert.ok(Math.abs(doneShare - prodShare) <= 0.05, `the share of context edges that belong to done cards (${doneShare.toFixed(3)}) is within 5 points of production's ${prodShare.toFixed(3)}`);
  assert.equal(d.contextRows, d.relatedToRows + d.derivedFromRows + d.supersedesRows + d.supersededByRows, 'the declared context total is the sum of its four edge types');
  assert.equal(JSON.stringify(prodShapeBoard().board), JSON.stringify(a.board), 'the same seed gives the same board, byte for byte');
  assert.notEqual(JSON.stringify(prodShapeBoard({ seed: 7 }).board), JSON.stringify(a.board), 'CONTROL: another seed gives another board, so the comparison above can fail');
});

// ---- PS8: a card moving INTO done while the (single) readiness query runs ----
// The design reads a card's context only when the SAME snapshot says the card is not done. The one-query shape is what keeps those two facts from coming from different moments, and the
// executor's own snapshot property (S3 in the #1644 snapshot file) is what keeps ONE query whole. This row puts the two together on the candidate's own query text: the text the REST sends is
// captured, a deliberately slow branch is appended (so a write can land inside it), and while it runs one card with context is moved to done through REST. For that card the rows of the
// answer must agree with each other: a context row exists exactly when the facts row of the same answer says "not done" (or always, when the query does not filter).
// any spelling of "leave out the done cards": FILTER NOT EXISTS, FILTER(!EXISTS ...), or MINUS
const FILTER_RE = /NOT\s+EXISTS|!\s*EXISTS|\bMINUS\b/i;
const isDone = (colValue) => /\/done$/.test(String(colValue)) || String(colValue) === 'column:done';
/** For card #n, the pair the answer's own rows imply: [is it done in the facts rows, how many context rows does it have]. */
const impliedBy = (rows, n) => ({
  done: isDone(rows.find((r) => r.readyKind?.value === 'facts' && r.id?.value === String(n))?.col?.value),
  ctx: rows.filter((r) => r.readyKind?.value === 'context' && r.id?.value === String(n)).length,
});
const torn = ({ done, ctx }, edges, filtered) => (filtered && done ? ctx !== 0 : ctx !== edges);

test('#1698 (PS8-CONTROL) the torn-read check can fail: facts read before a card goes done and context read after (two requests) is caught', () => {
  assert.equal(torn({ done: false, ctx: 0 }, 5, true), true, 'not done in the facts rows but no context rows: torn');
  assert.equal(torn({ done: true, ctx: 5 }, 5, true), true, 'done in the facts rows but context rows present, with the filter on: torn');
  assert.equal(torn({ done: false, ctx: 5 }, 5, true), false); assert.equal(torn({ done: true, ctx: 0 }, 5, true), false);
  assert.equal(torn({ done: true, ctx: 5 }, 5, false), false, 'without the filter the context is always there: not torn');
});

// ---- The rows that need an executor share ONE world ----
// The first version made nine worlds (an executor and a 1,600-card migration each) and took 117 to 135 s on a laptop and more than 300 s on the CI runner, where the suite runner killed the file
// ("HUNG ... exceeded 300000ms") in both runs on PR #63. One world (one executor, one migration) is restarted behind REST with or without a stamp file and with the switch on or off. The rows that
// CHANGE the board (PS4, PS8) run last, and PS8 skips the card PS4 closed. The assertions are the same ones; only the sharing changed.
test('#1698 production-shaped board, one world: PS1 and PS2 parity, PS2-CONTROL, PS3 explain, PS5 accounting, PS6 the design, then PS4 a state change and PS8 a mid-read move', { skip: SKIP, timeout: 1500000 }, async (t) => {
  const { board, shas, declared, cardsList } = prodShapeBoard();
  await withStampEnv(true, shas, async (stampEnv) => {
    await worldWithEnv(board, {}, async (w) => {
      /** Both paths on this world, with the stamp on or off. */
      const bothPaths = async (stamped, route) => {
        const env = stamped ? stampEnv : {};
        await w.start({ env }); const oracle = await w.get(route);
        await w.start({ ready: true, env }); const on = await w.get(route);
        assert.equal(oracle.status, 200, oracle.text.slice(0, 300)); assert.equal(on.status, 200, on.text.slice(0, 300));
        assert.equal(oracle.json.source, 'replica', 'the oracle leg REPORTS replica'); assert.equal(on.json.source, 'executor', 'the switched leg REPORTS executor');
        return { oracle, on };
      };
      const saved = {};
      for (const stamped of [false, true]) {
        await t.test(`#1698 (${stamped ? 'PS2' : 'PS1'}) PARITY on the production-shaped board, ${stamped ? 'shipped shas PRESENT' : 'shipped shas ABSENT'}: the whole queue equals the in-process answer`, async () => {
          const { oracle, on } = await bothPaths(stamped, FULL); saved[stamped ? 'stamp' : 'plain'] = oracle.json;
          assert.ok(oracle.json.readyTotal > 100, `PRECONDITION: a real queue (${oracle.json.readyTotal} ready) so an empty-equals-empty pass is impossible`);
          assert.ok(oracle.json.excluded.length > 100, `PRECONDITION: a real excluded list (${oracle.json.excluded.length})`);
          assert.ok(oracle.json.ready.some((c) => (c.context?.relatedTo?.total ?? 0) > 5), 'PRECONDITION: ready items carry related members');
          assert.deepEqual(noWm(on.json), noWm(oracle.json), 'every ready item with its context, and every excluded item, in the same order');
          assert.equal(on.json.readyTotal, oracle.json.readyTotal, 'readyTotal'); assert.equal(on.json.excludedTotal, oracle.json.excludedTotal, 'excludedTotal');
          assert.equal(on.json.excluded.length, on.json.excludedTotal, 'PRECONDITION: the whole excluded list is on the page, so a dropped excluded card cannot hide beyond it');
          assert.equal(on.json.excluded.filter((c) => c.reason === 'column:done').length, declared.doneCards, 'every done card is still listed as excluded (their facts are still read)');
          assert.ok(on.json.excluded.every((c) => Object.keys(c).sort().join() === 'reason,shortId,title'), 'and the excluded list keeps its shape: shortId, title, reason, and no context');
        });
      }

      await t.test('#1698 (PS2-CONTROL) the stamp changes the answer: with shipped shas the queue differs from without, so PS2 cannot pass on a path that ignores them', async () => {
        assert.ok(saved.plain && saved.stamp, 'PRECONDITION: PS1 and PS2 produced their in-process answers');
        assert.notDeepEqual(noWm(saved.stamp), noWm(saved.plain), 'shipped shas must change at least one verdict on this board (cards whose commits are not all deployed)');
      });

      await t.test('#1698 (PS3) explain parity on the cards that stress the shape, including a done card\'s FULL context', async () => {
        const busiest = cardsList.reduce((m, c) => (c.relationships.relatedTo.length > m.relationships.relatedTo.length ? c : m));
        const pickBy = (f) => cardsList.find(f);
        const busiestDone = cardsList.filter((c) => c.column === 'done').reduce((m, c) => (c.relationships.relatedTo.length > m.relationships.relatedTo.length ? c : m));
        const sample = [busiest, busiestDone, pickBy((c) => c.parkedBy), pickBy((c) => c.relationships.supersededBy.length), pickBy((c) => c.blockers?.length), pickBy((c) => c.implementedBy?.length)];
        assert.ok(sample.every(Boolean), 'PRECONDITION: the board has a card of every stressing kind');
        const explainAll = async () => { const out = []; for (const c of sample) { const r = await w.get(`/api/ready?explain=${c.shortId}`); assert.equal(r.status, 200, r.text.slice(0, 200)); out.push(noWm(r.json)); } return out; };
        await w.start({ env: stampEnv }); const oracleExplain = await explainAll();
        await w.start({ ready: true, env: stampEnv }); const onExplain = await explainAll();
        assert.deepEqual(onExplain, oracleExplain, 'explain for the busiest, done, parked, superseded, person-blocked and commit-carrying cards equals the in-process answer');
        assert.equal(onExplain[1].context?.relatedTo?.total, busiestDone.relationships.relatedTo.length, `an explanation of the done card #${busiestDone.shortId} carries its FULL context (${busiestDone.relationships.relatedTo.length} relatedTo edges), whatever the normal path leaves out`);
        assert.ok(busiestDone.relationships.relatedTo.length >= 5, 'PRECONDITION: that done card has real context');
      });

      await t.test('#1698 (PS5) the readiness read\'s facts, blockers and implementedBy rows, counted by ?readyKind, equal what the board declares and all kinds add up to the total', async () => {
        for (const withStamp of [false, true]) {
          const counts = {}; let total = 0; let seen = 0;
          w.proxy.rewrite = (j) => { const rows = j?.results?.bindings; if (!Array.isArray(rows) || !rows.some((r) => r.readyKind)) return; seen++; for (const r of rows) { const k = r.readyKind.value; counts[k] = (counts[k] ?? 0) + 1; total++; } };
          try { await w.start({ ready: true, env: withStamp ? stampEnv : {} }); const r = await w.get(FULL); assert.equal(r.status, 200, r.text.slice(0, 200)); } finally { w.proxy.rewrite = null; }
          assert.equal(seen, 1, `PRECONDITION: exactly one readiness UNION was read (${seen})`);
          assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), total, 'the kinds add up to the total rows');
          assert.equal(counts.facts, declared.cards, 'facts: one row per card');
          assert.equal(counts.blockers, declared.blockedByEdges, 'blockers: one row per blockedBy edge');
          assert.equal(counts.implementedBy ?? 0, withStamp ? declared.implementedByRows : 0, `implementedBy: ${withStamp ? 'one row per commit link' : 'the branch is absent without a stamp'}`);
          console.log(`PS5 ${withStamp ? 'stamp' : 'no stamp'}: ${total} rows ${JSON.stringify(counts)}`);
        }
      });

      await t.test('#1698 (PS6, DESIGN) the normal path reads the context edges of cards that are not done and no others; an explanation request reads all of them', async () => {
        assert.ok(declared.contextRowsOpen < declared.contextRows, `PRECONDITION: some context belongs to done cards (${declared.contextRows - declared.contextRowsOpen} rows), so the design has something to leave out`);
        const doneWithContext = cardsList.find((c) => c.column === 'done' && c.relationships.relatedTo.length > 3);
        assert.ok(doneWithContext, 'PRECONDITION: a done card that carries context');
        let kinds = null;
        w.proxy.rewrite = (j) => { const rows = j?.results?.bindings; if (!Array.isArray(rows) || !rows.some((r) => r.readyKind)) return; kinds = {}; for (const r of rows) kinds[r.readyKind.value] = (kinds[r.readyKind.value] ?? 0) + 1; };
        try {
          await w.start({ ready: true });
          const normal = await w.get(FULL); assert.equal(normal.status, 200, normal.text.slice(0, 200));
          assert.ok(kinds, 'PRECONDITION: the normal call read the readiness UNION'); const normalKinds = kinds; kinds = null;
          const ex = await w.get(`/api/ready?explain=${doneWithContext.shortId}`); assert.equal(ex.status, 200, ex.text.slice(0, 200));
          assert.ok(kinds, 'PRECONDITION: the explanation call read the readiness UNION'); const explainKinds = kinds;
          assert.equal(normalKinds.context, declared.contextRowsOpen, `normal path: the context rows are those of cards that are not done (${declared.contextRowsOpen}), not all ${declared.contextRows}`);
          assert.equal(explainKinds.context, declared.contextRows, 'explanation path: every context edge is still read');
          assert.equal(normalKinds.facts, declared.cards, 'and the facts of done cards are still read (they count in excludedTotal)');
          assert.ok(ex.json.context?.relatedTo?.total >= 1 || JSON.stringify(ex.json).includes('relatedTo'), 'and the explanation of a done card still carries its context');
        } finally { w.proxy.rewrite = null; }
      });

      // ---- from here the rows CHANGE the board ----
      let closedByPS4 = null;
      await t.test('#1698 (PS4) CONTROL: a state change to one card moves the answer, on both paths, and they still agree (so the parity comparison CAN fail)', async () => {
        await w.start({ env: stampEnv }); const before = (await w.get(FULL)).json;
        await w.start({ ready: true, env: stampEnv }); const beforeOn = (await w.get(FULL)).json;
        assert.deepEqual(noWm(beforeOn), noWm(before), 'PRECONDITION: the two paths agreed before the change');
        const target = noWm(before).ready.find((c) => !c.context?.relatedTo?.total)?.shortId ?? before.ready[0].shortId; closedByPS4 = target;
        const p = await w.patch(target, { column: 'done' }); assert.ok(p.status === 200, `the state change applied (${p.status}): ${p.text.slice(0, 200)}`);
        const afterOn = (await w.get(FULL)).json;
        await w.start({ env: stampEnv }); const afterOracle = (await w.get(FULL)).json;
        assert.notDeepEqual(noWm(afterOn), noWm(beforeOn), 'CONTROL: closing a ready card changes the executor path\'s answer');
        assert.deepEqual(noWm(afterOn), noWm(afterOracle), 'and the two paths still agree after the change');
      });

      await t.test('#1698 (PS8) a card with context moved to done while the single readiness query runs: its rows agree with each other, before or after, never mixed', async () => {
        const victims = cardsList.filter((c) => c.column !== 'done' && c.shortId !== closedByPS4 && c.relationships.relatedTo.length >= 3 && !c.claimedBy && !c.parkedBy).slice(0, 3);
        assert.equal(victims.length, 3, 'PRECONDITION: three cards with context to move, one per round');
        w.proxy.bodies = [];
        await w.start({ ready: true }); const first = await w.get(FULL); assert.equal(first.status, 200, first.text.slice(0, 200));
        const text = w.proxy.bodies.find((b) => /readyKind/.test(b)); assert.ok(text, 'PRECONDITION: the readiness UNION text was captured'); w.proxy.bodies = null;
        const filtered = FILTER_RE.test(text);
        const SLOW = ' UNION { SELECT ("slow" AS ?readyKind) (COUNT(*) AS ?n) WHERE { { SELECT ?a WHERE { ?a a schema:CreativeWork } LIMIT 800 } { SELECT ?b WHERE { ?b a schema:CreativeWork } LIMIT 800 } FILTER(STRLEN(CONCAT(STR(?a), STR(?b))) > 0) } } }';
        const slow = text.replace(/\}\s*$/, SLOW); assert.notEqual(slow, text, 'PRECONDITION: the slow branch was appended to the candidate\'s own text');
        const run = async (q) => { const t0 = performance.now(); const r = await fetch(`${w.exec.baseUrl}/query?dataset=public`, { method: 'POST', body: q, signal: AbortSignal.timeout(180000) }); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j).slice(0, 200)); return { rows: j.results.bindings, ms: performance.now() - t0 }; };
        const alone = await run(slow); assert.ok(alone.ms >= 400, `PRECONDITION: the read is slow enough for a write to land inside it (${Math.round(alone.ms)} ms alone)`);
        const log = [];
        for (const [i, v] of victims.entries()) {
          const edges = v.relationships.relatedTo.length + v.relationships.derivedFrom.length + v.relationships.supersedes.length + v.relationships.supersededBy.length;
          const t0 = performance.now(); const reading = run(slow); await new Promise((r) => setTimeout(r, 200));
          const w0 = performance.now(); const p = await w.patch(v.shortId, { column: 'done' }); const got = await reading;
          assert.equal(p.status, 200, `PRECONDITION: the move to done is accepted (${p.status}) ${p.text.slice(0, 120)}`);
          assert.ok(w0 - t0 < got.ms, `PRECONDITION: the write started while the read was in flight (it started ${Math.round(w0 - t0)} ms in, the read took ${Math.round(got.ms)} ms)`);
          const im = impliedBy(got.rows, v.shortId);
          assert.equal(torn(im, edges, filtered), false, `round ${i + 1}: card #${v.shortId} (${edges} context edges): the facts rows say done=${im.done} and ${im.ctx} context rows came with them; the filter is ${filtered ? 'on' : 'off'}, so this is a torn read`);
          const settled = impliedBy((await run(text)).rows, v.shortId);   // the candidate's own text, without the slow branch: cheap, and the same rows
          assert.equal(settled.done, true, `round ${i + 1}: afterwards the card reads as done (the write really landed)`);
          assert.equal(torn(settled, edges, filtered), false, `round ${i + 1}: and the settled rows agree`);
          log.push(`${i + 1}: during=${im.done ? 'AFTER' : 'BEFORE'}`);
        }
        console.log(`PS8 filter ${filtered ? 'on' : 'off'}; ${log.join(' | ')}`);
      });
    });
  });
});

// ---- PS9: the contract of `readyFromExecutor` for callers other than the normal HTTP path ----
// The reduced context is OPT-IN (`contextOf: 'open'`) and the default stays today's full context, so any other or future caller keeps today's behaviour unless it asks.
import { readyFromExecutor } from '../core/ready-query.mjs';
const textOf = async (opts) => { let q = null; try { await readyFromExecutor(async (sparql) => { q = sparql; return []; }, opts); } catch { /* an empty answer is fine: only the text matters */ } return q; };
test('#1698 (PS9) readyFromExecutor reads every context edge by default, and reads only the edges of cards that are not done when asked (contextOf: \'open\')', async () => {
  const dflt = await textOf({ shippedShas: null }); const open = await textOf({ shippedShas: null, contextOf: 'open' });
  assert.ok(dflt && open, 'PRECONDITION: both calls produced a query');
  assert.ok(!FILTER_RE.test(dflt), 'the DEFAULT query has no done filter: every context edge, as today');
  assert.ok(FILTER_RE.test(open) && /column:done|\/column\/done/.test(open), 'asking for contextOf "open" adds a filter that leaves out cards in column done');
  for (const kind of ['facts', 'blockers', 'superseded', 'human', 'condition']) assert.ok(open.includes(`"${kind}" AS ?readyKind`) && dflt.includes(`"${kind}" AS ?readyKind`), `the ${kind} branch is in both`);
});

test('#1698 (PS9b) readyFromExecutor refuses a contextOf it does not know, before it asks the executor anything', async () => {
  let asked = 0;
  for (const bad of ['everything', 'OPEN', '', 0, true, {}]) {
    await assert.rejects(() => readyFromExecutor(async () => { asked++; return []; }, { shippedShas: null, contextOf: bad }), undefined, `contextOf ${JSON.stringify(bad)} is refused`);
  }
  assert.equal(asked, 0, 'and the executor was never asked: a mistyped option must not quietly fall back to either read');
  for (const good of ['all', 'open']) await readyFromExecutor(async () => [], { shippedShas: null, contextOf: good });   // CONTROL: the two known values are accepted
});
