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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { captureProblem } from '../scripts/cutover-capture-schema-1629.mjs';
import { contentDigest } from '../scripts/cutover-content-digest-1629.mjs';

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
