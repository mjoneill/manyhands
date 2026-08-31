/**
 * #945 slice 2 — THE WRITE VERB. Decision aad42bf5 (Option D, ruled text):
 * "raw triples (subject, predicate, object), any node type, N assertions in
 * one atomic call — with a PREDICATE REGISTRY, so a predicate must be
 * registered with a definition before it can be used. An unregistered
 * predicate fails the write and names what to do. This is NOT SPARQL Update
 * on the replica: assertions land on the store and project forward."
 *
 * Acceptance (#945): N relations one call · same guards as every write (the
 * existing door widened, not a second path) · reachable from MCP · never a
 * replica write. The slice-1 pin ("an empty registry stops no write") is
 * about the OLD door — card PATCH stays ungated. THIS verb is born gated:
 * that is what Option D is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'first', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    { id: 'u-2', shortId: 2, title: 'second', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    { id: 'u-3', shortId: 3, title: 'third', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 3,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 4,
});

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* some errors have no body */ }
  return { status: r.status, body: parsed };
};

const registerCore = async (baseUrl) => {
  const defs = [
    { name: 'schema:isPartOf', definition: 'Structural containment: the subject BELONGS TO the object. Transitive by this board\'s choice. Asserted, never inferred.' },
    { name: 'scrum:blockedBy', definition: 'Dependency constraint: the subject cannot proceed until the object resolves. The edge is the assertion; the blockers entry is its status.' },
    { name: 'scrum:implementedBy', definition: 'Realization: the subject is implemented by the full-sha commit named as object. Evidence-grade; shaIntegrity audits it.' },
    { name: 'scrum:mentionsCard', definition: 'DERIVED reference: emitted by projection from body text. Refers-to ONLY — a lead, not a claim. Never asserted directly.' },
  ];
  for (const d of defs) {
    const r = await api(baseUrl, 'POST', '/api/predicates', { ...d, by: 'ada' });
    assert.ok(r.status === 201 || r.status === 200, `registry seed: ${JSON.stringify(r.body)}`);
  }
};

const getCard = async (baseUrl, shortId) => (await api(baseUrl, 'GET', `/api/cards/${shortId}`)).body;

test('#945-2 N assertions land in ONE atomic call, through the existing door', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const r = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada',
      assertions: [
        { subject: 1, predicate: 'scrum:blockedBy', object: 2 },
        { subject: 3, predicate: 'schema:isPartOf', object: 1 },
        { subject: 2, predicate: 'scrum:implementedBy', object: 'a'.repeat(40) },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, 3);
    assert.equal(r.body.results.length, 3);

    const c1 = await getCard(s.baseUrl, 1);
    assert.deepEqual(c1.relationships.blockedBy, [2], 'blockedBy edge stored on the subject');
    const c3 = await getCard(s.baseUrl, 3);
    assert.equal(c3.parent, 'u-1', 'isPartOf became the canonical parent — the SAME store shape, not a parallel one');
    const c2 = await getCard(s.baseUrl, 2);
    assert.deepEqual(c2.implementedBy, ['a'.repeat(40)], 'implementedBy sha recorded');
  } finally { await s.stop(); }
});

test('#945-2 THE GATE: an unregistered predicate fails the WHOLE batch and names what to do — nothing applies', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const r = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada',
      assertions: [
        { subject: 1, predicate: 'scrum:blockedBy', object: 2 },          // valid
        { subject: 2, predicate: 'scrum:relatedTo', object: 3 },          // UNREGISTERED (the live experiment)
      ],
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /scrum:relatedTo/, 'the refusal names the predicate');
    assert.match(r.body.error, /register|predicate_register/i, 'and names what to do');
    const c1 = await getCard(s.baseUrl, 1);
    assert.deepEqual(c1.relationships?.blockedBy ?? [], [], 'ATOMIC: the valid batch-mate did NOT land');
  } finally { await s.stop(); }
});

test('#945-2 a DERIVED predicate refuses assertion, quoting its own registered definition', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const r = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada',
      assertions: [{ subject: 1, predicate: 'scrum:mentionsCard', object: 2 }],
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /derived/i, 'the registry definition does the refusing');
  } finally { await s.stop(); }
});

test('#945-2 isPartOf refuses a cycle, atomically', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const first = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada', assertions: [{ subject: 3, predicate: 'schema:isPartOf', object: 1 }],
    });
    assert.equal(first.status, 200);
    const r = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada',
      assertions: [
        { subject: 2, predicate: 'scrum:blockedBy', object: 3 },          // valid
        { subject: 1, predicate: 'schema:isPartOf', object: 3 },          // cycle: 3 is under 1
      ],
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /cycle/i);
    const c2 = await getCard(s.baseUrl, 2);
    assert.deepEqual(c2.relationships?.blockedBy ?? [], [], 'ATOMIC: nothing from the refused batch landed');
  } finally { await s.stop(); }
});

test('#945-2 refusals teach: missing by · unknown subject · malformed predicate · short sha · empty batch', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const noBy = await api(s.baseUrl, 'POST', '/api/assert', {
      assertions: [{ subject: 1, predicate: 'scrum:blockedBy', object: 2 }],
    });
    assert.equal(noBy.status, 400);
    assert.match(noBy.body.error, /\bby\b/i, 'attribution is required — who asserts');

    const ghost = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada', assertions: [{ subject: 99, predicate: 'scrum:blockedBy', object: 1 }],
    });
    assert.equal(ghost.status, 400);
    assert.match(ghost.body.error, /99/, 'the refusal names the unresolvable subject');

    const malformed = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada', assertions: [{ subject: 1, predicate: 'not-prefixed', object: 2 }],
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.body.error, /prefix/i);

    const shortSha = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada', assertions: [{ subject: 1, predicate: 'scrum:implementedBy', object: 'abc123' }],
    });
    assert.equal(shortSha.status, 400);
    assert.match(shortSha.body.error, /40/, 'full-sha rule survives through the new door');

    const empty = await api(s.baseUrl, 'POST', '/api/assert', { by: 'ada', assertions: [] });
    assert.equal(empty.status, 400);
  } finally { await s.stop(); }
});

test('#945-2 an assertion already true is a NOOP, not an error — asserting is idempotent', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const once = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada', assertions: [{ subject: 1, predicate: 'scrum:blockedBy', object: 2 }],
    });
    assert.equal(once.status, 200);
    const again = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada', assertions: [{ subject: 1, predicate: 'scrum:blockedBy', object: 2 }],
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.results[0].effect, 'noop', 'already-true is reported, not refused');
    const c1 = await getCard(s.baseUrl, 1);
    assert.deepEqual(c1.relationships.blockedBy, [2], 'no duplicate edge');
  } finally { await s.stop(); }
});

test('#945-2 the asserted edges reach the GRAPH — land on the store, project forward', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await registerCore(s.baseUrl);
    const w = await api(s.baseUrl, 'POST', '/api/assert', {
      by: 'ada',
      assertions: [
        { subject: 3, predicate: 'schema:isPartOf', object: 1 },
        { subject: 1, predicate: 'scrum:blockedBy', object: 2 },
      ],
    });
    assert.equal(w.status, 200);
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      by: 'ada',
      query: 'SELECT ?s WHERE { ?s schema:isPartOf ?o . ?o schema:identifier "1" }',
    });
    assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 300));
    assert.equal(q.body.rows.length, 1, 'the projection carries the asserted containment');
  } finally { await s.stop(); }
});
