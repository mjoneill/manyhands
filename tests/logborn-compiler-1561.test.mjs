/**
 * #1561 — the log-born unit's intention kinds, at the compiler and on a REAL
 * executor. Pure checks first (no python); the guard checks need pyoxigraph.
 *
 * What is pinned:
 *   - every record kind compiles to ONE update that the UNCHANGED staticCheck accepts;
 *   - the digest binds the payload (any change moves it; set order does not);
 *   - validation refuses what the payload must not carry;
 *   - hostile text in a literal cannot read as structure, and round-trips exactly;
 *   - the expected-version guard: a stale memory.revise is PRECONDITION_FAILED and
 *     changes NO domain triple; replay is a no-op; a changed intention under the same
 *     opId is an intent-collision;
 *   - referential and one-open-declaration preconditions;
 *   - Person identity effects (the planner's plan.create, a reviewer's contract) ride the
 *     intention's `people` payload: BOUND by the digest, compiled as guarded domain inserts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { compile, staticCheck, ValidationError, digestOf, canonicalize, PERSON_PAYLOAD_FIELDS } from '../core/graph-compiler.mjs';
import { PERSON_NODE_FIELDS } from '../core/graph-people.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { PROJECT_DIR, freePort } from './helpers/harness.mjs';

const M = 'https://scrumboard.local/memory/m1';
const P = (k) => `https://scrumboard.local/person/${k}`;
const D = (k) => `https://scrumboard.local/decision/${k}`;
const SD = (k) => `https://scrumboard.local/entity/seat-state/bob/decl-${k}`;
let n = 0;
const op = () => `urn:ex:op/t1561/${process.pid}/${++n}`;
const actor = 'urn:ex:seat/bob';

const memCreate = (over = {}) => ({
  kind: 'memory.create', opId: op(), actor,
  memory: { iri: M, identifier: 'm1', owner: P('bob'), name: 'title', tags: ['b', 'a'], priority: 'p1', currentVersion: `${M}/v1`, relatedTo: [] },
  versions: [{ iri: `${M}/v1`, version: '1', body: 'first', author: P('bob'), dateCreated: '2026-10-04T00:00:00.000Z' }],
  ...over,
});
const memRevise = (expectedVersion, over = {}) => ({
  kind: 'memory.revise', opId: op(), actor,
  target: { iri: M, expectedVersion },
  set: { name: 'retitled', tags: ['c'], priority: null, currentVersion: `${M}/v2`, relatedTo: [] },
  versions: [{ iri: `${M}/v2`, version: '2', body: 'second', author: P('bob'), dateCreated: '2026-10-04T00:01:00.000Z' }],
  ...over,
});
const decCreate = (k, over = {}) => ({
  kind: 'decision.create', opId: op(), actor,
  decision: { iri: D(k), identifier: k, statement: 's', decidedBy: P('bob'), constrains: ['x'], reopensIf: 'r', dateCreated: '2026-10-04T00:00:00.000Z', supersedes: [], duplicateOf: [], ...over },
});
const declare = (k, ends = null, over = {}) => ({
  kind: 'seat.declare', opId: op(), actor, seat: P('bob'), ends, at: ends ? '2026-10-04T01:00:00.000Z' : null,
  declaration: { iri: SD(k), mode: 'available', acceptsRoutineWork: 'true', constraints: [], declaredAt: '2026-10-04T00:00:00.000Z', ...over },
});

// ── pure ─────────────────────────────────────────────────────────────────────

test('#1561 every record kind compiles to ONE update the unchanged staticCheck accepts; every domain triple is ?d_-guarded', () => {
  const all = [memCreate(), memRevise('1'), decCreate('d1'), { kind: 'decision.relate', opId: op(), actor, target: D('d2'), supersedes: [D('d1')] },
    declare('a'), declare('b', SD('a')), { kind: 'seat.clear', opId: op(), actor, seat: P('bob'), ends: SD('b'), at: '2026-10-04T02:00:00.000Z' }];
  for (const i of all) {
    const { sparql } = compile(i);
    const chk = staticCheck(sparql, i.opId);
    assert.ok(chk.ok, `${i.kind}: ${chk.errors.join('; ')}`);
    const domain = chk.triples.filter((t) => t.cat === 'DOMAIN');
    assert.ok(domain.length > 0, `${i.kind} has domain triples`);
    for (const t of domain) assert.ok([t.s, t.p, t.o].some((x) => x.startsWith('?d_')), `${i.kind}: ${t.s} ${t.p} ${t.o}`);
    assert.equal((sparql.match(/^(DELETE|INSERT) \{$/gm) || []).length, 2, 'one DELETE/INSERT pair: one operation');
  }
});

test('#1561 the digest binds the payload: any field moves it; set order does not', () => {
  const base = memCreate();
  const d0 = digestOf(canonicalize(base));
  const mut = (f) => { const x = structuredClone(base); f(x); return digestOf(canonicalize(x)); };
  assert.notEqual(mut((x) => { x.versions[0].body = 'first!'; }), d0);
  assert.notEqual(mut((x) => { x.memory.tags.push('z'); }), d0);
  assert.notEqual(mut((x) => { x.memory.owner = P('ada'); }), d0);
  assert.notEqual(mut((x) => { x.actor = 'urn:ex:seat/ada'; }), d0);
  assert.equal(mut((x) => { x.memory.tags.reverse(); }), d0, 'tags are a set');
  assert.notEqual(digestOf(canonicalize(memRevise('1'))), digestOf(canonicalize({ ...memRevise('2'), opId: memRevise('1').opId })));
});

test('#1561 validation refuses what a record intention must not carry', () => {
  const bad = [
    memCreate({ extra: 1 }),
    { ...memCreate(), memory: { ...memCreate().memory, owner: 'https://scrumboard.local/person/a b' } },
    { ...memCreate(), versions: [{ ...memCreate().versions[0], body: 42 }] },
    { ...memCreate(), versions: [{ ...memCreate().versions[0], body: 'lone \ud800 surrogate' }] },
    { ...memRevise('x') },
    { kind: 'seat.clear', opId: op(), actor, seat: P('bob'), at: 'now' },
    { kind: 'decision.relate', opId: op(), actor, target: D('a'), supersedes: [D('a')] },
    { kind: 'decision.relate', opId: op(), actor, target: D('a') },
    declare('q', null, { acceptsRoutineWork: true }),
    { ...memCreate(), opId: 'urn:ex:notop/1' },
  ];
  for (const b of bad) assert.throws(() => compile(b), ValidationError, JSON.stringify(b).slice(0, 120));
});

const HOSTILE = 'x; DELETE { ?s ?p ?o } BIND(true AS ?ok) ?d_evil) "q" \\ \\u0041   \u0085 \u0001 \n\r\t é 😀 }';
test('#1561 hostile text compiles: a literal cannot read as structure to the static checker', () => {
  const i = memCreate({ versions: [{ ...memCreate().versions[0], body: HOSTILE }] });
  const { sparql } = compile(i);
  assert.ok(staticCheck(sparql, i.opId).ok);
  assert.equal((sparql.match(/BIND\(true AS \?ok\)/g) || []).length, 1);
});

const person = (k, over = {}) => ({ '@type': 'Person', '@id': P(k), identifier: k, name: k.toUpperCase(), 'scrum:glyph': null, 'scrum:resolved': true, 'scrum:aliases': [], ...over });

test('#1561 Person payload: the digest BINDS it — two intentions identical except their Person effects get different digests', () => {
  const a = memCreate({ people: [person('newbie', { name: 'Newbie' })] });
  const b = { ...structuredClone(a), people: [person('newbie', { name: 'Someone Else' })] };
  const none = { ...structuredClone(a) }; delete none.people;
  assert.notEqual(digestOf(canonicalize(a)), digestOf(canonicalize(b)), 'a different Person name under the same opId moves the digest');
  assert.notEqual(digestOf(canonicalize(a)), digestOf(canonicalize(none)), 'Person effects present vs absent moves the digest');
  assert.notEqual(compile(a).digest, compile(b).digest, 'and compile() reports the bound digest');
  // a Person-less intention keeps the digest it had before Person effects existed (no `people` key in the record)
  assert.equal(digestOf(canonicalize({ ...none, people: [] })), digestOf(canonicalize(none)));
  assert.equal('people' in canonicalize(none).record, false);
  // set order does not move it
  const two = memCreate({ people: [person('b'), person('a', { 'scrum:aliases': ['y', 'x'] })] });
  const swapped = { ...structuredClone(two), people: [person('a', { 'scrum:aliases': ['x', 'y'] }), person('b')] };
  assert.equal(digestOf(canonicalize(two)), digestOf(canonicalize(swapped)));
});

test('#1561 Person payload: compiled as ok-guarded DOMAIN inserts under the UNCHANGED staticCheck, with a not-yet-typed precondition; never a delete', () => {
  for (const i of [memCreate({ people: [person('newbie')] }), memRevise('1', { people: [person('newbie')] }), decCreate('p1', { }),
    { kind: 'person.import', opId: op(), actor, people: [person('a'), person('b', { 'scrum:glyph': '◆', 'scrum:aliases': ['bee'] })] }]) {
    const { sparql } = compile(i);
    const chk = staticCheck(sparql, i.opId);
    assert.ok(chk.ok, `${i.kind}: ${chk.errors.join('; ')}`);
    for (const t of chk.triples.filter((x) => x.block === 'DELETE')) assert.ok(!/person\//.test(t.s), `no Person triple is ever deleted: ${t.s}`);
    for (const p of i.people || []) {
      assert.ok(sparql.includes(`FILTER NOT EXISTS { <${p['@id']}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?xpt }`), `${i.kind}: ${p.identifier} is created only where no typed node is`);
    }
  }
  assert.ok(!compile(memCreate()).sparql.includes('schema.org/Person'), 'no payload, no Person triple');
});

test('#1561 Person payload: validation — the planner whitelist exactly, IRI = base + identifier, no duplicates, person.import non-empty', () => {
  assert.deepEqual([...PERSON_PAYLOAD_FIELDS], [...PERSON_NODE_FIELDS], 'the compiler accepts exactly the planner\'s whitelist');
  const bad = [
    memCreate({ people: [{ ...person('a'), assigned: ['x'] }] }),
    memCreate({ people: [{ ...person('a'), '@id': P('b') }] }),
    memCreate({ people: [{ ...person('a'), '@type': 'Agent' }] }),
    memCreate({ people: [person('a'), person('a', { name: 'other' })] }),
    memCreate({ people: [{ ...person('a'), 'scrum:resolved': 'yes' }] }),
    memCreate({ people: [{ ...person('a'), '@id': 'urn:ex:seat/a' }] }),
    memCreate({ people: {} }),
    { kind: 'person.import', opId: op(), actor, people: [] },
    { kind: 'person.import', opId: op(), actor },
  ];
  for (const b of bad) assert.throws(() => compile(b), ValidationError, String(JSON.stringify(b.people)).slice(0, 120));
});

// ── on a real executor ───────────────────────────────────────────────────────

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
let proc, client, base;
before(async () => {
  if (SKIP) return;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-exec-'));
  const port = await freePort();
  proc = spawn(PY, [path.join(PROJECT_DIR, 'graph-executor', 'executor.py'), '--store', store, '--port', String(port), '--dataset-id', 'lb-1561', '--create', '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = ''; proc.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(); });
    proc.on('exit', (c) => reject(new Error(`executor exited ${c}`)));
  });
  base = `http://127.0.0.1:${port}`;
  client = createGraphClient({ baseUrl: base, expectedDatasetId: 'lb-1561' });
});
after(() => { proc?.kill('SIGKILL'); });

// #1638: ver / recordedBy / entityJson are bookkeeping (named graph), but this fixture still wants them in the "nothing changed"
// comparison, so it reads BOTH graphs (receipts and the marker are excluded by the same filter as before).
const BK = '<urn:scrum:bookkeeping:executor>';
// Each row KEEPS ITS GRAPH ("bk " prefix for the bookkeeping graph), so a triple that moves between graphs is a change.
const DOMAIN_Q = `SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o BIND("" AS ?g) } UNION { GRAPH ${BK} { ?s ?p ?o } BIND("bk " AS ?g) } FILTER(!STRSTARTS(STR(?s), "urn:ex:op/") && ?s != <urn:ex:dataset>) }`;
// and placement is asserted outright on every read: no bookkeeping stamp in the default graph, nothing but stamps in the bookkeeping graph
const STAMPS = ['urn:ex:ver', 'urn:ex:recordedBy', 'urn:ex:retiredBy', 'https://scrumboard.local/ns#entityJson'];
const domain = async () => {
  const rows = (await client.query(DOMAIN_Q)).rows;
  assert.deepEqual(rows.filter((b) => (b.g.value === '') === STAMPS.includes(b.p.value)).map((b) => `${b.g.value}${b.s.value} ${b.p.value}`), [], 'a triple sits in the wrong graph');
  return rows.map((b) => `${b.g.value}${b.s.value} ${b.p.value} ${b.o.value}`).sort();
};
const seq = async () => Number((await (await fetch(`${base}/health`)).json()).commitSeq);
const bkVals = async (s, p) => (await client.query(`SELECT ?o WHERE { GRAPH ${BK} { <${s}> <${p}> ?o } }`)).rows.map((b) => b.o.value).sort();
const vals = async (s, p) => (await client.query(`SELECT ?o WHERE { <${s}> <${p}> ?o }`)).rows.map((b) => b.o.value).sort();

test('#1561 executor: memory.create applies; a replay changes nothing; a changed intention under the same opId is an intent-collision', { skip: SKIP }, async () => {
  const i = memCreate({ versions: [{ ...memCreate().versions[0], body: HOSTILE }] });
  assert.equal((await client.update(i)).outcome, 'APPLIED');
  assert.deepEqual(await vals(`${M}/v1`, 'https://scrumboard.local/ns#body'), [HOSTILE], 'hostile text round-trips byte-exact');
  assert.deepEqual(await bkVals(M, 'urn:ex:ver'), ['1']);
  const s0 = await seq(); const d0 = await domain();
  const again = await client.update(i);
  assert.equal(again.outcome, 'APPLIED', 'the replay reports the recorded outcome');
  assert.equal(await seq(), s0, 'a replay writes nothing, not even the marker');
  assert.deepEqual(await domain(), d0);
  const collide = await client.update({ ...i, versions: [{ ...i.versions[0], body: 'other' }] });
  assert.equal(collide.outcome, 'REJECTED'); assert.equal(collide.reason, 'intent-collision');
});

test('#1561 executor: a STALE memory.revise is PRECONDITION_FAILED and changes no domain triple; the fresh one replaces the mutable state', { skip: SKIP }, async () => {
  const d0 = await domain(); const s0 = await seq();
  const stale = await client.update(memRevise('7'));
  assert.equal(stale.outcome, 'PRECONDITION_FAILED');
  assert.deepEqual(await domain(), d0, 'no domain change');
  assert.equal(await seq(), s0 + 1, 'the PF receipt enters the commit sequence');
  const ok = await client.update(memRevise('1'));
  assert.equal(ok.outcome, 'APPLIED', ok.reason);
  assert.deepEqual(await vals(M, 'https://scrumboard.local/ns#tag'), ['c'], 'tags REPLACED, not added to');
  assert.deepEqual(await vals(M, 'https://schema.org/name'), ['retitled']);
  assert.deepEqual(await vals(M, 'https://scrumboard.local/ns#priority'), [], 'priority unset');
  assert.deepEqual(await bkVals(M, 'urn:ex:ver'), ['2']);
  assert.deepEqual(await vals(`${M}/v1`, 'https://scrumboard.local/ns#body'), [HOSTILE], 'v1 untouched');
  // the SAME expected version again (a writer who read before the last write) is refused
  const late = await client.update(memRevise('1', { set: { name: 'late', tags: [], currentVersion: `${M}/v2` }, versions: [] }));
  assert.equal(late.outcome, 'PRECONDITION_FAILED', 'a title-only write with a stale revision is refused too');
  assert.deepEqual(await vals(M, 'https://schema.org/name'), ['retitled']);
});

test('#1561 executor: decision relations are preconditions (a named decision must exist)', { skip: SKIP }, async () => {
  assert.equal((await client.update(decCreate('e1', { supersedes: [D('nope')] }))).outcome, 'PRECONDITION_FAILED');
  // the refused create's receipt must not make its IRI non-fresh: the corrected create applies
  assert.equal((await client.update(decCreate('e1'))).outcome, 'APPLIED');
  assert.equal((await client.update(decCreate('e2', { supersedes: [D('e1')] }))).outcome, 'APPLIED');
  assert.equal((await client.update({ kind: 'decision.relate', opId: op(), actor, target: D('e1'), duplicateOf: [D('nope')] })).outcome, 'PRECONDITION_FAILED');
  assert.equal((await client.update({ kind: 'decision.relate', opId: op(), actor, target: D('e1'), duplicateOf: [D('e2')] })).outcome, 'APPLIED');
  assert.deepEqual(await vals(D('e1'), 'https://scrumboard.local/ns#duplicateOf'), [D('e2')]);
});

test('#1561 executor: at most ONE open declaration per seat; a clear ends exactly the open one', { skip: SKIP }, async () => {
  assert.equal((await client.update(declare('a'))).outcome, 'APPLIED');
  assert.equal((await client.update(declare('b'))).outcome, 'PRECONDITION_FAILED', 'a second open interval without ending the first');
  assert.equal((await client.update(declare('b', SD('a')))).outcome, 'APPLIED');
  assert.deepEqual(await vals(SD('a'), 'https://scrumboard.local/ns#endedAt'), ['2026-10-04T01:00:00.000Z']);
  assert.equal((await client.update(declare('c', SD('a')))).outcome, 'PRECONDITION_FAILED', 'ending an already-ended one');
  const clr = (ends) => ({ kind: 'seat.clear', opId: op(), actor, seat: P('bob'), ends, at: '2026-10-04T02:00:00.000Z' });
  assert.equal((await client.update(clr(SD('a')))).outcome, 'PRECONDITION_FAILED');
  assert.equal((await client.update(clr(SD('b')))).outcome, 'APPLIED');
  const open = (await client.query('SELECT ?d WHERE { ?d a <https://scrumboard.local/ns#SeatDeclaration> FILTER NOT EXISTS { ?d <https://scrumboard.local/ns#endedAt> ?x } }')).rows;
  assert.equal(open.length, 0);
});

test('#1561 executor: Person effects land on APPLIED and NOWHERE on PRECONDITION_FAILED; a replay with different Person effects is an intent-collision', { skip: SKIP }, async () => {
  const pf = decCreate('h1', { supersedes: [D('missing')] });
  pf.people = [person('hooked')];
  assert.equal((await client.update(pf)).outcome, 'PRECONDITION_FAILED');
  assert.deepEqual(await vals(P('hooked'), 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), [], 'a PF writes the Person nowhere');
  const good = decCreate('h2'); good.people = [person('hooked', { 'scrum:aliases': ['hk'] })];
  assert.equal((await client.update(good)).outcome, 'APPLIED');
  assert.deepEqual(await vals(P('hooked'), 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), ['https://schema.org/Person']);
  assert.deepEqual(await vals(P('hooked'), 'https://schema.org/name'), ['HOOKED']);
  assert.deepEqual(await vals(P('hooked'), 'https://scrumboard.local/ns#resolved'), ['true']);
  assert.deepEqual(await vals(P('hooked'), 'https://scrumboard.local/ns#aliases'), ['hk']);
  assert.deepEqual(await bkVals(P('hooked'), 'urn:ex:recordedBy'), [good.opId]);
  const s0 = await seq();
  const collide = await client.update({ ...good, people: [person('hooked', { name: 'Impostor' })] });
  assert.equal(collide.outcome, 'REJECTED'); assert.equal(collide.reason, 'intent-collision', 'same opId, different Person effects: detected');
  assert.equal(await seq(), s0); assert.deepEqual(await vals(P('hooked'), 'https://schema.org/name'), ['HOOKED']);
});

test('#1561 executor: person.import never overwrites an existing identity (PRECONDITION_FAILED, the canonical node untouched)', { skip: SKIP }, async () => {
  const first = { kind: 'person.import', opId: op(), actor, people: [person('canon', { name: 'Canonical' })] };
  assert.equal((await client.update(first)).outcome, 'APPLIED');
  const d0 = await domain();
  const clobber = { kind: 'person.import', opId: op(), actor, people: [person('canon', { name: 'From a JSON save' }), person('fresh1')] };
  assert.equal((await client.update(clobber)).outcome, 'PRECONDITION_FAILED');
  assert.deepEqual(await domain(), d0, 'nothing of the import landed — not even the fresh one');
  assert.deepEqual(await vals(P('canon'), 'https://schema.org/name'), ['Canonical']);
});
