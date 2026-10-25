/**
 * #1744 — the FULL card-reference-index verifier: the index against the cards' stored JSON, not merely its internal
 * consistency (contract amendment, ruling 46773: the runtime guards prove consistency; only this proves the name sets
 * match the JSON). Shared by scripts/card-ref-index-1744.mjs (--verify, --verify-and-latch, --backfill) and the server's
 * boot gate, so the check a start runs is the check the schedule runs.
 *
 * CONSISTENT POSITION (ruling 46781): the cards and the coverage are read at one store position. The executor's
 * commitSeq is read before and after the reads; if a compiled write moved it in between, the reads are retried, and a
 * store that never holds still for long enough answers UNSTABLE, never a corruption report. (A raw /update does not move
 * commitSeq; the index is maintained only by compiled card writes, so those are what can race it.)
 *
 * Pure of I/O beyond the `query` and `health` functions it is given.
 */
import { BOOKKEEPING_GRAPH } from './graph-vocab.mjs';
import { CRI, CARD_REF_INDEX_NS, cardNames, jsonDigest } from './card-ref-index.mjs';

const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const ENTITY = 'https://scrumboard.local/entity/';
const VER = 'urn:ex:ver';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';

export const liveCardsSparql = `SELECT ?c ?v ?j WHERE { ?c a <${RS}Card> . GRAPH <${BK}> { ?c <${VER}> ?v ; <${RS}entityJson> ?j } }`;
const coverageSparql = `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${CARD_REF_INDEX_NS}card/")) } }`;
export const markerSparql = `SELECT ?v WHERE { GRAPH <${BK}> { <${CRI.marker}> <${CRI.complete}> ?v } }`;

/** Every invariant violation in one consistent read, by name; [] means the index is exact. */
function judge(cardRows, cov) {
  const bad = [];
  const cards = cardRows.map((b) => ({ iri: b.c.value, id: b.c.value.slice(ENTITY.length), ver: Number(b.v.value), json: b.j.value }));
  const byIri = new Map();
  for (const c of cards) { if (byIri.has(c.iri)) bad.push(`card ${c.id} has more than one version or JSON`); byIri.set(c.iri, c); }
  const nodes = new Map();
  for (const b of cov) {
    const n = nodes.get(b.s.value) || { versions: [], digests: [], names: [], counts: [], sums: [], lists: [], other: [] };
    if (b.p.value === CRI.indexedVersion) n.versions.push(b.o); else if (b.p.value === CRI.indexedJsonDigest) n.digests.push(b.o);
    else if (b.p.value === CRI.namesCount) n.counts.push(b.o); else if (b.p.value === CRI.namesSum) n.sums.push(b.o);
    else if (b.p.value === CRI.namesShortId) n.names.push(b.o); else if (b.p.value === CRI.namesList) n.lists.push(b.o); else n.other.push(b.p.value);
    nodes.set(b.s.value, n);
  }
  for (const c of cards) {
    const n = nodes.get(CRI.card(c.id));
    if (!n) { bad.push(`card ${c.id} has no coverage node`); continue; }
    if (n.versions.length !== 1 || n.versions[0].datatype !== XSD_INT || Number(n.versions[0].value) !== c.ver) bad.push(`card ${c.id}: indexedVersion is not exactly ${c.ver}`);
    if (n.digests.length !== 1 || n.digests[0].datatype || n.digests[0].value !== jsonDigest(c.json)) bad.push(`card ${c.id}: indexedJsonDigest is not exactly the stored JSON's`);
    let ws;
    try { ws = cardNames(JSON.parse(c.json)); } catch { bad.push(`card ${c.id}: its stored JSON does not parse`); continue; }
    const want = ws.join(',');
    if (n.names.some((x) => x.datatype !== XSD_INT)) bad.push(`card ${c.id}: a namesShortId is not an xsd:integer`);
    const got = n.names.map((x) => Number(x.value)).sort((a, b) => a - b).join(',');
    if (got !== want) bad.push(`card ${c.id}: names {${got}}, it names {${want}}`);
    if (n.counts.length !== 1 || Number(n.counts[0].value) !== ws.length || n.sums.length !== 1 || Number(n.sums[0].value) !== ws.reduce((a, b) => a + b, 0)) bad.push(`card ${c.id}: the names' count/sum watermark is not exact`);
    if (n.lists.length !== 1 || n.lists[0].datatype || n.lists[0].value !== want) bad.push(`card ${c.id}: namesList is not exactly "${want}"`);
    if (n.other.length) bad.push(`card ${c.id}: unexpected predicates ${n.other.join(' ')}`);
  }
  for (const s of nodes.keys()) if (!byIri.has(`${ENTITY}${s.slice(`${CARD_REF_INDEX_NS}card/`.length)}`)) bad.push(`orphan coverage ${s}`);
  return { bad, cards };
}

/**
 * Verify the index at one consistent position. `query(sparql)` returns bindings (it throws on failure); `health()` returns
 * the executor's /health body. Returns { status: 'EXACT'|'VIOLATED'|'UNSTABLE', bad, cards, commitSeq, marker } where
 * `marker` is the completion marker's values as read at that position.
 */
export async function verifyIndex({ query, health, attempts = 5 }) {
  for (let i = 0; i < attempts; i++) {
    const before = String((await health()).commitSeq);
    const cardRows = await query(liveCardsSparql);
    const cov = await query(coverageSparql);
    const marker = (await query(markerSparql)).map((b) => b.v.value);
    const after = String((await health()).commitSeq);
    if (before !== after) continue;
    const { bad, cards } = judge(cardRows, cov);
    return { status: bad.length ? 'VIOLATED' : 'EXACT', bad, cards, commitSeq: before, marker };
  }
  return { status: 'UNSTABLE', bad: [], cards: [], commitSeq: null, marker: [] };
}
