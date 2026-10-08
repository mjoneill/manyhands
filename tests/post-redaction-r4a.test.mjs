/**
 * R4a — LOGICAL REDACTION SUBSTRATE of a post, on a REAL executor. ⚠ NOT R4. Pre-registered by the separate test author BEFORE it exists.
 * Copy unchanged into tests/ and build to it; if the contract needs a change the test changes first and the change is announced on #1574.
 * Real executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass. The production graph flag stays OFF.
 *
 * ⚠ WHAT THIS FILE DOES NOT PROVE, AND MUST NOT BE READ AS PROVING: that the removed text is physically gone. The measured finding on this runtime is that a
 * SPARQL DELETE, even followed by optimize(), leaves the text in the store's write-ahead log and in a post-delete .sst; only a verified rewrite into a
 * fresh store removed it, and a rewrite is a NEW INCARNATION. None of that is exercised here. Every row below is about what the CURRENT store answers and
 * what its neighbours do. R4 is complete only when the physical slice, the retained copies (pre-redaction checkpoints, backups, the document and event
 * log, attachment bytes), the rewrite's crash states and the cursor resync across a rewrite hold, and those are the `todo` rows at the end.
 *
 * CONTRACT PINNED HERE (the pins proposed in the #1574 thread and accepted by the builder; none is owner-ratified storage policy)
 *   INTENTION   {kind: 'post.redact', opId, actor, post: {id}, authorityRef, occurredAt}. A normal receipted operation. The removed text appears in NO field
 *               of the intention, no receipt, no tombstone, no response, no error.
 *   DELETE      the post's content triples are DELETED (every triple that carried the body, the mentions, the author link, dateCreated, `about`, origin): a
 *               superseding assertion or a marker that leaves the body queryable fails.
 *   TOMBSTONE   the post's IRI keeps EXACTLY these triples: rdf:type <https://scrumboard.local/ns#RedactedPost>, ns#postSeq (the original, xsd:integer),
 *               urn:ex:recordedBy (the ORIGINAL operation) and ns#redactedBy (the IRI of the REDACTION operation, never the actor). Nothing else. A synthetic unique marker in
 *               the body, a mention and the author appears in NO triple anywhere in the store (every subject, every graph).
 *   IDEMPOTENT  the same opId again returns the same APPLIED receipt and the executor's commit counter does NOT move (no second logical commit).
 *   REFUSALS    an unknown target is a NAMED refusal (not APPLIED, no tombstone created); a post that is already redacted under another opId is not redacted twice.
 *   FENCES      the same post id cannot be recreated by post.create or post.import under a NEW opId; R0 reports it as {id, reason: 'redacted-post'} (exit 4)
 *               and writes nothing; a publisher retry whose entry still says pending but whose post is redacted is BLOCKED with POST_REDACTED, never published.
 *   R3 READS    bootstrap keeps the post's slot as {id, postSeq, body: null, redacted: true} (no other content field; never "" and never the old text); a live
 *               cursor that already delivered the post receives ONE item {op: 'redact', id, postSeq, body: null, redacted: true, commitSeq} at the redaction commit,
 *               for imported posts too; a consumer on a FILTER (mentions_me) that received the post still receives its redaction after the mention is deleted.
 *               A redacted post is NOT a GRAPH_DISCOVERY_INCONSISTENT.
 *
 * NOT PINNED, BY NAME: authorisation of the caller (the intention is a substrate behind the host-only, human-authorised
 * coordinator, never the authority); attachments (no graph shape yet); the durable redaction-decision ledger that must survive a restore; everything physical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, waitForHttp, makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor, PY } from './helpers/graph-executor-proc.mjs';
import { announcePostId, postCreateIntention } from '../core/announce-outbox.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { readNodeWhole } from './helpers/node-placement-1638.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'r3-test';
const ENTITY = 'https://scrumboard.local/entity/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const T0 = '2026-10-04T12:00:00.000Z';
const GC = /^gc1\.([0-9a-f-]{36})\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
const GB = /^gb1\.([0-9a-f-]{36})\.(\d+)\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
// the scope is the FULL sha256 of canonical JSON with explicit nulls and a fixed field order (an absent filter is null, never a sentinel string)
const scopeOf = (f = {}) => crypto.createHash('sha256').update(JSON.stringify({ v: 1, mentions_me: f.mentions_me == null ? null : String(f.mentions_me).toLowerCase(), attachedTo: f.attachedTo ?? null, conversation: f.conversation ?? null })).digest('hex');
const commitOf = (token) => Number(token.split('.')[3]);

// ---- fixtures: publisher-mode obligations seeded into a MIGRATED board, so their reservations start at `base + 1`
const payloadOf = (mut, mentions = []) => ({ author: 'board', body: `post ${mut}`, mentions, notify: false, occurredAt: T0, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: mut, slot: 'claim' });
const entryOf_ = (mut, mentions) => ({ obligationId: `${mut}:claim`, mutationId: mut, slot: 'claim', status: 'pending', mode: 'publisher', payload: payloadOf(mut, mentions) });
const originOf_ = (mut) => ({ mutationId: mut, slots: ['claim'], origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', mode: 'publisher' });
const docPosts = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, body: `doc ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt: T0, postSeq: i + 1 }));
function entriesBoard(muts, { base = 40, mentions = {} } = {}) {
  const origins = {}, entries = {};
  for (const m of muts) { origins[m] = originOf_(m); entries[`${m}:claim`] = entryOf_(m, mentions[m] || []); }
  return makeBoardFixture({ conversations: docPosts(base), postSeqEpoch: EPOCH_DOC, nextPostSeq: base + 1, announcementOutbox: { origins, entries } });
}
const idOf = (m) => announcePostId(m, 'claim');

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const publish = (base, mut) => api(base, 'POST', `/api/outbox/${encodeURIComponent(`${mut}:claim`)}/publish`, {});
const entryOf = async (base, mut) => (await api(base, 'GET', '/api/outbox')).body.entries.find((e) => e.obligationId === `${mut}:claim`);
const feed = (base, qs) => api(base, 'GET', `/api/conversations?${qs}`);
const ids = (r) => r.body.conversations.map((c) => c.id);

/** A proxy in front of the executor that can HOLD the next /update BEFORE forwarding it (a write that is reserved but not committed). */
async function startProxy(execUrl) {
  let target = execUrl;
  const p = { updates: 0, requests: 0, armed: null, down: false, swap: null };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    p.requests++;
    if (p.down) { req.socket.destroy(); return; }
    if (req.method === 'POST' && req.url === '/update') {
      p.updates++;
      if (p.armed) { const a = p.armed; p.armed = null; a.arrive(); await a.released; }
    }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${target}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const text = await f.text(); res.statusCode = f.status; res.end(text);
      if (p.swap && req.url === '/query' && ++p.swap.seen === p.swap.after) target = p.swap.to;   // the executor behind the proxy is REPLACED after the Nth query of the swap
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.hold = () => { let arrive, release; const arrived = new Promise((r) => { arrive = r; }); const released = new Promise((r) => { release = r; }); p.armed = { arrive, released }; return { arrived, release }; };
  p.swapAfter = (n, url) => { p.swap = { after: n, to: url, seen: 0 }; };
  p.unswap = () => { p.swap = null; target = execUrl; };
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

async function spawnServer(boardFile, execUrl, { flag = true } = {}) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'r3-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `r3-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `r3-${port}`,
    SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl, ...(flag ? { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}

/** A board file, a real executor behind a proxy, and a server: each of the three can be restarted on the same state. */
async function stack(board, body, { flag = true } = {}) {
  const store = tmpStore('r3-store-');
  let exec = await startExecutor({ store, datasetId: DSID, create: true }); const port = exec.port;
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-')); const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(board, null, 2));
  let srv = await spawnServer(file, proxy.url, { flag });
  const api_ = {
    get base() { return srv.base; }, proxy, file, store, get exec() { return exec; },
    restartServer: async () => { srv.stop(); srv = await spawnServer(file, proxy.url, { flag }); },
    restartExecutor: async () => { await killExecutor(exec); exec = await startExecutor({ store, datasetId: DSID, create: false, port }); },
    killExecutor: async () => { await killExecutor(exec); },
    startExecutor: async () => { exec = await startExecutor({ store, datasetId: DSID, create: false, port }); },
    stderr: () => srv.stderr(),
  };
  try { return await body(api_); } finally { srv.stop(); await proxy.stop(); await killExecutor(exec); }
}


const MARKER = 'REDACTME-7c1f9a-unique';
const NSV = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const redactIntention = (mut, tag = 'r1') => ({ kind: 'post.redact', opId: `urn:ex:op/redact/${mut}-${tag}`, actor: 'https://scrumboard.local/person/ada', post: { id: idOf(mut) }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' });
const markerPost = (mut) => ({ payload: { ...payloadOf(mut, [MARKER]), body: `body ${MARKER}` } });
const withMarker = (muts) => { const b = entriesBoard(muts, { base: 10 }); for (const m of muts) { b.announcementOutbox.entries[`${m}:claim`].payload = { ...b.announcementOutbox.entries[`${m}:claim`].payload, body: `body ${MARKER} ${m}`, mentions: [MARKER] }; } return b; };
const clientFor = (s) => createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID });
async function markerRows(s) {
  const r = await clientFor(s).query(`SELECT ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } FILTER(CONTAINS(STR(?o), ${JSON.stringify(MARKER)}) || CONTAINS(STR(?s), ${JSON.stringify(MARKER)}) || CONTAINS(STR(?p), ${JSON.stringify(MARKER)})) }`);
  assert.equal(r.ok, true, JSON.stringify(r)); return r.rows.length;
}
async function nodeOf_(s, mut) {
  // #1638: the node is its domain triples (default graph) PLUS its bookkeeping; readNodeWhole asserts each part is in the RIGHT graph, then returns the whole node. The allow-list assertions below speak of the WHOLE node and are unchanged.
  const r = await readNodeWhole(clientFor(s), `${ENTITY}${idOf(mut)}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = {}; for (const b of r.rows) (out[b.p.value] ||= []).push(`${b.o.type}|${b.o.value}|${b.o.datatype || ''}`);
  for (const k of Object.keys(out)) out[k].sort(); return out;
}
const commitMark = async (s) => { const r = await clientFor(s).query(`SELECT ?c WHERE { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:commitSeq> ?c } }`); return Number(r.rows[0].c.value); };

test('X0 CONTROL: before redaction the marker IS present in the store (body, mention) and the R3 feed serves it; so nothing below can pass on a missing source', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a', 'm-b']), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    assert.ok((await markerRows(s)) >= 2, 'the marker is in the graph (the body and the mention of each post)');
    const boot = await feed(s.base, 'afterCommit=start&limit=10');
    assert.equal(boot.status, 200, boot.text);
    assert.ok(boot.text.includes(MARKER), 'and the discovery feed serves it');
  });
});

test('X1 THE DELETE: after post.redact the marker is in NO triple of the store (any subject, any graph), the post keeps EXACTLY the tombstone triples, and the unrelated post is byte-for-byte unchanged', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a', 'm-b']), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const bBefore = await nodeOf_(s, 'm-b'); const aBefore = await nodeOf_(s, 'm-a');
    assert.ok((await markerRows(s)) >= 2);
    const r = await clientFor(s).update(redactIntention('m-a'));
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    const left = await markerRows(s);
    const bMarkerRows = Object.values(bBefore).flat().filter((v) => v.includes(MARKER)).length;
    assert.equal(left, bMarkerRows, 'the marker survives ONLY on the unrelated post m-b (its own body and mention), nowhere on the redacted one');
    const t = await nodeOf_(s, 'm-a');
    assert.deepEqual(Object.keys(t).sort(), [RDF_TYPE, `${NSV}postSeq`, 'urn:ex:recordedBy', `${NSV}redactedBy`].sort(), `the tombstone keeps exactly these predicates: ${JSON.stringify(t)}`);
    assert.deepEqual(t[RDF_TYPE], [`uri|${NSV}RedactedPost|`]);
    assert.deepEqual(t[`${NSV}postSeq`], aBefore[`${NSV}postSeq`], 'the ORIGINAL postSeq, an xsd:integer');
    assert.deepEqual(t['urn:ex:recordedBy'], aBefore['urn:ex:recordedBy'], 'the ORIGINAL recording operation');
    assert.deepEqual(t[`${NSV}redactedBy`], [`uri|${redactIntention('m-a').opId}|`], 'redactedBy is the REDACTION operation (its IRI), not the actor; recordedBy still names the original creation operation');
    assert.deepEqual(await nodeOf_(s, 'm-b'), bBefore, 'the unrelated post is unchanged');
  });
});

test('X2 NOTHING THE OPERATION EMITS CARRIES THE REMOVED TEXT: the intention, the update result, the reconcile result and the receipt triples are free of the marker', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const intention = redactIntention('m-a');
    assert.ok(!JSON.stringify(intention).includes(MARKER), 'the intention itself is content-free');
    const r = await clientFor(s).update(intention); assert.equal(r.outcome, 'APPLIED');
    assert.ok(!JSON.stringify(r).includes(MARKER), 'the update result');
    const rec = await clientFor(s).reconcile(intention); assert.equal(rec.outcome, 'APPLIED'); assert.ok(!JSON.stringify(rec).includes(MARKER), 'the reconcile result');
    assert.equal(await markerRows(s), 0, 'and no triple anywhere, receipts and operation nodes included');
  });
});

test('X3 IDEMPOTENT: the same opId again is the same APPLIED receipt and the commit counter does not move; a second operation id for an already-redacted post is not a second redaction', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const first = await clientFor(s).update(redactIntention('m-a'));
    assert.equal(first.outcome, 'APPLIED'); const mark = await commitMark(s); const t = await nodeOf_(s, 'm-a');
    const again = await clientFor(s).update(redactIntention('m-a'));
    assert.equal(again.outcome, 'APPLIED'); assert.equal(again.digest, first.digest, 'the same receipt');
    assert.equal(await commitMark(s), mark, 'no second logical commit');
    const other = await clientFor(s).update(redactIntention('m-a', 'r2'));
    assert.notEqual(other.outcome, 'APPLIED', `an already-redacted post is not redacted again under another opId: ${JSON.stringify(other)}`);
    assert.deepEqual(await nodeOf_(s, 'm-a'), t, 'the tombstone is unchanged');
  });
});

test('X4 REFUSALS: an unknown target is a NAMED refusal (not APPLIED) and creates no tombstone; a wrong dataset is refused', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a', 'm-ctl']), async (s) => {
    for (const m of ['m-a', 'm-ctl']) assert.equal((await publish(s.base, m)).body.status, 'published');
    assert.equal((await clientFor(s).update(redactIntention('m-ctl'))).outcome, 'APPLIED', 'CONTROL: a real target IS redacted, so the refusals below are about THESE requests and not about an intention kind the executor does not know');
    const r = await clientFor(s).update({ ...redactIntention('m-a'), opId: 'urn:ex:op/redact/no-such-post', post: { id: '00000000-0000-4000-8000-0000000000ff' } });
    assert.notEqual(r.outcome, 'APPLIED', `an unknown target must not be a success: ${JSON.stringify(r)}`);
    assert.ok(r.reason || r.outcome, 'and it names why');
    const none = await clientFor(s).query(`SELECT ?p ?o WHERE { <${ENTITY}00000000-0000-4000-8000-0000000000ff> ?p ?o }`);
    assert.equal(none.rows.length, 0, 'no tombstone was invented for a post that never existed');
    const wrong = createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: 'some-other-dataset' });
    const w = await wrong.update(redactIntention('m-a'));
    assert.notEqual(w.outcome, 'APPLIED', `a wrong dataset is refused: ${JSON.stringify(w)}`);
  });
});

test('X5 NO RECREATION: after redaction, post.create and post.import of the SAME post id under a NEW opId are not APPLIED and the node stays a tombstone with no body', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const created = (await entryOf(s.base, 'm-a'));
    assert.equal((await clientFor(s).update(redactIntention('m-a'))).outcome, 'APPLIED');
    const again = await clientFor(s).update({ ...postCreateIntention({ ...entryOf_('m-a'), payload: { ...entryOf_('m-a').payload, body: `body ${MARKER} resurrected` }, publicationAt: created.publicationAt, postSeq: created.postSeq }), opId: 'urn:ex:op/announce/m-a/claim-second-try' });
    assert.notEqual(again.outcome, 'APPLIED', `a new opId must not recreate a redacted post: ${JSON.stringify(again)}`);
    const imp = await clientFor(s).update({ kind: 'post.import', opId: 'urn:ex:op/backfill/' + idOf('m-a') + '-again', actor: 'https://scrumboard.local/person/board', post: { id: idOf('m-a'), body: `body ${MARKER}`, author: 'board', createdAt: '2026-10-01T00:00:00.000Z', attachedTo: null, mentions: [MARKER], postSeq: created.postSeq } });
    assert.notEqual(imp.outcome, 'APPLIED', `nor may an import: ${JSON.stringify(imp)}`);
    assert.equal(await markerRows(s), 0, 'the marker is still nowhere');
  });
});

test('X6 R0 NEVER RE-IMPORTS A REDACTED ID from an older board snapshot: {id, reason: "redacted-post"}, exit 4, nothing written, the marker absent', { skip: SKIP }, async () => {
  const tool = process.env.BACKFILL_SCRIPT || path.join(HERE, '..', 'scripts', 'backfill-posts-r0.mjs');
  await stack(withMarker(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const rec = await entryOf(s.base, 'm-a');
    assert.equal((await clientFor(s).update(redactIntention('m-a'))).outcome, 'APPLIED');
    const old = [{ id: idOf('m-a'), body: `body ${MARKER}`, author: 'board', attachedTo: null, attachments: [], mentions: [MARKER], createdAt: '2026-10-01T00:00:00.000Z', postSeq: rec.postSeq }];
    const bf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r4-snap-')), 'board.json');
    fs.writeFileSync(bf, JSON.stringify(makeBoardFixture({ conversations: old, postSeqEpoch: EPOCH_DOC, nextPostSeq: rec.postSeq + 1 }), null, 2));
    const before = s.proxy.updates;
    const run = spawnSync(process.execPath, [tool, '--board-file', bf, '--executor-url', s.exec.baseUrl, '--dataset-id', DSID], { encoding: 'utf8', cwd: PROJECT_DIR });
    assert.equal(run.status, 4, `${run.stdout}${run.stderr}`);
    const summary = JSON.parse(run.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
    assert.deepEqual(summary.conflicts, [{ id: idOf('m-a'), reason: 'redacted-post' }]);
    assert.deepEqual([summary.written, summary.alreadyPresent], [0, 0]);
    assert.equal(await markerRows(s), 0, 'the old snapshot did not bring the text back');
  });
});

test('X7 A PUBLISHER RETRY OF A REDACTED POST IS BLOCKED, never published: an entry that still says pending (its recording write was lost) while the graph holds a tombstone is POST_REDACTED, and the old create receipt is not read as current visibility', { skip: SKIP }, async () => {
  const board = entriesBoard(['m-a'], { base: 10 });
  const e = board.announcementOutbox.entries['m-a:claim']; e.publicationAt = '2026-10-05T07:30:00.000Z'; e.postSeq = 11; e.payload = { ...e.payload, body: `body ${MARKER}`, mentions: [MARKER] };
  board.nextPostSeq = 12;
  await stack(board, async (s) => {
    const w = await clientFor(s).update(postCreateIntention(e));
    assert.equal(w.outcome, 'APPLIED', 'fixture: the post exists in the graph although the entry still says pending');
    assert.equal((await clientFor(s).update(redactIntention('m-a'))).outcome, 'APPLIED');
    const r = await publish(s.base, 'm-a');
    assert.equal(r.body.status, 'blocked', `a redacted post must not be reported as published: ${r.text}`);
    assert.match(JSON.stringify(r.body), /POST_REDACTED/);
    assert.equal((await entryOf(s.base, 'm-a')).status, 'blocked');
    assert.equal(await markerRows(s), 0, 'and nothing brought the text back');
  });
});

test('X8 R3 READS A REDACTED POST CONTENT-FREE: a live cursor that already delivered it receives ONE redact item at the redaction commit, a fresh bootstrap keeps its slot as {id, postSeq, body: null, redacted: true}, and neither is a GRAPH_DISCOVERY_INCONSISTENT nor carries the old text', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a', 'm-b']), async (s) => {
    const c0 = (await feed(s.base, 'afterCommit=start')).body.nextAfterCommit;
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const seen = await feed(s.base, `afterCommit=${c0}&limit=10`);
    assert.deepEqual(ids(seen), [idOf('m-a'), idOf('m-b')]);
    assert.equal((await clientFor(s).update(redactIntention('m-a'))).outcome, 'APPLIED');
    const live = await feed(s.base, `afterCommit=${seen.body.nextAfterCommit}&limit=10`);
    assert.equal(live.status, 200, live.text);
    assert.equal(live.body.conversations.length, 1, 'exactly one item: the redaction');
    const it = live.body.conversations[0];
    assert.equal(it.op, 'redact'); assert.equal(it.id, idOf('m-a')); assert.equal(it.body, null); assert.equal(it.redacted, true); assert.equal(typeof it.postSeq, 'number'); assert.ok(it.commitSeq > seen.body.conversations[1].commitSeq);
    assert.ok(!live.text.includes(MARKER), 'the live item carries no historical text');
    const boot = await feed(s.base, 'afterCommit=start&limit=10');
    assert.equal(boot.status, 200, boot.text);
    const slot = boot.body.conversations.find((c) => c.id === idOf('m-a'));
    assert.ok(slot, 'the redacted post keeps its slot in the bootstrap');
    assert.equal(slot.body, null); assert.equal(slot.redacted, true);
    assert.ok(!JSON.stringify(slot).includes(MARKER), 'no content field of the slot carries the marker');
    assert.deepEqual(boot.body.conversations.map((c) => c.postSeq), [...boot.body.conversations.map((c) => c.postSeq)].sort((a, b) => a - b), 'and the order is still postSeq');
  });
});

test('X9 A FILTERED CONSUMER STILL GETS THE REDACTION: a mentions_me consumer that received the post still receives its redact item after the mention triple is deleted', { skip: SKIP }, async () => {
  await stack(withMarker(['m-a']), async (s) => {
    const c0 = (await feed(s.base, `afterCommit=start&mentions_me=${MARKER}`)).body.nextAfterCommit;
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const got = await feed(s.base, `afterCommit=${c0}&limit=10&mentions_me=${MARKER}`);
    assert.deepEqual(ids(got), [idOf('m-a')], 'control: the filtered consumer received it');
    assert.equal((await clientFor(s).update(redactIntention('m-a'))).outcome, 'APPLIED');
    const after = await feed(s.base, `afterCommit=${got.body.nextAfterCommit}&limit=10&mentions_me=${MARKER}`);
    assert.equal(after.status, 200, after.text);
    assert.deepEqual(after.body.conversations.map((c) => [c.op, c.id]), [['redact', idOf('m-a')]], 'its cache can drop the removed text: the redaction is not filtered away with the mention');
  });
});

// ------------------------------------------------------------------ NOT IN THIS FILE (visible as todo, never a pass)
const PHYS = 'NOT IN THIS FILE: owner decision and a separate physical-slice file; R4 is not complete without it';
test('P1 PHYSICAL ABSENCE: the removed text is not recoverable from the store\'s own files (WAL, SST, any other) after the chosen mechanism and a reopen; DELETE plus optimize() is already measured NOT to do this', { todo: PHYS }, () => assert.fail(PHYS));
test('P2 the verified sanitised-store REWRITE: preserves unrelated data, dataset identity, receipts and monotonic commit positions; is a NEW incarnation; crash outcomes before and after the switch are named', { todo: PHYS }, () => assert.fail(PHYS));
test('P3 EVERY cursor carrying the old incarnation resyncs after a rewrite, including a late owed post across that boundary (the R3/R4 joint)', { todo: PHYS }, () => assert.fail(PHYS));
test('P4 retained copies: pre-redaction checkpoints and backups, the document and event-log copies, attachment bytes and exports each have a stated disposition', { todo: PHYS }, () => assert.fail(PHYS));
test('P5 the durable redaction-decision ledger outside both restore sets: a restore of an older store is reconciled with it BEFORE serving', { todo: PHYS }, () => assert.fail(PHYS));
test('P6 the host-only, human-authorised coordinator: dry run by default, explicit confirmation, partial failure is a named INCOMPLETE state', { todo: PHYS }, () => assert.fail(PHYS));
