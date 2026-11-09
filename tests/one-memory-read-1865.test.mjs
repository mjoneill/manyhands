/**
 * #1865 — reading ONE memory must read ONE memory.
 *
 * qOneMemory and qOneMemoryHistory began `?m … identifier "X" . { BIND(?m AS ?s) } UNION { ?s ofMemory ?m } …`. SPARQL
 * evaluates a group bottom-up, so inside `{ BIND(?m AS ?s) }` ?m is unbound, the BIND binds nothing, and that branch joins
 * with ?s FREE: every Memory and MemoryVersion in the store came back. The callers pick the one they asked for out of the
 * result, so answers were right, but each read cost the whole memory store: 32,737 rows / 15 MB / ~5.3 s on the live store
 * for a memory with ONE version (measured 2026-11-09), and the memory update that reads first lost to the 5 s executor cap.
 *
 * Run against a REAL executor (the defect is the engine's scoping, which no fake reproduces). The world holds TWO memories,
 * so a query that ignores its argument has something to leak.
 *   O1  qOneMemory("mem-a") returns rows ONLY for mem-a and its versions, and still carries mem-a's write revision (the
 *       bookkeeping `ver` union) and NOT mem-b's
 *   O2  qOneMemoryHistory("mem-a") returns rows ONLY for mem-a, its versions and its revision nodes, never mem-b's
 *   O3  CONTROL: the asked-for memory is complete: its identity node and both of its versions are present, in both reads
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HAVE_PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { qOneMemory, qOneMemoryHistory } from '../core/logborn-unit.mjs';

const T = { skip: HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)', timeout: 120000 };
const DSID = 'om1865';
const BK = 'urn:scrum:bookkeeping:executor';
// spelled out, NOT imported from the build's vocabulary, so a renamed term fails the rows instead of following them
const RS = (n) => `<https://scrumboard.local/ns#${n}>`;
const ID = '<https://schema.org/identifier>';
const MEM = (k) => `https://scrumboard.local/memory/${k}`;
const VER = (k, i) => `https://scrumboard.local/memory/${k}/v/${i}`;
const REV = (k, i) => `https://scrumboard.local/memory/${k}/r/${i}`;

const memory = (k, versions) => [
  `<${MEM(k)}> a ${RS('Memory')} ; ${ID} ${JSON.stringify(k)} ; ${RS('title')} ${JSON.stringify(`title of ${k}`)} .`,
  ...Array.from({ length: versions }, (_, i) => `<${VER(k, i + 1)}> a ${RS('MemoryVersion')} ; ${RS('ofMemory')} <${MEM(k)}> ; ${RS('body')} ${JSON.stringify(`${k} v${i + 1}`)} .`),
  `<${REV(k, 1)}> a ${RS('MemoryRevision')} ; ${RS('ofMemory')} <${MEM(k)}> ; ${RS('revision')} 1 .`,
];
const ver = (k, n) => `<${MEM(k)}> <urn:ex:ver> ${n} .`;

const STORES = [];
after(() => { for (const d of STORES) fs.rmSync(d, { recursive: true, force: true }); });
let n = 0;
async function world(body) {
  const store = tmpStore('om1865-'); STORES.push(store); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    const seed = async (data) => {
      const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/om1865-${process.pid}-${n++}` }, body: `INSERT DATA { ${data} }` });
      assert.equal(r.status, 200, `PRECONDITION: seeded (${await r.text()})`);
    };
    await seed([...memory('mem-a', 2), ...memory('mem-b', 1)].join(' '));
    await seed(`GRAPH <${BK}> { ${ver('mem-a', 7)} ${ver('mem-b', 9)} }`);
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'one-memory-read-1865' });
    const select = async (q) => { const r = await client.query(q); assert.ok(r.ok, `query answered (${r.reason})`); return r.rows; };
    await body({ select });
  } finally { killExecutor(exec); }
}
const subjects = (rows) => [...new Set(rows.map((r) => r.s.value))].sort();

test('O1 qOneMemory reads ONLY the memory asked for and its versions, with its own write revision and not the other one\'s', T, async () => {
  await world(async ({ select }) => {
    const rows = await select(qOneMemory('mem-a'));
    assert.deepEqual(subjects(rows), [MEM('mem-a'), VER('mem-a', 1), VER('mem-a', 2)].sort(),
      `a single-memory read returned other memories' rows (${rows.length} rows)`);
    const vers = rows.filter((r) => r.p.value === 'urn:ex:ver').map((r) => `${r.s.value}=${r.o.value}`);
    assert.deepEqual(vers, [`${MEM('mem-a')}=7`], 'the write revision is mem-a\'s, and only mem-a\'s');
  });
});

test('O2 qOneMemoryHistory reads ONLY the memory asked for, its versions and its revision nodes', T, async () => {
  await world(async ({ select }) => {
    const rows = await select(qOneMemoryHistory('mem-a'));
    assert.deepEqual(subjects(rows), [MEM('mem-a'), VER('mem-a', 1), VER('mem-a', 2), REV('mem-a', 1)].sort(),
      `a single-memory history read returned other memories' rows (${rows.length} rows)`);
  });
});

test('O3 CONTROL: the memory asked for is complete in both reads (identity node and both versions)', T, async () => {
  await world(async ({ select }) => {
    for (const q of [qOneMemory('mem-a'), qOneMemoryHistory('mem-a')]) {
      const s = subjects(await select(q));
      for (const want of [MEM('mem-a'), VER('mem-a', 1), VER('mem-a', 2)]) assert.ok(s.includes(want), `missing ${want}`);
    }
  });
});
