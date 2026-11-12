/**
 * #1851 (#1848 slice 2) — ONE LINKING RUN end to end over a real scratch executor: read a run's published claims from the graph,
 * read every link that already exists (any status), search each claim, write what is new in one update. The search is a fake
 * here (the live one is POST /api/search); the graph is real.
 *
 * INTERFACE PINNED HERE:
 *   linkRun({ graphClient, search, run, minScore, perAssertion, model, actor, at }) →
 *     { ok:true, assertions, proposed, skipped, outcome }   outcome = the write's outcome, or 'nothing-to-write'
 *     { ok:false, reason, proposed:0 }                      search unavailable, or the graph unreadable: nothing written
 *
 *   R1  a run's claims are read from the graph and their links written; the count on the graph equals `proposed`
 *   R2  a second run over the same claims proposes nothing, sends NO update, and counts what it skipped
 *   R3  a link already DISMISSED on the graph is not proposed again (the existing set is read with no status filter)
 *   R4  search unavailable: ok:false with the reason, nothing written
 *   R5  a run with no published claims: ok:true, nothing proposed, nothing sent (not an error, and not a silent success
 *       either: assertions:0 says why)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { linkRun, spanKey, linkIri } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const AT = '2026-11-12T19:40:00.000Z';
const ACTOR = 'https://scrumboard.local/person/linker';

let exec, client, storeDir;
before(async () => {
  if (SKIP) return;
  storeDir = tmpStore('klr-1851-');
  exec = await startExecutor({ store: storeDir, datasetId: 'klr-1851', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'klr-1851', timeoutMs: 30000 });
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
/** A run with two published claims and two cards, all fresh. */
async function seedRun() {
  const run = `https://scrumboard.local/activity/run-${crypto.randomUUID()}`;
  const claims = [
    { iri: `https://scrumboard.local/assertion/${crypto.randomUUID()}`, gist: `keep the top layer small ${run}`, span: `the top layer should stay small ${run}` },
    { iri: `https://scrumboard.local/assertion/${crypto.randomUUID()}`, gist: null, span: `dreaming consolidates logs offline ${run}` },
  ];
  const cards = [crypto.randomUUID(), crypto.randomUUID()];
  await raw(`INSERT DATA { ${claims.map((c) => `<${c.iri}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; <${RS}anchorText> ${JSON.stringify(c.span)}${c.gist ? ` ; <${RS}gist> ${JSON.stringify(c.gist)}` : ''} .`).join(' ')}
    ${cards.map((id) => `<${cardIriOf(id)}> <${RDF}type> <${RS}Card> .`).join(' ')} }`);
  // the fake search: the first claim bears on card 0, the second (searched by its SPAN: it has no gist) on card 1
  const table = { [claims[0].gist]: [{ id: cards[0], shortId: 1, score: 0.8 }], [claims[1].span]: [{ id: cards[1], shortId: 2, score: 0.7 }] };
  const asked = [];
  const search = async (text) => { asked.push(text); return { ok: true, hits: table[text] ?? [] }; };
  return { run, claims, cards, search, asked };
}
const countingClient = () => { let updates = 0; return { c: { ...client, update: async (i, o) => { updates += 1; return client.update(i, o); } }, n: () => updates }; };
const go = (extra) => linkRun({ graphClient: client, minScore: 0.6, perAssertion: 3, model: 'qwen3-embedding:8b', actor: ACTOR, at: AT, ...extra });

test('R1 a run\'s claims are read from the graph and their links written', { skip: SKIP }, async () => {
  const s = await seedRun();
  const r = await go({ run: s.run, search: s.search });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.assertions, 2);
  assert.equal(r.proposed, 2);
  assert.equal(r.outcome, 'APPLIED');
  assert.deepEqual([...s.asked].sort(), [s.claims[0].gist, s.claims[1].span].sort(), 'the gist when there is one, else the span');
  assert.equal(await count(`?l <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${s.claims[0].iri}> ; <${RS}bearsOnCard> <${cardIriOf(s.cards[0])}>`), 1);
  assert.equal(await count(`?l <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${s.claims[1].iri}> ; <${RS}bearsOnCard> <${cardIriOf(s.cards[1])}>`), 1);
});

