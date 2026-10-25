#!/usr/bin/env node
/**
 * #1747 step 2 — capture the STOPPED source: write the manifest that steps 3 and 4 bind to.
 *
 *   node scripts/cutover-capture-1629.mjs --source-store <dir> --board-data <doc> --outbox-manifest <entries.csv>
 *        --identity <health.json> --out <capture.json>
 *
 * Contract v2 §6 step 2: "Capture a verified independent copy of the stopped graph store and stopped document/event
 * inputs. Record dataset identity/epoch/commitSeq, source digests, ...". `--identity` is the stopped executor's LAST
 * /health answer, saved by step 1 just before the stop. This tool never starts an executor and never opens the store with
 * Oxigraph: it reads FILES only, so it cannot itself be the writer that makes the capture unstable.
 *
 * It refuses, before anything is written:
 *   · STORE_OPEN    a process holds a file in the source store open (lsof +D); a store that cannot be checked is refused too
 *   · NOT_STOPPED   the identity file is not a /health body naming datasetId, incarnation, epoch and commitSeq
 *   · NOT_SOURCE    the identity's storeHome is not the source store (the /health of some other executor)
 *   · STORE_SHAPE   the source store holds a subdirectory or a non-regular file (the manifest lists flat files only)
 *   · UNSTABLE      two full passes over the store's files (name, size, sha256), and over the document's and the outbox
 *                   manifest's sha256, differ: something wrote during the capture
 *   · OUT_EXISTS    --out already exists; it is never overwritten
 * The graph-side census (posts, tombstones, receipts) is NOT read here, because reading it means opening the store; the
 * importer enumerates it from the promoted candidate.
 *
 * Output: `CAPTURED <sha256 of the manifest>` and exit 0; `REFUSED <CODE> <why>` and exit 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { captureProblem } from './cutover-capture-schema-1629.mjs';

const BETWEEN_PASSES = process.env.SCRUM_CUTOVER_CAPTURE_BETWEEN_PASSES || '';   // test seam: a file appended to between the passes; unset = off

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const refuse = (code, why) => { console.log(`REFUSED ${code} ${why}`); process.exit(1); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const storeArg = arg('--source-store'), docFile = arg('--board-data'), outboxFile = arg('--outbox-manifest');
const identityFile = arg('--identity'), outFile = arg('--out');
if (!storeArg || !docFile || !outboxFile || !identityFile || !outFile) {
  refuse('USAGE', 'node scripts/cutover-capture-1629.mjs --source-store <dir> --board-data <doc> --outbox-manifest <csv> --identity <health.json> --out <capture.json>');
}
if (fs.existsSync(outFile)) refuse('OUT_EXISTS', `${outFile} already exists`);

let store;
try { store = fs.realpathSync(storeArg); } catch { refuse('STORE_SHAPE', `${storeArg} does not exist`); }
if (!fs.statSync(store).isDirectory()) refuse('STORE_SHAPE', `${store} is not a directory`);

let ident;
try { ident = JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch { refuse('NOT_STOPPED', 'the identity file is not JSON'); }
if (!ident || typeof ident !== 'object' || Array.isArray(ident)) refuse('NOT_STOPPED', 'the identity file is not a /health body');
for (const k of ['datasetId', 'incarnation', 'epoch', 'commitSeq']) {
  if (typeof ident[k] !== 'string' || !ident[k]) refuse('NOT_STOPPED', `the identity names no ${k}`);
}
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (typeof ident.storeHome !== 'string' || realOr(ident.storeHome) !== store) {
  refuse('NOT_SOURCE', `the identity's storeHome ${JSON.stringify(ident.storeHome)} is not ${store}`);
}

// lsof exits 1 both for "nothing open" and for some errors, so its output decides, and a missing lsof is a refusal
let held;
try { held = execFileSync('lsof', ['-F', 'pn', '+D', store], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) {
  if (e.code === 'ENOENT') refuse('STORE_OPEN', 'lsof is not available, so an open store cannot be ruled out');
  held = String(e.stdout || '');
}
const holders = held.split('\n').filter((l) => l.startsWith('p')).map((l) => l.slice(1));
if (holders.length) refuse('STORE_OPEN', `pid ${[...new Set(holders)].join(', ')} holds a file in ${store} open`);

const pass = () => {
  const files = [];
  for (const d of fs.readdirSync(store, { withFileTypes: true })) {
    if (!d.isFile()) refuse('STORE_SHAPE', `${d.name} in ${store} is not a regular file`);
    const b = fs.readFileSync(path.join(store, d.name));
    files.push({ name: d.name, size: b.length, sha256: sha(b) });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, documentSha256: sha(fs.readFileSync(docFile)), outboxManifestSha256: sha(fs.readFileSync(outboxFile)) };
};
const first = pass();
if (BETWEEN_PASSES) fs.appendFileSync(BETWEEN_PASSES, 'x');
const second = pass();
if (JSON.stringify(first) !== JSON.stringify(second)) refuse('UNSTABLE', 'the two passes differ: something wrote during the capture');
const capturedAt = new Date().toISOString();

// the census is read from the DOCUMENT the second pass hashed; a document that changed since is caught by the re-hash
const docBytes = fs.readFileSync(docFile);
if (sha(docBytes) !== second.documentSha256) refuse('UNSTABLE', 'the document changed after the second pass');
let doc;
try { doc = JSON.parse(docBytes.toString('utf8')); } catch { refuse('STORE_SHAPE', 'the board document is not JSON'); }
const meta = doc['scrum:meta'] || {};
const ob = meta.announcementOutbox || {};
const countBy = (xs, key) => {
  const out = {};
  for (const x of xs) { const k = String(x?.[key]); out[k] = (out[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};
const origins = Object.values(ob.origins || {}), entries = Object.values(ob.entries || {});
const census = {
  postReservations: Object.keys(meta.postReservations || {}).length,
  outboxOrigins: origins.length,
  outboxOriginsByMode: countBy(origins, 'mode'),
  outboxEntries: entries.length,
  outboxEntriesByStatus: countBy(entries, 'status'),
  nextPostSeq: meta.nextPostSeq ?? null,
  postSeqEpoch: meta.postSeqEpoch ?? null,
  seatStates: Array.isArray(meta.seatStates) ? meta.seatStates.length : null,
};

const manifest = {
  capturedAt, census, commitSeq: ident.commitSeq, datasetId: ident.datasetId, documentSha256: second.documentSha256,
  epoch: ident.epoch, files: second.files, incarnation: ident.incarnation, outboxManifestSha256: second.outboxManifestSha256,
  sourceStore: store,
};
// the same CLOSED schema steps 3 and 4 read: a manifest this tool writes must be one they accept
const problem = captureProblem(manifest);
if (problem) refuse('STORE_SHAPE', problem);
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
try { fs.writeFileSync(outFile, bytes, { flag: 'wx' }); } catch (e) {
  if (e.code === 'EEXIST') refuse('OUT_EXISTS', `${outFile} already exists`);
  throw e;
}
console.log(`CAPTURED ${sha(bytes)}`);
