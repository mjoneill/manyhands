/**
 * #1751 — the outbox SUMMARY: status counts and the structural audit as a few flat SELECTs over the bookkeeping graph, instead of
 * one readCommittedOrigin per stored origin (~8.5k executor calls a run, ~1.2 M a day, measured 2026-11-09).
 *
 * Run against a REAL executor, with records written straight into the bookkeeping graph. Every failure kind has its own row
 * whose world holds EXACTLY that corruption, and the row must see it non-zero (review post 51946: a clean store cannot tell a
 * working query from a blind one).
 *   S0  CONTROL: a clean world (two origins, three obligations, one pending) has no structural failure; the counts are right;
 *       the one origin with a pending obligation is listed as unsettled and the settled one is not.
 *   S1  orphan: an obligation whose obligationId names no Origin
 *   S2  mismatch: an origin whose slotCount differs from the number of its obligations (non-zero)
 *   S3  missing: an origin with no obligation at all
 *   S4  retired without its DispositionRecord (review post 51944); its control, a retired obligation WITH one, is not flagged
 *   S7  an obligation with NO status, or a status outside pending/published/blocked/retired, is a failure and is not settled
 *       (review post 51949: readCommittedOrigin refuses it, and a settled-looking record must not hide it)
 *   S8  a field with two values on one record (an Origin with two slotCounts; an Obligation with two statuses) is a
 *       cardinality failure, and the record is counted ONCE (review post 51949)
 *   S5  the summary costs a FIXED number of executor queries, not one per origin (the reason for #1751)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let M = null, modErr = null;
try { M = await import(pathToFileURL(path.join(HERE, '..', 'core', 'outbox-summary.mjs')).href); } catch (e) { modErr = e; }
const need = () => assert.ok(M, `core/outbox-summary.mjs does not exist (${modErr?.message?.slice(0, 160)})`);
const T = { skip: HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)', timeout: 120000 };

const DSID = 'ob1751';
const BK = 'urn:scrum:bookkeeping:executor';
const RG = 'urn:ex:postseq/recovery';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
// spelled out here, NOT imported from the build's vocabulary, so a renamed predicate fails the rows instead of following them
const ORI = (n) => `<urn:ex:origin/${n}>`;
const PSQ = (n) => `<urn:ex:postseq/${n}>`;
const int = (n) => `"${n}"^^<${XSD}integer>`;
const str = (s) => JSON.stringify(s);

const originTriples = (m, slotCount) => `${ORI(`origin/${m}`)} a ${ORI('Origin')} ; ${ORI('mutationId')} ${str(m)} ; ${ORI('slotCount')} ${int(slotCount)} .`;
const obligationTriples = (m, slot, status) => `${ORI(`obligation/${m}/${slot}`)} a ${ORI('Obligation')} ; ${ORI('obligationId')} ${str(`${m}:${slot}`)} ; ${ORI('status')} ${str(status)} .`;
const dispositionTriples = (obligationId) => `<urn:ex:test/disposition/${encodeURIComponent(obligationId)}> a ${PSQ('DispositionRecord')} ; ${PSQ('obligationId')} ${str(obligationId)} ; ${PSQ('decision')} "retire-unsent-unknown" ; ${PSQ('obligationStatusAfter')} "retired" .`;

const CLEAN = [originTriples('m-a', 2), obligationTriples('m-a', 'claim', 'published'), obligationTriples('m-a', 'move', 'published'),
  originTriples('m-b', 1), obligationTriples('m-b', 'claim', 'pending')];

const STORES = [];
after(() => { for (const d of STORES) fs.rmSync(d, { recursive: true, force: true }); });
let n = 0;
async function world({ bk = [], rg = [] }, body) {
  need();
  const store = tmpStore('ob1751-'); STORES.push(store); fs.rmSync(store, { recursive: true });
  let exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    const seed = async (graph, triples) => {
      if (!triples.length) return;
      const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/ob1751-${process.pid}-${n++}` }, body: `INSERT DATA { GRAPH <${graph}> { ${triples.join(' ')} } }` });
      assert.equal(r.status, 200, `PRECONDITION: seeded ${graph} (${await r.text()})`);
    };
    await seed(BK, bk);
    if (rg.length) {
      // The recovery graph refuses every /update (HOLD_PROTECTED), as it should. Records go in the way a real one would from
      // outside the HTTP path: stop the executor, write the quads into the store directly, then reopen it.
      killExecutor(exec); await new Promise((r) => setTimeout(r, 300));
      const py = `import pyoxigraph as px, sys\ns = px.Store(sys.argv[1])\ns.update(sys.argv[2])\ns.flush()\n`;
      const w = spawnSync(PY, ['-c', py, store, `INSERT DATA { GRAPH <${RG}> { ${rg.join(' ')} } }`], { encoding: 'utf8' });
      assert.equal(w.status, 0, `PRECONDITION: wrote the recovery graph directly (${w.stderr})`);
      exec = await startExecutor({ store, datasetId: DSID });
    }
    let queries = 0;
    const raw = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'outbox-summary-1751' });
    const client = { ...raw, query: (q) => { queries += 1; return raw.query(q); } };
    await body({ client, queries: () => queries });
  } finally { killExecutor(exec); }
}
const kinds = (s) => Object.fromEntries(Object.entries(s.failures).map(([k, v]) => [k, v.length]));

test('S0 CONTROL: a clean world has no structural failure, right counts, and only the origin with a pending obligation is unsettled', T, async () => {
  await world({ bk: CLEAN }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.deepEqual(kinds(s), { orphan: 0, mismatch: 0, missing: 0, retiredWithoutDisposition: 0, badStatus: 0, cardinality: 0 });
    assert.deepEqual(s.counts, { origins: 2, obligations: 3, byStatus: { pending: 1, published: 2 } });
    assert.deepEqual(s.unsettled, ['m-b']);
  });
});

test('S1 an obligation that names no Origin is an orphan', T, async () => {
  await world({ bk: [...CLEAN, obligationTriples('m-ghost', 'claim', 'published')] }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    assert.deepEqual(s.failures.orphan, [{ obligationId: 'm-ghost:claim', mutationId: 'm-ghost' }]);
    assert.equal(s.failures.mismatch.length + s.failures.missing.length, 0, 'an orphan is not also counted as something else');
  });
});

test('S2 an origin whose slotCount differs from its obligation count is a mismatch', T, async () => {
  await world({ bk: [...CLEAN, originTriples('m-c', 2), obligationTriples('m-c', 'claim', 'published')] }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    assert.deepEqual(s.failures.mismatch, [{ mutationId: 'm-c', slotCount: 2, obligations: 1 }]);
    assert.equal(s.failures.missing.length, 0);
  });
});

test('S3 an origin with no obligation at all is missing', T, async () => {
  await world({ bk: [...CLEAN, originTriples('m-d', 1)] }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    assert.deepEqual(s.failures.missing, [{ mutationId: 'm-d', slotCount: 1 }]);
    assert.equal(s.failures.mismatch.length, 0, 'missing is reported as missing, not as a mismatch of 0');
  });
});

test('S4 a retired obligation with no DispositionRecord is flagged; one WITH its record is not', T, async () => {
  const bk = [...CLEAN, originTriples('m-e', 1), obligationTriples('m-e', 'claim', 'retired'), originTriples('m-f', 1), obligationTriples('m-f', 'claim', 'retired')];
  await world({ bk, rg: [dispositionTriples('m-f:claim')] }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    assert.deepEqual(s.failures.retiredWithoutDisposition, [{ obligationId: 'm-e:claim' }]);
    assert.equal(s.counts.byStatus.retired, 2);
    assert.ok(!s.unsettled.includes('m-e') && !s.unsettled.includes('m-f'), 'retired is settled');
  });
});

test('S7 an obligation with no status, or an unknown one, is a badStatus failure and is never treated as settled', T, async () => {
  const noStatus = `${ORI('obligation/m-g/claim')} a ${ORI('Obligation')} ; ${ORI('obligationId')} ${str('m-g:claim')} .`;
  await world({ bk: [...CLEAN, originTriples('m-g', 1), noStatus, originTriples('m-h', 1), obligationTriples('m-h', 'claim', 'mislaid')] }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    assert.deepEqual(s.failures.badStatus, [{ obligationId: 'm-g:claim', status: null }, { obligationId: 'm-h:claim', status: 'mislaid' }]);
    assert.ok(s.unsettled.includes('m-g') && s.unsettled.includes('m-h'), 'an origin with an unreadable status gets the deep check');
  });
});

test('S8 two values for one field on one record is a cardinality failure, and the record is counted once', T, async () => {
  const twoSlotCounts = `${ORI('origin/m-i')} ${ORI('slotCount')} ${int(2)} .`;   // m-i also gets slotCount 1 below
  const twoStatuses = `${ORI('obligation/m-i/claim')} ${ORI('status')} "pending" .`;   // and its obligation also reads published
  await world({ bk: [...CLEAN, originTriples('m-i', 1), obligationTriples('m-i', 'claim', 'published'), twoSlotCounts, twoStatuses] }, async ({ client }) => {
    const s = await M.outboxSummary(client);
    const fields = s.failures.cardinality.map((x) => `${x.subject.split('/').slice(-2).join('/')} ${x.field} ${x.values.length}`).sort();
    assert.deepEqual(fields, ['m-i/claim status 2', 'origin/m-i slotCount 2']);
    assert.equal(s.counts.origins, 3, 'm-a, m-b and m-i, each once');
    assert.equal(s.counts.obligations, 4, 'the obligation with two statuses is ONE obligation');
    assert.ok(s.unsettled.includes('m-i'), 'an ambiguous record gets the deep check');
  });
});

test('S5 the summary costs a fixed number of executor queries, whatever the number of origins', T, async () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push(originTriples(`m-${i}`, 1), obligationTriples(`m-${i}`, 'claim', 'published'));
  await world({ bk: many }, async ({ client, queries }) => {
    const s = await M.outboxSummary(client);
    assert.equal(s.counts.origins, 40);
    assert.ok(queries() <= 4, `40 origins took ${queries()} queries; the old audit took one validation per origin`);
  });
});

test('S6 an unreadable executor is UNAVAILABLE, never a clean zero', T, async () => {
  need();
  const dead = { query: async () => ({ ok: false, reason: 'transport: ECONNREFUSED' }) };
  const s = await M.outboxSummary(dead);
  assert.equal(s.ok, false);
  assert.equal(s.status, 'UNAVAILABLE');
  assert.equal(s.failures, undefined, 'no failure counts at all, so nothing can read a zero');
});
