/**
 * #1744 — the FULL card-reference-index verifier: the index against the cards' stored JSON, not merely its internal
 * consistency (contract amendment, ruling 46773: the runtime guards prove consistency; only this proves the name sets
 * match the JSON). Shared by scripts/card-ref-index-1744.mjs (--verify, --verify-and-latch, --backfill) and the server's
 * boot gate, so the check a start runs is the check the schedule runs.
 *
 * CONSISTENT POSITION (ruling 46781): the cards and the coverage are read at one store position. The executor's
 * commitSeq is read before and after the reads; if a compiled write moved it in between, the reads are retried, and a
 * store that never holds still for long enough answers UNSTABLE, never a corruption report. (A raw /update does not move
 * commitSeq; the index is maintained only by compiled card writes, so those are what can race it.) The position is the
 * whole identity, dataset · epoch · incarnation · commitSeq, and each part must be PRESENT and well-formed: a health body
 * that lacks one cannot prove two reads were at one position (two missing values are not equal), so it throws.
 *
 * CENSUS: every live Card is enumerated first, and its version, its JSON and its coverage are then each required: a card
 * missing its metadata is a violation by name, never a card the check silently skipped.
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

// every live Card, whether or not its metadata is present: OPTIONAL, so a card without a version or JSON is still a row
export const liveCardsSparql = `SELECT ?c ?v ?j WHERE { ?c a <${RS}Card> . OPTIONAL { GRAPH <${BK}> { ?c <${VER}> ?v } } OPTIONAL { GRAPH <${BK}> { ?c <${RS}entityJson> ?j } } }`;
const coverageSparql = `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${CARD_REF_INDEX_NS}card/")) } }`;
export const markerSparql = `SELECT ?v WHERE { GRAPH <${BK}> { <${CRI.marker}> <${CRI.complete}> ?v } }`;

/** Every invariant violation in one consistent read, by name; [] means the index is exact. */
function judge(cardRows, cov) {
  const bad = [];
  const cards = cardRows.map((b) => ({ iri: b.c.value, id: b.c.value.slice(ENTITY.length), ver: b.v ? Number(b.v.value) : undefined, json: b.j?.value }));
  const byIri = new Map();
  for (const c of cards) { if (byIri.has(c.iri)) bad.push(`card ${c.id} has more than one version or JSON`); byIri.set(c.iri, c); }
  for (const c of cards) {
    if (c.ver === undefined) bad.push(`card ${c.id} has no version`);
    if (c.json === undefined) bad.push(`card ${c.id} has no stored JSON`);
  }
  const nodes = new Map();
  for (const b of cov) {
    const n = nodes.get(b.s.value) || { versions: [], digests: [], names: [], counts: [], sums: [], lists: [], other: [] };
    if (b.p.value === CRI.indexedVersion) n.versions.push(b.o); else if (b.p.value === CRI.indexedJsonDigest) n.digests.push(b.o);
    else if (b.p.value === CRI.namesCount) n.counts.push(b.o); else if (b.p.value === CRI.namesSum) n.sums.push(b.o);
    else if (b.p.value === CRI.namesShortId) n.names.push(b.o); else if (b.p.value === CRI.namesList) n.lists.push(b.o); else n.other.push(b.p.value);
    nodes.set(b.s.value, n);
  }
  for (const c of cards) {
    if (c.ver === undefined || c.json === undefined) continue;   // named above; its coverage cannot be judged against nothing
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

const DIGITS = /^\d+$/;
/** The store position a /health body names, or a throw: every part present, single-valued and well-formed. */
export function storePosition(h, dataset) {
  const why = [];
  if (!h || typeof h !== 'object') throw new Error('the executor health body is not an object');
  if (h.markerError) why.push(`markerError ${h.markerError}`);
  if (typeof h.datasetId !== 'string' || !h.datasetId) why.push('no datasetId');
  else if (dataset !== undefined && h.datasetId !== dataset) why.push(`datasetId ${h.datasetId}, not ${dataset}`);
  for (const k of ['epoch', 'commitSeq']) if (typeof h[k] !== 'string' || !DIGITS.test(h[k])) why.push(`${k} ${JSON.stringify(h[k] ?? null)} is not an integer`);
  if (typeof h.incarnation !== 'string' || !h.incarnation || h.incarnation.startsWith('CONTRADICTORY')) why.push(`incarnation ${JSON.stringify(h.incarnation ?? null)}`);
  if (why.length) throw new Error(`the executor health does not name one store position: ${why.join('; ')}`);
  return { datasetId: h.datasetId, epoch: h.epoch, incarnation: h.incarnation, commitSeq: h.commitSeq };
}
const samePosition = (a, b) => a.datasetId === b.datasetId && a.epoch === b.epoch && a.incarnation === b.incarnation && a.commitSeq === b.commitSeq;

/**
 * Verify the index at one consistent position. `query(sparql)` returns bindings (it throws on failure); `health()` returns
 * the executor's /health body; `dataset`, when given, is the dataset the position must name. Returns
 * { status: 'EXACT'|'VIOLATED'|'UNSTABLE', bad, cards, commitSeq, position, marker } where `marker` is the completion
 * marker's values as read at that position. A health body that names no well-formed position THROWS (storePosition).
 */
export async function verifyIndex({ query, health, dataset, attempts = 5 }) {
  for (let i = 0; i < attempts; i++) {
    const before = storePosition(await health(), dataset);
    const cardRows = await query(liveCardsSparql);
    const cov = await query(coverageSparql);
    const marker = (await query(markerSparql)).map((b) => b.v.value);
    const after = storePosition(await health(), dataset);
    if (!samePosition(before, after)) continue;
    const { bad, cards } = judge(cardRows, cov);
    return { status: bad.length ? 'VIOLATED' : 'EXACT', bad, cards, commitSeq: before.commitSeq, position: before, marker };
  }
  return { status: 'UNSTABLE', bad: [], cards: [], commitSeq: null, position: null, marker: [] };
}
