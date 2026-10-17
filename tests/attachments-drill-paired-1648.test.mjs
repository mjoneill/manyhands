/**
 * #1648 — the attachment drill's EXECUTOR SOURCE and its REFERENCE SET. Builder rows, written for the review of 798a26b.
 *
 * Two findings: a recursive copy of a store directory is not a consistent executor snapshot (so a raw directory must be
 * refused, and a paired capture must come from POST /checkpoint under the fence); and only post attachment nodes were
 * enumerated, while a card's attachments live in its entityJson in the bookkeeping graph.
 *
 * Every row runs against a SCRATCH executor on a temp store (graph-executor/executor.py through the shared helper),
 * seeded with one post attachment (an attachmentOf node) and one card attachment (an entityJson `attachments` entry).
 *
 *   D1  a raw directory as --source-executor is refused as UNSAFE: exit 2, no `check`, nothing under --scratch.
 *   D1b an executor URL that does not answer is refused the same way.
 *   D2  a CLEAN run by URL: exit 0, check.ok, paired: true with the checkpoint's commitSeq/quads/datasetId/takenAt,
 *       and BOTH reference ids enumerated, one from each shape.
 *   D3  the same with one file deleted from the RESTORED copy: a named failure for that id.
 *   D4  only the CARD-held file missing from the source: the capture degrades and the check fails, naming that exact id.
 *   D5  a VERIFIED graph-store backup directory as the source: paired: false, kept apart from check.ok (which is true),
 *       and the card id is still enumerated.
 *   D5b a backup directory that does not verify (one byte changed) is refused as unsafe.
 *
 * NOT covered: an https executor; a source executor that is written to DURING the drill (the checkpoint is taken inside
 * the executor's write lock, which these rows do not exercise); any reference shape other than the two named above.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRILL = path.join(REPO, 'scripts', 'attachments-drill.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const BK = 'urn:scrum:bookkeeping:executor';
const POST_ID = '11111111-1111-4111-8111-111111111111.txt';
const CARD_ID = '22222222-2222-4222-8222-222222222222.txt';
const FILES = { [POST_ID]: 'post-held bytes', [CARD_ID]: 'card-held bytes, longer' };

const temps = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
let x = null; let store = null;

before(async () => {
  if (SKIP) return;
  store = tmpStore('drill1648-store-'); fs.rmSync(store, { recursive: true }); temps.push(store, `${store}.checkpoints`);
  x = await startExecutor({ store, datasetId: 'drill-1648', create: true });
  const card = JSON.stringify({ '@id': 'card-1', '@type': 'Card', title: 'a card with a file', attachments: [{ id: CARD_ID, name: 'c.txt', mime: 'text/plain', size: Buffer.byteLength(FILES[CARD_ID]) }] });
  const sparql = `INSERT DATA {
    <https://scrumboard.local/entity/post-1-att-0> <https://scrumboard.local/ns#attachmentOf> <https://scrumboard.local/entity/post-1> ;
      <https://schema.org/identifier> "${POST_ID}" ; <https://schema.org/contentSize> "${Buffer.byteLength(FILES[POST_ID])}" .
    GRAPH <${BK}> { <https://scrumboard.local/entity/card-1> <https://scrumboard.local/ns#entityJson> ${JSON.stringify(card)} } }`;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:op:drill-1648-seed' }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the scratch executor took the seed: ${await r.text()}`);
});
after(async () => {
  if (x) await killExecutor(x);
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

function attachments(skip = []) {
  const dir = mk('drill1648-att-');
  for (const [id, text] of Object.entries(FILES)) if (!skip.includes(id)) fs.writeFileSync(path.join(dir, id), text);
  return dir;
}
const listing = (d) => fs.readdirSync(d, { recursive: true }).sort();
function drill(att, source, scratch = mk('drill1648-scr-')) {
  const r = spawnSync(process.execPath, [DRILL, '--source-attachments', att, '--source-executor', source, '--scratch', scratch, '--python', PY], { encoding: 'utf8', timeout: 120000 });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch { /* left null: a row says whether it expects one */ }
  return { ...r, json, scratch };
}
const refIds = (scratch) => JSON.parse(fs.readFileSync(path.join(scratch, 'capture', 'refs.json'), 'utf8')).map((r) => r.id).sort();

