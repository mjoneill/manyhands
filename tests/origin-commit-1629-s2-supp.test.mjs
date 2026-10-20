/**
 * #1629 slice 2 — SUPPLEMENTAL rows for the two code-review findings at 52458d4e (the contract owner's review recorded at card v122). TEST
 * AUTHOR's, written after the frozen file (origin-commit-1629-s2.test.mjs, unchanged) and before the builder's corrections.
 *
 *   SP1  readPreparedOrigin must not accept a stored plan that is MALFORMED (not a card.write plan at all) merely because its planDigest was
 *        recomputed to match: the reader validates the plan's schema, not only its hash. Read INVALID.
 *   SP2  the same for a plan that IS a well-formed canonical card.write plan but breaks the route binding (a card route with TWO card parts),
 *        with both digests recomputed to match: the reader validates the route binding. Read INVALID.
 *        CONTROL for SP1/SP2: the untampered Prepared node reads ok, and a tamper that leaves the planDigest STALE is INVALID (so a pass in
 *        SP1/SP2 cannot come from a reader that never got past the digest check).
 *   SP3  an agent route whose provenance.releasedCards lists the cards in a different order from the plan's canonical part order is
 *        refused at canonicalization, for prepare and for the commit; CONTROL: the same cards in plan order are accepted.
 *
 * Digests are computed HERE from r3 §3's own formula (sha256 of "originPlanV 1\n" + JSON / "originDescriptorV 1\n" + JSON), not with the build's
 * functions. NOT covered: any other schema rule of the plan beyond these two shapes; the route-binding of a descriptor whose plan is valid.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';
import { entityQuads } from '../core/collections-unit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let M = null, modErr = null;
try { M = await import(pathToFileURL(path.join(HERE, '..', 'core', 'origin-commit.mjs')).href); } catch (e) { modErr = e; }
const need = () => assert.ok(M, `core/origin-commit.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'og1629s';
const BK = 'urn:scrum:bookkeeping:executor';
const NAMESPACE = 'cd807138-eefc-40d2-9a80-525e666e6269';
const OI = (name) => `urn:ex:origin/${name}`;
const ACTOR_SEAT = 'ada';
const ACTOR = `https://scrumboard.local/person/${ACTOR_SEAT}`;
const AGENT_ID = (seat) => `https://scrumboard.local/agent/${encodeURIComponent(seat)}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const planDigest = (json) => sha(`originPlanV 1\n${json}`);

function uuidv5(name, ns) {
  const h = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(ns.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const midOf = (route, subject, requestKey) => uuidv5(JSON.stringify(['origin-v1', route, subject, requestKey, ACTOR_SEAT]), NAMESPACE);
const card = (id, shortId, extra = {}) => ({ id, shortId, title: `card ${shortId}`, description: 'body', column: 'backlog', createdAt: '2026-10-20T06:00:00.000Z', createdBy: 'ada', version: 1, ...extra });
const cpart = (c, expectedVersion, prior = null) => ({ iri: cardIriOf(c.id), expectedVersion, version: c.version, quads: cardQuads(c, new Map()), ...(prior ? { prior: priorQuads(prior, new Map()) } : {}), json: JSON.stringify(c) });
function claimOrigin(c, requestKey) {
  const mid = midOf('claim', c.id, requestKey);
  const descriptor = { route: 'claim', subject: c.id, requestKey, originActor: ACTOR_SEAT, mutationId: mid, provenance: { cardId: c.id, version: 2 }, slots: [{ slot: 'claim', author: 'board', body: 'announce 0', mentions: [], notify: true }] };
  return { mid, descriptor, plan: { parts: [cpart({ ...c, version: 2, claimedBy: ACTOR_SEAT }, '1', c)] } };
}
const prepareIntention = (o) => ({ kind: 'origin.prepare', opId: `urn:ex:op/origin/prepare/${o.mid}`, actor: ACTOR, origin: o.descriptor, plan: o.plan });

const STORES = [];
after(() => { for (const d of STORES) fs.rmSync(d, { recursive: true, force: true }); });
let n = 0;
async function world(body, cards) {
  need();
  const store = tmpStore('og1629s-'); STORES.push(store); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'origin-1629-supp' });
    for (const c of cards) assert.equal((await client.update({ kind: 'card.write', opId: `urn:ex:op/card/og1629s-${process.pid}-${n++}`, actor: ACTOR, parts: [cpart(c, null)] })).outcome, 'APPLIED', `PRECONDITION: card ${c.id}`);
    await body({ client, exec });
  } finally { await killExecutor(exec); }
}
async function raw(exec, sparql) {
  const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/og1629s-${process.pid}-${n++}` }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: the test's tamper was written (${await r.text()})`);
}
const lit = (s) => JSON.stringify(s);
/** Replace the stored planJson (and, unless `staleDigest`, the planDigest) of the Prepared node, keeping each literal's datatype. */
async function replacePlan(exec, mid, planJson, { staleDigest = false } = {}) {
  const P = `<${OI(`prepared/${mid}`)}>`;
  await raw(exec, `DELETE { GRAPH <${BK}> { ${P} <${OI('planJson')}> ?j } } INSERT { GRAPH <${BK}> { ${P} <${OI('planJson')}> ?nj } } WHERE { GRAPH <${BK}> { ${P} <${OI('planJson')}> ?j } BIND(STRDT(${lit(planJson)}, DATATYPE(?j)) AS ?nj) }`);
  if (!staleDigest) await raw(exec, `DELETE { GRAPH <${BK}> { ${P} <${OI('planDigest')}> ?d } } INSERT { GRAPH <${BK}> { ${P} <${OI('planDigest')}> ?nd } } WHERE { GRAPH <${BK}> { ${P} <${OI('planDigest')}> ?d } BIND(STRDT(${lit(planDigest(planJson))}, DATATYPE(?d)) AS ?nd) }`);
}

