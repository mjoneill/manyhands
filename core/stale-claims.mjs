/**
 * #455 — THE STALE-CLAIM INQUIRY: which held cards has their holder gone quiet on?
 *
 * A claim is the only record that a seat is mid-something, and a dead or idle
 * holder's claim looks identical to a live one. On 2026-09-14 a card was held
 * ~5 h with no attributed write and the room found out because a human asked
 * by hand. The ruling (2026-09-15 01:58Z, on #455): the board ASKS — it never
 * reclaims. This module answers the question the ask is built on:
 *
 *   rows = open claims where the holder has written NOTHING on that card
 *          (no card event by them, no post attached to it) for N hours,
 *          and whose last answer did not name a later next check.
 *
 * ⛔ Not a TTL. Nothing here releases anything; the asker (core/stale-claim-ask.mjs)
 * posts one line per silence episode and the holder clears it by writing.
 *
 * A write ELSEWHERE on the board does not reset the clock — the card is the
 * record of the work, so only a write on the card counts (the claim-side rule,
 * 2026-09-15 01:54Z). A holder's one-line answer can name its own next check:
 * "still on it, next observable is Thursday" / "… 2026-09-18" — the clock
 * moves to that moment, so a human away at work for a day is asked once and
 * held to the date they gave, not to a clock built for seats.
 *
 * N: 1 h — ruled 3 h on 2026-09-15 01:58Z, then measured over 300 claim episodes (08-04 → 09-15): an
 * hour of silence is ~2× as likely in a stall as in a ship, and the SM took the number (12:21Z).
 * The retro moves it; it is one constant, overridable by env for the test.
 */

export const STALE_CLAIM_HOURS = Number(process.env.SCRUM_STALE_CLAIM_HOURS || 1);

const HOUR = 3_600_000;
// A claim's own event lands a few ms after `claimedAt` is stamped; anything
// inside this window is the claim itself, not a write after it.
const CLAIM_SETTLE_MS = 2_000;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The next check a holder's answer names, as an ISO stamp, or null.
 * Reads an ISO date (`2026-09-18`, optionally with a time) or a weekday name
 * (`Thursday` → the next Thursday after `at`, 00:00Z — the day, not an hour).
 * Deliberately narrow: two spellings the room already uses, never a parser.
 */
export function nextCheckFrom(body, at) {
  if (typeof body !== 'string' || !body) return null;
  const iso = body.match(/\b(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?)Z?)?\b/);
  if (iso) {
    const stamp = iso[2] ? `${iso[1]}T${iso[2].length === 5 ? iso[2] + ':00' : iso[2]}.000Z` : `${iso[1]}T00:00:00.000Z`;
    const t = Date.parse(stamp);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const day = body.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (day) {
    const from = new Date(at);
    if (!Number.isFinite(from.getTime())) return null;
    const want = WEEKDAYS.indexOf(day[1].toLowerCase());
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    let ahead = (want - d.getUTCDay() + 7) % 7;
    if (ahead === 0) ahead = 7;                // "Thursday" said on a Thursday means next week's
    d.setUTCDate(d.getUTCDate() + ahead);
    return d.toISOString();
  }
  return null;
}

/**
 * @param {object} args
 * @param {Array<object>} args.cards         board cards (claimedBy/claimedAt read)
 * @param {Array<object>} args.conversations board posts (author/attachedTo/createdAt/body read)
 * @param {(sinceIso: string) => Array<object>} args.events
 *   event-log rows recorded at/after `sinceIso` — called ONCE, only when some
 *   claim is old enough to be stale; never called on a board with no such claim
 * @param {string} args.now  ISO
 * @param {number} [args.hours=STALE_CLAIM_HOURS]
 * @returns {Array<{shortId, id, title, holder, claimedAt, lastHolderWriteAt, silentHours, quietUntil}>}
 */
export function staleClaims({ cards = [], conversations = [], events = () => [], now, hours = STALE_CLAIM_HOURS }) {
  const nowMs = Date.parse(now);
  const limit = hours * HOUR;
  const held = cards.filter((c) => c && typeof c.claimedBy === 'string' && c.claimedBy && typeof c.claimedAt === 'string');
  // Only a claim older than N can be stale — a holder write only makes it fresher.
  const candidates = held.filter((c) => nowMs - Date.parse(c.claimedAt) >= limit);
  if (!candidates.length) return [];

  const since = candidates.map((c) => c.claimedAt).sort()[0];
  const log = events(since) || [];
  const rows = [];
  for (const card of candidates) {
    const holder = card.claimedBy;
    const claimedMs = Date.parse(card.claimedAt);
    let last = claimedMs;
    let lastPost = null;
    for (const e of log) {
      if (e?.actor !== holder || e?.entity?.kind !== 'card' || e?.entity?.id !== card.id) continue;
      const t = Date.parse(e.recorded_at);
      if (!Number.isFinite(t) || t - claimedMs < CLAIM_SETTLE_MS) continue;
      if (t > last) last = t;
    }
    for (const m of conversations) {
      if (m?.author !== holder || m?.attachedTo !== card.id) continue;
      const t = Date.parse(m.createdAt);
      if (!Number.isFinite(t) || t <= claimedMs) continue;
      if (t > last) last = t;
      if (!lastPost || t > Date.parse(lastPost.createdAt)) lastPost = m;
    }
    const silent = nowMs - last;
    if (silent < limit) continue;
    const quietUntil = lastPost ? nextCheckFrom(lastPost.body, lastPost.createdAt) : null;
    if (quietUntil && nowMs < Date.parse(quietUntil)) continue;   // they said when; it isn't yet
    rows.push({
      shortId: card.shortId,
      id: card.id,
      title: card.title,
      holder,
      claimedAt: card.claimedAt,
      lastHolderWriteAt: new Date(last).toISOString(),
      silentHours: Math.round(silent / HOUR * 10) / 10,
      quietUntil,
    });
  }
  return rows.sort((a, b) => b.silentHours - a.silentHours);
}
