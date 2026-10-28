#!/usr/bin/env node
/**
 * #1747 step 2 input — write the OUTBOX MANIFEST the importer reads (step 5): one disposition per pending announcement.
 *
 *   node scripts/cutover-outbox-manifest-1629.mjs --board-data <doc> --out <entries.csv> [--publisher-note "<why>"]
 *
 * The importer accepts exactly one class per pending entry, and re-proves every one against the candidate before it
 * writes anything (the proof post must exist and join the entry field for field), so this tool decides nothing the
 * importer does not check:
 *   · a LEGACY entry retires with proof: `retire-with-proof` (its own legacyPostId is the proof the importer joins);
 *   · a PUBLISHER entry's notify obligation is `disposed-not-sent`, with a NOTE: a human's reason, given on the command
 *     line. It is never invented here; a document with a pending publisher entry and no --publisher-note is refused.
 * Run it on the STOPPED source's document, the same file the capture digests.
 *
 * Output: `MANIFEST <n> rows (<legacy> legacy, <publisher> publisher) <sha256>` and exit 0; `REFUSED <CODE> <why>` and
 * exit 1. --out is never overwritten.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const refuse = (code, why) => { console.log(`REFUSED ${code} ${why}`); process.exit(1); };

const docFile = arg('--board-data'), out = arg('--out'), note = arg('--publisher-note');
if (!docFile || !out) refuse('USAGE', 'node scripts/cutover-outbox-manifest-1629.mjs --board-data <doc> --out <entries.csv> [--publisher-note "<why>"]');
if (fs.existsSync(out)) refuse('OUT_EXISTS', `${out} already exists; it is never overwritten`);

let doc;
try { doc = JSON.parse(fs.readFileSync(docFile, 'utf8')); } catch (e) { refuse('DOC_MALFORMED', `${docFile} is not readable JSON: ${e.message}`); }
const entries = doc?.['scrum:meta']?.announcementOutbox?.entries;
if (!entries || typeof entries !== 'object' || Array.isArray(entries)) refuse('DOC_MALFORMED', 'scrum:meta.announcementOutbox.entries is not an object');

const pending = Object.values(entries).filter((e) => e?.status === 'pending');
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const rows = [];
let legacy = 0, publisher = 0;
for (const e of pending) {
  if (typeof e.obligationId !== 'string' || !e.obligationId) refuse('DOC_MALFORMED', `a pending entry has no obligationId: ${JSON.stringify(e).slice(0, 120)}`);
  if (e.mode === 'legacy') {
    rows.push([e.obligationId, 'retire-with-proof', '']); legacy++;
  } else if (e.mode === 'publisher') {
    if (!note) refuse('NOTE_REQUIRED', `${e.obligationId} is a pending publisher entry: its disposition needs a human's reason (--publisher-note)`);
    rows.push([e.obligationId, 'disposed-not-sent', note]); publisher++;
  } else refuse('UNKNOWN_MODE', `${e.obligationId}: mode ${JSON.stringify(e.mode)}`);
}
const text = ['obligationId,class,note', ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n';
fs.writeFileSync(out, text, { flag: 'wx' });
console.log(`MANIFEST ${rows.length} rows (${legacy} legacy, ${publisher} publisher) ${crypto.createHash('sha256').update(text).digest('hex')}`);
