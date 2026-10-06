/**
 * #1582 point 6, THE COMPILER-LAYER ROW: a model call recorded AFTER its post was redacted must not keep the post's text, AND must still be recorded (its cost is the budget's record). The builder's piece 1 (`047db18`) left the
 * "store postedText only where the post is not a RedactedPost" clause to the route; measured with `compiler-layer-probe-p1.mjs`: at the compiler level the late call's text IS stored (holders 0 -> 1). A route that reads
 * "not redacted" and then writes is not atomic with a redaction landing in between, so the card's "a guard in the same update" (point 6; the contract owner, 19:56Z: "put the guard in modelcall.create's update") is pinned HERE,
 * through the real executor and the real graph client, with no route in the way. Written by the separate test author. Synthetic content. Without a python with pyoxigraph the rows are SKIPPED, and a skip is NOT a pass.
 *
 *   R0  CONTROL: a model call recorded BEFORE the redaction, quoting the post, loses its text when the post is redacted, and keeps its cost (already green on `047db18`); the store scan sees the text before.
 *   R1  THE GUARD: a model call recorded AFTER the redaction, carrying the post's text, is APPLIED, keeps its cost, and no triple in the store holds the text.
 *   R2  A CALL FOR A LIVE POST STILL KEEPS ITS TEXT: the guard must not be "never store postedText": a call quoting a post that is NOT redacted keeps it (so R1 cannot pass by dropping the text always).
 *
 * NOT COVERED, by name: the route's own answer to a late call (status and shape, which the card does not fix), a redaction racing the create inside the executor (the guard in the same update is what makes that safe; a race row would be
 * timing-based and flaky, so none is written), `entityJson` (the wire entity as one literal) carrying the text: the rows scan EVERY literal in the store, so a copy hiding there would be caught, but only if the test's `entityJson` holds it, and
 * these rows put it in `postedText` only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphClient } from '../core/graph-client.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'r1-test'; const PERSON = 'https://scrumboard.local/person/'; const NS = 'https://scrumboard.local/ns#'; const ENTITY = 'https://scrumboard.local/entity/';
const iso = () => new Date().toISOString();
let n = 0; const op = (t) => `urn:ex:op/r1/${t}-${process.pid}-${Date.now()}-${++n}`;
const ANY = (pat) => `{ ${pat} } UNION { GRAPH ?g { ${pat} } }`;   // the compiler writes to the DEFAULT graph; a named-graph scope alone reads zero rows
async function world(body) {
  const x = await startExecutor({ store: tmpStore('r1-'), datasetId: DSID, create: true });
  const gc = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID });
  const q = async (sparql) => { const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: sparql }); const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t).results.bindings; };
  const holders = async (needle) => (await q(`SELECT ?s ?p WHERE { ${ANY(`?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)}))`)} }`)).length;
  const costOf = async (id) => (await q(`SELECT ?c WHERE { ${ANY(`<https://scrumboard.local/model-call/${id}> <${NS}cost> ?c`)} }`)).map((b) => b.c.value);
  const importPost = async (id, text) => { const r = await gc.update({ kind: 'post.import', opId: op(`post-${id}`), actor: `${PERSON}board`, post: { id, body: text, author: 'ada', createdAt: iso(), attachedTo: null, mentions: [], postSeq: ++n } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
  const redact = async (id) => { const r = await gc.update({ kind: 'post.redact', opId: op(`red-${id}`), actor: `${PERSON}ada`, post: { id }, authorityRef: 'test', occurredAt: iso() }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
  const call = (id, post, text) => gc.update({ kind: 'modelcall.create', opId: op(`call-${id}`), actor: `${PERSON}ada`, call: { iri: `https://scrumboard.local/model-call/${id}`, agent: 'ada', model: 'm1', calledAt: iso(), cost: '0.25', producedPost: `${ENTITY}${post}`, postedText: text, requestId: `rq-${id}-aaaaaaaa`, entityJson: '{}' } });
  try { return await body({ holders, costOf, importPost, redact, call }); } finally { await killExecutor(x); }
}
const mark = (t) => `raven-slate-${t}-${process.pid}-${Date.now().toString(36)}`;

test('R0 CONTROL: a call recorded before the redaction loses its text and keeps its cost', { skip: SKIP, timeout: 120000 }, async () => {
  await world(async (w) => {
    const M = mark('r0'); await w.importPost('r0-post', `body ${M}`);
    assert.equal((await w.call('r0-c1', 'r0-post', `body ${M}`)).outcome, 'APPLIED');
    assert.equal(await w.holders(M), 2, 'CONTROL: before the redaction the text is in the post and in the call (the scan can see it)');
    await w.redact('r0-post');
    assert.equal(await w.holders(M), 0, 'after the redaction no triple holds the text');
    assert.deepEqual(await w.costOf('r0-c1'), ['0.25'], 'and the call keeps its cost');
  });
});

test('R1 THE GUARD: a call recorded AFTER the redaction is applied, keeps its cost, and no triple holds the text', { skip: SKIP, timeout: 120000 }, async () => {
  await world(async (w) => {
    const M = mark('r1'); await w.importPost('r1-post', `body ${M}`);
    await w.redact('r1-post');
    assert.equal(await w.holders(M), 0, 'CONTROL: the redaction took the text from the store');
    const late = await w.call('r1-late', 'r1-post', `body ${M}`);
    assert.equal(late.outcome, 'APPLIED', `the late call is recorded (its cost is the budget's record): ${JSON.stringify(late).slice(0, 200)}`);
    assert.deepEqual(await w.costOf('r1-late'), ['0.25'], 'and keeps its cost');
    assert.equal(await w.holders(M), 0, 'but the redacted post\'s text did not come back through the model-call row');
  });
});

test('R2 A CALL FOR A LIVE POST STILL KEEPS ITS TEXT: the guard is "not redacted", not "never"', { skip: SKIP, timeout: 120000 }, async () => {
  await world(async (w) => {
    const M = mark('r2'); await w.importPost('r2-post', `body ${M}`);
    assert.equal((await w.call('r2-c1', 'r2-post', `body ${M}`)).outcome, 'APPLIED');
    assert.equal(await w.holders(M), 2, 'a call quoting a post that is not redacted keeps its text (post and call)');
  });
});
