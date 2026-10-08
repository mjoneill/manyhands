/**
 * #1561 — Person identities on the log-born unit's graph store (a reviewer's contract,
 * docs/graph-person-retention.md, items 1–4).
 *
 *   UNIT WRITES   a memory owner / version author, a decider or a seat references a
 *                 person but is NOT an identity source (#619 closed set): the planner
 *                 runs on every such write, `plan.create` is empty, nothing is minted,
 *                 and an unresolved reference goes to the audit sink.
 *   IMPORT        the migration makes ONE guarded, receipted person.import of
 *                 `plan.create` (prior = the document's Person nodes, passed
 *                 explicitly), logs unresolvedReferences to its audit surface, never
 *                 rewrites or deletes a canonical identity, verifies both ways, and a
 *                 rerun writes nothing.
 *   SURVIVAL      with the unit ON, a residual JSON save (a card write → saveDomain)
 *                 and an executor restart leave every graph Person identity intact —
 *                 including one the JSON projection never had.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRestServer, freePort, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { IRI } from '../core/graph-replica.mjs';
import {
  createLogbornUnit, planUnitPeople, entitiesOfIntention, memoryCreateIntention, memoryReviseIntention,
  decisionCreateIntention, seatDeclareIntention, Q_PEOPLE,
} from '../core/logborn-unit.mjs';
import { migrate, PEOPLE_OP_PREFIX } from '../scripts/migrate-logborn-1561.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const ACTOR = 'urn:ex:seat/builder';
const TOK = { bob: mintToken() };
const P = (k) => `https://scrumboard.local/person/${k}`;
const person = (k, over = {}) => ({ '@type': 'Person', '@id': P(k), identifier: k, name: k, 'scrum:glyph': null, 'scrum:resolved': true, 'scrum:aliases': [], ...over });
const now = '2026-10-04T00:00:00.000Z';

const memIdentity = (owner) => ({ '@id': 'https://scrumboard.local/memory/u1', '@type': 'scrum:Memory', identifier: 'u1', name: 't', 'scrum:owner': owner, 'scrum:currentVersion': 'https://scrumboard.local/memory/u1/v1' });
const memVersion = (author) => ({ '@id': 'https://scrumboard.local/memory/u1/v1', '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': 'https://scrumboard.local/memory/u1', 'scrum:version': 1, 'scrum:body': 'b', author, dateCreated: now });

// ── the unit's write paths: which can create a Person ──────────────────────────

test('#1561 UNIT: no unit write path mints a Person — owner, version author, decider and seat are references, not sources; unresolved ones are REPORTED', () => {
  const writes = {
    'memory.create': memoryCreateIntention({ actor: 'urn:ex:seat/bob', identity: memIdentity('newbie'), versions: [memVersion('newbie')] }),
    'memory.revise': memoryReviseIntention({ actor: 'urn:ex:seat/bob', identity: memIdentity('newbie'), newVersions: [memVersion('newbie')], expectedRev: 1 }),
    'decision.create': decisionCreateIntention({ actor: 'urn:ex:seat/bob', entity: { '@id': 'https://scrumboard.local/decision/d1', identifier: 'd1', 'scrum:statement': 's', 'scrum:decidedBy': 'newbie', dateCreated: now } }),
    'seat.declare': seatDeclareIntention({ actor: 'urn:ex:seat/bob', seat: 'newbie', decl: { mode: 'available', declaredAt: now }, iri: 'https://scrumboard.local/entity/seat-state/newbie/decl-1' }),
  };
  const expectPred = { 'memory.create': ['author', 'scrum:owner'], 'memory.revise': ['author'], 'decision.create': ['scrum:decidedBy'], 'seat.declare': ['scrum:declaredSeat'] };
  for (const [kind, intention] of Object.entries(writes)) {
    for (const canonicalPeople of [[], [person('bob')]]) {
      const plan = planUnitPeople({ entities: entitiesOfIntention(intention), canonicalPeople });
      assert.deepEqual(plan.people, [], `${kind}: plan.create is empty — the reference is not an identity source`);
      assert.deepEqual(plan.unresolvedReferences.map((u) => u.predicate).sort(), expectPred[kind], `${kind}: the unresolved reference is reported`);
      assert.ok(plan.unresolvedReferences.every((u) => u.identifier === 'newbie' && u.value === P('newbie')));
    }
    // a reference to an EXISTING identity is resolved, not reported
    const resolved = planUnitPeople({ entities: entitiesOfIntention(intention), canonicalPeople: [person('newbie')] });
    assert.deepEqual(resolved, { people: [], unresolvedReferences: [] }, kind);
  }
});

// ── executors ───────────────────────────────────────────────────────────────

async function startExecutor(dsid, store = fs.mkdtempSync(path.join(os.tmpdir(), 'lbp-store-')), create = true) {
  const port = await freePort();
  const proc = spawn(PY, [path.join(PROJECT_DIR, 'graph-executor', 'executor.py'), '--store', store, '--port', String(port), '--dataset-id', dsid, ...(create ? ['--create'] : []), '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve, reject) => {
    let out = ''; proc.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(); });
    proc.on('exit', (c) => reject(new Error(`executor exited ${c}: ${err}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  return { proc, store, url, client: createGraphClient({ baseUrl: url, expectedDatasetId: dsid }), stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); }) };
}
const seqOf = async (url) => Number((await (await fetch(`${url}/health`)).json()).commitSeq);
const rawUpdate = (url, sparql) => fetch(`${url}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/tamper/${Math.random()}` }, body: sparql }).then((r) => r.status);
/** Every triple on every Person node, receipts' recordedBy included: the identity surface, as text. */
// #1638: recordedBy is bookkeeping (named graph), so the surface is the Person nodes' default-graph triples PLUS their bookkeeping triples.
const Q_PEOPLE_BK = 'SELECT ?s ?p ?o WHERE { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Person> . GRAPH <urn:scrum:bookkeeping:executor> { ?s ?p ?o } }';
const personSurface = async (client) => {
  const r = await client.query(Q_PEOPLE);
  assert.ok(r.ok, r.reason);
  const bk = await client.query(Q_PEOPLE_BK);
  assert.ok(bk.ok, bk.reason);
  // no bookkeeping stamp may sit on a Person in the DEFAULT graph at all (consistently wrong placement would pass equality),
  // and each row names its graph so a stamp that MOVED between graphs fails the equality too
  const STAMPS = ['urn:ex:ver', 'urn:ex:recordedBy', 'urn:ex:retiredBy', 'https://scrumboard.local/ns#entityJson'];
  assert.deepEqual(r.rows.filter((b) => STAMPS.includes(b.p.value)).map((b) => `${b.s.value} ${b.p.value}`), [], 'bookkeeping left on a Person in the default graph');
  return [...r.rows.map((b) => `${b.s.value} ${b.p.value} ${b.o.value}`), ...bk.rows.map((b) => `[bk] ${b.s.value} ${b.p.value} ${b.o.value}`)].sort();
};
const isPerson = async (client, k) => (await client.query(`SELECT ?t WHERE { <${P(k)}> a ?t }`)).rows.length > 0;

