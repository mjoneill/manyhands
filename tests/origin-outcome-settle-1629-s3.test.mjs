/**
 * #1629 slice 3 — OUTCOME (R-A1) and SETTLEMENT (obligation.settle) rows, written before the build against draft r3 (#1629 v152:
 * C1, C2, C3, §4), whose settlement sequence and outcome states were accepted for row authoring (non-builder review 45026). TEST
 * AUTHOR's. Executor-level: a real executor, the slice-2 primitive as landed for prepare/commit, and the build's NEW read and record kind.
 *
 * NAMES THE BUILDER MAY CHANGE, IN ONE PLACE EACH (below, "the builder's names"): the outcome read's export and its state strings;
 * the settle record kind, its transition field and its opId shape; the block reason set. Rows assert BEHAVIOUR through those names.
 *
 * OUTCOME, a pure read keyed by mutationId (r2 R-A1 as corrected by r3 C1):
 *   O1  committed: prepare + commit APPLIED → `committed`
 *   O2  UNKNOWN THAT COMMITTED: the commit is APPLIED in the executor but the caller's response is LOST (a proxy that forwards the
 *       update and destroys the socket before answering); the caller saw no outcome; the read says `committed`
 *   O3  refused: the card moved, the commit came back PRECONDITION_FAILED → `refused`
 *   O4  UNRESOLVED (C1): Prepared, no link, no receipt → `unresolved`, and never a word meaning "never applied"
 *   O5  unavailable: the executor is down → the read says unavailable/unknown, never a guessed state
 *   O6  PURE: reading every outcome above changes neither the bookkeeping graph nor commitSeq
 * SETTLEMENT, one guarded update keyed by obligationId whose proof the executor reads itself (r2 §4 with r3 C2: publish only after
 * dispatch, one transition):
 *   S0  CONTROL (runs on today's code): a committed origin's reserved post can be created with post.create from the reservation
 *       (APPLIED, at the derived postId and reserved postSeq), so S1's proof exists to be read
 *   S1  publish: with the post.create receipt APPLIED for the deterministic op, settle publish → APPLIED, the obligation reads published
 *   S2  publish with NO post receipt → PRECONDITION_FAILED, the obligation stays pending, nothing changed
 *   S3  publish when the deterministic op was written with a DIFFERENT body (receipt APPLIED, digest not the frozen payload's) →
 *       PRECONDITION_FAILED: post existence and an APPLIED receipt alone never satisfy the proof
 *   S4  replay: the same settle publish again → APPLIED, nothing changes, commitSeq unchanged
 *   S5  terminal: after published, settle block → PRECONDITION_FAILED, status stays published (never overwritten)
 *   S6  block(tombstoned): the deterministic post exists and is redacted → APPLIED, the obligation reads blocked
 *   S7  block(tombstoned) with no tombstone → PRECONDITION_FAILED; block with a reason outside the closed set is refused before sending
 *
 * Every row except S0 is TODO until the build lands the outcome read and the settle kind (today the read is not exported and the
 * kind is not in RECORD_KINDS). Each is reported on every run and never fails CI; then delete PENDING_BUILD and each must pass.
 *
 * NOT covered, by name: the REST diagnostic route and /api/outbox's exclusion of Prepared records (C3; REST-level, owed with the
 * wiring); RECONCILE_REQUIRED after a restore (B1, out of scope); the publisher's dispatch ordering (row L4a/L4b at REST); the
 * complete endpoint refusing a caller-supplied APPLIED; legacy-proof-missing (M1, out of scope).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { canonicalize } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';
import { postCreateIntention, announcePostId } from '../core/announce-outbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let M = null, modErr = null;
try { M = await import(pathToFileURL(path.join(HERE, '..', 'core', 'origin-commit.mjs')).href); } catch (e) { modErr = e; }
const need = () => assert.ok(M, `core/origin-commit.mjs does not exist (${modErr?.message?.slice(0, 120)})`);

// ── the builder's names ──
const OUTCOME_READ = () => M?.readOriginOutcome;   // (client, mutationId) → { ok, outcome } | { ok: false, reason }
const OUTCOME = { committed: 'committed', refused: 'refused', unresolved: 'unresolved' };
const NEVER_APPLIED_WORDS = /never.?applied|abandon/i;   // C1: an unresolved origin is never reported in these words
const SETTLE_KIND = 'obligation.settle';
const settleIntention = (obligationId, transition, extra = {}) => ({ kind: SETTLE_KIND, opId: `urn:ex:op/obligation/settle/${obligationId}/${transition}`, actor: PERSON('board'), obligationId, transition, ...extra });
const BLOCK_REASONS = ['tombstoned'];

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const PENDING_BUILD = { todo: 'needs the slice-3 build: the outcome read (r2 R-A1/r3 C1) and the obligation.settle kind (r2 §4/r3 C2) are not built; delete PENDING_BUILD when they land' };
const TP = { ...T, ...PENDING_BUILD };
const DSID = 'og1629o';
const BK = 'urn:scrum:bookkeeping:executor';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NAMESPACE = 'cd807138-eefc-40d2-9a80-525e666e6269';
const PS = (name) => `urn:ex:postseq/${name}`;
const PERSON = (seat) => `https://scrumboard.local/person/${seat}`;
const EPOCH = 'e-1629-s3o';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuidv5(name, ns) {
  const h = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(ns.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const midOf = (route, subject, requestKey, originActor) => uuidv5(JSON.stringify(['origin-v1', route, subject, requestKey, originActor]), NAMESPACE);
const card = (id, shortId, extra = {}) => ({ id, shortId, title: `card ${shortId}`, description: 'body', column: 'backlog', createdAt: '2026-10-22T06:00:00.000Z', createdBy: 'ada', version: 1, ...extra });
const cpart = (c, expectedVersion, prior = null) => ({ iri: cardIriOf(c.id), expectedVersion, version: c.version, quads: cardQuads(c, new Map()), ...(prior ? { prior: priorQuads(prior, new Map()) } : {}), json: JSON.stringify(c) });
function claimOrigin(c, requestKey, seat = 'ada') {
  const mid = midOf('claim', c.id, requestKey, seat);
  const descriptor = { route: 'claim', subject: c.id, requestKey, originActor: seat, mutationId: mid, provenance: { cardId: c.id, version: 2 }, slots: [{ slot: 'claim', author: 'board', body: `${seat} claimed #${c.shortId}`, mentions: [], notify: true }] };
  return { mid, descriptor, plan: { parts: [cpart({ ...c, version: 2, claimedBy: seat }, '1', c)] } };
}
const prepareIntention = (o) => ({ kind: 'origin.prepare', opId: `urn:ex:op/origin/prepare/${o.mid}`, actor: PERSON(o.descriptor.originActor), origin: o.descriptor, plan: o.plan });
const commitIntention = (o, occurredAt) => ({ kind: 'card.write', opId: `urn:ex:op/origin/commit/${o.mid}`, actor: PERSON(o.descriptor.originActor), ...o.plan, origin: { ...o.descriptor, occurredAt } });
const lit = (v) => (typeof v === 'number' ? `"${v}"^^<${XSD}integer>` : JSON.stringify(String(v)));

let seedN = 0;
const STORES = [];
after(() => { for (const d of STORES) fs.rmSync(d, { recursive: true, force: true }); });
/** A proxy in front of the executor; `dropNextUpdate()` forwards the next /update and destroys the caller's socket before answering. */
async function startProxy(execUrl) {
  const p = { drop: false };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const dropThis = p.drop && req.url.startsWith('/update'); if (dropThis) p.drop = false;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const t = await f.text();
      if (dropThis) { p.dropped = { status: f.status, text: t }; req.socket.destroy(); return; }
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.dropNextUpdate = () => { p.drop = true; };
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function world(body, cards) {
  need();
  const store = tmpStore('og1629o-'); STORES.push(store); fs.rmSync(store, { recursive: true });
  let exec = await startExecutor({ store, datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const mk = (url) => createGraphClient({ baseUrl: url, expectedDatasetId: DSID, timeoutMs: 30000, label: 'origin-1629-s3-outcome' });
  const ctx = { client: mk(exec.baseUrl), viaProxy: mk(proxy.url), proxy, exec: () => exec,
    stopExecutor: async () => { await killExecutor(exec); exec = null; },
  };
  try {
    const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/og1629o-alloc-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { <${PS('allocator')}> a <${PS('Allocator')}> ; <${PS('postSeqEpoch')}> ${lit(EPOCH)} ; <${PS('nextPostSeq')}> ${lit(100)} ; <${PS('version')}> ${lit(1)} . } }` });
    assert.equal(r.status, 200, `PRECONDITION: the allocator was seeded (${await r.text()})`);
    for (const c of cards) {
      const w = await ctx.client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629o-seed-${process.pid}-${seedN++}`, actor: PERSON('ada'), parts: [cpart(c, null)] });
      assert.equal(w.outcome, 'APPLIED', `PRECONDITION: fixture card ${c.id} created (${JSON.stringify(w)})`);
    }
    await body(ctx);
  } finally { await proxy.stop(); if (exec) await killExecutor(exec); }
}
const rows = async (client, sparql) => { const q = await client.query(sparql); assert.ok(q.ok, `query answered (${q.reason})`); return q.rows; };
const bkState = async (client) => (await rows(client, `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o } }`)).map((r) => `${r.s.value} ${r.p.value} ${r.o.value}`).sort();
async function prepared(client, o) {
  assert.equal((await client.update(prepareIntention(o))).outcome, 'APPLIED', 'PRECONDITION: prepare APPLIED');
  const p = await M.readPreparedOrigin(client, o.mid);
  assert.equal(p.ok, true, `PRECONDITION: the Prepared record reads ok (${JSON.stringify(p).slice(0, 200)})`);
  return p.prepared;
}
async function committed(client, o) {
  const p = await prepared(client, o);
  assert.equal((await client.update(commitIntention(o, p.occurredAt))).outcome, 'APPLIED', 'PRECONDITION: commit APPLIED');
  const got = await M.readCommittedOrigin(client, o.mid);
  assert.equal(got.ok, true, `PRECONDITION: the committed join reads ok (${JSON.stringify(got).slice(0, 200)})`);
  return got.committed;
}
/** The reserved announcement's post.create, built from the committed reservation the way the publisher builds it from an entry. */
function postFor(o, committedJoin, override = {}) {
  const res = committedJoin.reservations[0], ob = committedJoin.obligations[0];
  const d = res.draft;
  return postCreateIntention({ mutationId: o.mid, slot: ob.slot, postSeq: res.postSeq, publicationAt: res.createdAt, payload: { author: d.author, body: d.body, originActor: d.originActor, occurredAt: d.occurredAt, mentions: d.mentions, ...override } });
}
const obligationStatus = async (client, o) => (await M.readCommittedOrigin(client, o.mid)).committed?.obligations?.[0]?.status;
async function outcome(client, mid) {
  const read = OUTCOME_READ();
  assert.equal(typeof read, 'function', 'the outcome read is exported (builder\'s name: readOriginOutcome)');
  return read(client, mid);
}

