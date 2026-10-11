/**
 * #1642 apex — a node with many history in-edges (a seat: ~13k `prov:wasAssociatedWith` on the live board) took ~76 s
 * per graph_neighbors call on the executor path, measured on a restored copy. Candidate cause: `history.latest` fetched
 * the LABEL facts of every history subject, in batches of 200, so the reads grew with the node's history.
 *
 * Counted, not timed (a time bound is load-sensitive; a count is not):
 *   H1 EXECUTOR READS  one call on a node with 2,000 history in-edges makes a bounded number of executor queries,
 *                      independent of how many history subjects it has (the batch-per-200 shape made 11+ for this fixture
 *                      and ~66 for a seat)
 *   H2 STORE MATCHES   the in-process path reads only the three time predicates per history subject, the #1484 cost:
 *                      at most 1 + 3 matches per subject, never the 11 label predicates
 *   H3 SAME ANSWER     both drivers give the same history { count, latest } on that node, and latest is the newest time
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oxigraph from 'oxigraph';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HAVE_PY, PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { graphNeighbors, graphNeighborsFromExecutor } from '../core/graph-neighbors.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const PROV = 'http://www.w3.org/ns/prov#';
const SEAT = 'https://scrumboard.local/person/hist1642';
const N = 2000;   // large enough that a batch-per-200 read shows (11+ queries); the fix is independent of N
const at = (k) => new Date(Date.UTC(2026, 9, 1) + k * 60_000).toISOString();   // activity k at minute k: the newest is k = N - 1

const triples = () => {
  const t = [
    `<${SEAT}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Person>`,
    `<${SEAT}> <https://schema.org/name> "hist seat"`,
    `<https://scrumboard.local/entity/c1642> <https://schema.org/author> <${SEAT}>`,
  ];
  for (let k = 0; k < N; k++) {
    const a = `https://scrumboard.local/activity/h1642-${k}`;
    t.push(`<${a}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${PROV}Activity>`, `<${a}> <${PROV}wasAssociatedWith> <${SEAT}>`, `<${a}> <${PROV}startedAtTime> "${at(k)}"`);
  }
  return t;
};

function storeWithCount() {
  const store = new oxigraph.Store();
  store.load(triples().map((x) => `${x} .`).join('\n'), { format: 'application/n-triples' });
  const counted = { matches: 0 };
  const proxy = { match: (...a) => { counted.matches += 1; return store.match(...a); } };
  return { store: proxy, counted };
}

test('H2 STORE MATCHES: the in-process path reads at most 1 + 3 matches per history subject, never the label predicates', () => {
  const { store, counted } = storeWithCount();
  const r = graphNeighbors(store, { node: 'person:hist1642' });
  assert.equal(r.history.count, N, 'CONTROL: the fixture has its history');
  assert.ok(counted.matches <= 50 + 4 * N, `${counted.matches} store matches for ${N} history subjects (bound ${50 + 4 * N}; reading 11 label predicates each would be ~${12 * N})`);
});

test('H1 EXECUTOR READS + H3 SAME ANSWER: a bounded number of executor queries, and the same history as the in-process path', { skip: SKIP }, async () => {
  // seeded as #1642's parity rows seed their probe: the executor stopped, the store written directly, the executor started again
  const storeDir = tmpStore('hist-');
  await killExecutor(await startExecutor({ store: storeDir, datasetId: 'hist-test', create: true }));
  const nt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-nt-')), 'seed.nt');
  fs.writeFileSync(nt, triples().map((t) => `${t} .`).join('\n'));
  const seed = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(storeDir)})\ns.bulk_load(path=${JSON.stringify(nt)}, format=px.RdfFormat.N_TRIPLES)\ns.flush()`]);
  assert.equal(seed.status, 0, `seeded: ${String(seed.stderr)}`);
  const x = await startExecutor({ store: storeDir, datasetId: 'hist-test', create: false });
  try {
    let queries = 0;
    const counting = (...a) => { queries += 1; return fetch(...a); };
    const ex = await graphNeighborsFromExecutor(x.baseUrl, { node: 'person:hist1642' }, { fetchImpl: counting });
    assert.equal(ex.history.count, N, `CONTROL: the executor holds the history (${JSON.stringify(ex.history)})`);
    assert.ok(queries <= 6, `${queries} executor queries for one call on a node with ${N} history subjects (bound 6, independent of history size)`);
    const { store } = storeWithCount();
    const local = graphNeighbors(store, { node: 'person:hist1642' });
    assert.deepEqual(ex.history, local.history, 'the same { count, latest } on both drivers');
    assert.equal(local.history.latest.at, at(N - 1), 'latest is the newest activity time');
  } finally { await killExecutor(x); }
});
