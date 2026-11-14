/**
 * #1689 — AMBIENT RECALL'S RECORDS ARE GRAPH NODES: three record kinds, against a real scratch executor. Each is a small node
 * of its own at an IRI derived from what it is about, so a repeat names the same node and the freshness guard refuses it.
 * Nothing rewrites the post or any other large entity.
 *
 * INTERFACE PINNED HERE:
 *   recall.offer { post, offers: [{ iri, source, assertion, score, bar }], at }   actor: the board's own service identity
 *     at recall/<sha256(post "\n" source)>: rdf:type scrum:RecallOffer · scrum:offerOn <post> · scrum:offeredSource <source> ·
 *     scrum:fromAssertion <claim> · scrum:score · scrum:minScore (the bar it cleared) · schema:dateCreated · prov:wasAssociatedWith
 *   recall.open { opening, offer, via: "seat"|"browser", at }   actor: the seat, or the board standing for a browser
 *     at <offer>/opened/<sha256(actor)>: rdf:type scrum:RecallOpening · scrum:ofOffer · scrum:openedBy · scrum:openedVia · schema:dateCreated
 *   recall.read { read, post, at }   actor: the seat that read the post
 *     at recall/read/<sha256(post "\n" actor)>: rdf:type scrum:RecallRead · scrum:readOf <post> · scrum:readBy <actor> · schema:dateCreated
 *
 *   G1  one post's offers in ONE update: a node per source, each with its claim, score, bar, time and actor
 *   G2  a second offer of the same source on the same post is refused, and takes its whole update with it
 *   G3  an offer is refused unless the post is a schema:Comment, the claim a scrum:Assertion and the source a scrum:SourceVersion
 *   G4  an IRI not derived from its parts is refused before anything is sent; the shape is checked (score ≥ bar, each source once)
 *   G5  an opening: one per (offer, opener), a re-open refused; a browser's opening says so; an opening of no offer is refused
 *   G6  a read: one per (post, seat), a re-read refused; a read of a post that carries no offer is refused
 *   G7  existing kinds digest exactly as before the three were added (RECORD_V is not bumped)
 *   G8  offersQuery reads the offers back as the items a post carries (the projection's rebuild)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { compile, RECORD_V } from '../core/graph-compiler.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { offerIri, openingIri, readIri, offerIntention, openIntention, readIntention, offersQuery, offersOfRows } from '../core/knowledge-recall.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const PROV = 'http://www.w3.org/ns/prov#';
const BOARD = 'https://scrumboard.local/person/board';
const SEAT = 'urn:ex:seat/seat-a';
const OTHER = 'urn:ex:seat/seat-b';
const at = () => new Date().toISOString();

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('krg-1689-');
  exec = await startExecutor({ store: storeDir, datasetId: 'krg-1689', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'krg-1689', timeoutMs: 30000 });
});
after(async () => { await killExecutor(exec); if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true }); });

const q = async (sparql) => { const r = await client.query(sparql); assert.ok(r.ok, `query failed: ${r.reason}`); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);
async function raw(body) {
  const res = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture applied (${res.status} ${await res.text()})`);
}
/** A post (schema:Comment with a postSeq), a source, a run and its claims, as the board and the extractor leave them. */
async function world({ claims = 2, seq = 7 } = {}) {
  const id = crypto.randomUUID();
  const post = `https://scrumboard.local/entity/${id}`;
  const src = `https://scrumboard.local/source/${crypto.createHash('sha256').update(id).digest('hex')}`;
  const run = `https://scrumboard.local/activity/run-${crypto.randomUUID()}`;
  const as = Array.from({ length: claims }, () => `https://scrumboard.local/assertion/${crypto.randomUUID()}`);
  await raw(`INSERT DATA { <${post}> <${RDF}type> <${SC}Comment> ; <${RS}postSeq> ${seq} ; <${SC}text> "a post" .
    <${src}> <${RDF}type> <${RS}SourceVersion> ; <${SC}name> "The source" ; <${SC}url> "https://example.com/s" .
    <${run}> <${RDF}type> <${PROV}Activity> ; <${RS}op> "extract" ; <${PROV}used> <${src}> .
    <${run}/extraction> <${RDF}type> <${RS}ExtractionReport> ; <${RS}ofRun> <${run}> ; <${RS}at> "2026-11-14T10:00:00.000Z" .
    ${as.map((a, i) => `<${a}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; <${RS}gist> "gist ${i}" ; <${RS}anchorText> "quote ${i}" .`).join('\n')} }`);
  return { id, post, src, run, as };
}
const item = (w, i = 0, score = 0.7) => ({ source: w.src, assertion: w.as[i], score, bar: 0.62 });

