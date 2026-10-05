/**
 * #1574 R3 — graph post DISCOVERY by the executor's commit order.
 *
 * Every commons poller keys on a post's createdAt, so a post that becomes visible LATE (an older time, or a lower
 * postSeq than one already consumed) is skipped by every client whose cursor has moved on. Here the position is the
 * executor's durable `commitSeq`, stamped on each operation's receipt in the same guarded update that wrote the post.
 * `postSeq` stays the DISPLAY order and is never a discovery position.
 *
 *   BOOTSTRAP  `afterCommit=start` reads the marker's commitSeq as a baseline B and pages the posts COMMITTED AT OR
 *              BELOW B (imports included) in postSeq order under `gb1.<incarnation>.<epoch>.<B>.<lastPostSeq>.<scope>`.
 *              B bounds MEMBERSHIP: a post committed after B is never a bootstrap row, whatever its postSeq. The page
 *              that empties the snapshot answers phase 'live' with `gc1.<incarnation>.<epoch>.<B>.<scope>`.
 *   LIVE       posts committed AFTER the cursor, ascending commitSeq, imports excluded. The next cursor is the LAST
 *              DELIVERED commit, never the head: an empty page echoes the request's own cursor.
 *   FILTERS    are applied before the limit; the cursor crosses an excluded row only after examining it for THIS
 *              filter, and the token carries the filter scope (sha256 of canonical JSON) so a filter change is refused.
 *   ELIGIBLE   an operation with an APPLIED receipt AND a queryable post node. An APPLIED operation whose node is gone
 *              is INCONSISTENT (there is no redaction record yet: R4); nothing is guessed and no cursor moves.
 *
 * Tokens are fenced by the executor's incarnation and epoch: another store, a promoted copy or a rewrite is a resync.
 */
import { createHash } from 'node:crypto';

const NS = 'urn:ex:';
const DATASET = `${NS}dataset`;
const COMMIT = `${NS}commitSeq`;
const OUTCOME = `${NS}outcome`;
const EPOCH = `${NS}epoch`;
const INCARNATION = `${NS}incarnation`;
const RECORDED_BY = `${NS}recordedBy`;
const APPLIED = `${NS}APPLIED`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const RS = 'https://scrumboard.local/ns#';
const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const TALK = 'https://scrumboard.local/talk/';

/** The operations that write posts. Imports (R0's backfill) are part of a bootstrap and never live activity. */
export const LIVE_POST_OPS = Object.freeze([`${NS}op/announce/`, `${NS}op/post/`]);   // #1574 R2 — ordinary posts are live too
export const IMPORT_POST_OPS = Object.freeze([`${NS}op/backfill/`]);
/** #1574 R4a — redactions are live activity (for imported posts too) and never bootstrap rows: a bootstrap shows the slot. */
export const REDACT_POST_OPS = Object.freeze([`${NS}op/redact/`]);
const REDACTED_TYPE = 'https://scrumboard.local/ns#RedactedPost';
const BATCH = 200;
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
/** Bootstrap rows after `last`, PLUS every row whose postSeq is not a valid positive integer: an invalid value must reach
 *  the validator (and be refused by name), never be filtered out of sight by the comparison. */
const afterOrInvalid = (last) => `(!BOUND(?ps) || DATATYPE(?ps) != <${XSD_INT}> || ?ps <= 0 || ?ps > ${last})`;

export class DiscoveryError extends Error {
  constructor(status, body) { super(body.code); this.status = status; this.body = body; }
}
const refuse = (status, code, error, extra = {}) => { throw new DiscoveryError(status, { error, code, ...extra }); };
const resync = (error) => refuse(409, 'POST_CURSOR_EPOCH_CHANGED', error, { resync: 'afterCommit=start' });

/** The filter scope: the full sha256 of canonical JSON, fixed field order, explicit nulls. Continuity, not authorization. */
export function scopeOf({ mentions_me = null, attachedTo = null, conversation = null } = {}) {
  const canon = JSON.stringify({ v: 1, mentions_me: mentions_me == null ? null : String(mentions_me).toLowerCase(), attachedTo: attachedTo ?? null, conversation: conversation ?? null });
  return createHash('sha256').update(canon).digest('hex');
}

const GC = /^gc1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
const GB = /^gb1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d+)\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
export const isGraphToken = (t) => typeof t === 'string' && /^g[cb]1\./.test(t);
export const formatLive = (inc, epoch, commit, scope) => `gc1.${inc}.${epoch}.${commit}.${scope}`;
export const formatBoot = (inc, epoch, base, lastPostSeq, scope) => `gb1.${inc}.${epoch}.${base}.${lastPostSeq}.${scope}`;

