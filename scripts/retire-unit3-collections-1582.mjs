#!/usr/bin/env node
/**
 * #1582 step 4 — REMOVE THE BOARD FILE'S COPIES OF DELIVERIES AND MODEL CALLS, once the graph holds every one of them.
 *
 *   node scripts/retire-unit3-collections-1582.mjs --board-data <path> --executor <url> --dataset <id> [--apply]
 *
 * RUN WITH REST STOPPED: this edits the board file directly, and REST holds it in memory.
 *
 * Without --apply it verifies and reports; nothing is written. With --apply, and only if EVERY document delivery
 * (by its derived graph IRI) and EVERY document model call (by its IRI) is in the graph, it drops exactly those
 * nodes from the file's @graph in ONE atomic write (tmp + rename) and appends ONE board-meta event to the event log
 * naming what left and where it went (#1598 K8: one bulk write, not one event per row). Every other node is kept as
 * parsed, and the script refuses to write if any other node count changed. Take a verified backup of the file first:
 * it is the row-level record of what was removed.
 */
import fs from 'node:fs';
import { createGraphClient } from '../core/graph-client.mjs';
import { appendEvent } from '../core/event-log.mjs';
import * as U3 from '../core/unit3-graph.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = opt('--board-data'); const executor = opt('--executor'); const dataset = opt('--dataset'); const apply = args.includes('--apply');
if (!file || !executor || !dataset) {
  console.error('usage: node scripts/retire-unit3-collections-1582.mjs --board-data <path> --executor <url> --dataset <id> [--apply]');
  process.exit(2);
}
const eventsDir = process.env.SCRUM_EVENT_LOG_DIR || `${file.replace(/\.json$/, '')}-events`;
const RS = 'https://scrumboard.local/ns#';
const T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const isDelivery = (n) => n && n['@type'] === 'scrum:Delivery';
const isCall = (n) => n && n['@type'] === 'scrum:ModelCall';

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(doc['@graph'])) { console.error(`${file} is not a JSON-LD board document`); process.exit(2); }
const graph = doc['@graph'];
const dels = graph.filter(isDelivery); const calls = graph.filter(isCall);
const want = [
  ...dels.map((e) => ({ id: e['@id'], type: 'Delivery', iri: U3.SEAT_RE.test(String(e['scrum:deliveredTo'])) && U3.POST_ID_RE.test(String(e['scrum:ofConversation'])) ? U3.deliveryIriOf(e['scrum:deliveredTo'], e['scrum:ofConversation']) : null })),
  ...calls.map((e) => ({ id: e['@id'], type: 'ModelCall', iri: /^https:\/\/scrumboard\.local\/model-call\/[A-Za-z0-9-]{1,64}$/.test(String(e['@id'])) ? e['@id'] : null })),
];
const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 60000 });
const missing = want.filter((w) => !w.iri);
for (const type of ['Delivery', 'ModelCall']) {
  const rows = want.filter((w) => w.iri && w.type === type);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const q = await g.query(`SELECT ?s WHERE { VALUES ?s { ${batch.map((w) => `<${w.iri}>`).join(' ')} } ?s <${T}> <${RS}${type}> }`);
    if (!q.ok) { console.error(`the graph could not be read: ${q.reason}`); process.exit(1); }
    const held = new Set(q.rows.map((r) => r.s.value));
    missing.push(...batch.filter((w) => !held.has(w.iri)));
  }
}
console.log(`${file}: ${dels.length} deliveries, ${calls.length} model calls in the file; ${want.length - missing.length} of ${want.length} verified in the graph · ${apply ? 'APPLY' : 'DRY RUN (nothing written)'}`);
if (missing.length) {
  for (const m of missing.slice(0, 10)) console.log(`  NOT IN THE GRAPH: ${m.type} ${m.id}`);
  console.log('REFUSED: run scripts/migrate-unit3-1582.mjs --apply first; nothing was written.');
  process.exit(1);
}
if (!dels.length && !calls.length) { console.log('nothing to remove.'); process.exit(0); }
if (!apply) process.exit(0);

const countBy = (nodes) => { const c = {}; for (const n of nodes) { const t = JSON.stringify(n?.['@type'] ?? null); c[t] = (c[t] || 0) + 1; } return c; };
const kept = graph.filter((n) => !isDelivery(n) && !isCall(n));
const before = countBy(graph); const after = countBy(kept);
delete before['"scrum:Delivery"']; delete before['"scrum:ModelCall"'];
if (JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(after).sort())) {
  console.error('REFUSED: a node count other than deliveries and model calls would change; nothing was written.'); process.exit(1);
}
const now = new Date().toISOString();
appendEvent(eventsDir, { op: 'update', actor: 'board', entity: { kind: 'board-meta', id: 'unit3-collections' },
  state: { retired: { deliveries: dels.length, modelCalls: calls.length }, movedTo: 'graph executor', verifiedInGraph: true, reason: '#1582: deliveries and model calls live in the graph' } }, { now });
const out = { ...doc, '@graph': kept };
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
fs.renameSync(tmp, file);
const reread = JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'];
console.log(`REMOVED ${dels.length} deliveries and ${calls.length} model calls; ${reread.length} nodes remain (was ${graph.length}); read back: ${reread.filter(isDelivery).length} deliveries, ${reread.filter(isCall).length} model calls.`);
