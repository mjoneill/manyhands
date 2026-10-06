#!/usr/bin/env node
/**
 * #1582 unit 3 — MOVE THE DOCUMENT'S DELIVERIES AND MODEL CALLS INTO THE GRAPH.
 *
 *   node scripts/migrate-unit3-1582.mjs --board-data <path> --executor <url> --dataset <id> [--apply]
 *
 * Without --apply it reads both sides and reports what it WOULD write; nothing is sent. With --apply:
 *   1. every model call, at its EXISTING IRI (delivery steps link to those IRIs), one `modelcall.create` each. The
 *      postedText guard runs inside each update, so a call that quoted a post since redacted is moved without the text;
 *   2. every delivery, at its DERIVED IRI (deliveryIriOf(to, conversation), the identity live creates use), with its whole
 *      history in ONE `delivery.import` (steps 1..n, version n).
 * Every opId is derived from the row, so a re-run replays the receipts and writes nothing twice; a delivery the graph
 * already holds (created live since the unit went on) is PRECONDITION_FAILED and left as it is.
 *
 * Stop the guest runners first: a delivery's id changes from its random document IRI to the derived one, and a runner
 * holding an old id mid-turn would get a 404 for its next step. The document's collections are NOT removed; with the unit
 * on they are not read, and they stay for a rollback (which would not hold rows written to the graph after the switch).
 */
import fs from 'node:fs';
import { createGraphClient } from '../core/graph-client.mjs';
import * as U3 from '../core/unit3-graph.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = opt('--board-data'); const executor = opt('--executor'); const dataset = opt('--dataset'); const apply = args.includes('--apply');
if (!file || !executor || !dataset) {
  console.error('usage: node scripts/migrate-unit3-1582.mjs --board-data <path> --executor <url> --dataset <id> [--apply]');
  process.exit(2);
}

const PERSON = 'https://scrumboard.local/person/';
const ENTITY = 'https://scrumboard.local/entity/';
const RS = 'https://scrumboard.local/ns#';
const actor = (who) => `${PERSON}${encodeURIComponent(typeof who === 'string' && who ? who : 'board')}`;

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const graph = Array.isArray(doc['@graph']) ? doc['@graph'] : [];
const calls = graph.filter((n) => n && n['@type'] === 'scrum:ModelCall');
const deliveries = graph.filter((n) => n && n['@type'] === 'scrum:Delivery');
const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 60000 });

const skipped = []; const refused = [];
const callSuffix = (iri) => (typeof iri === 'string' && /^https:\/\/scrumboard\.local\/model-call\/[A-Za-z0-9-]{1,64}$/.test(iri) ? iri.slice(U3.MODEL_CALL_PREFIX.length) : null);

function callIntention(e) {
  const suffix = callSuffix(e['@id']);
  if (!suffix) return { skip: `model call ${JSON.stringify(e['@id'])}: not an IRI REST can address` };
  if (typeof e['scrum:agent'] !== 'string' || !e['scrum:agent']) return { skip: `model call ${e['@id']}: no agent` };
  if (typeof e['scrum:calledAt'] !== 'string' || !e['scrum:calledAt']) return { skip: `model call ${e['@id']}: no calledAt` };
  const pp = e['scrum:producedPost'];
  const ppIri = typeof pp === 'string' && U3.POST_ID_RE.test(pp) ? `${ENTITY}${pp}` : null;
  const text = typeof e['scrum:postedText'] === 'string' ? e['scrum:postedText'] : null;
  return { intention: {
    kind: 'modelcall.create', opId: `urn:ex:op/model-call/import/${suffix}`, actor: actor(e.creator ?? e['scrum:agent']),
    call: { iri: e['@id'], agent: e['scrum:agent'], model: typeof e['scrum:model'] === 'string' ? e['scrum:model'] : null, calledAt: e['scrum:calledAt'],
      cost: String(Number(e['scrum:cost']) || 0), producedPost: ppIri,
      // the same rule as REST: text is stored only where the redaction guard can see its post
      postedText: text != null && (pp == null || ppIri != null) ? text : null,
      requestId: `import-${suffix}`, entityJson: JSON.stringify({ ...e, 'scrum:postedText': null }) },
  } };
}

