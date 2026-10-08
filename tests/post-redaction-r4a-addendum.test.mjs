/**
 * R4a ADDENDUM — two things the frozen R4a file (sha256 83f2a60b…5395) does not contain, found by reading the build 2c0b413.
 *
 *   X10 THE TOMBSTONE IS AN ALLOW-LIST, NOT A DENY-LIST. The build deletes a fixed list of content predicates and leaves every other triple on the node. Any
 *       predicate it does not name survives a redaction: the ones the U1-U4 shape adds (opId, onBehalfOf, recovered, attachments), and any future one. After
 *       post.redact the post node carries EXACTLY the tombstone triples (RedactedPost, the original postSeq, the original recordedBy, redactedBy) and nothing
 *       else, and every node of the post's attachments (E/<id>/attachment/<k>) is gone, with the marker in no triple anywhere. The fixture plants extra
 *       triples (a made-up predicate, NS opId, NS onBehalfOf, an attachment node) on a published post in the STOPPED store.
 *   X11 AMBIGUOUS OWNERSHIP REFUSES, IT DOES NOT BROADEN DELETION: a node under E/<id>/attachment/ is deleted only when it PROVES it belongs to the post (its
 *       NS attachmentOf names this post). A node under that prefix whose attachmentOf names ANOTHER post, or has none, makes post.redact a NAMED refusal (not
 *       APPLIED): the post keeps its content, the ambiguous node is untouched, and nothing is half-deleted.
 *   C1-C4 THE SHARED GRAPH CLIENT'S DATASET FENCE (the build fixed a real defect: a client built for the wrong dataset APPLIED a write), pinned at the boundary
 *       and for more than one caller: a WRONG dataset is REJECTED and not one write attempt reaches the store (counted at a proxy); an UNREADABLE identity is
 *       UNAVAILABLE with zero write attempts; the RIGHT dataset applies; and a client with NO expected dataset still writes, as it always did. The callers are a
 *       unit-1 kind (memory.create) and post.redact.
 * Real executor; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
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
  const p = { updates: 0, requests: 0, attempted: 0, armed: null, down: false, swap: null };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    p.requests++;
    if (req.method === 'POST' && req.url === '/update') p.attempted++;     // every write ATTEMPT that reaches the proxy, even one it then drops
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
const SCHEMA_ = 'https://schema.org/';
const redactIntention = (mut, tag = 'r1') => ({ kind: 'post.redact', opId: `urn:ex:op/redact/${mut}-${tag}`, actor: 'https://scrumboard.local/person/ada', post: { id: idOf(mut) }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' });
const clientFor = (s) => createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID });
const withMarkerBoard = (muts) => { const b = entriesBoard(muts, { base: 10 }); for (const m of muts) { const e = b.announcementOutbox.entries[`${m}:claim`]; e.payload = { ...e.payload, body: `body ${MARKER} ${m}`, mentions: [MARKER] }; } return b; };
async function nodeTriples_(s, iri) { const r = await clientFor(s).query(`SELECT ?p ?o WHERE { { <${iri}> ?p ?o } UNION { GRAPH <urn:scrum:bookkeeping:executor> { <${iri}> ?p ?o } } }`); assert.equal(r.ok, true);   /* #1638: the node = domain triples + its bookkeeping; the allow-list speaks of the whole node */ const out = {}; for (const b of r.rows) (out[b.p.value] ||= []).push(`${b.o.type}|${b.o.value}|${b.o.datatype || ''}`); for (const k of Object.keys(out)) out[k].sort(); return out; }
async function markerRows(s) { const r = await clientFor(s).query(`SELECT ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } FILTER(CONTAINS(STR(?o), ${JSON.stringify(MARKER)}) || CONTAINS(STR(?s), ${JSON.stringify(MARKER)})) }`); assert.equal(r.ok, true); return r.rows.length; }
async function subjectsUnder(s, prefix) { const r = await clientFor(s).query(`SELECT DISTINCT ?s WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } FILTER(STRSTARTS(STR(?s), ${JSON.stringify(prefix)})) }`); assert.equal(r.ok, true); return r.rows.length; }

