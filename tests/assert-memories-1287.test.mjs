/**
 * #1287 — `graph_assert` could not reach a memory.
 *
 * #945 decided Option D ("raw triples, any node type") and shipped the verb.
 * #1118 slice B added obligations as a second subject kind, describing itself
 * as "Option D's 'any node type' earning its keep". Memories were never added,
 * so #971 — whose whole thesis is that memories have no edges — names #945 as
 * "precisely the mechanism this needs" and cannot use it:
 *
 *     graph_assert(memoryA, scrum:relatedTo, memoryB)
 *     → 400 'subject "…/memory/…" does not resolve to a card (shortId or
 *            uuid) or an obligation (@id). Nothing in this batch was applied.'
 *
 * That is not a missing decision. It is a hole in a delivered verb, and the
 * store already knows how to resolve a memory @id — `resolveNodeId` has done
 * it for obligations' `about` field the whole time. The capability was
 * adjacent and unused.
 *
 * ⛔ SCOPE, set by the product owner: resolution plus ONE predicate mapping.
 * `scrum:relatedTo` is the design-neutral choice — already registered, already
 * symmetric by construction, and its definition asserts "no direction, no
 * dependency, no belonging, no lineage, no endorsement, and no ranking". An
 * ordering or membership predicate would take #971's open design decision by
 * implementation, which is the shape #971 exists to complain about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const assertTriples = (base, assertions, by = 'ada') => post(base, '/api/assert', { by, assertions });

async function makeMemory(base, name, owner = 'ada') {
  const r = await post(base, '/api/memories', { title: name, body: `body of ${name}`, owner, by: owner });
  // ⚠️ Read the body ONCE. An `await r.text()` inside an assertion MESSAGE is
  // evaluated eagerly even when the assertion passes, which consumes the body
  // and makes the following .json() throw "Body has already been read".
  const raw = await r.text();
  assert.ok(r.status === 200 || r.status === 201, `memory create failed: ${r.status} ${raw}`);
  const m = JSON.parse(raw);
  const id = m['@id'] || m.id || (m.memory && (m.memory['@id'] || m.memory.id));
  assert.ok(id, `no id in memory create response: ${JSON.stringify(m).slice(0, 300)}`);
  // ⚠️ The create response returns ONLY the bare uuid — never the @id. Both
  // forms are returned here because the verb must accept the one a caller
  // actually holds, and the graph is keyed on the other.
  return { id, iri: String(id).startsWith('http') ? String(id) : `https://scrumboard.local/memory/${id}` };
}

async function makeCard(base, title = 'a card') {
  const r = await post(base, '/api/cards', { title, by: 'ada', column: 'backlog' });
  const raw = await r.text();
  assert.equal(r.status, 201, raw);
  return JSON.parse(raw).shortId;
}

/** Register the predicates this verb gates on. */
async function registerPredicates(base) {
  for (const [name, definition] of [
    ['scrum:relatedTo', 'SEE ALSO, and nothing more. Symmetric by construction.'],
    ['schema:isPartOf', 'STRUCTURAL CONTAINMENT: the subject belongs to the object.'],
  ]) {
    const r = await post(base, '/api/predicates', { name, definition, by: 'ada' });
    const raw = await r.text();
    assert.ok(r.status === 200 || r.status === 201 || r.status === 409, `${name}: ${r.status} ${raw}`);
  }
}

async function withServer(fn) {
  const s = await startRestServer({});
  try {
    await registerPredicates(s.baseUrl);
    return await fn(s);
  } finally { await s.stop(); }
}