// ── OUTCOME ──
test('#1629 s3 (O1) committed: a prepared and committed origin reads `committed`', TP, async () => {
  const c = card('o1', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-o1');
    await committed(client, o);
    const r = await outcome(client, o.mid);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.outcome, OUTCOME.committed, JSON.stringify(r));
  }, [c]);
});

test('#1629 s3 (O2) UNKNOWN THAT COMMITTED: the commit applied but its response was lost; the read says `committed`', TP, async () => {
  const c = card('o2', 1);
  await world(async ({ client, viaProxy, proxy }) => {
    const o = claimOrigin(c, 'k-o2');
    const p = await prepared(client, o);
    proxy.dropNextUpdate();
    const seen = await viaProxy.update(commitIntention(o, p.occurredAt));
    assert.notEqual(seen.outcome, 'APPLIED', `PRECONDITION: the caller did NOT see APPLIED (${JSON.stringify(seen).slice(0, 200)})`);
    assert.equal(proxy.dropped?.status, 200, `PRECONDITION: the executor did answer the dropped update (${JSON.stringify(proxy.dropped).slice(0, 200)})`);
    const r = await outcome(client, o.mid);
    assert.equal(r.outcome, OUTCOME.committed, `O2: UNKNOWN that committed reads committed (${JSON.stringify(r)})`);
  }, [c]);
});

