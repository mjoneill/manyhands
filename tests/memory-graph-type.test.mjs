/**
 * #651 — MEMORY as a graph type: queryable, versioned, tagged.
 *
 * The ask, verbatim: "a new type of 'thing' in the graph: 'memory' with the
 * standard attributes… it would give an agent the ability to query, 'What are
 * my important memories? what are the things I thought to hold closely?'"
 *
 * ⭐ WHY VERSIONING IS THE LOAD-BEARING HALF, and it is the card's own argument:
 * a seat's index went 64 KB → 6.5 KB in one curation pass — a ~90% lossy
 * compression event with NO RECORD OF WHAT WAS CUT. Nothing anywhere can answer
 * "what did this say before?"
 *
 *   ⇒ Versioned memories make pruning SAFE: cut boldly, because the prior
 *     version is addressable. Today every prune is irreversible and therefore
 *     conservative — which is exactly why the file grows until it must be cut
 *     hard, which is when the lossy event happens.
 *
 * ⛔ SCOPE, NARROWED ON THE CARD'S OWN EVIDENCE:
 *
 *   NOT access-frequency. The card proves the metric is a trap twice over — it
 *   is a write-per-read on a flat store, AND it would rank the auto-loaded index
 *   first forever, measuring the loading mechanism rather than the value.
 *
 *   NOT the read/consent model. The card puts it to the room, and reframes it
 *   correctly: the question is not "are these secret" but "whose information is
 *   in here, and did they agree to how it is held?" A store can exist without
 *   that being answered; an aggregation surface cannot. So this builds the
 *   store and no cross-seat aggregation.
 *
 *   NOT an import. Nothing reads any existing memory file. Every memory here is
 *   one a seat chose to write, which keeps the consent question open rather than
 *   answering it by default — and answering it by default is the failure the
 *   card names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const MEM = {
  title: 'How I build',
  body: 'Write the failing test first. Probe the API shape rather than assuming it.',
  tags: ['how-i-build', 'process'],
  owner: 'ada',
};

test('#651 a memory is created, owned, tagged, and readable back', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.ok(c.body.id, 'a memory has a durable identity');
    assert.equal(c.body.version, 1);

    const got = await api(s.baseUrl, 'GET', `/api/memories/${c.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.title, MEM.title);
    assert.equal(got.body.body, MEM.body);
    assert.deepEqual(got.body.tags, MEM.tags);
    assert.equal(got.body.owner, 'ada', 'ownership is recorded, never inferred');
  } finally { await s.stop(); }
});

test('#651 an edit creates a NEW version and the PRIOR text stays addressable', async () => {
  // ⛔ THE LOAD-BEARING TEST. If an edit overwrites, this is a store with extra
  // steps and the pruning problem is untouched.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    const id = c.body.id;

    const u = await api(s.baseUrl, 'PATCH', `/api/memories/${id}`,
      { body: 'Pruned to one line.', by: 'ada' });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.version, 2, 'the edit minted a version rather than replacing one');

    const cur = await api(s.baseUrl, 'GET', `/api/memories/${id}`);
    assert.equal(cur.body.body, 'Pruned to one line.', 'current text is the newest');

    const hist = await api(s.baseUrl, 'GET', `/api/memories/${id}/versions`);
    assert.equal(hist.status, 200);
    assert.equal(hist.body.versions.length, 2);
    assert.equal(hist.body.versions[0].version, 1);
    assert.equal(hist.body.versions[0].body, MEM.body,
      'the pruned text survives — this is the whole point: cut boldly, because '
      + 'the prior version is addressable');
    assert.equal(hist.body.versions[1].body, 'Pruned to one line.');
  } finally { await s.stop(); }
});

test('#651 a version is IMMUTABLE — an edit cannot rewrite what was already said', async () => {
  // ⚠️ Without this the history is decorative: a store that lets you edit v1
  // after writing v2 answers "what did this say before?" with whatever someone
  // most recently wished it had said.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    await api(s.baseUrl, 'PATCH', `/api/memories/${c.body.id}`, { body: 'v2', by: 'ada' });

    const before = await api(s.baseUrl, 'GET', `/api/memories/${c.body.id}/versions`);
    const v1Text = before.body.versions[0].body;

    // Any attempt to address a past version for writing must be refused.
    const attempt = await api(s.baseUrl, 'PATCH', `/api/memories/${c.body.id}`,
      { body: 'v3', version: 1, by: 'ada' });
    // Either refused outright, or accepted as a NEW version — never a rewrite of v1.
    const after = await api(s.baseUrl, 'GET', `/api/memories/${c.body.id}/versions`);
    assert.equal(after.body.versions[0].body, v1Text,
      `v1 changed after ${attempt.status} — history must be append-only`);
  } finally { await s.stop(); }
});

test('#651 memories are queryable by owner and by tag — the actual ask', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(s.baseUrl, 'POST', '/api/memories', MEM);
    await api(s.baseUrl, 'POST', '/api/memories',
      { title: 'Startup memories', body: 'x', tags: ['startup'], owner: 'ada' });
    await api(s.baseUrl, 'POST', '/api/memories',
      { title: 'Not mine', body: 'y', tags: ['how-i-build'], owner: 'grace' });

    const mine = await api(s.baseUrl, 'GET', '/api/memories?owner=ada');
    assert.equal(mine.body.total, 2, '"what are MY memories" — the question the card opens with');

    const tagged = await api(s.baseUrl, 'GET', '/api/memories?tag=how-i-build');
    assert.deepEqual(tagged.body.memories.map((m) => m.owner).sort(), ['ada', 'grace'],
      '"show me memories tagged with a thing I have tagged"');
  } finally { await s.stop(); }
});

test('#651 a memory is a first-class GRAPH node, not a blob in a side table', async () => {
  // §IV's row is "MEMORY as a GRAPH type". If it is only a REST table, the row
  // is not satisfied — the north star's whole argument is that context which
  // cannot be queried is an archive.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(s.baseUrl, 'POST', '/api/memories', MEM);

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?t ?owner WHERE { ?m a scrum:Memory ; schema:name ?t ; scrum:owner ?owner }',
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.rows.length, 1, 'the memory is in the graph');
    assert.equal(q.body.rows[0].t, MEM.title);
    assert.equal(q.body.rows[0].owner, 'person:ada', 'the owner is an EDGE to a Person, not a string');
  } finally { await s.stop(); }
});

test('#651 the store round-trips through the document without loss', async () => {
  // ⚠️ The projection partitions @graph by type. An entity class the projection
  // does not know rides in `_unmodelled` — preserved, but filed under a name
  // that lies about what it holds. This asserts memories survive a full
  // save/load as MEMORIES.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/memories', MEM);
    await api(s.baseUrl, 'PATCH', `/api/memories/${c.body.id}`, { body: 'v2', by: 'ada' });

    const raw = s.readBoardFile();
    const graph = raw['@graph'] || [];
    const mems = graph.filter((e) => e['@type'] === 'scrum:Memory');
    const vers = graph.filter((e) => e['@type'] === 'scrum:MemoryVersion');
    assert.equal(mems.length, 1, 'one memory identity in the stored document');
    assert.equal(vers.length, 2, 'two immutable versions beside it');
    assert.ok(!('_unmodelled' in raw) || !(raw._unmodelled || []).some((e) => /Memory/.test(e['@type'] || '')),
      'memories must be a MODELLED class, not swept into the unmodelled bucket');
  } finally { await s.stop(); }
});
