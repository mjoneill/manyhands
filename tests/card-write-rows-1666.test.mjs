/**
 * #1666 — a card.write that touches N existing cards must cost rows ADDITIVE in N, never multiplicative. #1638 read each
 * card's bookkeeping in its own top-level OPTIONAL; sibling OPTIONALs join, so the WHERE produced Π(bk triples per card) ×
 * |data branches| solutions — a create with 6 relatedTo inverses evaluated ~250k rows and took the executor past 10 GB.
 * The row: compile a real N-part write, run its WHERE as a COUNT against a real executor, and bound the count by the
 * triples it has to visit. Then the write itself must still apply and replace every part's bookkeeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ACTOR = 'https://scrumboard.local/person/ada';
const BK = '<urn:scrum:bookkeeping:executor>';
let n = 0;
const op = () => `urn:ex:op/card/rows-${process.pid}-${++n}`;
const card = (id, shortId, extra = {}) => ({ id, shortId, title: `card ${shortId}`, description: 'body', column: 'backlog', labels: ['a', 'b'], createdAt: '2026-10-10T15:00:00.000Z', createdBy: 'ada', version: 1, ...extra });
const part = (c, expectedVersion, prior = null) => ({
  iri: cardIriOf(c.id), expectedVersion, version: c.version, quads: cardQuads(c, new Map()), ...(prior ? { prior: priorQuads(prior, new Map()) } : {}), json: JSON.stringify(c),
});
const whereOf = (sparql) => sparql.slice(sparql.indexOf('\nWHERE {') + 1);

test('#1666 card.write: the rows a 6-card update evaluates grow with the cards touched, not as their product', { skip: SKIP }, async () => {
  const x = await startExecutor({ store: tmpStore('rows-'), datasetId: 'rows-test', create: true });
  try {
    const g = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'rows-test', timeoutMs: 30000 });
    const N = 6;
    const olds = Array.from({ length: N }, (_, k) => card(`r${k}`, k + 1));
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: olds.map((c) => part(c, null)) })).outcome, 'APPLIED');
    const news = olds.map((c) => ({ ...c, title: `moved ${c.shortId}`, version: 2 }));
    const intention = { kind: 'card.write', opId: op(), actor: ACTOR, parts: news.map((c, k) => part(c, '1', olds[k])) };

    const visited = await g.query(`SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { GRAPH ${BK} { ?s ?p ?o } } FILTER(STRSTARTS(STR(?s), "https://scrumboard.local/entity/r")) }`);
    assert.ok(visited.ok, visited.reason);
    const triples = Number(visited.rows[0].n.value);
    const counted = await g.query(`SELECT (COUNT(*) AS ?n) ${whereOf(compile(intention).sparql)}`);
    assert.ok(counted.ok, counted.reason);
    const solutions = Number(counted.rows[0].n.value);
    // additive: one row per triple the write deletes (data + prior VALUES + bookkeeping), never their product
    assert.ok(solutions <= 3 * triples, `the update evaluates ${solutions} solutions for ${triples} triples on ${N} cards — a cross product`);

    const r = await g.update(intention);
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    for (const c of news) {
      const bk = await g.query(`SELECT ?p ?o WHERE { GRAPH ${BK} { <${cardIriOf(c.id)}> ?p ?o } }`);
      const vers = bk.rows.filter((row) => row.p.value === 'urn:ex:ver').map((row) => row.o.value);
      assert.deepEqual(vers, ['2'], `${c.id}: the old version stamp is replaced, not added to`);
      assert.equal(bk.rows.filter((row) => row.p.value.endsWith('entityJson')).length, 1, `${c.id}: one entityJson`);
    }
  } finally { await killExecutor(x); }
});