/** 'start' | {kind:'live', ...} | {kind:'boot', ...}; a document token is a 409, anything else unparseable a 400. */
export function parseDiscoveryToken(raw) {
  if (raw === 'start') return { kind: 'start' };
  if (typeof raw === 'string' && raw.startsWith('ps1.')) resync('afterCommit takes a graph discovery cursor; a ps1 token is a document-path cursor and is never reinterpreted');
  let m = GC.exec(raw || '');
  if (m) return { kind: 'live', inc: m[1], epoch: m[2], commit: Number(m[3]), scope: m[4] };
  m = GB.exec(raw || '');
  if (m) return { kind: 'boot', inc: m[1], epoch: m[2], base: Number(m[3]), lastPostSeq: Number(m[4]), scope: m[5] };
  refuse(400, 'UNKNOWN_CURSOR', 'afterCommit is not a discovery cursor: expected gc1.…, gb1.… or the keyword start (a time is never accepted here)');
}

async function read(client, sparql) {
  const r = await client.query(sparql);
  if (!r.ok) refuse(503, 'GRAPH_DISCOVERY_UNAVAILABLE', `the graph could not be read (${r.reason || r.status || 'unavailable'}); nothing was delivered and no cursor moved`);
  return r.rows;
}

async function marker(client) {
  const rows = await read(client, `SELECT ?e ?s ?i WHERE { <${DATASET}> <${EPOCH}> ?e ; <${COMMIT}> ?s ; <${INCARNATION}> ?i }`);
  if (rows.length !== 1) refuse(503, 'GRAPH_DISCOVERY_INCONSISTENT', `the executor's marker has ${rows.length} rows (expected 1)`);
  return { epoch: rows[0].e.value, commit: Number(rows[0].s.value), inc: rows[0].i.value };
}

const prefixFilter = (prefixes) => prefixes.map((p) => `STRSTARTS(STR(?op), ${JSON.stringify(p)})`).join(' || ');

/** The node fields of a set of post IRIs, as {iri: post}. */
async function nodes(client, iris) {
  if (!iris.length) return {};
  const rows = await read(client, `SELECT ?p ?k ?v WHERE { VALUES ?p { ${iris.map((i) => `<${i}>`).join(' ')} } ?p ?k ?v }`);
  const out = {};
  for (const b of rows) {
    const p = (out[b.p.value] ||= { id: b.p.value.slice(ENTITY.length), mentions: [] });
    const k = b.k.value, v = b.v.value;
    if (k === RDF_TYPE && v === REDACTED_TYPE) p.redacted = true;
    else if (k === `${SCHEMA}text`) p.body = v;
    else if (k === `${SCHEMA}author`) p.author = v.startsWith(PERSON) ? v.slice(PERSON.length) : v;
    else if (k === `${SCHEMA}dateCreated`) p.createdAt = v;
    else if (k === `${RS}postSeq`) { p.postSeq = Number(v); p.postSeqValid = (p.postSeqValid ?? true) && b.v.datatype === XSD_INT && /^[0-9]+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0; p.postSeqCount = (p.postSeqCount || 0) + 1; }
    else if (k === `${RS}mentionsName`) p.mentions.push(v);
    else if (k === `${SCHEMA}about`) p.attachedTo = v.startsWith(ENTITY) ? v.slice(ENTITY.length) : v;
    else if (k === `${RS}conversation`) p.conversation = v.startsWith(TALK) ? v.slice(TALK.length) : v;
  }
  return out;
}

function matches(post, f) {
  if (f.mentions_me != null && !post.mentions.some((m) => m.toLowerCase() === String(f.mentions_me).toLowerCase())) return false;
  if (f.attachedTo != null && (post.attachedTo ?? 'null') !== f.attachedTo) return false;
  if (f.conversation != null && post.conversation !== f.conversation) return false;
  return true;
}
// #1574 R4a — a redacted post is served content-free: its slot and nothing it said (never "" and never the old text)
const redactedShape = (p, commitSeq, op = null) => ({ ...(op ? { op } : {}), id: p.id, postSeq: p.postSeq, body: null, redacted: true, commitSeq });
const shape = (p, commitSeq) => p.redacted ? redactedShape(p, commitSeq) : ({ id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, postSeq: p.postSeq, commitSeq, mentions: p.mentions, ...(p.attachedTo ? { attachedTo: p.attachedTo } : {}) });

