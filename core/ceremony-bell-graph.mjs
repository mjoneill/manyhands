/**
 * #1815 wiring, step A: the ceremony bell's reservation, state and events as GRAPH state, written by REST under its write
 * lock (the one writer), the way #1786 holds the whisper's guards. Several MCP processes run the tick; a reservation they
 * race gets one 201 and one 409, and "why didn't it ring?" is a graph query any seat can run.
 *
 *   scrum:CeremonyBell       one per bell key (`${kind}@${slotISO}`). Created only by a reservation; later writes replace
 *                            its state. `opener` projects as an edge to the seat, `openerPost` as an edge to the post.
 *   scrum:CeremonyBellEvent  one per decision the tick records, linked to its bell by scrum:ofBell when it has one. Each
 *                            carries the boot it belongs to (bootId, bootAt), so coverage starts at bootAt and a gap
 *                            between boots reads as unknown, never as "nothing happened".
 *
 * The kind and the slot are literals on the bell, not edges: there is no ceremony or slot node for an edge to reach, and an
 * edge to a node nobody writes would be a dangling IRI that answers every join with nothing.
 *
 * Pure: values in, entities or answers out.
 */
import crypto from 'node:crypto';

export const BELL_TYPE = 'scrum:CeremonyBell';
export const BELL_EVENT_TYPE = 'scrum:CeremonyBellEvent';
const BASE = 'https://scrumboard.local/ceremony-bell/';
export const bellIri = (key) => `${BASE}${encodeURIComponent(key)}`;
export const bellEventIri = (id) => `${BASE}event/${id}`;

/** `review@2026-11-11T16:00:00.000Z` → { kind, slot }, or null when it is not a kind and a canonical ISO instant. */
export function parseBellKey(key) {
  if (typeof key !== 'string') return null;
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const kind = key.slice(0, at), slot = key.slice(at + 1);
  const ms = Date.parse(slot);
  if (!kind.trim() || Number.isNaN(ms) || new Date(ms).toISOString() !== slot) return null;
  return { kind, slot };
}

/** The bell's state fields, value name → predicate. Closed: REST refuses any other field rather than drop it. */
export const BELL_VALUE_FIELDS = Object.freeze({
  state: 'scrum:bellState',
  at: 'scrum:stateAt',
  opener: 'scrum:opener',
  openerSource: 'scrum:openerSource',
  postId: 'scrum:openerPost',
  createdAt: 'scrum:postCreatedAt',
  checked: 'scrum:checked',
  checkedAt: 'scrum:checkedAt',
  checkOutcome: 'scrum:checkOutcome',
  lagSeconds: 'scrum:lagSeconds',
});

/** The fields of `value` this table does not know, so a caller can refuse them. */
export const unknownBellFields = (value) => Object.keys(value || {}).filter((k) => !Object.hasOwn(BELL_VALUE_FIELDS, k));

/** The bell entity for `key` holding `value`. `reservedAt` is when it was first reserved, kept across state writes. */
export function bellEntity(key, value, reservedAt) {
  const { kind, slot } = parseBellKey(key);
  const e = { '@id': bellIri(key), '@type': BELL_TYPE, 'scrum:bellKey': key, 'scrum:ceremonyKind': kind, 'scrum:slotAt': slot, 'scrum:occurredAt': reservedAt };
  for (const [k, v] of Object.entries(value || {})) if (v !== undefined) e[BELL_VALUE_FIELDS[k]] = v;
  return e;
}

/** A stored bell entity's value, exactly as it was written (the inverse of bellEntity's state half). */
export function bellValue(entity) {
  const out = {};
  for (const [k, p] of Object.entries(BELL_VALUE_FIELDS)) if (Object.hasOwn(entity, p)) out[k] = entity[p];
  return out;
}

export const findBell = (ents, key) => (Array.isArray(ents) ? ents : []).find((e) => e && e['@id'] === bellIri(key)) || null;

// Event fields with a predicate of their own; everything else the tick records rides scrum:detail as JSON, so nothing is
// lost and the graph does not grow a predicate per diagnostic.
const EVENT_FIELDS = Object.freeze({
  type: 'scrum:eventType', outcome: 'scrum:outcome', tickAt: 'scrum:tickAt', opener: 'scrum:opener',
  openerSource: 'scrum:openerSource', bootId: 'scrum:bootId', bootAt: 'scrum:bootAt',
  droppedSince: 'scrum:droppedSince', firstDropAt: 'scrum:firstDropAt',
});
const NOT_DETAIL = new Set([...Object.keys(EVENT_FIELDS), 'key', 'kind', 'slot']);

/** One recorded event as an entity, linked to its bell when it names one. */
export function bellEventEntity({ key, event, receivedAt, id = crypto.randomUUID() }) {
  const e = { '@id': bellEventIri(id), '@type': BELL_EVENT_TYPE, 'scrum:occurredAt': receivedAt };
  if (key) e['scrum:ofBell'] = bellIri(key);
  for (const [k, p] of Object.entries(EVENT_FIELDS)) if (event[k] !== undefined && event[k] !== null) e[p] = event[k];
  const rest = Object.fromEntries(Object.entries(event).filter(([k, v]) => !NOT_DETAIL.has(k) && v !== undefined));
  if (Object.keys(rest).length) e['scrum:detail'] = JSON.stringify(rest);
  return e;
}
