/**
 * core/in-flight.mjs — #1078: ONE answer to "what is in flight".
 *
 * Measured 2026-08-29T13:10Z, one board, three surfaces, three answers:
 *   column `in-progress`   0 cards        → an idle room
 *   live claims            4 cards        → a busy one, two leases six days old
 *   work_list.open         []             → a protocol silent for 11 days
 * None was wrong on its own terms; nothing reconciled them, so each was
 * silently authoritative to whoever opened it first. Three stale leases
 * (#367 #437 #962) were held out of the pool and visible on NONE of the
 * surfaces a person reads — #437 was PARKED and CLAIMED at once.
 *
 * THE RULING (design state on #1078, posted to the commons before it was code):
 *   the CLAIM is authoritative for "in flight". It is the only surface with
 *   first-write-wins and a tool-call cost. The column is a workflow stage a
 *   human drags; the work-bid ledger is negotiation BEFORE a claim. Both are
 *   reported here as DERIVED, and every way they disagree with the claim is
 *   named rather than reconciled away.
 *
 * NOT here, on purpose: moving claimed cards into `in-progress`. A mutex is
 * not a stage; collapsing them loses one of the two facts.
 *
 * Every threshold this file applies is published in the payload beside the
 * verdict it produced, so "stale" can never be quoted without its definition.
 * `now` is REQUIRED, never defaulted — a derived view does not report its own
 * staleness, so the reader supplies the clock the verdict is relative to.
 */

import { readWorkObjects, openWorkObjectsAt } from './work-store.mjs';

/** A claim older than this is flagged. Six-day leases were the finding; two days is a long session. */
export const STALE_AFTER_HOURS = 48;
/** A ledger with no transition inside this window is reported dormant. */
export const DORMANT_AFTER_DAYS = 7;
export const IN_PROGRESS_COLUMN = 'in-progress';

const HOUR = 3_600_000;

function assertNow(now, who) {
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) {
    throw new Error(`${who}: now is required (ISO-8601) — a defaulted clock is a verdict with no timestamp`);
  }
}

/**
 * The claim-authoritative view of what is in flight, plus the named
 * disagreements of the other two surfaces. Pure; no I/O.
 */
export function inFlight(cards, { now, staleAfterHours = STALE_AFTER_HOURS, inProgressColumn = IN_PROGRESS_COLUMN } = {}) {
  assertNow(now, 'inFlight');
  const nowMs = Date.parse(now);
  const held = [];
  const inProgressUnclaimed = [];
  const claimedNotInProgress = [];
  const claimedAndParked = [];
  const stale = [];

  for (const c of cards || []) {
    if (!c) continue;
    const claimed = typeof c.claimedBy === 'string' && c.claimedBy.length > 0;
    if (!claimed) {
      if (c.column === inProgressColumn) inProgressUnclaimed.push({ shortId: c.shortId, title: c.title });
      continue;
    }
    const at = typeof c.claimedAt === 'string' ? Date.parse(c.claimedAt) : NaN;
    const ageHours = Number.isNaN(at) ? null : Math.floor((nowMs - at) / HOUR);
    const isStale = ageHours == null ? null : ageHours >= staleAfterHours;
    const parkedUntil = typeof c.parkedUntil === 'string' ? c.parkedUntil : null;
    held.push({
      shortId: c.shortId, title: c.title, claimedBy: c.claimedBy, claimedAt: c.claimedAt ?? null,
      column: c.column ?? null, ageHours, stale: isStale, parkedUntil,
    });
    if (c.column !== inProgressColumn) claimedNotInProgress.push(c.shortId);
    if (parkedUntil != null || c.parkedBy) claimedAndParked.push({ shortId: c.shortId, claimedBy: c.claimedBy, parkedUntil });
    if (isStale === true) stale.push(c.shortId);
  }

  return {
    authority: 'claim',
    definition: 'in flight = held by a live claim (card_claim). The column is a workflow stage and the '
      + 'work-bid ledger is negotiation before a claim; both are derived views and their disagreements '
      + 'with the claim are listed, never reconciled away.',
    now,
    staleAfterHours,
    cards: held,
    disagreements: { inProgressUnclaimed, claimedNotInProgress, claimedAndParked, stale },
  };
}

/**
 * The work-bid ledger, summarised from the same store work_list reads. Says
 * `available:false` with the reason when no store is configured — a missing
 * instrument must not read as an empty protocol.
 */
export function workLedgerSummary(dir, now, { dormantAfterDays = DORMANT_AFTER_DAYS } = {}) {
  assertNow(now, 'workLedgerSummary');
  if (typeof dir !== 'string' || dir.length === 0) {
    return { available: false, reason: 'SCRUM_WORK_STORE is not set on this server, so the ledger cannot be read here — work_list has the same limit' };
  }
  const all = readWorkObjects(dir);
  const open = openWorkObjectsAt(dir, now).length;
  let last = null;
  for (const wo of all) {
    for (const t of wo.transitions || []) {
      if (typeof t.at === 'string' && (last == null || t.at > last)) last = t.at;
    }
  }
  const dormant = last != null && (Date.parse(now) - Date.parse(last)) >= dormantAfterDays * 24 * HOUR;
  return {
    available: true,
    reconciled: false,
    open,
    settled: all.length - open,
    lastTransitionAt: last,
    dormant,
    dormantAfterDays,
    note: 'derived from the transition log, not from claims — a declared window is not a claim and a claim is not a window',
  };
}
