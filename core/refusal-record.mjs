/**
 * #1762 S2 — a refusal as a CONTENT-FREE graph record (contract on #1762, "S2 CONTRACT"; ruling on #1217: refused non-post
 * text may become unrecoverable). With native history on, a refusal writes ONE `scrum:RefusalRecord` and nothing to the
 * event log. The record holds identifiers and outcomes only: the route TEMPLATE, the status, a REGISTERED code or rule, the
 * entity kind, an entity id and a requestId only when they have a safe id's shape, and the seat. Never an error message, a
 * request or response body, a mention or an attachment, for any route: what a refused write said is not kept.
 *
 * Pure: raw refusal facts → the `refusal.record` intention. The compiler re-checks every field's shape, so a caller that
 * skips this module still cannot store prose.
 */
import { createHash, randomUUID } from 'node:crypto';

const PERSON = 'https://scrumboard.local/person/';
export const REFUSAL_UNKNOWN = 'https://scrumboard.local/ns#unknown';
export const UNLISTED = 'unlisted';
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;   // core/unit3-graph.mjs REQUEST_ID_RE
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEAT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENTITY_KIND_RE = /^[a-z][a-z-]{0,31}$/;

// The codes a refusal may name, verbatim. Every other code is stored as `unlisted`. tests/refusal-record-1762.test.mjs
// fails when a literal code in the server or core is missing here, so a new code is added on purpose, never by accident.
export const REFUSAL_CODES = Object.freeze(new Set(`ACK_TOKEN_INVALID ALREADY_ACKED AMBIGUOUS_NODE ATTACHMENT_FENCE_BUSY AUTH_REQUIRED BAD_DIRECTION
BAD_SOURCE BAD_TAIL CARD_WRITE_CONFLICT CARDS_UNAVAILABLE CHECKS_SOURCE_UNAVAILABLE CONFLICTING_CURSOR_PARAMS CURSOR_TOO_OLD
DECISION_REF DECISION_TWIN DECISIONS_TRUNCATED DELIVERY_CHANGED DISPATCH_HELD EMPTY_QUERY EVENT_NOT_FOUND GRAPH_DEPS_MISSING
GRAPH_DISCOVERY_OFF GRAPH_EXECUTOR_UNAVAILABLE GRAPH_FEED_UNREADABLE GRAPH_UNAVAILABLE GRAPH_WRITE_CONTENDED GRAPH_WRITE_REFUSED
GRAPH_WRITE_SCOPE GRAPH_WRITE_UNAUTHENTICATED GRAPH_WRITE_UNKNOWN IMPORTED_SETTLED INDEX_INCOMPLETE INSTRUMENT_FAILED
INTENT_COLLISION INVALID_ATTACHMENT_SIZE INVALID_POST INVALID_REQUEST_ID LANE_NOT_REGISTERED LEGACY_HOLD MEMORY_ASSERT_NOT_CUT_OVER
MOVE_FENCED MULTI_SEAT NEIGHBORS_SOURCE_UNAVAILABLE NEIGHBOUR_MOVED NO_CONVERSATION NO_DELIVERY_IDENTITY NO_FLAGS NO_SUCH_CARD
NO_SUCH_TALK NOT_A_PARTICIPANT NOT_SELECT OUTBOX_UNAVAILABLE OUTBOX_UNVERIFIABLE PERSON_INTEGRITY POST_CURSOR_EPOCH_CHANGED
POST_NODE_UNREADABLE POST_REDACTED POST_SEQ_ALLOCATOR_REFUSED POST_SEQ_BEHIND_GRAPH POST_SEQ_MIGRATION_REQUIRED
POST_SEQ_RESERVATION_INVALID POST_SEQ_STATE_CORRUPT READ_ONLY READY_SOURCE_UNAVAILABLE REPLICA_RETIRED REQUEST_ID_CONFLICT
REQUEST_ID_INVALID REQUEST_ID_REQUIRED ROW_CAP SCOPE_INSUFFICIENT SEAT_MISMATCH SEAT_NOT_SELF SEAT_STATE_TRUNCATED SERVICE_REFUSED
SINGLE_SEAT SOURCE_UNAVAILABLE TALK_CLOSED TOKEN_EXPIRED TOKEN_REVOKED TOKEN_UNKNOWN UNBOUNDED_PATH UNKNOWN_CURSOR UNKNOWN_LANE
UNKNOWN_NODE UNKNOWN_PREFIX UNKNOWN_ROLE UNKNOWN_SEAT UNKNOWN_TERM UNSUPPORTED_RETURN_SHAPE WRITE_CONFLICT`.split(/\s+/)));
// The adapter's rails (POST /api/refusals `rule`), verbatim; any other rule is `unlisted`.
export const REFUSAL_RULES = Object.freeze(new Set(['#755 work gate', '#755 claim cooldown']));