test('G1 one post\'s offers in ONE update: a node per source, with its claim, score, bar, time and actor', { skip: SKIP }, async () => {
  const a = await world(); const b = await world();
  const r = await client.update(offerIntention({ post: a.post, offers: [item(a), { ...item(b, 1, 0.65) }], actor: BOARD, at: at() }));
  assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
  for (const [w, k, score] of [[a, 0, '0.7'], [b, 1, '0.65']]) {
    const o = offerIri(a.post, w.src);
    assert.equal(await count(`<${o}> <${RDF}type> <${RS}RecallOffer> ; <${RS}offerOn> <${a.post}> ; <${RS}offeredSource> <${w.src}> ; <${RS}fromAssertion> <${w.as[k]}> ; <${RS}score> "${score}" ; <${RS}minScore> "0.62" ; <${SC}dateCreated> ?t ; <${PROV}wasAssociatedWith> <${BOARD}>`), 1);
  }
  assert.equal(await count(`<${a.post}> ?p ?o`), 3, 'the post itself is untouched: still its three triples');
});

test('G2 a second offer of the same source on the same post is refused, with its whole update', { skip: SKIP }, async () => {
  const a = await world(); const b = await world();
  assert.equal((await client.update(offerIntention({ post: a.post, offers: [item(a)], actor: BOARD, at: at() }))).outcome, 'APPLIED');
  const again = await client.update(offerIntention({ post: a.post, offers: [item(a, 1), item(b)], actor: BOARD, at: at() }));
  assert.equal(again.outcome, 'PRECONDITION_FAILED');
  assert.equal(await count(`<${offerIri(a.post, b.src)}> ?p ?o`), 0, 'nothing of the refused update landed');
  assert.equal(await count(`?o <${RS}offerOn> <${a.post}>`), 1);
});

test('G3 the post must be a Comment, the claim an Assertion, the source a SourceVersion', { skip: SKIP }, async () => {
  const a = await world();
  const notPost = `https://scrumboard.local/entity/${crypto.randomUUID()}`;
  for (const [what, i] of [['post', offerIntention({ post: notPost, offers: [item(a)], actor: BOARD, at: at() })],
    ['claim', offerIntention({ post: a.post, offers: [{ ...item(a), assertion: `https://scrumboard.local/assertion/${crypto.randomUUID()}` }], actor: BOARD, at: at() })],
    ['source', offerIntention({ post: a.post, offers: [{ ...item(a), source: a.run }], actor: BOARD, at: at() })]]) {
    assert.equal((await client.update(i)).outcome, 'PRECONDITION_FAILED', what);
  }
  assert.equal(await count(`?o <${RDF}type> <${RS}RecallOffer> ; <${RS}offerOn> <${a.post}>`), 0);
  await raw(`DELETE { <${a.post}> <${RDF}type> <${SC}Comment> } INSERT { <${a.post}> <${RDF}type> <${RS}RedactedPost> } WHERE { }`);
  assert.equal((await client.update(offerIntention({ post: a.post, offers: [item(a)], actor: BOARD, at: at() }))).outcome, 'PRECONDITION_FAILED', 'a redacted post is not offered anything');
});

test('G4 a non-derived IRI and a bad shape are refused before anything is sent', () => {
  const post = 'https://scrumboard.local/entity/x'; const source = 'https://scrumboard.local/source/s'; const assertion = 'https://scrumboard.local/assertion/a';
  const good = { kind: 'recall.offer', opId: 'urn:ex:op/x', actor: BOARD, post, at: '2026-11-14T10:00:00.000Z', offers: [{ iri: offerIri(post, source), source, assertion, score: 0.7, bar: 0.62 }] };
  assert.doesNotThrow(() => compile(good));
  const bad = (patch, re) => assert.throws(() => compile({ ...good, ...patch }), re);
  bad({ offers: [{ ...good.offers[0], iri: 'https://scrumboard.local/recall/nope' }] }, /recall\/<sha256/);
  bad({ offers: [{ ...good.offers[0], score: 0.5 }] }, /below its bar/);
  bad({ offers: [{ ...good.offers[0], score: 1.5 }] }, /\[0, 1\]/);
  bad({ offers: [] }, /at least one offer/);
  bad({ offers: [good.offers[0], { ...good.offers[0], assertion: 'https://scrumboard.local/assertion/b' }] }, /each source once/);
  bad({ post: 'https://scrumboard.local/card/x' }, /entity/);
  const open = { kind: 'recall.open', opId: 'urn:ex:op/o', actor: SEAT, offer: offerIri(post, source), opening: openingIri(offerIri(post, source), SEAT), via: 'seat', at: '2026-11-14T10:00:00.000Z' };
  assert.doesNotThrow(() => compile(open));
  assert.throws(() => compile({ ...open, opening: openingIri(offerIri(post, source), OTHER) }), /opened\/<sha256\(actor\)>/);
  assert.throws(() => compile({ ...open, via: 'tab' }), /seat or browser/);
  const read = { kind: 'recall.read', opId: 'urn:ex:op/r', actor: SEAT, post, read: readIri(post, SEAT), at: '2026-11-14T10:00:00.000Z' };
  assert.doesNotThrow(() => compile(read));
  assert.throws(() => compile({ ...read, read: readIri(post, OTHER) }), /recall\/read\/<sha256/);
});

