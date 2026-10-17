/**
 * #1648 — THE DRILL'S SOURCE AND ITS REPORT, on a REAL scratch executor. TEST AUTHOR's; written after the reviewer's findings on the first build
 * and the builder's plan on the card (commons 43078 to 43081), and before reading the fixes.
 *
 * WHAT THE CONTRACT IS (from the thread, not from the code):
 *   node scripts/attachments-drill.mjs --source-attachments <dir> --source-executor <URL | verified backup dir> --scratch <empty dir> [--python PY]
 *   - refusals, in this order, are exit 2 with NOTHING on stdout and nothing created under --scratch: a missing flag; a --scratch that is not an
 *     existing empty directory; an UNSAFE executor source. A recursive copy of an arbitrary store directory is not a consistent snapshot, so the only
 *     sources are an executor URL that answers, and a directory that is a VERIFIED graph-store backup.
 *   - past those checks it prints ONE JSON object on stdout whose `notCovered` is NOT_COVERED as is, on a failed check too, and exits 0 exactly when
 *     `check.ok`.
 *   - PAIRING IS REPORTED APART FROM check.ok: a verified backup directory can pass every byte check and is still `paired: false`; an executor URL is
 *     a paired capture, `paired: true`. A byte-check pass must never be readable as a paired-capture pass.
 *   - references are read from the snapshot in BOTH shapes the graph holds them (a post's attachment node, and a card's own `attachments` list), so a
 *     file named only by a card is a reference, and its loss is a named failure, not silence.
 *
 *   S1  CLEAN: a verified backup as the source, every file present: exit 0, check.ok, paired false, notCovered once, and the restored bytes equal the source's
 *   S2  a FAILED check still prints it: one file missing from the source, exit 1, ONE JSON object, notCovered as is, check.ok false      (the old F8c, re-based)
 *   S3  F7g, BOTH SHAPES: refs.json names the post-held and the card-held id; either file missing alone is DEGRADED, dangling is exactly that id, and the check names it
 *   S4  UNSAFE SOURCES are refused: a raw directory, a raw directory that looks like a store, a backup with one byte changed, a URL that does not answer
 *   S5  the ORDER of the refusals: a non-empty scratch is reported as such even when the source is also unsafe, and is left untouched
 *   S6  an executor URL is a PAIRED capture, and the pairing survives a failed check (reported apart from it)
 *   S7  a file two shapes name with DIFFERENT nonzero sizes is never certified clean; equal sizes, and an unknown size beside a known one, stay valid
 *
 * NOT covered, by name: a source executor written to DURING the drill (the checkpoint is taken inside the executor's own write lock; these rows do not
 * exercise a concurrent writer); an https executor; any reference shape beyond the two named; the capture's exclusion against uploads (F1 to F7 and G1 to G6);
 * the pinned pyoxigraph version (the rows run on whichever interpreter GRAPH_EXECUTOR_PYTHON names; the builder named the pinned one).
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
const BACKUP = path.join(REPO, 'scripts', 'graph-store-backup.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const BK = 'urn:scrum:bookkeeping:executor';
const POST_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.txt';
const CARD_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.txt';
const FILES = { [POST_ID]: 'bytes of the file a post names', [CARD_ID]: 'bytes of the file only a card names, a little longer' };

const temps = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
let x = null; let backup = null;

/**
 * Seed a scratch executor with attachment references and return it: `spec` maps an attachment id to { post, card }, the size a post's attachment node records
 * and the size a card's own `attachments` list records (undefined = that shape does not name the file; 0 = the shape names it with an UNKNOWN size).
 */
