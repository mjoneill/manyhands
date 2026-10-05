/**
 * #1574 C3c ADDENDUM — two rows the frozen C3c file (sha256 96cd29ec…cf33) does not contain, found by the independent mutation run on 5c0ff43.
 * Copy beside the frozen file in tests/; the frozen file is untouched.
 *
 *   E1 AN UPGRADE-PATH ENTRY: a pending entry that already carries a `publicationAt` but no `postSeq` (fixed by the earlier build at its first
 *      attempt, before reservations existed). The reservation adds the postSeq and KEEPS that publicationAt: it is never re-fixed ("every retry
 *      reuses publicationAt"). Mutant C4 (re-fix publicationAt whenever a reservation is made) survived every frozen row, because no frozen
 *      fixture has an entry in this state.
 *   E2 ONE DATE RULE ON THE FLAG-OFF PATH, WITH A DATE FIXED EARLIER: the document post's createdAt is the entry's STORED publicationAt, not the
 *      moment of this write. The frozen D1 seeds an entry with no publicationAt, so the stored value and "now" coincide to the millisecond and the
 *      row cannot tell them apart (mutant C16, createdAt = creation time, survived). The state arises for real after a flag-ON attempt fixed the
 *      time and the flag was then turned OFF.
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


const T_FIXED = '2026-10-04T18:15:00.000Z';      // a time in the past: it cannot be mistaken for "now"
test('E1 a pending entry that already has a publicationAt but no postSeq KEEPS that publicationAt when the reservation adds the postSeq (it is never re-fixed): the node carries the kept time and the reserved number', { skip: SKIP }, async () => {
  await withStack(seeded('m-u', 'publisher', { publicationAt: T_FIXED }), {}, async ({ s, exec }) => {
    const r = await publish(s.baseUrl, 'm-u:claim');
    assert.equal(r.body.status, 'published', r.text);
    const e = await entryOf(s.baseUrl, 'm-u:claim');
    assert.equal(e.publicationAt, T_FIXED, 'the stored publicationAt was kept, not replaced by this attempt\'s time');
    assert.equal(e.postSeq, 1, 'the empty board\'s first reservation');
    const f = await nodeFields(exec, nodeOf('m-u'));
    assert.deepEqual(f[`${SCHEMA}dateCreated`].map((o) => o.value), [T_FIXED]);
    assert.deepEqual(f[`${NS}postSeq`].map((o) => o.value), ['1']);
  });
});
test('E2 flag OFF: the document post\'s createdAt is the entry\'s STORED publicationAt (a time fixed earlier), not the moment of this write', async () => {
  const s = await startRestServer({ board: seeded('m-d', 'publisher', { publicationAt: T_FIXED }) });
  try {
    const r = await publish(s.baseUrl, 'm-d:claim');
    assert.equal(r.body.status, 'published', r.text);
    const b = (await api(s.baseUrl, 'GET', '/api/conversations')).body;
    const posts = (Array.isArray(b) ? b : (b?.conversations ?? [])).filter((c) => c.author === 'board');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].createdAt, T_FIXED, `createdAt must be the stored publicationAt, not the time of this write: ${posts[0].createdAt}`);
    assert.equal((await entryOf(s.baseUrl, 'm-d:claim')).publicationAt, T_FIXED, 'and the entry keeps it');
    assert.equal(posts[0].origin?.occurredAt, T0, 'the frozen origin time still rides as provenance');
  } finally { await s.stop(); }
});
