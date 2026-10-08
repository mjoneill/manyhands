/**
 * #1638 — read a node WHOLE (its default-graph triples plus its bookkeeping) WITHOUT losing which graph each part came from.
 *
 * The whole-node pins in the post tests (the exact allow-list of a tombstone, "exactly one recordedBy", "the node carries exactly these triples") speak of the node as a unit. A plain union of the two
 * graphs would let a triple sit in the WRONG graph and still pass. So this reads each graph apart, asserts PLACEMENT first, and only then returns the union:
 *   - no bookkeeping predicate on the node in the DEFAULT graph (it would be publicly queryable), and
 *   - no domain predicate on the node in the bookkeeping graph (it would be hidden from the public dataset).
 * The list of bookkeeping predicates is the build's own single definition (core/graph-vocab.mjs); the node under test is an entity subject, so the predicate decides.
 */
import assert from 'node:assert/strict';
import { BOOKKEEPING_PREDICATES, BOOKKEEPING_GRAPH } from '../../core/graph-vocab.mjs';

const BK_SET = new Set(BOOKKEEPING_PREDICATES.map((p) => String(p).replace(/^<|>$/g, '')));

export async function readNodeWhole(client, iri) {
  const d = await client.query(`SELECT ?p ?o WHERE { <${iri}> ?p ?o }`);
  const b = await client.query(`SELECT ?p ?o WHERE { GRAPH <${BOOKKEEPING_GRAPH}> { <${iri}> ?p ?o } }`);
  assert.equal(d.ok && b.ok, true, `reading <${iri}>: ${JSON.stringify({ d: d.ok, b: b.ok, why: d.reason ?? b.reason })}`);
  const stamped = [...new Set(d.rows.filter((r) => BK_SET.has(r.p.value)).map((r) => r.p.value))];
  assert.deepEqual(stamped, [], `#1638 PLACEMENT: bookkeeping predicate(s) on <${iri}> in the DEFAULT graph (publicly queryable): ${stamped.join(', ')}`);
  const foreign = [...new Set(b.rows.filter((r) => !BK_SET.has(r.p.value)).map((r) => r.p.value))];
  assert.deepEqual(foreign, [], `#1638 PLACEMENT: domain predicate(s) on <${iri}> in the BOOKKEEPING graph (hidden from the public dataset): ${foreign.join(', ')}`);
  return { ok: true, rows: [...d.rows, ...b.rows] };
}
