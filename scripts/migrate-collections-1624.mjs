#!/usr/bin/env node
/**
 * #1624 — COPY THE DOCUMENT'S SMALL-KIND COLLECTIONS INTO THE GRAPH (the K13 families plus wakes).
 *
 *   node scripts/migrate-collections-1624.mjs --board-data <path> --executor <url> --dataset <id> [--apply]
 *
 * Run with REST STOPPED: it reads the document as REST would have written it. The document is NOT changed; removing
 * its copies is a separate, verified step (scripts/retire-collections-1624.mjs) after a read-back.
 *
 * Each entity is ONE guarded create, through the same machinery a REST write uses:
 *   · the families' definitions are the server's own (core/collection-families.mjs), so unique values and reference
 *     guards (`requires`) are checked exactly as a REST create would check them;
 *   · a create is a FRESH SUBJECT: an entity the graph already holds answers PRECONDITION_FAILED and is left as it is;
 *   · the opId is derived from the collection and the entity's IRI (never random), and the write goes through
 *     durableUpdate: an UNKNOWN outcome is settled by the receipt, and replayed only when the receipt is ABSENT. A re-run
 *     therefore writes nothing twice.
 * Wakes go through their own `entity.put` kind (core/smallkinds-unit.mjs), keeping each wake's IRI.
 * An identifier that cannot be an IRI is renamed on the way in, by the one map the retire step also uses
 * (core/collection-renames-1624.mjs: the tending prompt "scrum board-clarity" → "scrum-board-clarity").
 *
 * After an --apply it reads every family back from the graph and compares each document entity's wire JSON with the
 * graph's: COMPLETE only when every document entity is held with the SAME content. An entity the graph already held
 * with DIFFERENT content is reported by name and makes the run INCOMPLETE; it is never overwritten.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { jsonLdToDomain, isJsonLdDocument } from '../core/jsonld.mjs';
import { domainToBoard } from '../core/mapping.mjs';
import { collectionFamilies } from '../core/collection-families.mjs';
import { createCollectionsUnit } from '../core/collections-unit.mjs';
import { importIntention } from '../core/collection-import-1624.mjs';
import { wakeCreateIntention, wakesForQuery, wakeFromRow } from '../core/smallkinds-unit.mjs';
import { renameEntity } from '../core/collection-renames-1624.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = opt('--board-data'); const executor = opt('--executor'); const dataset = opt('--dataset'); const apply = args.includes('--apply');
if (!file || !executor || !dataset) {
  console.error('usage: node scripts/migrate-collections-1624.mjs --board-data <path> --executor <url> --dataset <id> [--apply]');
  process.exit(2);
}
const ACTOR = 'https://scrumboard.local/person/board';
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
// Identifiers that cannot be IRIs are renamed on the way in (core/collection-renames-1624.mjs, owner decision).
const board = renameEntity(domainToBoard(isJsonLdDocument(raw) ? jsonLdToDomain(raw) : raw));
// The live configuration runs with the cards unit on, so a reference to a card is a graph subject.
const families = collectionFamilies({ cardsUnit: true });
const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 120000 });
const unit = createCollectionsUnit({ client: g, families, mintId: () => 'unused' });

/** family key → Map(iri → wire JSON) the graph holds now */
async function graphHolds() {
  await unit.load();
  const snap = unit.snapshot();
  return new Map(Object.entries(snap).map(([k, list]) => [k, new Map(list.map((e) => [e['@id'], JSON.stringify(e)]))]));
}
async function graphWakes() {
  const q = await g.query(wakesForQuery());
  if (!q.ok) throw new Error(`the graph could not be read: ${q.reason}`);
  return new Map(q.rows.map((r) => [String(r.w.value), r]));
}
/** The document's wakes as the server's wake writer would store them (its wire JSON is {seat, at, note}). */
const docWakes = (Array.isArray(board.wakes) ? board.wakes : []).filter((w) => w && typeof w['@id'] === 'string');
const wakeJson = (w) => JSON.stringify({ seat: w['scrum:wokeSeat'] ?? '', at: w['scrum:wokeAt'] ?? '', note: typeof w.text === 'string' ? w.text : '' });

