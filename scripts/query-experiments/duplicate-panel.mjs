#!/usr/bin/env node
/**
 * duplicate-panel.mjs — the BM25 duplicate-suggestion instrument from 2026-08-03.
 *
 * WHY THIS FILE EXISTS: the room found that self-audit happens exactly where
 * someone else's audit already paid for the instrument, and nowhere else. Two
 * seats, two mechanisms, same finding. So the instruments live here rather than
 * in a session scratchpad — otherwise the next check costs full price and
 * therefore does not happen. Organizing principle: make the right thing the * cheapest path, and the room does it on its own.
 *
 * ⚠️ NOT production code. It is a measuring device, and its numbers were used to
 * gate a build decision, so its defaults are load-bearing — see CALIBRATION.
 *
 * Usage:
 *   node duplicate-panel.mjs 647              # panel for one card, as-of its filing
 *   node duplicate-panel.mjs --sample 12      # random ordinary filings, unrated
 *   node duplicate-panel.mjs --pairs          # the labelled rediscovery set
 *
 * ⭐ PROTOCOL NOTE, learned the hard way: if a second rater is going to score
 * these panels, PUBLISH THE PANELS BEFORE YOUR VERDICT, never in the same
 * message. Shipping evidence and conclusion together reads as thorough and
 * destroys the second rater's blind — it happened on 2026-08-03 and cost a
 * whole sample.
 */

const BASE = process.env.BOARD_URL || 'http://127.0.0.1:3141';

// ── CALIBRATION ────────────────────────────────────────────────────────────
// k1/b are BM25 defaults. `b` (length normalisation) is the one that matters
// here: WITHOUT it the longest cards (#454 54KB, #530 36KB, #584 30KB) match
// every query and dominate every panel. Adding it moved the labelled set from
// ranks 1/3/9/63 to 1/2/1/46. Do not set b=0 without re-running --pairs.
const K1 = 1.5;
const B = 0.75;

// The four adjudicated rediscovery pairs the room reasoned from, plus the three
// the instrument itself surfaced. ⚠️ All of the first four are cases a HUMAN
// eventually noticed, so any hit rate measured on them is an optimistic
// ceiling. The last three were found by this script and are the less-biased
// evidence.
const LABELLED = [
  [533, 466], [534, 466], [647, 455], [424, 125], // human-noticed
  [644, 573], [514, 499], [384, 383],             // instrument-found
];

const STOP = new Set(('the a an and or of to in for on is are be by with that this it its'
  + ' no not new from as at we our us can').split(' '));

const tokens = (s) => (s || '').toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [];

async function loadCards() {
  // NB: no-param /api/cards is the legacy bare array WITH descriptions, which is
  // what scoring needs. The bounded default (#657) omits them by design.
  const res = await fetch(`${BASE}/api/cards`);
  if (!res.ok) throw new Error(`board unreachable: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.cards ?? []);
}

function buildIndex(cards) {
  const docs = new Map();
  const df = new Map();
  for (const c of cards) {
    const t = tokens(`${c.title} ${c.description || ''}`);
    docs.set(c.shortId, t);
    for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const N = cards.length;
  const avgdl = [...docs.values()].reduce((a, d) => a + d.length, 0) / N;
  return { docs, df, N, avgdl };
}

function bm25(query, shortId, ix) {
  const d = ix.docs.get(shortId);
  if (!d) return 0;
  const tf = new Map();
  for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
  let score = 0;
  for (const w of query) {
    const f = tf.get(w);
    if (!f) continue;
    const n = ix.df.get(w) ?? 0;
    const idf = Math.log(1 + (ix.N - n + 0.5) / (n + 0.5));
    score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.length / ix.avgdl)));
  }
  return score;
}

/**
 * The panel a filer would see. Scores ONLY cards that existed when `shortId`
 * was filed — without that the instrument cheats, and a card written about the
 * analysis links everything the analysis discussed (the #656 observer effect).
 */
function panel(shortId, cards, ix, k = 3) {
  const card = cards.find((c) => c.shortId === shortId);
  if (!card) throw new Error(`no card #${shortId}`);
  const q = new Set(tokens(card.title));
  return cards
    .filter((c) => c.shortId !== shortId && (c.createdAt || '') < card.createdAt)
    .map((c) => ({ score: bm25(q, c.shortId, ix), shortId: c.shortId, title: c.title }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const fmt = (rows) => rows.map((r) => `      ${r.score.toFixed(2).padStart(6)}  #${String(r.shortId).padEnd(4)} ${r.title.slice(0, 62)}`).join('\n');

const [, , ...argv] = process.argv;
const cards = await loadCards();
const ix = buildIndex(cards);
const byId = new Map(cards.map((c) => [c.shortId, c]));

if (argv[0] === '--pairs') {
  // Does the instrument still find what it found on 2026-08-03? Ranks will
  // drift as the board grows; a large jump means the corpus changed under you.
  for (const [newer, older] of LABELLED) {
    if (!byId.has(newer) || !byId.has(older)) { console.log(`#${newer}→#${older}  MISSING`); continue; }
    const full = panel(newer, cards, ix, cards.length);
    const rank = full.findIndex((r) => r.shortId === older) + 1;
    console.log(`#${newer} → #${older}   rank ${rank || 'NOT FOUND'} / ${full.length}`);
  }
} else if (argv[0] === '--sample') {
  // Unrated panels for a second rater. Prints NO verdict on purpose.
  const n = Number(argv[1] || 12);
  const seen = new Set(LABELLED.flat());
  const pool = cards.filter((c) => c.shortId > 200 && !seen.has(c.shortId));
  // Deterministic shuffle — Math.random would make the sample unciteable.
  const seed = Number(argv[2] || 4242);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = pool.sort((a, b) => a.shortId - b.shortId)
    .map((c) => ({ c, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, n)
    .map((x) => x.c).sort((a, b) => a.shortId - b.shortId);
  console.log(`# ${n} random filings, seed ${seed}. NO RATINGS — rate before reading anyone else's.\n`);
  for (const c of pick) {
    console.log(`#${c.shortId}  ${c.title.slice(0, 70)}`);
    console.log(fmt(panel(c.shortId, cards, ix)));
    console.log();
  }
} else if (argv[0]) {
  const id = Number(argv[0]);
  const c = byId.get(id);
  console.log(`FILING #${id}  ${c.title}\n`);
  console.log(fmt(panel(id, cards, ix, 5)));
} else {
  console.log('usage: duplicate-panel.mjs <shortId> | --sample [n] [seed] | --pairs');
}