test('#1629 s3 (O3) refused: after the card moved, the commit came back PRECONDITION_FAILED; the read says `refused`', TP, async () => {
  const c = card('o3', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-o3');
    const p = await prepared(client, o);
    assert.equal((await client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629o-move-${process.pid}`, actor: PERSON('ada'), parts: [cpart({ ...c, version: 2, title: 'moved' }, '1', c)] })).outcome, 'APPLIED');
    assert.equal((await client.update(commitIntention(o, p.occurredAt))).outcome, 'PRECONDITION_FAILED', 'PRECONDITION: the commit was refused');
    const r = await outcome(client, o.mid);
    assert.equal(r.outcome, OUTCOME.refused, JSON.stringify(r));
  }, [c]);
});

test('#1629 s3 (O4) UNRESOLVED: Prepared with no link and no receipt reads `unresolved`, never "never applied"', TP, async () => {
  const c = card('o4', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-o4');
    await prepared(client, o);
    const r = await outcome(client, o.mid);
    assert.equal(r.outcome, OUTCOME.unresolved, JSON.stringify(r));
    assert.doesNotMatch(JSON.stringify(r), NEVER_APPLIED_WORDS, 'C1: an unresolved origin is never reported as never applied');
  }, [c]);
});

test('#1629 s3 (O5) unavailable: with the executor down the read reports it, never a guessed state', TP, async () => {
  const c = card('o5', 1);
  await world(async ({ client, stopExecutor }) => {
    const o = claimOrigin(c, 'k-o5');
    await committed(client, o);
    await stopExecutor();
    const r = await outcome(client, o.mid);
    assert.equal(r.ok, false, `O5: not ok (${JSON.stringify(r)})`);
    assert.ok(!Object.values(OUTCOME).includes(r.outcome), `O5: and no outcome state is guessed (${JSON.stringify(r)})`);
  }, [c]);
});

test('#1629 s3 (O6) PURE: reading committed, refused and unresolved outcomes changes nothing in the bookkeeping graph', TP, async () => {
  const a = card('o6a', 1), b = card('o6b', 2), u = card('o6u', 3);
  await world(async ({ client }) => {
    const oa = claimOrigin(a, 'k-o6a'), ob = claimOrigin(b, 'k-o6b'), ou = claimOrigin(u, 'k-o6u');
    await committed(client, oa);
    const pb = await prepared(client, ob);
    assert.equal((await client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629o-o6-${process.pid}`, actor: PERSON('ada'), parts: [cpart({ ...b, version: 2, title: 'moved' }, '1', b)] })).outcome, 'APPLIED');
    assert.equal((await client.update(commitIntention(ob, pb.occurredAt))).outcome, 'PRECONDITION_FAILED');
    await prepared(client, ou);
    const before = await bkState(client);
    for (let i = 0; i < 2; i++) for (const o of [oa, ob, ou]) await outcome(client, o.mid);
    assert.deepEqual(await bkState(client), before, 'O6: six outcome reads changed nothing in the bookkeeping graph (receipts and commitSeq included)');
  }, [a, b, u]);
});

