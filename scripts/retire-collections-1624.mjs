#!/usr/bin/env node
/**
 * #1624 — REMOVE THE BOARD FILE'S COPIES OF THE SMALL-KIND COLLECTIONS, once the graph holds every one of them.
 *
 *   node scripts/retire-collections-1624.mjs --board-data <path> --executor <url> --dataset <id> [--apply]
 *
 * RUN WITH REST STOPPED: this edits the board file directly, and REST holds it in memory. Take a verified backup of the
 * file first: it is the row-level record of what was removed.
 *
 * Without --apply it verifies and reports; nothing is written. Every document entity of every family
 * (core/collection-families.mjs) and every wake is looked up in the graph by its IRI, after the SAME renames the
 * migration applied (core/collection-renames-1624.mjs). An entity counts as held when the graph has it, in its own
 * collection, with
 *   · the SAME wire JSON as the file's copy; or
 *   · a NEWER version (urn:ex:ver > 1) AND a receipt for this entity's import operation. The graph took it FROM the
 *     migration and moved on, so the file's copy is stale. A newer graph entity WITHOUT that lineage is refused: a
 *     file-only edit made after the import would otherwise be discarded.
 * The file's decision copies (graph-held since #1561) are removed with them, each only when the graph has it.
 * With --apply, and only if EVERY entity is held, it drops exactly those nodes from the file's @graph in ONE atomic
 * write (tmp + rename) and appends ONE board-meta event naming what left. Every other node is kept as parsed, and it
 * refuses to write if the arithmetic does not add up.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { appendEvent } from '../core/event-log.mjs';
import { jsonLdToDomain } from '../core/jsonld.mjs';
import { domainToBoard } from '../core/mapping.mjs';
import { collectionFamilies } from '../core/collection-families.mjs';
import { renameEntity } from '../core/collection-renames-1624.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = opt('--board-data'); const executor = opt('--executor'); const dataset = opt('--dataset'); const apply = args.includes('--apply');
if (!file || !executor || !dataset) {
  console.error('usage: node scripts/retire-collections-1624.mjs --board-data <path> --executor <url> --dataset <id> [--apply]');
  process.exit(2);
}
const eventsDir = process.env.SCRUM_EVENT_LOG_DIR || `${file.replace(/\.json$/, '')}-events`;
const RS = 'https://scrumboard.local/ns#';
const T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const lit = (s) => JSON.stringify(String(s));

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(doc['@graph'])) { console.error(`${file} is not a JSON-LD board document`); process.exit(2); }
const graph = doc['@graph'];
const board = domainToBoard(jsonLdToDomain(doc));
const families = collectionFamilies({ cardsUnit: true });

/** what must be held: {key, fileId (the file's own @id), iri (after renames), json (renamed wire JSON), wake?} */
const want = [];
for (const fam of families) {
  for (const e of (Array.isArray(board[fam.key]) ? board[fam.key] : [])) {
    if (!e || typeof e['@id'] !== 'string') continue;
    const r = renameEntity(e);
    want.push({ key: fam.key, fileId: e['@id'], iri: r['@id'], json: JSON.stringify(r), opId: `urn:ex:op/collection/import/${fam.key}/${sha(r['@id'])}` });
  }
}
for (const w of (Array.isArray(board.wakes) ? board.wakes : [])) {
  if (!w || typeof w['@id'] !== 'string') continue;
  want.push({ key: 'wakes', wake: true, fileId: w['@id'], iri: w['@id'],
    json: JSON.stringify({ seat: w['scrum:wokeSeat'] ?? '', at: w['scrum:wokeAt'] ?? '', note: typeof w.text === 'string' ? w.text : '' }) });
}

// Decisions have been graph-held since #1561 (2026-10-04): the server reads them from the graph only, so the file's
// copies are dead. One is held when the graph has a scrum:Decision at its IRI. Content is not compared: the graph has
// been the authority for these since then.
for (const n of graph) if (n && n['@type'] === 'scrum:Decision' && typeof n['@id'] === 'string') want.push({ key: 'decisions', decision: true, fileId: n['@id'], iri: n['@id'] });

