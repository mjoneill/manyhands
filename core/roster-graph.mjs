/**
 * #1764 — the roster's CONFIGURED seats (humans, and the seats they set up) as graph nodes in the `rosterSeats` collection
 * family, so "who is on the board" is one query (the invited agents already are graph nodes). Two paths, as every K13
 * family that once had a file shape:
 *   · the collections unit OFF: roster.json, read and written by roster-config.mjs, exactly as before;
 *   · the unit ON: these nodes are the roster. roster.json is imported ONCE, and from then on it is only an EXPORT that
 *     the board rewrites, for the one reader that cannot reach the graph: the pre-push history gate (severance-check,
 *     #600), which reads seat names from the file and must never under-guard. See writeRosterExport in server.js: a save
 *     writes the export as a SUPERSET of old and new seats before the graph commit and the exact set after it, so at every
 *     instant the file's seats ⊇ the graph's.
 *
 * Pure: validated seats ⇄ entities, in roster ORDER (the order is part of the roster's contract: the author picker
 * defaults to the first seat, #1200).
 */
export const SEAT_TYPE = 'scrum:RosterSeat';
export const ROLES_TYPE = 'scrum:RosterRoles';
export const seatIri = (key) => `https://scrumboard.local/seat/${encodeURIComponent(key)}`;
export const ROLES_IRI = 'https://scrumboard.local/config/roster-roles';

/** validateRoster's clean seats (an ordered object) and validateRoles' roles → the family's entities. */
export function rosterEntities(seats, roles = {}) {
  const out = Object.entries(seats).map(([key, s], k) => ({
    '@id': seatIri(key), '@type': SEAT_TYPE,
    'scrum:seatKey': key, name: s.name, 'scrum:color': s.color, 'scrum:rosterOrder': k,
    ...(s.glyph ? { 'scrum:glyph': s.glyph } : {}),
    ...(s.aliases?.length ? { 'scrum:aliases': [...s.aliases] } : {}),
    ...(s.kind ? { 'scrum:kind': s.kind } : {}),
  }));
  out.push({ '@id': ROLES_IRI, '@type': ROLES_TYPE, ...(roles.po ? { 'scrum:poSeat': roles.po } : {}) });
  return out;
}

/** The family's entities → the seats in validateRoster's shape, in rosterOrder. */
export function seatsFrom(ents) {
  const seats = {};
  for (const e of (Array.isArray(ents) ? ents : []).filter((x) => x && x['@type'] === SEAT_TYPE)
    .sort((a, b) => (a['scrum:rosterOrder'] ?? 0) - (b['scrum:rosterOrder'] ?? 0))) {
    const aliases = e['scrum:aliases'] == null ? [] : [].concat(e['scrum:aliases']);
    seats[e['scrum:seatKey']] = {
      name: e.name,
      ...(e['scrum:glyph'] ? { glyph: e['scrum:glyph'] } : {}),
      color: e['scrum:color'],
      ...(aliases.length ? { aliases } : {}),
      ...(e['scrum:kind'] ? { kind: e['scrum:kind'] } : {}),
    };
  }
  return seats;
}

/** The family's roles node → { po? }. */
export function rolesFrom(ents) {
  const r = (Array.isArray(ents) ? ents : []).find((x) => x && x['@id'] === ROLES_IRI);
  return r?.['scrum:poSeat'] ? { po: r['scrum:poSeat'] } : {};
}

/** Does the graph already hold a configured roster? (The one-time import runs only when it does not.) */
export const rosterInGraph = (ents) => (Array.isArray(ents) ? ents : []).some((x) => x && x['@type'] === SEAT_TYPE);

/** The SUPERSET written before a graph commit: every seat of `next`, in its order, then each seat of `prev` it drops. */
export function supersetSeats(prev, next) {
  const out = { ...next };
  for (const [k, v] of Object.entries(prev || {})) if (!(k in out)) out[k] = v;
  return out;
}