// ── SETTLEMENT ──
test('#1629 s3 (S0 CONTROL, today) a committed origin\'s reserved post is created by post.create from its reservation, at the derived postId and reserved postSeq', T, async () => {
  const c = card('s0', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s0');
    const j = await committed(client, o);
    const pc = postFor(o, j);
    assert.equal(pc.post.id, announcePostId(o.mid, 'claim'), 'the post is at the derived postId');
    assert.equal(pc.post.postSeq, j.reservations[0].postSeq, 'with the reserved postSeq');
    const r = await client.update(pc);
    assert.equal(r.outcome, 'APPLIED', `S0: the reserved post is created (${JSON.stringify(r).slice(0, 300)})`);
    assert.equal(await obligationStatus(client, o), 'pending', 'S0: and the obligation still reads pending (nothing settles it on today\'s code)');
  }, [c]);
});

test('#1629 s3 (S1) settle publish with the post receipt APPLIED: APPLIED, the obligation reads published', TP, async () => {
  const c = card('s1', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s1');
    const j = await committed(client, o);
    assert.equal((await client.update(postFor(o, j))).outcome, 'APPLIED', 'PRECONDITION: the post exists');
    const r = await client.update(settleIntention(j.obligations[0].obligationId, 'publish'));
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r).slice(0, 300));
    assert.equal(await obligationStatus(client, o), 'published');
  }, [c]);
});

test('#1629 s3 (S2) settle publish with NO post receipt: refused, the obligation stays pending, nothing changed', TP, async () => {
  const c = card('s2', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s2');
    const j = await committed(client, o);
    const before = await bkState(client);
    const r = await client.update(settleIntention(j.obligations[0].obligationId, 'publish'));
    assert.equal(r.outcome, 'PRECONDITION_FAILED', JSON.stringify(r).slice(0, 300));
    assert.equal(await obligationStatus(client, o), 'pending');
    const after = (await bkState(client)).filter((t) => !t.startsWith('urn:ex:op/') && !t.includes('urn:ex:commitSeq'));
    assert.deepEqual(after, before.filter((t) => !t.startsWith('urn:ex:op/') && !t.includes('urn:ex:commitSeq')), 'nothing but the refusal receipt changed');
  }, [c]);
});

