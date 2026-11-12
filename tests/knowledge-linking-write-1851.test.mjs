/**
 * #1851 (#1848 slice 2) — WRITING the proposed "bears on" links. core/knowledge-linking.mjs decides WHICH links (its own rows,
 * knowledge-linking-1851.test.mjs); this file pins the WRITE: one compiled, guarded update per linking run (kind `link.propose`),
 * against a real scratch executor.
 *
 * INTERFACE PINNED HERE:
 *   linkIri(spanKey) → `https://scrumboard.local/link/<sha256(spanKey)>`. The IRI is DERIVED from (normalised span, card), so
 *     the same claim re-extracted under a new assertion IRI names the SAME link node, and the write's freshness guard refuses
 *     a second one: a dismissal sticks structurally, not by a check a caller must remember (review 52706 point 3).
 *   linkIntention({ proposals, minScore, model, at, actor, opId? }) → a `link.propose` intention
 *   On the graph, per link: rdf:type scrum:BearsOn · scrum:fromAssertion <assertion> · scrum:bearsOnCard <card> · scrum:score
 *     · scrum:minScore · scrum:searchQuery · scrum:spanKey · scrum:model · scrum:status "proposed" · schema:dateCreated.
 *
 *   W1  a link.propose writes one BearsOn node per proposal with every field, status "proposed"
 *   W2  (L6)  a link whose card is not a scrum:Card is refused, and NOTHING of that run is written
 *   W3  (L6b) a link whose assertion is not a scrum:Assertion is refused, and nothing is written
 *   W4  (L3c, structural) the same span + card proposed again under a NEW assertion IRI is refused: same link IRI, not fresh
 *   W5  the compiler refuses a malformed link (a score that is not a number in [0,1], an empty query) before anything is sent
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { spanKey, linkIri, linkIntention } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SC = 'https://schema.org/';
const AT = '2026-11-12T19:30:00.000Z';
const ACTOR = 'https://scrumboard.local/person/linker';

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('kl-1851-');
  exec = await startExecutor({ store: storeDir, datasetId: 'kl-1851', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'kl-1851', timeoutMs: 30000 });
});
after(async () => {
  await killExecutor(exec);
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
});

const q = async (sparql) => { const r = await client.query(sparql); assert.ok(r.ok, `query failed: ${r.reason}`); return r.rows; };
const count = async (where) => Number((await q(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`))[0].n.value);

/** Fixture nodes the write's preconditions read: a typed assertion and a typed card, written raw (they are not under test). */
async function seed({ assertion, span, card }) {
  const body = `INSERT DATA { ${assertion ? `<${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} .` : ''} ${card ? `<${card}> <${RDF}type> <${RS}Card> .` : ''} }`;
  const res = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body,
    headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL } });
  assert.equal(res.status, 200, `fixture seed applied (${res.status} ${await res.text()})`);
}
const fresh = () => {
  const id = crypto.randomUUID();
  return { assertion: `https://scrumboard.local/assertion/${id}`, cardId: crypto.randomUUID(), span: `keep the injected top layer small ${id}` };
};
const proposal = ({ assertion, cardId, span }, extra = {}) => ({ assertion, card: cardId, shortId: 1319, score: 0.681, query: 'keep the injected top layer small', spanKey: spanKey(span, cardId), ...extra });
const write = (proposals, extra = {}) => client.update(linkIntention({ proposals, minScore: 0.62, model: 'qwen3-embedding:8b', at: AT, actor: ACTOR, ...extra }));

