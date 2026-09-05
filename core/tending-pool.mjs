/**
 * core/tending-pool.mjs — #1189, the READ half of the runtime seam (#804).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * #805 modelled the whispers as graph entities — prompt identity, versioned
 * bodies, authorship, provenance, and an ORDERED playlist — and did it well.
 * Nothing ever read them. The firing path took its words from DEFAULT_POOL, a
 * frozen array in whisper-store.mjs, because whisper-pool.json does not exist
 * and readPool() has therefore taken its ENOENT branch on every tick since.
 *
 * The gap was measurable and nobody measured it: 393 real firings against 1
 * TendingMint. The graph described a system; a different system was running.
 *
 * ⛔ SO THE DEFECT CLASS THIS MODULE GUARDS IS NOT "WRONG WORDS". It is
 * "plausible words computed from somewhere nobody is looking at" — which is
 * indistinguishable from correct behaviour at every observable surface,
 * including the room receiving the whisper.
 *
 * ── PURE, AND WHY ──────────────────────────────────────────────────────────
 * This module takes the tending entities as an argument and reads no files, no
 * clock and no randomness it was not handed. Same discipline as
 * core/whisper-window.mjs: the node half can be tested against a temp dir, the
 * pure half against a fixture, and neither has to fake the other.
 *
 * ── THE ONE-HOP TRAP, WRITTEN DOWN BECAUSE IT CAUGHT THREE READERS ─────────
 * Identity and content are split: `scrum:TendingPrompt` carries the durable
 * identity and NO text; `scrum:TendingPromptVersion` carries `scrum:body`.
 * Likewise `scrum:TendingPlaylist` is bare and the ORDER lives on
 * `scrum:TendingPlaylistVersion.scrum:orderedPrompts`.
 *
 * That split is correct — it is what lets an edit mint a new version without
 * destroying the previous one's authorship. But it means the OBVIOUS query
 * (ask the prompt node for its text) returns a well-formed EMPTY answer rather
 * than an error, and an empty answer reads as "there is no text". On
 * 2026-09-04 that produced three separate wrong surveys within one hour, one
 * of which became a LINE STOPPED on this card. Read through the version.
 */

/** Membership and order both come from here; nothing else may add a prompt. */
const PLAYLIST_VERSION = 'scrum:TendingPlaylistVersion';
const PROMPT = 'scrum:TendingPrompt';
const PROMPT_VERSION = 'scrum:TendingPromptVersion';

const idOf = (e) => e?.['@id'];
const typeOf = (e) => e?.['@type'];

/** `{'@list': [...]}` or, on legacy rows, a bare array. Never invent an order. */
function listItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) return [...value];
  if (Array.isArray(value['@list'])) return [...value['@list']];
  return [];
}