test('#1629 s3 (S3) the deterministic op written with a DIFFERENT body: receipt APPLIED but not the frozen payload\'s digest, so settle publish is refused', TP, async () => {
  const c = card('s3', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s3');
    const j = await committed(client, o);
    const forged = postFor(o, j, { body: 'not what was frozen' });
    const w = await client.update(forged);
    assert.equal(w.outcome, 'APPLIED', `PRECONDITION: a post was written under the deterministic op with a different body (${JSON.stringify(w).slice(0, 200)}); if the executor already refuses this, S3 needs a different forgery`);
    const r = await client.update(settleIntention(j.obligations[0].obligationId, 'publish'));
    assert.equal(r.outcome, 'PRECONDITION_FAILED', `S3: post existence and an APPLIED receipt alone never satisfy the proof (${JSON.stringify(r).slice(0, 300)})`);
    assert.equal(await obligationStatus(client, o), 'pending');
  }, [c]);
});

test('#1629 s3 (S4) replay of settle publish: APPLIED again, nothing changes', TP, async () => {
  const c = card('s4', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s4');
    const j = await committed(client, o);
    assert.equal((await client.update(postFor(o, j))).outcome, 'APPLIED');
    const s = settleIntention(j.obligations[0].obligationId, 'publish');
    assert.equal((await client.update(s)).outcome, 'APPLIED');
    const before = await bkState(client);
    assert.equal((await client.update(s)).outcome, 'APPLIED', 'the replay returns the original receipt');
    assert.deepEqual(await bkState(client), before, 'and changed nothing (commitSeq included)');
  }, [c]);
});

test('#1629 s3 (S5) terminal: after published, settle block is refused and the status stays published', TP, async () => {
  const c = card('s5', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s5');
    const j = await committed(client, o);
    assert.equal((await client.update(postFor(o, j))).outcome, 'APPLIED');
    assert.equal((await client.update(settleIntention(j.obligations[0].obligationId, 'publish'))).outcome, 'APPLIED');
    const pid = announcePostId(o.mid, 'claim');
    assert.equal((await client.update({ kind: 'post.redact', opId: `urn:ex:op/redact/${pid}`, actor: PERSON('ada'), post: { id: pid }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-22T12:00:00.000Z' })).outcome, 'APPLIED', 'PRECONDITION: a tombstone exists, so only the terminal state can refuse the block');
    const r = await client.update(settleIntention(j.obligations[0].obligationId, 'block', { reason: 'tombstoned' }));
    assert.equal(r.outcome, 'PRECONDITION_FAILED', JSON.stringify(r).slice(0, 300));
    assert.equal(await obligationStatus(client, o), 'published', 'a terminal state is never overwritten');
  }, [c]);
});

test('#1629 s3 (S6) block(tombstoned) on a pending obligation whose post is redacted: APPLIED, it reads blocked', TP, async () => {
  const c = card('s6', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s6');
    const j = await committed(client, o);
    assert.equal((await client.update(postFor(o, j))).outcome, 'APPLIED');
    const pid = announcePostId(o.mid, 'claim');
    assert.equal((await client.update({ kind: 'post.redact', opId: `urn:ex:op/redact/${pid}`, actor: PERSON('ada'), post: { id: pid }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-22T12:00:00.000Z' })).outcome, 'APPLIED', 'PRECONDITION: the deterministic post is tombstoned');
    const r = await client.update(settleIntention(j.obligations[0].obligationId, 'block', { reason: 'tombstoned' }));
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r).slice(0, 300));
    assert.equal(await obligationStatus(client, o), 'blocked');
  }, [c]);
});

test('#1629 s3 (S7) block(tombstoned) without a tombstone is refused; a reason outside the closed set never reaches the store', TP, async () => {
  const c = card('s7', 1);
  await world(async ({ client }) => {
    const o = claimOrigin(c, 'k-s7');
    const j = await committed(client, o);
    const r = await client.update(settleIntention(j.obligations[0].obligationId, 'block', { reason: 'tombstoned' }));
    assert.equal(r.outcome, 'PRECONDITION_FAILED', JSON.stringify(r).slice(0, 300));
    assert.equal(await obligationStatus(client, o), 'pending');
    assert.ok(!BLOCK_REASONS.includes('because-i-said-so'));
    assert.throws(() => canonicalize(settleIntention(j.obligations[0].obligationId, 'block', { reason: 'because-i-said-so' })), 'a reason outside the closed set is refused at canonicalization');
  }, [c]);
});
