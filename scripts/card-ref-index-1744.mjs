#!/usr/bin/env node
/**
 * #1744 (#1629 slice 4) — initialise or verify the derived CARD REFERENCE INDEX (contract v2 V2-2, F2, F3).
 *
 *   node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --backfill   write, then verify
 *   node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --verify     verify only, write nothing
 *   node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --verify-and-latch   the SCHEDULED check (below)
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
 *
 * --verify-and-latch (contract amendment, rulings 46773/46781; the daily and per-deploy schedule): the FULL JSON check at
 * one consistent store position (core/card-ref-index-verify.mjs). A violation LATCHES the marker `complete "false"` with
 * its reason and time, and every index layer then refuses as built (boot, required-at-runtime, the marker-keyed guard).
 * It never repairs and never re-opens a latched marker: recovery is an explicit --backfill with writers stopped.
 *   exit 0  COMPLETE                     the index is exact (a latched marker stays latched: exit 1, LATCHED)
 *   exit 1  LATCHED <n> violation(s)     the latch is written AND read back as false
 *   exit 2  CLOSURE UNCONFIRMED <why>    a violation was found but the latch could not be confirmed, or the executor could
 *                                        not be read, or the index is exact under an ABSENT or malformed marker (index-keyed
 *                                        writes are admitted with no marker): NEVER reported as fail-closed
 *   exit 3  UNSTABLE                     the store never held still for a consistent read; nothing judged, nothing written
 * --verify stays strictly read-only: it reports the same statuses and writes nothing.
 */
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';
import { CRI, CARD_REF_INDEX_NS, coverageTriplesText, markerTripleText } from '../core/card-ref-index.mjs';
import { verifyIndex, liveCardsSparql } from '../core/card-ref-index-verify.mjs';

const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const ENTITY = 'https://scrumboard.local/entity/';
const VER = 'urn:ex:ver';
const BATCH = 200;
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const base = String(arg('--executor') || '').replace(/\/+$/, '');
const dataset = arg('--dataset');
const WRITE = process.argv.includes('--backfill');
const LATCH = process.argv.includes('--verify-and-latch');
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
  const r = await fetch(`${base}/update`, { method: 'POST', body: sparql, headers: { 'x-op-id': `urn:ex:op/card-ref-index/${tag}/${Date.now()}-${process.pid}-${opN++}`, 'x-epoch': ep, 'x-manyhands-write-protocol': 'postseq-v1' } });   // the #1748 floor; ignored on a store without one
  if (!r.ok) refuse('WRITE_FAILED', `${tag}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

const liveCards = async () => {
  const rows = await query(liveCardsSparql);
  const missing = rows.filter((b) => !b.v || !b.j).map((b) => b.c.value.slice(ENTITY.length));
  if (missing.length) refuse('CARD_INCOMPLETE', `${missing.length} live card(s) without a version or stored JSON: ${missing.slice(0, 5).join(', ')}`);
  return rows.map((b) => ({ iri: b.c.value, id: b.c.value.slice(ENTITY.length), ver: Number(b.v.value), json: b.j.value }));
};

async function main() {
  if (!base || !dataset) refuse('USAGE', 'node scripts/card-ref-index-1744.mjs --executor <url> --dataset <id> --backfill|--verify|--verify-and-latch');
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
  const v = await verifyIndex({ query, health, dataset });
  if (LATCH) return latch(v);
  if (v.status === 'UNSTABLE') { console.log('UNSTABLE the store never held still for a consistent read; nothing judged'); process.exit(3); }
  const { bad, cards } = v;
  if (bad.length) refuse('INDEX_INCOMPLETE', `${bad.length} violation(s): ${bad.slice(0, 5).join('; ')}`);
  if (WRITE) await update(`INSERT DATA { GRAPH <${BK}> { ${markerTripleText()} } }`, 'mark');
  const marks = await query(`SELECT ?v WHERE { GRAPH <${BK}> { <${CRI.marker}> <${CRI.complete}> ?v } }`);
  if (marks.length !== 1 || marks[0].v.value !== 'true') refuse('MARKER', `the completion marker reads ${JSON.stringify(marks.map((m) => m.v.value))}`);
  console.log(`cards ${cards.length}`);
  console.log('COMPLETE');
}

/** --verify-and-latch: a violation latches the marker false and is confirmed by read-back, or reported UNCONFIRMED. */
async function latch(v) {
  if (v.status === 'UNSTABLE') { console.log('UNSTABLE the store never held still for a consistent read; nothing judged, nothing written'); process.exit(3); }
  if (v.status === 'EXACT') {
    if (v.marker.length === 1 && v.marker[0] === 'true') { console.log(`cards ${v.cards.length}`); console.log('COMPLETE'); process.exit(0); }
    // an exact index under a latched marker stays latched: re-opening is --backfill's job, with writers stopped
    if (v.marker.length === 1 && v.marker[0] === 'false') { console.log(`LATCHED the marker reads ["false"]; it stays until an explicit --backfill`); process.exit(1); }
    // an ABSENT or malformed marker is not a closure: index-keyed writes are admitted while no marker exists, and nothing
    // here wrote one, so the closure is reported as unconfirmed, never as LATCHED
    console.log(`CLOSURE UNCONFIRMED the index is exact but the marker reads ${JSON.stringify(v.marker)}: writes keyed to it are not confirmed closed; run --backfill with writers stopped`);
    process.exit(2);
  }
  const reason = `${v.bad.length} violation(s) at commitSeq ${v.commitSeq}: ${v.bad.slice(0, 5).join('; ')}`.slice(0, 900);
  const at = new Date().toISOString();
  try {
    await update(`DELETE { GRAPH <${BK}> { <${CRI.marker}> ?p ?o } } INSERT { GRAPH <${BK}> { <${CRI.marker}> <${CRI.complete}> "false"^^<http://www.w3.org/2001/XMLSchema#boolean> ; <${CRI.latchReason}> ${JSON.stringify(reason)} ; <${CRI.latchedAt}> "${at}"^^<http://www.w3.org/2001/XMLSchema#dateTime> } } WHERE { OPTIONAL { GRAPH <${BK}> { <${CRI.marker}> ?p ?o } } }`, 'latch');
    const back = (await query(`SELECT ?v WHERE { GRAPH <${BK}> { <${CRI.marker}> <${CRI.complete}> ?v } }`)).map((b) => b.v.value);
    if (back.length !== 1 || back[0] !== 'false') throw new Error(`the marker reads ${JSON.stringify(back)} after the latch`);
  } catch (e) {
    console.log(`CLOSURE UNCONFIRMED ${reason} | the latch could not be confirmed: ${String(e?.message || e).slice(0, 200)}`);
    process.exit(2);
  }
  console.log(`LATCHED ${reason}`);
  process.exit(1);
}

main().then(() => process.exit(0), (e) => {
  // with --verify-and-latch, a run that could not even read the executor has not failed closed: it is UNCONFIRMED
  if (LATCH) { console.log(`CLOSURE UNCONFIRMED the verification did not complete: ${String(e?.message || e).slice(0, 300)}`); process.exit(2); }
  console.log(e instanceof Refused ? e.message : `REFUSED ERROR ${String(e?.message || e).slice(0, 300)}`); process.exit(1);
});
