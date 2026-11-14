/**
 * #1852 (#1848 slice 3) — THE FIRST TIME A SEAT IS SHOWN A LINK IS RECORDED. Kind `link.show`, against a real scratch executor.
 *
 * #1850 counts what a seat was SHOWN beside what she USED; before this a seat was "shown" only the links she decided. A
 * delivery (core/knowledge-delivery.mjs) puts a link in front of a seat without her asking, so each first showing is its
 * own node, ONE per seat and link at an IRI derived from both: a second showing names the same node and is refused, so a
 * re-read can never count twice.
 *
 * INTERFACE PINNED HERE:
 *   showIntention({ links: [<link IRI>…], card: <card IRI>, how: 'claim'|'get', actor, at, opId? }) → `link.show`
 *   On the graph, per showing, at <link>/shown/<sha256(actor)>: rdf:type scrum:LinkShowing · scrum:ofLink <link> ·
 *     scrum:shownTo <actor> · scrum:shownOn <card> · scrum:shownVia "claim"|"get" · schema:dateCreated
 *
 *   W1  two first showings in ONE update: both nodes, each with its link, seat, card, way and time
 *   W2  a second showing of the same link to the same seat is refused, and takes its whole update with it
 *   W3  another seat shown the same link gets its own node
 *   W4  a showing whose IRI is not derived from its link and the actor is refused before anything is sent
 *   W5  the shape: `how` is claim or get, at least one showing, each link once, each link a link/<sha256> IRI
 *   W6  a showing of something that is not a scrum:BearsOn is refused, nothing written
 *   W7  a showing on a card the link does not bear on is refused, nothing written
 *   W8  a showing leaves the link's status alone
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { linkIri, spanKey } from '../core/knowledge-linking.mjs';
import { showIntention, showIri } from '../core/knowledge-delivery.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const SEAT = 'urn:ex:seat/seat-a';
const OTHER = 'urn:ex:seat/seat-b';
const AT = '2026-11-14T16:00:00.000Z';

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('kls-1852-');
  exec = await startExecutor({ store: storeDir, datasetId: 'kls-1852', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kls-1852', timeoutMs: 30000 });
});
after(async () => {
  await killExecutor(exec);
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
});

const q = async (sparql) => { const r = await client.query(sparql); assert.ok(r.ok, `query failed: ${r.reason}`); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);
async function raw(body) {
  const res = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture applied (${res.status} ${await res.text()})`);
}
/** A card and `n` proposed links that bear on it, all fresh. */
async function seed(n = 1) {
  const cardId = crypto.randomUUID(); const card = cardIriOf(cardId);
  const links = Array.from({ length: n }, (_, k) => linkIri(spanKey(`claim ${k} ${cardId}`, cardId)));
  await raw(`INSERT DATA { <${card}> <${RDF}type> <${RS}Card> . ${links.map((l) => `<${l}> <${RDF}type> <${RS}BearsOn> ; <${RS}bearsOnCard> <${card}> ; <${RS}status> "proposed" .`).join(' ')} }`);
  return { card, links };
}
const showings = (link) => q(`SELECT ?n ?to ?on ?via ?at WHERE { ?n <${RDF}type> <${RS}LinkShowing> ; <${RS}ofLink> <${link}> ; <${RS}shownTo> ?to ;
  <${RS}shownOn> ?on ; <${RS}shownVia> ?via ; <${SC}dateCreated> ?at }`);

test('W1 two first showings in ONE update: both nodes, each with its link, seat, card, way and time', { skip: SKIP }, async () => {
  const s = await seed(2);
  const w = await client.update(showIntention({ links: s.links, card: s.card, how: 'claim', actor: SEAT, at: AT }));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  for (const link of s.links) {
    const rows = await showings(link);
    assert.equal(rows.length, 1);
    assert.deepEqual({ n: rows[0].n.value, to: rows[0].to.value, on: rows[0].on.value, via: rows[0].via.value, at: rows[0].at.value },
      { n: showIri(link, SEAT), to: SEAT, on: s.card, via: 'claim', at: AT });
  }
});

