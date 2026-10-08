/**
 * #1558 resolver repair (the builder, backup for a reviewer) — the resolver against data
 * written by the REAL compiler, not hand-built fixtures. The hand-built suite
 * was green while a compiled plain assertion could never be CURRENT (review 1,
 * R1): its fixture receipts carried ex:target, which the compiler never writes
 * for a plain assertion. Every case here starts from compiled writes; the
 * malformed cases then apply ONE labelled raw write.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';
import { createAuthorityResolver } from '../core/authority-resolver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

const live = [];
after(() => { for (const p of live) p.kill('SIGKILL'); });
async function freshStore() {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  const { proc, port } = await new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'dev-resolver-compiled', '--create'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ proc: p, port: JSON.parse(out.split('\n')[0]).port }); });
    p.on('exit', (c) => reject(new Error(`executor exited ${c}`)));
  });
  live.push(proc);
  const base = `http://127.0.0.1:${port}`;
  const client = createGraphClient({ baseUrl: base });
  const raw = async (body) => { const r = await fetch(`${base}/update`, { method: 'POST', body, headers: { 'x-op-id': 'urn:ex:op/raw-fixture' } }); assert.equal(r.status, 200); };
  const resolver = createAuthorityResolver({ query: client.query });
  const resolve = () => resolver.resolve({ topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX', evaluationTime: '2026-10-04T04:00:00Z' });
  const ok = async (i) => { const r = await client.update(i); assert.equal(r.outcome, 'APPLIED', `${i.opId}: ${r.outcome} ${r.reason ?? ''}`); };
  await ok({ kind: 'rule', opId: 'urn:ex:op/r', actor: 'urn:ex:admin', rule: { iri: 'urn:ex:R' } });
  await ok({ kind: 'grant', opId: 'urn:ex:op/g', actor: 'urn:ex:admin', grant: { iri: 'urn:ex:G', grantee: 'urn:ex:bob', scope: 'urn:ex:scopeX', mayRetire: true, rev: '1' } });
  return { client, raw, resolve, ok };
}
// #1638: bookkeeping (receipts, ver, retiredBy, recordedBy) lives in its own named graph; raw faults on it go there.
const BKG = 'GRAPH <urn:scrum:bookkeeping:executor>';
const A = { grant: 'urn:ex:G', grantRev: '1', rule: 'urn:ex:R', ruleRev: '1' };
const asrt = (iri, value, extra = {}) => ({ kind: 'assertion', opId: `urn:ex:op/${iri.split(':').pop()}`, actor: 'urn:ex:bob',
  newAssertion: { iri, subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value }, scope: 'urn:ex:scopeX' }, authority: A, ...extra });
const correct = (opName, target, ver, iri, value) => ({ kind: 'correction', opId: `urn:ex:op/${opName}`, actor: 'urn:ex:bob', targets: [{ iri: target, expectedVersion: ver }],
  newAssertion: { iri, subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value }, scope: 'urn:ex:scopeX' }, authority: A });

test('#1558 R1: a COMPILED plain binding assertion is CURRENT, with its recorded basis', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'v'));
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
  const ca = env.currentAuthorities[0];
  assert.equal(ca.iri, 'urn:ex:A1');
  assert.equal(ca.recordedBy.iri, 'urn:ex:op/A1');
  assert.equal(ca.recordedBy.outcome, 'APPLIED');
  assert.equal(ca.recordedBy.grant, 'urn:ex:G');
  assert.equal(ca.recordedBy.grantRev, '1');
  assert.equal(ca.recordedBy.ruleRev, '1');
  assert.equal(ca.author, 'urn:ex:bob');
});

test('#1558 a COMPILED correction: CURRENT new value, the retirement explained in the same envelope', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'old'));
  await s.ok(correct('c1', 'urn:ex:A1', '1', 'urn:ex:A2', 'new'));
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
  assert.equal(env.currentAuthorities[0].iri, 'urn:ex:A2');
  assert.equal(env.retirements.length, 1);
  assert.deepEqual([env.retirements[0].target, env.retirements[0].by, env.retirements[0].receipt.iri, env.retirements[0].receipt.grant],
    ['urn:ex:A1', 'urn:ex:A2', 'urn:ex:op/c1', 'urn:ex:G']);
  assert.ok(env.otherAssertions.some((o) => o.iri === 'urn:ex:A1' && o.status === 'retired'));
});

test('#1558 a COMPILED ungranted non-binding observation sits beside the governing assertion; CURRENT stays', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'governing'));
  const obs = asrt('urn:ex:O1', 'newer-observation', { actor: 'urn:ex:nobody' });
  delete obs.authority; obs.newAssertion.binding = false;
  await s.ok(obs);
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
  assert.equal(env.currentAuthorities[0].iri, 'urn:ex:A1');
  const o = env.otherAssertions.find((x) => x.iri === 'urn:ex:O1');
  assert.equal(o.binding, false);
  assert.equal(o.author, 'urn:ex:nobody', 'the observation keeps its author (from its receipt) beside the governing one');
});

test('#1558 R2: an unrelated op carrying a conflicting grant does not touch this topic (the grant join is anchored)', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'v'));
  // another topic, another grant; then give THAT grant a contradictory second scope
  await s.ok({ kind: 'grant', opId: 'urn:ex:op/g2', actor: 'urn:ex:admin', grant: { iri: 'urn:ex:G2', grantee: 'urn:ex:carol', scope: 'urn:ex:scopeZ', rev: '1' } });
  await s.ok({ kind: 'assertion', opId: 'urn:ex:op/Z1', actor: 'urn:ex:carol', newAssertion: { iri: 'urn:ex:Z1', subject: 'urn:ex:topicOther', predicate: 'urn:ex:policy', value: { type: 'literal', value: 'z' }, scope: 'urn:ex:scopeZ' }, authority: { grant: 'urn:ex:G2', grantRev: '1', rule: 'urn:ex:R', ruleRev: '1' } });
  await s.raw('INSERT DATA { <urn:ex:G2> <urn:ex:scope> <urn:ex:scopeQ> }');
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
});

// ONE labelled raw fault on top of compiled data; each must NOT certify CURRENT, and must name why.
const FAULTS = [
  ['F1 grant scope moved after a plain assertion', 'DELETE DATA { <urn:ex:G> <urn:ex:scope> <urn:ex:scopeX> } ; INSERT DATA { <urn:ex:G> <urn:ex:scope> <urn:ex:scopeY> }', /grant-scope-mismatch/],
  ['F2 provenance receipt outcome is PRECONDITION_FAILED', `DELETE DATA { ${BKG} { <urn:ex:op/A1> <urn:ex:outcome> <urn:ex:APPLIED> } } ; INSERT DATA { ${BKG} { <urn:ex:op/A1> <urn:ex:outcome> <urn:ex:PRECONDITION_FAILED> } }`, /receipt-not-applied/],
  ['F3 grantee is not the receipt actor', 'DELETE DATA { <urn:ex:G> <urn:ex:grantee> <urn:ex:bob> } ; INSERT DATA { <urn:ex:G> <urn:ex:grantee> <urn:ex:mallory> }', /grantee-mismatch/],
  ['F4 the only assertion raw-retired with no replacement', 'DELETE DATA { <urn:ex:A1> <urn:ex:status> <urn:ex:current> } ; INSERT DATA { <urn:ex:A1> <urn:ex:status> <urn:ex:retired> }', /retired-without-basis/],
  ['F5 the binding assertion carries an unknown status IRI', 'DELETE DATA { <urn:ex:A1> <urn:ex:status> <urn:ex:current> } ; INSERT DATA { <urn:ex:A1> <urn:ex:status> <urn:ex:bogus> }', /status-invalid/],
  ['F6 the receipt names a grant that does not exist', 'DELETE WHERE { <urn:ex:G> ?p ?o }', /grant-missing/],
  ['F7 the receipt has no grantRev', `DELETE WHERE { ${BKG} { <urn:ex:op/A1> <urn:ex:grantRev> ?o } }`, /missing-receipt-grantRev/],
  ['F8 the receipt has two actors', `INSERT DATA { ${BKG} { <urn:ex:op/A1> <urn:ex:actor> <urn:ex:mallory> } }`, /receipt-actor-conflict/],
  ['F9 the rule the receipt names does not exist', 'DELETE WHERE { <urn:ex:R> ?p ?o }', /rule-missing/],
  ['F10 the receipt itself is gone (recordedBy dangles)', `DELETE WHERE { ${BKG} { <urn:ex:op/A1> ?p ?o } }`, /missing-receipt/],
  ['F11 grant inactive', 'DELETE DATA { <urn:ex:G> <urn:ex:active> true } ; INSERT DATA { <urn:ex:G> <urn:ex:active> false }', /grant-inactive/],
  ['F12 assertion author differs from the receipt actor', 'DELETE DATA { <urn:ex:A1> <urn:ex:author> <urn:ex:bob> } ; INSERT DATA { <urn:ex:A1> <urn:ex:author> <urn:ex:mallory> }', /author-actor-mismatch/],
];
for (const [label, fault, want] of FAULTS) {
  test(`#1558 ${label} → UNRESOLVED (${want.source})`, { skip: SKIP }, async () => {
    const s = await freshStore();
    await s.ok(asrt('urn:ex:A1', 'v'));
    assert.equal((await s.resolve()).status, 'CURRENT', 'twin: the same store before the fault is CURRENT');
    await s.raw(fault);
    const env = await s.resolve();
    assert.equal(env.status, 'UNRESOLVED', `${label}: ${env.status} ${env.reason}`);
    assert.match(env.reason, want);
  });
}

test('#1558 a revision bumped AFTER the receipt does not invalidate it (non-retroactive, a reviewer D1 04:01Z)', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'v'));
  await s.raw('DELETE DATA { <urn:ex:G> <urn:ex:rev> 1 } ; INSERT DATA { <urn:ex:G> <urn:ex:rev> 2 }');
  await s.raw('DELETE DATA { <urn:ex:R> <urn:ex:rev> 1 } ; INSERT DATA { <urn:ex:R> <urn:ex:rev> 2 }');
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
  assert.equal(env.currentAuthorities[0].recordedBy.grantRev, '1', 'the historical basis is what is reported');
});

test('#1558 R2 (cost): the query\'s rows for a topic do not grow with unrelated authorized ops elsewhere in the store', { skip: SKIP }, async () => {
  const { buildAuthorityQuery } = await import('../core/authority-resolver.mjs');
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'v'));
  const q = buildAuthorityQuery({ topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX' });
  const before = (await s.client.query(q)).rows.length;
  for (let i = 0; i < 20; i++) {
    await s.ok({ kind: 'assertion', opId: `urn:ex:op/other${i}`, actor: 'urn:ex:bob', newAssertion: { iri: `urn:ex:other${i}`, subject: `urn:ex:topicOther${i}`, predicate: 'urn:ex:policy', value: { type: 'literal', value: 'o' }, scope: 'urn:ex:scopeX' }, authority: A });
  }
  const afterRows = (await s.client.query(q)).rows.length;
  assert.equal(afterRows, before, `rows for this topic went ${before} → ${afterRows} after 20 unrelated ops`);
});

// ---------- a reviewer review 3 ----------
const correctionFaults = [
  ['retiredBy missing on the retired target', `DELETE WHERE { ${BKG} { <urn:ex:A1> <urn:ex:retiredBy> ?o } }`, /retiredBy-missing/],
  ['retiredBy has a second value', `INSERT DATA { ${BKG} { <urn:ex:A1> <urn:ex:retiredBy> <urn:ex:op/other> } }`, /retiredBy-conflict/],
  ['retiredBy points at another receipt', `DELETE WHERE { ${BKG} { <urn:ex:A1> <urn:ex:retiredBy> ?o } } ; INSERT DATA { ${BKG} { <urn:ex:A1> <urn:ex:retiredBy> <urn:ex:op/other> } }`, /retiredBy-mismatch/],
];
for (const [label, fault, want] of correctionFaults) {
  test(`#1558 review3 #1: ${label} → UNRESOLVED (${want.source})`, { skip: SKIP }, async () => {
    const s = await freshStore();
    await s.ok(asrt('urn:ex:A1', 'old'));
    await s.ok(correct('c1', 'urn:ex:A1', '1', 'urn:ex:A2', 'new'));
    assert.equal((await s.resolve()).status, 'CURRENT', 'twin first');
    await s.raw(fault);
    const env = await s.resolve();
    assert.equal(env.status, 'UNRESOLVED', `${env.status} ${env.reason}`);
    assert.match(env.reason, want);
  });
}

const fieldFaults = [
  ['governing assertion has no author', 'DELETE WHERE { <urn:ex:A1> <urn:ex:author> ?o }', /candidate-malformed:urn:ex:A1:author-missing/],
  ['binding is not a boolean', 'DELETE WHERE { <urn:ex:A1> <urn:ex:binding> ?o } ; INSERT DATA { <urn:ex:A1> <urn:ex:binding> "yes" }', /candidate-malformed:urn:ex:A1:binding-invalid/],
  ['binding missing (would otherwise read as an observation)', 'DELETE WHERE { <urn:ex:A1> <urn:ex:binding> ?o }', /candidate-malformed:urn:ex:A1:binding-missing/],
  ['scope missing (would otherwise read as ineligible)', 'DELETE WHERE { <urn:ex:A1> <urn:ex:scope> ?o }', /candidate-malformed:urn:ex:A1:scope-missing/],
  ['value missing', 'DELETE WHERE { <urn:ex:A1> <urn:ex:value> ?o }', /candidate-malformed:urn:ex:A1:value-missing/],
  ['ver is not an integer', `DELETE WHERE { ${BKG} { <urn:ex:A1> <urn:ex:ver> ?o } } ; INSERT DATA { ${BKG} { <urn:ex:A1> <urn:ex:ver> "one" } }`, /candidate-malformed:urn:ex:A1:ver-invalid/],
  ['a malformed OTHER candidate blocks NO_AUTHORITY too', `DELETE WHERE { <urn:ex:A1> ?p ?o } ; DELETE WHERE { ${BKG} { <urn:ex:A1> ?p ?o } } ; INSERT DATA { <urn:ex:B> a <urn:ex:Assertion> ; <urn:ex:subject> <urn:ex:topic1> }`, /candidate-malformed:urn:ex:B:/],
];
for (const [label, fault, want] of fieldFaults) {
  test(`#1558 review3 #2: ${label} → UNRESOLVED`, { skip: SKIP }, async () => {
    const s = await freshStore();
    await s.ok(asrt('urn:ex:A1', 'v'));
    assert.equal((await s.resolve()).status, 'CURRENT', 'twin first');
    await s.raw(fault);
    const env = await s.resolve();
    assert.equal(env.status, 'UNRESOLVED', `${env.status} ${env.reason}`);
    assert.match(env.reason, want);
  });
}

test('#1558 review3 #3 (E1): CURRENT says WHY it governs, and the newer observation says why it does not', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'governing'));
  const obs = asrt('urn:ex:O1', 'newer', { actor: 'urn:ex:nobody' });
  delete obs.authority; obs.newAssertion.binding = false;
  await s.ok(obs);
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
  assert.match(env.reason, /^governing: urn:ex:A1 is binding and current, recorded by urn:ex:op\/A1 \(APPLIED\) by urn:ex:bob under grant urn:ex:G rev 1 and rule urn:ex:R rev 1/);
  const o = env.otherAssertions.find((x) => x.iri === 'urn:ex:O1');
  assert.match(o.notGoverning, /non-binding observation: it cannot displace binding authority/);
});

test('#1558 review3 #3 (E2): a retired assertion says what retired it and under which grant', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'old'));
  await s.ok(correct('c1', 'urn:ex:A1', '1', 'urn:ex:A2', 'new'));
  const env = await s.resolve();
  const o = env.otherAssertions.find((x) => x.iri === 'urn:ex:A1');
  assert.equal(o.notGoverning, 'retired: superseded by urn:ex:A2 under receipt urn:ex:op/c1 (grant urn:ex:G rev 1)');
});

test('#1558 review3 #4: evidence IRIs reach the envelope for the governing, retired and observation entries', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'old', { evidence: ['urn:ex:ev/1', 'urn:ex:ev/0'] }));
  await s.ok({ ...correct('c1', 'urn:ex:A1', '1', 'urn:ex:A2', 'new'), evidence: ['urn:ex:ev/2'] });
  const obs = asrt('urn:ex:O1', 'seen', { actor: 'urn:ex:nobody', evidence: ['urn:ex:ev/3'] });
  delete obs.authority; obs.newAssertion.binding = false;
  await s.ok(obs);
  const env = await s.resolve();
  assert.equal(env.status, 'CURRENT', env.reason);
  assert.deepEqual(env.currentAuthorities[0].evidence, ['urn:ex:ev/2']);
  assert.deepEqual(env.otherAssertions.find((x) => x.iri === 'urn:ex:A1').evidence, ['urn:ex:ev/0', 'urn:ex:ev/1']);
  assert.deepEqual(env.otherAssertions.find((x) => x.iri === 'urn:ex:O1').evidence, ['urn:ex:ev/3']);
});

// clipped SUPPORTING rows, every candidate id kept: UNAVAILABLE, never a certified answer
for (const [label, drop] of [
  ['the provenance rows', (r) => r.kind?.value !== 'prov'],
  ['the superseded-target rows', (r) => r.kind?.value !== 'sup'],
  ['one candidate-field row (evidence)', (r) => !(r.kind?.value === 'cand' && r.c_evidence)],
]) {
  test(`#1558 review3 coverage: dropping ${label} while keeping every candidate id → UNAVAILABLE incomplete-result`, { skip: SKIP }, async () => {
    const s = await freshStore();
    await s.ok(asrt('urn:ex:A1', 'old', { evidence: ['urn:ex:ev/1'] }));
    await s.ok({ ...correct('c1', 'urn:ex:A1', '1', 'urn:ex:A2', 'new'), evidence: ['urn:ex:ev/2'] });
    const clipped = createAuthorityResolver({ query: async (q) => {
      const r = await s.client.query(q);
      const rows = r.rows.filter(drop);
      assert.ok(rows.length < r.rows.length, 'the clip removed something');
      const ids = (x) => new Set(x.map((b) => b.candidate?.value).filter(Boolean));
      assert.equal(ids(rows).size, ids(r.rows).size, 'every candidate id is still present');
      return { ...r, rows };
    } });
    const env = await clipped.resolve({ topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX', evaluationTime: '2026-10-04T04:00:00Z' });
    assert.equal(env.status, 'UNAVAILABLE', `${env.status} ${env.reason}`);
    assert.match(env.reason, /^incomplete-result: n\w+Triples counted/);
  });
}

test('#1558 review3 coverage: the retiredBy-receipt rows are REDUNDANT in a compiled correction (same receipt as the replacement\'s provenance), so dropping them changes nothing and is correctly NOT incomplete', { skip: SKIP }, async () => {
  const s = await freshStore();
  await s.ok(asrt('urn:ex:A1', 'old'));
  await s.ok(correct('c1', 'urn:ex:A1', '1', 'urn:ex:A2', 'new'));
  const clipped = createAuthorityResolver({ query: async (q) => { const r = await s.client.query(q); return { ...r, rows: r.rows.filter((x) => x.kind?.value !== 'ret') }; } });
  const args = { topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX', evaluationTime: '2026-10-04T04:00:00Z' };
  const full = await s.resolve();
  const cut = await clipped.resolve(args);
  assert.equal(full.status, 'CURRENT');
  assert.deepEqual(cut, full, 'every receipt triple is still carried by the provenance rows, so the coverage counts match and the answer is unchanged');
});

test('#1558/#1559 every envelope says what its status MEANS; NO_AUTHORITY has a reason (G1: the empty reason told the reader nothing)', { skip: SKIP }, async () => {
  const { STATUS_MEANING } = await import('../core/authority-meaning.mjs');
  const s = await freshStore();
  const none = await s.resolve();
  assert.equal(none.status, 'NO_AUTHORITY');
  assert.equal(none.meaning, STATUS_MEANING.NO_AUTHORITY);
  assert.match(none.meaning, /remember is NOT authority/);
  assert.ok(none.reason.length > 0, 'NO_AUTHORITY carries a reason');
  await s.ok(asrt('urn:ex:A1', 'v'));
  assert.equal((await s.resolve()).meaning, STATUS_MEANING.CURRENT);
  const down = createAuthorityResolver({ query: async () => ({ ok: false, status: 'UNAVAILABLE', reason: 'transport: refused' }) });
  const u = await down.resolve({ topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX', evaluationTime: '2026-10-04T04:00:00Z' });
  assert.equal(u.meaning, STATUS_MEANING.UNAVAILABLE);
  assert.match(u.meaning, /do NOT know what governs this/);
  // a resident (G1 N1 residual): the demo stopped the order but still OFFERED the remembered value as a branch
  for (const k of ['NO_AUTHORITY', 'UNAVAILABLE']) {
    assert.match(STATUS_MEANING[k], /do not offer a remembered value as an option to act on/i, `${k} forbids the offered branch`);
    assert.match(STATUS_MEANING[k], /labell?ed as your memory/i, `${k} still allows a labelled memory as context`);
  }
});
