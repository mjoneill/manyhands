// #1791 — a post whose text contains "; delete" or "; insert" was REFUSED at the post-seq reservation: psqLit wrote the draft
// JSON with only \ and " escaped, so its raw ';' reached the SPARQL text and staticCheck's multi-operation guard read prose as a
// second operation. The value is unchanged by the fix (the same string, spelled with \u escapes); a real second operation is
// still refused. Against a real executor, the stored draft reads back byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, staticCheck } from '../core/graph-compiler.mjs';
import { reserveOpId } from '../core/postseq-reserve.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { POSTSEQ_TERMS } from '../core/graph-vocab.mjs';

const PROSE = ['its node is gone; delete the card', 'a; INSERT b', 'x;\tDELETE { } WHERE { }', 'semi; colon; plain',
  // #1781's probe bodies: SPARQL quoted in a post
  'GRAPH ?g { ?d <urn:ex:commitSeq> ?s }', '?op <urn:ex:commitSeq> ?c', 'a version stamp ?x <urn:ex:ver> 3'];
const item = (body, requestId) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } });
const intent = (it) => ({ kind: 'postseq.reserve', opId: reserveOpId([it]), actor: 'urn:ex:seat/ada', reservations: [it] });

test('#1791 R1 prose containing "; delete" / "; INSERT" compiles; a real second operation is still refused by staticCheck', () => {
  PROSE.forEach((body, k) => assert.doesNotThrow(() => compile(intent(item(body, `rk-1791-${k}`))), body));
  const { sparql } = compile(intent(item('plain', 'rk-1791-plain')));
  assert.equal(staticCheck(`${sparql};\nDELETE WHERE { ?s ?p ?o }`, reserveOpId([item('plain', 'rk-1791-plain')])).ok, false, 'a genuine multi-operation request is refused');
  // the scans still see the request's OWN syntax: only the literals are blanked
  const op = reserveOpId([item('plain', 'rk-1791-plain')]);
  // every injection lands AFTER the duplicate guard (which must be first), so each refusal below is for its stated reason;
  // the CONTROL injects a harmless line at the same point and must pass
  const inject = (line) => sparql.replace('  FILTER(!BOUND(?dup))\n', `  FILTER(!BOUND(?dup))\n  ${line}\n`);
  assert.notEqual(inject('X'), sparql, 'PRECONDITION: the injection point exists');
  assert.equal(staticCheck(inject('BIND(1 AS ?xharmless)'), op).ok, true, 'CONTROL: a harmless line at the injection point passes');
  assert.equal(staticCheck(inject('GRAPH ?g { ?gs ?gp ?go }'), op).ok, false, 'a real named graph in the WHERE is still refused');
  assert.equal(staticCheck(inject('?xop <urn:ex:commitSeq> ?xc .'), op).ok, false, 'a real bookkeeping predicate outside GRAPH <bk> is still refused');
  // the blanking ends a literal at its real closing quote: a literal ending in an ESCAPED backslash ("x\\\\") is closed by
  // the next quote, so syntax right after it stays visible (a regex that treated \\" as an escape would swallow it)
  const after = (tail) => inject(`BIND("x\\\\" AS ?xlit)${tail}`);
  // …with a LATER literal on the same line, which is what a wrong escape rule would run on to and swallow everything between
  assert.equal(staticCheck(after(' GRAPH ?g { ?gs ?gp "y" }'), op).ok, false, 'a named graph right after "x\\\\" is still seen');
  assert.equal(staticCheck(after(' ?xop <urn:ex:commitSeq> ?xc . BIND("y" AS ?xlit2)'), op).ok, false, 'a bookkeeping predicate right after "x\\\\" is still seen');
  assert.equal(staticCheck(after(' BIND("y" AS ?xlit2)'), op).ok, true, 'CONTROL: the two literals alone pass');
  assert.equal(staticCheck(after(''), op).ok, true, 'CONTROL: the literal alone passes');
});

test('#1791 R2 against a real executor the reserved draft reads back byte-identical, semicolons and all', { skip: !HAVE_PY && 'no executor python' }, async (t) => {
  const x = await startExecutor({ store: tmpStore('r1791-'), datasetId: 'r1791', create: true });
  t.after(() => killExecutor(x));
  const c = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'r1791', timeoutMs: 30000, label: 'r1791' });
  const seed = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:ex:op/test/r1791-seed', 'x-epoch': String((await (await fetch(`${x.baseUrl}/health`)).json()).epoch) },
    body: `INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> "e-1791" ; <urn:ex:postseq/nextPostSeq> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ; <urn:ex:postseq/version> "1"^^<http://www.w3.org/2001/XMLSchema#integer> . } }` });
  assert.equal(seed.status, 200, `PRECONDITION: the allocator is seeded (${await seed.text()})`);
  const it = item(PROSE[0], 'rk-1791-live');
  const r = await c.update(intent(it));
  assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
  const pid = postWriteId(it.author, it.requestId);
  const q = await c.query(`SELECT ?dj WHERE { GRAPH <urn:scrum:bookkeeping:executor> { ${POSTSEQ_TERMS.reservation(pid)} ${POSTSEQ_TERMS.draftJson} ?dj } }`);
  assert.ok(q.ok, q.reason);
  assert.equal(q.rows.length, 1);
  assert.equal(JSON.parse(q.rows[0].dj.value).body, PROSE[0], 'the stored draft carries the text exactly');
  assert.ok(!/\\u00(3B|3F|7B|7D|3C|3E)/.test(q.rows[0].dj.value), 'the escapes are SPARQL spelling only: the stored string holds the real characters');
});
