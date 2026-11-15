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
 *   G9  an offer whose claim did not come from the source it names (a real claim, a real source, not each other's) is refused
 *   G10 post.redact takes the post's recall records with it in the SAME update: its offers, their openings and its reads, in the
 *       default graph and their recordedBy in the bookkeeping graph; another post's records are untouched
 *   G11 a node that names the post's recall but is not provably one never refuses the redaction and is never deleted whole:
 *       only its naming edge goes (offerOn the post, readOf the post, ofOffer one of the post's offers), so nothing left names
 *       the post or one of its offer IRIs; a typed opening outside <offer>/opened/ is such a node
 *       ... unless its IRI is the post's own derivation: a node at offerIri(P, its offeredSource), at readIri(P, its readBy), or under
 *       such an offer's /opened/ carries a hash of the post in its IRI, so it is the post's, typed or not, and goes WHOLE (G13);
 *       a typed node at an IRI that is NOT the derivation carries no hash of the post and keeps everything but its edge (G11 iv)
 *   G12 an offer whose claim's run used the named source, but whose passage is under ANOTHER source's blocks, is refused
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
    ${as.map((a, i) => `<${a}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; <${RS}expressedIn> <${src}/block/${i}> ; <${RS}gist> "gist ${i}" ; <${RS}anchorText> "quote ${i}" .`).join('\n')} }`);
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

test('G9 an offer naming a real claim and a real source the claim did not come from is refused, nothing written', { skip: SKIP }, async () => {
  const a = await world(); const b = await world();
  const crossed = await client.update(offerIntention({ post: a.post, offers: [{ source: b.src, assertion: a.as[0], score: 0.7, bar: 0.62 }], actor: BOARD, at: at() }));
  assert.equal(crossed.outcome, 'PRECONDITION_FAILED', `a's claim offered as b's source: ${JSON.stringify(crossed)}`);
  assert.equal(await count(`?o <${RS}offerOn> <${a.post}>`), 0, 'nothing written');
  // CONTROL: the same claim under its own source is accepted
  assert.equal((await client.update(offerIntention({ post: a.post, offers: [{ source: a.src, assertion: a.as[0], score: 0.7, bar: 0.62 }], actor: BOARD, at: at() }))).outcome, 'APPLIED');
});

const redact = (w) => client.update({ kind: 'post.redact', opId: `urn:ex:op/redact-${crypto.randomUUID()}`, actor: BOARD, post: { id: w.id }, authorityRef: 'test:1689', occurredAt: at() });
const BK_REC = (iri) => `SELECT ?r WHERE { GRAPH ?g { <${iri}> <urn:ex:recordedBy> ?r } }`;

test('G10 post.redact takes the post\'s offers, their openings and its reads with it, bookkeeping included; others untouched', { skip: SKIP }, async () => {
  const a = await world(); const b = await world();
  for (const w of [a, b]) {
    assert.equal((await client.update(offerIntention({ post: w.post, offers: [item(w)], actor: BOARD, at: at() }))).outcome, 'APPLIED');
    const offer = offerIri(w.post, w.src);
    assert.equal((await client.update(openIntention({ offer, actor: SEAT, via: 'seat', at: at() }))).outcome, 'APPLIED');
    assert.equal((await client.update(openIntention({ offer, actor: BOARD, via: 'browser', at: at() }))).outcome, 'APPLIED');
    assert.equal((await client.update(readIntention({ post: w.post, actor: SEAT, at: at() }))).outcome, 'APPLIED');
  }
  const nodes = (w) => { const o = offerIri(w.post, w.src); return [o, openingIri(o, SEAT), openingIri(o, BOARD), readIri(w.post, SEAT)]; };
  for (const n of nodes(a)) assert.equal((await q(BK_REC(n))).length, 1, `PRECONDITION: ${n} has its recordedBy`);
  const r = await redact(a);
  assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
  for (const n of nodes(a)) {
    assert.equal(await count(`<${n}> ?p ?o`), 0, `${n}: no default-graph triple left`);
    assert.equal((await q(BK_REC(n))).length, 0, `${n}: no bookkeeping triple left`);
  }
  assert.equal(await count(`?x ?p <${a.post}>`), 0, 'nothing in the store points at the redacted post any more');
  assert.equal(await count(`{ ?x <${RS}offeredSource> <${a.src}> } UNION { ?x <${RS}ofOffer> <${offerIri(a.post, a.src)}> }`), 0);
  for (const n of nodes(b)) assert.equal(await count(`<${n}> ?p ?o`) > 0, true, `${n}: the other post's record is untouched`);
  assert.equal(await count(`<${a.post}> <${RDF}type> <${RS}RedactedPost>`), 1, 'and the post is a tombstone as before');
});

