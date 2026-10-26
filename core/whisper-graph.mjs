/**
 * #1786 — the whisper's two once-per-window guards as GRAPH state, answered by REST under its write lock (the one writer),
 * so two MCP processes, or two ticks, racing one window make exactly one send and one grant. Before, both guards lived in
 * whisper-state.json inside ONE MCP process (whisper-store.mjs), which no second process and no graph query could see.
 *
 *   the WINDOW RESERVATION — the board may SEND one prompt per window. Its own node, `scrum:TendingWindowReservation`, and
 *     NOT the TendingMint: a mint is a delivered firing (#1189, core/tending-tick.mjs), and a reservation whose post then
 *     fails burns the window (#804's fail-silent rule) without claiming the room was tended.
 *   the CLAIM — one SEAT may WHISPER per window. A granted `scrum:TendingClaimAttempt`, the shape #805 imports legacy grants
 *     in, plus its window (`scrum:clockWindow`) so the guard needs no join. Refusals stay log-only, as before.
 *
 * Pure: entities in, entities or answers out. The decision itself is core/whisper-window.mjs's claimWhisper, unchanged.
 */
import { claimAttemptId } from './tending-ids.mjs';

export const RESERVATION_TYPE = 'scrum:TendingWindowReservation';
export const reservationIri = (window) => `https://scrumboard.local/tending/window/${encodeURIComponent(window)}`;
const PERSON = 'https://scrumboard.local/person/';
const byId = (ents) => new Map((Array.isArray(ents) ? ents : []).map((e) => [e['@id'], e]));

/** Is this window already reserved for a send? */
export const windowReserved = (ents, window) => byId(ents).has(reservationIri(window));

/** The reservation entity for `window` at `at`. */
export const reservationEntity = (window, at) => ({ '@id': reservationIri(window), '@type': RESERVATION_TYPE, 'scrum:clockWindow': window, 'scrum:occurredAt': at });

/** The window a granted attempt settled: its own, or (an imported legacy grant) its mint's. */
function attemptWindow(a, ids) {
  if (a['scrum:clockWindow']) return a['scrum:clockWindow'];
  const m = a['scrum:ofMint'] ? ids.get(a['scrum:ofMint']) : null;
  return m?.['scrum:clockWindow'] ?? m?.['scrum:legacyClockWindow'] ?? null;
}
const seatOf = (a) => a['scrum:declaredSeatRaw'] ?? String(a['scrum:declaredSeat'] ?? '').replace(PERSON, '');
const granted = (ents) => (Array.isArray(ents) ? ents : []).filter((e) => e['@type'] === 'scrum:TendingClaimAttempt' && e['scrum:outcome'] === 'granted');

/** claimWhisper's settlement state for `window`: who holds it, if anyone. */
export function claimStateFor(ents, window) {
  const ids = byId(ents);
  const held = granted(ents).find((a) => attemptWindow(a, ids) === window);
  return held
    ? { lastWhisperWindow: window, lastWhisperBy: seatOf(held), lastWhisperAt: held['scrum:receivedAt'] ?? null }
    : { lastWhisperWindow: null, lastWhisperBy: null, lastWhisperAt: null };
}

/** A grant as an entity: one per window (its IRI is the window's), linked to the window's delivered mint when there is one. */
export function grantEntity({ ents, window, seat, receivedAt, completedAt, reached }) {
  const mint = (Array.isArray(ents) ? ents : []).find((e) => e['@type'] === 'scrum:TendingMint' && e['scrum:clockWindow'] === window);
  return {
    '@id': claimAttemptId(`grant-${window}`),
    '@type': 'scrum:TendingClaimAttempt',
    'scrum:clockWindow': window,
    ...(mint ? { 'scrum:ofMint': mint['@id'] } : {}),
    'scrum:receivedAt': receivedAt,
    'scrum:completedAt': completedAt,
    'scrum:outcome': 'granted',
    'scrum:declaredSeat': `${PERSON}${encodeURIComponent(seat)}`,
    'scrum:declaredSeatRaw': seat,
    ...(Array.isArray(reached) && reached.length ? { 'scrum:seatNamesWithOpenStreamsAtSend': reached.map((k) => `${PERSON}${encodeURIComponent(k)}`) } : {}),
  };
}

/** The grant history, oldest first: what recentWhispers() returned from the file. */
export function claimHistory(ents, limit = 24) {
  const ids = byId(ents);
  return granted(ents)
    .map((a) => ({ window: attemptWindow(a, ids), seat: seatOf(a), at: a['scrum:receivedAt'] ?? null,
      ...(Array.isArray(a['scrum:seatNamesWithOpenStreamsAtSend']) ? { reached: a['scrum:seatNamesWithOpenStreamsAtSend'].map((p) => String(p).replace(PERSON, '')) } : {}) }))
    .filter((h) => h.window && h.at)
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
    .slice(-limit);
}
