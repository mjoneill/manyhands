#!/usr/bin/env node
/**
 * #1744 (#1629 slice 4) — initialise or verify the derived CARD REFERENCE INDEX (contract v2 V2-2, F2, F3).
 *
 *   node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --backfill   write, then verify
 *   node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --verify     verify only, write nothing
 *
 * Run with card WRITERS STOPPED (F3: "perform the guarded complete backfill with writers quiesced"). It:
 *   1. removes the completion marker, so the index is NOT USABLE while it runs (every index-dependent write refuses);
 *   2. snapshots every live card (id, graph version, stored entityJson) and writes its coverage node in batches, each ONE
 *      update guarded on every card in it still being at its snapshot version (a card that changed makes the batch a no-op);
 *   3. removes coverage for any subject that is not a live card;
 *   4. verifies the WHOLE invariant (exactly one node per live card, version and JSON digest equal, the EXACT name set, no
 *      orphan, no duplicate watermark) and only then writes the marker `complete true`.
 * Output: `cards <n>` then `COMPLETE` and exit 0, or `REFUSED <CODE> <why>` and exit 1. The marker is never written over a
 * failed verification. A fresh empty board gets an explicit, verified empty index the same way (F3).
 */
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';
import { CRI, CARD_REF_INDEX_NS, cardNames, jsonDigest, coverageTriplesText, markerTripleText } from '../core/card-ref-index.mjs';

const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const ENTITY = 'https://scrumboard.local/entity/';
const VER = 'urn:ex:ver';
const BATCH = 200;
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const base = String(arg('--executor') || '').replace(/\/+$/, '');
const dataset = arg('--dataset');
const WRITE = process.argv.includes('--backfill');
class Refused extends Error { constructor(code, why) { super(`REFUSED ${code} ${why}`); } }
const refuse = (code, why) => { throw new Refused(code, why); };

