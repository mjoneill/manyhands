/**
 * #1902 Half 1, slice 1 — EVERY SEAT'S INBOX: which seats a committed post CONCERNS, and the reconciler that turns the
 * commit-ordered post feed into delivery rows for them.
 *
 * The board already holds a durable inbox, `scrum:Delivery` (one row per seat and post, append-only steps). Until this
 * slice only a resident in channel mode had rows, and only when the MCP server was up to receive the post's one-shot
 * hint. Here REST, which owns the post write and already reads the commit-ordered feed (core/post-discovery.mjs), offers
 * a row to every seat a post concerns, from a persisted cursor, so a post committed while this process was down gets its
 * row when it comes back. The hint stays as it is; a row's identity is derived from (seat, post), so both may run.
 *
 * WHAT "CONCERNS" MEANS IN THIS SLICE (and nothing more):
 *   - the post NAMES the seat as a whole word, case-insensitively, `@` or not, by its key, its display name or an alias, as
 *     the ROSTER records them (PO decision 2026-11-15: this room addresses seats by bare name, "Nimbus, can you…"; with
 *     #699's `@`-only rule a day of real posts made 27 rows, nearly all for a human). A word boundary is anything that is
 *     not a Unicode letter, digit or `_`, so "ashtray" is not "ash". Or its stored `mentions` names the key;
 *   - the post belongs to a 1:1 talk and the seat is a participant of that talk (the seat it is with, or its opener).
 *   Never: the author (a seat is never offered its own post), a roster seat marked `kind: system`, a roster seat marked
 *   `kind: human` (a human: no connector reads a row for her, so a row would be noise), or one of EXCLUDED_IDENTITIES. Card assignees and "every post" subscriptions are not here.
 * No seat name is written in this file: every name comes from the roster passed in.
 *
 * A row holds ids, never text: the delivery node names the post by IRI (core/unit3-graph.mjs), so a redacted post leaves
 * nothing of what it said in any row.
 */
import { EXCLUDED_IDENTITIES } from './people.mjs';

const lc = (s) => String(s ?? '').trim().toLowerCase();

/**
 * The roster (key → { name?, aliases?, kind? }) as an index: the seats that can be concerned, and every spelling the
 * roster records for each (key, display name, aliases), lower-cased.
 */
