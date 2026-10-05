/**
 * #1574 unit 2, gate 11 — the publisher's REAL graph write: a `post.create` intention applied through the executor,
 * verified by receipt, then (and only then) recorded as published. Pre-registered by the separate test author BEFORE
 * the implementation exists. Copy unchanged into tests/ and build to it; if the contract needs a change, the test
 * changes first and the change is announced on #1574. Builds on the frozen C3a and C3b.
 *
 * Uses the REAL executor (graph-executor/executor.py, via tests/helpers/graph-executor-proc.mjs) on a fabricated
 * scratch store. Without a python that has pyoxigraph every test here is SKIPPED, and a skip is NOT a pass.
 *
 * NOT COVERED HERE, BY NAME: reading conversations from the graph (GET /api/conversations still reads the board
 * document, so with the flag ON a published post is invisible there: THE FLAG MUST STAY OFF until read and write
 * move together, a binding cutover rule); ordinary posts, C5 order, C6 redaction, C7 commitSeq DISCOVERY; board-key-only
 * authorization of /publish; C4 notification and its recovery; dead-publisher detection; the done-nudge, wiki and
 * rest/retire emitters; power loss.
 *
 * CONTRACT PINNED HERE
 *   INTENTION  core/announce-outbox.mjs exports the PURE postCreateIntention(entry) -> {kind: 'post.create',
 *              opId: `urn:ex:op/announce/<mutationId>/<slot>`, actor, post: {id, body, author, originActor,
 *              origin: {mutationId, slot}, occurredAt, mentions?}} built ONLY from the stored entry's frozen payload, never
 *              from caller input and never from status/receipt fields. The time is the frozen occurredAt, never "now": two
 *              builds are byte-identical after canonicalisation (same digest). It also carries `publicationAt`: the time the
 *              publisher FIRST attempted this entry, fixed once under the lock, stored on the entry as `publicationAt`, and
 *              reused by every retry (so a retry reproduces the identical intention and is never an intent-collision). And it
 *              carries `postSeq` (below): a positive safe integer, stored on the entry, digest-covered. postCreateIntention THROWS
 *              for an entry with no valid postSeq (absent, 0, negative, fractional, a string, unsafe): it never synthesises one.
 *   POSTSEQ    LOGICAL ORDER ONLY. At the entry's FIRST /publish attempt, under the write lock, in the SAME document write that fixes
 *              `publicationAt`, the server reserves `entry.postSeq = nextPostSeq` and advances the counter by one: the SAME counter the
 *              document posts use, on a board that is `empty` (it mints the epoch and counter) or `migrated`. The lock is then released
 *              BEFORE the executor is contacted. Every retry (a restart, a pending outcome, five simultaneous calls) reuses the stored
 *              postSeq and publicationAt; the counter is never consumed twice for one obligation. An unfinished attempt leaves a
 *              consumed number: gaps are allowed, the sequence is not gap-free. A document post made in between gets a HIGHER number;
 *              a graph post and a document post never share one. Neither field proves VISIBILITY: they mark the first attempt (the
 *              RESERVATION), not successful publication; backoff or an UNKNOWN outcome can separate them from the executor commit,
 *              and a matching APPLIED receipt is what proves the write. Graph DISCOVERY will use the executor's commitSeq, not this.
 *              BOARD STATES at publish time, for PUBLISHER-mode entries only (legacy-mode entries still verify against their document
 *              post and are untouched): `clean` unmigrated (no epoch, no postSeq anywhere) -> the entry stays PENDING with the named
 *              reason POST_SEQ_MIGRATION_REQUIRED in the RESPONSE (as `reason` or `code`), no number reserved, the executor NOT contacted,
 *              the board file BYTE-IDENTICAL; after the stopped-file migration the same entry publishes. `corrupt` -> 500
 *              POST_SEQ_STATE_CORRUPT before any change, the executor not contacted, the file byte-identical.
 *   POST ID    a DETERMINISTIC, UUID-shaped id (several existing surfaces accept only a UUID as a post id): an RFC 4122
 *              version-5 UUID of the name `<mutationId>:<slot>` under the namespace UUID exported as
 *              ANNOUNCE_POST_NAMESPACE, with announcePostId(mutationId, slot) exported beside it. THE NAMESPACE LITERAL IS
 *              PINNED IN THIS FILE (bb9ac420-d837-46bc-984d-6c875b978aee); the export must equal it, the test recomputes the id
 *              independently, and a golden vector is asserted, so a random, merely UUID-looking, or re-namespaced id fails.
 *   NODE       the post is the node <https://scrumboard.local/entity/<postId>> with exactly these triples:
 *                rdf:type            <https://schema.org/Comment>
 *                schema:text         plain literal, the frozen body
 *                schema:author       IRI <https://scrumboard.local/person/board>   (an IRI, NOT a literal)
 *                schema:dateCreated  plain literal, the entry's publicationAt (what every commons poller keys its cursor on)
 *                <https://scrumboard.local/ns#postSeq> the entry's reserved postSeq, an xsd:integer literal (logical order; not discovery)
 *                <https://scrumboard.local/ns#originOccurredAt> literal, the frozen occurredAt (provenance, not position)
 *                <https://scrumboard.local/ns#originMutation>  literal      <https://scrumboard.local/ns#originSlot>  literal
 *                <https://scrumboard.local/ns#originActor>     IRI <https://scrumboard.local/person/<seat>>
 *                <urn:ex:recordedBy> <urn:ex:op/announce/<mutationId>/<slot>>   (the compiler's existing op link)
 *              and nothing else. (Mentions would ride the existing ns#mentionsName; the fixtures have none.)
 *   DATE       THREE THINGS THAT MUST STAY SEPARATE: origin time (the frozen occurredAt, provenance), stable write identity
 *              (the intention, which must be identical on every retry), and discovery order (NOT this file's job). A written
 *              time must be covered by the intention digest, so the time on the node is the entry's `publicationAt`, fixed
 *              once under the lock and reused by every retry; the same value is the flag-OFF document post's createdAt; the
 *              frozen occurredAt rides as origin.occurredAt / ns#originOccurredAt.
 *              ⚠ THIS FILE DOES NOT CLAIM THAT A PUBLISHED POST IS DISCOVERABLE. Every commons poller keys its since-cursor on
 *              createdAt, and ANY timestamp (origin, first attempt, or fresh) can fall behind a client's cursor when a post is
 *              published late, so a delayed post can still be missed. postSeq gives the post a place in the logical order, and
 *              nothing more: finding a late-committed graph post needs the executor's commitSeq and the pollers moved onto it (the
 *              read slice). Until that lands the flag stays OFF.
 *   OUTCOMES   graph-client outcomes map: APPLIED with a matching intention digest -> published; REJECTED/intent-collision ->
 *              blocked; UNKNOWN, UNAVAILABLE or ABSENT -> pending. A published entry records the deterministic postId.
 *   FLAG       env SCRUM_GRAPH_UNIT_CONVERSATIONS=1 with SCRUM_GRAPH_EXECUTOR_URL and SCRUM_GRAPH_DATASET_ID. Legacy-mode
 *              entries are STILL verified against the document and make NO executor write.
 *   BARRIER    env SCRUM_TEST_BARRIER_DIR, fifo `after-executor-apply`: read AFTER the executor call returns and BEFORE the
 *              entry is marked published, with the board's write lock released. And the existing `after-document` (read after a
 *              document write, before any caller is answered): the first write of a publish is the RESERVATION, so holding it there
 *              and killing the server is a crash after the reservation and BEFORE any executor contact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, waitForHttp, makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile, canonicalize, digestOf } from '../core/graph-compiler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX_MOD = process.env.OUTBOX_MODULE || path.join(HERE, '..', 'core', 'announce-outbox.mjs');
// THE NAMESPACE IS PINNED HERE AS A LITERAL, chosen once and never changed: an implementation that exports a different
// constant would derive different ids for the same obligation, and a retry after a deploy would then write a SECOND node.
const NAMESPACE = 'bb9ac420-d837-46bc-984d-6c875b978aee';
let postCreateIntention = null, announcePostId = null, EXPORTED_NAMESPACE = null, modErr = null;
try { ({ postCreateIntention, announcePostId, ANNOUNCE_POST_NAMESPACE: EXPORTED_NAMESPACE } = await import(pathToFileURL(OUTBOX_MOD).href)); } catch (e) { modErr = e; }
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'c3c-test';
const ENTITY = 'https://scrumboard.local/entity/';

// ---- fixtures: an obligation seeded straight into the board file
const T0 = '2026-10-04T12:00:00.000Z';
const T1 = '2026-10-05T07:30:00.000Z';        // a fixed publicationAt for the pure intention tests
const S1 = 57;                                  // a fixed postSeq for the pure intention tests
const payloadOf = (mut, slot, body) => ({ author: 'board', body, mentions: [], notify: true, occurredAt: T0, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: mut, slot });
const entryFor = (mut, mode, extra = {}, slot = 'claim') => ({ obligationId: `${mut}:${slot}`, mutationId: mut, slot, status: 'pending', mode, payload: payloadOf(mut, slot, `claimed ${mut}`), ...extra });
const originFor = (mut, mode, slot = 'claim') => ({ mutationId: mut, slots: [slot], origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', mode });
const seeded = (mut, mode = 'publisher', extra = {}, conversations = []) => makeBoardFixture({
  announcementOutbox: { origins: { [mut]: originFor(mut, mode) }, entries: { [`${mut}:claim`]: entryFor(mut, mode, extra) } }, conversations });
const NS = 'https://scrumboard.local/ns#', SCHEMA = 'https://schema.org/', RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PERSON = 'https://scrumboard.local/person/';
// an INDEPENDENT RFC 4122 version-5 UUID, so the implementation's id is checked against the standard, not against itself
function uuid5(name, namespaceUuid) {
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const idOf = (mut, slot = 'claim') => uuid5(`${mut}:${slot}`, NAMESPACE);
const nodeOf = (mut, slot = 'claim') => `${ENTITY}${idOf(mut, slot)}`;
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const EPOCH = '11111111-2222-4333-8444-555555555555';
// a board whose posts are numbered 1..n, with the epoch and a counter at n+1 (a MIGRATED board)
const numberedPosts = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, body: `doc ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt: T0, postSeq: i + 1 }));
const migratedSeeded = (mut, n = 3, mode = 'publisher', extra = {}) => ({ ...seeded(mut, mode, extra, numberedPosts(n)), postSeqEpoch: EPOCH, nextPostSeq: n + 1 });
const unnumberedPosts = (n) => numberedPosts(n).map(({ postSeq, ...c }) => c);
const docPost = (base, body) => api(base, 'POST', '/api/conversations', { body, author: 'ada' });

async function api(base, method, route, body, { signal } = {}) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(20000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const publish = (base, id, body, opts) => api(base, 'POST', `/api/outbox/${encodeURIComponent(id)}/publish`, body || {}, opts);
const entryOf = async (base, id) => (await api(base, 'GET', '/api/outbox')).body.entries.find((e) => e.obligationId === id);
/** Everything the executor holds about one node, as {predicateIri: [{type, value}]}. */
async function nodeFields(exec, iri) {
  const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  const r = await client.query(`SELECT ?p ?o WHERE { <${iri}> ?p ?o }`);
  assert.equal(r.ok, true, `the executor query must work: ${JSON.stringify(r)}`);
  const out = {};
  for (const b of r.rows) (out[b.p.value] ||= []).push({ type: b.o.type, value: b.o.value, ...(b.o.datatype ? { datatype: b.o.datatype } : {}) });
  return out;
}
async function countNodes(exec, iri) {
  const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  const r = await client.query(`SELECT ?p ?o WHERE { <${iri}> ?p ?o }`);
  return r.ok ? r.rows.length : -1;
}