let opN = 0;
async function health() { return (await fetch(`${base}/health`)).json(); }
async function query(sparql) {
  const r = await fetch(`${base}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/card-ref-index/read/${process.pid}-${opN++}` }, body: sparql });
  if (!r.ok) refuse('UNAVAILABLE', `query ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).results.bindings;
}
async function update(sparql, tag) {
  const ep = String((await health()).epoch);
  const r = await fetch(`${base}/update`, { method: 'POST', body: sparql, headers: { 'x-op-id': `urn:ex:op/card-ref-index/${tag}/${Date.now()}-${process.pid}-${opN++}`, 'x-epoch': ep } });
  if (!r.ok) refuse('WRITE_FAILED', `${tag}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

const liveCards = async () => (await query(`SELECT ?c ?v ?j WHERE { ?c a <${RS}Card> . GRAPH <${BK}> { ?c <${VER}> ?v ; <${RS}entityJson> ?j } }`))
  .map((b) => ({ iri: b.c.value, id: b.c.value.slice(ENTITY.length), ver: Number(b.v.value), json: b.j.value }));

/** Every invariant violation, by name; [] means the index is exact. */
async function violations() {
  const bad = [];
  const cards = await liveCards();
  const byIri = new Map();
  for (const c of cards) { if (byIri.has(c.iri)) bad.push(`card ${c.id} has more than one version or JSON`); byIri.set(c.iri, c); }
  const cov = await query(`SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${CARD_REF_INDEX_NS}card/")) } }`);
  const nodes = new Map();
  for (const b of cov) {
    const n = nodes.get(b.s.value) || { versions: [], digests: [], names: [], counts: [], sums: [], other: [] };
    if (b.p.value === CRI.indexedVersion) n.versions.push(b.o); else if (b.p.value === CRI.indexedJsonDigest) n.digests.push(b.o);
    else if (b.p.value === CRI.namesCount) n.counts.push(b.o); else if (b.p.value === CRI.namesSum) n.sums.push(b.o);
    else if (b.p.value === CRI.namesShortId) n.names.push(b.o); else n.other.push(b.p.value);
    nodes.set(b.s.value, n);
  }
  const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
  for (const c of cards) {
    const n = nodes.get(CRI.card(c.id));
    if (!n) { bad.push(`card ${c.id} has no coverage node`); continue; }
    if (n.versions.length !== 1 || n.versions[0].datatype !== XSD_INT || Number(n.versions[0].value) !== c.ver) bad.push(`card ${c.id}: indexedVersion is not exactly ${c.ver}`);
    if (n.digests.length !== 1 || n.digests[0].datatype || n.digests[0].value !== jsonDigest(c.json)) bad.push(`card ${c.id}: indexedJsonDigest is not exactly the stored JSON's`);
    const want = cardNames(JSON.parse(c.json)).join(',');
    if (n.names.some((x) => x.datatype !== XSD_INT)) bad.push(`card ${c.id}: a namesShortId is not an xsd:integer`);
    const got = n.names.map((x) => Number(x.value)).sort((a, b) => a - b).join(',');
    if (got !== want) bad.push(`card ${c.id}: names {${got}}, it names {${want}}`);
    const ws = cardNames(JSON.parse(c.json));
    if (n.counts.length !== 1 || Number(n.counts[0].value) !== ws.length || n.sums.length !== 1 || Number(n.sums[0].value) !== ws.reduce((a, b) => a + b, 0)) bad.push(`card ${c.id}: the names' count/sum watermark is not exact`);
    if (n.other.length) bad.push(`card ${c.id}: unexpected predicates ${n.other.join(' ')}`);
  }
  for (const s of nodes.keys()) if (!byIri.has(`${ENTITY}${s.slice(`${CARD_REF_INDEX_NS}card/`.length)}`)) bad.push(`orphan coverage ${s}`);
  return { bad, cards };
}

async function main() {
  if (!base || !dataset) refuse('USAGE', 'node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --backfill|--verify');
  const h = await health();
  if (h.datasetId !== dataset) refuse('WRONG_DATASET', `the executor serves ${h.datasetId}, not ${dataset}`);
  if (WRITE) {
    await update(`DELETE WHERE { GRAPH <${BK}> { <${CRI.marker}> ?p ?o } }`, 'unmark');   // not usable while it runs
    const snap = await liveCards();
    for (let i = 0; i < snap.length; i += BATCH) {
      const batch = snap.slice(i, i + BATCH);
      const subjects = batch.map((c) => `<${CRI.card(c.id)}>`).join(' ');
      const guard = batch.map((c, k) => `GRAPH <${BK}> { <${c.iri}> <${VER}> ?v${k} . FILTER(?v${k} = ${c.ver}) }`).join('\n  ');
      await update(`DELETE { GRAPH <${BK}> { ?s ?p ?o } } INSERT { GRAPH <${BK}> {\n${batch.map((c) => coverageTriplesText(c.id, c.ver, c.json)).join('\n')}\n} }
WHERE {\n  ${guard}\n  OPTIONAL { VALUES ?s { ${subjects} } GRAPH <${BK}> { ?s ?p ?o } }\n}`, `batch-${i / BATCH}`);
    }
    // coverage for anything that is not a live card is removed
    const live = new Set(snap.map((c) => CRI.card(c.id)));
    const covSubjects = [...new Set((await query(`SELECT DISTINCT ?s WHERE { GRAPH <${BK}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${CARD_REF_INDEX_NS}card/")) } }`)).map((b) => b.s.value))];
    for (const s of covSubjects) if (!live.has(s)) await update(`DELETE WHERE { GRAPH <${BK}> { <${s}> ?p ?o } }`, 'orphan');
    const after = await liveCards();
    if (after.length !== snap.length || after.some((c) => { const was = snap.find((x) => x.iri === c.iri); return !was || was.ver !== c.ver || was.json !== c.json; })) {
      refuse('CARDS_CHANGED', 'a card changed during the backfill: stop the writers and run it again (the marker stays absent)');
    }
  }
  const { bad, cards } = await violations();
  if (bad.length) refuse('INDEX_INCOMPLETE', `${bad.length} violation(s): ${bad.slice(0, 5).join('; ')}`);
  if (WRITE) await update(`INSERT DATA { GRAPH <${BK}> { ${markerTripleText()} } }`, 'mark');
  const marks = await query(`SELECT ?v WHERE { GRAPH <${BK}> { <${CRI.marker}> <${CRI.complete}> ?v } }`);
  if (marks.length !== 1 || marks[0].v.value !== 'true') refuse('MARKER', `the completion marker reads ${JSON.stringify(marks.map((m) => m.v.value))}`);
  console.log(`cards ${cards.length}`);
  console.log('COMPLETE');
}

main().then(() => process.exit(0), (e) => { console.log(e instanceof Refused ? e.message : `REFUSED ERROR ${String(e?.message || e).slice(0, 300)}`); process.exit(1); });
