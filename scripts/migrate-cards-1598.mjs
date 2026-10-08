#!/usr/bin/env node
/**
 * #1598 K8 — COPY THE DOCUMENT'S CARDS INTO THE GRAPH.
 *
 *   node scripts/migrate-cards-1598.mjs --board-data <path> --executor <url> --dataset <id> [--apply]
 *
 * Without --apply it reads both sides and reports what it WOULD write; nothing is sent. With --apply, each document
 * card is ONE `card.write` create part (the replica's own projection, the card's wire JSON, graph version 1) under an
 * opId derived from the card id, so a re-run replays receipts and writes nothing twice. A card the graph already holds
 * is PRECONDITION_FAILED and left as it is. The shortId counter is seeded from the document's `nextShortId` when the
 * graph has none yet.
 *
 * Run with REST STOPPED (it reads the document as REST would have written it). The document is NOT changed: removing
 * its cards is a separate, verified step (the #1626 retire script's shape), after a by-id read-back.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { jsonLdToDomain, isJsonLdDocument } from '../core/jsonld.mjs';
import { domainToBoard } from '../core/mapping.mjs';
import { cardQuads, cardIriOf, shortIdMap, SHORTID_COUNTER_IRI } from '../core/cards-graph.mjs';
import { BK } from '../core/graph-vocab.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = opt('--board-data'); const executor = opt('--executor'); const dataset = opt('--dataset'); const apply = args.includes('--apply');
if (!file || !executor || !dataset) {
  console.error('usage: node scripts/migrate-cards-1598.mjs --board-data <path> --executor <url> --dataset <id> [--apply]');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const board = domainToBoard(isJsonLdDocument(raw) ? jsonLdToDomain(raw) : raw);
const cards = (board.cards || []).filter((c) => c && typeof c.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(c.id));
const skipped = (board.cards || []).filter((c) => !cards.includes(c)).map((c) => JSON.stringify(c?.id));
const ids = shortIdMap(board.cards || []);
const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 120000 });

async function count() {
  const q = await g.query(`SELECT (COUNT(?s) AS ?n) WHERE { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://scrumboard.local/ns#Card> . GRAPH ${BK} { ?s <urn:ex:ver> ?v } }`);
  if (!q.ok) throw new Error(`the graph could not be read: ${q.reason}`);
  return Number(q.rows[0]?.n?.value ?? 0);
}
async function counter() {
  const q = await g.query(`SELECT ?n WHERE { GRAPH ${BK} { <${SHORTID_COUNTER_IRI}> <urn:ex:ver> ?n } }`);
  if (!q.ok) throw new Error(`the graph could not be read: ${q.reason}`);
  return q.rows.length ? Number(q.rows[0].n.value) : null;
}

const before = { cards: await count(), counter: await counter() };
console.log(`document: ${cards.length} cards (${skipped.length} with an id that cannot be an IRI), nextShortId ${board.nextShortId} · graph before: ${JSON.stringify(before)} · ${apply ? 'APPLY' : 'DRY RUN (nothing sent)'}`);
for (const s of skipped.slice(0, 20)) console.log(`  skipped: card id ${s}`);
const tally = { APPLIED: 0, PRECONDITION_FAILED: 0, refused: 0 };
const refused = [];
if (apply) {
  const t0 = Date.now();
  for (const [k, c] of cards.entries()) {
    const intent = {
      kind: 'card.write', opId: `urn:ex:op/card/import/${c.id}`, actor: 'https://scrumboard.local/person/board',
      parts: [{ iri: cardIriOf(c.id), expectedVersion: null, version: '1', quads: cardQuads(c, ids), json: JSON.stringify(c), importDigest: createHash('sha256').update(JSON.stringify(c)).digest('hex') }],
    };
    const r = await g.update(intent);
    if (r.outcome === 'APPLIED' || r.outcome === 'PRECONDITION_FAILED') tally[r.outcome]++;
    else if (r.outcome === 'REJECTED') { tally.refused++; refused.push(`card ${c.shortId} ${c.id}: ${r.reason}`); }
    else throw new Error(`card ${c.shortId} ${c.id}: ${r.outcome} ${r.reason ?? ''} — stopped; a re-run is safe (every opId is derived)`);
    if ((k + 1) % 200 === 0) console.error(`cards: ${k + 1}/${cards.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  if (before.counter == null && Number.isSafeInteger(board.nextShortId)) {
    const r = await g.update({ kind: 'card.write', opId: `urn:ex:op/card/import/counter-${board.nextShortId}`, actor: 'https://scrumboard.local/person/board',
      parts: [], counter: { expected: null, next: String(board.nextShortId) } }).catch((e) => ({ outcome: 'ERROR', reason: e.message }));
    console.log(`counter seed: ${r.outcome}${r.reason ? ` ${r.reason}` : ''}`);
  }
}
const after = { cards: await count(), counter: await counter() };
console.log(`cards: ${JSON.stringify(tally)}`);
console.log(`graph after: ${JSON.stringify(after)}`);
for (const s of refused.slice(0, 20)) console.log(`  REFUSED: ${s}`);
if (apply) {
  const short = [];
  if (after.cards < cards.length) short.push(`cards ${after.cards} < ${cards.length}`);
  if (after.counter == null || after.counter < board.nextShortId) short.push(`counter ${after.counter} < ${board.nextShortId}`);
  if (short.length || refused.length) { console.log(`INCOMPLETE: ${[...short, `${refused.length} refused`].join('; ')}`); process.exit(1); }
  console.log('COMPLETE: every document card is in the graph, and the counter is at least the document\'s nextShortId.');
}
