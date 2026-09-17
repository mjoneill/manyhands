#!/usr/bin/env node
/**
 * #971 slice 3 — MIGRATE EVERY DOCUMENT-BORN MEMORY INTO THE LOG, one touch each.
 *
 * Slice 2 made the first write to a document-born memory drop its rows from
 * board-data.json and carry the whole memory (identity + every version) in
 * the event; the replica syncs the document first (rows vanish, triples with
 * them) and activities second (the event puts them back). This script is
 * that touch, applied to every row the document still carries — THROUGH THE
 * API (PATCH /api/memories/:id with no change), never by editing the file.
 *
 * A stored-record migration needs the same review as a deploy, and more
 * (decision bc7e28b4): the transform, the dry-run output and the rollback
 * path, read by another seat before it runs. So:
 *
 *   default   DRY RUN — reads everything, prints the plan, writes NOTHING.
 *   --run     touches each memory in turn; after each, reads it back from the
 *             graph and DIFFS it against the pre-touch read (title, owner,
 *             tags, priority, body, version, every version's text/author/at,
 *             relatedTo). The first diff STOPS the run: N migrated, the rest
 *             untouched — there is no cliff, and nothing is ever deleted
 *             except a row whose replacement was read back equal.
 *
 * Rollback: every write appends a full snapshot to board-data-events/, and
 * the touched memory's rows are gone from the document only AFTER the event
 * that carries them is in the log — the event is the record, the document
 * was the copy. Take a file backup first anyway (the script refuses --run
 * without --backup-taken, and says so): `cp board-data.json backups/…`.
 *
 * Reads the legacy ids from the board FILE (read-only) because the wire does
 * not say per memory which rows are document-born; everything else is API.
 *
 *   node scripts/migrate-memories-971.mjs --board http://127.0.0.1:3141 --file <board-data.json> --by <your seat> [--run --backup-taken]
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BOARD = opt('--board', 'http://127.0.0.1:3141');
const FILE = opt('--file');
const BY = opt('--by');   // the seat running the migration — every touch is attributed to it
const RUN = args.includes('--run');
const BACKUP = args.includes('--backup-taken');
if (!FILE) { console.error('usage: --file <board-data.json> is required (read-only; names the document-born ids)'); process.exit(2); }
if (!BY) { console.error('usage: --by <seat> is required — the migration is attributed, never anonymous (#1106)'); process.exit(2); }
if (RUN && !BACKUP) { console.error('⛔ --run needs --backup-taken: copy board-data.json to backups/ first, then say so. Refusing.'); process.exit(2); }

const api = async (method, p, body) => {
  const r = await fetch(`${BOARD}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const graph = async (query) => (await api('POST', '/api/graph', { query })).rows || [];

/** Everything a reader can see of one memory, from the graph-backed API. */
async function snapshot(id) {
  const m = await api('GET', `/api/memories/${id}`);
  const v = await api('GET', `/api/memories/${id}/versions`);
  const rel = (await graph(`SELECT ?o WHERE { <https://scrumboard.local/memory/${id}> scrum:relatedTo ?o }`)).map((r) => String(r.o)).sort();
  return {
    title: m.title, owner: m.owner, tags: [...m.tags].sort(), priority: m.priority ?? null, body: m.body, version: m.version,
    versions: v.versions.map((x) => ({ version: x.version, body: x.body, author: x.author, at: x.at })),
    relatedTo: rel,
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const rows = (doc['@graph'] || []).filter((e) => e && /^scrum:Memory(Version)?$/.test(e['@type'] || ''));
const ids = [...new Set(rows.filter((e) => e['@type'] === 'scrum:Memory').map((e) => e.identifier))];
const versionRows = rows.length - ids.length;
const list = await api('GET', '/api/memories');
console.log(`board ${BOARD} · file ${FILE}`);
console.log(`document-born memories: ${ids.length} identities + ${versionRows} version rows = ${rows.length} rows · API says legacyRows=${list.legacyRows} · total memories on the board ${list.total}`);
if (list.legacyRows !== rows.length) { console.error(`⛔ the API's legacyRows (${list.legacyRows}) ≠ the file's rows (${rows.length}): the file you named is not the board this server serves. Refusing.`); process.exit(3); }
if (!ids.length) { console.log('nothing to migrate'); process.exit(0); }

if (!RUN) {
  console.log(`DRY RUN — no writes. The plan: PATCH /api/memories/<id> {by:"${BY}"} for each of ${ids.length} memories, read-back diff after each, stop on the first diff.`);
  let checked = 0;
  for (const id of ids) { await snapshot(id); checked += 1; }   // proves every one is READABLE from the graph before any write
  console.log(`pre-read: ${checked}/${ids.length} memories readable from the graph with their versions. Re-run with --run --backup-taken to migrate.`);
  process.exit(0);
}

const t0 = Date.now();
let migrated = 0;
for (const id of ids) {
  const before = await snapshot(id);
  const t1 = Date.now();
  await api('PATCH', `/api/memories/${id}`, { by: BY });   // the touch: no change, whole memory to the log, rows dropped
  const after = await snapshot(id);
  if (!same(before, after)) {
    console.error(`⛔ DIFF after touching ${id} — STOPPING with ${migrated} migrated, ${ids.length - migrated} untouched.\n before ${JSON.stringify(before)}\n after  ${JSON.stringify(after)}`);
    process.exit(4);
  }
  migrated += 1;
  console.log(`✓ ${migrated}/${ids.length} ${id} "${before.title.slice(0, 50)}" v${before.version} (${before.versions.length} versions) ${Date.now() - t1} ms`);
}
const final = await api('GET', '/api/memories');
console.log(`done: ${migrated} migrated in ${Math.round((Date.now() - t0) / 1000)} s · legacyRows now ${final.legacyRows} · total memories ${final.total} (was ${list.total})`);
if (final.legacyRows !== 0) { console.error(`⛔ legacyRows is ${final.legacyRows}, expected 0`); process.exit(5); }
if (final.total !== list.total) { console.error(`⛔ total moved ${list.total} → ${final.total}`); process.exit(5); }
