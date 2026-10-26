#!/usr/bin/env node
/**
 * #1787 — give every EXISTING card its attachment nodes. Cards written before #1787 carry their attachments only inside
 * their stored entityJson; the card projection (core/graph-replica.mjs) now emits one node per attachment, in a post's
 * shape, so every new write carries them. This re-projects the cards whose nodes are missing or differ.
 *
 *   node scripts/backfill-card-attachments-1787.mjs --executor <url> --dataset <id> [--apply]
 *
 * Without --apply: a DRY RUN that changes nothing and reports
 *   #1787 backfill (dry run): scanned N cards, K need attachment nodes, M already current
 * With --apply: each of the K goes through the ordinary guarded card.write (its own version guard; its stored JSON
 * UNCHANGED, so its REST version does not move), then
 *   #1787 backfill: scanned N, reprojected K, already current M
 * A card is CURRENT when the graph holds exactly the attachment triples its projection emits. Idempotent: a second run
 * reprojects 0. Exit 0 on success; 1 when any write is not APPLIED (naming the card), or on a usage or read error.
 * The opId is under urn:ex:op/backfill/, so a board with native history on (#1762) treats it as a migration.
 */
import { createGraphClient } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { cardQuads, priorQuads, cardIriOf, shortIdMap } from '../core/cards-graph.mjs';
import { BK } from '../core/graph-vocab.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const executor = opt('--executor'), dataset = opt('--dataset'), apply = args.includes('--apply');
if (!executor || !dataset) { console.error('usage: backfill-card-attachments-1787.mjs --executor <url> --dataset <id> [--apply]'); process.exit(1); }

const RS = 'https://scrumboard.local/ns#';
const g = createGraphClient({ baseUrl: executor, expectedDatasetId: dataset, timeoutMs: 120000, label: 'backfill-1787' });
const rows = async (sparql) => { const r = await g.query(sparql); if (!r.ok) { console.error(`#1787 backfill: the executor did not answer: ${r.reason}`); process.exit(1); } return r.rows; };
const key = (t) => `${t.type === 'uri' ? `<${t.value}>` : JSON.stringify(t.value)}^${t.datatype ?? ''}`;

// every card's stored wire JSON and its graph version stamp, in one read
const stored = await rows(`SELECT ?c ?j ?v WHERE { ?c a <${RS}Card> . GRAPH ${BK} { ?c <${RS}entityJson> ?j ; <urn:ex:ver> ?v } }`);
const cards = stored.map((r) => ({ iri: r.c.value, json: r.j.value, ver: Number(r.v.value), card: JSON.parse(r.j.value) }));
const map = shortIdMap(cards.map((x) => x.card));
// the attachment triples the graph holds now, by card
const held = new Map();
for (const r of await rows(`SELECT ?c ?a ?p ?o WHERE { ?a <${RS}attachmentOf> ?c ; ?p ?o }`)) {
  if (!held.has(r.c.value)) held.set(r.c.value, new Set());
  held.get(r.c.value).add(`<${r.a.value}> <${r.p.value}> ${key(r.o)}`);
}
const wanted = (x) => new Set(cardQuads(x.card, map).filter(([s]) => s.value.startsWith(`${x.iri}/attachment/`)).map(([s, p, o]) => `<${s.value}> <${p.value}> ${key(o)}`));
const same = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));

const need = cards.filter((x) => !same(wanted(x), held.get(x.iri) ?? new Set()));
const current = cards.length - need.length;
if (!apply) {
  console.log(`#1787 backfill (dry run): scanned ${cards.length} cards, ${need.length} need attachment nodes, ${current} already current`);
  process.exit(0);
}
let done = 0;
for (const x of need) {
  const part = { iri: cardIriOf(x.card.id), expectedVersion: String(x.ver), version: String(x.ver + 1), quads: cardQuads(x.card, map), prior: priorQuads(x.card, map), json: x.json };
  const r = await durableUpdate(g, { kind: 'card.write', opId: `urn:ex:op/backfill/1787/${x.card.id}-${x.ver}`, actor: 'https://scrumboard.local/person/board', parts: [part] });
  if (r.outcome !== 'APPLIED') { console.error(`#1787 backfill: card ${x.card.id} (#${x.card.shortId}) was not written: ${r.outcome} ${r.reason ?? ''}`); process.exit(1); }
  done++;
}
console.log(`#1787 backfill: scanned ${cards.length}, reprojected ${done}, already current ${current}`);