/** One batch of eligible operations, each with its post node or null (INCONSISTENT). */
async function opBatch(client, { prefixes, where, order, limit }) {
  // a writing op finds its post through recordedBy (a live Comment, or the tombstone it became); a REDACTION op finds the
  // tombstone it made through redactedBy
  const raw = await read(client, `SELECT ?op ?c ?p ?ps ?q ?qs WHERE {
  ?op <${COMMIT}> ?c ; <${OUTCOME}> ?out .
  FILTER(STR(?out) = ${JSON.stringify(APPLIED)} && (${prefixFilter(prefixes)}) && ${where})
  OPTIONAL { ?p <${RECORDED_BY}> ?op ; <${RDF_TYPE}> ?pt . FILTER(?pt = <${SCHEMA}Comment> || ?pt = <${REDACTED_TYPE}>) OPTIONAL { ?p <${RS}postSeq> ?ps } }
  OPTIONAL { ?q <${RS}redactedBy> ?op . OPTIONAL { ?q <${RS}postSeq> ?qs } }
} ORDER BY ${order} LIMIT ${limit}`);
  const rows = raw.map((b) => (b.p || !b.q ? b : { ...b, p: b.q, ps: b.qs, redact: true }));
  for (const b of rows) {
    if (!b.p) refuse(503, 'GRAPH_DISCOVERY_INCONSISTENT', `operation ${b.op.value} has an APPLIED receipt but no post node (and there is no redaction record); nothing was delivered and no cursor moved`);
    // a literal with no datatype is a plain string (xsd:string), never an xsd:integer: every writer stamps the number typed
    if (!b.ps || b.ps.datatype !== XSD_INT || !/^[0-9]+$/.test(b.ps.value) || !Number.isSafeInteger(Number(b.ps.value)) || Number(b.ps.value) <= 0) refuse(503, 'GRAPH_DISCOVERY_INCONSISTENT', `post ${b.p.value} has no valid postSeq; it is neither omitted nor listed, and no cursor moved`);
  }
  return rows.map((b) => ({ op: b.op.value, commit: Number(b.c.value), iri: b.p.value, postSeq: b.ps ? Number(b.ps.value) : null, redact: !!b.redact }));
}

// #1596 — the bootstrap snapshot cache: one ordered list per (incarnation, epoch, baseline), a few entries kept.
const SNAP_MAX = 8;
const snapCache = new Map();
async function snapshotList(client, m, base) {
  const key = `${m.inc}|${m.epoch}|${base}`;
  const hit = snapCache.get(key);
  if (hit) { snapCache.delete(key); snapCache.set(key, hit); return hit; }
  // one ordered read of the whole snapshot; every row is validated by opBatch (a missing node or an invalid postSeq
  // refuses the page, exactly as before), so a cached list holds only valid, ordered entries
  const list = await opBatch(client, { prefixes: [...LIVE_POST_OPS, ...IMPORT_POST_OPS], where: `?c <= ${base}`, order: '?ps', limit: 100000000 });
  if (snapCache.size >= SNAP_MAX) snapCache.delete(snapCache.keys().next().value);
  snapCache.set(key, list);
  return list;
}
function lowerBound(list, lastPs) { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].postSeq > lastPs) hi = mid; else lo = mid + 1; } return lo; }

/**
 * One page. `filters` = {mentions_me, attachedTo, conversation} as requested. Returns {conversations, phase, nextAfterCommit}.
 * Throws DiscoveryError (400/409/503) with nothing delivered and no cursor handed out.
 */
export async function postFeed(client, args) {
  const tok = parseDiscoveryToken(args.after);
  const scope = scopeOf(args.filters || {});
  if (tok.kind !== 'start' && tok.scope !== scope) refuse(400, 'CURSOR_FILTER_MISMATCH', 'this cursor was issued for different filters; start a new bootstrap (afterCommit=start) to change them');
  const m = await marker(client);
  // THE IDENTITY FENCE: the marker and the batch are separate reads. If the store behind the executor changed between
  // them (another incarnation or epoch), the rows would belong to the new store while the cursor names the old one, so
  // the marker is read again AFTER the batch reads and any change refuses the page: no rows, no cursor. A refusal raised
  // inside the batch is re-checked the same way, so a swapped store is never reported as an inconsistency of the old one.
  const same = async () => { const m2 = await marker(client); return m2.inc === m.inc && m2.epoch === m.epoch; };
  const switched = () => refuse(503, 'GRAPH_DISCOVERY_UNAVAILABLE', 'the store behind the executor changed during this read; nothing was delivered and no cursor moved (retry: a different store answers with a resync)');
  let page;
  try { page = await pageOf(client, tok, scope, m, args); }
  catch (e) { if (e instanceof DiscoveryError && e.body.code === 'GRAPH_DISCOVERY_INCONSISTENT' && !(await same())) switched(); throw e; }
  if (!(await same())) switched();
  return page;
}

