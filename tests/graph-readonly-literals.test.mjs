/**
 * #899 — the READ-ONLY guard reads string LITERALS as verbs, so the board's own
 * event vocabulary is unqueryable in its own provenance log.
 *
 * ⛔ MEASURED, and it is one character:
 *
 *     SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity ; scrum:op "creat"  }   → runs
 *     SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity ; scrum:op "create" }   → 400 READ-ONLY
 *
 * The guard tests `/\b(INSERT|DELETE|…|CREATE|MOVE|…)\b/i` against the query
 * with IRIs stripped — `<…>` is removed, quoted literals are not. So a literal
 * containing a keyword is indistinguishable from the keyword.
 *
 * ⚠️ AND THE COLLISION IS WITH OUR OWN DATA, not with some unlucky word. The
 * event log's `op` values are create · update · delete · move · post · claim ·
 * release. **Three of the seven are SPARQL UPDATE keywords**, so "what was
 * created today", "what was deleted", and "what moved" — the three most obvious
 * questions to ask a provenance log — are all refused.
 *
 * ⇒ A false positive in a guard that exists to protect the graph, whose effect
 *   is to push a caller off the graph and back to REST. That is the dogfooding
 *   failure the room has been chasing all week, living inside the rail meant to
 *   defend against it.
 *
 * ── WHY LOOSENING THIS IS SAFE ──────────────────────────────────────────────
 *
 * The refusal is a COURTESY, not the boundary. The module's own docstring says
 * the shape is "enforced structurally (query(), never update())" — oxigraph's
 * `query()` cannot execute an update no matter what string reaches it. This
 * regex exists to return a clear sentence instead of a parser error.
 *
 * ⭐ So the cost of a false NEGATIVE here is a worse error message, while the
 * cost of a false POSITIVE is a legitimate question the graph refuses to answer.
 * The asymmetry says: strip literals, and let the engine be the boundary it
 * already is. A test below drives a real UPDATE through `queryGraph` to prove
 * the structural half rather than trusting the comment — the room has been
 * bitten twice today by a sentence asserting a runtime property.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph } from '../core/graph-replica.mjs';

const store = () => buildGraphStore({ '@graph': [] });
const refused = (q) => {
  try { queryGraph(store(), q); return false; } catch (e) { return e?.code === 'READ_ONLY'; }
};

test('#899 ⛔ the board\'s own op values are queryable — create · delete · move', () => {
  for (const op of ['create', 'delete', 'move', 'update', 'post', 'claim', 'release']) {
    const q = `SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity ; scrum:op "${op}" }`;
    assert.equal(refused(q), false,
      `a SELECT asking for op "${op}" was refused as a write — the guard cannot tell a literal from a verb`);
  }
});

test('#899 the one-character reproduction, kept as the regression', () => {
  assert.equal(refused('SELECT ?n WHERE { ?a scrum:op "creat" }'), false, 'control: without the "e" it always ran');
  assert.equal(refused('SELECT ?n WHERE { ?a scrum:op "create" }'), false, 'and now the real word runs too');
});

test('#899 ⭐ A REAL UPDATE IS STILL REFUSED — the loosening must not open the door', () => {
  // ⛔ THE PAIRED CONTROL. Every permissive assertion above is worthless beside a
  // guard that stopped refusing anything, which is the shape a careless fix takes.
  for (const q of [
    'INSERT DATA { <urn:a> <urn:b> <urn:c> }',
    'DELETE WHERE { ?s ?p ?o }',
    'DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }',
    'CLEAR ALL',
    'DROP GRAPH <urn:g>',
    'LOAD <urn:doc>',
    'CREATE GRAPH <urn:g>',
    'COPY DEFAULT TO <urn:g>',
    'MOVE DEFAULT TO <urn:g>',
    'ADD DEFAULT TO <urn:g>',
  ]) {
    assert.equal(refused(q), true, `${q.split(' ')[0]} must still be refused`);
  }
});

test('#899 a keyword in a literal AND a real update in the same query is still refused', () => {
  // ⚠️ The bypass a naive literal-strip would create: hide the verb inside quotes
  // and put the real one outside. Stripping must remove only the literal.
  assert.equal(
    refused('INSERT DATA { <urn:a> <urn:b> "create" }'), true,
    'a real INSERT is not laundered by containing an innocent literal',
  );
});

test('#899 escaped quotes do not break the stripping', () => {
  // A literal containing an escaped quote must not end the literal early, or the
  // rest of the query gets scanned as if it were inside one.
  assert.equal(refused('SELECT ?n WHERE { ?a scrum:note "she said \\"create\\" once" }'), false);
  assert.equal(refused('SELECT ?n WHERE { ?a scrum:note "a \\" then" } ; DROP ALL'), true,
    'and a real DROP after a tricky literal is still caught');
});

test('#899 single-quoted and triple-quoted literals are stripped too', () => {
  assert.equal(refused("SELECT ?n WHERE { ?a scrum:op 'create' }"), false, 'SPARQL allows single quotes');
  assert.equal(refused('SELECT ?n WHERE { ?a scrum:text """a create statement""" }'), false, 'and long literals');
});

test('#899 ⭐⭐ THE STRUCTURAL BOUNDARY IS REAL — proven, not quoted from a comment', () => {
  // The docstring claims the shape is "enforced structurally (query(), never
  // update())". That claim is what makes loosening the regex safe, so it gets
  // driven rather than trusted — two comments asserting runtime properties have
  // already turned out to be false today.
  //
  // We bypass the wrapper deliberately and hand a real UPDATE to the engine.
  const s = store();
  let threw = false;
  try { s.query('INSERT DATA { <urn:a> <urn:b> <urn:c> }'); } catch { threw = true; }
  assert.equal(threw, true,
    'oxigraph.query() executed an UPDATE — the regex is then the ONLY boundary and '
    + 'must not be loosened without replacing it');
  assert.equal(s.size, 0, 'and nothing was written');
});