const NAME = `<${SC}name> "kept"`;
const G11_CASES = [
    // (i) not typed an offer, under recall/ — and a typed opening hanging off it, under ITS /opened/ (proven or not, the offer is the post's)
    { what: 'an untyped node with offerOn the post', node: () => `https://scrumboard.local/recall/${crypto.randomBytes(32).toString('hex')}`,
      stray: (w, n) => `<${n}> <${RS}offerOn> <${w.post}> ; ${NAME} . <${n}/opened/${'ef'.repeat(32)}> <${RDF}type> <${RS}RecallOpening> ; <${RS}ofOffer> <${n}> ; ${NAME} .`,
      edge: (w, n) => `<${n}> <${RS}offerOn> <${w.post}>`, also: (w, n) => [[`${n}/opened/${'ef'.repeat(32)}`, `<${n}/opened/${'ef'.repeat(32)}> <${RS}ofOffer> <${n}>`]] },
    // (ii) a read outside recall/read/
    { what: 'a typed read with the wrong IRI shape', node: () => `https://scrumboard.local/elsewhere/${crypto.randomUUID()}`,
      stray: (w, n) => `<${n}> <${RDF}type> <${RS}RecallRead> ; <${RS}readOf> <${w.post}> ; ${NAME} .`, edge: (w, n) => `<${n}> <${RS}readOf> <${w.post}>`, also: () => [] },
    // (iii) a typed opening of the post's PROVEN offer, outside <offer>/opened/ (mutant M3's case)
    { what: 'a typed opening of the post\'s offer outside <offer>/opened/', node: (w) => `${offerIri(w.post, w.src)}/elsewhere/${'ab'.repeat(32)}`,
      stray: (w, n) => `<${n}> <${RDF}type> <${RS}RecallOpening> ; <${RS}ofOffer> <${offerIri(w.post, w.src)}> ; <${RS}openedVia> "seat" ; ${NAME} .`,
      edge: (w, n) => `<${n}> <${RS}ofOffer> <${offerIri(w.post, w.src)}>`, also: () => [] },
    // (iv) typed a RecallOffer, offerOn the post, under recall/ — but NOT at offerIri(post, its source): no hash of the post in it
    { what: 'a typed offer at an IRI that is not the derivation', node: () => `https://scrumboard.local/recall/${crypto.randomBytes(32).toString('hex')}`,
      stray: (w, n) => `<${n}> <${RDF}type> <${RS}RecallOffer> ; <${RS}offerOn> <${w.post}> ; <${RS}offeredSource> <${w.src}x> ; ${NAME} .`,
      edge: (w, n) => `<${n}> <${RS}offerOn> <${w.post}>`, also: () => [] },
];
for (const [c, tag] of G11_CASES.map((c, k) => [c, ['i', 'ii', 'iii', 'iv'][k]])) test(`G11(${tag}) ${c.what}: cut loose (only its naming edge goes), never deleted whole, never a refusal`, { skip: SKIP }, async () => {
  {
    const w = await world();
    assert.equal((await client.update(offerIntention({ post: w.post, offers: [item(w)], actor: BOARD, at: at() }))).outcome, 'APPLIED');
    const n = c.node(w);
    await raw(`INSERT DATA { ${c.stray(w, n)} }`);
    const offer = offerIri(w.post, w.src);
    const nodes = [[n, c.edge(w, n)], ...c.also(w, n)];
    const before = []; for (const [x] of nodes) before.push(await count(`<${x}> ?p ?o`));
    const r = await redact(w);
    assert.equal(r.outcome, 'APPLIED', `${c.what}: recall data never refuses a redaction: ${JSON.stringify(r)}`);
    assert.equal(await count(`<${w.post}> <${RDF}type> <${RS}RedactedPost>`), 1, `${c.what}: the post is a tombstone`);
    for (const [[x, edge], k] of nodes.map((e, k) => [e, k])) {
      assert.equal(await count(edge), 0, `${c.what}: its naming edge is gone (${edge})`);
      assert.equal(await count(`<${x}> ?p ?o`), before[k] - 1, `${c.what}: ${x} survives minus that one edge (never deleted whole)`);
      assert.equal(await count(`<${x}> <${SC}name> "kept"`), 1, `${c.what}: nothing else of it is touched`);
    }
    assert.equal(await count(`?x ?p <${w.post}>`), 0, `${c.what}: nothing names the redacted post`);
    assert.equal(await count(`<${offer}> ?p ?o`), 0, `${c.what}: the proven offer is gone`);
    assert.equal(await count(`?x ?p <${offer}>`), 0, `${c.what}: nothing refers to the deleted offer IRI`);
  }
});