async function withStack(board, { envExtra = {}, proxyDelayMs = 0 } = {}, body) {
  const store = tmpStore('c3c-store-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  let proxy = null, url = exec.baseUrl;
  // the proxy HOLDS a real /update for proxyDelayMs and says when it ARRIVED, so a test can start its other work only once the
  // executor write is demonstrably in flight (not after a guessed sleep)
  let arrive; const proxyState = { arrivals: 0, arrived: new Promise((r) => { arrive = r; }) };
  if (proxyDelayMs) {
    proxy = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      if (req.method === 'POST' && req.url === '/update') { proxyState.arrivals++; arrive(); await new Promise((r) => setTimeout(r, proxyDelayMs)); }
      // every request header is forwarded except the two the fetch sets itself: the executor REQUIRES x-op-id on a write, and a proxy that drops it
      // turns a healthy publish into a pending one (found when the real build ran this row)
      const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
      const f = await fetch(`${exec.baseUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      res.statusCode = f.status; res.end(await f.text());
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${proxy.address().port}`;
  }
  const s = await startRestServer({ board, env: { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: url, ...envExtra } });
  try { return await body({ s, exec, store, proxyState }); }
  finally { await s.stop(); proxy?.close(); await killExecutor(exec); }
}

// ------------------------------------------------------------------ 1. the intention is pure and frozen
test('I1 the module exports postCreateIntention, announcePostId and the namespace', () => {
  assert.equal(modErr, null, `core/announce-outbox.mjs must import cleanly: ${modErr}`);
  assert.equal(typeof postCreateIntention, 'function'); assert.equal(typeof announcePostId, 'function');
  assert.equal(EXPORTED_NAMESPACE, NAMESPACE, 'the exported namespace must be exactly the pinned literal');
});
test('I1b the post id is a deterministic RFC 4122 version-5 UUID of `<mutationId>:<slot>`, distinct per mutation and per slot', () => {
  const id = announcePostId('m-i', 'claim');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'UUID-shaped, version 5, RFC variant');
  assert.equal(id, uuid5('m-i:claim', NAMESPACE), 'equals an independent v5 computation');
  assert.equal(id, '1d70b74b-456f-528f-af30-5b6a2291e10a', 'equals the pinned golden vector (computed once, outside this file)');
  assert.equal(announcePostId('m-i', 'claim'), id, 'deterministic');
  assert.notEqual(announcePostId('m-i', 'release'), id); assert.notEqual(announcePostId('m-j', 'claim'), id);
});
test('I2 two builds from the same stored entry are byte-identical after canonicalisation, with a deterministic id and the frozen time', () => {
  const e = entryFor('m-i', 'publisher', { publicationAt: T1, postSeq: S1 });
  const a = postCreateIntention(e), b = postCreateIntention(JSON.parse(JSON.stringify(e)));
  assert.equal(a.kind, 'post.create');
  assert.equal(a.opId, 'urn:ex:op/announce/m-i/claim');
  assert.equal(a.post.id, idOf('m-i'));
  assert.equal(a.post.occurredAt, T0, 'the origin time is the frozen occurredAt, not now');
  assert.equal(a.post.publicationAt, T1, 'the publication time is the entry\'s stored publicationAt, not now');
  assert.equal(a.post.postSeq, S1, 'the sequence is the entry\'s stored postSeq');
  assert.equal(a.post.body, 'claimed m-i'); assert.equal(a.post.author, 'board'); assert.equal(a.post.originActor, 'ada');
  assert.deepEqual([a.post.origin.mutationId, a.post.origin.slot], ['m-i', 'claim']);
  assert.doesNotThrow(() => compile(a), 'the compiler must accept the new intention kind');
  assert.equal(digestOf(canonicalize(a)), digestOf(canonicalize(b)), 'a retry reproduces the identical intention');
  assert.deepEqual(canonicalize(a), canonicalize(b));
});
test('I3 the intention is built ONLY from the frozen payload: status, receipt, postId and publication fields do not change it, and the body does', () => {
  const base = entryFor('m-i', 'publisher', { publicationAt: T1, postSeq: S1 });
  const d0 = digestOf(canonicalize(postCreateIntention(base)));
  for (const extra of [{ status: 'published', postId: 'whatever', publishedAt: '2030-01-01T00:00:00.000Z', receipt: 'executor' }, { reason: 'x', blockedAt: '2030-01-01T00:00:00.000Z' }, { legacyPostId: 'p', status: 'blocked' }]) {
    assert.equal(digestOf(canonicalize(postCreateIntention({ ...base, ...extra }))), d0, JSON.stringify(extra));
  }
  const changed = { ...base, payload: { ...base.payload, body: 'a different body' } };
  assert.notEqual(digestOf(canonicalize(postCreateIntention(changed))), d0, 'the digest must be sensitive to the frozen content');
  assert.notEqual(digestOf(canonicalize(postCreateIntention({ ...base, publicationAt: '2031-01-01T00:00:00.000Z' }))), d0, 'and to the publication time once it is fixed');
  assert.notEqual(digestOf(canonicalize(postCreateIntention({ ...base, postSeq: S1 + 1 }))), d0, 'and to the reserved postSeq: it is covered by the digest');
});

test('I4 an entry with no valid postSeq, or no publicationAt, has no intention: absent, zero, negative, fractional, a string and an unsafe integer all THROW (neither a number nor a time is ever synthesised)', () => {
  const base = entryFor('m-i', 'publisher', { publicationAt: T1 });
  assert.throws(() => postCreateIntention(base), 'no postSeq at all');
  assert.throws(() => postCreateIntention(entryFor('m-i', 'publisher', { postSeq: S1 })), 'no publicationAt: the time is never synthesised either');
  assert.throws(() => postCreateIntention(entryFor('m-i', 'publisher')), 'neither stored field');
  for (const bad of [0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 2, NaN]) assert.throws(() => postCreateIntention({ ...base, postSeq: bad }), `postSeq ${String(bad)}`);
  assert.doesNotThrow(() => postCreateIntention({ ...base, postSeq: 1 })); assert.doesNotThrow(() => postCreateIntention({ ...base, postSeq: Number.MAX_SAFE_INTEGER }));
});

// ------------------------------------------------------------------ 2. the real write, end to end
test('G1 publishing a publisher-mode entry writes ONE node with exactly its frozen fields, and only then marks it published', { skip: SKIP }, async () => {
  await withStack(seeded('m-g'), {}, async ({ s, exec }) => {
    assert.equal(await countNodes(exec, nodeOf('m-g')), 0, 'precondition: nothing in the graph yet');
    const t0 = Date.now();
    const r = await publish(s.baseUrl, 'm-g:claim');
    const t1 = Date.now();
    assert.equal(r.status, 200, r.text); assert.equal(r.body.status, 'published', r.text);
    assert.equal(r.body.postId, idOf('m-g'));
    const e = await entryOf(s.baseUrl, 'm-g:claim');
    assert.ok(Date.parse(e.publicationAt) >= t0 - 1000 && Date.parse(e.publicationAt) <= t1 + 1000, `publicationAt is the time of this publish, not the frozen time: ${e.publicationAt}`);
    const f = await nodeFields(exec, nodeOf('m-g'));
    assert.deepEqual(Object.keys(f).sort(), [RDF_TYPE, `${SCHEMA}author`, `${SCHEMA}dateCreated`, `${SCHEMA}text`, `${NS}originActor`, `${NS}originMutation`, `${NS}originOccurredAt`, `${NS}originSlot`, `${NS}postSeq`, 'urn:ex:recordedBy'].sort(), `the node carries exactly these triples: ${JSON.stringify(f)}`);
    assert.deepEqual(f[RDF_TYPE].map((o) => o.value), [`${SCHEMA}Comment`]);
    assert.deepEqual(f[`${SCHEMA}text`], [{ type: 'literal', value: 'claimed m-g' }]);
    assert.deepEqual(f[`${SCHEMA}author`], [{ type: 'uri', value: `${PERSON}board` }], 'the author is an IRI, not a literal');
    assert.deepEqual(f[`${SCHEMA}dateCreated`].map((o) => [o.type, o.value]), [['literal', e.publicationAt]], 'dateCreated is the entry\'s publicationAt, a plain literal');
    assert.deepEqual(f[`${NS}originOccurredAt`], [{ type: 'literal', value: T0 }], 'the frozen occurredAt rides as provenance');
    assert.deepEqual(f[`${NS}originMutation`], [{ type: 'literal', value: 'm-g' }]);
    assert.deepEqual(f[`${NS}originSlot`], [{ type: 'literal', value: 'claim' }]);
    assert.deepEqual(f[`${NS}originActor`], [{ type: 'uri', value: `${PERSON}ada` }], 'the origin actor is an IRI');
    assert.deepEqual(f['urn:ex:recordedBy'].map((o) => o.value), ['urn:ex:op/announce/m-g/claim'], 'the compiler\'s own op link');
    assert.equal(e.status, 'published'); assert.equal(e.postId, idOf('m-g'));
    assert.equal(e.postSeq, 1, 'an EMPTY board: the first reservation mints the epoch and counter and takes 1');
    assert.deepEqual(f[`${NS}postSeq`], [{ type: 'literal', value: '1', datatype: XSD_INT }], 'the node carries the reserved postSeq as an xsd:integer');
    assert.equal((await docPost(s.baseUrl, 'after the graph post')).body.postSeq, 2, 'the document counter was advanced exactly once, by the reservation');
  });
});

test('G2 a repeat, and five simultaneous calls, leave exactly ONE node and the same published postId', { skip: SKIP }, async () => {
  await withStack(seeded('m-g'), {}, async ({ s, exec }) => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => publish(s.baseUrl, 'm-g:claim')));
    for (const r of rs) assert.equal(r.body.status, 'published', r.text);
    assert.equal(new Set(rs.map((r) => r.body.postId)).size, 1);
    const once = await nodeFields(exec, nodeOf('m-g'));
    assert.deepEqual(once[`${SCHEMA}text`].map((o) => o.value), ['claimed m-g'], 'one text value: no second node and no second write');
    const again = await publish(s.baseUrl, 'm-g:claim');
    assert.equal(again.body.postId, rs[0].body.postId);
    assert.deepEqual(await nodeFields(exec, nodeOf('m-g')), once, 'a repeat changed nothing in the graph');
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
    const stored = await entryOf(s.baseUrl, 'm-g:claim');
    assert.equal(stored.postSeq, 1, 'ONE reservation for five simultaneous calls and a repeat');
    assert.equal((await docPost(s.baseUrl, 'next')).body.postSeq, 2, 'the counter was consumed exactly once for this obligation, not once per call');
    const rec = await client.reconcile(postCreateIntention({ ...entryFor('m-g', 'publisher'), publicationAt: stored.publicationAt, postSeq: stored.postSeq }));
    assert.equal(rec.outcome, 'APPLIED', 'the executor holds an APPLIED receipt for exactly this intention');
  });
});

