/**
 * #1648 — one attachment id referenced by BOTH a post and a card, with the two references recording different sizes.
 * Builder rows, written for the review of 1865c79: the drill kept the FIRST nonzero size for a repeated id, so a
 * disagreement was lost before the byte checker could compare it with the manifest, and the run certified clean.
 *
 * One scratch executor, seeded with four ids, each held by one post attachment node and one card entityJson entry:
 *   C1  post records the TRUE size, card records a wrong one   -> the check fails for that id (ref-size-mismatch)
 *   C2  post records a wrong size, card records the TRUE one   -> the same (the order of the two shapes does not hide it)
 *   E   both record the same true size                         -> no failure, no conflict
 *   Z   post records 0 (unknown), card records the true size   -> no failure, no conflict (0 yields to a known size)
 * and every conflicting id is reported in references.sizeConflicts with both sizes.
 *
 * NOT covered: a conflict between two references of the SAME shape; a size recorded as a non-integer.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRILL = path.join(REPO, 'scripts', 'attachments-drill.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const BK = 'urn:scrum:bookkeeping:executor';
const BYTES = 'abc';
const TRUE = Buffer.byteLength(BYTES);
const ID = { C1: '31111111-1111-4111-8111-111111111111.txt', C2: '32222222-2222-4222-8222-222222222222.txt', E: '33333333-3333-4333-8333-333333333333.txt', Z: '34444444-4444-4444-8444-444444444444.txt' };
// [post size, card size] per id
const SIZES = { C1: [TRUE, 999], C2: [999, TRUE], E: [TRUE, TRUE], Z: [0, TRUE] };

const temps = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
let x = null;

before(async () => {
  if (SKIP) return;
  const store = tmpStore('drill1648c-store-'); fs.rmSync(store, { recursive: true }); temps.push(store, `${store}.checkpoints`);
  x = await startExecutor({ store, datasetId: 'drill-1648c', create: true });
  const posts = []; const cards = [];
  for (const [k, id] of Object.entries(ID)) {
    const [p, c] = SIZES[k];
    posts.push(`<https://scrumboard.local/entity/post-${k}-att-0> <https://scrumboard.local/ns#attachmentOf> <https://scrumboard.local/entity/post-${k}> ;
      <https://schema.org/identifier> "${id}" ; <https://schema.org/contentSize> "${p}" .`);
    const card = JSON.stringify({ '@id': `card-${k}`, '@type': 'Card', title: `card ${k}`, attachments: [{ id, name: `${k}.txt`, mime: 'text/plain', size: c }] });
    cards.push(`<https://scrumboard.local/entity/card-${k}> <https://scrumboard.local/ns#entityJson> ${JSON.stringify(card)} .`);
  }
  const sparql = `INSERT DATA { ${posts.join('\n')} GRAPH <${BK}> { ${cards.join('\n')} } }`;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:op:drill-1648c-seed' }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the scratch executor took the seed: ${await r.text()}`);
});
after(async () => {
  if (x) await killExecutor(x);
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

function run() {
  const att = mk('drill1648c-att-');
  for (const id of Object.values(ID)) fs.writeFileSync(path.join(att, id), BYTES);
  const r = spawnSync(process.execPath, [DRILL, '--source-attachments', att, '--source-executor', x.baseUrl, '--scratch', mk('drill1648c-scr-'), '--python', PY], { encoding: 'utf8', timeout: 120000 });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch { /* the rows say what they expect */ }
  return { ...r, json };
}

test('#1648 (C) conflicting nonzero sizes for one id fail the check in BOTH shape orders, and are reported; equal and 0-plus-known do not', { skip: SKIP, timeout: 180000 }, () => {
  const r = run();
  assert.ok(r.json, `one JSON object on stdout: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 300)}`);
  assert.equal(r.json.paired, true, 'PRECONDITION: a paired run by URL');
  assert.equal(r.json.check.ok, false, `a conflict is never certified clean: ${JSON.stringify(r.json.check.failures)}`);
  assert.equal(r.status, 1, 'and the exit follows check.ok');
  const mismatched = [...new Set(r.json.check.failures.filter((f) => f.code === 'ref-size-mismatch').map((f) => f.id))].sort();
  assert.deepEqual(mismatched, [ID.C1, ID.C2].sort(), `ref-size-mismatch names exactly the two conflicting ids, whichever shape was wrong: ${JSON.stringify(r.json.check.failures)}`);
  assert.deepEqual(r.json.check.failures.filter((f) => f.id === ID.E || f.id === ID.Z), [], 'equal sizes, and 0 beside a known size, are not failures');
  assert.deepEqual(r.json.references?.sizeConflicts, [{ id: ID.C1, sizes: [TRUE, 999] }, { id: ID.C2, sizes: [TRUE, 999] }].sort((a, b) => a.id.localeCompare(b.id)),
    `the report names each conflict with both sizes: ${JSON.stringify(r.json.references)}`);
  assert.equal(r.json.references.count, 4, 'the reference count is distinct ids, not emitted entries');
});
