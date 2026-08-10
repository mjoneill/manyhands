#!/usr/bin/env node
/**
 * scripts/sprint-review.mjs — #755. Run the sprint's abandon signals.
 *
 * ⚠️ WHY THIS FILE EXISTS, and it is the same defect it reports on:
 *
 * `core/sprint-signals.mjs` shipped with five exports, a green test file, and
 * NO ENTRY POINT. The author ran it once from an ad-hoc script in her own
 * session and posted the numbers. A second seat then could not reproduce them —
 * not because the code was wrong, but because the glue that produced the
 * numbers existed only in one session.
 *
 * ⇒ ***On the closing day, somebody would have found a module they could not
 *   invoke, written their own harness, and narrated the verdict anyway.***
 *
 * ⇒ That is tonight's recurring shape, one more time:
 *     the suite runs the TREE        the rail runs in the PROCESS
 *     git ancestry says COMMITTED    the log says RAN
 *     a module EXISTS                nobody can INVOKE it
 *   ⇒ the thing that exists is not the thing that gets used.
 *
 * Usage:
 *   node scripts/sprint-review.mjs --since <iso> --events <dir> --seats <a,b,c>
 *   ... --work-store <dir>          (without it, signal 2's numerator is a
 *                                   structural zero and the report says so)
 *   ... --human-races <n>          (the count only a human can supply)
 *
 * --events and --seats may also come from SCRUM_EVENTS_DIR / SCRUM_REVIEW_SEATS.
 *
 * Exit codes:
 *   0  ran (whether or not any signal fires — a firing signal is a RESULT,
 *      not an error, and making it non-zero would tempt someone to suppress it)
 *   2  could not run (bad args, unreadable events) — fails loudly, never
 *      silently prints an empty report
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkObjects } from '../core/work-store.mjs';
import {
  signalOneContestedBids,
  signalTwoUngrantedActions,
  signalThreeOutOfBand,
  renderSignal,
} from '../core/sprint-signals.mjs';

// ⛔ NO DEFAULTS FOR EITHER OF THESE, and it is not fussiness.
//
// A hardcoded events path is one machine's layout published into a public repo.
// A hardcoded seat list is a roster snapshot that goes stale silently — and a
// stale roster here does not error, it QUIETLY DROPS a seat's actions out of
// signal 2's denominator, which is the same shape as every instrument-reach
// defect this card documents.
//
// ⇒ Both must be supplied, and the script refuses without them. The refusal is
//   loud; a wrong default would not be.
const eventsDirFrom = (v) => v || process.env.SCRUM_EVENTS_DIR || null;
const seatsFrom = (v) => {
  const raw = v || process.env.SCRUM_REVIEW_SEATS || null;
  return raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : null;
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function die(msg) {
  console.error(`sprint-review: ${msg}`);
  process.exit(2);
}

const since = arg('since');
if (!since) die('--since <iso-timestamp> is required. A review with no window is a review of nothing.');
if (Number.isNaN(Date.parse(since))) die(`--since "${since}" is not a parseable timestamp`);

const eventsDir = eventsDirFrom(arg('events'));
if (!eventsDir) die('--events <dir> (or SCRUM_EVENTS_DIR) is required — this script does not guess where the event log lives.');
if (!existsSync(eventsDir)) die(`events dir not found: ${eventsDir}`);

const SEATS = seatsFrom(arg('seats'));
if (!SEATS) die('--seats <a,b,c> (or SCRUM_REVIEW_SEATS) is required — a guessed roster silently drops a seat from the denominator.');

// ⚠️ Read every daily file and filter by timestamp rather than by FILENAME.
// A filename-based window silently drops events recorded in a file whose date
// straddles the boundary — the awk-timestamp-range trap, in a different suit.
const events = [];
let malformed = 0;
for (const f of readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(eventsDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.occurred_at >= since) events.push(e);
    } catch {
      malformed += 1;
    }
  }
}

// #755 slice 2d — the store exists now, so read it. Optional on purpose: with
// no --work-store the numerator stays a STRUCTURAL ZERO and the report SAYS
// so, which is the honest reading when the store isn't wired for this run.
const workStore = arg('work-store');
// null, NOT [] — "no store configured" and "store is empty" are different
// facts and the signal reports them differently.
const workObjects = workStore ? readWorkObjects(workStore) : null;

const humanRaces = arg('human-races');

const signals = [
  // Bids are prose today; there is no record to hand in. When a bid store
  // exists, this is where it gets wired — and until then the instrument says
  // UNMEASURABLE rather than inventing a zero.
  ['SIGNAL 1  window bought nothing ', signalOneContestedBids({ bidRecords: null })],
  // Work objects likewise: no store yet, so the numerator is a STRUCTURAL zero
  // and says so in its own output.
  ['SIGNAL 2  ungranted covered acts', signalTwoUngrantedActions({ events, workObjects, seats: SEATS })],
  ['SIGNAL 3  unkeyed races recur   ', signalThreeOutOfBand({ humanSuppliedCount: humanRaces === null ? null : Number(humanRaces) })],
];

console.log(`SPRINT REVIEW — events since ${since}: ${events.length}`);
console.log(`events dir: ${eventsDir}`);
console.log(`seats counted: ${SEATS.join(', ')}`);
console.log(`work objects: ${workStore ? `${workObjects.length} from ${workStore}` : 'NO STORE CONFIGURED — pass --work-store; signal 2 numerator is structurally 0'}`);
if (malformed) console.log(`⚠️ ${malformed} unparseable line(s) skipped`);
console.log('');

for (const [label, s] of signals) console.log(renderSignal(label, s));

const measurable = signals.filter(([, s]) => s.status !== 'unmeasurable').length;
const firing = signals.filter(([, s]) => s.fires).map(([l]) => l.trim().split(/\s{2,}/)[0]);

console.log('');
console.log(`⇒ ${measurable} of ${signals.length} signals measurable.`);
console.log(
  firing.length
    ? `⇒ FIRING: ${firing.join(', ')} — read the abandon prescription on #755 before reinterpreting.`
    : '⇒ none firing.',
);

// ⚠️ Said every run, not just when it looks bad. A reader who sees only signal
// lines will read "none firing" as "the experiment is going well."
if (measurable < signals.length) {
  console.log('');
  console.log('⚠️ AN UNMEASURABLE SIGNAL IS NOT A PASSING SIGNAL. The sprint cannot');
  console.log('   currently produce evidence for its own central claim, and a report');
  console.log('   that is mostly UNMEASURABLE is a finding, not a formality.');
}
