/**
 * #1762 S2 — a refusal as a graph record with NO composed content (contract on #1762, "S2 CONTRACT v2.2"; ruling on
 * #1217: refused non-post text may become unrecoverable). With native history on, a refusal writes ONE
 * `scrum:RefusalRecord` and nothing to the event log. It holds no error message, body, mention or attachment. It holds
 * outcomes (status, a REGISTERED code or rule), the trusted route TEMPLATE and the action it names (an adapter label only
 * when registered), the seat, and two bounded client-chosen identifiers, which are retained-data EXCEPTIONS, stated as
 * such: requestId and entityId, each only in its id shape. Anything unregistered is `scrum:unlisted`.
 *
 * Pure: raw refusal facts → the `refusal.record` intention. The compiler checks every field against these same registries,
 * so a caller that skips this module cannot store an unregistered value either.
 */
import { createHash, randomUUID } from 'node:crypto';

const PERSON = 'https://scrumboard.local/person/';
export const REFUSAL_UNKNOWN = 'https://scrumboard.local/ns#unknown';
export const UNLISTED = 'unlisted';   // the intention's sentinel; the compiler writes it as the IRI scrum:unlisted
export const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;   // core/unit3-graph.mjs REQUEST_ID_RE
export const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ENTITY_KIND_RE = /^[a-z][a-z-]{0,31}$/;
const SEAT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
// The adapter's labels (POST /api/refusals `route`) → the action each one refused. Closed: any other label is `unlisted`.
export const ADAPTER_ROUTES = Object.freeze({ 'mcp card_create': 'card_create', 'mcp card-targeting gate': 'card-targeting' });
// Every write route's template, as routeTemplate renders the router's own regex. tests/refusal-record-1762.test.mjs G5
// fails when a write route is added to server.js and not here, so the table is closed and never stale.
export const ROUTE_TEMPLATES = Object.freeze(new Set([
  'DELETE /api/cards/:p', 'DELETE /api/cards/:p/claim', 'DELETE /api/columns/:p', 'DELETE /api/seats/:p/state',
  'DELETE /api/tending/whispers/:p', 'PATCH /api/agents/:p', 'PATCH /api/cards/:p', 'PATCH /api/columns/:p',
  'PATCH /api/memories/:p', 'PATCH /api/models/:p', 'PATCH /api/nodes/:p', 'PATCH /api/obligations/:p',
  'PATCH /api/roles/:p', 'PATCH /api/talks/:p', 'PATCH /api/tending/whispers/:p', 'POST /api/agents',
  'POST /api/agents/:p/prompt', 'POST /api/artifacts', 'POST /api/assert', 'POST /api/attachments', 'POST /api/cards',
  'POST /api/cards/:p/claim', 'POST /api/cards/:p/move-fence', 'POST /api/columns', 'POST /api/config',
  'POST /api/conversations', 'POST /api/cursors/ack', 'POST /api/cursors/inbound', 'POST /api/cursors/register',
  'POST /api/cursors/served', 'POST /api/decisions', 'POST /api/decisions/:p/relations', 'POST /api/deliveries',
  'POST /api/deliveries/:p/events', 'POST /api/deliveries/events', 'POST /api/export', 'POST /api/export/preview',
  'POST /api/graph', 'POST /api/kinds', 'POST /api/labels/aliases', 'POST /api/memories', 'POST /api/model-calls',
  'POST /api/models', 'POST /api/models/:p/probe', 'POST /api/nodes', 'POST /api/obligations',
  'POST /api/outbox/:p/complete', 'POST /api/outbox/:p/publish', 'POST /api/predicates',
  'POST /api/procedure-versions', 'POST /api/procedures', 'POST /api/refusals', 'POST /api/roles', 'POST /api/roster',
  'POST /api/runs', 'POST /api/runs/generated', 'POST /api/search', 'POST /api/search/all', 'POST /api/talks',
  'POST /api/tending-config', 'POST /api/tending/mints', 'POST /api/tending/order', 'POST /api/tending/shuffle',
  'POST /api/tending/claims', 'POST /api/tending/whispers', 'POST /api/tending/windows', 'POST /api/wakes', 'PUT /api/seats/:p/state'
]));

/** `METHOD <regex source>` (the router's meter label) → `METHOD /api/cards/:p/claim`; anything unlisted is `unlisted`. */
export function routeTemplate(method, routeSource) {
  if (typeof method !== 'string' || typeof routeSource !== 'string') return UNLISTED;
  const src = routeSource.startsWith(`${method} `) ? routeSource.slice(method.length + 1) : routeSource;
  const t = `${method} ${src.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\[\^\\?\/\]\+\)/g, ':p').replace(/\\\//g, '/').replace(/\/\?$/, '')}`;
  return ROUTE_TEMPLATES.has(t) ? t : UNLISTED;
}