function versionNumber(e) {
  const v = e?.['scrum:version'];
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * The playlist the room is actually running: the HIGHEST-versioned
 * PlaylistVersion. Reordering mints a new version rather than mutating the
 * old, so "latest" is the whole selection rule — and an older version staying
 * readable is the point, not a leak.
 */
function currentPlaylistVersion(entities) {
  let best = null;
  for (const e of entities) {
    if (typeOf(e) !== PLAYLIST_VERSION) continue;
    if (!best || versionNumber(e) > versionNumber(best)) best = e;
  }
  return best;
}

/**
 * Resolve the live pool: the ordered, enabled, non-empty whispers the next
 * firing may choose from.
 *
 * Returns `[{ slug, promptId, versionId, version, body }]` in playlist order.
 *
 * ⚠️ MEMBERSHIP comes from the playlist; BODY comes from the prompt's latest
 * version. Those are deliberately different lookups. The playlist pins v1 of a
 * prompt, but an edit mints v2 — so following the listed version id for the
 * TEXT would make every edit appear to do nothing, while following it for
 * MEMBERSHIP is what makes removal actually remove.
 */
export function resolvePool(entities = []) {
  const list = Array.isArray(entities) ? entities : [];

  const promptsById = new Map();
  for (const e of list) if (typeOf(e) === PROMPT && idOf(e)) promptsById.set(idOf(e), e);

  // Latest version per prompt identity.
  const latestByPrompt = new Map();
  const versionsById = new Map();
  for (const e of list) {
    if (typeOf(e) !== PROMPT_VERSION || !idOf(e)) continue;
    versionsById.set(idOf(e), e);
    const of = e['scrum:ofPrompt'];
    if (!of) continue;
    const incumbent = latestByPrompt.get(of);
    if (!incumbent || versionNumber(e) > versionNumber(incumbent)) latestByPrompt.set(of, e);
  }

  const playlist = currentPlaylistVersion(list);
  if (!playlist) return [];

  const pool = [];
  const seenPrompts = new Set();
  for (const listedVersionId of listItems(playlist['scrum:orderedPrompts'])) {
    const listed = versionsById.get(listedVersionId);
    const promptIri = listed?.['scrum:ofPrompt'];
    if (!promptIri || seenPrompts.has(promptIri)) continue;
    seenPrompts.add(promptIri);

    const promptNode = promptsById.get(promptIri);
    // ABSENCE IS NOT DISABLEMENT. A missing flag means enabled — treating it as
    // false would silence every bootstrapped prompt on first deploy, and that
    // reads from the room as "tending is broken" rather than as a config state.
    if (promptNode?.['scrum:enabled'] === false) continue;

    const current = latestByPrompt.get(promptIri) ?? listed;
    const body = typeof current['scrum:body'] === 'string' ? current['scrum:body'].trim() : '';
    // An empty body is refused rather than emitted: the room cannot tell an
    // empty whisper from a broken sender, and neither can the sender.
    if (!body) continue;

    pool.push({
      slug: promptNode?.identifier ?? null,
      promptId: promptIri,
      versionId: idOf(current),
      version: versionNumber(current),
      body,
    });
  }
  return pool;
}

/**
 * Choose this window's whisper. `rand` is injected for the same reason `now`
 * is elsewhere in tending: a module that reaches for its own randomness cannot
 * be tested for reachability, and "shuffle" that always returns index 0 passes
 * every filtering assertion.
 *
 * ⛔ Selection happens over the ALREADY-FILTERED pool. Shuffling the unfiltered
 * list and rejecting afterwards would fire a disabled whisper roughly 1/N of
 * the time — intermittent, unreproducible, and indistinguishable from a ghost.
 */
export function selectPrompt(pool = [], { shuffle = false, rand } = {}) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (!shuffle) return pool[0];
  if (typeof rand !== 'function') {
    throw new Error('selectPrompt: shuffle requires an injected `rand` — this module never reaches for its own randomness');
  }
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[i];
}

/**
 * #1189 follow-up — the NEXT whisper when the room is playing in list order.
 *
 * `lastVersionId` is the prompt version the previous firing sent, read from
 * the most recent scrum:TendingMint. The cursor is therefore DERIVED from the
 * graph rather than stored beside it: one fact, one home, nothing to drift.
 *
 * ⛔ MATCHES ON PROMPT IDENTITY, NOT ON THE VERSION IRI. Editing a whisper
 * mints a new version, so comparing version IRIs would fail to find the
 * last-fired entry and silently restart the sequence at the top — an edit
 * would reset the running order, invisibly, which is worse than the rotation
 * this replaces.
 *
 * Falls back to the FIRST entry when there is no previous firing, or when the
 * one that fired is no longer in the playlist (removed, disabled, retired).
 * Resuming from an absent member has no defined answer, and picking a
 * neighbour would invent a position nobody chose.
 */
export function nextInOrder(pool = [], lastVersionId = null) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (!lastVersionId) return pool[0];
  const lastPrompt = promptIdOfVersion(String(lastVersionId));
  const at = pool.findIndex((p) => promptIdOfVersion(String(p.versionId)) === lastPrompt);
  if (at < 0) return pool[0];
  return pool[(at + 1) % pool.length];
}

/**
 * A version IRI is `<prompt iri>/v<N>`; the prompt identity is everything
 * before the final `/v<N>`. Derived rather than looked up so this stays pure —
 * the caller passes bodies, not the entity graph.
 */
function promptIdOfVersion(versionIri) {
  return String(versionIri).replace(/\/v\d+$/, '');
}
