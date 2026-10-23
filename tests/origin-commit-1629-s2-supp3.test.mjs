/**
 * #1629 slice 2 — THIRD SUPPLEMENTAL row, for the contract owner's re-review of 4ce40c6e (card v132): the reader re-admits a stored plan
 * whose JSON fields are in a NON-CANONICAL ORDER, because the validator returns its input unchanged and the byte check then compares the
 * input with itself. TEST AUTHOR's, written after the pinned set (rows, supp, supp2, golden: all unchanged) and before the correction.
 *
 *   SP5  a Prepared whose stored planJson carries the same plan with (a) the ROOT keys reordered (counter before parts) or (b) one PART's
 *        keys reordered (reversed), planDigest recomputed over the reordered bytes, reads INVALID.
 *        CONTROL: the same tamper machinery writing the plan back in its own canonical bytes, digest recomputed, still reads ok.
 *        A RED at 4ce40c6e (both cases read ok) is itself the evidence that the recomputed digest matched — had it not, the digest check
 *        would already have refused them.
 *
 * NOT covered: key order inside quads/collections/unique entries, whitespace or escaping differences in the JSON text.
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

const reorder = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

test('#1629 s2 (SP5) a stored plan whose root or part keys are out of canonical order reads INVALID, digest matching; CONTROL: canonical rewrite ok', T, async () => {
  const a = card('sp5a', 1), b = card('sp5b', 2), c = card('sp5c', 3);
  await world(async ({ client, exec }) => {
    const oa = claimOrigin(a, 'k-sp5a'), ob = claimOrigin(b, 'k-sp5b'), oc = claimOrigin(c, 'k-sp5c');
    for (const o of [oa, ob, oc]) assert.equal((await client.update(prepareIntention(o))).outcome, 'APPLIED', 'PRECONDITION: prepared');
    const stored = {};
    for (const o of [oa, ob, oc]) {
      const r = await M.readPreparedOrigin(client, o.mid);
      assert.equal(r.ok, true, `CONTROL: the Prepared as written reads ok (${JSON.stringify(r).slice(0, 200)})`);
      stored[o.mid] = r.prepared.planJson;
    }
    const rootKeys = Object.keys(JSON.parse(stored[oa.mid]));
    assert.deepEqual(rootKeys.slice(0, 2), ['parts', 'counter'], 'PRECONDITION: the canonical root order begins parts, counter');
    const partKeys = Object.keys(JSON.parse(stored[ob.mid]).parts[0]);
    assert.ok(partKeys.length > 1, 'PRECONDITION: a part has more than one key');
    // CONTROL: rewrite through the same machinery, bytes unchanged
    const same = JSON.stringify(JSON.parse(stored[oc.mid]));
    assert.equal(same, stored[oc.mid], 'PRECONDITION: parse+stringify reproduces the stored bytes');
    await replacePlan(exec, oc.mid, same);
    const rc = await M.readPreparedOrigin(client, oc.mid);
    assert.equal(rc.ok, true, `CONTROL: the tamper machinery writing the canonical bytes back still reads ok (${JSON.stringify(rc).slice(0, 200)})`);
    // (a) root keys: counter first
    const pa = JSON.parse(stored[oa.mid]);
    const rootSwapped = JSON.stringify(reorder(pa, ['counter', 'parts', ...rootKeys.slice(2)]));
    assert.notEqual(rootSwapped, stored[oa.mid], 'PRECONDITION: the root tamper changed the bytes');
    assert.deepEqual(JSON.parse(rootSwapped), pa, 'PRECONDITION: the root tamper is the same plan');
    await replacePlan(exec, oa.mid, rootSwapped);
    // (b) one part's keys reversed
    const pb = JSON.parse(stored[ob.mid]);
    const nested = JSON.stringify({ ...pb, parts: [reorder(pb.parts[0], [...partKeys].reverse()), ...pb.parts.slice(1)] });
    assert.notEqual(nested, stored[ob.mid], 'PRECONDITION: the part tamper changed the bytes');
    assert.deepEqual(JSON.parse(nested), pb, 'PRECONDITION: the part tamper is the same plan');
    await replacePlan(exec, ob.mid, nested);
    // both read before either is asserted, so a RED reports both
    const ra = await M.readPreparedOrigin(client, oa.mid), rb = await M.readPreparedOrigin(client, ob.mid);
    assert.deepEqual([ra.status ?? (ra.ok ? 'ok' : '?'), rb.status ?? (rb.ok ? 'ok' : '?')], ['INVALID', 'INVALID'],
      `SP5: [root keys reordered, part keys reordered] each read INVALID (got ${JSON.stringify(ra).slice(0, 120)} / ${JSON.stringify(rb).slice(0, 120)})`);
    assert.equal(ra.ok, false); assert.equal(rb.ok, false);
  }, [a, b, c]);
});
