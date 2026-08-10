#!/usr/bin/env node
/**
 * scripts/race-corpus.mjs — #755: WHICH cards were created in a race, and when.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * #755's evidence table leads with "11 documented creation races (gaps 6s–64s),
 * TWO independently written scripts — ⭐ STRONGEST". That number sizes the whole
 * offer, and as of 2026-08-10 neither the member list nor either script
 * survives: five pairs are named in the card's 86KB, the other six are gone,
 * and the scripts lived in a session working directory that no longer exists.
 *
 * ⇒ So the strongest row in the table is a COUNT WITH NO MEMBERS AND NO
 *   INSTRUMENT. It cannot be audited, re-run, or corrected by anyone who was
 *   not in the room the day it was produced.
 *
 * ⚠️ That is the exact defect `tests/sprint-review-cli.test.mjs` was written to
 * prevent — "produced by ad-hoc glue in the author's own session, and a second
 * seat could not reproduce them, not because the code was wrong but because the
 * glue existed nowhere the repo could see." We wrote that test for the review
 * instrument and left the headline evidence in the state it forbids.
 *
 * ── THE RULE WAS PRE-REGISTERED ─────────────────────────────────────────────
 * Posted to #755 at 2026-08-10T22:02Z, BEFORE this script was run even once, by
 * an author who holds a position on what the answer implies. The thresholds and
 * the stoplist below are that posted rule, transcribed. If they are ever tuned,
 * the tuning is a visible diff against a timestamped post.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * ⛔ It does not classify a race as keyed or unkeyed. That is a judgement about
 * whether a human message was a request, it is the number under dispute, and
 * the author of this script argued for one side of it. Detection is mechanical
 * and belongs here; classification is judgement and belongs to a seat with no
 * stake. See #755.
 *
 * ⛔ It does not drop candidates it believes are false positives. A reader must
 * be able to disagree with a ROW, not with a filter they cannot see. S3 is
 * expected to produce false positives (#767~#770 on 2026-08-10 shared four
 * distinctive tokens and were unrelated); they are printed and labelled.
 */

import { readFileSync, existsSync } from 'node:fs';

// ── the pre-registered rule, transcribed ────────────────────────────────────

/** Max gap for a pair to be a CANDIDATE. Deliberately wider than the answer. */
const WINDOW_SECONDS = 300;

/**
 * ⚠️ 300s, not the 64s of the card's stated range. Thresholding at the edge of
 * the known answer guarantees rediscovering the known answer. Every pair prints
 * its gap so a reader can re-threshold downward; nobody can re-threshold upward
 * through a filter that already ran.
 */

/** S3: minimum shared distinctive title tokens. */
const MIN_SHARED_TOKENS = 3;

/** Fixed before the first run. Common board vocabulary that carries no topic. */
const STOPLIST = new Set([
  'card', 'board', 'work', 'seat', 'that', 'this', 'with', 'from', 'have',
  'when', 'what', 'which', 'cannot', 'never', 'every', 'into', 'their',
  'there', 'been', 'does', 'not',
]);

const distinctive = (title) =>
  new Set(
    String(title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOPLIST.has(t)),
  );