test('W1 a link.propose writes one BearsOn node per proposal, every field, status "proposed"', { skip: SKIP }, async () => {
  const f = fresh();
  await seed({ assertion: f.assertion, span: f.span, card: cardIriOf(f.cardId) });
  const p = proposal(f);
  const w = await write([p]);
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  const L = linkIri(p.spanKey);
  const rows = await q(`SELECT ?a ?c ?s ?m ?qq ?k ?mod ?st ?d WHERE { <${L}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> ?a ; <${RS}bearsOnCard> ?c ;
    <${RS}score> ?s ; <${RS}minScore> ?m ; <${RS}searchQuery> ?qq ; <${RS}spanKey> ?k ; <${RS}model> ?mod ; <${RS}status> ?st ; <${SC}dateCreated> ?d }`);
  assert.equal(rows.length, 1, 'exactly one link node with every field');
  const r = rows[0];
  assert.equal(r.a.value, f.assertion);
  assert.equal(r.c.value, cardIriOf(f.cardId));
  assert.equal(Number(r.s.value), 0.681);
  assert.equal(Number(r.m.value), 0.62);
  assert.equal(r.qq.value, p.query);
  assert.equal(r.k.value, p.spanKey);
  assert.equal(r.mod.value, 'qwen3-embedding:8b');
  assert.equal(r.st.value, 'proposed');
  assert.equal(r.d.value, AT);
});

test('W2 (L6) a link to something that is not a scrum:Card is refused, and nothing of that run is written', { skip: SKIP }, async () => {
  const ok = fresh(); const bad = fresh();
  await seed({ assertion: ok.assertion, span: ok.span, card: cardIriOf(ok.cardId) });
  await seed({ assertion: bad.assertion, span: bad.span, card: null });   // the card was never written
  const w = await write([proposal(ok), proposal(bad)]);
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`?l <${RS}fromAssertion> <${ok.assertion}>`), 0, 'the good link in the same run was not written either');
});

test('W3 (L6b) a link from something that is not a scrum:Assertion is refused, and nothing is written', { skip: SKIP }, async () => {
  const f = fresh();
  await seed({ assertion: null, span: f.span, card: cardIriOf(f.cardId) });   // the assertion was never published
  const w = await write([proposal(f)]);
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`?l <${RS}bearsOnCard> <${cardIriOf(f.cardId)}>`), 0);
});

test('W4 (L3c) the same span + card under a NEW assertion IRI is refused: it names the same link node', { skip: SKIP }, async () => {
  const f = fresh();
  await seed({ assertion: f.assertion, span: f.span, card: cardIriOf(f.cardId) });
  assert.equal((await write([proposal(f)])).outcome, 'APPLIED');
  const reborn = { ...f, assertion: `https://scrumboard.local/assertion/${crypto.randomUUID()}` };   // a .r1 re-run's fresh IRI
  await seed({ assertion: reborn.assertion, span: f.span, card: null });
  const p2 = proposal(reborn);
  assert.equal(linkIri(p2.spanKey), linkIri(proposal(f).spanKey), 'the same link IRI');
  const w = await write([p2]);
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.equal(await count(`?l <${RS}fromAssertion> <${reborn.assertion}>`), 0);
});

test('W5 the compiler refuses a malformed link before anything is sent', () => {
  const f = fresh();
  const intent = (p) => linkIntention({ proposals: [p], minScore: 0.62, model: 'm', at: AT, actor: ACTOR });
  assert.throws(() => compile(intent(proposal(f, { score: 1.5 }))), /score/);
  assert.throws(() => compile(intent(proposal(f, { score: 'high' }))), /score/);
  assert.throws(() => compile(intent(proposal(f, { query: '' }))), /query/);
  assert.throws(() => compile(linkIntention({ proposals: [], minScore: 0.62, model: 'm', at: AT, actor: ACTOR })), /at least one/);
  assert.doesNotThrow(() => compile(intent(proposal(f))), 'CONTROL: a well-formed link compiles');
});

test('W5b a link whose IRI is NOT link/<sha256(spanKey)> is refused: a caller cannot mint a fresh IRI around a dismissal', () => {
  const f = fresh();
  const good = linkIntention({ proposals: [proposal(f)], minScore: 0.62, model: 'm', at: AT, actor: ACTOR });
  const forged = { ...good, links: [{ ...good.links[0], iri: `https://scrumboard.local/link/${crypto.randomUUID().replace(/-/g, '')}` }] };
  assert.throws(() => compile(forged), /link\/<sha256\(spanKey\)>/);
  assert.doesNotThrow(() => compile(good), 'CONTROL: the derived IRI compiles');
});