async function pageOf(client, tok, scope, m, { limit, filters = {} }) {
  if (tok.kind !== 'start' && (tok.inc !== m.inc || tok.epoch !== m.epoch)) {
    resync(`this cursor belongs to another store (incarnation ${tok.inc}, epoch ${tok.epoch}; the executor is incarnation ${m.inc}, epoch ${m.epoch}): its positions are not comparable, so it is never jumped to the head`);
  }
  const want = Math.max(0, limit);

  if (tok.kind === 'live') {
    // #1596 — the idle poll: nothing can have committed after the marker's commitSeq, so a cursor EXACTLY at the head is
    // answered from the marker read alone (an empty page echoing the request's own cursor), without matching any op. A
    // cursor AHEAD of the marker is not given this shortcut: it takes the ordinary path, unchanged.
    if (tok.commit === m.commit) return { conversations: [], phase: 'live', nextAfterCommit: formatLive(m.inc, m.epoch, tok.commit, scope) };
    const out = []; let scanned = tok.commit;
    while (out.length < want) {
      const batch = await opBatch(client, { prefixes: [...LIVE_POST_OPS, ...REDACT_POST_OPS], where: `?c > ${scanned}`, order: '?c', limit: BATCH });
      if (!batch.length) break;
      const n = await nodes(client, batch.map((x) => x.iri));
      for (const x of batch) {
        scanned = x.commit;   // examined for THIS filter; an excluded row is crossed only by a later delivered one
        const p = n[x.iri];
        // a redaction reaches EVERY consumer, whatever its filter: one that cached the post must be able to drop it, and
        // the fields its filter matched on are gone. It carries nothing the post said.
        if (p && x.redact) { out.push(redactedShape(p, x.commit, 'redact')); if (out.length >= want) break; }
        else if (p && (p.redacted || matches(p, filters))) { out.push(shape(p, x.commit)); if (out.length >= want) break; }
      }
      if (batch.length < BATCH) break;
    }
    // the LAST DELIVERED commit, never the head; an empty page echoes the request's own cursor
    const next = out.length ? out.at(-1).commitSeq : tok.commit;
    return { conversations: out, phase: 'live', nextAfterCommit: formatLive(m.inc, m.epoch, next, scope) };
  }

  // bootstrap: a fixed baseline, paged by postSeq; imports included.
  // #1596 — the ordered list of (postSeq, op) at or below the baseline is a FIXED snapshot (nothing committed at or below
  // B changes position), so it is read ONCE per (store, baseline) and cached, instead of re-matching and re-sorting
  // every op on every page. Node fields are still read fresh per page, so a redaction made mid-bootstrap still shows.
  const base = tok.kind === 'start' ? m.commit : tok.base;
  let lastPs = tok.kind === 'start' ? 0 : tok.lastPostSeq;
  const list = await snapshotList(client, m, base);
  let i = lowerBound(list, lastPs);   // the first entry with postSeq > lastPs
  const out = [];
  while (out.length < want && i < list.length) {
    const chunk = list.slice(i, i + Math.min(BATCH, Math.max(want - out.length, 1) * 2));
    const n = await nodes(client, chunk.map((x) => x.iri));
    for (const x of chunk) {
      if (out.length >= want) break;
      i++;
      lastPs = x.postSeq;
      const p = n[x.iri];
      if (!p) refuse(503, 'GRAPH_DISCOVERY_INCONSISTENT', `post ${x.iri} vanished during the bootstrap; nothing was delivered and no cursor moved`);
      // the cached order is re-checked against the node AS IT IS NOW: a postSeq that changed, went invalid or doubled is
      // a named inconsistency, never served from a stale list
      if (!p.postSeqValid || p.postSeqCount !== 1 || p.postSeq !== x.postSeq) refuse(503, 'GRAPH_DISCOVERY_INCONSISTENT', `post ${x.iri} has no valid postSeq (or not the one it was listed under); it is neither omitted nor listed, and no cursor moved`);
      if (p.redacted || matches(p, filters)) out.push(shape(p, x.commit));
    }
  }
  const exhausted = i >= list.length;
  if (exhausted) return { conversations: out, phase: 'live', nextAfterCommit: formatLive(m.inc, m.epoch, base, scope) };
  return { conversations: out, phase: 'bootstrap', nextAfterCommit: formatBoot(m.inc, m.epoch, base, lastPs, scope) };
}
