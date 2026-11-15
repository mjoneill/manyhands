/**
 * #1905 — a claim attached to a card BY HAND. A machine link (#1851, kind `link.propose`) carries how it was found: score,
 * minScore, query, model. A hand attach has none of those, and inventing them to pass the validator would be fabricating a
 * measurement. So it is its own kind, `link.attach`, writing the SAME scrum:BearsOn node at the SAME derived IRI, plus who
 * attached it and why. This file pins the WRITE and the COUNTS against a real scratch executor.
 *
 * INTERFACE PINNED HERE:
 *   attachIntention({ assertion, card, span, reason, actor, at, opId? }) → a `link.attach` intention. `card` is the card's
 *     id (not its IRI), as linkIntention's proposals carry it; the link IRI is linkIri(spanKey(span, card)).
 *   On the graph: rdf:type scrum:BearsOn · scrum:fromAssertion · scrum:bearsOnCard · scrum:spanKey · scrum:status "proposed"
 *     · schema:dateCreated · scrum:attachedBy <actor> · scrum:attachReason "<reason>". NO score, minScore, searchQuery, model.
 *   linkCountsQuery(since) counts decisions and showings of MACHINE links only: a link with scrum:attachedBy is excluded.
 *
 *   A1  an attach writes the BearsOn node with who and why, status "proposed", and none of a machine link's search fields
 *   A2  attaching a pair the machine already linked is refused (same IRI, not fresh), and the machine link is untouched
 *   A3  the machine proposing a pair someone already attached is refused: no second node (DONE WHEN 4)
 *   A4  an attach to a non-Card, or from a non-Assertion, is refused, and nothing is written
 *   A5  the compiler refuses a malformed attach before anything is sent: no reason, a blank or over-long reason, an IRI that
 *       is not derived from the span key, a span key for a different card
 *   A6  link.decide answers an attached link exactly as it answers a machine one: a confirm moves its status
 *   A7  (DONE WHEN 3) link_counts excludes hand-attached links: a confirm of one is not "used", a showing of one is not "shown"
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { spanKey, linkIri, linkIntention, attachIntention, decideIntention, linkCountsQuery, countLinkUse, ATTACH_REASON_MAX } from '../core/knowledge-linking.mjs';
import { showIntention } from '../core/knowledge-delivery.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const AT = '2026-11-15T03:00:00.000Z';
const LINKER = 'https://scrumboard.local/person/linker';
const ATTACHER = 'urn:ex:seat/attacher';
const READER = 'urn:ex:seat/reader';
const REASON = 'One inbox per participant is the shape the card is missing: a missed delivery would be a row still waiting.';

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('kl-1905-');
  exec = await startExecutor({ store: storeDir, datasetId: 'kl-1905', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kl-1905', timeoutMs: 30000 });
});
after(async () => {
  await killExecutor(exec);
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
});

const q = async (sparql) => { const r = await client.query(sparql); assert.ok(r.ok, `query failed: ${r.reason}`); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);

/** Fixture nodes the write's preconditions read, written raw (they are not under test). */
async function seed({ assertion, span, card }) {
  const body = `INSERT DATA { ${assertion ? `<${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} .` : ''} ${card ? `<${card}> <${RDF}type> <${RS}Card> .` : ''} }`;
  const res = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture seed applied (${res.status} ${await res.text()})`);
}
const fresh = () => {
  const id = crypto.randomUUID();
  return { assertion: `https://scrumboard.local/assertion/${id}`, cardId: crypto.randomUUID(), span: `the inbox should be the source of truth ${id}` };
};
const attach = (f, extra = {}) => attachIntention({ assertion: f.assertion, card: f.cardId, span: f.span, reason: REASON, actor: ATTACHER, at: AT, ...extra });
const propose = (f) => linkIntention({ proposals: [{ assertion: f.assertion, card: f.cardId, score: 0.7, query: 'q', spanKey: spanKey(f.span, f.cardId) }], minScore: 0.6, model: 'm', at: AT, actor: LINKER });
const iriOf = (f) => linkIri(spanKey(f.span, f.cardId));
const seeded = async () => { const f = fresh(); await seed({ assertion: f.assertion, span: f.span, card: cardIriOf(f.cardId) }); return f; };

test('A1 an attach writes the BearsOn node with who and why, status "proposed", and none of the search fields', { skip: SKIP }, async () => {
  const f = await seeded();
  const w = await client.update(attach(f));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  const L = iriOf(f);
  const rows = await q(`SELECT ?a ?c ?k ?st ?d ?by ?why WHERE { <${L}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> ?a ; <${RS}bearsOnCard> ?c ;
    <${RS}spanKey> ?k ; <${RS}status> ?st ; <${SC}dateCreated> ?d ; <${RS}attachedBy> ?by ; <${RS}attachReason> ?why }`);
  assert.equal(rows.length, 1, 'exactly one link node with every field');
  const r = rows[0];
  assert.equal(r.a.value, f.assertion);
  assert.equal(r.c.value, cardIriOf(f.cardId));
  assert.equal(r.k.value, spanKey(f.span, f.cardId));
  assert.equal(r.st.value, 'proposed');
  assert.equal(r.d.value, AT);
  assert.equal(r.by.value, ATTACHER);
  assert.equal(r.why.value, REASON);
  for (const p of ['score', 'minScore', 'searchQuery', 'model']) {
    assert.equal(await count(`<${L}> <${RS}${p}> ?x`), 0, `a hand attach carries no ${p}: it was not found by a search`);
  }
});