test('G3 a pre-planted opId with DIFFERENT content is blocked, never published, and the planted node is untouched', { skip: SKIP }, async () => {
  await withStack(seeded('m-g'), {}, async ({ s, exec }) => {
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
    const planted = postCreateIntention({ ...entryFor('m-g', 'publisher', { publicationAt: T1, postSeq: S1 }), payload: payloadOf('m-g', 'claim', 'planted, not what the obligation says') });
    assert.equal((await client.update(planted)).outcome, 'APPLIED', 'precondition: the plant is applied');
    const before = await nodeFields(exec, nodeOf('m-g'));
    const r = await publish(s.baseUrl, 'm-g:claim');
    assert.equal(r.body.status, 'blocked', r.text);
    const e = await entryOf(s.baseUrl, 'm-g:claim');
    assert.equal(e.status, 'blocked'); assert.notEqual(e.status, 'published');
    assert.deepEqual(await nodeFields(exec, nodeOf('m-g')), before, 'the graph was not overwritten');
    assert.deepEqual(before[`${SCHEMA}text`].map((o) => o.value), ['planted, not what the obligation says']);
  });
});

test('G4 an executor that is DOWN leaves the entry pending (never blocked, never published), and the SAME entry publishes once the executor is back', { skip: SKIP }, async () => {
  await withStack(seeded('m-g'), {}, async ({ s, exec, store }) => {
    const port = exec.port;
    await killExecutor(exec);
    const r = await publish(s.baseUrl, 'm-g:claim');
    assert.ok(r.status < 500, r.text);
    assert.equal(r.body.status, 'pending', r.text);
    const e = await entryOf(s.baseUrl, 'm-g:claim');
    assert.equal(e.status, 'pending'); assert.equal(e.postId, undefined);
    assert.equal(typeof e.publicationAt, 'string', 'the publication time is fixed at the FIRST attempt, even one that did not complete');
    assert.equal(e.postSeq, 1, 'and so is the postSeq: reserved at the first attempt, though nothing reached the graph');
    const back = await startExecutor({ store, datasetId: DSID, create: false, port });       // the same store, the same port
    try {
      const again = await publish(s.baseUrl, 'm-g:claim');
      assert.equal(again.body.status, 'published', `pending is not a terminal state: ${again.text}`);
      assert.deepEqual((await nodeFields(back, nodeOf('m-g')))[`${SCHEMA}text`].map((o) => o.value), ['claimed m-g'], 'exactly one node, written after recovery');
      const after = await entryOf(s.baseUrl, 'm-g:claim');
      assert.equal(after.publicationAt, e.publicationAt, 'the retry REUSED the stored publication time');
      assert.equal(after.postSeq, e.postSeq, 'and the stored postSeq');
      assert.deepEqual((await nodeFields(back, nodeOf('m-g')))[`${NS}postSeq`].map((o) => o.value), [String(e.postSeq)], 'the node carries the RESERVED number');
      assert.deepEqual((await nodeFields(back, nodeOf('m-g')))[`${SCHEMA}dateCreated`].map((o) => o.value), [e.publicationAt]);
    } finally { await killExecutor(back); }
  });
});

