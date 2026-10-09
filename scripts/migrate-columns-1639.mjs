#!/usr/bin/env node
/**
 * #1639 — COPY THE DOCUMENT'S COLUMNS INTO THE GRAPH (for SCRUM_GRAPH_UNIT_COLUMNS=1).
 *
 *   node scripts/migrate-columns-1639.mjs --board-data <path> --executor <url> --dataset <id> [--apply]
 *
 * Run with REST STOPPED: it reads the document as REST would have written it. The document is NOT changed; removing
 * its column nodes is a separate, verified step, not this one.
 *
 * Without --apply it is a DRY RUN: it reads the graph, prints the plan, and sends nothing.
 * With --apply every document column the graph does not hold yet is created in ONE guarded update, through the same
 * machinery a REST write uses (core/columns-unit.mjs → the compiler's entity.put kind 'collection'):
 *   · a create is a FRESH SUBJECT: a column the graph already holds is never overwritten (and not sent at all);
 *   · the opId is derived from the content sent (never random) and the write goes through durableUpdate: an UNKNOWN
 *     outcome is settled by the receipt, replayed only when the receipt is ABSENT. A re-run therefore writes nothing twice.
 *
 * After an --apply it reads the columns back and compares each document column with the graph's: COMPLETE only when
 * every document column is held with the SAME content. A column the graph already held with DIFFERENT content is
 * reported by name and makes the run INCOMPLETE (exit 1); it is never overwritten.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { jsonLdToDomain, isJsonLdDocument } from '../core/jsonld.mjs';
import { domainToBoard } from '../core/mapping.mjs';
import { createColumnsUnit, columnToNode } from '../core/columns-unit.mjs';

const USAGE = 'usage: node scripts/migrate-columns-1639.mjs --board-data <path> --executor <url> --dataset <id> [--apply]';
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const file = opt('--board-data'); const executor = opt('--executor'); const dataset = opt('--dataset'); const apply = args.includes('--apply');
const missingFlags = [['--board-data', file], ['--executor', executor], ['--dataset', dataset]].filter(([, v]) => !v).map(([k]) => k);
if (missingFlags.length) {
  console.error(`missing ${missingFlags.join(', ')}\n${USAGE}`);
  process.exit(2);
}
const ACTOR = 'https://scrumboard.local/person/board';
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const board = domainToBoard(isJsonLdDocument(raw) ? jsonLdToDomain(raw) : raw);
const docColumns = (Array.isArray(board.columns) ? board.columns : []).filter((c) => c && typeof c.id === 'string' && c.id);
if (!docColumns.length) { console.error('the document holds no columns: nothing to migrate (refusing: a unit-on board needs its columns)'); process.exit(1); }

const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 120000 });
const unit = createColumnsUnit({ client: g, mintId: () => 'unused' });

/** id → wire JSON of the column the graph holds now */
async function graphHolds() {
  await unit.load();
  return new Map(unit.snapshot().map((c) => [c.id, c]));
}
const same = (a, b) => JSON.stringify(columnToNode(a)) === JSON.stringify(columnToNode(b));

const before = await graphHolds();
const toCreate = docColumns.filter((c) => !before.has(c.id));
console.log(`document: ${docColumns.length} column(s) · graph before: ${before.size} · to create: ${toCreate.map((c) => c.id).join(', ') || 'none'} · ${apply ? 'APPLY' : 'DRY RUN (nothing sent)'}`);

let outcome = 'NONE';
if (apply && toCreate.length) {
  // The target is the graph's columns as they are PLUS the missing ones: the plan is then creates only (never an update).
  const parts = unit.plan([...before.values(), ...toCreate]);
  if (parts.some((p) => p.expectedVersion != null || p.remove)) throw new Error('the plan would change a column the graph holds; refusing');
  const opId = `urn:ex:op/collection/import/columns/${sha(JSON.stringify(parts.map((p) => [p.iri, p.json]).sort()))}`;
  const r = await durableUpdate(g, { kind: 'entity.put', opId, actor: ACTOR, entity: { kind: 'collection', parts } });
  outcome = r.outcome;
  if (r.outcome !== 'APPLIED' && r.outcome !== 'PRECONDITION_FAILED') {
    console.error(`the write's outcome is ${r.outcome}${r.reason ? `: ${r.reason}` : ''}. Stopped; a re-run is safe (the opId is derived)`);
    process.exit(1);
  }
}

const after = await graphHolds();
const missing = []; const differ = [];
for (const c of docColumns) {
  const got = after.get(c.id);
  if (!got) missing.push(c.id);
  else if (!same(got, c)) differ.push(c.id);
}
console.log(`write: ${outcome}`);
console.log(`graph after: ${after.size} column(s)`);
console.log(`read-back: ${missing.length} not in the graph, ${differ.length} in the graph with DIFFERENT content`);
for (const s of missing) console.log(`  NOT IN THE GRAPH: ${s}`);
for (const s of differ) console.log(`  DIFFERENT CONTENT: ${s}`);
if (apply) {
  if (missing.length || differ.length) { console.log('INCOMPLETE: the document keeps its columns; nothing was overwritten.'); process.exit(1); }
  console.log('COMPLETE: every document column is in the graph with the same content.');
}
