/**
 * #1747 step 2 — the capture tool (scripts/cutover-capture-1629.mjs, the builder's 9ad05d3) against interface v0 on #1747 and
 * the builder's stated codes (46481). ROW AUTHOR's rows. A REAL stopped executor store; the tool reads FILES only.
 *   C0       CONTROL: CAPTURED <sha>; the manifest's bytes hash to the printed sha, pass the CLOSED schema steps 3 and 4
 *            read, list the store's files exactly, carry the identity's fields and the document's census
 *   C1..C7   each refusal, before anything is written: OUT_EXISTS (the old file byte-unchanged), NOT_STOPPED, NOT_SOURCE,
 *            STORE_SHAPE (a subdirectory), STORE_OPEN (a held file), UNSTABLE (a document and a store file changed between
 *            the passes, via the builder's seam SCRUM_CUTOVER_CAPTURE_BETWEEN_PASSES)
 * The chain (capture → step 3 → step 4 → READY on one fixture) is the S2 row in tests/cutover-import-step4-1747.test.mjs,
 * which owns that fixture. Known, stated limit (the builder's): lsof sees only processes this user can see.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { captureProblem } from '../scripts/cutover-capture-schema-1629.mjs';
import { contentDigest, MAX_BUCKET_QUADS } from '../scripts/cutover-content-digest-1629.mjs';
import http from 'node:http';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(REPO, 'scripts', 'cutover-capture-1629.mjs');
const T = { skip: HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)', timeout: 120000 };
const DS = 'cap1747';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const owned = new Set();
after(() => { for (const d of owned) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); owned.add(d); return d; };
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => resolve({ status, out, err }));
});
const DOC = { '@graph': [], 'scrum:meta': {
  nextPostSeq: 40250, postSeqEpoch: 'e-cap-1747', seatStates: [],
  postReservations: { k1: { createdAt: '2026-10-06T01:00:01.000Z', postId: 'a', postSeq: 40001 }, k2: { createdAt: '2026-10-06T01:00:02.000Z', postId: 'b', postSeq: 40002 } },
  announcementOutbox: {
    origins: { m1: { mode: 'legacy' }, m2: { mode: 'publisher' }, m3: { mode: 'legacy' } },
    entries: { 'm1:claim': { status: 'pending' }, 'm2:claim': { status: 'published' }, 'm3:release': { status: 'pending' } },
  },
} };

/** a stopped source: a REAL executor store, its last /health saved as the identity, plus a document and an outbox manifest */
async function stopped() {
  const dir = tmp('cap1747-');
  const store = tmpStore('cap1747-store-'); owned.add(store);
  const x = await startExecutor({ store, datasetId: DS, create: true });
  const health = await (await fetch(`${x.baseUrl}/health`)).json();
  await killExecutor(x);
  const identity = path.join(dir, 'identity.json'); fs.writeFileSync(identity, JSON.stringify(health));
  const doc = path.join(dir, 'board-data.json'); fs.writeFileSync(doc, JSON.stringify(DOC, null, 2));
  const outbox = path.join(dir, 'entries.csv'); fs.writeFileSync(outbox, 'obligationId,kind,createdAt,matchedPostId,class,note\n');
  return { dir, store, identity, health, doc, outbox, out: path.join(dir, 'capture.json') };
}
const args = (s, over = {}) => ['--source-store', over.store ?? s.store, '--board-data', s.doc, '--outbox-manifest', s.outbox, '--identity', over.identity ?? s.identity, '--out', over.out ?? s.out];
function expectRefused(r, code, s, ctx) {
  assert.equal(r.status, 1, `${ctx}: exit 1 (${r.status}: ${r.out.slice(-200)} ${r.err.slice(-200)})`);
  assert.match(r.out, new RegExp(`^REFUSED ${code} `, 'm'), `${ctx}: REFUSED ${code} (${r.out.slice(-200)})`);
  assert.ok(!/^CAPTURED /m.test(r.out), `${ctx}: never CAPTURED`);
  if (s) assert.equal(fs.existsSync(s.out), false, `${ctx}: nothing written`);
}

