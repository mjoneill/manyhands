/**
 * core/tending-authoring.mjs — #1189, the WRITE half of the runtime seam (#804).
 *
 * ── WHY NOT THE EXISTING SURFACE ───────────────────────────────────────────
 * `whisper_pool` (#802) already writes the pool. It takes `string[]` and
 * replaces wholesale. Going through it would have been the fast path and it is
 * the one thing this card forbids: a bare string has no identity, so every
 * edit would discard the version lineage, the authorship, the evidence links
 * and the authorship ruling recorded on 2026-08-15 — and it would look like
 * it worked, because the room would still receive a whisper. The words would
 * survive and everything that makes them ATTRIBUTABLE would not.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * ⛔ NOTHING HERE EVER REWRITES AN EXISTING VERSION NODE. An edit mints the
 * next version; a reorder mints the next playlist version. Old versions stay
 * readable, byte-intact, with their original author. That is what makes the
 * question "what was the room running last Tuesday, and who wrote it" a query
 * rather than an archaeology project.
 *
 * ⛔ AND NOTHING HERE MUTATES ITS INPUT. The board write seam reads the
 * document, applies, then persists; an op that mutates in place corrupts the
 * in-memory document even on a path where the write is later refused.
 *
 * ── REMOVAL IS A TOMBSTONE ─────────────────────────────────────────────────
 * removePrompt() ends MEMBERSHIP and keeps the entity. The room ruled on
 * 2026-09-05 that a deleted thing should leave a readable trace rather than a
 * dangling pointer — "a 404 is appropriate, it's signal" — and a prompt whose
 * lineage is still queryable after removal is that rule applied at the only
 * place in this subsystem where it can bite.
 */

import { promptId, promptVersionId, playlistId, playlistVersionId } from './tending-ids.mjs';
import { person as personIri } from './tending-bootstrap.mjs';

const PROMPT = 'scrum:TendingPrompt';
const PROMPT_VERSION = 'scrum:TendingPromptVersion';
const PLAYLIST = 'scrum:TendingPlaylist';
const PLAYLIST_VERSION = 'scrum:TendingPlaylistVersion';
const STATE_ID = 'https://scrumboard.local/tending/state/current';

const DEFAULT_PLAYLIST = 'room-tending';

const clone = (entities) => entities.map((e) => ({ ...e }));

/**
 * ⛔ THE PERSON IRI IS NOT A CURIE, and getting this wrong is invisible.
 *
 * A first cut minted `person:<seat>`. The projector's asPerson() prepends the
 * person base to any value that is not already an http IRI, so that stored
 * CURIE became `…/person/person:<seat>` — a DOUBLE PREFIX. It projects
 * cleanly, it renders, and it joins to nothing: every "who wrote this whisper"
 * query returns a well-formed empty answer rather than an error.
 *
 * So this reuses the bootstrap's exported helper rather than reimplementing it.
 * Two spellings of one identity is the same defect as two predicates for one
 * fact, one layer down. A leading `person:` is stripped first, because callers
 * reasonably pass either shape.
 */
const person = (key) => (key ? personIri(String(key).replace(/^person:/, '')) : undefined);

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function listOf(entity) {
  const v = entity?.['scrum:orderedPrompts'];
  if (!v) return [];
  if (Array.isArray(v)) return [...v];
  if (Array.isArray(v['@list'])) return [...v['@list']];
  return [];
}

function promptBySlug(entities, slug) {
  return entities.find((e) => e['@type'] === PROMPT && e.identifier === slug) ?? null;
}

function latestVersionNumber(entities, promptIri) {
  let max = 0;
  for (const e of entities) {
    if (e['@type'] !== PROMPT_VERSION || e['scrum:ofPrompt'] !== promptIri) continue;
    max = Math.max(max, num(e['scrum:version']));
  }
  return max;
}

function currentPlaylist(entities) {
  let best = null;
  for (const e of entities) {
    if (e['@type'] !== PLAYLIST_VERSION) continue;
    if (!best || num(e['scrum:version']) > num(best['scrum:version'])) best = e;
  }
  return best;
}

function playlistSlugOf(entities, playlistVersion) {
  const ofPlaylist = playlistVersion?.['scrum:ofPlaylist'];
  const node = entities.find((e) => e['@type'] === PLAYLIST && e['@id'] === ofPlaylist);
  return node?.identifier ?? DEFAULT_PLAYLIST;
}

/** slug → the version @id currently PINNED in the playlist, in playlist order. */
function membership(entities, playlistVersion) {
  const byId = new Map(entities.filter((e) => e['@type'] === PROMPT_VERSION).map((e) => [e['@id'], e]));
  const promptsById = new Map(entities.filter((e) => e['@type'] === PROMPT).map((e) => [e['@id'], e]));
  const out = [];
  for (const vid of listOf(playlistVersion)) {
    const slug = promptsById.get(byId.get(vid)?.['scrum:ofPrompt'])?.identifier;
    if (slug) out.push({ slug, versionId: vid });
  }
  return out;
}

/** Mint the next playlist version carrying `versionIds` in the given order. */
function withNewPlaylist(entities, versionIds, at) {
  const current = currentPlaylist(entities);
  const slug = playlistSlugOf(entities, current);
  const next = num(current?.['scrum:version']) + 1;
  const out = clone(entities);
  if (!entities.some((e) => e['@type'] === PLAYLIST && e.identifier === slug)) {
    out.push({ '@id': playlistId(slug), '@type': PLAYLIST, identifier: slug, 'scrum:importedAt': at });
  }
  out.push({
    '@id': playlistVersionId(slug, next),
    '@type': PLAYLIST_VERSION,
    'scrum:ofPlaylist': playlistId(slug),
    'scrum:version': next,
    // ⚠️ {"@list":[…]} and never a bare array: a bare array is an unordered SET
    // in JSON-LD, so the order would round-trip today and carry no guarantee.
    // assertTendingShape() refuses the bare form for exactly this reason.
    'scrum:orderedPrompts': { '@list': versionIds },
    'scrum:importedAt': at,
  });
  return out;
}