test('W2 a second showing of the same link to the same seat is refused, and takes its whole update with it', { skip: SKIP }, async () => {
  const s = await seed(2);
  assert.equal((await client.update(showIntention({ links: [s.links[0]], card: s.card, how: 'get', actor: SEAT, at: AT }))).outcome, 'APPLIED');
  const again = await client.update(showIntention({ links: s.links, card: s.card, how: 'claim', actor: SEAT, at: '2026-11-14T17:00:00.000Z' }));
  assert.equal(again.outcome, 'PRECONDITION_FAILED', JSON.stringify(again));
  const first = await showings(s.links[0]);
  assert.equal(first.length, 1, 'still one node for the pair');
  assert.deepEqual({ via: first[0].via.value, at: first[0].at.value }, { via: 'get', at: AT }, 'and it is the FIRST showing, untouched');
  assert.equal((await showings(s.links[1])).length, 0, 'the new showing in the refused update was not written either');
});

test('W3 another seat shown the same link gets its own node', { skip: SKIP }, async () => {
  const s = await seed(1);
  assert.equal((await client.update(showIntention({ links: s.links, card: s.card, how: 'get', actor: SEAT, at: AT }))).outcome, 'APPLIED');
  assert.equal((await client.update(showIntention({ links: s.links, card: s.card, how: 'get', actor: OTHER, at: AT }))).outcome, 'APPLIED');
  assert.deepEqual((await showings(s.links[0])).map((r) => r.to.value).sort(), [SEAT, OTHER]);
});

test('W4 a showing whose IRI is not derived from its link and the actor is refused before anything is sent', () => {
  const link = linkIri('span:x|y');
  const card = cardIriOf('c');
  const i = showIntention({ links: [link], card, how: 'get', actor: SEAT, at: AT });
  assert.doesNotThrow(() => compile(i), 'CONTROL: the derived IRI compiles');
  assert.throws(() => compile({ ...i, showings: [{ iri: showIri(link, OTHER), link }] }), /shown\/<sha256\(actor\)>/);
  assert.throws(() => compile({ ...i, showings: [{ iri: `${link}/shown/${crypto.randomUUID()}`, link }] }), /shown\/<sha256\(actor\)>/);
});

test('W5 the shape: how is claim or get, at least one showing, each link once, each link a link/<sha256> IRI', () => {
  const link = linkIri('span:x|y');
  const card = cardIriOf('c');
  const ok = showIntention({ links: [link], card, how: 'get', actor: SEAT, at: AT });
  assert.throws(() => compile({ ...ok, how: 'list' }), /how must be claim or get/);
  assert.throws(() => compile({ ...ok, showings: [] }), /at least one showing/);
  assert.throws(() => compile(showIntention({ links: [link, link], card, how: 'get', actor: SEAT, at: AT })), /each link once/);
  assert.throws(() => compile(showIntention({ links: ['https://scrumboard.local/link/short'], card, how: 'get', actor: SEAT, at: AT })), /link\/<sha256>/);
  assert.throws(() => compile({ ...ok, verdict: 'confirmed' }), /unknown field verdict/);
});

test('W6 a showing of something that is not a scrum:BearsOn is refused, nothing written', { skip: SKIP }, async () => {
  const s = await seed(1);
  const ghost = linkIri(`span:ghost-${crypto.randomUUID()}|nothing`);
  const w = await client.update(showIntention({ links: [ghost], card: s.card, how: 'get', actor: SEAT, at: AT }));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`?n <${RS}ofLink> <${ghost}>`), 0);
});

test('W7 a showing on a card the link does not bear on is refused, nothing written', { skip: SKIP }, async () => {
  const s = await seed(1);
  const elsewhere = await seed(1);
  const w = await client.update(showIntention({ links: s.links, card: elsewhere.card, how: 'get', actor: SEAT, at: AT }));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal((await showings(s.links[0])).length, 0);
});

test('W8 a showing leaves the link\'s status alone', { skip: SKIP }, async () => {
  const s = await seed(1);
  assert.equal((await client.update(showIntention({ links: s.links, card: s.card, how: 'claim', actor: SEAT, at: AT }))).outcome, 'APPLIED');
  assert.deepEqual((await q(`SELECT ?st WHERE { <${s.links[0]}> <${RS}status> ?st }`)).map((r) => r.st.value), ['proposed']);
});
