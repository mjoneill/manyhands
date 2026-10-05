/**
 * #1574 R2 — an ORDINARY post written straight to the graph (conversations unit ON). The pure half: ids, the intention,
 * and the reservation map. The route itself (locks, executor calls, status codes) lives in server.js.
 *
 *   id           a version-5 UUID of `<author>:<requestId>` under POST_WRITE_NAMESPACE, so the same author retrying the
 *                same key names the same post, and two authors using one key name two posts.
 *   reservation  `postReservations[key] = {postId, postSeq, createdAt}` in the board document, written under the lock in
 *                the same write that advances `nextPostSeq`. The key is the requestId; a second author reusing a key
 *                another author already holds is stored under `<requestId>@<author>` instead, so neither is handed the
 *                other's post.
 *   intention    `post.write`, opId `urn:ex:op/post/<postId>`, the node shape R0 writes. Built only from the request's
 *                content and the reserved number and time, so a retry rebuilds the identical intention (the same digest)
 *                and the executor's receipt decides: the same content replays, different content is an intent-collision.
 */
import { createHash } from 'node:crypto';

/** The namespace of every ordinary post id. Chosen once and NEVER changed: a new namespace would give a retry a new id. */
export const POST_WRITE_NAMESPACE = '6f1d2c8e-4b7a-4e39-9c51-2a8d7e0b4f63';
export const RESERVATIONS_FIELD = 'postReservations';
export const POST_OP_PREFIX = 'urn:ex:op/post/';
/** An APPLIED reservation older than this is dropped the next time a reservation is written (see pruneReservations). */
export const RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PERSON_IRI = 'https://scrumboard.local/person/';
// 1–256 UTF-16 code units, compared exactly (no normalization). C0 controls, DEL and C1 controls are refused, and so are
// unpaired surrogates: hashed as UTF-8 they become U+FFFD, so two distinct strings would name ONE post.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
export const validRequestId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 256 && !CONTROL_RE.test(v) && v.isWellFormed();

/** The post id of one (author, requestId): an RFC 4122 version-5 UUID. */
export function postWriteId(author, requestId) {
  const ns = Buffer.from(POST_WRITE_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(`${author}:${requestId}`, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;   // version 5
  b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const reservationsOf = (data) => (isObj(data?.[RESERVATIONS_FIELD]) ? data[RESERVATIONS_FIELD] : {});

/** The reservation this author's key holds, or null. Matched by postId, so another author's entry is never returned. */
export function findReservation(data, requestId, author) {
  const all = reservationsOf(data);
  const postId = postWriteId(author, requestId);
  for (const k of [requestId, `${requestId}@${author}`]) {
    const r = Object.hasOwn(all, k) ? all[k] : undefined;   // own keys only: `__proto__`, `constructor` are ordinary keys here
    if (isObj(r) && r.postId === postId && Number.isSafeInteger(r.postSeq) && r.postSeq > 0 && typeof r.createdAt === 'string') return { key: k, ...r };
  }
  return null;
}

/** The key a NEW reservation for this author is stored under: the requestId, unless another author already holds it. */
export function reservationKey(data, requestId, author) {
  const all = reservationsOf(data);
  const held = Object.hasOwn(all, requestId) ? all[requestId] : undefined;
  return isObj(held) && held.postId !== postWriteId(author, requestId) ? `${requestId}@${author}` : requestId;
}

/**
 * Prunes the reservation map inside a write that is ALREADY recording a reservation, so it costs no extra document write.
 * A reservation is dropped only when it is known APPLIED and older than RESERVATION_TTL_MS. Age alone never drops one: an
 * unresolved reservation (its write never confirmed) is kept however old it is, so its retry still lands the reserved
 * number. `appliedKeys` are the keys this process has seen APPLIED since the last such write; they are stamped
 * `applied: true` here, in the same write. (A key applied just before a restart is never stamped and is simply kept.)
 */
export function pruneReservations(all, nowMs, appliedKeys = new Set()) {
  const out = [];   // entries, then Object.fromEntries: `out[k] = …` with k = '__proto__' would set the prototype, not a key
  for (const [k, r] of Object.entries(isObj(all) ? all : {})) {
    if (!isObj(r)) continue;
    const entry = appliedKeys.has(k) && r.applied !== true ? { ...r, applied: true } : r;
    const t = Date.parse(entry.createdAt);
    if (entry.applied === true && Number.isFinite(t) && nowMs - t > RESERVATION_TTL_MS) continue;
    out.push([k, entry]);
  }
  return Object.fromEntries(out);
}

/** An attachment size the graph can store: a non-negative safe integer. */
export const validAttachmentSize = (n) => Number.isSafeInteger(n) && n >= 0;

/** The `post.write` intention. `post` is the post as the route built it; `postSeq` and `createdAt` are the reserved ones. */
export function postWriteIntention(post) {
  return {
    kind: 'post.write',
    opId: `${POST_OP_PREFIX}${post.id}`,
    actor: `${PERSON_IRI}${post.author}`,
    post: {
      id: post.id, body: post.body, author: post.author, createdAt: post.createdAt, attachedTo: post.attachedTo ?? null,
      mentions: Array.isArray(post.mentions) ? [...post.mentions] : [], postSeq: post.postSeq,
      ...(post.conversation ? { conversation: post.conversation } : {}),
      ...(post.onBehalfOf != null ? { onBehalfOf: post.onBehalfOf } : {}),
      ...(Array.isArray(post.attachments) && post.attachments.length
        ? { attachments: post.attachments.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size })) } : {}),
    },
  };
}