const relatedOf = async (base, id) => {
  const rows = await j(await fetch(`${base}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `SELECT ?o WHERE { <${id}> scrum:relatedTo ?o }` }),
  }));
  return (rows.rows || []).map((r) => r.o);
};

test('#1287 ⭐ a memory can be BOTH ENDS of an assertion — the hole is closed', async () => {
  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'a shared null defeats independent instruments')).iri;
    const b = (await makeMemory(s.baseUrl, 'a suite result measures the machine as much as the tree')).iri;

    const r = await assertTriples(s.baseUrl, [{ subject: a, predicate: 'scrum:relatedTo', object: b }]);
    const raw = await r.text();
    assert.equal(r.status, 200, `memory→memory relatedTo must be assertable: ${raw}`);
    assert.equal(JSON.parse(raw).applied, 1);
  });
});

test('#1287 ⭐ the edge is SYMMETRIC — readable from both ends, as the predicate\'s definition requires', async () => {
  // relatedTo is "symmetric BY CONSTRUCTION — the server writes both
  // directions". A one-way write would make memories the one entity where
  // this predicate means something different from everywhere else.
  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'memory A')).iri;
    const b = (await makeMemory(s.baseUrl, 'memory B')).iri;
    assert.equal((await assertTriples(s.baseUrl, [{ subject: a, predicate: 'scrum:relatedTo', object: b }])).status, 200);

    assert.deepEqual(await relatedOf(s.baseUrl, a), [b], 'readable from the subject');
    assert.deepEqual(await relatedOf(s.baseUrl, b), [a], 'and from the object');
  });
});

test('#1287 — asserting the same edge twice is a NOOP, not a duplicate and not an error', async () => {
  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'memory A')).iri;
    const b = (await makeMemory(s.baseUrl, 'memory B')).iri;
    const one = [{ subject: a, predicate: 'scrum:relatedTo', object: b }];
    assert.equal((await j(await assertTriples(s.baseUrl, one))).applied, 1);
    const again = await assertTriples(s.baseUrl, one);
    assert.equal(again.status, 200);
    assert.equal((await j(again)).applied, 0, 'an assertion already true is a noop');
    assert.deepEqual(await relatedOf(s.baseUrl, a), [b], 'and no duplicate edge');
  });
});

test('#1287 ⛔ NEGATIVE CONTROL — a predicate with no memory mapping still REFUSES', async () => {
  // The failure mode this test exists for: a resolution change that makes
  // EVERY predicate suddenly applicable to memories. schema:isPartOf applies
  // apex labels at write time and is card→parent; it must not silently work.
  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'memory A')).iri;
    const b = (await makeMemory(s.baseUrl, 'memory B')).iri;
    const r = await assertTriples(s.baseUrl, [{ subject: a, predicate: 'schema:isPartOf', object: b }]);
    assert.equal(r.status, 400, 'isPartOf between memories must refuse');
    assert.match((await j(r)).error, /no store mapping|does not resolve/i);
    assert.deepEqual(await relatedOf(s.baseUrl, a), [], 'and nothing was written');
  });
});

test('#1287 ⛔ a memory @id that does not exist refuses, and the refusal names all THREE kinds', async () => {
  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'memory A')).iri;
    const ghost = 'https://scrumboard.local/memory/00000000-0000-4000-8000-000000000000';
    const r = await assertTriples(s.baseUrl, [{ subject: ghost, predicate: 'scrum:relatedTo', object: a }]);
    assert.equal(r.status, 400);
    const err = (await j(r)).error;
    assert.match(err, /card/i);
    assert.match(err, /obligation/i);
    assert.match(err, /memory/i, `the refusal must now name memories too, or it teaches the old model: ${err}`);
  });
});

test('#1287 ⛔ ATOMICITY SURVIVES — a batch mixing a good and a bad assertion applies NOTHING', async () => {
  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'memory A')).iri;
    const b = (await makeMemory(s.baseUrl, 'memory B')).iri;
    const r = await assertTriples(s.baseUrl, [
      { subject: a, predicate: 'scrum:relatedTo', object: b },
      { subject: a, predicate: 'scrum:relatedTo', object: 'https://scrumboard.local/memory/does-not-exist' },
    ]);
    assert.equal(r.status, 400);
    assert.deepEqual(await relatedOf(s.baseUrl, a), [], 'the GOOD assertion in the batch must not have landed');
  });
});

test('#1287 — cards still work exactly as before (the regression control)', async () => {
  // Widening resolution must not disturb the paths that already worked.
  await withServer(async (s) => {
    const parent = await makeCard(s.baseUrl, 'parent');
    const child = await makeCard(s.baseUrl, 'child');
    const r = await assertTriples(s.baseUrl, [{ subject: child, predicate: 'schema:isPartOf', object: parent }]);
    assert.equal(r.status, 200, await r.clone().text());
    const card = await j(await fetch(`${s.baseUrl}/api/cards/${child}`));
    assert.ok(card.parent, 'the card parent edge still lands');
  });
});

test('#1287 ⭐ #971\'s CHECK CAN NOW MOVE — its ASK is false before and true after ONE call', async () => {
  // #971's check ASKs for any memory carrying relatedTo/isPartOf/supersedes/
  // derivedFrom/order and expects false. It was pinned false because no verb
  // any seat held could make it true — measuring a missing FEATURE while
  // looking exactly like measuring missing EFFORT.
  const ask = async (base) => (await j(await fetch(`${base}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'ASK { ?m a scrum:Memory . ?m ?p ?o . FILTER(?p IN (schema:isPartOf, scrum:relatedTo, scrum:supersedes, scrum:derivedFrom, scrum:order)) }' }),
  }))).ask;

  await withServer(async (s) => {
    const a = (await makeMemory(s.baseUrl, 'memory A')).iri;
    const b = (await makeMemory(s.baseUrl, 'memory B')).iri;
    assert.equal(await ask(s.baseUrl), false, 'false before — the control');
    assert.equal((await assertTriples(s.baseUrl, [{ subject: a, predicate: 'scrum:relatedTo', object: b }])).status, 200);
    assert.equal(await ask(s.baseUrl), true, 'and one call moves it');
  });
});

test('#1287 ⭐ the BARE UUID the create response hands back is accepted — the read path reaches the write path', async () => {
  // POST /api/memories returns {id: "<uuid>", …} and NEVER the @id, so a caller
  // who has just created a memory holds only the bare form. Refusing it would
  // make this verb unreachable from the API that mints its subjects.
  await withServer(async (s) => {
    const a = await makeMemory(s.baseUrl, 'memory A');
    const b = await makeMemory(s.baseUrl, 'memory B');
    const r = await assertTriples(s.baseUrl, [{ subject: a.id, predicate: 'scrum:relatedTo', object: b.id }]);
    assert.equal(r.status, 200, `the bare uuid must resolve: ${await r.clone().text()}`);
    assert.deepEqual(await relatedOf(s.baseUrl, a.iri), [b.iri], 'and it stores the canonical @id');
  });
});
