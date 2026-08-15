/**
 * core/tending-bootstrap.mjs — #805. The live tending system, as graph data.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-08-14 the hourly tending shipped and ran in production while the
 * board's own graph contained ZERO nodes describing it: 610 Comments in which
 * we discussed the design, 37 cards about it, and not one entity that WAS it.
 * `graph_query` for "tending" returned our conversation and nothing else.
 *
 * The prompts lived as three frozen strings in whisper-store.mjs; settlement
 * and pause lived in flat JSON sidecars. This module migrates that state into
 * the versioned, queryable nodes the room specified.
 *
 * ── PURE ON PURPOSE ────────────────────────────────────────────────────────
 * This takes the live values and the resolved evidence as ARGUMENTS and returns
 * entities. It reads no files and no clock. The bootstrap that writes is a thin
 * caller; everything worth testing is in here, against fixtures, with no I/O.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ─────────────────────────────────────────────
 * Every @id comes from core/tending-ids.mjs and is a pure function of durable
 * identity — never of body text (see that file's header for the lineage-merge
 * hazard). Re-running therefore recomputes the same ids and upserts. There is
 * no "does it already exist?" read, so there is nothing to race.
 *
 * ── ⛔ WHAT THIS MODULE REFUSES TO DO ───────────────────────────────────────
 * 1. INVENT AN AUTHOR. Absent stays absent and never defaults to anyone.
 * 2. ASSERT A SUPERLATIVE. There is no `firstSentBy`. "Earliest recorded use"
 *    is DERIVED at query time over evidencedBy, so it re-derives correctly the
 *    moment better evidence lands. A stored "first" goes stale silently.
 * 3. CLAIM AN ABSENCE. "No recorded utterance" is written as a bounded search
 *    result WITH its cutoff — never as "never sent", which is a claim about
 *    the world that a substring search cannot support.
 * 4. DUPLICATE EVIDENCE. The utterances are ALREADY 161 Comment nodes with
 *    author, text and timestamp. This links to them. Copying them would replace
 *    a primary source with a summary of it.
 * 5. RELABEL LEGACY AS SILENCE. The one existing grant settled a CLOCK WINDOW.
 *    The successor keys on silence. Calling the old window a silence would
 *    manufacture a fact, so legacy events carry `scrum:legacyClockWindow` and
 *    NO `ofSilence` edge.
 */

import {
  promptId, promptVersionId, playlistId, playlistVersionId,
  mintId, claimAttemptId,
} from './tending-ids.mjs';

/** Person @ids resolve against the same base `author` already uses. */
const PERSON_BASE = 'https://scrumboard.local/person/';
export const person = (seat) => (seat ? `${PERSON_BASE}${seat}` : undefined);

/** Drop undefined keys so ABSENT is genuinely absent, not `null` pretending. */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * The playlist slug. One playlist exists; multi-playlist is deliberately NOT
 * built (the room held it as a feature, not a shape).
 */
export const DEFAULT_PLAYLIST_SLUG = 'room-tending';

/**
 * Build every entity for the bootstrap.
 *
 * @param {object}   a
 * @param {Array}    a.prompts   [{ slug, body, author?, evidencedBy?, provenanceNote?, influencedBy? }]
 *                               Order is the PLAYLIST order.
 * @param {object}   a.config    the live tending config, e.g. { enabled: true }
 * @param {object}   a.state     the live whisper-state sidecar (may be {})
 * @param {string}   a.importedAt  ISO instant this migration ran — recorded, never inferred
 * @param {string}   [a.playlistSlug]
 */