test('#1629 s2 (SP1) a MALFORMED stored plan with a matching planDigest reads INVALID; CONTROLS: untampered ok, stale digest INVALID', T, async () => {
  const a = card('sp1', 1), b = card('sp1b', 2);
  await world(async ({ client, exec }) => {
    const oa = claimOrigin(a, 'k-sp1'), ob = claimOrigin(b, 'k-sp1-stale');
    for (const o of [oa, ob]) assert.equal((await client.update(prepareIntention(o))).outcome, 'APPLIED', 'PRECONDITION: prepared');
    assert.equal((await M.readPreparedOrigin(client, oa.mid)).ok, true, 'CONTROL: the untampered Prepared reads ok');
    const malformed = JSON.stringify({ parts: [{ iri: 'not-a-card' }] });
    await replacePlan(exec, ob.mid, malformed, { staleDigest: true });
    assert.equal((await M.readPreparedOrigin(client, ob.mid)).status, 'INVALID', 'CONTROL: a malformed plan with a STALE digest is INVALID (the digest check)');
    await replacePlan(exec, oa.mid, malformed);
    const r = await M.readPreparedOrigin(client, oa.mid);
    assert.equal(r.ok, false, `SP1: a malformed plan is never ok, even with a matching digest (${JSON.stringify(r).slice(0, 200)})`);
    assert.equal(r.status, 'INVALID');
  }, [a, b]);
});