// ── input ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--board') out.board = argv[i + 1];
    if (argv[i] === '--since') out.since = argv[i + 1];
    if (argv[i] === '--window') out.window = Number(argv[i + 1]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ⛔ No default path. A hardcoded location is one machine's layout published
// into a public repo — the same refusal scripts/sprint-review.mjs makes.
if (!args.board) {
  console.error('usage: race-corpus.mjs --board <board-data.json> [--since <ISO>] [--window <seconds>]');
  console.error('  --board is REQUIRED: this script will not guess where the board data lives.');
  process.exit(2);
}
if (!existsSync(args.board)) {
  console.error(`board file not found: ${args.board}`);
  process.exit(2);
}
if (args.since && Number.isNaN(Date.parse(args.since))) {
  console.error(`--since is not a parseable timestamp: ${args.since}`);
  process.exit(2);
}

const windowSeconds = Number.isFinite(args.window) ? args.window : WINDOW_SECONDS;

// ── load ────────────────────────────────────────────────────────────────────

const graph = JSON.parse(readFileSync(args.board, 'utf8'))['@graph'] || [];
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * ⛔ Relationship edges are UUIDs (`@id`), NOT shortIds.
 *
 * The first version of this parser scraped trailing digits off the reference —
 * which turns "b575995c-…-6aba6bda8602" into 8602, a shortId that never exists.
 * S1 therefore reported ZERO supersession-linked races across the whole board,
 * silently, and looked like a fact about the data.
 *
 * ⚠️ It was caught only because a title in the output said "[superseded by
 * #389]" while S1 claimed no supersession edges existed anywhere — an observed
 * fact contradicting the instrument, which is the third time in one day that
 * was the tell rather than the code looking wrong. A zero-hit source is a
 * finding; the finding here was about the instrument.
 */
const uuidToShortId = new Map(
  graph
    .filter((n) => n['@type'] === 'CreativeWork' && n['@id'] != null && n.identifier != null)
    .map((n) => [String(n['@id']), Number(n.identifier)]),
);
const shortIdOf = (ref) => uuidToShortId.get(String(ref)) ?? null;

const cards = graph
  .filter((n) => n['@type'] === 'CreativeWork' && n.dateCreated && n.identifier != null)
  .map((n) => ({
    id: Number(n.identifier),
    title: String(n.name || ''),
    at: Date.parse(n.dateCreated),
    iso: n.dateCreated,
    supersedes: asArray(n.supersedes).map(shortIdOf).filter((x) => x != null),
    supersededBy: asArray(n.supersededBy).map(shortIdOf).filter((x) => x != null),
  }))
  .filter((c) => !Number.isNaN(c.at))
  .filter((c) => !args.since || c.at >= Date.parse(args.since))
  .sort((a, b) => a.at - b.at);

// ── detect ──────────────────────────────────────────────────────────────────

const rows = [];
for (let i = 0; i < cards.length; i += 1) {
  for (let j = i + 1; j < cards.length; j += 1) {
    const gap = (cards[j].at - cards[i].at) / 1000;
    if (gap <= 0) continue;
    if (gap > windowSeconds) break; // sorted: everything later is further away

    const A = cards[i];
    const B = cards[j];
    const sources = [];

    // S1 — an explicit supersession edge between the two
    if (A.supersedes.includes(B.id) || A.supersededBy.includes(B.id)
      || B.supersedes.includes(A.id) || B.supersededBy.includes(A.id)) {
      sources.push('S1:supersession');
    }

    // S2 — either title marks itself a duplicate
    const dupish = (t) => /\[dup|duplicate/i.test(t);
    if (dupish(A.title) || dupish(B.title)) sources.push('S2:dup-title');

    // S3 — shared distinctive tokens
    const ta = distinctive(A.title);
    const tb = distinctive(B.title);
    const shared = [...ta].filter((t) => tb.has(t));
    if (shared.length >= MIN_SHARED_TOKENS) sources.push(`S3:tokens(${shared.length})`);

    if (sources.length) rows.push({ A, B, gap, sources, shared });
  }
}

// ── report ──────────────────────────────────────────────────────────────────

console.log('#755 RACE CORPUS — detection only, no keyed/unkeyed classification');
console.log(`board:  ${args.board}`);
console.log(`cards:  ${cards.length}${args.since ? ` (since ${args.since})` : ' (all)'}`);
console.log(`window: ${windowSeconds}s   min shared tokens: ${MIN_SHARED_TOKENS}`);
console.log(`rule pre-registered on #755 at 2026-08-10T22:02Z, before first run`);
console.log('');

if (!rows.length) {
  console.log('NO CANDIDATE PAIRS. That is a result, not an absence — the universe above was non-empty.');
} else {
  console.log(`CANDIDATE PAIRS: ${rows.length}`);
  console.log('');
  for (const r of rows.sort((x, y) => x.gap - y.gap)) {
    console.log(`#${r.A.id} + #${r.B.id}   gap ${r.gap.toFixed(1)}s   [${r.sources.join(' ')}]`);
    console.log(`   A ${r.A.iso}  ${r.A.title.slice(0, 96)}`);
    console.log(`   B ${r.B.iso}  ${r.B.title.slice(0, 96)}`);
    if (r.shared.length) console.log(`   shared: ${r.shared.join(' ')}`);
    console.log('');
  }
}

// ⚠️ Every count is printed with its members above. A count alone is a pointer
// to evidence nobody can follow — which is how the number this script exists to
// replace became unauditable in the first place.
console.log('--- by source (a pair may appear under several) ---');
for (const s of ['S1:supersession', 'S2:dup-title', 'S3']) {
  const hits = rows.filter((r) => r.sources.some((x) => x.startsWith(s)));
  console.log(`${s.padEnd(16)} ${hits.length}  ${hits.map((r) => `#${r.A.id}+#${r.B.id}`).join(' ') || '(none)'}`);
}
console.log('');
console.log('⚠️ S3 produces FALSE POSITIVES by construction (shared theme, different subject).');
console.log('⚠️ KEYED vs UNKEYED is NOT decided here — see #755 Rule 2, applied by a seat with no stake.');