async function seededExecutor(spec, tag) {
  const store = tmpStore(`drillsrc1648-${tag}-`); fs.rmSync(store, { recursive: true }); temps.push(store, `${store}.checkpoints`);
  const ex = await startExecutor({ store, datasetId: `drillsrc-${tag}`, create: true });
  const cardAtt = Object.entries(spec).filter(([, v]) => v.card !== undefined).map(([id, v]) => ({ id, name: `${id}.card`, mime: 'text/plain', size: v.card }));
  const card = JSON.stringify({ '@id': `card-${tag}`, '@type': 'Card', title: 'a card that holds files', attachments: cardAtt });
  const posts = Object.entries(spec).filter(([, v]) => v.post !== undefined).map(([id, v], n) => `
    <https://scrumboard.local/entity/post-${tag}-att-${n}> <https://scrumboard.local/ns#attachmentOf> <https://scrumboard.local/entity/post-${tag}> ;
      <https://schema.org/identifier> "${id}" ; <https://schema.org/contentSize> "${v.post}" .`).join('\n');
  const sparql = `INSERT DATA { ${posts}
    GRAPH <${BK}> { <https://scrumboard.local/entity/card-${tag}> <https://scrumboard.local/ns#entityJson> ${JSON.stringify(card)} } }`;
  const r = await fetch(`${ex.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:op:drillsrc-1648-seed-${tag}` }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the scratch executor took the seed: ${await r.text()}`);
  return ex;
}
async function verifiedBackup(ex) {
  const { backupStore } = await import(pathToFileURL(BACKUP).href);
  const b = await backupStore({ url: ex.baseUrl, dest: mk('drillsrc1648-bk-'), python: PY });
  assert.equal(b.ok, true, `PRECONDITION: a verified backup of the seeded store: ${JSON.stringify(b.checks)}`);
  return b;
}

before(async () => {
  if (SKIP) return;
  x = await seededExecutor({ [POST_ID]: { post: Buffer.byteLength(FILES[POST_ID]) }, [CARD_ID]: { card: Buffer.byteLength(FILES[CARD_ID]) } }, 'main');
  backup = await verifiedBackup(x);
});
after(async () => {
  if (x) await killExecutor(x);
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/** A source-attachments directory holding the fixture files, minus `skip`. */
function attachments(skip = [], files = FILES) {
  const dir = mk('drillsrc1648-att-');
  for (const [id, text] of Object.entries(files)) if (!skip.includes(id)) fs.writeFileSync(path.join(dir, id), text);
  return dir;
}
const listing = (d) => fs.readdirSync(d, { recursive: true }).sort();
function drill(att, source, scratch = mk('drillsrc1648-scr-')) {
  const r = spawnSync(process.execPath, [DRILL, '--source-attachments', att, '--source-executor', source, '--scratch', scratch, '--python', PY], { encoding: 'utf8', timeout: 120000 });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch { /* left null: a row says whether it expects one */ }
  return { ...r, json, scratch };
}
const refs = (scratch) => JSON.parse(fs.readFileSync(path.join(scratch, 'capture', 'refs.json'), 'utf8'));
const notCovered = async () => (await import(pathToFileURL(DRILL).href)).NOT_COVERED;
const SENTENCE = 'direct filesystem writes by an operator, a script or another process are operationally excluded and not fenced';

test('#1648 (S1) CLEAN: a verified backup as the source, every file present: exit 0, check.ok, paired false, notCovered once, restored bytes equal the source\'s', { skip: SKIP, timeout: 120000 }, async () => {
  const att = attachments(); const r = drill(att, backup.path);
  assert.ok(r.json, `ONE JSON object on stdout: ${r.stdout.slice(0, 200)} | ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 0, `exit 0: ${JSON.stringify(r.json.check?.failures)} ${r.json.error}`);
  assert.equal(r.json.check.ok, true);
  assert.equal(r.json.paired, false, 'a verified backup directory was not taken under this capture: paired is false, even though every byte check passed');
  assert.deepEqual(r.json.notCovered, await notCovered(), 'notCovered is NOT_COVERED as is');
  assert.equal(r.json.notCovered.filter((s) => s === SENTENCE).length, 1, 'with the out-of-band-writer sentence once');
  for (const [id, text] of Object.entries(FILES)) {
    assert.equal(fs.readFileSync(path.join(r.json.restoredDir, id), 'utf8'), text, `${id} was restored with the source's bytes`);
  }
});