test('X10 THE TOMBSTONE IS AN ALLOW-LIST: with extra triples planted on the post (a made-up predicate, NS opId, NS onBehalfOf, an attachment node), post.redact leaves the post node with EXACTLY the tombstone triples, no node under E/<id>/attachment/, and the marker in no triple anywhere', { skip: SKIP }, async () => {
  await stack(withMarkerBoard(['m-a', 'm-b']), async (s) => {
    for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
    const iri = `${ENTITY}${idOf('m-a')}`; const before = await nodeTriples_(s, iri);
    await s.killExecutor();
    const att = `${iri}/attachment/0`;
    const upd = [
      `INSERT DATA { <${iri}> <https://example.org/a-predicate-nobody-listed> "${MARKER} unknown" . <${iri}> <${NSV}opId> "${MARKER} op" . <${iri}> <${NSV}onBehalfOf> "${MARKER} delegate" . <${att}> <${NSV}attachmentOf> <${iri}> . <${att}> <${NSV}attachmentIndex> "0"^^<http://www.w3.org/2001/XMLSchema#integer> . <${att}> <${SCHEMA_}name> "${MARKER}.png" . }`,
    ];
    const ins = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(s.store)}); [s.update(u) for u in ${JSON.stringify(upd)}]`], { encoding: 'utf8' });
    assert.equal(ins.status, 0, `fixture: planting the extra triples: ${ins.stderr}`);
    await s.startExecutor();
    const planted = await nodeTriples_(s, iri);
    assert.ok(planted['https://example.org/a-predicate-nobody-listed'] && planted[`${NSV}opId`] && planted[`${NSV}onBehalfOf`], 'fixture: the extra triples are on the post');
    assert.equal(await subjectsUnder(s, `${iri}/attachment/`), 1, 'fixture: the attachment node exists');
    const r = await clientFor(s).update(redactIntention('m-a'));
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    const t = await nodeTriples_(s, iri);
    assert.deepEqual(Object.keys(t).sort(), [RDF_TYPE, `${NSV}postSeq`, 'urn:ex:recordedBy', `${NSV}redactedBy`].sort(), `ONLY the tombstone triples remain (an allow-list): ${JSON.stringify(t)}`);
    assert.deepEqual(t[`${NSV}postSeq`], before[`${NSV}postSeq`]); assert.deepEqual(t['urn:ex:recordedBy'], before['urn:ex:recordedBy']);
    assert.equal(await subjectsUnder(s, `${iri}/attachment/`), 0, 'the attachment nodes went with the post');
    const left = await markerRows(s);
    assert.equal(left, 2, `the marker survives only on the unrelated post m-b (its body and mention): ${left}`);
  });
});

test('X11 AMBIGUOUS ATTACHMENT OWNERSHIP REFUSES, in BOTH directions, atomically: a node under E/<id>/attachment/ whose attachmentOf names ANOTHER post, one under the prefix with NO attachmentOf, and one OUTSIDE the prefix that names THIS post each make post.redact a named refusal (not APPLIED) that changes no triple at all', { skip: SKIP }, async () => {
  const variants = [
    ['under the prefix, names another post', (iri, other) => ({ node: `${iri}/attachment/0`, extra: `<${iri}/attachment/0> <${NSV}attachmentOf> <${other}> .` })],
    ['under the prefix, names no post', (iri) => ({ node: `${iri}/attachment/0`, extra: '' })],
    ['OUTSIDE the prefix, names this post', (iri) => ({ node: `${ENTITY}stray-attachment-of-${iri.slice(ENTITY.length)}`, extra: `<${ENTITY}stray-attachment-of-${iri.slice(ENTITY.length)}> <${NSV}attachmentOf> <${iri}> .` })],
  ];
  for (const [label, make] of variants) {
    await stack(withMarkerBoard(['m-a', 'm-b']), async (s) => {
      for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
      const iri = `${ENTITY}${idOf('m-a')}`, other = `${ENTITY}${idOf('m-b')}`; const { node, extra } = make(iri, other);
      await s.killExecutor();
      const ins = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(s.store)}); s.update(${JSON.stringify(`INSERT DATA { <${node}> <${SCHEMA_}name> "${MARKER}-ambiguous.png" . ${extra} }`)})`], { encoding: 'utf8' });
      assert.equal(ins.status, 0, `fixture (${label}): ${ins.stderr}`);
      await s.startExecutor();
      const snap = async () => JSON.stringify({ post: await nodeTriples_(s, iri), other: await nodeTriples_(s, other), amb: await nodeTriples_(s, node), marker: await markerRows(s) });
      const before = await snap();
      const r = await clientFor(s).update(redactIntention('m-a'));
      assert.notEqual(r.outcome, 'APPLIED', `${label}: an attachment node that does not prove its owner both ways must make the redaction REFUSE: ${JSON.stringify(r)}`);
      assert.equal(await snap(), before, `${label}: NO triple changed (atomic refusal): the post, the other post, the ambiguous node and the marker rows are all as they were`);
    });
  }
});

