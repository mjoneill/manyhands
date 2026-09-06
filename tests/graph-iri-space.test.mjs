/**
 * 2026-09-06 — ONE INVALID IRI TOOK THE WHOLE GRAPH READ SIDE DOWN.
 *
 * A tending prompt saved with a space in its slug became
 * `…/tending/prompt/scrum board-clarity`; oxigraph threw "Invalid IRI code
 * point ' '" on EVERY query that scanned the store, including ASK { ?s ?p ?o }.
 * Three layers, each tested: the mint refuses a slug that cannot be a segment
 * (with the slug that would have worked), the Settings form slugifies before
 * sending, and the replica percent-encodes any invalid character at
 * projection so a bad node already stored is queryable instead of poisonous.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPrompt, assertSlug, slugify } from '../core/tending-authoring.mjs';
import { buildGraphStore, queryGraph, invalidIriSeen } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { promptId, promptVersionId } from '../core/tending-ids.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const AT = '2026-09-06T00:00:00.000Z';
const BAD = 'https://scrumboard.local/tending/prompt/scrum board-clarity';
const poisoned = () => [
  { '@id': BAD, '@type': 'scrum:TendingPrompt', identifier: 'scrum board-clarity', 'scrum:importedAt': AT },
  { '@id': `${BAD}/v1`, '@type': 'scrum:TendingPromptVersion', 'scrum:ofPrompt': BAD, 'scrum:version': 1, 'scrum:body': 'Are the columns reflective?', author: 'person:ada', 'scrum:importedAt': AT },
  { '@id': promptId('alpha'), '@type': 'scrum:TendingPrompt', identifier: 'alpha', 'scrum:importedAt': AT },
  { '@id': promptVersionId('alpha', 1), '@type': 'scrum:TendingPromptVersion', 'scrum:ofPrompt': promptId('alpha'), 'scrum:version': 1, 'scrum:body': 'A body', author: 'person:ada', 'scrum:importedAt': AT },
  { '@id': 'https://scrumboard.local/tending/state/current', '@type': 'scrum:TendingState', 'scrum:enabled': true },
];

test('the mint REFUSES a slug that cannot be an IRI segment and names the slug that would work; plain slugs are untouched', () => {
  assert.throws(() => createPrompt([], { slug: 'scrum board-clarity', body: 'x', at: AT }), /cannot be an IRI segment.*use "scrum-board-clarity"/);
  assert.throws(() => assertSlug('a/b'), /cannot be an IRI segment/);
  assert.equal(assertSlug('scrum-board-clarity'), 'scrum-board-clarity');
  assert.equal(slugify('  Scrum Board: Clarity!  '), 'scrum-board-clarity');
  assert.equal(promptId('scrum-board-clarity'), 'https://scrumboard.local/tending/prompt/scrum-board-clarity', 'existing ids are unchanged by the rule');
  const out = createPrompt([], { slug: 'fine-slug', body: 'x', at: AT });
  assert.ok(out.some((e) => e['@id'] === promptId('fine-slug')));
});

test('a poisoned store still PROJECTS and ANSWERS: the bad node is queryable at its percent-encoded name, the good node beside it is untouched, and the count is visible', () => {
  const before = invalidIriSeen.count;
  const store = buildGraphStore(domainToJsonLd({ nodes: [], messages: [], people: [], columns: [], tending: poisoned() }));
  const all = queryGraph(store, 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }');
  assert.ok(Number(all.rows[0].n) > 0, 'ASK/SELECT over the whole store must not throw');
  const enc = queryGraph(store, 'SELECT ?v WHERE { <https://scrumboard.local/tending/prompt/scrum%20board-clarity/v1> scrum:ofPrompt ?p . <https://scrumboard.local/tending/prompt/scrum%20board-clarity> a ?v }');
  assert.equal(enc.rows.length, 1, 'the poisoned prompt lives at the encoded IRI');
  const good = queryGraph(store, 'SELECT ?b WHERE { ?v scrum:ofPrompt <https://scrumboard.local/tending/prompt/alpha> ; scrum:body ?b }');
  assert.equal(good.rows[0].b, 'A body');
  assert.ok(invalidIriSeen.count >= before + 2, 'each encoded IRI is counted (prompt + version, at least once each)');
  assert.match(invalidIriSeen.samples[0], /scrum board-clarity/);
});

test('FRONT DOOR: a board carrying the poisoned prompt boots, /api/graph answers ASK { ?s ?p ?o }, and POST /api/tending/whispers with a spaced slug is a 400 naming the fix — not a stored node', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1, tending: poisoned() }) });
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const ask = await api('POST', '/api/graph', { query: 'ASK { ?s ?p ?o }' });
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    const cards = await api('POST', '/api/graph', { query: 'SELECT ?t (COUNT(?s) AS ?n) WHERE { ?s a ?t } GROUP BY ?t' });
    assert.equal(cards.status, 200, 'the query that failed on prod');
    const bad = await api('POST', '/api/tending/whispers', { slug: 'scrum board-clarity', body: 'Are the columns reflective?', by: 'ada' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body)); assert.match(bad.body.error, /scrum-board-clarity/);
    const ok = await api('POST', '/api/tending/whispers', { slug: 'scrum-board-clarity', body: 'Are the columns reflective?', by: 'ada' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const html = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(html, /replace\(\/\[\^a-z0-9\._-\]\+\/g, '-'\)/, 'the form slugifies before sending');
  } finally { await srv.stop(); }
});