export function seatIndex(seats) {
  const eligible = new Set();
  const byName = new Map();
  for (const [key0, v] of Object.entries(seats || {})) {
    const key = lc(key0);
    if (!key || EXCLUDED_IDENTITIES.includes(key) || NOT_A_ROW_SEAT.has(lc(v?.kind))) continue;
    eligible.add(key);
    byName.set(key, key);
    if (typeof v?.name === 'string' && v.name.trim()) byName.set(lc(v.name), key);
    for (const a of Array.isArray(v?.aliases) ? v.aliases : []) if (typeof a === 'string' && a.trim()) byName.set(lc(a), key);
  }
  const spellings = [...byName.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const re = spellings.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${spellings.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null;
  return { eligible, byName, re };
}
/** The roster `kind` values whose seats are never offered a row: the board's own voices, and human persons. */
export const NOT_A_ROW_SEAT = new Set(['system', 'human']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The seats the text names as whole words, case-insensitively, by any spelling the roster records (`@` optional). */
export function mentionedSeats(text, index) {
  if (typeof text !== 'string' || !index.re) return [];
  const found = new Set();
  for (const m of text.matchAll(index.re)) {
    const hit = index.byName.get(m[0].toLowerCase());
    if (hit) found.add(hit);
  }
  return [...found];
}

/**
 * The seats one post concerns, sorted. `talk` is the post's talk as the board holds it ({ with, openedBy }) or null.
 * A redacted post, or one with no id, concerns no one: there is nothing to deliver.
 */
export function concernedSeats(post, { index, talk = null } = {}) {
  if (!post || typeof post.id !== 'string' || !post.id || post.redacted === true) return [];
  const out = new Set(mentionedSeats(post.body, index));
  for (const m of Array.isArray(post.mentions) ? post.mentions : []) if (index.eligible.has(lc(m))) out.add(lc(m));
  if (talk && typeof post.conversation === 'string' && post.conversation) {
    for (const p of [talk.with, talk.openedBy]) if (index.eligible.has(lc(p))) out.add(lc(p));
  }
  out.delete(lc(post.author));
  return [...out].sort();
}

/**
 * THE RECONCILER. Reads the commit-ordered feed from a persisted cursor and offers each post to the seats it concerns.
 *
 *   readPage(after)        → { conversations, nextAfterCommit }   (throws { status, body: { code } } on a refusal)
 *   concerns(post)         → [seat]                               (sync or async)
 *   offer(seat, postId)    → { ok: true, created?: boolean } | { ok: false, why }   (ok:false = try again later)
 *   store.read()           → the saved state or null;  store.write(state) persists it (a PROJECTION: see persistent-stores)
 *   onOffered(seat, postId, created)  — optional, after each successful offer
 *
 * The cursor moves only past a page whose every offer succeeded, so a failed offer is retried from the same place on the
 * next tick; the repeat of an offer that did succeed is the same row (derived identity), never a second one. A first start
 * with no saved cursor begins at the TIP: history is not offered (that would be every post ever, to everyone it named).
 * A cursor from another store or epoch (409 POST_CURSOR_EPOCH_CHANGED) also restarts at the tip, and says so in the state.
 */
export function createSeatInboxReconciler({ readPage, concerns, offer, store, onOffered = () => {}, tickMs = 10_000, maxPagesPerTick = 20, log = (m) => console.error(m), now = () => new Date().toISOString() }) {
  let state = null;      // { v, cursor, observingSince, resyncs: [{at, why}] }
  let running = null;    // the tick in flight
  let again = false;     // a kick arrived while a tick ran
  let timer = null;
  let stopped = false;
  const stats = { ticks: 0, offered: 0, created: 0, failed: 0, lastTickAt: null, lastError: null };

  const save = () => { try { store.write(state); } catch (e) { log(`[#1902] seat inbox cursor not saved: ${e?.message ?? e}`); } };
  function load() {
    let s = null;
    try { s = store.read(); } catch (e) { log(`[#1902] seat inbox cursor unreadable, starting at the tip: ${e?.message ?? e}`); }
    state = s && typeof s === 'object' && s.v === 1
      ? { v: 1, cursor: typeof s.cursor === 'string' ? s.cursor : null, observingSince: typeof s.observingSince === 'string' ? s.observingSince : now(), resyncs: Array.isArray(s.resyncs) ? s.resyncs.slice(-10) : [] }
      : { v: 1, cursor: null, observingSince: now(), resyncs: [] };
  }

  async function tickOnce() {
    stats.ticks += 1; stats.lastTickAt = now();
    if (!state) load();
    if (!state.cursor) {
      const tip = await readPage('tip');
      state.cursor = tip.nextAfterCommit; save();
      return;
    }
    for (let p = 0; p < maxPagesPerTick && !stopped; p++) {
      let page;
      try { page = await readPage(state.cursor); } catch (e) {
        if (e?.body?.code === 'POST_CURSOR_EPOCH_CHANGED') {
          log(`[#1902] seat inbox cursor belongs to another store or epoch; restarting at the tip (posts committed in between are NOT offered by this path): ${e.body.error ?? ''}`);
          state.resyncs = [...state.resyncs, { at: now(), why: e.body.code }].slice(-10); state.cursor = null; save();
          return;
        }
        throw e;
      }
      for (const post of page.conversations || []) {
        const seats = await concerns(post);
        for (const seat of seats) {
          const r = await offer(seat, post.id);
          if (!r?.ok) { stats.failed += 1; stats.lastError = `${seat} ${post.id}: ${r?.why ?? 'failed'}`; log(`[#1902] offer of ${post.id} to ${seat} failed, retried next tick: ${r?.why ?? ''}`); return; }
          stats.offered += 1; if (r.created) stats.created += 1;
          try { onOffered(seat, post.id, !!r.created); } catch { /* a listener never stops the feed */ }
        }
      }
      const moved = page.nextAfterCommit && page.nextAfterCommit !== state.cursor;
      if (moved) { state.cursor = page.nextAfterCommit; save(); }
      if (!moved || !(page.conversations || []).length) return;
    }
  }

  async function tick() {
    if (stopped) return;
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await tickOnce(); } while (again && !stopped);
      } catch (e) { stats.lastError = e?.message ?? String(e); log(`[#1902] seat inbox tick failed, retried next tick: ${stats.lastError}`); }
      finally { running = null; }
    })();
    return running;
  }

  return {
    start() { stopped = false; load(); timer = setInterval(() => { tick(); }, tickMs); timer.unref?.(); setImmediate(() => { tick(); }); },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    kick() { if (!stopped && timer) setImmediate(() => { tick(); }); },
    tick,
    state: () => (state ? { ...state } : null),
    stats: () => ({ ...stats }),
  };
}