test('G5 caller input never reaches the node: a body, author and postId in the request are ignored', { skip: SKIP }, async () => {
  await withStack(seeded('m-g'), {}, async ({ s, exec }) => {
    const r = await publish(s.baseUrl, 'm-g:claim', { body: 'EVIL', author: 'mallory', postId: 'chosen-by-caller', occurredAt: '2031-01-01T00:00:00Z', origin: { mutationId: 'x', slot: 'y' }, postSeq: 999, publicationAt: '2031-01-01T00:00:00Z' });
    assert.equal(r.body.status, 'published', r.text);
    assert.equal(r.body.postId, idOf('m-g'));
    assert.equal((await entryOf(s.baseUrl, 'm-g:claim')).postSeq, 1, 'a caller-supplied postSeq is ignored: the server reserves it');
    assert.deepEqual((await nodeFields(exec, nodeOf('m-g')))[`${NS}postSeq`].map((o) => o.value), ['1']);
    const f = await nodeFields(exec, nodeOf('m-g'));
    assert.deepEqual([f[`${SCHEMA}text`].map((o) => o.value), f[`${SCHEMA}author`].map((o) => o.value), f[`${NS}originMutation`].map((o) => o.value)], [['claimed m-g'], [`${PERSON}board`], ['m-g']]);
    assert.equal(await countNodes(exec, `${ENTITY}chosen-by-caller`), 0);
    assert.ok(!(f[`${SCHEMA}dateCreated`] || []).some((o) => o.value.startsWith('2031')), 'a caller-supplied time never reaches the node');
    assert.deepEqual(f[`${NS}originOccurredAt`].map((o) => o.value), [T0]);
  });
});

