/**
 * #1558 slice — the D2 write compiler and the graph client, against a real
 * executor on a throwaway store. Builder's DEV fixtures (fixture CLASSES only;
 * no sealed G1 values). The pre-registered proofs P1–P8 are a separate run.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, canonTerm, canonicalize, digestOf, staticCheck, ValidationError } from '../core/graph-compiler.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

function start(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ proc: p, ready: JSON.parse(out.split('\n')[0]) }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}

// #1638: bookkeeping (the per-entity ver stamp) lives in the bookkeeping graph; the domain stays in the default graph.
const BK = '<urn:scrum:bookkeeping:executor>';
const SEED = `INSERT DATA {
  <urn:ex:A1> a <urn:ex:Assertion> ; <urn:ex:subject> <urn:ex:topic1> ; <urn:ex:predicate> <urn:ex:policy> ;
    <urn:ex:value> "old" ; <urn:ex:scope> <urn:ex:scopeX> ; <urn:ex:binding> true ; <urn:ex:status> <urn:ex:current> .
  <urn:ex:A2> a <urn:ex:Assertion> ; <urn:ex:subject> <urn:ex:topic1> ; <urn:ex:predicate> <urn:ex:policy> ;
    <urn:ex:value> "old2" ; <urn:ex:scope> <urn:ex:scopeX> ; <urn:ex:binding> true ; <urn:ex:status> <urn:ex:current> .
  GRAPH ${BK} { <urn:ex:A1> <urn:ex:ver> 1 . <urn:ex:A2> <urn:ex:ver> 4 . }
  <urn:ex:G1> a <urn:ex:Grant> ; <urn:ex:grantee> <urn:ex:bob> ; <urn:ex:scope> <urn:ex:scopeX> ; <urn:ex:mayRetire> true ; <urn:ex:active> true ; <urn:ex:rev> 3 .
  <urn:ex:G2> a <urn:ex:Grant> ; <urn:ex:grantee> <urn:ex:carol> ; <urn:ex:scope> <urn:ex:scopeX> ; <urn:ex:mayRetire> false ; <urn:ex:active> true ; <urn:ex:rev> 1 .
  <urn:ex:R1> <urn:ex:rev> 1 .
}`;

let srv, client;
let n = 0;
const fresh = (p) => `urn:ex:${p}/${++n}`;

before(async () => {
  if (SKIP) return;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  srv = await start(['--store', store, '--port', '0', '--dataset-id', 'dev-fixture', '--create']);
  const base = `http://127.0.0.1:${srv.ready.port}`;
  const r = await fetch(`${base}/update`, { method: 'POST', body: SEED, headers: { 'x-op-id': 'urn:ex:op/seed' } });
  assert.equal(r.status, 200);
  client = createGraphClient({ baseUrl: base, expectedDatasetId: 'dev-fixture' });
});
after(() => { srv?.proc.kill('SIGKILL'); });

const correction = (over = {}) => ({
  kind: 'correction',
  opId: fresh('op'),
  actor: 'urn:ex:bob',
  targets: [{ iri: 'urn:ex:A1', expectedVersion: '1' }],
  newAssertion: { iri: fresh('N'), subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value: 'new' }, scope: 'urn:ex:scopeX' },
  authority: { grant: 'urn:ex:G1', grantRev: '3', rule: 'urn:ex:R1', ruleRev: '1' },
  evidence: ['urn:ex:evidence/1'],
  ...over,
});

async function rows(q) { const r = await client.query(q); assert.ok(r.ok, r.reason); return r.rows; }
async function seq() { return (await rows(`SELECT ?s WHERE { GRAPH ${BK} { <urn:ex:dataset> <urn:ex:commitSeq> ?s } }`))[0].s.value; }
// an entity's triples, each read ONLY from the graph it must live in: its bookkeeping stamps (ver, recordedBy, retiredBy,
// entityJson) from the bookkeeping graph, everything else from the default graph. A stamp that landed in the default graph
// (or a domain triple in the bookkeeping graph) is therefore MISSING here, so every `includes` below still checks placement.
const STAMPS = '<urn:ex:ver>, <urn:ex:recordedBy>, <urn:ex:retiredBy>, <https://scrumboard.local/ns#entityJson>';
async function triplesOf(iri) {
  // and NO bookkeeping stamp may remain on it in the default graph, nor a domain triple in the bookkeeping graph
  const stray = await rows(`SELECT ?p ?o WHERE { { <${iri}> ?p ?o FILTER(?p IN (${STAMPS})) } UNION { GRAPH ${BK} { <${iri}> ?p ?o } FILTER(?p NOT IN (${STAMPS})) } }`);
  assert.deepEqual(stray.map((r) => `${r.p.value} ${r.o.value}`), [], `${iri}: a triple sits in the wrong graph`);
  return (await rows(`SELECT ?p ?o WHERE { { <${iri}> ?p ?o FILTER(?p NOT IN (${STAMPS})) } UNION { GRAPH ${BK} { <${iri}> ?p ?o } FILTER(?p IN (${STAMPS})) } }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();
}
// a receipt lives only in the bookkeeping graph
async function receiptOf(iri) {
  return (await rows(`SELECT ?p ?o WHERE { GRAPH ${BK} { <${iri}> ?p ?o } }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();
}
// every quad in the store, both graphs, graph included
async function allQuads() {
  return (await rows('SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }')).map((r) => JSON.stringify([r.g, r.s, r.p, r.o])).sort();
}

// ---------- pure: literals, digest, static checker ----------

test('#1558 literal domain (A5): integer and dateTime canonicalized as strings; unsupported types rejected', () => {
  assert.equal(canonTerm({ type: 'literal', value: '012', datatype: `${XSD}integer` }), `"12"^^<${XSD}integer>`);
  assert.equal(canonTerm({ type: 'literal', value: '-0', datatype: `${XSD}integer` }), `"0"^^<${XSD}integer>`);
  assert.equal(canonTerm({ type: 'literal', value: '90071992547409931', datatype: `${XSD}integer` }), `"90071992547409931"^^<${XSD}integer>`);
  assert.equal(canonTerm({ type: 'literal', value: '2026-10-04T03:00:00.120Z', datatype: `${XSD}dateTime` }), `"2026-10-04T03:00:00.12Z"^^<${XSD}dateTime>`);
  assert.equal(canonTerm({ type: 'literal', value: '2026-10-04T03:00:00.000Z', datatype: `${XSD}dateTime` }), `"2026-10-04T03:00:00Z"^^<${XSD}dateTime>`);
  assert.equal(canonTerm({ type: 'literal', value: 'hej', lang: 'SV' }), '"hej"@sv');
  for (const bad of [
    { type: 'literal', value: '12.50', datatype: `${XSD}decimal` },
    { type: 'literal', value: '1.0E0', datatype: `${XSD}double` },
    { type: 'literal', value: '2026-10-04T03:00:00', datatype: `${XSD}dateTime` },
    { type: 'literal', value: '2026-10-04T03:00:00+02:00', datatype: `${XSD}dateTime` },
    { type: 'literal', value: 12 },
    { type: 'bnode', value: 'b0' },
  ]) assert.throws(() => canonTerm(bad), ValidationError, JSON.stringify(bad));
});

test('#1558 digest: an equivalent spelling digests the same; a changed value or any bound field does not', () => {
  const base = correction({ opId: 'urn:ex:op/d', newAssertion: { iri: 'urn:ex:N/d', subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value: '012', datatype: `${XSD}integer` }, scope: 'urn:ex:scopeX' } });
  const d0 = digestOf(canonicalize(base));
  const same = structuredClone(base); same.newAssertion.value.value = '12';
  assert.equal(digestOf(canonicalize(same)), d0, 'lexical variant of the same value');
  const mutations = [
    (x) => { x.newAssertion.value.value = '13'; },
    (x) => { x.actor = 'urn:ex:carol'; },
    (x) => { x.targets[0].expectedVersion = '2'; },
    (x) => { x.targets[0].iri = 'urn:ex:A2'; },
    (x) => { x.newAssertion.subject = 'urn:ex:topic2'; },
    (x) => { x.newAssertion.predicate = 'urn:ex:p2'; },
    (x) => { x.newAssertion.scope = 'urn:ex:scopeY'; },
    (x) => { x.newAssertion.iri = 'urn:ex:N/other'; },
    (x) => { x.authority.grantRev = '4'; },
    (x) => { x.authority.grant = 'urn:ex:G2'; },
    (x) => { x.authority.ruleRev = '2'; },
    (x) => { x.authority.rule = 'urn:ex:R2'; },
    (x) => { x.evidence = ['urn:ex:evidence/2']; },
    (x) => { x.evidence = []; },
  ];
  for (const m of mutations) {
    const x = structuredClone(base); m(x);
    assert.notEqual(digestOf(canonicalize(x)), d0, m.toString());
  }
});

test('#1558 static checker accepts compiled output and rejects both must-fail controls (P1 shape)', () => {
  const c = correction({ opId: 'urn:ex:op/s', targets: [{ iri: 'urn:ex:A1', expectedVersion: 1 }, { iri: 'urn:ex:A2', expectedVersion: 4 }] });
  const { sparql } = compile(c);
  const ok = staticCheck(sparql, c.opId);
  assert.ok(ok.ok, ok.errors.join('\n'));
  assert.ok(ok.triples.some((t) => t.cat === 'DOMAIN') && ok.triples.some((t) => t.cat === 'RECEIPT') && ok.triples.some((t) => t.cat === 'MARKER'));
  // control 1: one DOMAIN triple without its guard variable
  const unguarded = sparql.replace('  ?d_new <urn:ex:value> ?d_value .', '  <urn:ex:N/x> <urn:ex:value> ?n_actor .');
  assert.notEqual(unguarded, sparql);
  assert.equal(staticCheck(unguarded, c.opId).ok, false);
  // control 2: a DOMAIN triple mislabelled as NEW-OP (on the op subject, carrying only an ?n_ variable)
  const mislabelled = sparql.replace('INSERT {\n', `INSERT {\n  <${c.opId}> <urn:ex:value> ?n_actor .\n`);
  assert.equal(staticCheck(mislabelled, c.opId).ok, false);
  // control 3: a ?d_ variable defined without the ?ok guard
  const looseBind = sparql.replace(/BIND\(IF\(BOUND\(\?ok\), (<urn:ex:N[^>]*>), \?u\) AS \?d_new\)/, 'BIND($1 AS ?d_new)');
  assert.notEqual(looseBind, sparql);
  assert.equal(staticCheck(looseBind, c.opId).ok, false);
});

test('#1558 validation rejects bad intentions before dispatch', () => {
  const bad = [
    (x) => { x.opId = 'urn:other:1'; },
    (x) => { x.targets = []; },
    (x) => { x.targets.push({ ...x.targets[0] }); },
    (x) => { x.newAssertion.iri = x.targets[0].iri; },
    (x) => { x.actor = '_:b0'; },
    (x) => { x.extra = 1; },
    (x) => { x.authority.grantRev = 1.5; },
    (x) => { x.newAssertion.value = { type: 'literal', value: '1.5', datatype: `${XSD}decimal` }; },
  ];
  for (const m of bad) {
    const x = correction(); m(x);
    assert.throws(() => compile(x), ValidationError, m.toString());
  }
});

// ---------- against the executor ----------

test('#1558 authorized correction: APPLIED, target retired with explanation, new assertion current, marker +1', { skip: SKIP }, async () => {
  const s0 = await seq();
  const c = correction();
  const r = await client.update(c);
  assert.equal(r.outcome, 'APPLIED', r.reason);
  assert.equal(Number(await seq()), Number(s0) + 1);
  const a1 = await triplesOf('urn:ex:A1');
  assert.ok(a1.includes('urn:ex:status urn:ex:retired') && a1.includes('urn:ex:ver 2'));
  assert.ok(a1.includes(`urn:ex:retiredBy ${c.opId}`));
  assert.ok(!a1.includes('urn:ex:status urn:ex:current') && !a1.includes('urn:ex:ver 1'));
  const na = await triplesOf(c.newAssertion.iri);
  for (const want of ['urn:ex:status urn:ex:current', 'urn:ex:value new', 'urn:ex:supersedes urn:ex:A1', `urn:ex:recordedBy ${c.opId}`, 'urn:ex:evidence urn:ex:evidence/1', 'urn:ex:author urn:ex:bob', 'urn:ex:ver 1']) {
    assert.ok(na.includes(want), `new assertion missing ${want}`);
  }
  const rec = await receiptOf(c.opId);
  for (const want of ['urn:ex:grant urn:ex:G1', 'urn:ex:grantRev 3', 'urn:ex:rule urn:ex:R1', 'urn:ex:ruleRev 1', 'urn:ex:target urn:ex:A1', 'urn:ex:outcome urn:ex:APPLIED']) {
    assert.ok(rec.includes(want), `receipt missing ${want}`);
  }

  // replay: the recorded outcome, nothing changes at all
  const q0 = await allQuads();
  for (let i = 0; i < 3; i++) assert.equal((await client.update(c)).outcome, 'APPLIED');
  assert.deepEqual(await allQuads(), q0);

  // same opId, changed value → intent collision, nothing changes
  const changed = structuredClone(c); changed.newAssertion.value.value = 'different';
  const rj = await client.update(changed);
  assert.equal(rj.outcome, 'REJECTED');
  assert.equal(rj.reason, 'intent-collision');
  assert.deepEqual(await allQuads(), q0);

  // reconcile reads the stored outcome without writing
  assert.equal((await client.reconcile(c)).outcome, 'APPLIED');
});

async function refusedNoDomainChange(c, label) {
  const q0 = (await allQuads()).filter((q) => !q.includes(c.opId) && !q.includes('urn:ex:dataset'));
  const s0 = Number(await seq());
  const r = await client.update(c);
  assert.equal(r.outcome, 'PRECONDITION_FAILED', `${label}: ${r.outcome} ${r.reason || ''}`);
  const q1 = (await allQuads()).filter((q) => !q.includes(c.opId) && !q.includes('urn:ex:dataset'));
  assert.deepEqual(q1, q0, `${label}: domain changed`);
  assert.equal(Number(await seq()), s0 + 1, `${label}: marker`);
  const q2 = await allQuads();
  assert.equal((await client.update(c)).outcome, 'PRECONDITION_FAILED', `${label}: replay`);
  assert.deepEqual(await allQuads(), q2, `${label}: replay changed the store`);
}

test('#1558 refusals reach the store as PRECONDITION_FAILED: no domain change, one receipt, marker +1, replay inert', { skip: SKIP }, async () => {
  await refusedNoDomainChange(correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '3' }] }), 'stale version');
  await refusedNoDomainChange(correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }], authority: { grant: 'urn:ex:G1', grantRev: '2', rule: 'urn:ex:R1', ruleRev: '1' } }), 'stale grant revision');
  await refusedNoDomainChange(correction({ actor: 'urn:ex:carol', targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }], authority: { grant: 'urn:ex:G2', grantRev: '1', rule: 'urn:ex:R1', ruleRev: '1' } }), 'grant without mayRetire');
  await refusedNoDomainChange(correction({ actor: 'urn:ex:mallory', targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }] }), 'not the grantee');
  await refusedNoDomainChange(correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }], authority: { grant: 'urn:ex:G1', grantRev: '3', rule: 'urn:ex:R1', ruleRev: '9' } }), 'stale rule revision');
  const wrongTopic = correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }] });
  wrongTopic.newAssertion.subject = 'urn:ex:topic2';
  await refusedNoDomainChange(wrongTopic, 'target topic does not match');
  const taken = correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }] });
  taken.newAssertion.iri = 'urn:ex:G1';
  await refusedNoDomainChange(taken, 'new IRI already exists');
});

test('#1558 multi-target: one stale target fails the WHOLE operation; both fresh retires both', { skip: SKIP }, async () => {
  // A2 is at ver 4 and current; make a second current assertion to pair with it
  const mk = correction({ kind: 'assertion', targets: [] });
  mk.newAssertion.value = { type: 'literal', value: 'sibling' };
  assert.equal((await client.update(mk)).outcome, 'APPLIED');
  const B = mk.newAssertion.iri;
  await refusedNoDomainChange(correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }, { iri: B, expectedVersion: '0' }] }), 'one of two stale');
  const both = correction({ targets: [{ iri: 'urn:ex:A2', expectedVersion: '4' }, { iri: B, expectedVersion: '1' }] });
  assert.equal((await client.update(both)).outcome, 'APPLIED');
  for (const t of ['urn:ex:A2', B]) assert.ok((await triplesOf(t)).includes('urn:ex:status urn:ex:retired'), t);
});

test('#1558 a pre-dispatch validation REJECTED writes no receipt and does not move the marker', { skip: SKIP }, async () => {
  const q0 = await allQuads();
  const c = correction(); c.newAssertion.value = { type: 'literal', value: '1.5', datatype: `${XSD}decimal` };
  const r = await client.update(c);
  assert.equal(r.outcome, 'REJECTED');
  assert.match(r.reason, /^validation:/);
  assert.deepEqual(await allQuads(), q0);
});

test('#1558 PINNED: the compiler\'s canonical forms are what the engine stores', { skip: SKIP }, async () => {
  const forms = [
    { type: 'literal', value: '012', datatype: `${XSD}integer` },
    { type: 'literal', value: '-0', datatype: `${XSD}integer` },
    { type: 'literal', value: '1', datatype: `${XSD}boolean` },
    { type: 'literal', value: '2026-10-04T03:00:00.000Z', datatype: `${XSD}dateTime` },
    { type: 'literal', value: '2026-10-04T03:00:00.120Z', datatype: `${XSD}dateTime` },
    { type: 'literal', value: 'Hej', lang: 'SV' },
  ];
  for (const f of forms) {
    const c = correction({ kind: 'assertion', targets: [] });
    c.newAssertion.value = f;
    assert.equal((await client.update(c)).outcome, 'APPLIED');
    const got = (await rows(`SELECT ?v WHERE { <${c.newAssertion.iri}> <urn:ex:value> ?v }`))[0].v;
    const mine = canonTerm(f);
    const stored = got['xml:lang'] ? `${JSON.stringify(got.value)}@${got['xml:lang']}` : `"${got.value}"^^<${got.datatype}>`;
    assert.equal(stored, mine, `engine stored ${stored} for ${JSON.stringify(f)}`);
  }
});

test('#1558 client: executor down → update UNAVAILABLE (never sent), query UNAVAILABLE (never empty)', { skip: SKIP }, async () => {
  // a port that was just bound and released: nothing listens, so the connection is refused
  const net = await import('node:net');
  const free = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const dead = createGraphClient({ baseUrl: `http://127.0.0.1:${free}` });
  assert.equal((await dead.update(correction())).outcome, 'UNAVAILABLE');
  const q = await dead.query('SELECT * WHERE { ?s ?p ?o }');
  assert.equal(q.ok, false);
  assert.equal(q.status, 'UNAVAILABLE');
});

test('#1558 client: malformed or non-SELECT results are UNAVAILABLE, never a partial ok', async () => {
  const fake = (body, status = 200) => createGraphClient({ baseUrl: 'http://x', fetchImpl: async () => ({ status, text: async () => body }) });
  const cases = [
    '{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"uri","value":"a"}}',
    '{"head":{},"boolean":true}',
    '{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"weird","value":"a"}}]}}',
    '{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"uri","value":"a","datatype":"x"}}]}}',
    '{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"literal","value":"a","datatype":"x","xml:lang":"en"}}]}}',
    '{"head":{"vars":["s"]},"results":{"bindings":[{"t":{"type":"uri","value":"a"}}]}}',
    '{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"literal","value":5}}]}}',
  ];
  for (const b of cases) {
    const r = await fake(b).query('SELECT ?s {}');
    assert.equal(r.ok, false, b);
    assert.equal(r.status, 'UNAVAILABLE');
  }
  assert.equal((await fake('{}', 500).query('x')).ok, false);
  assert.equal((await fake('{"head":{"vars":["s"]},"results":{"bindings":[]}}').ask('x')).ok, false);
  const good = await fake('{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"literal","value":"9007199254740993","datatype":"http://www.w3.org/2001/XMLSchema#integer"}}]}}').query('x');
  assert.equal(good.rows[0].s.value, '9007199254740993');
});

test('#1558 client: startup fencing refuses a different dataset identity', { skip: SKIP }, async () => {
  const wrong = createGraphClient({ baseUrl: `http://127.0.0.1:${srv.ready.port}`, expectedDatasetId: 'prod' });
  const r = await wrong.datasetIdentity();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'REFUSED');
  assert.equal((await client.datasetIdentity()).datasetId, 'dev-fixture');
});

test('#1558 non-binding observation: needs no grant; binding vs non-binding digest differently', { skip: SKIP }, async () => {
  const obs = correction({ kind: 'assertion', targets: [], actor: 'urn:ex:nobody' });
  delete obs.authority;
  obs.newAssertion.binding = false;
  const r = await client.update(obs);
  assert.equal(r.outcome, 'APPLIED', r.reason);
  const t = await triplesOf(obs.newAssertion.iri);
  assert.ok(t.includes('urn:ex:binding false') && t.includes('urn:ex:status urn:ex:current'));
  const rec = await receiptOf(obs.opId);
  assert.ok(!rec.some((x) => x.startsWith('urn:ex:grant ')), 'no authority basis is invented on the receipt');
  // a BINDING assertion without an authority is a validation rejection
  const bad = structuredClone(obs); bad.opId = fresh('op'); bad.newAssertion.iri = fresh('N'); bad.newAssertion.binding = true;
  assert.equal((await client.update(bad)).outcome, 'REJECTED');
  const asB = structuredClone(obs); asB.newAssertion.binding = true; asB.authority = { grant: 'urn:ex:G1', grantRev: '3', rule: 'urn:ex:R1', ruleRev: '1' };
  assert.notEqual(digestOf(canonicalize(asB)), digestOf(canonicalize(obs)));
});

test('#1558 grant and rule kinds seed through the compiler, with receipts; a taken IRI is PRECONDITION_FAILED', { skip: SKIP }, async () => {
  const s0 = Number(await seq());
  const g = { kind: 'grant', opId: fresh('op'), actor: 'urn:ex:trial-admin', grant: { iri: fresh('G'), grantee: 'urn:ex:dave', scope: 'urn:ex:scopeX', mayRetire: true, rev: '1' } };
  assert.equal((await client.update(g)).outcome, 'APPLIED');
  const gt = await triplesOf(g.grant.iri);
  for (const want of ['urn:ex:grantee urn:ex:dave', 'urn:ex:mayRetire true', 'urn:ex:active true', 'urn:ex:rev 1', `urn:ex:recordedBy ${g.opId}`]) assert.ok(gt.includes(want), want);
  const rl = { kind: 'rule', opId: fresh('op'), actor: 'urn:ex:trial-admin', rule: { iri: fresh('R') } };
  assert.equal((await client.update(rl)).outcome, 'APPLIED');
  assert.ok((await triplesOf(rl.rule.iri)).includes('urn:ex:rev 1'));
  assert.equal(Number(await seq()), s0 + 2);
  // the seeded grant and rule authorize a binding assertion by dave
  const a = correction({ kind: 'assertion', targets: [], actor: 'urn:ex:dave', authority: { grant: g.grant.iri, grantRev: '1', rule: rl.rule.iri, ruleRev: '1' } });
  assert.equal((await client.update(a)).outcome, 'APPLIED');
  // a grant whose IRI is taken
  const dupG = { ...g, opId: fresh('op') };
  await refusedNoDomainChange(dupG, 'grant IRI taken');
  for (const bad of [
    { ...g, opId: fresh('op'), grant: { ...g.grant, extra: 1 } },
    { kind: 'rule', opId: fresh('op'), actor: 'urn:ex:trial-admin', rule: { iri: 'urn:ex:R/x', rev: '2' } },
    { kind: 'grant', opId: fresh('op'), actor: 'urn:ex:trial-admin', grant: { ...g.grant, mayRetire: 'yes' } },
  ]) assert.equal((await client.update(bad)).outcome, 'REJECTED', JSON.stringify(bad));
});
