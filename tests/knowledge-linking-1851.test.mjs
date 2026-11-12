/**
 * #1851 (#1848 slice 2) — WHICH CARDS DOES AN EXTRACTED CLAIM BEAR ON. The extractor publishes claims (#1810) and nothing
 * connects them to our work: on 2026-11-09 two seats reached for 52 claims zero times (#1848). Slice 0 linked them by hand with
 * the board's meaning search (#1849). This slice does the same by machine and writes the result as PROPOSED links a seat
 * confirms or dismisses; nothing here is delivered to anyone (that is slice 3, #1852).
 *
 * INTERFACE PINNED HERE:
 *   proposeLinks({ assertions, search, existing, minScore, perAssertion }) → Promise<{ ok, proposals, skipped, reason? }>
 *     assertions    [{ iri, gist?, span }] the published claims; the query is the gist, or the span when there is none
 *     search(q)     → { ok:true, hits:[{ id, shortId, score, kind? }] } | { ok:false, reason } — the board's card search, injected.
 *                   A hit with kind 'source' is not a card and is never linked.
 *     existing      iterable of "<assertionIri>|<cardId>" keys that already have a link in ANY status (proposed, confirmed,
 *                   dismissed). Such a pair is never proposed again: that is how a dismissal sticks.
 *     minScore      a hit below it is not proposed (the number is config: slice 0 found noise at 0.654 and a real hit at 0.622)
 *     perAssertion  at most this many links per claim, highest score first
 *   proposals: [{ assertion, card, shortId, score, query }] · skipped: how many hits were dropped because a link already existed
 *   search unavailable on ANY claim ⇒ { ok:false, reason, proposals: [] }: a run that could not search is never "0 links found".
 *
 *   L1  a hit below minScore is not proposed; one at or above it is
 *   L2  at most perAssertion links per claim, the highest scores kept
 *   L3  a dismissed pair is not proposed again (and L3b: neither is a proposed or confirmed one: the key carries no status)
 *   L4  a claim with no gist is searched by its span
 *   L5  search unavailable ⇒ ok:false with the reason and NO proposals, even if earlier claims searched fine
 *   L6  a Source hit is never linked: only cards
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeLinks, spanKey } from '../core/knowledge-linking.mjs';

const A1 = { iri: 'https://scrumboard.local/assertion/a1', gist: 'keep the injected top layer small', span: 'the top layer should stay small' };
const A2 = { iri: 'https://scrumboard.local/assertion/a2', gist: 'dreaming consolidates logs offline', span: 'dreaming runs offline' };
const hit = (id, score, extra = {}) => ({ id, shortId: Number(id.replace(/\D/g, '')) || null, score, ...extra });
const searchFrom = (table) => { const asked = []; const fn = async (q) => { asked.push(q); return table[q] ?? { ok: true, hits: [] }; }; fn.asked = asked; return fn; };

test('L1 a hit below minScore is not proposed; one at or above it is', async () => {
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('c1319', 0.681), hit('c1406', 0.62), hit('c327', 0.599)] } });
  const r = await proposeLinks({ assertions: [A1], search, existing: [], minScore: 0.62, perAssertion: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.proposals.map((p) => p.card), ['c1319', 'c1406']);
  assert.equal(r.proposals[0].assertion, A1.iri);
  assert.equal(r.proposals[0].score, 0.681);
  assert.equal(r.proposals[0].query, A1.gist, 'the query is kept on the proposal');
});

test('L2 at most perAssertion links per claim, the highest scores kept', async () => {
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('c5', 0.70), hit('c9', 0.90), hit('c7', 0.80), hit('c6', 0.75)] } });
  const r = await proposeLinks({ assertions: [A1], search, existing: [], minScore: 0.5, perAssertion: 2 });
  assert.deepEqual(r.proposals.map((p) => p.card), ['c9', 'c7']);
});

test('L3 a dismissed pair is not proposed again, and is counted as skipped', async () => {
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('c1319', 0.681), hit('c1406', 0.65)] } });
  const r = await proposeLinks({ assertions: [A1], search, existing: [`${A1.iri}|c1319`], minScore: 0.6, perAssertion: 5 });
  assert.deepEqual(r.proposals.map((p) => p.card), ['c1406']);
  assert.equal(r.skipped, 1);
});

test('L3b the existing key carries no status: a pair already proposed or confirmed is not proposed twice either', async () => {
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('c1', 0.9)] }, [A2.gist]: { ok: true, hits: [hit('c1', 0.9)] } });
  const r = await proposeLinks({ assertions: [A1, A2], search, existing: new Set([`${A1.iri}|c1`]), minScore: 0.5, perAssertion: 5 });
  assert.deepEqual(r.proposals.map((p) => `${p.assertion}|${p.card}`), [`${A2.iri}|c1`], 'the same card may still be linked from a different claim');
});

test('L3c re-extraction mints a NEW assertion IRI for the same span: the dismissed pair is still not proposed (review 52706 point 3)', async () => {
  // a .r1 re-run mints every assertion IRI with randomUUID, so the IRI key alone would let a dismissal come back
  const reborn = { iri: 'https://scrumboard.local/assertion/a1-rerun', gist: A1.gist, span: `  ${A1.span.toUpperCase()}\n` };
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('c1319', 0.681)] } });
  const r = await proposeLinks({ assertions: [reborn], search, existing: [spanKey(A1.span, 'c1319')], minScore: 0.5, perAssertion: 5 });
  assert.deepEqual(r.proposals, [], 'the same span (case and whitespace aside) under a new IRI is the same claim');
  assert.equal(r.skipped, 1);
  // CONTROL: a reworded claim is a different claim and IS proposed. This is the documented limit, not a hidden one
  const reworded = { ...reborn, span: 'the injected layer ought to be kept small' };
  const r2 = await proposeLinks({ assertions: [reworded], search, existing: [spanKey(A1.span, 'c1319')], minScore: 0.5, perAssertion: 5 });
  assert.deepEqual(r2.proposals.map((p) => p.card), ['c1319']);
  assert.equal(r2.proposals[0].spanKey, spanKey(reworded.span, 'c1319'), 'each proposal carries its span key, so the writer can store it');
});

test('L4 a claim with no gist is searched by its span', async () => {
  const noGist = { iri: 'https://scrumboard.local/assertion/a3', span: 'fixed rules can weaken stronger models' };
  const search = searchFrom({ [noGist.span]: { ok: true, hits: [hit('c1180', 0.666)] } });
  const r = await proposeLinks({ assertions: [noGist], search, existing: [], minScore: 0.6, perAssertion: 5 });
  assert.deepEqual(search.asked, [noGist.span]);
  assert.equal(r.proposals[0].query, noGist.span);
});

test('L5 search unavailable on any claim: ok:false, the reason, and no proposals at all', async () => {
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('c1', 0.9)] }, [A2.gist]: { ok: false, reason: 'embedder unavailable' } });
  const r = await proposeLinks({ assertions: [A1, A2], search, existing: [], minScore: 0.5, perAssertion: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /embedder unavailable/);
  assert.deepEqual(r.proposals, [], 'a partial search writes nothing, so "no link" can never mean "never searched"');
});

test('L6 a Source hit is never linked: only cards', async () => {
  const search = searchFrom({ [A1.gist]: { ok: true, hits: [hit('https://scrumboard.local/source/abc', 0.95, { kind: 'source' }), hit('c1', 0.7)] } });
  const r = await proposeLinks({ assertions: [A1], search, existing: [], minScore: 0.5, perAssertion: 5 });
  assert.deepEqual(r.proposals.map((p) => p.card), ['c1']);
});