test('#1648 (S2) a FAILED check still prints ONE JSON object with notCovered as is, and exits non-zero exactly because check.ok is false', { skip: SKIP, timeout: 120000 }, async () => {
  const r = drill(attachments([POST_ID]), backup.path);
  assert.ok(r.json, `ONE JSON object on stdout even though the check fails: ${r.stdout.slice(0, 200)} | ${r.stderr.slice(0, 300)}`);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'and only one line');
  assert.equal(r.json.check.ok, false, 'CONTROL: this fixture really fails the check (a file the graph names is missing from the source)');
  assert.equal(r.status === 0, r.json.check.ok === true, `exit 0 exactly when check.ok (exit ${r.status})`);
  assert.deepEqual(r.json.notCovered, await notCovered(), 'notCovered is NOT_COVERED as is, on a failed check');
  assert.equal(r.json.notCovered.filter((s) => s === SENTENCE).length, 1);
});

test('#1648 (S3, F7g) BOTH reference shapes: refs.json names the post-held and the card-held id; either file missing alone is DEGRADED with exactly that id dangling, and the check names it', { skip: SKIP, timeout: 180000 }, () => {
  const ok = drill(attachments(), backup.path);
  assert.ok(ok.json, `${ok.stderr.slice(0, 300)}`);
  const got = refs(ok.scratch);
  assert.deepEqual(got.map((r) => r.id).sort(), [POST_ID, CARD_ID].sort(), 'the reference set holds the id a post names AND the id only a card names');
  assert.equal(got.find((r) => r.id === POST_ID).size, Buffer.byteLength(FILES[POST_ID]), 'with the post-held file\'s size');
  assert.equal(got.find((r) => r.id === CARD_ID).size, Buffer.byteLength(FILES[CARD_ID]), 'and the card-held file\'s size');
  for (const missing of [POST_ID, CARD_ID]) {
    const r = drill(attachments([missing]), backup.path);
    assert.ok(r.json, `${missing} missing: ONE JSON object: ${r.stderr.slice(0, 300)}`);
    assert.equal(r.status, 1, `${missing} missing: the drill fails`);
    assert.equal(r.json.capture.status, 'DEGRADED', `${missing} missing: the capture is DEGRADED, never plain success`);
    assert.deepEqual(r.json.capture.dangling, [missing], `${missing} missing: dangling is exactly that id`);
    assert.ok(JSON.stringify(r.json.check.failures).includes(missing), `${missing} missing: the check names it: ${JSON.stringify(r.json.check.failures)}`);
  }
});

test('#1648 (S4) UNSAFE sources are refused: a raw directory, one that looks like a store, a backup with a byte changed, a URL that does not answer', { skip: SKIP, timeout: 180000 }, () => {
  const looksLikeStore = mk('drillsrc1648-raw-'); fs.writeFileSync(path.join(looksLikeStore, 'CURRENT'), 'MANIFEST-000001\n'); fs.writeFileSync(path.join(looksLikeStore, 'MANIFEST-000001'), 'x');
  const tampered = mk('drillsrc1648-tamper-'); fs.cpSync(backup.path, path.join(tampered, 'b'), { recursive: true });
  const dir = path.join(tampered, 'b'); const m = JSON.parse(fs.readFileSync(path.join(dir, 'backup-manifest.json'), 'utf8'));
  const victim = path.join(dir, m.files.find((f) => f.size > 0).name); const buf = fs.readFileSync(victim); buf[0] ^= 0xff; fs.writeFileSync(victim, buf);
  const cases = [['an empty raw directory', mk('drillsrc1648-empty-')], ['a raw directory that looks like a store', looksLikeStore], ['a backup with one byte changed', dir], ['a URL that does not answer', 'http://127.0.0.1:9/']];
  for (const [what, source] of cases) {
    const att = attachments(); const attBefore = listing(att);
    const r = drill(att, source);
    assert.equal(r.status, 2, `${what}: refused with exit 2 (got ${r.status}): ${r.stderr.slice(0, 200)}`);
    assert.equal(r.stdout.trim(), '', `${what}: nothing on stdout (no check, no report)`);
    assert.ok(r.stderr.trim().length > 0, `${what}: and a message saying why`);
    assert.deepEqual(listing(r.scratch), [], `${what}: nothing was created under --scratch`);
    assert.deepEqual(listing(att), attBefore, `${what}: the source attachments are untouched`);
  }
});

