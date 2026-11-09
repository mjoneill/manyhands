/**
 * #1858 — when the ceremony bell is silent, a scheduled poster names the seats who open.
 *
 * The bell (#1815) runs inside the MCP server, and the flag that says "the opener is missing" is
 * written by the same tick. A stopped or stale MCP process therefore silences both. This decision
 * runs in a separate scheduled job, and its trigger is the room itself: at slot + 6 min, is there a
 * bell opener for this slot? A post-driven seat is woken by a post, so the fallback is one ordinary
 * room post naming the configured seats, in order (the second name covers one empty model call).
 *
 * Pure: the caller fetches the room's board-authored posts since the earliest slot and posts the
 * bodies this returns. Idempotence comes from the room too: a fallback already posted for a slot
 * (its body starts with fallbackMarker) means no second one.
 */

import { latestSlot } from './ceremony-bell.mjs';

export const FALLBACK_DELAY_MS = 6 * 60 * 1000;
/** Long enough to cover a late launchd fire after sleep; short enough never to reach the next hour's slot. */
export const FALLBACK_WINDOW_MS = 40 * 60 * 1000;

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** The bell's own opener starts with exactly this (see openerLine in ceremony-bell.mjs). */
const bellPrefix = (kind, slotMs) => `🔔 ${hhmm(slotMs)}Z: ${kind}.`;

/** Every fallback body starts with this, so a re-run can see its own earlier post. */
export const fallbackMarker = (kind, slotMs) => `⏰ ${hhmm(slotMs)}Z ${kind}: no bell.`;

const isRoomPostByBoard = (p) => p && p.author === 'board' && !p.attachedTo && typeof p.body === 'string';

export function fallbackDecide({ now, entries, posts, seats }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const out = [];
  for (const entry of entries) {
    const slotMs = latestSlot(entry, nowMs);
    const due = slotMs + FALLBACK_DELAY_MS;
    if (nowMs < due || nowMs >= due + FALLBACK_WINDOW_MS) continue;
    const key = `${entry.kind}@${new Date(slotMs).toISOString()}`;
    // Only posts made at or after this slot can belong to it: last week's opener has the same prefix.
    const mine = posts.filter((p) => isRoomPostByBoard(p) && Date.parse(p.createdAt) >= slotMs);
    if (mine.some((p) => p.body.startsWith(bellPrefix(entry.kind, slotMs)))) { out.push({ key, action: 'skip-bell-posted' }); continue; }
    const marker = fallbackMarker(entry.kind, slotMs);
    if (mine.some((p) => p.body.startsWith(marker))) { out.push({ key, action: 'skip-fallback-posted' }); continue; }
    const named = (seats || []).filter(Boolean);
    const who = named.length
      ? `${named.map((s) => `@${s}`).join(', then ')}: please open the ${entry.kind}.`
      : `Nobody is named to open, so whoever is here, please start the ${entry.kind}.`;
    out.push({ key, action: 'post', body: `${marker} The ${entry.kind} slot was ${hhmm(slotMs)}Z and no bell opener reached the room by ${hhmm(due)}Z. ${who} (#1858)` });
  }
  return out;
}
