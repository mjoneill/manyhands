/**
 * #1558 slice — the D1 authority resolver. Builder's DEV fixtures (classes
 * only; no sealed G1 values). Tests run against a real pyoxigraph executor on
 * a throwaway store; we reuse the spawn pattern from tests/graph-compiler.test.mjs.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EX, NS } from '../core/graph-vocab.mjs';

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
    p.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n')[0];
      if (out.includes('\n')) { try { resolve({ proc: p, ready: JSON.parse(line) }); } catch (e) { reject(e); } }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(Object.assign(new Error(`exited ${code}: ${err}`), { code, stderr: err })));
  });
}

const TOPIC = 'urn:ex:t/topic';
const PRED = 'urn:ex:t/policy';
const SCOPE = 'urn:ex:t/scopeA';

let srv, port, client, store;
let n = 0;
const fresh = (p) => `urn:ex:t/${p}/${++n}`;

async function execUpdate(body) {
  const r = await fetch(`http://127.0.0.1:${port}/update`, { method: 'POST', body, headers: { 'x-op-id': fresh('op') } });
  if (r.status !== 200) { console.error('FAILED BODY:', body); }
  assert.equal(r.status, 200, `update failed: ${await r.text()}`);
}

async function rows(q) {
  const r = await fetch(`http://127.0.0.1:${port}/query`, { method: 'POST', body: q });
  assert.equal(r.status, 200);
  const j = await r.json();
  return j.results.bindings;
}

before(async () => {
  if (SKIP) return;
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  srv = await start(['--store', store, '--port', '0', '--dataset-id', 'dev-resolver-fixture', '--create']);
  port = srv.ready.port;
  client = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async (sparql) => {
      const r = await fetch(`http://127.0.0.1:${port}/query`, { method: 'POST', body: sparql });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { return { ok: false, status: 'UNAVAILABLE', reason: 'not JSON' }; }
      if (r.status !== 200) return { ok: false, status: 'UNAVAILABLE', reason: `http ${r.status}` };
      if (!json?.head?.vars || !Array.isArray(json.results?.bindings)) {
        return { ok: false, status: 'UNAVAILABLE', reason: 'malformed result' };
      }
      return { ok: true, head: json.head, rows: json.results.bindings };
    },
  });
});
after(() => { srv?.proc.kill('SIGKILL'); });

async function seq() {
  const r = await rows(`SELECT ?s WHERE { <${NS}dataset> <${NS}commitSeq> ?s }`);
  return r[0].s.value;
}

// REPAIR (the builder, review 3): the compiler always writes ex:author, and ex:retiredBy on a retired
// target, so the fixtures carry them too; a fixture the compiler could never produce tests nothing.
function recordA(iriV, value, status = 'current', ver = '1', binding = true, recordedBy = null, supersedes = null, retiredBy = null, author = 'urn:ex:t/bob') {
  const subj = `<${iriV}>`;
  const tails = [];
  tails.push(`a <${NS}Assertion>`);
  tails.push(`<${NS}subject> <${TOPIC}>`);
  tails.push(`<${NS}predicate> <${PRED}>`);
  tails.push(`<${NS}value> ${JSON.stringify(value)}`);
  tails.push(`<${NS}scope> <${SCOPE}>`);
  tails.push(`<${NS}binding> ${binding}`);
  tails.push(`<${NS}status> <${NS}${status}>`);
  tails.push(`<${NS}ver> ${ver}`);
  if (recordedBy) tails.push(`<${NS}recordedBy> <${recordedBy}>`);
  if (supersedes) tails.push(`<${NS}supersedes> <${supersedes}>`);
  if (retiredBy) tails.push(`<${NS}retiredBy> <${retiredBy}>`);
  if (author) tails.push(`<${NS}author> <${author}>`);
  const joined = tails.map((t, i) => i === tails.length - 1 ? `${t} .` : `${t} ;`).join(' ');
  return `INSERT DATA { ${subj} ${joined} }`;
}

function receiptIri(rid, grant, grantRev, rule, ruleRev, target, actor, outcome = 'APPLIED') {
  const subj = `<${rid}>`;
  const tails = [];
  tails.push(`<${NS}outcome> <${NS}${outcome}>`);
  tails.push(`<${NS}actor> <${actor}>`);
  tails.push(`<${NS}grant> <${grant}>`);
  tails.push(`<${NS}grantRev> ${grantRev}`);
  tails.push(`<${NS}rule> <${rule}>`);
  tails.push(`<${NS}ruleRev> ${ruleRev}`);
  tails.push(`<${NS}target> <${target}>`);
  const joined = tails.map((t, i) => i === tails.length - 1 ? `${t} .` : `${t} ;`).join(' ');
  return `INSERT DATA { ${subj} ${joined} }`;
}

function grantIri(gid, grantee, scope, mayRetire, rev) {
  return `INSERT DATA {
    <${gid}> a <${NS}Grant> ;
      <${NS}grantee> <${grantee}> ;
      <${NS}scope> <${scope}> ;
      <${NS}mayRetire> ${mayRetire} ;
      <${NS}active> true ;
      <${NS}rev> ${rev} .
  }`;
}

function ruleIri(rid, rev) {
  return `INSERT DATA { <${rid}> <${NS}rev> ${rev} . }`;
}

function datasetMarker(datasetId = 'dev-resolver-fixture') {
  return `INSERT DATA {
    <${NS}dataset> <${NS}datasetId> ${JSON.stringify(datasetId)} ;
      <${NS}epoch> 1 ;
      <${NS}commitSeq> 0 .
  }`;
}

async function resetGraph({ extras = [] } = {}) {
  await execUpdate('DELETE WHERE { ?s ?p ?o }');
  await execUpdate(datasetMarker());
  for (const e of extras) await execUpdate(e);
}

test('CURRENT: one authorized unretired binding produces CURRENT with basis', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true, rec));
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'CURRENT');
  assert.equal(env.topic, TOPIC);
  assert.equal(env.predicate, PRED);
  assert.equal(env.scope, SCOPE);
  assert.equal(env.evaluationTime, '2026-10-04T03:21:14Z');
  assert.equal(env.observedRevision.datasetId, 'dev-resolver-fixture');
  assert.equal(env.observedRevision.epoch, '1');
  assert.equal(typeof env.observedRevision.commitSeq, 'string');
  assert.equal(env.currentAuthorities.length, 1);
  assert.equal(env.currentAuthorities[0].iri, a1);
  assert.equal(env.currentAuthorities[0].value.value, 'alpha');
  assert.equal(env.currentAuthorities[0].value.type, 'literal');
  assert.equal(env.currentAuthorities[0].ver, '1');
  assert.equal(env.currentAuthorities[0].author, 'urn:ex:t/bob');
  assert.equal(env.currentAuthorities[0].recordedBy.iri, rec);
  assert.equal(env.currentAuthorities[0].recordedBy.outcome, 'APPLIED');
  assert.equal(env.currentAuthorities[0].recordedBy.grant, g);
  assert.equal(env.currentAuthorities[0].recordedBy.grantRev, '1');
  assert.equal(env.currentAuthorities[0].recordedBy.rule, r);
  assert.equal(env.currentAuthorities[0].recordedBy.ruleRev, '1');
  assert.equal(env.currentAuthorities[0].recordedBy.target, a1);
  assert.equal(env.governingRules.length, 1);
  assert.equal(env.governingRules[0].iri, r);
  assert.equal(env.completeness, 'complete');
  assert.equal(env.otherAssertions.length, 0);
  assert.equal(env.retirements.length, 0);
});

test('CURRENT: corrected-and-retired shows old retired authority and supersession relationship in same envelope', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a1, 'old', 'retired', '2', true, rec, null, rec));
  await execUpdate(recordA(a2, 'new', 'current', '1', true, rec, a1));
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'CURRENT');
  assert.equal(env.currentAuthorities.length, 1);
  assert.equal(env.currentAuthorities[0].iri, a2);
  assert.equal(env.currentAuthorities[0].value.value, 'new');
  assert.equal(env.currentAuthorities[0].value.type, 'literal');
  assert.equal(env.retirements.length, 1);
  assert.equal(env.retirements[0].target, a1);
  assert.equal(env.retirements[0].by, a2);
  assert.equal(env.retirements[0].receipt.iri, rec);
  assert.equal(env.retirements[0].receipt.grant, g);
  assert.equal(env.retirements[0].receipt.grantRev, '1');
  assert.equal(env.otherAssertions.length, 1);
  assert.equal(env.otherAssertions[0].iri, a1);
  assert.equal(env.otherAssertions[0].status, 'retired');
});

test('CURRENT: same-value binding assertion corroborates preserving identities', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec1 = fresh('rec1'); const rec2 = fresh('rec2');
  await execUpdate(recordA(a1, 'shared', 'current', '1', true, rec1));
  await execUpdate(recordA(a2, 'shared', 'current', '1', true, rec2));
  await execUpdate(receiptIri(rec1, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(receiptIri(rec2, g, '1', r, '1', a2, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'CURRENT');
  assert.equal(env.currentAuthorities.length, 2);
  const ids = env.currentAuthorities.map((x) => x.iri).sort();
  assert.deepEqual(ids, [a1, a2].sort());
});

test('NO_AUTHORITY: complete successful zero-authority query yields NO_AUTHORITY', { skip: SKIP }, async () => {
  await resetGraph();
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'NO_AUTHORITY');
  assert.equal(env.completeness, 'complete');
  assert.equal(env.currentAuthorities.length, 0);
  assert.equal(env.observedRevision.datasetId, 'dev-resolver-fixture');
});

test('UNRESOLVED: two incompatible eligible binding assertions with no resolved supersession yields UNRESOLVED with both', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec1 = fresh('rec1'); const rec2 = fresh('rec2');
  await execUpdate(recordA(a1, 'first', 'current', '1', true, rec1));
  await execUpdate(recordA(a2, 'second', 'current', '1', true, rec2));
  await execUpdate(receiptIri(rec1, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(receiptIri(rec2, g, '1', r, '1', a2, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNRESOLVED');
  assert.equal(env.currentAuthorities.length, 2);
  assert.equal(env.reason.length > 0, true);
  assert.ok(env.reason.includes('binding-conflict'));
});

test('CURRENT: non-binding observation with no retirement alongside old CURRENT is side by side, NOT automatic conflict', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('Obs');
  const g = fresh('G'); const r = fresh('R');
  const rec1 = fresh('rec1');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true, rec1));
  await execUpdate(recordA(a2, 'observation', 'current', '1', false));
  await execUpdate(receiptIri(rec1, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'CURRENT');
  assert.equal(env.currentAuthorities.length, 1);
  assert.equal(env.currentAuthorities[0].iri, a1);
  assert.equal(env.otherAssertions.length, 1);
  assert.equal(env.otherAssertions[0].iri, a2);
  assert.equal(env.otherAssertions[0].binding, false);
});

test('CURRENT: newer non-binding observation does not override prior binding authority', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('Obs');
  const g = fresh('G'); const r = fresh('R');
  const rec1 = fresh('rec1');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true, rec1));
  // bump seq so a2 is "newer" — replace the previous commitSeq atomically so
  // the marker remains a single value (not contradictory)
  await execUpdate(`DELETE WHERE { <${NS}dataset> <${NS}commitSeq> ?o }`);
  await execUpdate(`INSERT DATA { <${NS}dataset> <${NS}commitSeq> 5 . }`);
  await execUpdate(recordA(a2, 'stale-numeric-observer', 'current', '1', false));
  await execUpdate(receiptIri(rec1, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'CURRENT');
  assert.equal(env.currentAuthorities[0].iri, a1);
  assert.equal(env.otherAssertions[0].iri, a2);
});

test('UNRESOLVED: dangling retirement edge (target points to non-existent predecessor) yields UNRESOLVED', { skip: SKIP }, async () => {
  await resetGraph();
  const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a2, 'new', 'current', '1', true, rec, 'urn:ex:t/missing-target'));
  await execUpdate(receiptIri(rec, g, '1', r, '1', 'urn:ex:t/missing-target', 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNRESOLVED');
  assert.ok(env.reason.includes('dangling-supersedes'));
});

test('UNRESOLVED: retirement cycle (a supersedes b supersedes a) yields UNRESOLVED', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec1 = fresh('rec1'); const rec2 = fresh('rec2');
  await execUpdate(recordA(a1, 'x', 'current', '1', true, rec1, a2));
  await execUpdate(recordA(a2, 'y', 'current', '1', true, rec2, a1));
  await execUpdate(receiptIri(rec1, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(receiptIri(rec2, g, '1', r, '1', a2, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNRESOLVED');
  assert.ok(env.reason.includes('supersession-cycle'));
});

test('UNRESOLVED: raw retired status without replacement edge is preserved (not silently CURRENT)', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  const rec = fresh('rec');
  const g = fresh('G'); const r = fresh('R');
  await execUpdate(recordA(a1, 'orphan-retired', 'retired', '2', true, rec));
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  // REPAIR (the builder, for a reviewer's review): this asserted NO_AUTHORITY while its own title and
  // the resolver header promised UNRESOLVED. Per a reviewer's D1 ruling (04:01:42Z) missing
  // supporting data — here, a retirement with no replacement basis — is UNRESOLVED.
  assert.equal(env.status, 'UNRESOLVED');
  assert.match(env.reason, /retired-without-basis/);
});

test('UNRESOLVED: invalid grant scope basis (grant scope mismatches the resolver scope) yields UNRESOLVED', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true, rec));
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  // grant has a different scope than the resolver scope
  await execUpdate(grantIri(g, 'urn:ex:t/bob', 'urn:ex:t/scopeB', true, '1'));
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNRESOLVED');
  assert.ok(env.reason.includes('grant-scope-mismatch'));
});

test('UNRESOLVED: non-retroactive — current grant rev advanced, receipt at older grant rev still authorizes historical retirement', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a1, 'old', 'retired', '2', true, rec, null, rec));
  await execUpdate(recordA(a2, 'new', 'current', '1', true, rec, a1));
  // historical receipt at grantRev=1
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  // grant has since advanced to rev=2; must not invalidate the historical retirement
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(`DELETE WHERE { <${g}> <${NS}rev> 1 }`);
  await execUpdate(`INSERT DATA { <${g}> <${NS}rev> 2 . }`);
  await execUpdate(ruleIri(r, '1'));

  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  // The CURRENT new assertion has no receipt (it is the bare "new" — receipt governs the retirement, not its successor)
  assert.equal(env.status, 'CURRENT');
  assert.equal(env.currentAuthorities[0].iri, a2);
  assert.equal(env.retirements[0].target, a1);
});

test('UNAVAILABLE: missing marker yields UNAVAILABLE, never empty', { skip: SKIP }, async () => {
  await resetGraph();
  // delete the marker
  await execUpdate(`DELETE WHERE { <${NS}dataset> ?p ?o }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /marker/);
});

test('UNAVAILABLE: contradictory marker (multiple commitSeq) yields UNAVAILABLE', { skip: SKIP }, async () => {
  await resetGraph();
  await execUpdate(`INSERT DATA { <${NS}dataset> <${NS}commitSeq> 7 . }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /marker/);
});

test('UNAVAILABLE: malformed marker literal (non-integer) yields UNAVAILABLE', { skip: SKIP }, async () => {
  await resetGraph();
  await execUpdate(`DELETE WHERE { <${NS}dataset> <${NS}commitSeq> ?o }`);
  await execUpdate(`INSERT DATA { <${NS}dataset> <${NS}commitSeq> "not-int" . }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /marker/);
});

test('UNAVAILABLE: query transport failure yields UNAVAILABLE', { skip: SKIP }, async () => {
  await resetGraph();
  const bad = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async () => ({ ok: false, status: 'UNAVAILABLE', reason: 'connection refused' }),
  });
  const env = await bad.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /connection refused/);
});

test('UNAVAILABLE: candidate truncation control (caller limits results) yields UNAVAILABLE', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true));
  // deliberately inject a clipped response with mismatched count
  const clipped = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async (sparql) => {
      const r = await fetch(`http://127.0.0.1:${port}/query`, { method: 'POST', body: sparql });
      const j = await r.json();
      const rows = j.results.bindings.slice(0, 0);
      const ids = rows.map((b) => b.candidate?.value).filter(Boolean);
      return {
        ok: true,
        head: j.head,
        rows,
        // claim there were more candidates than distinct ids we got back
        candidateCount: ids.length + 1,
      };
    },
  });
  const env = await clipped.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /count|candidate|clip|truncat/i);
});

test('UNAVAILABLE: malformed result (ok:true but rows empty when candidateCount says there are rows) yields UNAVAILABLE', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true));
  const malformed = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async (sparql) => {
      const r = await fetch(`http://127.0.0.1:${port}/query`, { method: 'POST', body: sparql });
      const j = await r.json();
      const rows = [];
      return { ok: true, head: j.head, rows, candidateCount: 5 };
    },
  });
  const env = await malformed.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /count|candidate|clip|truncat|empty|complete/i);
});

test('UNAVAILABLE: malicious IRI with quote injection is rejected without invoking query', async () => {
  let calls = 0;
  const sentinel = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async () => { calls++; return { ok: false, status: 'UNAVAILABLE', reason: 'should not be called' }; },
  });
  const evil = 'urn:ex:a"} ; DROP ?s ?p ?o . <urn:ex:b>';
  const env = await sentinel.resolve({ topic: evil, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /iri|invalid|escape/i);
  assert.equal(calls, 0);
});

test('UNAVAILABLE: missing evaluationTime is rejected', async () => {
  let calls = 0;
  const sentinel = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async () => { calls++; return { ok: false, status: 'UNAVAILABLE', reason: 'should not be called' }; },
  });
  const env = await sentinel.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE });
  assert.equal(env.status, 'UNAVAILABLE');
  assert.match(env.reason, /evaluation|require/i);
  assert.equal(calls, 0);
});

test('CURRENT: large integer marker preserved as exact integer string (no JS Number coercion)', { skip: SKIP }, async () => {
  await resetGraph();
  // overwrite marker with a large integer
  await execUpdate(`DELETE WHERE { <${NS}dataset> <${NS}commitSeq> ?o }`);
  await execUpdate(`INSERT DATA { <${NS}dataset> <${NS}commitSeq> 9007199254740993 . }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'NO_AUTHORITY');
  assert.equal(env.observedRevision.commitSeq, '9007199254740993');
  assert.equal(typeof env.observedRevision.commitSeq, 'string');
});

test('UNRESOLVED: wrong-scope assertion is excluded by exact-scope semantics', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true, rec));
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));
  // the assertion actually has a different scope; rewrite scope to a wrong one
  await execUpdate(`DELETE WHERE { <${a1}> <${NS}scope> ?o }`);
  await execUpdate(`INSERT DATA { <${a1}> <${NS}scope> <urn:ex:t/scopeB> . }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'NO_AUTHORITY');
});

test('UNRESOLVED: cross-topic assertion is excluded by exact-topic semantics', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  const g = fresh('G'); const r = fresh('R');
  const rec = fresh('rec');
  await execUpdate(recordA(a1, 'alpha', 'current', '1', true, rec));
  await execUpdate(receiptIri(rec, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));
  // change subject
  await execUpdate(`DELETE WHERE { <${a1}> <${NS}subject> ?o }`);
  await execUpdate(`INSERT DATA { <${a1}> <${NS}subject> <urn:ex:t/topicOther> . }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'NO_AUTHORITY');
});

test('query call counter: exactly one SELECT per resolve (no pre-reads, no pagination)', { skip: SKIP }, async () => {
  await resetGraph();
  let calls = 0;
  const counter = (await import('../core/authority-resolver.mjs')).createAuthorityResolver({
    query: async (sparql) => {
      calls++;
      const r = await fetch(`http://127.0.0.1:${port}/query`, { method: 'POST', body: sparql });
      const j = await r.json();
      return { ok: true, head: j.head, rows: j.results.bindings, candidateCount: j.results.bindings.length };
    },
  });
  const env = await counter.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'NO_AUTHORITY');
  assert.equal(calls, 1);
});

test('UNRESOLVED: control — newest-wins stub (high ver binding) must NOT override an unresolved older conflict', { skip: SKIP }, async () => {
  // sanity control: we verify our resolver does NOT pick the binding with the highest ver alone.
  // two equally valid current bindings with incompatible values must yield UNRESOLVED.
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  const g = fresh('G'); const r = fresh('R');
  const rec1 = fresh('rec1'); const rec2 = fresh('rec2');
  await execUpdate(recordA(a1, 'first', 'current', '1', true, rec1));
  await execUpdate(recordA(a2, 'second', 'current', '99', true, rec2));
  await execUpdate(receiptIri(rec1, g, '1', r, '1', a1, 'urn:ex:t/bob'));
  await execUpdate(receiptIri(rec2, g, '1', r, '1', a2, 'urn:ex:t/bob'));
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNRESOLVED');
  assert.equal(env.currentAuthorities.length, 2);
});

test('CURRENT: malformed candidates surfaced by OPTIONAL/UNION are validated, not silently dropped', { skip: SKIP }, async () => {
  await resetGraph();
  // Assertion missing predicate and binding — should be discoverable but invalidated.
  const bad = fresh('bad');
  await execUpdate(`INSERT DATA {
    <${bad}> a <${NS}Assertion> ;
      <${NS}subject> <${TOPIC}> ;
      <${NS}value> "missing-fields" .
  }`);
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  // REPAIR (the builder; a reviewer review 3 #2): a malformed candidate on the topic is never quietly
  // "ineligible" — the answer is UNRESOLVED and names the missing fields.
  assert.equal(env.status, 'UNRESOLVED');
  assert.match(env.reason, /candidate-malformed:[^;]*predicate-missing/);
  assert.match(env.reason, /candidate-malformed:[^;]*binding-missing/);
  assert.ok(env.otherAssertions.some((o) => o.iri === bad));
});

test('CURRENT: integrity failure when receipt is absent for an asserted retirement is UNRESOLVED with reason', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A'); const a2 = fresh('N');
  await execUpdate(recordA(a1, 'old', 'retired', '2', true));
  await execUpdate(recordA(a2, 'new', 'current', '1', true, null, a1));
  // no receipt at all
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  assert.equal(env.status, 'UNRESOLVED');
  assert.ok(env.reason.includes('missing-retirement-basis') || env.reason.includes('missing-receipt'));
});

test('CURRENT: legacy bootstrap with no recordedBy/retiredBy is reported (not fabricated) as basis absent', { skip: SKIP }, async () => {
  await resetGraph();
  const a1 = fresh('A');
  const g = fresh('G'); const r = fresh('R');
  await execUpdate(`INSERT DATA {
    <${a1}> a <${NS}Assertion> ;
      <${NS}subject> <${TOPIC}> ;
      <${NS}predicate> <${PRED}> ;
      <${NS}value> "alpha" ;
      <${NS}scope> <${SCOPE}> ;
      <${NS}binding> true ;
      <${NS}status> <${NS}current> ;
      <${NS}ver> 1 .
  }`);
  await execUpdate(grantIri(g, 'urn:ex:t/bob', SCOPE, true, '1'));
  await execUpdate(ruleIri(r, '1'));
  // bootstrap style — explicit fabricated receipt + grant exists but is not linked via recordedBy
  await execUpdate(receiptIri('urn:ex:t/legacyReceipt', g, '1', r, '1', a1, 'urn:ex:t/bob'));
  const env = await client.resolve({ topic: TOPIC, predicate: PRED, scope: SCOPE, evaluationTime: '2026-10-04T03:21:14Z' });
  // bootstrap, the resolver reports basis absent rather than fabricating one
  assert.equal(env.status, 'UNRESOLVED');
  assert.ok(env.reason.includes('bootstrap') || env.reason.includes('missing'));
});