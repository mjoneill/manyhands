/**
 * #1384 — shuffle must DEAL the pool, not draw from it with replacement.
 *
 * Read 2026-09-27 02:12Z: with shuffle on, each hourly firing drew
 * `items[floor(rand() * length)]` with no memory of what had fired. From a pool
 * of 22 that is ≈9.2 expected repeats per 24 firings, and the room saw the same
 * prompt twice in one evening, three nights running.
 *
 * The fix is a shuffle-bag: every active prompt fires once per cycle, in random
 * order. The cycle number is STORED on each TendingMint (spec c69c7266). A
 * derivation that walked history back to the first duplicate was proposed and
 * falsified in review: at every cycle boundary it inherited most of the previous
 * cycle as "already dealt", and a 66-firing simulation put 22 / 21 / 19 distinct
 * prompts in consecutive blocks. The acceptance below is that test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bagState, selectFromBag } from '../core/tending-pool.mjs';

const P = 'https://scrumboard.local/tending/prompt/';
const entry = (slug, v = 1) => ({ slug, promptId: P + slug, versionId: `${P}${slug}/v${v}`, body: `body ${slug}` });
const pool = (n) => Array.from({ length: n }, (_, i) => entry(`p${String(i).padStart(2, '0')}`));
const idOf = (versionId) => String(versionId).replace(/\/v\d+$/, '');

// A seeded generator, so a failure reproduces exactly.
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** Fire `n` times against `poolAt(i)`, feeding each mint back in, exactly as the server does. */
function simulate(n, poolAt, rand = lcg(1)) {
  const mints = [];
  for (let i = 0; i < n; i += 1) {
    const p = poolAt(i, mints);
    const bag = bagState(mints, p);
    const last = mints.length ? mints[mints.length - 1].versionId : null;
    const pick = selectFromBag(p, bag, rand, last);
    if (!pick) { mints.push(null); continue; }
    mints.push({ versionId: pick.entry.versionId, cycle: pick.cycle, mintedAt: String(i).padStart(6, '0') });
  }
  return mints;
}

test('#1384 ACCEPTANCE: 3 × |pool| firings put every prompt exactly once in each block', () => {
  const p = pool(22);
  const mints = simulate(66, () => p);
  for (let b = 0; b < 3; b += 1) {
    const block = mints.slice(b * 22, b * 22 + 22).map((m) => idOf(m.versionId));
    assert.equal(new Set(block).size, 22, `block ${b + 1} had ${new Set(block).size} distinct prompts: ${block.join(',')}`);
  }
});

test('#1384 cycles are numbered from 1 and advance only when the whole pool has been dealt', () => {
  const mints = simulate(45, () => pool(22));
  assert.deepEqual(mints.map((m) => m.cycle), [...Array(22).fill(1), ...Array(22).fill(2), 3]);
});

test('#1384 the first pick of a new cycle never repeats the last pick of the old one', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const mints = simulate(8, () => pool(4), lcg(seed));
    for (let i = 1; i < mints.length; i += 1) {
      assert.notEqual(idOf(mints[i].versionId), idOf(mints[i - 1].versionId), `seed ${seed}: back-to-back repeat at firing ${i}`);
    }
  }
});

test('#1384 pool sizes 0, 1 and 2: no deadlock, the guard yields when there is no other choice', () => {
  assert.equal(selectFromBag([], bagState([], []), lcg(1), null), null, 'an empty pool picks nothing');
  const one = simulate(3, () => pool(1));
  assert.deepEqual(one.map((m) => idOf(m.versionId)), [P + 'p00', P + 'p00', P + 'p00'], 'a pool of one repeats, because nothing else exists');
  const two = simulate(6, () => pool(2));
  for (let i = 1; i < two.length; i += 1) assert.notEqual(two[i].versionId, two[i - 1].versionId, `pool of two alternated at ${i}`);
});

test('#1384 a prompt disabled mid-cycle cannot stop the cycle closing', () => {
  const full = pool(5);
  // Disable p02 after two firings. If it had not yet been dealt, a cycle that
  // waited for it would never close.
  const without = full.filter((e) => e.slug !== 'p02');
  const mints = simulate(12, (i) => (i < 2 ? full : without));
  const cycles = mints.map((m) => m.cycle);
  assert.ok(cycles.includes(2) && cycles.includes(3), `cycles must keep advancing: ${cycles.join(',')}`);
  assert.ok(mints.slice(2).every((m) => idOf(m.versionId) !== P + 'p02'), 'a disabled prompt is never picked');
});

test('#1384 disabling a prompt that ALREADY fired this cycle does not close the cycle early', () => {
  // The dealt set must be counted against the CURRENT pool. Counted against
  // history, the disabled prompt still fills a slot, the cycle closes one short,
  // and a live prompt is skipped for a whole cycle.
  for (let seed = 1; seed <= 50; seed += 1) {
    const full = pool(5);
    const mints = simulate(9, (i, soFar) => (i < 2 ? full
      : full.filter((e) => e.versionId !== soFar[0].versionId)), lcg(seed));
    const cycle1 = mints.filter((m) => m.cycle === 1).map((m) => idOf(m.versionId));
    const live = full.filter((e) => e.versionId !== mints[0].versionId).map((e) => e.promptId);
    for (const id of live) assert.ok(cycle1.includes(id), `seed ${seed}: ${id} was skipped in cycle 1 (${cycle1.join(',')})`);
  }
});

test('#1384 a prompt added mid-cycle is dealt in the SAME cycle', () => {
  const base = pool(4);
  const grown = [...base, entry('new')];
  const mints = simulate(5, (i) => (i < 2 ? base : grown));
  assert.deepEqual(new Set(mints.map((m) => idOf(m.versionId))).size, 5, 'all five, including the new one, before any repeat');
  assert.ok(mints.every((m) => m.cycle === 1));
});