test('A2 attaching a pair the machine already linked is refused, and the machine link is untouched', { skip: SKIP }, async () => {
  const f = await seeded();
  assert.equal((await client.update(propose(f))).outcome, 'APPLIED', 'the machine linked it first');
  const w = await client.update(attach(f));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`<${iriOf(f)}> <${RS}attachedBy> ?x`), 0, 'the machine link gained no attacher');
  assert.equal(await count(`<${iriOf(f)}> <${RS}score> ?x`), 1, 'and kept its score');
});

test('A3 the machine proposing a pair someone already attached is refused: no second node', { skip: SKIP }, async () => {
  const f = await seeded();
  assert.equal((await client.update(attach(f))).outcome, 'APPLIED');
  const w = await client.update(propose(f));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`?l <${RS}fromAssertion> <${f.assertion}>`), 1, 'one link for the pair');
  assert.equal(await count(`<${iriOf(f)}> <${RS}score> ?x`), 0, 'and it is still the hand one');
});

test('A4 an attach to a non-Card, or from a non-Assertion, is refused and nothing is written', { skip: SKIP }, async () => {
  const noCard = fresh();
  await seed({ assertion: noCard.assertion, span: noCard.span, card: null });
  assert.equal((await client.update(attach(noCard))).outcome, 'PRECONDITION_FAILED');
  const noClaim = fresh();
  await seed({ assertion: null, span: noClaim.span, card: cardIriOf(noClaim.cardId) });
  assert.equal((await client.update(attach(noClaim))).outcome, 'PRECONDITION_FAILED');
  assert.equal(await count(`{ <${iriOf(noCard)}> ?p ?o } UNION { <${iriOf(noClaim)}> ?p ?o }`), 0, 'neither link exists');
});

test('A5 the compiler refuses a malformed attach before anything is sent', () => {
  const f = fresh();
  assert.doesNotThrow(() => compile(attach(f)), 'CONTROL: a well-formed attach compiles');
  assert.throws(() => compile(attach(f, { reason: undefined })), /reason/);
  assert.throws(() => compile(attach(f, { reason: '   ' })), /reason/);
  assert.throws(() => compile(attach(f, { reason: 'first line\nsecond line' })), /one line/);
  assert.throws(() => compile(attach(f, { reason: 'x'.repeat(ATTACH_REASON_MAX + 1) })), /reason/);
  assert.doesNotThrow(() => compile(attach(f, { reason: 'x'.repeat(ATTACH_REASON_MAX) })), 'CONTROL: a reason at the cap compiles');
  const good = attach(f);
  assert.throws(() => compile({ ...good, link: { ...good.link, iri: `https://scrumboard.local/link/${'a'.repeat(64)}` } }), /link\/<sha256\(spanKey\)>/);
  const other = crypto.randomUUID();
  const elsewhere = spanKey(f.span, other);
  assert.throws(() => compile({ ...good, link: { ...good.link, spanKey: elsewhere, iri: linkIri(elsewhere) } }), /spanKey.*card/);
});

test('A6 link.decide answers an attached link as it answers a machine one: a confirm moves its status', { skip: SKIP }, async () => {
  const f = await seeded();
  assert.equal((await client.update(attach(f))).outcome, 'APPLIED');
  const w = await client.update(decideIntention({ link: iriOf(f), verdict: 'confirmed', workingOn: f.cardId, actor: READER }));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  const st = await q(`SELECT ?st WHERE { <${iriOf(f)}> <${RS}status> ?st }`);
  assert.deepEqual(st.map((r) => r.st.value), ['confirmed']);
});

test('A7 link_counts excludes hand-attached links: a confirm of one is not used, a showing of one is not shown', { skip: SKIP }, async () => {
  // one card, two claims on it: a showing is made on the card its links bear on (link.show's precondition)
  const hand = await seeded();
  const machine = { ...fresh(), cardId: hand.cardId };
  await seed({ assertion: machine.assertion, span: machine.span, card: null });
  assert.equal((await client.update(attach(hand))).outcome, 'APPLIED');
  assert.equal((await client.update(propose(machine))).outcome, 'APPLIED');
  const COUNTER = `urn:ex:seat/counter-${crypto.randomUUID().slice(0, 8)}`;
  for (const f of [hand, machine]) {
    assert.equal((await client.update(decideIntention({ link: iriOf(f), verdict: 'confirmed', workingOn: f.cardId, actor: COUNTER }))).outcome, 'APPLIED');
  }
  const SHOWN = `urn:ex:seat/shown-${crypto.randomUUID().slice(0, 8)}`;
  assert.equal((await client.update(showIntention({ links: [iriOf(hand), iriOf(machine)], card: cardIriOf(machine.cardId), how: 'get', actor: SHOWN, at: AT }))).outcome, 'APPLIED');
  const rows = await q(linkCountsQuery('1970-01-01T00:00:00.000Z'));
  const c = countLinkUse(rows.map((r) => (r.v ? { by: r.by.value, link: r.l.value, verdict: r.v.value } : { by: r.by.value, link: r.l.value, delivered: true })));
  const seat = (s) => c.seats.find((x) => x.seat === s.replace('urn:ex:seat/', ''));
  assert.deepEqual([seat(COUNTER).used, seat(COUNTER).shown], [1, 1], `only the machine link's confirm counts: ${JSON.stringify(seat(COUNTER))}`);
  assert.deepEqual([seat(SHOWN).shown, seat(SHOWN).delivered], [1, 1], `only the machine link's showing counts: ${JSON.stringify(seat(SHOWN))}`);
  // CONTROL: the excluded link really was decided and shown, so the zero above is the exclusion and not a write that never landed
  assert.equal(await count(`?d <${RS}ofLink> <${iriOf(hand)}> ; <${RS}linkVerdict> "confirmed"`), 1);
  assert.equal(await count(`?d <${RS}ofLink> <${iriOf(hand)}> ; <${RS}shownTo> ?x`), 1);
});