test('#1629 s2 (SP2) a well-formed plan that breaks the card-route binding (two card parts), digests matching, reads INVALID', T, async () => {
  const a = card('sp2a', 1), b = card('sp2b', 2);
  await world(async ({ client, exec }) => {
    const oa = claimOrigin(a, 'k-sp2'), ob = claimOrigin(b, 'k-sp2-other');
    for (const o of [oa, ob]) assert.equal((await client.update(prepareIntention(o))).outcome, 'APPLIED', 'PRECONDITION: prepared');
    const pa = (await M.readPreparedOrigin(client, oa.mid)).prepared, pb = (await M.readPreparedOrigin(client, ob.mid)).prepared;
    // two canonical one-part plans merged into one two-part plan, parts in canonical (iri) order: a valid card.write plan, the wrong route shape
    const parts = [...JSON.parse(pa.planJson).parts, ...JSON.parse(pb.planJson).parts].sort((x, y) => (x.iri < y.iri ? -1 : 1));
    const twoPart = JSON.stringify({ ...JSON.parse(pa.planJson), parts });
    // PRECONDITION: each part is byte-for-byte a part the build itself stored as canonical, in canonical order (the stored plan holds
    // canonical term strings, which compile() does not take as input, so well-formedness is shown by provenance, not by recompiling)
    assert.equal(parts.length, 2); assert.ok(parts[0].iri < parts[1].iri, 'PRECONDITION: parts in canonical iri order');
    await replacePlan(exec, oa.mid, twoPart);
    // (the stale-digest control lives in SP1; here both digests match, so only a route-binding check can refuse)
    const r = await M.readPreparedOrigin(client, oa.mid);
    assert.equal(r.ok, false, `SP2: a claim Prepared whose plan has two card parts is never ok (${JSON.stringify(r).slice(0, 200)})`);
    assert.equal(r.status, 'INVALID');
  }, [a, b]);
});

test('#1629 s2 (SP3) releasedCards out of the plan\'s canonical part order is refused for prepare and commit; in order, accepted', () => {
  need();
  const x = card('sp3a', 1, { claimedBy: 'zoe' }), y = card('sp3b', 2, { claimedBy: 'zoe' });
  const agent = { '@id': AGENT_ID('zoe'), '@type': 'scrum:Agent', 'scrum:seatKey': 'zoe', 'scrum:state': 'resting', name: 'zoe' };
  const plan = { parts: [x, y].map((c) => { const { claimedBy, ...r } = c; return cpart({ ...r, version: 2 }, '1', c); }),
    collections: [{ collection: 'agents', iri: AGENT_ID('zoe'), expectedVersion: '1', version: '2', quads: entityQuads(agent), json: JSON.stringify(agent), unique: [{ predicate: 'https://scrumboard.local/ns#seatKey', value: { type: 'literal', value: 'zoe' } }] }] };
  const make = (released, requestKey) => {
    const mid = midOf('agent-rest', 'zoe', requestKey);
    const descriptor = { route: 'agent-rest', subject: 'zoe', requestKey, originActor: ACTOR_SEAT, mutationId: mid, provenance: { agent: 'zoe', releasedCards: released }, slots: [{ slot: 'agent-rest', author: 'board', body: 'zoe is resting', mentions: [], notify: false }] };
    return { mid, descriptor, plan };
  };
  const canonicalOrder = [x.id, y.id].sort((p, q) => (cardIriOf(p) < cardIriOf(q) ? -1 : 1));
  const inOrder = make(canonicalOrder, 'k-sp3-ok'), reversed = make([...canonicalOrder].reverse(), 'k-sp3-rev');
  assert.doesNotThrow(() => compile(prepareIntention(inOrder)), 'CONTROL: releasedCards in the plan\'s canonical order is accepted');
  assert.throws(() => compile(prepareIntention(reversed)), /./, 'SP3: releasedCards in another order is refused at prepare');
  const commit = (o) => ({ kind: 'card.write', opId: `urn:ex:op/origin/commit/${o.mid}`, actor: ACTOR, ...o.plan, origin: { ...o.descriptor, occurredAt: '2026-10-20T06:00:00.000Z' } });
  assert.doesNotThrow(() => compile(commit(inOrder)), 'CONTROL: in order, the commit compiles');
  assert.throws(() => compile(commit(reversed)), /./, 'SP3: releasedCards in another order is refused at the commit too');
});
