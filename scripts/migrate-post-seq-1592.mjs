#!/usr/bin/env node
/**
 * #1592 — number the existing posts of a STOPPED board's file, so the document path's post sequence covers them.
 *
 *   node scripts/migrate-post-seq-1592.mjs --board-file <board-data.json> [--dry-run] [--rollback]
 *
 * MIGRATE   Only a file with NO postSeqEpoch is numbered: each post gets postSeq = its array index + 1 (today's
 *           order exactly, which is array order and NOT time order), nextPostSeq = count + 1, and a new
 *           postSeqEpoch (a UUID). A file that already HAS an epoch is left byte-for-byte alone: survivors of a
 *           removal keep their numbers and the counter is never reset to count + 1, because a reset would hand a
 *           removed post's number to a new one and every cursor past it would miss that post.
 * ROLLBACK  strips postSeq from every post and nextPostSeq / postSeqEpoch from the document. Migrating again
 *           afterwards gives the same posts and seqs under a DIFFERENT epoch, so a token from before the rollback is
 *           refused (409 POST_CURSOR_EPOCH_CHANGED) instead of being read against a different numbering.
 * --dry-run prints what would change and writes nothing.
 *
 * The file keeps its own shape: a legacy {cards, conversations, …} file stays legacy (the three fields are
 * top-level keys), and a JSON-LD file stays JSON-LD (posts are the @graph Comments in order, postSeq rides each
 * one's `_extra` exactly as the server's own save writes it, and the counter and epoch ride `scrum:meta`).
 *
 * ⛔ Stop the server first. A running server holds the document in its write lock's view and its next save would
 * overwrite this script's result (or this script would overwrite a post the server just stored).
 * Take a backup first: cp board-data.json backups/board-data-backup-$(date +%Y%m%d-%H%M%S).json
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FILE = opt('--board-file');
const DRY = args.includes('--dry-run');
const ROLLBACK = args.includes('--rollback');
if (!FILE) { console.error('usage: node scripts/migrate-post-seq-1592.mjs --board-file <path> [--dry-run] [--rollback]'); process.exit(2); }
if (!fs.existsSync(FILE)) { console.error(`no such file: ${FILE}`); process.exit(2); }

const raw = fs.readFileSync(FILE, 'utf8');
const doc = JSON.parse(raw);
const jsonLd = !!doc && typeof doc === 'object' && Array.isArray(doc['@graph']);

// One view over both shapes: where the counter/epoch live, the posts in order, and how to read/write a post's seq.
let meta, posts, getSeq, setSeq, dropSeq;
if (jsonLd) {
  if (!doc['scrum:meta'] || typeof doc['scrum:meta'] !== 'object') doc['scrum:meta'] = {};
  meta = doc['scrum:meta'];
  posts = doc['@graph'].filter((e) => e && e['@type'] === 'Comment');
  getSeq = (p) => p._extra?.postSeq;
  setSeq = (p, n) => { p._extra = { ...(p._extra || {}), postSeq: n }; };
  dropSeq = (p) => { if (!p._extra) return; delete p._extra.postSeq; if (Object.keys(p._extra).length === 0) delete p._extra; };
} else {
  meta = doc;
  posts = Array.isArray(doc.conversations) ? doc.conversations : [];
  getSeq = (p) => p.postSeq;
  setSeq = (p, n) => { p.postSeq = n; };
  dropSeq = (p) => { delete p.postSeq; };
}

const shape = jsonLd ? 'JSON-LD' : 'legacy';
let changed = false;
if (ROLLBACK) {
  const numbered = posts.filter((p) => getSeq(p) !== undefined).length;
  const has = ['nextPostSeq', 'postSeqEpoch'].filter((k) => k in meta);
  console.log(`${shape} file, ${posts.length} posts: rollback strips postSeq from ${numbered} and ${has.length ? has.join(' + ') : 'no counter/epoch'} from the document`);
  if (numbered || has.length) {
    for (const p of posts) dropSeq(p);
    delete meta.nextPostSeq; delete meta.postSeqEpoch;
    changed = true;
  }
} else if (meta.postSeqEpoch !== undefined) {
  console.log(`${shape} file already numbered (epoch ${meta.postSeqEpoch}, nextPostSeq ${meta.nextPostSeq}): left untouched`);
} else {
  const epoch = crypto.randomUUID();
  console.log(`${shape} file, ${posts.length} posts: postSeq = index + 1 (1..${posts.length}), nextPostSeq = ${posts.length + 1}, postSeqEpoch = ${epoch}`);
  posts.forEach((p, i) => setSeq(p, i + 1));
  meta.nextPostSeq = posts.length + 1;
  meta.postSeqEpoch = epoch;
  changed = true;
}

if (!changed) process.exit(0);
if (DRY) { console.log('--dry-run: nothing written'); process.exit(0); }
const out = JSON.stringify(doc, null, 2) + (raw.endsWith('\n') ? '\n' : '');
const tmp = `${FILE}.tmp-1592`;
fs.writeFileSync(tmp, out, 'utf8');
fs.renameSync(tmp, FILE);
console.log(`written: ${FILE}`);