test('G5 an opening: one per (offer, opener); a re-open refused; a browser\'s says so; an opening of no offer refused', { skip: SKIP }, async () => {
  const a = await world();
  await client.update(offerIntention({ post: a.post, offers: [item(a)], actor: BOARD, at: at() }));
  const offer = offerIri(a.post, a.src);
  assert.equal((await client.update(openIntention({ offer, actor: SEAT, via: 'seat', at: at() }))).outcome, 'APPLIED');
  assert.equal((await client.update(openIntention({ offer, actor: SEAT, via: 'seat', at: at() }))).outcome, 'PRECONDITION_FAILED', 'a re-open adds nothing');
  assert.equal((await client.update(openIntention({ offer, actor: BOARD, via: 'browser', at: at() }))).outcome, 'APPLIED');
  assert.equal(await count(`<${openingIri(offer, SEAT)}> <${RDF}type> <${RS}RecallOpening> ; <${RS}ofOffer> <${offer}> ; <${RS}openedBy> <${SEAT}> ; <${RS}openedVia> "seat"`), 1);
  assert.equal(await count(`<${openingIri(offer, BOARD)}> <${RS}openedBy> <${BOARD}> ; <${RS}openedVia> "browser"`), 1);
  assert.equal((await client.update(openIntention({ offer: offerIri(a.post, a.run), actor: SEAT, via: 'seat', at: at() }))).outcome, 'PRECONDITION_FAILED');
});

test('G6 a read: one per (post, seat); a re-read refused; a read of a post with no offer refused', { skip: SKIP }, async () => {
  const a = await world(); const none = await world();
  await client.update(offerIntention({ post: a.post, offers: [item(a)], actor: BOARD, at: at() }));
  assert.equal((await client.update(readIntention({ post: a.post, actor: SEAT, at: at() }))).outcome, 'APPLIED');
  assert.equal((await client.update(readIntention({ post: a.post, actor: SEAT, at: at() }))).outcome, 'PRECONDITION_FAILED');
  assert.equal((await client.update(readIntention({ post: a.post, actor: OTHER, at: at() }))).outcome, 'APPLIED');
  assert.equal((await client.update(readIntention({ post: none.post, actor: SEAT, at: at() }))).outcome, 'PRECONDITION_FAILED');
  assert.equal(await count(`?r <${RDF}type> <${RS}RecallRead> ; <${RS}readOf> <${a.post}> ; <${RS}readBy> ?s ; <${SC}dateCreated> ?t`), 2);
});

test('G7 existing kinds digest exactly as before the recall kinds were added (RECORD_V is not bumped)', () => {
  // HOW THE EXPECTED VALUES WERE OBTAINED (2026-11-14): compiled by the compiler at 80d68f6 (origin/main's, unchanged by
  // #1689 until this commit), before the three kinds were added. D14 in knowledge-linking-decide-1851 pins link.decide.
  assert.equal(RECORD_V, 2);
  const link = `https://scrumboard.local/link/${'ab'.repeat(32)}`;
  const show = compile({ kind: 'link.show', opId: 'urn:ex:op/pin-1689-show', actor: SEAT, card: 'https://scrumboard.local/entity/pin-card', how: 'get', at: '2026-11-14T16:00:00.000Z',
    showings: [{ iri: `${link}/shown/${crypto.createHash('sha256').update(SEAT).digest('hex')}`, link }] });
  assert.equal(show.digest, '526e2394acebd95240ae3eb16ae1fcf6de4ae601a37fa5cf3f709c2d39984c70');
  const prop = compile({ kind: 'link.propose', opId: 'urn:ex:op/pin-1689-propose', actor: SEAT, at: '2026-11-14T16:00:00.000Z',
    links: [{ iri: `https://scrumboard.local/link/${crypto.createHash('sha256').update('k').digest('hex')}`, assertion: 'https://scrumboard.local/assertion/pin', card: 'https://scrumboard.local/entity/pin-card', score: 0.7, minScore: 0.6, query: 'q', spanKey: 'k', model: 'm' }] });
  assert.equal(prop.digest, 'c8e2ec803eeffd774f374e94fff1627997e15d8042e8da665ecb8bf00b8fa5b7');
});

test('G8 offersQuery reads a post\'s offers back as the items it carries', { skip: SKIP }, async () => {
  const a = await world({ claims: 2, seq: 41 }); const b = await world();
  await client.update(offerIntention({ post: a.post, offers: [item(a, 1, 0.71), item(b, 0, 0.66)], actor: BOARD, at: at() }));
  const all = offersOfRows(await q(offersQuery()));
  const one = offersOfRows(await q(offersQuery([a.post])));
  assert.deepEqual(one.get(a.id), all.get(a.id));
  const got = one.get(a.id);
  assert.equal(got.seq, 41);
  assert.deepEqual(got.items.map((i) => [i.why.claim, i.score, i.source.title, i.why.gist, i.why.quote]), [[a.as[1], 0.71, 'The source', 'gist 1', 'quote 1'], [b.as[0], 0.66, 'The source', 'gist 0', 'quote 0']]);
  assert.equal(got.items[0].readingPage, `/reading.html?run=${a.run.split('/').pop()}`);
  assert.equal(got.items[0].readAt, '2026-11-14T10:00:00.000Z');
});