test('#1561 UNIT on a real executor: a memory owned by someone with no identity mints NOTHING and is reported to the audit sink; a known owner is not', { skip: SKIP }, async () => {
  const ex = await startExecutor('lbp-unit');
  try {
    assert.equal((await ex.client.update({ kind: 'person.import', opId: 'urn:ex:op/test/seed', actor: ACTOR, people: [person('bob')] })).outcome, 'APPLIED');
    const audits = [];
    const unit = createLogbornUnit({ slice: { client: ex.client, fence: async () => null, trialBypass: true }, loadIri: async () => IRI, audit: (e) => audits.push(e) });
    const before = await personSurface(ex.client);
    const r = await unit.write(memoryCreateIntention({ actor: 'urn:ex:seat/bob', identity: memIdentity('newbie'), versions: [memVersion('newbie')] }));
    assert.equal(r.outcome, 'APPLIED', r.reason);
    assert.deepEqual(r.people, []);
    assert.equal(await isPerson(ex.client, 'newbie'), false, 'a memory owner alone does not mint (#619)');
    assert.deepEqual(await personSurface(ex.client), before, 'no Person triple moved');
    assert.equal(audits.length, 1);
    assert.match(audits[0].opId, /^urn:ex:op\/logborn\/memory\//);
    assert.deepEqual(audits[0].unresolvedReferences.map((u) => `${u.predicate} ${u.identifier}`).sort(), ['author newbie', 'scrum:owner newbie']);
    const d = await unit.write(decisionCreateIntention({ actor: 'urn:ex:seat/bob', entity: { '@id': 'https://scrumboard.local/decision/known', identifier: 'known', 'scrum:statement': 's', 'scrum:decidedBy': 'bob', dateCreated: now } }));
    assert.equal(d.outcome, 'APPLIED', d.reason);
    assert.equal(audits.length, 1, 'a reference to a known identity is not an audit entry');
  } finally { await ex.stop(); }
});

// ── the migration's receipted import, and survival ───────────────────────────

const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
let sourceBoard, sourceEvents;
before(async () => {
  if (SKIP) return;
  const off = await startRestServer({ board: makeBoardFixture() });
  try {
    const b = off.baseUrl;
    // identity SOURCES (#619): a card's assignees and its creator
    assert.equal((await api(b, 'POST', '/api/cards', { title: 'sourced', assignees: ['carol', 'erin'], by: 'dave' })).status, 201);
    // references that are NOT sources
    assert.equal((await api(b, 'POST', '/api/memories', { owner: 'nobody', title: 'm', body: 'x', by: 'nobody' })).status, 201);
    assert.equal((await api(b, 'POST', '/api/decisions', { statement: 'S', decidedBy: 'nodecider', constrains: ['t'], reopensIf: 'R' })).status, 201);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbp-src-'));
    sourceBoard = path.join(dir, 'board.json');
    sourceEvents = path.join(dir, 'board-events');
    fs.copyFileSync(off.boardFile, sourceBoard);
    fs.cpSync(off.boardFile.replace(/\.json$/, '-events'), sourceEvents, { recursive: true });
  } finally { await off.stop(); }
});

test('#1561 IMPORT: one receipted person.import of plan.create; unresolved references to the audit surface; canonical identities neither rewritten nor deleted; verified both ways; a rerun writes nothing', { skip: SKIP }, async () => {
  const docPeople = JSON.parse(fs.readFileSync(sourceBoard, 'utf8'))['@graph'].filter((e) => e['@type'] === 'Person').map((e) => e.identifier).sort();
  assert.ok(docPeople.includes('carol') && docPeople.includes('dave'), `the document holds the sourced people: ${docPeople}`);
  assert.ok(!docPeople.includes('nobody') && !docPeople.includes('nodecider'), 'and not the references');

  const ex = await startExecutor('lbp-import');
  try {
    // canonical BEFORE the migration: carol (different metadata than the document) and a departed identity the document never had
    assert.equal((await ex.client.update({ kind: 'person.import', opId: 'urn:ex:op/preexisting/1', actor: ACTOR,
      people: [person('carol', { name: 'Carol Canonical', 'scrum:aliases': ['cc'] }), person('departed', { name: 'Gone From JSON' })] })).outcome, 'APPLIED');
    const s0 = await seqOf(ex.url);

    const dry = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'dry-run' });
    assert.equal(dry.refused, null, JSON.stringify(dry));
    assert.equal(await seqOf(ex.url), s0, 'the dry run wrote nothing');
    assert.ok(dry.people.create >= 2, JSON.stringify(dry.people));

    const audits = [];
    const run = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run', audit: (e) => audits.push(e) });
    assert.equal(run.refused, null, JSON.stringify(run, null, 1));
    assert.ok(run.people.opId.startsWith(PEOPLE_OP_PREFIX));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].opId, run.people.opId); assert.match(audits[0].digest, /^[0-9a-f]{64}$/);
    const unresolved = audits[0].unresolvedReferences.map((u) => `${u.predicate} ${u.identifier}`).sort();
    for (const u of ['author nobody', 'scrum:decidedBy nodecider', 'scrum:owner nobody']) assert.ok(unresolved.includes(u), `${u} in ${unresolved}`);

    // the receipt: ONE op recorded every imported identity
    const rec = await ex.client.query(`SELECT ?s WHERE { GRAPH <urn:scrum:bookkeeping:executor> { ?s <urn:ex:recordedBy> <${run.people.opId}> } }`);
    assert.equal(rec.rows.length, run.people.create);
    const receipt = await ex.client.query(`SELECT ?o WHERE { GRAPH <urn:scrum:bookkeeping:executor> { <${run.people.opId}> <urn:ex:outcome> ?o } }`);
    assert.deepEqual(receipt.rows.map((b) => b.o.value), ['urn:ex:APPLIED']);
    for (const k of ['dave', 'erin']) assert.equal(await isPerson(ex.client, k), true, `${k} imported`);
    for (const k of ['nobody', 'nodecider']) assert.equal(await isPerson(ex.client, k), false, `${k} NOT minted (a reference, not a source)`);
    const name = async (k) => (await ex.client.query(`SELECT ?n WHERE { <${P(k)}> <https://schema.org/name> ?n }`)).rows.map((b) => b.n.value);
    assert.deepEqual(await name('carol'), ['Carol Canonical'], 'canonical wins: not rewritten from the document');
    assert.deepEqual(await name('departed'), ['Gone From JSON'], 'an identity the document omits is not deleted');

    assert.equal((await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' })).refused, null);
    const s1 = await seqOf(ex.url);
    const again = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run', audit: () => {} });
    assert.equal(again.refused, null, JSON.stringify(again));
    assert.equal(again.written, 0); assert.equal(again.people.create, 0); assert.equal(await seqOf(ex.url), s1, 'a rerun writes nothing');

    // both ways: an imported Person LOSES a triple / GAINS one
    assert.equal(await rawUpdate(ex.url, `DELETE DATA { <${P('dave')}> <https://schema.org/name> "dave" }`), 200);
    const lost = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.equal(lost.refused, 'verification failed');
    assert.ok(lost.diffs.some((d) => d.startsWith('person source→target') && d.includes(P('dave'))), lost.diffs.join('\n'));
    assert.equal(await rawUpdate(ex.url, `INSERT DATA { <${P('dave')}> <https://schema.org/name> "dave" }`), 200);
    assert.equal(await rawUpdate(ex.url, `INSERT DATA { <${P('erin')}> <https://scrumboard.local/ns#aliases> "smuggled" }`), 200);
    const gained = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'verify' });
    assert.ok(gained.diffs.some((d) => d.startsWith('person target→source') && d.includes(P('erin'))), gained.diffs.join('\n'));
    assert.ok(!gained.diffs.some((d) => d.startsWith('person source→target')), 'only the reverse direction differs');
  } finally { await ex.stop(); }
});