test('X12 A NEAR-PREFIX NAME IS NOT INSIDE THE PREFIX: a node named E/<id>/attachmentX (no slash after `attachment`) that names THIS post is OUTSIDE E/<id>/attachment/ and so makes the redaction REFUSE atomically, exactly like any other claimant outside the prefix; it must not be deleted as if it were an owned attachment', { skip: SKIP }, async () => {
  const variants = [
    ['near-prefix `attachmentX`, names this post', (iri) => ({ node: `${iri}/attachmentX`, extra: `<${iri}/attachmentX> <${NSV}attachmentOf> <${iri}> .` })],
    ['near-prefix `attachment` with no suffix, names this post', (iri) => ({ node: `${iri}/attachment`, extra: `<${iri}/attachment> <${NSV}attachmentOf> <${iri}> .` })],
  ];
  for (const [label, make] of variants) {
    await stack(withMarkerBoard(['m-a', 'm-b']), async (s) => {
      for (const m of ['m-a', 'm-b']) assert.equal((await publish(s.base, m)).body.status, 'published');
      const iri = `${ENTITY}${idOf('m-a')}`, other = `${ENTITY}${idOf('m-b')}`; const { node, extra } = make(iri, other);
      await s.killExecutor();
      const ins = spawnSync(PY, ['-c', `import pyoxigraph as ox; s = ox.Store(${JSON.stringify(s.store)}); s.update(${JSON.stringify(`INSERT DATA { <${node}> <${SCHEMA_}name> "${MARKER}-ambiguous.png" . ${extra} }`)})`], { encoding: 'utf8' });
      assert.equal(ins.status, 0, `fixture (${label}): ${ins.stderr}`);
      await s.startExecutor();
      const snap = async () => JSON.stringify({ post: await nodeTriples_(s, iri), other: await nodeTriples_(s, other), amb: await nodeTriples_(s, node), marker: await markerRows(s) });
      const before = await snap();
      const r = await clientFor(s).update(redactIntention('m-a'));
      assert.notEqual(r.outcome, 'APPLIED', `${label}: an attachment node that does not prove its owner both ways must make the redaction REFUSE: ${JSON.stringify(r)}`);
      assert.equal(await snap(), before, `${label}: NO triple changed (atomic refusal): the post, the other post, the ambiguous node and the marker rows are all as they were`);
    });
  }
});

