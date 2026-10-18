/**
 * #1629 C1 — IDENTITY AND DIGEST COMPATIBILITY across the allocator cutover (contract v2 §2, §7 row C1, §9). TEST AUTHOR's, written before any build.
 * Ordinary and announcement post ids, the publication op ids, and the existing publication digests must come out EXACTLY as they do today, so a
 * migrated retry finds its own post and receipt instead of writing a second one.
 *
 * WHERE EACH GOLDEN VALUE COMES FROM (so no row certifies the code with its own output):
 *   ids       Python's uuid.uuid5 (an independent RFC 4122 implementation) over the namespaces the contract names, run 2026-10-18 at 608dbba
 *   digests   today's code at 608dbba (core/graph-compiler.mjs canonicalize + digestOf over core/post-write.mjs postWriteIntention and
 *             core/announce-outbox.mjs postCreateIntention): "compatible" MEANS unchanged, so today's value is the requirement
 *
 *   C1a  ordinary post id = UUIDv5(POST namespace, author + ':' + requestId), for plain, case-differing and Unicode request ids; NO normalisation:
 *        "Req-É" written precomposed and decomposed are two different posts (contract §2: exact requestId/author, no Unicode/case normalisation)
 *   C1b  announcement post id = UUIDv5(ANNOUNCE namespace, mutationId + ':' + slot)
 *   C1c  the namespaces and op-id shapes the contract freezes: urn:ex:op/post/<postId> and urn:ex:op/announce/<mutationId>/<slot>
 *   C1d  the post.write publication digest of a fixed post is today's, its intention keeps today's fields, and it INCLUDES the assigned
 *        postSeq and createdAt (contract §9: only the NEW reservation digest excludes them): changing either changes the digest
 *   C1e  the post.create publication digest of a fixed publisher entry is today's, and it includes postSeq and publicationAt
 *
 * Passes TODAY (it is the "must not change" half of C1). Negative controls it is built to catch: a changed namespace, a normalised request id
 * (NFC or lower-casing), a publication digest that drops or adds a field.
 * NOT covered, by name: the API response shapes of the post routes (C1 names them; the route rows belong with O1/P1, where a route exists);
 * receipts of MIGRATED operations (a migration fixture, M1); the new reservation digest (DS1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, digestOf } from '../core/graph-compiler.mjs';
import { POST_WRITE_NAMESPACE, POST_OP_PREFIX, postWriteId, postWriteIntention } from '../core/post-write.mjs';
import { ANNOUNCE_POST_NAMESPACE, announcePostId, opIdFor, postCreateIntention } from '../core/announce-outbox.mjs';

const POST = { id: postWriteId('ada', 'req-1'), body: 'a fixture post', author: 'ada', createdAt: '2026-08-01T00:00:00.000Z', attachedTo: null, mentions: ['grace'], postSeq: 41 };
const ENTRY = { mutationId: 'mut-1', slot: '0', postSeq: 42, publicationAt: '2026-08-01T00:01:00.000Z', payload: { body: 'an announcement', author: 'board', originActor: 'ada', occurredAt: '2026-08-01T00:00:30.000Z', mentions: [] } };
const digest = (i) => digestOf(canonicalize(i));

test('#1629 (C1a) ordinary post ids are UUIDv5 over the exact author and request id, with no normalisation', () => {
  assert.equal(postWriteId('ada', 'req-1'), 'a1780dca-a8a3-5dbd-89cd-d40cb0629798');
  assert.equal(postWriteId('Ada', 'req-1'), 'c1755bd5-c701-5d51-8f94-a7fd7b8b1948', 'the author is not case-folded');
  assert.equal(postWriteId('ada', 'Req-É'), '8341a0c7-c6f8-5d9c-bf43-c4b5d92f4e54', 'precomposed É');
  assert.equal(postWriteId('ada', 'Req-É'), 'e302a500-b2c7-5d5e-9d96-1c1049f7169e', 'decomposed É is a DIFFERENT post (no NFC)');
});

test('#1629 (C1b) announcement post ids are UUIDv5 over mutationId and slot', () => {
  assert.equal(announcePostId('mut-1', '0'), '1682d6b6-d01f-50b6-9a90-e7f38f628c58');
  assert.equal(announcePostId('mut-1', '1'), '7658e27e-ad31-5574-94c6-ff16d379044c', 'the slot is part of the identity');
  assert.equal(announcePostId('urn:ex:mutation/abc', 'claim'), '45856d55-eeeb-507f-bd41-9cf45d8ecf65');
});

test('#1629 (C1c) the frozen namespaces and op-id shapes', () => {
  assert.equal(POST_WRITE_NAMESPACE, '6f1d2c8e-4b7a-4e39-9c51-2a8d7e0b4f63');
  assert.equal(ANNOUNCE_POST_NAMESPACE, 'bb9ac420-d837-46bc-984d-6c875b978aee');
  assert.equal(postWriteIntention(POST).opId, `urn:ex:op/post/${POST.id}`); assert.equal(POST_OP_PREFIX, 'urn:ex:op/post/');
  assert.equal(opIdFor('mut-1', '0'), 'urn:ex:op/announce/mut-1/0');
  assert.equal(postCreateIntention(ENTRY).opId, 'urn:ex:op/announce/mut-1/0');
});

test('#1629 (C1d) the post.write publication digest is today\'s, and it includes the assigned postSeq and createdAt', () => {
  const w = postWriteIntention(POST);
  assert.deepEqual(Object.keys(w.post), ['id', 'body', 'author', 'createdAt', 'attachedTo', 'mentions', 'postSeq'], 'the intention keeps today\'s fields');
  assert.equal(digest(w), 'a3d3720c019e87bfd9bec593171eb9a7bf8d943a996fa34ef2560101319ddf41', 'today\'s digest, unchanged');
  assert.notEqual(digest(postWriteIntention({ ...POST, postSeq: 43 })), digest(w), 'postSeq is in the publication digest');
  assert.notEqual(digest(postWriteIntention({ ...POST, createdAt: '2026-08-01T00:00:01.000Z' })), digest(w), 'and so is createdAt');
});

test('#1629 (C1e) the post.create publication digest is today\'s, and it includes postSeq and publicationAt', () => {
  const c = postCreateIntention(ENTRY);
  assert.equal(digest(c), 'c715b5647ba871819af3ff8c06ddcb0045b3b01eae30dfad6b0edc57d1d3a6e5', 'today\'s digest, unchanged');
  assert.notEqual(digest(postCreateIntention({ ...ENTRY, postSeq: 43 })), digest(c), 'postSeq is in the publication digest');
  assert.notEqual(digest(postCreateIntention({ ...ENTRY, publicationAt: '2026-08-01T00:01:01.000Z' })), digest(c), 'and so is publicationAt');
});