test('R2 a second run over the same claims proposes nothing and sends no update', { skip: SKIP }, async () => {
  const s = await seedRun();
  assert.equal((await go({ run: s.run, search: s.search })).proposed, 2);
  const k = countingClient();
  const r = await go({ run: s.run, search: s.search, graphClient: k.c });
  assert.deepEqual({ ok: r.ok, proposed: r.proposed, skipped: r.skipped, outcome: r.outcome }, { ok: true, proposed: 0, skipped: 2, outcome: 'nothing-to-write' });
  assert.equal(k.n(), 0, 'no update was sent');
});

test('R3 a link already DISMISSED on the graph is not proposed again', { skip: SKIP }, async () => {
  const s = await seedRun();
  const key = spanKey(s.claims[0].span, s.cards[0]);
  await raw(`INSERT DATA { <${linkIri(key)}> <${RDF}type> <${RS}BearsOn> ; <${RS}spanKey> ${JSON.stringify(key)} ; <${RS}status> "dismissed" . }`);
  const r = await go({ run: s.run, search: s.search });
  assert.equal(r.proposed, 1, JSON.stringify(r));
  assert.equal(r.skipped, 1);
  assert.equal(await count(`?l <${RS}fromAssertion> <${s.claims[0].iri}>`), 0, 'the dismissed pair was not written again');
});

test('R4 search unavailable: ok:false with the reason, nothing written', { skip: SKIP }, async () => {
  const s = await seedRun();
  const k = countingClient();
  const r = await go({ run: s.run, graphClient: k.c, search: async () => ({ ok: false, reason: 'embedder unavailable' }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /embedder unavailable/);
  assert.equal(k.n(), 0);
  assert.equal(await count(`?l <${RS}fromAssertion> <${s.claims[0].iri}>`), 0);
});

test('R6 a dry run proposes and writes nothing: the reading before the writing', { skip: SKIP }, async () => {
  const s = await seedRun();
  const k = countingClient();
  const r = await go({ run: s.run, search: s.search, graphClient: k.c, dryRun: true });
  assert.deepEqual({ ok: r.ok, proposed: r.proposed, outcome: r.outcome }, { ok: true, proposed: 2, outcome: 'dry-run' });
  assert.equal(r.links.length, 2, 'the proposals are returned to read');
  assert.equal(k.n(), 0, 'no update was sent');
  assert.equal(await count(`?l <${RS}fromAssertion> <${s.claims[0].iri}>`), 0);
});

test('R7 the model may be a function, read when the write is built (the live search learns it from its first answer)', { skip: SKIP }, async () => {
  const s = await seedRun();
  let learned = null;
  const search = async (q) => { learned = 'learned-model'; return s.search(q); };
  const r = await go({ run: s.run, search, model: () => learned });
  assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
  const m = await q(`SELECT DISTINCT ?m WHERE { ?l <${RS}fromAssertion> <${s.claims[0].iri}> ; <${RS}model> ?m }`);
  assert.deepEqual(m.map((x) => x.m.value), ['learned-model']);
});

test('R5 a run with no published claims: ok, nothing proposed, nothing sent, and assertions:0 says why', { skip: SKIP }, async () => {
  const k = countingClient();
  const r = await go({ run: `https://scrumboard.local/activity/run-empty-${crypto.randomUUID()}`, graphClient: k.c, search: async () => { throw new Error('must not search'); } });
  assert.deepEqual({ ok: r.ok, assertions: r.assertions, proposed: r.proposed, outcome: r.outcome }, { ok: true, assertions: 0, proposed: 0, outcome: 'nothing-to-write' });
  assert.equal(k.n(), 0);
});
