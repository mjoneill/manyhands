/**
 * #1851 (#1848 slice 2) — A SEAT CONFIRMS OR DISMISSES A PROPOSED LINK. Kind `link.decide`, against a real scratch executor.
 *
 * Every decision is its OWN node, appended, never rewritten: that history is what #1850's "used" count reads, and a confirm
 * records the card the seat was working on, so a "used" is attributable to a moment of work and not to habit (steward,
 * 52709). A confirm replaces the link's `scrum:status`.
 *
 * #1852 — A DISMISS IS ONE SEAT'S. link_decide is about to be held by every agent on the board, and one seat's dismiss
 * used to set the link's status for everyone, for good. Now a dismiss only appends that seat's decision, and the status
 * becomes "dismissed" only when the write NAMES another seat's standing dismissal (`retiresWith`) and the graph agrees:
 * two distinct seats retire a link, one never does.
 *
 * INTERFACE PINNED HERE:
 *   decideIntention({ link, verdict: 'confirmed'|'dismissed', workingOn: <card uuid>|null, retiresWith?: <decision IRI>,
 *                     actor, at, opId? }) → `link.decide`
 *   On the graph: a fresh <link>/decision/<uuid> node: rdf:type scrum:LinkDecision · scrum:ofLink <link> ·
 *     scrum:linkVerdict · scrum:decidedBy <actor> · scrum:workingOn <card>? · schema:dateCreated. <link> scrum:status is
 *     replaced (exactly one value) by a confirm and by a RETIRING dismiss; a plain dismiss leaves it alone.
 *
 *   D1   a confirm: the link reads "confirmed" (and no longer "proposed"); one LinkDecision with seat, card and time
 *   D1b  a later dismiss by the same seat: the status stays "confirmed", and BOTH decisions are on the graph (history appended)
 *   D2b  a confirm with no workingOn card is refused before anything is sent (52709)
 *   D3   a decision on something that is not a scrum:BearsOn is refused (PRECONDITION_FAILED), nothing written
 *   D4   a workingOn that is not a scrum:Card is refused, nothing written
 *   D5   a dismiss needs no workingOn, and leaves the status as it was
 *   D6   a decision IRI cannot be reused: history is appended, never merged into an old node
 *   D7   a dismiss that names ANOTHER seat's standing dismissal retires the link: status "dismissed"
 *   D8   naming a dismissal by the SAME seat retires nothing (PRECONDITION_FAILED, nothing written)
 *   D9   naming a decision that is not a dismissal retires nothing
 *   D10  naming a decision on another link is refused: before anything is sent when its IRI is elsewhere, and by the
 *        precondition when a node under this link says it is of another
 *   D11  naming a dismissal its seat has since replaced with a confirm retires nothing
 *   D12  the shape: only a dismiss may retire, and never by naming itself
 *   D13  two first dismissals that did not see each other both leave the status alone; the next one retires the link
 *   D14  a decision WITHOUT retiresWith canonicalizes and digests exactly as it did before #1852 (so RECORD_V is not bumped)
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

test('D1b a later dismiss by the same seat: the status stays "confirmed", and both decisions stay on the graph', { skip: SKIP }, async () => {
  const s = await seedLink();
  assert.equal((await client.update(decideIntention({ link: s.link, verdict: 'confirmed', workingOn: s.working, actor: SEAT, at: '2026-11-12T20:00:00.000Z' }))).outcome, 'APPLIED');
  assert.equal((await client.update(decideIntention({ link: s.link, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:05:00.000Z' }))).outcome, 'APPLIED');
  assert.deepEqual(await statuses(s.link), ['confirmed'], 'one seat\'s dismiss does not move the link\'s status (#1852)');
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

test('D5 a dismiss needs no workingOn, and leaves the status as it was', { skip: SKIP }, async () => {
  const s = await seedLink();
  const w = await client.update(decideIntention({ link: s.link, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:00:00.000Z' }));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['proposed'], 'one seat\'s dismiss retires nothing (#1852)');
  assert.equal(await count(`?d <${RS}ofLink> <${s.link}> FILTER NOT EXISTS { ?d <${RS}workingOn> ?w }`), 1);
});

test('D6 a decision IRI cannot be reused: a second verdict under the same node is refused, so history is never merged', { skip: SKIP }, async () => {
  const s = await seedLink();
  const first = decideIntention({ link: s.link, verdict: 'confirmed', workingOn: s.working, actor: SEAT, at: '2026-11-12T20:00:00.000Z' });
  assert.equal((await client.update(first)).outcome, 'APPLIED');
  const reuse = decideIntention({ link: s.link, verdict: 'dismissed', workingOn: null, actor: SEAT, at: '2026-11-12T20:05:00.000Z' });
  reuse.decision = first.decision;   // a caller naming an existing decision node (a fresh opId, so this is not a replay)
  const w = await client.update(reuse);
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['confirmed'], 'the status did not move');
  assert.deepEqual((await q(`SELECT ?v WHERE { <${first.decision}> <${RS}linkVerdict> ?v }`)).map((r) => r.v.value), ['confirmed'], 'the first decision is untouched');
});

// ── #1852 — a dismiss is one seat's; two distinct seats retire a link ────────────────────────────────────────────────
const OTHER = 'https://scrumboard.local/person/bea';
const T0 = '2026-11-14T16:00:00.000Z'; const T1 = '2026-11-14T16:05:00.000Z'; const T2 = '2026-11-14T16:10:00.000Z';
const dismiss = (link, actor, at, retiresWith) => decideIntention({ link, verdict: 'dismissed', workingOn: null, actor, at, ...(retiresWith ? { retiresWith } : {}) });
const decisionsOf = async (link) => (await q(`SELECT ?by ?v WHERE { ?d <${RS}ofLink> <${link}> ; <${RS}linkVerdict> ?v ; <${RS}decidedBy> ?by }`)).map((r) => `${r.by.value.split('/').pop()}:${r.v.value}`).sort();

test('D7 a dismiss that names another seat\'s standing dismissal retires the link', { skip: SKIP }, async () => {
  const s = await seedLink();
  const first = dismiss(s.link, OTHER, T0);
  assert.equal((await client.update(first)).outcome, 'APPLIED');
  assert.deepEqual(await statuses(s.link), ['proposed'], 'PRECONDITION: the first dismiss retired nothing');
  const w = await client.update(dismiss(s.link, SEAT, T1, first.decision));
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['dismissed'], 'exactly one status, and it is dismissed');
  assert.deepEqual(await decisionsOf(s.link), ['ada:dismissed', 'bea:dismissed']);
});

test('D8 naming a dismissal by the SAME seat retires nothing', { skip: SKIP }, async () => {
  const s = await seedLink();
  const first = dismiss(s.link, SEAT, T0);
  assert.equal((await client.update(first)).outcome, 'APPLIED');
  const w = await client.update(dismiss(s.link, SEAT, T1, first.decision));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['proposed']);
  assert.deepEqual(await decisionsOf(s.link), ['ada:dismissed'], 'and the refused write appended no decision');
});

test('D9 naming a decision that is not a dismissal retires nothing', { skip: SKIP }, async () => {
  const s = await seedLink();
  const confirm = decideIntention({ link: s.link, verdict: 'confirmed', workingOn: s.working, actor: OTHER, at: T0 });
  assert.equal((await client.update(confirm)).outcome, 'APPLIED');
  const w = await client.update(dismiss(s.link, SEAT, T1, confirm.decision));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['confirmed']);
});

test('D10 naming a decision on another link is refused', { skip: SKIP }, async () => {
  const s = await seedLink(); const elsewhere = await seedLink();
  const theirs = dismiss(elsewhere.link, OTHER, T0);
  assert.equal((await client.update(theirs)).outcome, 'APPLIED');
  assert.throws(() => compile(dismiss(s.link, SEAT, T1, theirs.decision)), /retiresWith must be a decision of this link/, 'an IRI under another link never compiles');
  // a node that SITS under this link's IRI but says it is of another link: only the graph can tell
  const forged = `${s.link}/decision/${crypto.randomUUID()}`;
  await raw(`INSERT DATA { <${forged}> <${RDF}type> <${RS}LinkDecision> ; <${RS}ofLink> <${elsewhere.link}> ; <${RS}linkVerdict> "dismissed" ; <${RS}decidedBy> <${OTHER}> ; <${SC}dateCreated> "${T0}" . }`);
  const w = await client.update(dismiss(s.link, SEAT, T1, forged));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['proposed']);
  const missing = await client.update(dismiss(s.link, SEAT, T1, `${s.link}/decision/${crypto.randomUUID()}`));
  assert.equal(missing.outcome, 'PRECONDITION_FAILED', 'and a decision that does not exist retires nothing either');
});

test('D11 naming a dismissal its seat has since replaced with a confirm retires nothing', { skip: SKIP }, async () => {
  const s = await seedLink();
  const old = dismiss(s.link, OTHER, T0);
  assert.equal((await client.update(old)).outcome, 'APPLIED');
  assert.equal((await client.update(decideIntention({ link: s.link, verdict: 'confirmed', workingOn: s.working, actor: OTHER, at: T1 }))).outcome, 'APPLIED');
  const w = await client.update(dismiss(s.link, SEAT, T2, old.decision));
  assert.equal(w.outcome, 'PRECONDITION_FAILED', JSON.stringify(w));
  assert.deepEqual(await statuses(s.link), ['confirmed'], 'the other seat\'s standing verdict is her confirm');
});

test('D12 the shape: only a dismiss may retire, and never by naming itself', () => {
  const link = linkIri('span:x|y');
  const other = `${link}/decision/${crypto.randomUUID()}`;
  assert.doesNotThrow(() => compile(dismiss(link, SEAT, T0, other)), 'CONTROL: a dismiss naming another decision of its link compiles');
  assert.throws(() => compile({ ...decideIntention({ link, verdict: 'confirmed', workingOn: 'c', actor: SEAT, at: T0 }), retiresWith: other }), /only a dismiss retires/);
  const self = dismiss(link, SEAT, T0);
  assert.throws(() => compile({ ...self, retiresWith: self.decision }), /cannot retire with itself/);
});

test('D13 two first dismissals that did not see each other both leave the status alone; the next one retires the link', { skip: SKIP }, async () => {
  // the race the server accepts: each read the decisions before the other's write landed, so neither names the other
  const s = await seedLink();
  const a = dismiss(s.link, SEAT, T0); const b = dismiss(s.link, OTHER, T0);
  assert.equal((await client.update(a)).outcome, 'APPLIED');
  assert.equal((await client.update(b)).outcome, 'APPLIED');
  assert.deepEqual(await statuses(s.link), ['proposed'], 'two dismissals, and the link is not retired yet');
  const next = await client.update(dismiss(s.link, SEAT, T1, b.decision));
  assert.equal(next.outcome, 'APPLIED', JSON.stringify(next));
  assert.deepEqual(await statuses(s.link), ['dismissed'], 'the next dismiss sees the other seat\'s and retires it');
});

test('D14 a decision without retiresWith canonicalizes and digests exactly as it did before #1852', () => {
  // WHY: #1852 added `retiresWith` to link.decide without bumping RECORD_V, on the claim that a write which does not carry it
  // is byte-for-byte the record it always was. A bump would move the digest of EVERY record kind, and an op replayed by its
  // opId across the deploy would then read as an intent collision. This row holds the claim.
  // HOW THE EXPECTED VALUES WERE OBTAINED (2026-11-14): these two intentions were compiled by origin/main's own
  // core/graph-compiler.mjs at c3e6904, from a detached worktree, and `digest` and JSON.stringify(canonical.record) copied here.
  const link = `https://scrumboard.local/link/${'ab'.repeat(32)}`;
  const base = { kind: 'link.decide', actor: 'urn:ex:seat/seat-a', link, at: '2026-11-14T16:00:00.000Z' };
  const confirm = compile({ ...base, opId: 'urn:ex:op/pin-1852-confirm', verdict: 'confirmed', decision: `${link}/decision/pin-confirm`, workingOn: 'https://scrumboard.local/entity/pin-card' });
  const plain = compile({ ...base, opId: 'urn:ex:op/pin-1852-dismiss', verdict: 'dismissed', decision: `${link}/decision/pin-dismiss`, workingOn: null });
  assert.equal(JSON.stringify(confirm.canonical.record), `{"link":"${link}","verdict":"confirmed","decision":"${link}/decision/pin-confirm","workingOn":"https://scrumboard.local/entity/pin-card","at":"2026-11-14T16:00:00.000Z"}`);
  assert.equal(confirm.digest, '4c7b3c01761b7d8cc097d9dc7484ff24c47b845c95e9385f113d69fd1c85300e');
  assert.equal(JSON.stringify(plain.canonical.record), `{"link":"${link}","verdict":"dismissed","decision":"${link}/decision/pin-dismiss","workingOn":null,"at":"2026-11-14T16:00:00.000Z"}`);
  assert.equal(plain.digest, 'e6ca2fcc76a347e5d0758cd3fad917d221edfbaa71e2f115a1f6dcb73b28be87');
  // CONTROL: the field IS digest-covered when present, so a retiring write can never be replayed as a plain one
  const retiring = compile({ ...base, opId: 'urn:ex:op/pin-1852-dismiss', verdict: 'dismissed', decision: `${link}/decision/pin-dismiss`, workingOn: null, retiresWith: `${link}/decision/pin-other` });
  assert.notEqual(retiring.digest, plain.digest);
});