function deliveryIntention(e) {
  const to = e['scrum:deliveredTo']; const conv = e['scrum:ofConversation'];
  if (!U3.SEAT_RE.test(String(to))) return { skip: `delivery ${e['@id']}: deliveredTo ${JSON.stringify(to)} is not a seat key` };
  if (!U3.POST_ID_RE.test(String(conv))) return { skip: `delivery ${e['@id']}: conversation ${JSON.stringify(conv)} cannot be an IRI` };
  const events = Array.isArray(e['scrum:hasEvent']) ? e['scrum:hasEvent'] : [];
  if (!events.length) return { skip: `delivery ${e['@id']}: no events` };
  const iri = U3.deliveryIriOf(to, conv);
  const source0 = events[0]['scrum:source'] || 'fanout';
  const offeredAt = e['scrum:offeredAt'] || events[0]['scrum:at'];
  const steps = events.map((ev, k) => ({
    iri: U3.stepIri(iri, k + 1), index: String(k + 1), state: String(ev['scrum:state']), at: ev['scrum:at'] || offeredAt,
    source: ev['scrum:source'] || source0,
    ...(ev.creator != null ? { creator: String(ev.creator) } : {}),
    ...(Number.isInteger(ev['scrum:attempt']) ? { attempt: ev['scrum:attempt'] } : {}),
    ...(ev['scrum:reason'] ? { reason: String(ev['scrum:reason']) } : {}),
    ...(ev.text ? { text: String(ev.text) } : {}),
    ...(ev['scrum:traceId'] ? { traceId: String(ev['scrum:traceId']) } : {}),
    ...(ev['scrum:ofModelCall'] ? { ofModelCall: ev['scrum:ofModelCall'] } : {}),
  }));
  return { intention: {
    kind: 'delivery.import', opId: `urn:ex:op/delivery/${U3.deliverySuffix(iri)}/import`, actor: actor(e.creator),
    delivery: { iri, deliveredTo: to, ofConversation: `${ENTITY}${conv}`, source: source0, offeredAt, steps },
  } };
}

async function count(type) {
  const q = await g.query(`SELECT (COUNT(?s) AS ?n) WHERE { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RS}${type}> }`);
  if (!q.ok) throw new Error(`the graph could not be read: ${q.reason}`);
  return Number(q.rows[0]?.n?.value ?? 0);
}

async function run(label, rows, build) {
  const tally = { APPLIED: 0, PRECONDITION_FAILED: 0, skipped: 0, refused: 0 };
  const t0 = Date.now();
  for (const [k, e] of rows.entries()) {
    const b = build(e);
    if (b.skip) { skipped.push(b.skip); tally.skipped++; continue; }
    if (!apply) continue;
    const r = await g.update(b.intention);
    if (r.outcome === 'APPLIED' || r.outcome === 'PRECONDITION_FAILED') tally[r.outcome]++;
    else if (r.outcome === 'REJECTED') { refused.push(`${label} ${e['@id']}: ${r.reason}`); tally.refused++; }
    else throw new Error(`${label} ${e['@id']}: ${r.outcome} ${r.reason ?? ''} — stopped; a re-run is safe (every opId is derived)`);
    if ((k + 1) % 500 === 0) console.error(`${label}: ${k + 1}/${rows.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  return { ...tally, seconds: Math.round((Date.now() - t0) / 1000) };
}

const before = { ModelCall: await count('ModelCall'), Delivery: await count('Delivery'), DeliveryStep: await count('DeliveryStep') };
const steps = deliveries.reduce((n, d) => n + (Array.isArray(d['scrum:hasEvent']) ? d['scrum:hasEvent'].length : 0), 0);
console.log(`document: ${calls.length} model calls, ${deliveries.length} deliveries, ${steps} steps · graph before: ${JSON.stringify(before)} · ${apply ? 'APPLY' : 'DRY RUN (nothing sent)'}`);
const mc = await run('model call', calls, callIntention);
const dl = await run('delivery', deliveries, deliveryIntention);
const after = { ModelCall: await count('ModelCall'), Delivery: await count('Delivery'), DeliveryStep: await count('DeliveryStep') };
console.log(`model calls: ${JSON.stringify(mc)}`);
console.log(`deliveries:  ${JSON.stringify(dl)}`);
console.log(`graph after: ${JSON.stringify(after)}`);
for (const s of skipped.slice(0, 20)) console.log(`  skipped: ${s}`);
for (const s of refused.slice(0, 20)) console.log(`  REFUSED: ${s}`);
if (apply) {
  // The check that matters: every document row is in the graph. A live create since the switch can only ADD to the graph.
  const short = [];
  if (after.ModelCall < calls.length - mc.skipped) short.push(`model calls ${after.ModelCall} < ${calls.length - mc.skipped}`);
  if (after.Delivery < deliveries.length - dl.skipped) short.push(`deliveries ${after.Delivery} < ${deliveries.length - dl.skipped}`);
  if (short.length || refused.length) { console.log(`INCOMPLETE: ${[...short, `${refused.length} refused`].join('; ')}`); process.exit(1); }
  console.log('COMPLETE: every document row that could be moved is in the graph.');
}