test('G7 frozen MENTIONS are part of the node: the same set under ns#mentionsName, and they are part of the digest', { skip: SKIP }, async () => {
  const mentions = ['bea', 'cy'];
  const withMentions = { payload: { ...payloadOf('m-g', 'claim', 'claimed m-g'), mentions } };
  // the PURE calls need the two stored fields the server would have reserved (an entry without them has no intention: I4)
  const reserved = { publicationAt: T1, postSeq: S1 };
  const e = entryFor('m-g', 'publisher', { ...withMentions, ...reserved });
  assert.notEqual(digestOf(canonicalize(postCreateIntention(e))), digestOf(canonicalize(postCreateIntention(entryFor('m-g', 'publisher', reserved)))), 'dropping the mentions must change the intention');
  assert.deepEqual([...(postCreateIntention(e).post.mentions || [])].sort(), mentions);
  await withStack(seeded('m-g', 'publisher', withMentions), {}, async ({ s, exec }) => {
    const r = await publish(s.baseUrl, 'm-g:claim');
    assert.equal(r.body.status, 'published', r.text);
    const f = await nodeFields(exec, nodeOf('m-g'));
    assert.deepEqual((f[`${NS}mentionsName`] || []).map((o) => o.value).sort(), mentions, 'compared as a SET: the node does not keep order');
    assert.equal(f[`${NS}mentionsName`].every((o) => o.type === 'literal'), true);
  });
});