export function buildTendingEntities({
  prompts, config = {}, state = {}, importedAt, playlistSlug = DEFAULT_PLAYLIST_SLUG,
}) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error('buildTendingEntities: prompts must be a non-empty array');
  }
  if (!importedAt) throw new Error('buildTendingEntities: importedAt is required');

  const entities = [];

  // ── prompts + their v1 versions ─────────────────────────────────────────
  const versionIds = [];
  for (const p of prompts) {
    if (!p.slug || !p.body) throw new Error(`buildTendingEntities: prompt needs slug and body`);

    entities.push(compact({
      '@id': promptId(p.slug),
      '@type': 'scrum:TendingPrompt',
      identifier: p.slug,
    }));

    const vid = promptVersionId(p.slug, 1);
    versionIds.push(vid);
    entities.push(compact({
      '@id': vid,
      '@type': 'scrum:TendingPromptVersion',
      'scrum:ofPrompt': promptId(p.slug),
      'scrum:version': 1,
      'scrum:body': p.body,
      // ABSENT when unknown. Never inferred, never defaulted.
      author: p.author ? person(p.author) : undefined,
      // Durable sources: the creating commit, and existing Comment @ids.
      // Multi-valued; a bare string is normalised to a one-element list so the
      // shape a reader sees does not depend on how many sources there were.
      'scrum:evidencedBy': p.evidencedBy?.length ? [...p.evidencedBy] : undefined,
      // Real, and explicitly NOT authorship.
      'scrum:influencedBy': p.influencedBy ? person(p.influencedBy) : undefined,
      'scrum:provenanceNote': p.provenanceNote,
      'scrum:importedAt': importedAt,
    }));
  }

  // ── playlist: ORDER LIVES HERE ──────────────────────────────────────────
  // orderedPrompts is declared @container:@list in the context, so this is a
  // SEQUENCE rather than a set. A bare array would round-trip in order today
  // and carry no guarantee — see the flatten-negative control in slice zero.
  entities.push(compact({
    '@id': playlistId(playlistSlug),
    '@type': 'scrum:TendingPlaylist',
    identifier: playlistSlug,
  }));
  entities.push(compact({
    '@id': playlistVersionId(playlistSlug, 1),
    '@type': 'scrum:TendingPlaylistVersion',
    'scrum:ofPlaylist': playlistId(playlistSlug),
    'scrum:version': 1,
    // ⚠️ {"@list":[…]}, NOT a bare array. assertTendingShape() REFUSES a bare
    // array at load — correctly, because a bare array is an unordered SET in
    // JSON-LD and would carry no ordering guarantee at all. This module emitted
    // one on its first draft and the enforcement caught it on first contact.
    'scrum:orderedPrompts': { '@list': versionIds },
    'scrum:importedAt': importedAt,
  }));

  // ── current state ───────────────────────────────────────────────────────
  // ⛔ The flat config carried NO pausedAt and NO pausedBy. Those stay ABSENT.
  // Backfilling them by inference is exactly the invented provenance this card
  // forbids, and "who paused it" is unknowable from `{"enabled":true}`.
  entities.push(compact({
    '@id': `https://scrumboard.local/tending/state/current`,
    '@type': 'scrum:TendingState',
    'scrum:enabled': config.enabled === true,
    'scrum:paused': config.paused === true ? true : undefined,
    'scrum:pausedAt': config.pausedAt,
    'scrum:actor': config.pausedBy ? person(config.pausedBy) : undefined,
    'scrum:provenanceNote':
      'Imported from the flat tending-config.json sidecar, which carried only '
      + '{enabled}. No pausedAt/pausedBy existed in the source, so both are '
      + 'absent here rather than inferred.',
    'scrum:importedAt': importedAt,
  }));

  // ── legacy firing history ───────────────────────────────────────────────
  // ⛔ NOT silences. The successor keys on silence; this grant settled a clock
  // window. It carries the window verbatim and no ofSilence edge.
  for (const h of (Array.isArray(state.history) ? state.history : [])) {
    if (!h?.window || !h?.at) continue;
    const mid = mintId(`legacy:${h.window}`, h.at);
    entities.push(compact({
      '@id': mid,
      '@type': 'scrum:TendingMint',
      'scrum:legacyClockWindow': h.window,
      'scrum:mintedAt': h.at,
      // Transport telemetry ONLY. Present-but-empty is a real measurement
      // (zero named seats held a stream at send) and is NOT evidence of
      // non-delivery — the durable board post existed and was readable.
      'scrum:seatNamesWithOpenStreamsAtSend':
        Array.isArray(h.reached) ? h.reached.map(person) : undefined,
      'scrum:provenanceNote':
        'Legacy clock-window grant imported from whisper-state.json. The old '
        + 'window key is preserved verbatim and is NOT a silence key.',
      'scrum:importedAt': importedAt,
    }));

    // The grant, as a claim attempt — because heldByAttempt references the
    // winning ATTEMPT, never a Person. That is what lets a reader later ask
    // "was the holder a bound actor, a declared proxy, or an unbound
    // declaration?" — the question tonight's incident had no field to answer.
    // ⚠️ EXPLICIT event key, and it is DETERMINISTIC on purpose — which needs
    // justifying, because the contract says attempt ids must not INFER
    // uniqueness from timestamp or declared identity.
    //
    // That rule is about RUNTIME: two live attempts really can share a
    // millisecond and a declared seat, so at runtime the key must be minted
    // (newEventKey). This is not runtime. It is a CLOSED historical set, and
    // the legacy store itself enforced at most one grant per clock window via
    // its `lastWhisperWindow` guard. So the window is not an inference about
    // uniqueness — it is the key that implementation actually enforced.
    //
    // Deterministic here is REQUIRED, not merely convenient: newEventKey()
    // would mint a fresh UUID on every run and re-bootstrapping would append a
    // duplicate grant rather than upsert one.
    const cid = claimAttemptId(`legacy-grant-${h.window}`);
    entities.push(compact({
      '@id': cid,
      '@type': 'scrum:TendingClaimAttempt',
      'scrum:ofMint': mid,
      'scrum:receivedAt': h.at,
      'scrum:outcome': 'granted',
      // ⛔ actor is ABSENT: the legacy store recorded only a declared seat.
      // Whether that caller was bound is unknowable from the sidecar.
      'scrum:declaredSeat': person(h.seat),
      'scrum:declaredSeatRaw': h.seat,
      'scrum:provenanceNote':
        'Imported from success-only legacy history. Bound actor unknown: the '
        + 'flat store recorded a declared seat only. Refused attempts were '
        + 'never persisted by that implementation, so the absence of refusals '
        + 'here is not evidence that none occurred.',
      'scrum:importedAt': importedAt,
    }));
  }

  return entities;
}

/**
 * Merge bootstrap entities into a domain's `tending` array, upserting by @id.
 *
 * Idempotent: a second run replaces same-@id entities rather than appending,
 * so re-bootstrapping cannot produce duplicates. Entities NOT produced by this
 * bootstrap are left untouched — runtime writers (#804) own their own nodes.
 */
export function mergeTending(domain, entities) {
  const existing = Array.isArray(domain.tending) ? domain.tending : [];
  const byId = new Map(existing.map((e) => [e['@id'], e]));
  for (const e of entities) byId.set(e['@id'], e);
  return { ...domain, tending: [...byId.values()] };
}
