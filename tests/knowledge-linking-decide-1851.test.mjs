/**
 * #1851 (#1848 slice 2) — A SEAT CONFIRMS OR DISMISSES A PROPOSED LINK. Kind `link.decide`, against a real scratch executor.
 *
 * Every decision is its OWN node, appended, never rewritten: that history is what #1850's "used" count reads, and a confirm
 * records the card the seat was working on, so a "used" is attributable to a moment of work and not to habit (steward,
 * 52709). The link's `scrum:status` is replaced by the latest verdict, so a reader of the link alone sees where it stands.
 *
 * INTERFACE PINNED HERE:
 *   decideIntention({ link, verdict: 'confirmed'|'dismissed', workingOn: <card uuid>|null, actor, at, opId? }) → `link.decide`
 *   On the graph: <link> scrum:status <verdict> (exactly one status) · a fresh <link>/decision/<uuid> node: rdf:type
 *     scrum:LinkDecision · scrum:ofLink <link> · scrum:linkVerdict · scrum:decidedBy <actor> · scrum:workingOn <card>? ·
 *     schema:dateCreated
 *
 *   D1   a confirm: the link reads "confirmed" (and no longer "proposed"); one LinkDecision with seat, card and time
 *   D1b  a later dismiss of the same link: status "dismissed", and BOTH decisions are on the graph (history appended)
 *   D2b  a confirm with no workingOn card is refused before anything is sent (52709)
 *   D3   a decision on something that is not a scrum:BearsOn is refused (PRECONDITION_FAILED), nothing written
 *   D4   a workingOn that is not a scrum:Card is refused, nothing written
 *   D5   a dismiss needs no workingOn
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { decideIntention, linkIri, spanKey } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const SEAT = 'https://scrumboard.local/person/ada';

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('kld-1851-');
  exec = await startExecutor({ store: storeDir, datasetId: 'kld-1851', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kld-1851', timeoutMs: 30000 });
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
/** A proposed link and the card a seat is working on, both fresh. */
async function seedLink() {
  const card = crypto.randomUUID(); const working = crypto.randomUUID();
  const link = linkIri(spanKey(`a claim ${card}`, card));
  await raw(`INSERT DATA { <${link}> <${RDF}type> <${RS}BearsOn> ; <${RS}status> "proposed" . <${cardIriOf(card)}> <${RDF}type> <${RS}Card> . <${cardIriOf(working)}> <${RDF}type> <${RS}Card> . }`);
  return { link, working };
}
const statuses = async (link) => (await q(`SELECT ?s WHERE { <${link}> <${RS}status> ?s }`)).map((r) => r.s.value).sort();

test('D1 a confirm: the link reads "confirmed", with one LinkDecision naming the seat, the card and the time', { skip: SKIP }, async () => {
  const s = await seedLink();
  const at = '2026-11-12T20:00:00.000Z';
  const w = await client.update(decideIntention({ link: s.link, verdict: 'confirmed', workingOn: s.working, actor: SEAT, at }));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['confirmed'], 'exactly one status, and "proposed" is gone');
  const rows = await q(`SELECT ?d ?v ?by ?wo ?at WHERE { ?d <${RDF}type> <${RS}LinkDecision> ; <${RS}ofLink> <${s.link}> ; <${RS}linkVerdict> ?v ;
    <${RS}decidedBy> ?by ; <${RS}workingOn> ?wo ; <${SC}dateCreated> ?at }`);
  assert.equal(rows.length, 1);
  assert.deepEqual({ v: rows[0].v.value, by: rows[0].by.value, wo: rows[0].wo.value, at: rows[0].at.value }, { v: 'confirmed', by: SEAT, wo: cardIriOf(s.working), at });
  assert.ok(rows[0].d.value.startsWith(`${s.link}/decision/`), 'the decision lives under its link');
});

test('D1b a later dismiss: status "dismissed", and both decisions stay on the graph', { skip: SKIP }, async () => {
  const s = await seedLink();
  assert.equal((await client.update(decideIntention({ link: s.link, verdict: 'confirmed', workingOn: s.working, actor: SEAT, at: '2026-11-12T20:00:00.000Z' }))).outcome, 'APPLIED');
  assert.equal((await client.update(decideIntention({ link: s.link, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:05:00.000Z' }))).outcome, 'APPLIED');
  assert.deepEqual(await statuses(s.link), ['dismissed']);
  const vs = (await q(`SELECT ?v WHERE { ?d <${RS}ofLink> <${s.link}> ; <${RS}linkVerdict> ?v }`)).map((r) => r.v.value).sort();
  assert.deepEqual(vs, ['confirmed', 'dismissed'], 'the history is appended, never rewritten');
});

test('D2b a confirm with no workingOn card is refused before anything is sent', () => {
  const link = linkIri('span:x|y');
  assert.throws(() => compile(decideIntention({ link, verdict: 'confirmed', workingOn: null, actor: SEAT, at: '2026-11-12T20:00:00.000Z' })), /workingOn/);
  assert.throws(() => compile(decideIntention({ link, verdict: 'kept', workingOn: null, actor: SEAT, at: '2026-11-12T20:00:00.000Z' })), /verdict/);
  assert.doesNotThrow(() => compile(decideIntention({ link, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:00:00.000Z' })), 'CONTROL: a dismiss compiles without one');
});

test('D3 a decision on something that is not a scrum:BearsOn is refused, nothing written', { skip: SKIP }, async () => {
  const s = await seedLink();
  const ghost = linkIri(`span:ghost-${crypto.randomUUID()}|nothing`);
  const w = await client.update(decideIntention({ link: ghost, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:00:00.000Z' }));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`?d <${RS}ofLink> <${ghost}>`), 0);
  void s;
});

test('D4 a workingOn that is not a scrum:Card is refused, nothing written', { skip: SKIP }, async () => {
  const s = await seedLink();
  const w = await client.update(decideIntention({ link: s.link, verdict: 'confirmed', workingOn: crypto.randomUUID(), actor: SEAT, at: '2026-11-12T20:00:00.000Z' }));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['proposed'], 'the status did not move');
  assert.equal(await count(`?d <${RS}ofLink> <${s.link}>`), 0);
});

test('D5 a dismiss needs no workingOn', { skip: SKIP }, async () => {
  const s = await seedLink();
  const w = await client.update(decideIntention({ link: s.link, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:00:00.000Z' }));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['dismissed']);
  assert.equal(await count(`?d <${RS}ofLink> <${s.link}> FILTER NOT EXISTS { ?d <${RS}workingOn> ?w }`), 1);
});