test('#1648 (D1) a raw directory as --source-executor is refused as UNSAFE: exit 2, no check, nothing under --scratch', { skip: SKIP, timeout: 60000 }, () => {
  const raw = mk('drill1648-raw-'); fs.writeFileSync(path.join(raw, 'CURRENT'), 'looks like a store');
  const r = drill(attachments(), raw);
  assert.equal(r.status, 2, `refused (${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.ok(!/"check"/.test(r.stdout), `no check is printed: ${r.stdout.slice(0, 120)}`);
  assert.match(r.stderr, /unsafe/i, 'and the message says why');
  assert.deepEqual(listing(r.scratch), [], 'nothing was created under --scratch');
});

test('#1648 (D1b) an executor URL that does not answer is refused the same way', { skip: SKIP, timeout: 60000 }, () => {
  const r = drill(attachments(), 'http://127.0.0.1:9/');
  assert.equal(r.status, 2, `refused (${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.ok(!/"check"/.test(r.stdout));
  assert.match(r.stderr, /does not answer/);
  assert.deepEqual(listing(r.scratch), []);
});

test('#1648 (D2) a CLEAN run by URL: exit 0, check.ok, paired with the checkpoint, and both reference shapes enumerated', { skip: SKIP, timeout: 120000 }, () => {
  const r = drill(attachments(), x.baseUrl);
  assert.ok(r.json, `one JSON object on stdout: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 0, `exit 0: ${JSON.stringify(r.json.check?.failures)} ${r.json.error}`);
  assert.equal(r.json.check.ok, true);
  assert.equal(r.json.paired, true, 'a URL source is a paired capture');
  for (const k of ['commitSeq', 'quads', 'datasetId', 'takenAt']) assert.ok(r.json.pairing?.[k] !== undefined && r.json.pairing?.[k] !== null, `the pairing records ${k}: ${JSON.stringify(r.json.pairing)}`);
  assert.equal(r.json.pairing.datasetId, 'drill-1648');
  assert.deepEqual(refIds(r.scratch), [POST_ID, CARD_ID].sort(), 'both the post-held and the card-held id are references');
  assert.deepEqual(r.json.references?.shapes, { attachmentOf: 1, entityJson: 1 }, 'one from each shape');
});

test('#1648 (D3) the same with one file deleted from the RESTORED copy: a named failure for that id', { skip: SKIP, timeout: 120000 }, async () => {
  const { resolveSource, runDrill } = await import(pathToFileURL(DRILL).href);
  const source = await resolveSource(x.baseUrl, { python: PY });
  const report = await runDrill({ sourceAttachments: attachments(), source, scratch: mk('drill1648-scr-'), python: PY,
    hooks: { afterRestore: (dir) => fs.rmSync(path.join(dir, POST_ID)) } });
  assert.equal(report.check.ok, false);
  assert.ok(report.check.failures.some((f) => f.code === 'file-missing' && f.id === POST_ID), `file-missing names ${POST_ID}: ${JSON.stringify(report.check.failures)}`);
  assert.equal(report.paired, true, 'pairing is reported apart from the failed check');
});

test('#1648 (D4) only the CARD-held file missing from the source: the capture degrades and the check fails, naming that exact id', { skip: SKIP, timeout: 120000 }, () => {
  const r = drill(attachments([CARD_ID]), x.baseUrl);
  assert.ok(r.json, `one JSON object: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 1);
  assert.equal(r.json.capture.status, 'DEGRADED');
  assert.deepEqual(r.json.capture.dangling, [CARD_ID], 'the dangling set is exactly the card-held id');
  assert.deepEqual(r.json.check.failures.filter((f) => f.code === 'ref-unresolved').map((f) => f.id), [CARD_ID], 'and the check names it');
});

test('#1648 (D5) a VERIFIED backup directory as the source: paired: false, apart from check.ok (true), card id still enumerated', { skip: SKIP, timeout: 120000 }, async () => {
  const { backupStore } = await import(pathToFileURL(path.join(REPO, 'scripts', 'graph-store-backup.mjs')).href);
  const b = await backupStore({ url: x.baseUrl, dest: mk('drill1648-bk-'), python: PY });
  assert.equal(b.ok, true, `PRECONDITION: a verified backup: ${JSON.stringify(b.checks)}`);
  const r = drill(attachments(), b.path);
  assert.ok(r.json, `one JSON object: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 300)}`);
  assert.equal(r.json.check.ok, true, `the byte check can pass: ${JSON.stringify(r.json.check.failures)}`);
  assert.equal(r.status, 0, 'exit 0 follows check.ok, as the F8 rows require');
  assert.equal(r.json.paired, false, 'but an offline backup is NOT a paired capture');
  assert.ok(r.json.pairing?.commitSeq !== undefined && r.json.pairing?.backupDir === b.path, `and what it is is recorded: ${JSON.stringify(r.json.pairing)}`);
  assert.deepEqual(refIds(r.scratch), [POST_ID, CARD_ID].sort(), 'the card-held id is enumerated from the backup too');
});

test('#1648 (D5b) a backup directory that does not verify (one byte changed) is refused as unsafe', { skip: SKIP, timeout: 120000 }, async () => {
  const { backupStore } = await import(pathToFileURL(path.join(REPO, 'scripts', 'graph-store-backup.mjs')).href);
  const b = await backupStore({ url: x.baseUrl, dest: mk('drill1648-bk-'), python: PY });
  const m = JSON.parse(fs.readFileSync(path.join(b.path, 'backup-manifest.json'), 'utf8'));
  const victim = path.join(b.path, m.files.find((f) => f.size > 0).name);
  const buf = fs.readFileSync(victim); buf[0] ^= 0xff; fs.writeFileSync(victim, buf);
  const r = drill(attachments(), b.path);
  assert.equal(r.status, 2, `refused (${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /does NOT verify/);
  assert.deepEqual(listing(r.scratch), []);
});