test('#1384 an edited prompt (new version) is the SAME prompt: it is not dealt twice in a cycle', () => {
  const v1 = pool(3);
  const mints = [{ versionId: v1[0].versionId, cycle: 1, mintedAt: '1' }];
  const edited = [entry('p00', 2), v1[1], v1[2]];
  const bag = bagState(mints, edited);
  assert.deepEqual(bag.dealt, [P + 'p00'], 'p00 v1 counts as dealt for p00 v2');
  for (let s = 1; s <= 50; s += 1) {
    const pick = selectFromBag(edited, bag, lcg(s), mints[0].versionId);
    assert.notEqual(pick.entry.slug, 'p00', `seed ${s} re-dealt the edited prompt`);
  }
});

test('#1384 BOOTSTRAP: legacy mints with no cycle number are ignored, and the first bag firing opens cycle 1', () => {
  const legacy = pool(3).map((e, i) => ({ versionId: e.versionId, mintedAt: String(i) }));
  assert.deepEqual(bagState(legacy, pool(3)), { cycle: 1, dealt: [] });
});

test('#1384 CONTROL: the old uniform draw fails the acceptance with the same seed', () => {
  // Proves the acceptance can fail. Draw-with-replacement over 22 firings from a
  // pool of 22 almost surely repeats; if this ever passes, the acceptance is too weak.
  const rand = lcg(1);
  const p = pool(22);
  const block = Array.from({ length: 22 }, () => p[Math.floor(rand() * p.length)].slug);
  assert.ok(new Set(block).size < 22, 'a uniform draw produced 22 distinct in 22: the acceptance would not catch the defect');
});

// ── the seam: a recorded firing's cycle is what the NEXT firing is dealt from ──
import { promptId, promptVersionId, playlistId, playlistVersionId } from '../core/tending-ids.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const AT = '2026-09-27T00:00:00.000Z';
const prompts = ['alpha', 'beta'].flatMap((slug) => [
  { '@id': promptId(slug), '@type': 'scrum:TendingPrompt', identifier: slug, 'scrum:importedAt': AT },
  { '@id': promptVersionId(slug, 1), '@type': 'scrum:TendingPromptVersion', 'scrum:ofPrompt': promptId(slug), 'scrum:version': 1, 'scrum:body': `${slug} body`, author: 'person:ada', 'scrum:importedAt': AT },
]);
// The pool is what the current playlist version orders, not every prompt node.
const playlist = [
  { '@id': playlistId('main'), '@type': 'scrum:TendingPlaylist', identifier: 'main', 'scrum:importedAt': AT },
  { '@id': playlistVersionId('main', 1), '@type': 'scrum:TendingPlaylistVersion', 'scrum:ofPlaylist': playlistId('main'), 'scrum:version': 1,
    'scrum:orderedPrompts': { '@list': [promptVersionId('alpha', 1), promptVersionId('beta', 1)] }, 'scrum:importedAt': AT },
];

test('#1384 SEAM: GET /api/tending/whispers reports the bag, and a mint POSTed with its cycle moves it', { timeout: 30000 }, async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1,
    tending: [...prompts, ...playlist, { '@id': 'https://scrumboard.local/tending/state/current', '@type': 'scrum:TendingState', 'scrum:enabled': true }] }) });
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const mint = (slug, n, cycle) => api('POST', '/api/tending/mints', { window: `2026-09-27T0${n}`, mintedAt: `2026-09-27T0${n}:00:00.000Z`, versionId: promptVersionId(slug, 1), cycle, by: 'board' });

    let w = await api('GET', '/api/tending/whispers');
    assert.equal(w.status, 200);
    assert.equal(w.body.whispers.length, 2, JSON.stringify(w.body.whispers));
    assert.deepEqual(w.body.bag, { cycle: 1, dealt: [] }, 'a pool with no numbered mints opens cycle 1');

    assert.equal((await mint('alpha', 1, 1)).status, 201);
    w = await api('GET', '/api/tending/whispers');
    assert.deepEqual(w.body.bag, { cycle: 1, dealt: [promptId('alpha')] }, 'the stored cycle is read back as dealt');

    assert.equal((await mint('beta', 2, 1)).status, 201);
    w = await api('GET', '/api/tending/whispers');
    assert.deepEqual(w.body.bag, { cycle: 2, dealt: [] }, 'the whole pool dealt: the next firing opens cycle 2');

    const q = await api('POST', '/api/graph', { query: 'SELECT (COUNT(?m) AS ?n) WHERE { ?m a scrum:TendingMint ; scrum:tendingCycle ?c }' });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(Number(q.body.rows?.[0]?.n ?? q.body.results?.bindings?.[0]?.n?.value), 2, `the cycle is a queryable graph fact: ${JSON.stringify(q.body)}`);
  } finally { await srv.stop(); }
});

test('#1384 a STALE bag (every prompt already dealt) still never re-deals the prompt that just fired', () => {
  // Unreachable while bag and pool come from one read (bagState rolls first),
  // but a caller passing a stale bag must not get a back-to-back repeat.
  const p = pool(3);
  const staleBag = { cycle: 1, dealt: p.map((e) => e.promptId) };
  // Fixed draws covering every index: a seeded LCG's FIRST value barely moves
  // with the seed (0.23–0.28 for seeds 1–100), which let this test pass blind.
  for (const r of [0, 0.34, 0.5, 0.67, 0.99]) {
    const pick = selectFromBag(p, staleBag, () => r, p[1].versionId);
    assert.equal(pick.cycle, 2, 'the roll-over opens the next cycle');
    assert.notEqual(pick.entry.slug, 'p01', `draw ${r} re-dealt the prompt that just fired`);
  }
});