const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 60000 });
const missing = [];
const decisions = want.filter((w) => w.decision);
for (let i = 0; i < decisions.length; i += 200) {
  const batch = decisions.slice(i, i + 200);
  const q = await g.query(`SELECT DISTINCT ?s WHERE { VALUES ?s { ${batch.map((w) => `<${w.iri}>`).join(' ')} } ?s <${T}> <${RS}Decision> }`);
  if (!q.ok) { console.error(`the graph could not be read: ${q.reason}`); process.exit(1); }
  const held = new Set(q.rows.map((r) => r.s.value));
  for (const w of batch) if (!held.has(w.iri)) missing.push({ ...w, reason: 'not in the graph' });
}
const entities = want.filter((w) => !w.decision);
for (let i = 0; i < entities.length; i += 200) {
  const batch = entities.slice(i, i + 200);
  const values = `VALUES ?s { ${batch.map((w) => `<${w.iri}>`).join(' ')} }`;
  const q = await g.query(`SELECT ?s ?k ?v ?j ?t WHERE { ${values} ?s <${RS}entityJson> ?j OPTIONAL { ?s <${RS}inCollection> ?k } OPTIONAL { ?s <urn:ex:ver> ?v } OPTIONAL { ?s <${T}> ?t FILTER(?t = <${RS}Wake>) } }`);
  if (!q.ok) { console.error(`the graph could not be read: ${q.reason}`); process.exit(1); }
  const held = new Map(q.rows.map((r) => [r.s.value, r]));
  for (const w of batch) {
    const r = held.get(w.iri);
    if (!r) { missing.push({ ...w, reason: 'not in the graph' }); continue; }
    if (w.wake) { if (!r.t || r.j.value !== w.json) missing.push({ ...w, reason: 'content-differs' }); continue; }
    if (r.k?.value !== w.key) { missing.push({ ...w, reason: `in collection ${JSON.stringify(r.k?.value ?? null)}` }); continue; }
    if (r.j.value === w.json) continue;
    const newer = Number(r.v?.value ?? 0) > 1;
    const lineage = newer ? await g.query(`ASK { <${w.opId}> ?p ?o }`) : null;
    if (newer && lineage?.ok && lineage.boolean === true) continue;   // moved on from THIS import
    missing.push({ ...w, reason: newer ? 'newer in the graph without import lineage' : 'content-differs' });
  }
}

const removeIds = new Set(want.map((w) => w.fileId));
const removing = graph.filter((n) => removeIds.has(n['@id']));
const counts = Object.fromEntries([...new Set(want.map((w) => w.key))].map((k) => [k, want.filter((w) => w.key === k).length]));
console.log(`${file}: ${want.length} small-kind entities in the file ${JSON.stringify(counts)}; ${want.length - missing.length} of ${want.length} verified in the graph · ${apply ? 'APPLY' : 'DRY RUN (nothing written)'}`);
if (missing.length) {
  for (const m of missing.slice(0, 15)) console.log(`  NOT HELD (${m.reason}): ${m.key} ${m.iri}`);
  console.log('REFUSED: migrate first (scripts/migrate-collections-1624.mjs); nothing was written.');
  process.exit(1);
}
if (removing.length !== removeIds.size) {
  console.error(`REFUSED: ${removeIds.size} entities to remove but ${removing.length} file nodes match them; nothing was written.`); process.exit(1);
}
if (!removing.length) { console.log('nothing to remove.'); process.exit(0); }
if (!apply) process.exit(0);

const kept = graph.filter((n) => !removeIds.has(n['@id']));
if (kept.length + removing.length !== graph.length) {
  console.error(`REFUSED: ${graph.length} nodes, ${removing.length} to remove, but ${kept.length} would remain; nothing was written.`); process.exit(1);
}
const now = new Date().toISOString();
appendEvent(eventsDir, { op: 'update', actor: 'board', entity: { kind: 'board-meta', id: 'small-kind-collections' },
  state: { retired: counts, movedTo: 'graph executor', verifiedInGraph: true, reason: '#1624: these live in the graph' } }, { now });
const out = { ...doc, '@graph': kept };
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
fs.renameSync(tmp, file);
const reread = JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'];
console.log(`REMOVED ${removing.length} small-kind entities; ${reread.length} nodes remain (was ${graph.length}); read back: ${reread.filter((n) => removeIds.has(n['@id'])).length} of them left.`);
