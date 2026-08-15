/**
 * core/tending-ids.mjs — the canonical @id functions for tending entities.
 *
 * Published as part of the seam contract because BOTH builds depend on them:
 * #805 bootstrap computes ids to be idempotent, #804 runtime writers compute
 * the same ids for the same things. Two implementations of "the id" would
 * drift, and the drift would look like duplicate nodes rather than like a bug.
 *
 * ── IDEMPOTENCY BY CONSTRUCTION ───────────────────────────────────────────
 *
 * The board's own convention: ad-hoc many-instance entities (cards, comments)
 * get bare UUIDs; named/singleton entities (Person, Column) get DERIVED stable
 * URIs. Tending entities follow the second. Re-running bootstrap therefore
 * computes the same @id and upserts, rather than needing a "does it exist?"
 * check that can race or drift.
 *
 * ⛔ A PROMPT VERSION'S ID MUST NOT DERIVE FROM ITS TEXT ALONE.
 *
 * Two genuinely different prompts may legitimately carry identical text — a
 * reworded prompt that lands back on an earlier wording, or two playlists that
 * share a line. Keying on body would silently MERGE their lineages, and the
 * merge would be invisible: one node where there should be two, with one
 * author, one history, and no error anywhere.
 *
 * So a version's identity is (durable prompt identity, version number). The
 * body is content, not identity — which is also what makes a version immutable
 * in a useful way: editing the text produces a NEW version rather than
 * silently redefining an existing id.
 */

import { createHash, randomUUID } from 'node:crypto';

export const TENDING_IRI_BASE = 'https://scrumboard.local/tending/';

/** Stable short digest — enough to be collision-free here, short enough to read. */
const digest = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/**
 * A prompt's durable identity. Derived from a caller-supplied slug so a prompt
 * keeps its identity across every rewording — the thing versions hang from.
 */
export function promptId(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('promptId: slug is required');
  return `${TENDING_IRI_BASE}prompt/${slug}`;
}

/**
 * A prompt VERSION's identity: the prompt it belongs to, plus its version
 * number. NOT the body — see the header.
 */
export function promptVersionId(slug, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('promptVersionId: version must be a positive integer');
  }
  return `${TENDING_IRI_BASE}prompt/${slug}/v${version}`;
}

export function playlistId(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('playlistId: slug is required');
  return `${TENDING_IRI_BASE}playlist/${slug}`;
}

export function playlistVersionId(slug, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('playlistVersionId: version must be a positive integer');
  }
  return `${TENDING_IRI_BASE}playlist/${slug}/v${version}`;
}

/**
 * A silence is identified by the instant it began — that is what makes it THAT
 * silence, and it is a fact both sides compute identically from board state.
 */
export function silenceId(silenceSince) {
  if (!silenceSince) throw new Error('silenceId: silenceSince is required');
  return `${TENDING_IRI_BASE}silence/${silenceSince}`;
}

/** A mint is one offer answering one silence. */
export function mintId(silenceSince, mintedAt) {
  if (!silenceSince || !mintedAt) throw new Error('mintId: silenceSince and mintedAt are required');
  return `${TENDING_IRI_BASE}mint/${digest(`${silenceSince}|${mintedAt}`)}`;
}

/**
 * ⛔ EVENTS ARE NOT DERIVED. They take an explicit unique key.
 *
 * A claim attempt and a control event are AD-HOC MANY-INSTANCE entities, and
 * the board's own convention (measured on the live graph) is that those carry
 * UUID identity while named/singleton/versioned entities carry derived URIs.
 *
 * An earlier cut derived these from (mint, receivedAt, declaredSeat) and
 * (occurredAt). Both COLLIDE: two genuine attempts from one declared seat
 * inside the same millisecond would become ONE node, and so would two control
 * events sharing timestamp resolution. Under contention — the exact condition
 * these entities exist to record — a collision silently discards one of the
 * two facts, and a lost refusal is precisely what made the 2026-08-14
 * attribution incident unadjudicable.
 *
 * ⚠️ Uniqueness may NEVER be inferred from a timestamp plus a declared
 * identity. The declared seat is not authenticated, and a millisecond is not
 * a discriminator; it is a coincidence waiting to happen under load.
 */
export function claimAttemptId(eventKey) {
  if (!eventKey || typeof eventKey !== 'string') {
    throw new Error('claimAttemptId: an explicit unique eventKey is required — attempts are events, not derived');
  }
  return `${TENDING_IRI_BASE}claim/${eventKey}`;
}

export function controlEventId(eventKey) {
  if (!eventKey || typeof eventKey !== 'string') {
    throw new Error('controlEventId: an explicit unique eventKey is required — control events are events, not derived');
  }
  return `${TENDING_IRI_BASE}control/${eventKey}`;
}

/** Mint one. Callers that have no key of their own use this. */
export function newEventKey() {
  return randomUUID();
}