test('#1747 (C0 CONTROL) a stopped source is CAPTURED: the bytes hash to the printed sha, pass the closed schema, list the store exactly, carry the identity and the census', T, async () => {
  const s = await stopped();
  const r = await run(args(s));
  assert.equal(r.status, 0, `CAPTURED (${r.out} ${r.err.slice(-300)})`);
  const printed = r.out.match(/^CAPTURED ([0-9a-f]{64})$/m)?.[1];
  const bytes = fs.readFileSync(s.out);
  assert.equal(printed, sha(bytes), 'the printed sha is the sha of the bytes written');
  const m = JSON.parse(bytes);
  assert.equal(captureProblem(m), null, 'the manifest passes the CLOSED schema steps 3 and 4 read');
  const files = fs.readdirSync(s.store).sort().map((n) => { const b = fs.readFileSync(path.join(s.store, n)); return { name: n, size: b.length, sha256: sha(b) }; });
  assert.deepEqual(m.files, files, 'the store\'s files, exactly (name, size, sha256)');
  assert.equal(m.sourceStore, fs.realpathSync(s.store), 'the source store, by realpath');
  assert.deepEqual([m.datasetId, m.incarnation, m.epoch, m.commitSeq], [s.health.datasetId, s.health.incarnation, s.health.epoch, s.health.commitSeq], 'the identity\'s fields');
  assert.equal(m.documentSha256, sha(fs.readFileSync(s.doc)), 'the document\'s sha');
  assert.equal(m.outboxManifestSha256, sha(fs.readFileSync(s.outbox)), 'the outbox manifest\'s sha');
  assert.deepEqual(m.census, { postReservations: 2, outboxOrigins: 3, outboxOriginsByMode: { legacy: 2, publisher: 1 }, outboxEntries: 3, outboxEntriesByStatus: { pending: 2, published: 1 }, nextPostSeq: 40250, postSeqEpoch: 'e-cap-1747', seatStates: 0 }, 'the document census');
  const at = Date.parse(m.capturedAt);
  assert.ok(Number.isFinite(at) && at <= Date.now() && at > Date.now() - 120000, `capturedAt is now (${m.capturedAt})`);
});
test('#1747 (C1) --out already exists → REFUSED OUT_EXISTS, the old file byte-unchanged', T, async () => {
  const s = await stopped();
  fs.writeFileSync(s.out, 'an earlier capture');
  const r = await run(args(s));
  expectRefused(r, 'OUT_EXISTS', null, 'an existing --out');
  assert.equal(fs.readFileSync(s.out, 'utf8'), 'an earlier capture', 'never overwritten');
});
for (const k of ['datasetId', 'incarnation', 'epoch', 'commitSeq']) {
  test(`#1747 (C2) an identity with no ${k} → REFUSED NOT_STOPPED, nothing written`, T, async () => {
    const s = await stopped();
    const id = { ...s.health }; delete id[k]; fs.writeFileSync(s.identity, JSON.stringify(id));
    expectRefused(await run(args(s)), 'NOT_STOPPED', s, `no ${k}`);
  });
}
test('#1747 (C3) an identity whose storeHome is ANOTHER store (some other executor\'s /health) → REFUSED NOT_SOURCE, nothing written', T, async () => {
  const s = await stopped();
  fs.writeFileSync(s.identity, JSON.stringify({ ...s.health, storeHome: tmp('cap1747-other-') }));
  expectRefused(await run(args(s)), 'NOT_SOURCE', s, 'another store\'s identity');
});
test('#1747 (C4) a subdirectory in the source store → REFUSED STORE_SHAPE, nothing written', T, async () => {
  const s = await stopped();
  fs.mkdirSync(path.join(s.store, 'nested'));
  expectRefused(await run(args(s)), 'STORE_SHAPE', s, 'a subdirectory');
});
test('#1747 (C5) a process holding a source store file open → REFUSED STORE_OPEN naming it, nothing written', T, async () => {
  const s = await stopped();
  const f = fs.readdirSync(s.store).sort()[0];
  const fd = fs.openSync(path.join(s.store, f), 'r');
  try {
    const r = await run(args(s));
    expectRefused(r, 'STORE_OPEN', s, 'a held file');
    assert.match(r.out, new RegExp(`pid [^\\n]*\\b${process.pid}\\b`), 'it names the holder');
  } finally { fs.closeSync(fd); }
  const ok = await run(args(s));
  assert.equal(ok.status, 0, `CONTROL: released, the same source is CAPTURED (${ok.out})`);
});
for (const [what, target] of [['the document', (s) => s.doc], ['a source store file', (s) => path.join(s.store, fs.readdirSync(s.store).sort()[0])]]) {
  test(`#1747 (C6) ${what} changed BETWEEN the two passes → REFUSED UNSTABLE, nothing written`, T, async () => {
    const s = await stopped();
    expectRefused(await run(args(s), { SCRUM_CUTOVER_CAPTURE_BETWEEN_PASSES: target(s) }), 'UNSTABLE', s, `${what} changed`);
  });
}
test('#1747 (C7) the outbox manifest changed BETWEEN the passes → REFUSED UNSTABLE, nothing written', T, async () => {
  const s = await stopped();
  expectRefused(await run(args(s), { SCRUM_CUTOVER_CAPTURE_BETWEEN_PASSES: s.outbox }), 'UNSTABLE', s, 'the outbox manifest changed');
});
test('#1747 (C8, r9) the CONTENT PIN: two captures of an unchanged source record the same contentSha256, the shared digest of the store; a RAW write (commitSeq unmoved) changes it', T, async () => {
  const s = await stopped();
  const a = await run(args(s));
  assert.equal(a.status, 0, `CAPTURED (${a.out} ${a.err.slice(-300)})`);
  const m1 = JSON.parse(fs.readFileSync(s.out));
  const out2 = path.join(s.dir, 'capture-2.json');
  assert.equal((await run(args(s, { out: out2 }))).status, 0, 'CONTROL: a second capture of the unchanged source is CAPTURED');
  assert.equal(JSON.parse(fs.readFileSync(out2)).contentSha256, m1.contentSha256, 'CONTROL: the same content, the same digest');
  const ro = await startExecutor({ store: s.store, datasetId: DS, extraArgs: ['--read-only'] });
  let d; try { d = await contentDigest(ro.baseUrl); } finally { await killExecutor(ro); }
  assert.equal(m1.contentSha256, d.sha256, 'the recorded digest is the shared digest of THIS store');
  const x = await startExecutor({ store: s.store, datasetId: DS });
  let h;
  try {
    const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/cap1747-c8-${process.pid}`, 'x-epoch': String((await (await fetch(`${x.baseUrl}/health`)).json()).epoch) }, body: 'INSERT DATA { <urn:ex:test/c8> <urn:ex:test/p> "raw" }' });
    assert.equal(r.status, 200, 'PRECONDITION: the raw write applied');
    h = await (await fetch(`${x.baseUrl}/health`)).json();
  } finally { await killExecutor(x); }
  assert.equal(String(h.commitSeq), String(s.health.commitSeq), 'PRECONDITION: a raw write does not move commitSeq');
  fs.writeFileSync(s.identity, JSON.stringify(h));
  const out3 = path.join(s.dir, 'capture-3.json');
  assert.equal((await run(args(s, { out: out3 }))).status, 0, 'the changed source is CAPTURED');
  assert.notEqual(JSON.parse(fs.readFileSync(out3)).contentSha256, m1.contentSha256, 'the raw write changed the recorded digest');
});

// ── r10 (#122 re-review at 548bbf0, 46812): the three capture/digest guards no row killed (sabotages C, D, E) ──
/** a test-only proxy in front of a real executor: it forwards everything, and `rewrite(opId, json)` may change a /query answer */
async function digestProxy(target, rewrite) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const op = String(req.headers['x-op-id'] || ''); seen.push(op);
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    const r = await fetch(`${target}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
    let out = Buffer.from(await r.arrayBuffer());
    if (req.url.startsWith('/query') && r.ok) { const j = JSON.parse(out.toString('utf8')); const k = rewrite(op, j); if (k) out = Buffer.from(JSON.stringify(k)); }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(out);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}
const withCount = (j, n) => ({ ...j, results: { bindings: [{ ...j.results.bindings[0], n: { ...(j.results.bindings[0]?.n || { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }), value: String(n) } }] } });
async function served(fn) {
  const s = await stopped();
  const x = await startExecutor({ store: s.store, datasetId: DS });
  try { return await fn(s, x); } finally { await killExecutor(x); }
}
test('#1747 (C10, r10, sabotage E) a BLANK-NODE bucket over the quad limit refuses DIGEST_TOO_LARGE before it is fetched (it cannot be split)', T, async () => {
  await served(async (s, x) => {
    const px = await digestProxy(x.baseUrl, (op, j) => (/\/count\/_\/\d+$/.test(op) ? withCount(j, MAX_BUCKET_QUADS + 1) : null));
    let err = null;
    try { await contentDigest(px.url); } catch (e) { err = e; } finally { await px.close(); }
    assert.equal(err?.code, 'DIGEST_TOO_LARGE', `refused DIGEST_TOO_LARGE (${err?.message})`);
    assert.match(String(err?.message), /blank-node/, 'naming the blank-node bucket');
    assert.ok(!px.seen.some((o) => /\/bucket\//.test(o)), `no bucket was fetched (${px.seen.filter((o) => /\/bucket\//.test(o)).join(', ')})`);
  });
});
test('#1747 (C10b, r10, sabotage E) a single subject prefix still over the limit at DEPTH 3 refuses DIGEST_TOO_LARGE before it is fetched; the shallower buckets were split, not fetched', T, async () => {
  await served(async (s, x) => {
    const px = await digestProxy(x.baseUrl, (op, j) => (/\/count\/(0|00|000)\/\d+$/.test(op) ? withCount(j, MAX_BUCKET_QUADS + 1) : null));
    let err = null;
    try { await contentDigest(px.url); } catch (e) { err = e; } finally { await px.close(); }
    assert.equal(err?.code, 'DIGEST_TOO_LARGE', `refused DIGEST_TOO_LARGE (${err?.message})`);
    assert.match(String(err?.message), /bucket 000 /, 'naming the depth-3 bucket');
    assert.ok(!px.seen.some((o) => /\/bucket\/0/.test(o)), `none of 0, 00, 000 was fetched (${px.seen.filter((o) => /\/bucket\/0/.test(o)).join(', ')})`);
    assert.ok(px.seen.some((o) => /\/count\/00\/\d+$/.test(o)) && px.seen.some((o) => /\/count\/000\/\d+$/.test(o)), 'CONTROL: the over-limit buckets were SPLIT (0 into 00, 00 into 000), not refused at depth 1');
  });
});
test('#1747 (C11, r10, sabotage C) when the buckets do not cover every quad (the total count says one more), the digest REFUSES; it never returns a digest of a subset', T, async () => {
  await served(async (s, x) => {
    const ok = await contentDigest(x.baseUrl);
    assert.match(ok.sha256, /^[0-9a-f]{64}$/, 'CONTROL: the same store digests directly');
    const px = await digestProxy(x.baseUrl, (op, j) => (/\/count$/.test(op) ? withCount(j, Number(j.results.bindings[0].n.value) + 1) : null));
    let err = null, got = null;
    try { got = await contentDigest(px.url); } catch (e) { err = e; } finally { await px.close(); }
    assert.equal(got, null, `no digest returned (${JSON.stringify(got)})`);
    assert.match(String(err?.message), /buckets cover \d+ quads, the store holds \d+/, `refused by the coverage check (${err?.message})`);
  });
});
test('#1747 (C9, r10, sabotage D) a process that opens a source store file DURING the capture (after the first open-file check) → REFUSED STORE_OPEN by the LATE check, naming it; nothing written', T, async () => {
  const s = await stopped();
  const fifo = path.join(s.dir, 'between.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'PRECONDITION: mkfifo');
  const victim = path.join(s.store, fs.readdirSync(s.store).sort()[0]);
  // the helper blocks on the FIFO until the capture reaches its between-passes seam, then opens a store file and holds it.
  // The capture's seam write completes as soon as the helper opens the FIFO; the helper's file open takes well under a
  // millisecond, while the capture's second pass plus an lsof launch take far longer: that ordering is the row's margin.
  const helper = spawn(process.execPath, ['-e', `const fs=require('fs');const f=fs.openSync(process.argv[1],'r');const h=fs.openSync(process.argv[2],'r');process.stdout.write('held '+process.pid+'\\n');setInterval(()=>{},1000);`, fifo, victim], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const r = await run(args(s), { SCRUM_CUTOVER_CAPTURE_BETWEEN_PASSES: fifo });
    expectRefused(r, 'STORE_OPEN', s, 'a file opened during the capture');
    assert.match(r.out, /during the capture/, 'by the LATE check (the early one says nothing about "during")');
    assert.match(r.out, new RegExp(`\\b${helper.pid}\\b`), 'naming the holder');
  } finally { helper.kill('SIGKILL'); }
});
test('#1747 (C12, r10, finding 5) an identity file whose commitSeq is NOT the stopped store\'s (one higher) → REFUSED NOT_SOURCE naming commitSeq; nothing written', T, async () => {
  const s = await stopped();
  fs.writeFileSync(s.identity, JSON.stringify({ ...s.health, commitSeq: String(Number(s.health.commitSeq) + 1) }));
  const r = await run(args(s));
  expectRefused(r, 'NOT_SOURCE', s, 'an identity that names another position');
  assert.match(r.out, /commitSeq/, `naming the field that differs (${r.out.slice(-240)})`);
});