test('C1 A CLIENT FOR THE WRONG DATASET WRITES NOTHING: a unit-1 write (memory.create) and post.redact both come back REJECTED and not one write attempt reaches the store', { skip: SKIP }, async () => {
  await stack(withMarkerBoard(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const wrong = createGraphClient({ baseUrl: s.proxy.url, expectedDatasetId: 'some-other-dataset' });
    const before = s.proxy.attempted;
    const mem = await wrong.update({ kind: 'memory.create', opId: 'urn:ex:op/fence/mem-wrong', actor: 'urn:ex:seat/bob', memory: { iri: 'https://scrumboard.local/memory/fence-wrong', identifier: 'fw', name: 'must not exist', owner: 'https://scrumboard.local/person/bob' }, versions: [] });
    assert.equal(mem.outcome, 'REJECTED', JSON.stringify(mem));
    const red = await wrong.update(redactIntention('m-a'));
    assert.equal(red.outcome, 'REJECTED', JSON.stringify(red));
    assert.equal(s.proxy.attempted, before, 'not one /update attempt reached the store');
    assert.equal((await markerRows(s)) >= 1, true, 'the post is untouched');
    const none = await clientFor(s).query('SELECT ?p ?o WHERE { <https://scrumboard.local/memory/fence-wrong> ?p ?o }');
    assert.equal(none.rows.length, 0, 'and the memory was not created');
  });
});
test('C2 AN UNREADABLE IDENTITY IS UNAVAILABLE WITH ZERO WRITE ATTEMPTS: when the store\'s identity cannot be read, neither caller sends a write', { skip: SKIP }, async () => {
  await stack(withMarkerBoard(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const fresh = createGraphClient({ baseUrl: s.proxy.url, expectedDatasetId: DSID });   // a NEW client: nothing confirmed yet
    s.proxy.down = true; const before = s.proxy.attempted;
    const mem = await fresh.update({ kind: 'memory.create', opId: 'urn:ex:op/fence/mem-down', actor: 'urn:ex:seat/bob', memory: { iri: 'https://scrumboard.local/memory/fence-down', identifier: 'fd', name: 'must not exist', owner: 'https://scrumboard.local/person/bob' }, versions: [] });
    assert.equal(mem.outcome, 'UNAVAILABLE', JSON.stringify(mem));
    const fresh2 = createGraphClient({ baseUrl: s.proxy.url, expectedDatasetId: DSID });
    const red = await fresh2.update(redactIntention('m-a'));
    assert.equal(red.outcome, 'UNAVAILABLE', JSON.stringify(red));
    assert.equal(s.proxy.attempted, before, 'no write attempt was made while the identity was unreadable');
    s.proxy.down = false;
    assert.equal((await markerRows(s)) >= 1, true, 'the post is untouched');
  });
});
test('C3 THE RIGHT DATASET APPLIES (control), through the same fence: a unit-1 write and a redaction both APPLY, and a client with NO expected dataset still writes', { skip: SKIP }, async () => {
  await stack(withMarkerBoard(['m-a']), async (s) => {
    assert.equal((await publish(s.base, 'm-a')).body.status, 'published');
    const right = createGraphClient({ baseUrl: s.proxy.url, expectedDatasetId: DSID });
    const mem = await right.update({ kind: 'memory.create', opId: 'urn:ex:op/fence/mem-right', actor: 'urn:ex:seat/bob', memory: { iri: 'https://scrumboard.local/memory/fence-right', identifier: 'fr', name: 'created', owner: 'https://scrumboard.local/person/bob' }, versions: [] });
    assert.equal(mem.outcome, 'APPLIED', JSON.stringify(mem));
    const noExpect = createGraphClient({ baseUrl: s.proxy.url });
    const mem2 = await noExpect.update({ kind: 'memory.create', opId: 'urn:ex:op/fence/mem-noexpect', actor: 'urn:ex:seat/bob', memory: { iri: 'https://scrumboard.local/memory/fence-noexpect', identifier: 'fn', name: 'created without an expectation', owner: 'https://scrumboard.local/person/bob' }, versions: [] });
    assert.equal(mem2.outcome, 'APPLIED', `no expected dataset id means no fence, exactly as before: ${JSON.stringify(mem2)}`);
    assert.equal((await right.update(redactIntention('m-a'))).outcome, 'APPLIED');
    assert.equal(await markerRows(s), 0);
  });
});