test('#1648 (S5) the refusals run in order: a non-empty scratch is reported as such even when the source is also unsafe, and is left untouched', { skip: SKIP, timeout: 60000 }, () => {
  const scratch = mk('drillsrc1648-scr-'); fs.writeFileSync(path.join(scratch, 'precious.txt'), 'not the drill\'s');
  const before = listing(scratch);
  const r = drill(attachments(), mk('drillsrc1648-raw-'), scratch);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty/i, `the scratch is what is reported: ${r.stderr.slice(0, 200)}`);
  assert.deepEqual(listing(scratch), before);
  assert.equal(fs.readFileSync(path.join(scratch, 'precious.txt'), 'utf8'), 'not the drill\'s');
});

test('#1648 (S6) an executor URL is a PAIRED capture, and the pairing is reported apart from the check: a failed check does not unpair it, a passed one does not pair a backup', { skip: SKIP, timeout: 180000 }, () => {
  const clean = drill(attachments(), x.baseUrl);
  assert.ok(clean.json, `${clean.stdout.slice(0, 200)} | ${clean.stderr.slice(0, 300)}`);
  assert.equal(clean.status, 0, `a clean run by URL: ${JSON.stringify(clean.json.check?.failures)} ${clean.json.error}`);
  assert.equal(clean.json.paired, true, 'a URL source is a paired capture');
  assert.equal(clean.json.check.ok, true);
  const failed = drill(attachments([CARD_ID]), x.baseUrl);
  assert.ok(failed.json, `${failed.stderr.slice(0, 300)}`);
  assert.equal(failed.json.check.ok, false, 'CONTROL: this run fails the check');
  assert.equal(failed.json.paired, true, 'and it is still reported as a paired capture: pairing is not folded into the check');
  assert.equal(clean.json.paired !== drill(attachments(), backup.path).json.paired, true, 'while the same bytes through a backup directory are NOT paired');
});

test('#1648 (S7) a file the post and the card name with DIFFERENT nonzero sizes is never certified clean; equal sizes and unknown-beside-known stay valid', { skip: SKIP, timeout: 240000 }, async () => {
  const TEXT = 'abc';   // 3 bytes
  const ID = 'cccccccc-3333-4333-8333-cccccccccccc.txt';
  const run = async (tag, spec) => {
    const ex = await seededExecutor({ [ID]: spec }, tag);
    try { const b = await verifiedBackup(ex); return drill(attachments([], { [ID]: TEXT }), b.path); } finally { await killExecutor(ex); }
  };
  const equal = await run('eq', { post: 3, card: 3 });
  assert.ok(equal.json, `${equal.stderr.slice(0, 300)}`);
  assert.equal(equal.status, 0, `CONTROL equal sizes (3 and 3) are valid: ${JSON.stringify(equal.json.check?.failures)} ${equal.json.error}`);
  const unknown = await run('unk', { post: 0, card: 3 });
  assert.ok(unknown.json, `${unknown.stderr.slice(0, 300)}`);
  assert.equal(unknown.status, 0, `CONTROL an unknown size (0) beside a known one (3) is valid: ${JSON.stringify(unknown.json.check?.failures)} ${unknown.json.error}`);
  const conflict = await run('conf', { post: 3, card: 999 });
  assert.ok(conflict.json, `the disagreement still gets a report: ${conflict.stdout.slice(0, 200)} | ${conflict.stderr.slice(0, 300)}`);
  assert.notEqual(conflict.status, 0, `the post says 3 bytes and the card says 999 for the same file: that is not a clean run (exit ${conflict.status}, check.ok ${conflict.json.check?.ok})`);
  assert.ok(JSON.stringify([conflict.json.check?.failures, conflict.json.error]).includes(ID), `and the failure (or the error) names the file, not just the run: ${JSON.stringify([conflict.json.check?.failures, conflict.json.error]).slice(0, 300)}`);
});