const before = await graphHolds();
const beforeWakes = await graphWakes();
const counts = Object.fromEntries(families.map((f) => [f.key, (Array.isArray(board[f.key]) ? board[f.key] : []).filter((e) => e && typeof e['@id'] === 'string').length]));
console.log(`document: ${JSON.stringify({ ...counts, wakes: docWakes.length })} · graph before: ${JSON.stringify({ ...Object.fromEntries([...before].map(([k, m]) => [k, m.size])), wakes: beforeWakes.size })} · ${apply ? 'APPLY' : 'DRY RUN (nothing sent)'}`);

const tally = { APPLIED: 0, PRECONDITION_FAILED: 0, refused: 0 };
const refused = [];
async function send(label, intention) {
  const r = await durableUpdate(g, intention);
  if (r.outcome === 'APPLIED' || r.outcome === 'PRECONDITION_FAILED') { tally[r.outcome]++; return; }
  if (r.outcome === 'REJECTED') { tally.refused++; refused.push(`${label}: ${r.reason}`); return; }
  throw new Error(`${label}: ${r.outcome} ${r.reason ?? ''}. Stopped; a re-run is safe (every opId is derived)`);
}

if (apply) {
  const t0 = Date.now(); let n = 0;
  for (const fam of families) {
    for (const e of (Array.isArray(board[fam.key]) ? board[fam.key] : [])) {
      if (!e || typeof e['@id'] !== 'string') continue;
      await send(`${fam.key} ${e['@id']}`, importIntention(fam, e));
      if (++n % 200 === 0) console.error(`entities: ${n} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  for (const w of docWakes) {
    const intention = wakeCreateIntention({ actor: `https://scrumboard.local/person/${encodeURIComponent(w['scrum:wokeSeat'] || 'board')}`, iri: w['@id'], seat: w['scrum:wokeSeat'] ?? '', at: w['scrum:wokeAt'] ?? '', note: w.text, entityJson: wakeJson(w) });
    intention.opId = `urn:ex:op/smallkinds/wake-import/${sha(w['@id'])}`;
    await send(`wake ${w['@id']}`, intention);
  }
}

// Read back: every document entity must be held with the SAME wire JSON.
const after = await graphHolds();
const afterWakes = await graphWakes();
const missing = []; const differ = [];
for (const fam of families) {
  const held = after.get(fam.key) ?? new Map();
  for (const e of (Array.isArray(board[fam.key]) ? board[fam.key] : [])) {
    if (!e || typeof e['@id'] !== 'string') continue;
    const got = held.get(e['@id']);
    if (got == null) missing.push(`${fam.key} ${e['@id']}`);
    else if (got !== JSON.stringify(e)) differ.push(`${fam.key} ${e['@id']}`);
  }
}
for (const w of docWakes) {
  const r = afterWakes.get(w['@id']);
  if (!r) missing.push(`wake ${w['@id']}`);
  else if (String(r.j.value) !== wakeJson(w) || !wakeFromRow(r)) differ.push(`wake ${w['@id']}`);
}
console.log(`writes: ${JSON.stringify(tally)}`);
console.log(`graph after: ${JSON.stringify({ ...Object.fromEntries([...after].map(([k, m]) => [k, m.size])), wakes: afterWakes.size })}`);
console.log(`read-back: ${missing.length} not in the graph, ${differ.length} in the graph with DIFFERENT content`);
for (const s of missing.slice(0, 20)) console.log(`  NOT IN THE GRAPH: ${s}`);
for (const s of differ.slice(0, 20)) console.log(`  DIFFERENT CONTENT: ${s}`);
for (const s of refused.slice(0, 20)) console.log(`  REFUSED: ${s}`);
if (apply) {
  if (missing.length || differ.length || refused.length) { console.log('INCOMPLETE: nothing will be removed from the document until every entity is held with the same content.'); process.exit(1); }
  console.log('COMPLETE: every document entity of every small-kind family is in the graph with the same content.');
}