const anyTriple = async (iri) => count(`{ GRAPH ?g { <${iri}> ?p ?o } } UNION { GRAPH ?g { ?s ?p <${iri}> } } UNION { <${iri}> ?p ?o } UNION { ?s ?p <${iri}> }`);
test('G13(a) a node at the post\'s DERIVED offer or read IRI, typed or not, goes whole (subject and object, both graphs)', { skip: SKIP }, async () => {
  const w = await world();
  assert.equal((await client.update(offerIntention({ post: w.post, offers: [item(w)], actor: BOARD, at: at() }))).outcome, 'APPLIED');
  const s2 = `https://scrumboard.local/source/${crypto.randomBytes(32).toString('hex')}`;
  const off = offerIri(w.post, s2), rd = readIri(w.post, OTHER);
  await raw(`INSERT DATA { <${off}> <${RS}offerOn> <${w.post}> ; <${RS}offeredSource> <${s2}> ; ${NAME} .
    <${rd}> <${RS}readOf> <${w.post}> ; <${RS}readBy> <${OTHER}> ; ${NAME} . }`);   // untyped, at the derived IRIs
  assert.equal((await redact(w)).outcome, 'APPLIED');
  for (const n of [off, rd, offerIri(w.post, w.src)]) assert.equal(await anyTriple(n), 0, `${n}: no triple with it as subject or object, in either graph`);
});

test('G13(c) a node under a derived offer\'s /opened/, typed or not, goes whole; one elsewhere pointing at the offer loses only its edge', { skip: SKIP }, async () => {
  const w = await world();
  assert.equal((await client.update(offerIntention({ post: w.post, offers: [item(w)], actor: BOARD, at: at() }))).outcome, 'APPLIED');
  const offer = offerIri(w.post, w.src);
  const under = `${offer}/opened/${'12'.repeat(32)}`, elsewhere = `https://scrumboard.local/elsewhere/${crypto.randomUUID()}`;
  await raw(`INSERT DATA { <${under}> <${RS}ofOffer> <${offer}> ; ${NAME} . <${elsewhere}> <${RDF}type> <${RS}RecallOpening> ; <${RS}ofOffer> <${offer}> ; ${NAME} . }`);
  assert.equal((await redact(w)).outcome, 'APPLIED');
  assert.equal(await anyTriple(under), 0, 'the untyped node under /opened/ carries the offer\'s hash: gone');
  assert.equal(await count(`<${elsewhere}> ?p ?o`), 2, 'the one elsewhere keeps its type and name');
  assert.equal(await anyTriple(offer), 0, 'and nothing names the offer');
});

test('G13(d) the IRI SPARQL derives in the redaction is byte-identical to offerIri() and readIri() for real records', { skip: SKIP }, async () => {
  const w = await world();
  assert.equal((await client.update(offerIntention({ post: w.post, offers: [item(w)], actor: BOARD, at: at() }))).outcome, 'APPLIED');
  assert.equal((await client.update(readIntention({ post: w.post, actor: SEAT, at: at() }))).outcome, 'APPLIED');
  const rows = await q(`SELECT ?o ?d ?r ?dr WHERE { ?o <${RS}offerOn> <${w.post}> ; <${RS}offeredSource> ?src . ?r <${RS}readOf> <${w.post}> ; <${RS}readBy> ?a .
    BIND(CONCAT("https://scrumboard.local/recall/", SHA256(CONCAT(STR(<${w.post}>), "\\n", STR(?src)))) AS ?d)
    BIND(CONCAT("https://scrumboard.local/recall/read/", SHA256(CONCAT(STR(<${w.post}>), "\\n", STR(?a)))) AS ?dr) }`);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].d.value, rows[0].o.value], [offerIri(w.post, w.src), offerIri(w.post, w.src)]);
  assert.deepEqual([rows[0].dr.value, rows[0].r.value], [readIri(w.post, SEAT), readIri(w.post, SEAT)]);
});

test('G12 a claim whose run used the named source but whose passage is under another source\'s blocks is refused, nothing written', { skip: SKIP }, async () => {
  const w = await world();
  const s2 = `https://scrumboard.local/source/${crypto.randomBytes(32).toString('hex')}`;
  const claim = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  // ONE run that used BOTH sources; the claim is of that run, its passage under S2's blocks
  await raw(`INSERT DATA { <${s2}> <${RDF}type> <${RS}SourceVersion> ; <${SC}name> "The second source" ; <${SC}url> "https://example.com/s2" .
    <${w.run}> <${PROV}used> <${s2}> .
    <${claim}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${w.run}> ; <${RS}expressedIn> <${s2}/block/0> ; <${RS}gist> "g" ; <${RS}anchorText> "q" . }`);
  const wrong = await client.update(offerIntention({ post: w.post, offers: [{ source: w.src, assertion: claim, score: 0.7, bar: 0.62 }], actor: BOARD, at: at() }));
  assert.equal(wrong.outcome, 'PRECONDITION_FAILED', `the run used S, the passage is S2's: ${JSON.stringify(wrong)}`);
  assert.equal(await count(`?o <${RS}offerOn> <${w.post}>`), 0, 'nothing written');
  // CONTROL: the same claim offered with S2 is accepted
  assert.equal((await client.update(offerIntention({ post: w.post, offers: [{ source: s2, assertion: claim, score: 0.7, bar: 0.62 }], actor: BOARD, at: at() }))).outcome, 'APPLIED');
});