/** `METHOD <regex source>` (the router's meter label) → `METHOD /api/cards/:p/claim`; an unmatched request is `unmatched`. */
export function routeTemplate(method, routeSource) {
  if (typeof method !== 'string' || typeof routeSource !== 'string') return 'unmatched';
  const src = routeSource.startsWith(`${method} `) ? routeSource.slice(method.length + 1) : routeSource;
  const t = src.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\[\^\\\/\]\+\)/g, ':p').replace(/\\\//g, '/').replace(/\/\?$/, '');
  return /^\/api(\/(?:[a-z0-9][a-z0-9-]*|:p))*$/.test(t) ? `${method} ${t}` : 'unmatched';
}

/** The adapter's own label (`mcp card_create`), or `unmatched`. */
export const adapterRoute = (route) => (typeof route === 'string' && /^mcp [a-z][a-z_]{0,39}$/.test(route) ? route : 'unmatched');

/** One refusal's opId: the requestId's when it has one (a retried refusal is ONE record), else fresh. */
export const refusalOpId = (requestId) => `urn:ex:op/refused/${typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : randomUUID()}`;
export const refusalIriOf = (opId) => `https://scrumboard.local/refusal/${createHash('sha256').update(opId).digest('hex').slice(0, 32)}`;

/** The seat: the authenticated one when auth binds one, else the declared actor if it is a roster seat, else unknown. */
export function refusalSeat({ authSeat, declared, rosterKeys }) {
  if (typeof authSeat === 'string' && SEAT_RE.test(authSeat)) return `${PERSON}${encodeURIComponent(authSeat)}`;
  if (typeof declared === 'string' && SEAT_RE.test(declared) && rosterKeys && rosterKeys.has(declared)) return `${PERSON}${encodeURIComponent(declared)}`;
  return REFUSAL_UNKNOWN;
}

/**
 * The `refusal.record` intention. Inputs are the raw refusal facts; every value not in an allowlisted shape is dropped
 * (an id) or replaced by `unlisted` (a code or rule). `actor` is the board's own Person IRI: the writer of the record,
 * never the refused seat (that is `associatedWith`).
 */
export function refusalIntention({ actor, route, status, code, rule, entityKind, entityId, requestId, seat }) {
  const rid = typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : null;
  const opId = refusalOpId(rid);
  return {
    kind: 'refusal.record', opId, actor,
    refusal: {
      iri: refusalIriOf(opId), route,
      status: Number.isSafeInteger(status) && status >= 400 && status <= 599 ? status : 500,
      code: typeof code === 'string' && REFUSAL_CODES.has(code) ? code : UNLISTED,
      rule: rule == null ? null : (typeof rule === 'string' && REFUSAL_RULES.has(rule) ? rule : UNLISTED),
      entityKind: typeof entityKind === 'string' && ENTITY_KIND_RE.test(entityKind) ? entityKind : 'request',
      entityId: typeof entityId === 'string' && SAFE_ID_RE.test(entityId) ? entityId : null,
      requestId: rid, associatedWith: seat,
    },
  };
}

/** The health counter for audit writes that could not reach the graph: {count, since}. One stderr line a minute at most. */
export function createRefusalAuditMeter({ log = (m) => console.error(m), now = () => Date.now() } = {}) {
  let count = 0, since = null, lastLog = 0;
  return {
    unavailable(reason) {
      count++; if (since == null) since = new Date(now()).toISOString();
      if (now() - lastLog >= 60_000) { lastLog = now(); log(`[#1762 S2] a refusal could not be recorded in the graph (${count} since ${since}): ${String(reason).slice(0, 120)}`); }
    },
    stats: () => ({ count, since }),
  };
}