function requireBody(body) {
  const clean = typeof body === 'string' ? body.trim() : '';
  if (!clean) throw new Error('a whisper needs a non-empty body — an empty prompt is indistinguishable from a broken sender');
  return clean;
}

/**
 * A slug becomes an IRI SEGMENT verbatim (`…/tending/prompt/<slug>`), so it
 * must be one. On 2026-09-06 a prompt named with a space was saved as
 * `…/prompt/scrum board-clarity`; oxigraph refused every query that scanned
 * the store ("Invalid IRI code point ' '") and the whole read side of
 * graph-native was down until it was found. Refused here, with the form that
 * would have worked, so the operator error is a 400 and never a stored node.
 */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function slugify(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
export function assertSlug(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('slug is required');
  if (!SLUG_RE.test(slug)) {
    const hint = slugify(slug);
    throw new Error(`slug "${slug}" cannot be an IRI segment (letters, digits, . _ - only; a space or punctuation would make every graph query fail)${hint ? ` — use "${hint}"` : ''}`);
  }
  return slug;
}

export function createPrompt(entities = [], { slug, body, by, at } = {}) {
  if (!slug) throw new Error('createPrompt: slug is required');
  assertSlug(slug);
  const clean = requireBody(body);
  if (promptBySlug(entities, slug)) {
    throw new Error(`a whisper with slug "${slug}" already exists — editing it mints a version, creating it would fork the identity`);
  }
  const vid = promptVersionId(slug, 1);
  const withPrompt = [
    ...clone(entities),
    { '@id': promptId(slug), '@type': PROMPT, identifier: slug, 'scrum:importedAt': at },
    {
      '@id': vid,
      '@type': PROMPT_VERSION,
      'scrum:ofPrompt': promptId(slug),
      'scrum:version': 1,
      'scrum:body': clean,
      author: person(by),
      'scrum:importedAt': at,
    },
  ];
  const current = currentPlaylist(entities);
  return withNewPlaylist(withPrompt, [...listOf(current), vid], at);
}

export function editPrompt(entities = [], { slug, body, by, at } = {}) {
  const prompt = promptBySlug(entities, slug);
  if (!prompt) throw new Error(`unknown whisper "${slug}"`);
  const clean = requireBody(body);
  const next = latestVersionNumber(entities, prompt['@id']) + 1;
  return [
    ...clone(entities),
    {
      '@id': promptVersionId(slug, next),
      '@type': PROMPT_VERSION,
      'scrum:ofPrompt': prompt['@id'],
      'scrum:version': next,
      'scrum:body': clean,
      // The EDITOR, on the NEW version. Never backdated onto the original —
      // that would be inventing provenance, which is the one thing #805's
      // bootstrap refused to do even where it was confident.
      author: person(by),
      'scrum:importedAt': at,
    },
  ];
}

export function setEnabled(entities = [], { slug, enabled } = {}) {
  const prompt = promptBySlug(entities, slug);
  if (!prompt) throw new Error(`unknown whisper "${slug}"`);
  return entities.map((e) =>
    (e['@id'] === prompt['@id'] ? { ...e, 'scrum:enabled': enabled === true } : { ...e }));
}

export function reorderPlaylist(entities = [], { slugs, at } = {}) {
  if (!Array.isArray(slugs)) throw new Error('reorderPlaylist: slugs must be an array');
  const current = currentPlaylist(entities);
  const members = membership(entities, current);
  const known = new Set(members.map((m) => m.slug));

  for (const s of slugs) if (!known.has(s)) throw new Error(`unknown whisper "${s}" in reorder`);
  // ⛔ A reorder that silently drops what the caller omitted is a DELETE
  // wearing a reorder's name — the most destructive thing this surface could
  // do, and the easiest to ship by accident. Removal has its own verb.
  if (slugs.length !== members.length || new Set(slugs).size !== slugs.length) {
    throw new Error(`a reorder must list every current whisper exactly once (${members.length} expected, ${slugs.length} given) — use removePrompt to drop one`);
  }
  const pin = new Map(members.map((m) => [m.slug, m.versionId]));
  return withNewPlaylist(entities, slugs.map((s) => pin.get(s)), at);
}

export function removePrompt(entities = [], { slug, at } = {}) {
  const current = currentPlaylist(entities);
  const members = membership(entities, current);
  if (!members.some((m) => m.slug === slug)) throw new Error(`unknown whisper "${slug}"`);
  // Membership ends; the entity, its versions, its authorship and its
  // provenance all stay. See the module header — this is the tombstone.
  return withNewPlaylist(entities, members.filter((m) => m.slug !== slug).map((m) => m.versionId), at);
}

export function setShuffle(entities = [], { shuffle, at } = {}) {
  const has = entities.some((e) => e['@id'] === STATE_ID);
  const out = entities.map((e) => (e['@id'] === STATE_ID ? { ...e, 'scrum:shuffle': shuffle === true } : { ...e }));
  if (!has) {
    out.push({ '@id': STATE_ID, '@type': 'scrum:TendingState', 'scrum:enabled': true, 'scrum:shuffle': shuffle === true, 'scrum:importedAt': at });
  }
  return out;
}

/** Shuffle is graph state and defaults OFF when the flag has never been set. */
export function readShuffle(entities = []) {
  return entities.find((e) => e['@id'] === STATE_ID)?.['scrum:shuffle'] === true;
}