/** The adapter's label, through the closed list. */
export const adapterRoute = (route) => (typeof route === 'string' && Object.hasOwn(ADAPTER_ROUTES, route) ? route : UNLISTED);

const METHOD_ACTION = { POST: 'create', PATCH: 'update', PUT: 'replace', DELETE: 'delete' };
/** The bounded action a template names: its last fixed segment after a capture, else its method's; adapter labels map. */
export function refusedActionOf(route) {
  if (route === UNLISTED || typeof route !== 'string') return UNLISTED;
  if (Object.hasOwn(ADAPTER_ROUTES, route)) return ADAPTER_ROUTES[route];
  if (!ROUTE_TEMPLATES.has(route)) return UNLISTED;
  const [method, p] = route.split(' ');
  const segs = p.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  return last !== ':p' && segs.includes(':p') ? last : METHOD_ACTION[method] ?? UNLISTED;
}

/**
 * One refusal's opId (v2.2 §2): scoped to the refused seat AND the template, so the same requestId from another seat or
 * route is a different record; an identical retry is the same op (one record). No valid requestId: fresh, so no dedup.
 */
export function refusalOpId(associatedWith, route, requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return `urn:ex:op/refused/fresh-${randomUUID()}`;
  return `urn:ex:op/refused/${createHash('sha256').update(`${associatedWith}\u0000${route}\u0000${requestId}`).digest('hex').slice(0, 32)}`;
}
export const refusalIriOf = (opId) => `https://scrumboard.local/refusal/${createHash('sha256').update(opId).digest('hex').slice(0, 32)}`;

/** The seat: the authenticated one when auth binds one, else the declared actor if it is a roster seat, else unknown. */
export function refusalSeat({ authSeat, declared, rosterKeys }) {
  if (typeof authSeat === 'string' && SEAT_RE.test(authSeat)) return `${PERSON}${encodeURIComponent(authSeat)}`;
  if (typeof declared === 'string' && SEAT_RE.test(declared) && rosterKeys && rosterKeys.has(declared)) return `${PERSON}${encodeURIComponent(declared)}`;
  return REFUSAL_UNKNOWN;
}

/**
 * The `refusal.record` intention. An id outside its shape is DROPPED; a code, rule or route outside its registry is
 * `unlisted`; NO code (a claim 409 carries none) or no rule is ABSENT. `actor` is the board's own Person IRI, the writer of
 * the record; the refused seat is `associatedWith`.
 */
export function refusalIntention({ actor, route, status, code, rule, entityKind, entityId, requestId, seat }) {
  const rid = typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : null;
  const r = typeof route === 'string' && (ROUTE_TEMPLATES.has(route) || Object.hasOwn(ADAPTER_ROUTES, route)) ? route : UNLISTED;
  const opId = refusalOpId(seat, r, rid);
  return {
    kind: 'refusal.record', opId, actor,
    refusal: {
      iri: refusalIriOf(opId), route: r, refusedAction: refusedActionOf(r),
      status: Number.isSafeInteger(status) && status >= 400 && status <= 599 ? status : 500,
      code: code == null || code === '' ? null : (typeof code === 'string' && REFUSAL_CODES.has(code) ? code : UNLISTED),
      rule: rule == null || rule === '' ? null : (typeof rule === 'string' && REFUSAL_RULES.has(rule) ? rule : UNLISTED),
      entityKind: typeof entityKind === 'string' && ENTITY_KIND_RE.test(entityKind) ? entityKind : 'request',
      entityId: typeof entityId === 'string' && ENTITY_ID_RE.test(entityId) ? entityId : null,
      requestId: rid, associatedWith: seat,
    },
  };
}

export const REFUSAL_AUDIT_TOKEN = '[#1762 S2] refusal audit unavailable';
/**
 * The audit's health (v2.2 §6) and its in-flight bound (§3). `count` rises once per audit write that fails, is
 * unconfirmed, conflicts, or is dropped at the cap; `since` is the first such time (null at 0); both reset only on restart.
 * stderr: at most one line per 60 s, carrying REFUSAL_AUDIT_TOKEN.
 */
export function createRefusalAuditMeter({ log = (m) => console.error(m), now = () => Date.now(), maxInFlight = 16 } = {}) {
  let count = 0, since = null, lastLog = -Infinity, inFlight = 0;
  const unavailable = (reason) => {
    count++; if (since == null) since = new Date(now()).toISOString();
    if (now() - lastLog >= 60_000) { lastLog = now(); log(`${REFUSAL_AUDIT_TOKEN} (${count} since ${since}): ${String(reason).slice(0, 120)}`); }
  };
  return {
    unavailable,
    /** Run one audit write inside the bound; a write past the cap is dropped (counted) and resolves false. */
    async run(write) {
      if (inFlight >= maxInFlight) { unavailable('dropped: too many audit writes in flight'); return false; }
      inFlight++;
      try { return await write(); } finally { inFlight--; }
    },
    stats: () => ({ count, since }),
  };
}