test('G6 a LEGACY-mode entry is still verified against the document and makes NO executor write, flag on', { skip: SKIP }, async () => {
  const post = { id: 'p1', body: 'claimed m-l', author: 'board', attachedTo: null, attachments: [], mentions: [], createdAt: T0, origin: { mutationId: 'm-l', slot: 'claim' } };
  await withStack(seeded('m-l', 'legacy', { legacyPostId: 'p1' }, [post]), {}, async ({ s, exec }) => {
    const r = await publish(s.baseUrl, 'm-l:claim');
    assert.equal(r.body.status, 'published', r.text);
    assert.equal((await entryOf(s.baseUrl, 'm-l:claim')).receipt, 'legacy');
    assert.equal(await countNodes(exec, nodeOf('m-l')), 0, 'nothing was written to the graph for a legacy entry');
  });
});

// ------------------------------------------------------------------ 2b. one rule for the date, flag off and flag on
test('D1 flag OFF: the document post carries the entry\'s publicationAt as its createdAt (one rule for both paths) and the frozen occurredAt as origin.occurredAt; this does NOT show it is discoverable', async () => {
  const s = await startRestServer({ board: seeded('m-d') });
  try {
    const t0 = Date.now();
    const r = await publish(s.baseUrl, 'm-d:claim');
    const t1 = Date.now();
    assert.equal(r.body.status, 'published', r.text);
    const e = await entryOf(s.baseUrl, 'm-d:claim');
    const b = (await api(s.baseUrl, 'GET', '/api/conversations?attachedTo=null')).body;
    const posts = (Array.isArray(b) ? b : (b?.conversations ?? b?.items ?? [])).filter((c) => c.author === 'board');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].createdAt, e.publicationAt, 'one rule for both paths: createdAt is the entry\'s publicationAt');
    assert.ok(Date.parse(posts[0].createdAt) >= t0 - 1000 && Date.parse(posts[0].createdAt) <= t1 + 1000, `createdAt is the time of this publish, not the frozen origin time: ${posts[0].createdAt}`);
    assert.equal(posts[0].origin?.occurredAt, T0, 'the frozen origin time rides as provenance');
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ 3. the lock is free during a REAL, slow call
test('H3 while a REAL executor write is demonstrably held, a create, claim, save and read complete in seconds, the write is still outstanding after them, and the publish then finishes published', { skip: SKIP }, async () => {
  await withStack(seeded('m-g'), { proxyDelayMs: 4500 }, async ({ s, exec, proxyState }) => {
    let settled = false;
    const pending = publish(s.baseUrl, 'm-g:claim').then((r) => { settled = true; return r; });
    const arrived = await Promise.race([proxyState.arrived.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    assert.equal(arrived, true, 'the real /update NEVER reached the executor: the publish did not attempt the post write, so nothing here proves isolation');
    assert.equal(settled, false, 'the publish must be waiting on the held write');
    const t = async (label, fn) => { const t1 = Date.now(); const r = await fn(); const ms = Date.now() - t1; assert.ok(ms < 2500, `${label} took ${ms} ms while the executor write was held`); return r; };
    const card = await t('create', () => api(s.baseUrl, 'POST', '/api/cards', { title: 'during', description: 'x', createdBy: 'ada' }));
    assert.ok(card.status < 400, card.text);
    assert.equal((await t('claim', () => api(s.baseUrl, 'POST', `/api/cards/${card.body.id}/claim`, { by: 'ada' }))).status, 200);
    const snap = (await t('read', () => api(s.baseUrl, 'GET', '/api/board'))).body;
    assert.ok((await t('save', () => api(s.baseUrl, 'POST', '/api/save', { cards: snap.cards.map((c) => (c.id === card.body.id ? { ...c, title: 'saved during' } : c)), columns: snap.columns, nextShortId: snap.nextShortId }))).status < 400);
    assert.equal(settled, false, 'the executor write was STILL held after those operations: the isolation was real');
    const r = await pending;
    assert.equal(r.body.status, 'published', r.text);
    assert.deepEqual((await nodeFields(exec, nodeOf('m-g')))[`${SCHEMA}text`].map((o) => o.value), ['claimed m-g']);
  });
});

// ------------------------------------------------------------------ 4. crash after the executor applied, before recording
async function spawnServer(boardFile, barrierDir, execUrl) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'c3c-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `c3c-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `c3c-${port}`, SCRUM_TEST_BARRIER_DIR: barrierDir,
    SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { child, base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}

test('X4 a crash AFTER the executor applied and BEFORE the entry is marked published: after restart a repeat is published, with ONE node and the same postId', { skip: SKIP }, async () => {
  const exec = await startExecutor({ store: tmpStore('c3c-store-'), datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3c-crash-'));
  const boardFile = path.join(dir, 'board.json'); fs.writeFileSync(boardFile, JSON.stringify(seeded('m-g'), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  let a, b;
  try {
    a = await spawnServer(boardFile, barrierDir, exec.baseUrl);
    const fifo = path.join(barrierDir, 'after-executor-apply');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const inflight = publish(a.base, 'm-g:claim').then((r) => ({ status: r.status }), (e) => ({ reset: String(e?.message || e) }));
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), new Promise((r) => setTimeout(() => r(false), 12000))]);
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    a.stop();
    const seen = await Promise.race([inflight, new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))]);
    try { await fh?.close(); } catch { /* ignore */ }
    fs.rmSync(fifo, { force: true });
    assert.equal(reached, true, `the server never reached the after-executor-apply barrier: ${a.stderr().slice(-300)}`);
    assert.ok(seen.reset !== undefined || seen.timeout || seen.status >= 500, `the client must not be told it succeeded: ${JSON.stringify(seen)}`);
    const mid = await nodeFields(exec, nodeOf('m-g'));
    assert.deepEqual(mid[`${SCHEMA}text`].map((o) => o.value), ['claimed m-g'], 'the executor DID apply before the crash: the node exists');
    b = await spawnServer(boardFile, barrierDir, exec.baseUrl);
    const pre = await entryOf(b.base, 'm-g:claim');
    assert.equal(pre.status, 'pending', 'the document never recorded it: still pending after restart');
    const r = await publish(b.base, 'm-g:claim');
    assert.equal(r.body.status, 'published', r.text);
    assert.equal(r.body.postId, idOf('m-g'), 'the same deterministic post id');
    assert.deepEqual(await nodeFields(exec, nodeOf('m-g')), mid, 'no second write: the graph is exactly as the first attempt left it');
    assert.equal((await entryOf(b.base, 'm-g:claim')).publicationAt, mid[`${SCHEMA}dateCreated`][0].value, 'the retry published under the SAME time the first attempt used');
    assert.deepEqual([String((await entryOf(b.base, 'm-g:claim')).postSeq)], mid[`${NS}postSeq`].map((o) => o.value), 'and the SAME postSeq');
  } finally { a?.stop(); b?.stop(); await killExecutor(exec); }
});


// ------------------------------------------------------------------ 5. the reservation: one counter, two paths
/** A board file + barrier dir + real executor, with a server that can be started, killed and restarted on the same file. */
async function fileStack(board, body) {
  const exec = await startExecutor({ store: tmpStore('c3c-store-'), datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3c-file-'));
  const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(board, null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  const servers = [];
  const start = async () => { const x = await spawnServer(file, barrierDir, exec.baseUrl); servers.push(x); return x; };
  try { return await body({ file, barrierDir, exec, start }); } finally { for (const x of servers) x.stop(); await killExecutor(exec); }
}
const twoEntries = (n) => {
  const a = seeded('m-a', 'publisher', {}, numberedPosts(n)), b = seeded('m-b', 'publisher', {}, numberedPosts(n));
  return { ...a, postSeqEpoch: EPOCH, nextPostSeq: n + 1, announcementOutbox: { origins: { ...a.announcementOutbox.origins, ...b.announcementOutbox.origins }, entries: { ...a.announcementOutbox.entries, ...b.announcementOutbox.entries } } };
};

test('G8 ONE counter for two paths: a graph post takes the next number, a document post after it takes the one after, a second graph post the one after that, and no number is shared', { skip: SKIP }, async () => {
  await withStack(twoEntries(3), {}, async ({ s, exec }) => {
    assert.equal((await publish(s.baseUrl, 'm-a:claim')).body.status, 'published');
    const ea = await entryOf(s.baseUrl, 'm-a:claim');
    assert.equal(ea.postSeq, 4, 'the board is migrated (1..3, counter 4): the first reservation is 4');
    const dp = await docPost(s.baseUrl, 'a document post between the two graph posts');
    assert.equal(dp.body.postSeq, 5, 'a document post made after the reservation never shares its number');
    assert.equal((await publish(s.baseUrl, 'm-b:claim')).body.status, 'published');
    const eb = await entryOf(s.baseUrl, 'm-b:claim');
    assert.equal(eb.postSeq, 6, 'and the next graph post is higher again');
    assert.deepEqual((await nodeFields(exec, nodeOf('m-a')))[`${NS}postSeq`].map((o) => o.value), ['4']);
    assert.deepEqual((await nodeFields(exec, nodeOf('m-b')))[`${NS}postSeq`].map((o) => o.value), ['6']);
    assert.equal(new Set([ea.postSeq, dp.body.postSeq, eb.postSeq]).size, 3);
  });
});

test('G9 the reservation SURVIVES an unfinished attempt: executor down, a document post lands meanwhile and gets a HIGHER number, then the same obligation publishes under its RESERVED number and digest, and the counter was consumed once', { skip: SKIP }, async () => {
  await withStack(migratedSeeded('m-g', 3), {}, async ({ s, exec, store }) => {
    const port = exec.port;
    await killExecutor(exec);
    assert.equal((await publish(s.baseUrl, 'm-g:claim')).body.status, 'pending');
    const first = await entryOf(s.baseUrl, 'm-g:claim');
    assert.equal(first.postSeq, 4, 'reserved at the first attempt although nothing reached the graph');
    const between = await docPost(s.baseUrl, 'posted while the graph write was pending');
    assert.equal(between.body.postSeq, 5, 'an intervening document post gets a HIGHER number');
    assert.equal((await publish(s.baseUrl, 'm-g:claim')).body.status, 'pending', 'still down: a second attempt');
    assert.equal((await entryOf(s.baseUrl, 'm-g:claim')).postSeq, 4, 'the retry did not reserve again');
    const back = await startExecutor({ store, datasetId: DSID, create: false, port });
    try {
      assert.equal((await publish(s.baseUrl, 'm-g:claim')).body.status, 'published');
      const done = await entryOf(s.baseUrl, 'm-g:claim');
      assert.deepEqual([done.postSeq, done.publicationAt], [first.postSeq, first.publicationAt], 'the stored reservation was reused unchanged');
      assert.deepEqual((await nodeFields(back, nodeOf('m-g')))[`${NS}postSeq`].map((o) => o.value), ['4'], 'the node carries the RESERVED number, lower than the post that landed in between');
      const client = createGraphClient({ baseUrl: back.baseUrl, expectedDatasetId: DSID });
      const rec = await client.reconcile(postCreateIntention({ ...entryFor('m-g', 'publisher'), publicationAt: first.publicationAt, postSeq: first.postSeq }));
      assert.equal(rec.outcome, 'APPLIED', 'the executor holds an APPLIED receipt for exactly the reserved intention (same digest)');
      assert.equal((await docPost(s.baseUrl, 'after')).body.postSeq, 6, 'the counter was consumed ONCE for this obligation: the next post is 6, not 7 or 8');
    } finally { await killExecutor(back); }
  });
});

test('X5 a crash AFTER the reservation and BEFORE any executor contact: after restart the same obligation keeps its number and time, a document post made meanwhile got a higher number, and the publish then writes ONE node under the reserved number', { skip: SKIP }, async () => {
  await fileStack(migratedSeeded('m-g', 3), async ({ file, barrierDir, exec, start }) => {
    let a = await start();
    const fifo = path.join(barrierDir, 'after-document');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const inflight = publish(a.base, 'm-g:claim').then((r) => ({ status: r.status }), (e) => ({ reset: String(e?.message || e) }));
    let fh = null;
    const reached = await Promise.race([fsp.open(fifo, 'w').then((h) => { fh = h; return true; }), new Promise((r) => setTimeout(() => r(false), 12000))]);
    if (!reached) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ } }
    a.stop();
    await Promise.race([inflight, new Promise((r) => setTimeout(r, 4000))]);
    try { await fh?.close(); } catch { /* ignore */ }
    fs.rmSync(fifo, { force: true });
    assert.equal(reached, true, `the server never reached the after-document barrier on the reservation write: ${a.stderr().slice(-300)}`);
    assert.equal(await countNodes(exec, nodeOf('m-g')), 0, 'the executor was never contacted: nothing in the graph');
    const b = await start();
    const kept = await entryOf(b.base, 'm-g:claim');
    assert.equal(kept.status, 'pending'); assert.equal(kept.postSeq, 4, 'the reservation was committed before the crash and survives it');
    assert.equal(typeof kept.publicationAt, 'string');
    const between = await docPost(b.base, 'posted after the crash');
    assert.equal(between.body.postSeq, 5, 'a post made after the restart gets a higher number than the reservation');
    const r = await publish(b.base, 'm-g:claim');
    assert.equal(r.body.status, 'published', r.text);
    const done = await entryOf(b.base, 'm-g:claim');
    assert.deepEqual([done.postSeq, done.publicationAt], [4, kept.publicationAt], 'the same number and time');
    const f = await nodeFields(exec, nodeOf('m-g'));
    assert.deepEqual(f[`${NS}postSeq`].map((o) => o.value), ['4']); assert.deepEqual(f[`${SCHEMA}dateCreated`].map((o) => o.value), [kept.publicationAt]);
    assert.deepEqual(f[`${SCHEMA}text`].map((o) => o.value), ['claimed m-g'], 'exactly one node');
  });
});

test('G10 a CLEAN unmigrated board: a publisher-mode entry stays PENDING with POST_SEQ_MIGRATION_REQUIRED in the response, no number reserved, the executor never contacted and the board file byte-identical; after the stopped-file migration the same entry publishes with the next number', { skip: SKIP }, async () => {
  await fileStack(seeded('m-g', 'publisher', {}, unnumberedPosts(3)), async ({ file, exec, start }) => {
    let a = await start();
    const settled = fs.readFileSync(file);
    const r = await publish(a.base, 'm-g:claim');
    assert.ok(r.status < 500, r.text);
    assert.equal(r.body.status, 'pending', r.text);
    assert.ok(r.body.reason === 'POST_SEQ_MIGRATION_REQUIRED' || r.body.code === 'POST_SEQ_MIGRATION_REQUIRED', `the named reason must be in the response (as reason or code): ${r.text}`);
    assert.equal(await countNodes(exec, nodeOf('m-g')), 0, 'the executor was never contacted');
    assert.deepEqual(fs.readFileSync(file), settled, 'the reason is RESPONSE-ONLY: nothing was written (no reservation, no publicationAt, no counter)');
    const e = await entryOf(a.base, 'm-g:claim');
    assert.equal(e.postSeq, undefined); assert.equal(e.publicationAt, undefined);
    a.stop();
    const mig = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'migrate-post-seq-1592.mjs'), '--board-file', file], { encoding: 'utf8', cwd: PROJECT_DIR });
    assert.equal(mig.status, 0, `${mig.stdout}${mig.stderr}`);
    const b = await start();
    const r2 = await publish(b.base, 'm-g:claim');
    assert.equal(r2.body.status, 'published', r2.text);
    assert.equal((await entryOf(b.base, 'm-g:claim')).postSeq, 4, 'three posts were numbered 1..3 by the migration: the reservation is 4');
    assert.deepEqual((await nodeFields(exec, nodeOf('m-g')))[`${NS}postSeq`].map((o) => o.value), ['4']);
  });
});

test('G11 a CORRUPT board refuses a publisher-mode publish: 500 POST_SEQ_STATE_CORRUPT, the executor never contacted, the file byte-identical, the entry still pending', { skip: SKIP }, async () => {
  const mixed = { ...seeded('m-g', 'publisher', {}, [{ ...numberedPosts(3)[0] }, ...unnumberedPosts(3).slice(1)]) };   // one post numbered, the rest not, no epoch
  await fileStack(mixed, async ({ file, exec, start }) => {
    const a = await start();
    const settled = fs.readFileSync(file);
    const r = await publish(a.base, 'm-g:claim');
    assert.equal(r.status, 500, r.text); assert.equal(r.body?.code, 'POST_SEQ_STATE_CORRUPT');
    assert.equal(await countNodes(exec, nodeOf('m-g')), 0, 'the executor was never contacted');
    assert.deepEqual(fs.readFileSync(file), settled, 'nothing was written');
    assert.equal((await entryOf(a.base, 'm-g:claim')).status, 'pending');
  });
});