test('#1561 SURVIVAL: with the unit ON, a residual JSON save and an executor restart leave every graph Person identity intact', { skip: SKIP }, async () => {
  const dsid = 'lbp-survive';
  let ex = await startExecutor(dsid);
  assert.equal((await ex.client.update({ kind: 'person.import', opId: 'urn:ex:op/preexisting/2', actor: ACTOR, people: [person('departed', { name: 'Gone From JSON' })] })).outcome, 'APPLIED');
  const run = await migrate({ board: sourceBoard, events: sourceEvents, client: ex.client, actor: ACTOR, mode: 'run', audit: () => {} });
  assert.equal(run.refused, null, JSON.stringify(run));
  const surface0 = await personSurface(ex.client);
  assert.ok(surface0.some((t) => t.startsWith(P('departed'))) && surface0.some((t) => t.startsWith(P('dave'))));
  await ex.stop();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbp-on-'));
  const boardFile = path.join(dir, 'board.json');
  fs.copyFileSync(sourceBoard, boardFile);
  fs.cpSync(sourceEvents, path.join(dir, 'board-events'), { recursive: true });
  const tok = path.join(dir, 'tokens.json');
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(tok, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  const exUrl = `http://127.0.0.1:${await freePort()}`;
  const on = await startRestServer({ boardFile, env: { SCRUM_GRAPH_EXECUTOR_URL: exUrl, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_TRIAL_EXECUTOR_STORE: ex.store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tok, SCRUM_AUTH: 'required', SCRUM_GRAPH_UNIT_LOGBORN: '1' } });
  const client = createGraphClient({ baseUrl: exUrl, expectedDatasetId: dsid });
  try {
    for (let i = 0; i < 200; i++) { if ((await api(on.baseUrl, 'GET', '/api/trial/counters')).body.executor) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.deepEqual(await personSurface(client), surface0, 'served as migrated');
    // a residual JSON save: a card write, which saves the WHOLE document (its people regenerated without `departed`)
    const c0 = (await api(on.baseUrl, 'GET', '/api/trial/counters')).body.legacy;
    assert.equal((await api(on.baseUrl, 'POST', '/api/cards', { title: 'residual save', assignees: ['zed'], by: 'bob' })).status, 201);
    const c1 = (await api(on.baseUrl, 'GET', '/api/trial/counters')).body.legacy;
    assert.ok(c1.saveDomain > c0.saveDomain, `the card write saved the document (saveDomain ${c0.saveDomain} → ${c1.saveDomain})`);
    const docPeople = JSON.parse(fs.readFileSync(boardFile, 'utf8'))['@graph'].filter((e) => e['@type'] === 'Person').map((e) => e.identifier);
    assert.ok(!docPeople.includes('departed'), 'the JSON projection omits the departed identity');
    // a unit write naming a person with no identity
    assert.equal((await api(on.baseUrl, 'POST', '/api/memories', { owner: 'stranger', title: 't', body: 'b' })).status, 201);
    assert.deepEqual(await personSurface(client), surface0, 'the graph identities are untouched: none deleted, none rewritten, none minted');
  } finally { await on.stop(); }

  ex = await startExecutor(dsid, ex.store, false);   // restart on the same store
  try {
    assert.deepEqual(await personSurface(ex.client), surface0, 'and they survive an executor restart');
  } finally { await ex.stop(); }
});
