/**
 * #1629 slice 2 — SECOND SUPPLEMENTAL row, for the contract owner's re-review of 5b9bf46b (card v127): the reader's stored-term check
 * accepted a literal that is INVALID for its datatype ("oops"^^xsd:integer) and one that is valid but NOT CANONICAL ("01"^^xsd:integer).
 * TEST AUTHOR's, written after the pinned set (rows, supp, golden: all unchanged) and before the builder's correction.
 *
 *   SP4  a Prepared whose stored plan carries a typed literal the forward compiler would refuse ("oops"^^xsd:integer) or would have
 *        canonicalized differently ("02"^^xsd:integer, canonical "2"), with planDigest recomputed to match, reads INVALID.
 *        CONTROLS: the plan as prepared (a canonical "N"^^xsd:integer, admitted by the FORWARD path) reads ok; and the SAME tamper
 *        machinery rewriting that term to its own canonical text, digest recomputed, still reads ok — so an INVALID in SP4 cannot come from
 *        the rewrite itself.
 *
 * The typed literal enters through compile(origin.prepare), not by hand, so the "valid" side is the forward compiler's own judgement.
 * NOT covered: other datatypes (boolean, dateTime), language tags, IRI terms, prior quads, collection parts.
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

const XI = 'http://www.w3.org/2001/XMLSchema#integer';
const IDENT = '<https://schema.org/identifier>';
/** the card's schema:identifier carried as a TYPED xsd:integer in the part's quads (the forward path decides if that is admissible) */
const typedIdent = (o) => {
  const p = o.plan.parts[0];
  p.quads = p.quads.map(([s, pr, ob]) => (pr.value === 'https://schema.org/identifier' ? [s, pr, { type: 'literal', value: ob.value, datatype: XI }] : [s, pr, ob]));
  return o;
};
/** the stored planJson with the identifier term replaced by `"<lex>"^^xsd:integer`, quads re-sorted the way the build sorts them */
const withIdent = (planJson, lex) => {
  const plan = JSON.parse(planJson);
  plan.parts[0].quads = plan.parts[0].quads.map((q) => (q[1] === IDENT ? [q[0], q[1], `"${lex}"^^<${XI}>`] : q)).sort((x, y) => (x.join(' ') < y.join(' ') ? -1 : 1));
  return JSON.stringify(plan);
};

test('#1629 s2 (SP4) a stored typed literal that is invalid or non-canonical for its datatype reads INVALID, digests matching; CONTROLS: as prepared ok, canonical rewrite ok', T, async () => {
  const a = card('sp4a', 1), b = card('sp4b', 2), c = card('sp4c', 3);
  await world(async ({ client, exec }) => {
    const oa = typedIdent(claimOrigin(a, 'k-sp4a')), ob = typedIdent(claimOrigin(b, 'k-sp4b')), oc = typedIdent(claimOrigin(c, 'k-sp4c'));
    for (const o of [oa, ob, oc]) assert.equal((await client.update(prepareIntention(o))).outcome, 'APPLIED', 'PRECONDITION: the forward path admits a typed xsd:integer identifier');
    const stored = {};
    for (const [o, x] of [[oa, a], [ob, b], [oc, c]]) {
      const r = await M.readPreparedOrigin(client, o.mid);
      assert.equal(r.ok, true, `CONTROL: the Prepared as written reads ok (${JSON.stringify(r).slice(0, 200)})`);
      const q = JSON.parse(r.prepared.planJson).parts[0].quads.filter((t) => t[1] === IDENT);
      assert.deepEqual(q.map((t) => t[2]), [`"${x.shortId}"^^<${XI}>`], 'PRECONDITION: the stored plan holds exactly one canonical typed identifier');
      stored[o.mid] = r.prepared.planJson;
    }
    await replacePlan(exec, oc.mid, withIdent(stored[oc.mid], String(c.shortId)));
    const rc = await M.readPreparedOrigin(client, oc.mid);
    assert.equal(rc.ok, true, `CONTROL: the tamper machinery rewriting the term to its own canonical text still reads ok (${JSON.stringify(rc).slice(0, 200)})`);
    await replacePlan(exec, oa.mid, withIdent(stored[oa.mid], 'oops'));
    await replacePlan(exec, ob.mid, withIdent(stored[ob.mid], `0${b.shortId}`));
    // both cases are read before either is asserted, so a RED reports both
    const ra = await M.readPreparedOrigin(client, oa.mid), rb = await M.readPreparedOrigin(client, ob.mid);
    assert.deepEqual([ra.status ?? (ra.ok ? 'ok' : '?'), rb.status ?? (rb.ok ? 'ok' : '?')], ['INVALID', 'INVALID'],
      `SP4: ["oops"^^xsd:integer, "0${b.shortId}"^^xsd:integer] in a stored plan each read INVALID (got ${JSON.stringify(ra).slice(0, 120)} / ${JSON.stringify(rb).slice(0, 120)})`);
    assert.equal(ra.ok, false); assert.equal(rb.ok, false);
  }, [a, b, c]);
});
