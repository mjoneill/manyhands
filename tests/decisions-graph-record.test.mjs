/**
 * #1147 — DECISIONS BORN IN THE GRAPH, the second D3 migration step.
 *
 * Before: a decision was a scrum:Decision entity in the document's @graph,
 * projected into the replica FROM THE DOCUMENT, read by decision_list from
 * the document, and its create event was written beside it. After: the
 * write emits the EVENT only; the replica projects decisions from the event
 * log; the list and the obligation `about` resolver read the GRAPH. Rows an
 * older document still carries are projected too (same IRI, set semantics),
 * counted, never read. These tests are the card's release conditions; the
 * shape is #1143's, one collection over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const json = async (r) => ({ status: r.status, body: await r.json() });
const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(json);
const get = (base, path) => fetch(`${base}${path}`).then(json);
const graph = (base, query) => post(base, '/api/graph', { query }).then((r) => r.body);
// The harness writes the DOMAIN shape (a `decisions` key); a JSON-LD export carries them in @graph. Read both.
const docDecisionsOf = (doc) => [...(doc.decisions || []), ...((doc['@graph'] || []).filter((n) => n['@type'] === 'scrum:Decision'))];
const docDecisions = (s) => docDecisionsOf(s.readBoardFile());

const DECISION = (n, extra = {}) => ({
  statement: `ruling ${n}`, decidedBy: 'ada', constrains: [`topic-${n}`, 'shared'], reopensIf: `evidence ${n}`, ...extra,
});
const LEGACY = (id, n) => ({
  '@id': `https://scrumboard.local/decision/${id}`, '@type': 'scrum:Decision', identifier: id,
  'scrum:statement': `legacy ruling ${n}`, 'scrum:decidedBy': 'bo', 'scrum:constrains': [`legacy-${n}`, 'shared'],
  'scrum:reopensIf': `legacy evidence ${n}`, dateCreated: `2026-08-0${n}T00:00:00.000Z`,
});

test('#1147 a decision created through the API leaves NO row in the document and is read back from the GRAPH', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await post(s.baseUrl, '/api/decisions', DECISION(1));
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(docDecisions(s).length, 0, 'the document must carry no scrum:Decision row for a graph-born decision');
    const g = await graph(s.baseUrl, `SELECT ?st WHERE { <https://scrumboard.local/decision/${c.body.id}> a scrum:Decision ; scrum:statement ?st }`);
    assert.equal(g.rows?.length, 1, `exactly one node in the graph: ${JSON.stringify(g).slice(0, 300)}`);
    assert.equal(g.rows[0].st, 'ruling 1');
    const l = await get(s.baseUrl, '/api/decisions');
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.map((d) => d.id), [c.body.id], 'the list can only have come from the graph: the document has nothing');
    assert.equal(l.body[0].statement, 'ruling 1');
    assert.deepEqual(l.body[0].constrains, ['shared', 'topic-1'], 'topics come back SORTED: a graph is a set and keeps no typed order');
    assert.equal(l.body[0].reopensIf, 'evidence 1');
    assert.equal(l.body[0].decidedBy, 'ada');
    assert.ok(l.body[0].decidedAt, 'decidedAt survives the round trip');
  } finally { await s.stop(); }
});

test('#1147 PARITY for the migration season: legacy document rows + graph-born decisions read as ONE list, 40/40/40-shaped', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ decisions: [LEGACY('l-1', 1), LEGACY('l-2', 2)] }) });
  try {
    assert.equal(docDecisions(s).length, 2, 'fixture: two legacy rows in the document');
    // ⚠️ THE CASE PROD IS 100% OF (second reader's gap, 14:26Z): a legacy row
    // that ALSO has its create event in the log — both sources project the
    // same IRI. Seeded here because makeBoardFixture writes no events; without
    // this the "must not double" assertion below guards a board where doubling
    // cannot occur.
    const eventLogDir = s.boardFile.replace(/\.json$/, '') + '-events';
    const { appendEvent } = await import('../core/event-log.mjs');
    appendEvent(eventLogDir, { op: 'create', actor: 'bo', entity: { kind: 'decision', id: LEGACY('l-1', 1)['@id'] }, state: LEGACY('l-1', 1) });
    const c = await post(s.baseUrl, '/api/decisions', DECISION(3));
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(docDecisions(s).length, 2, 'the new one did not join the document');
    const l = await get(s.baseUrl, '/api/decisions');
    assert.deepEqual(l.body.map((d) => d.id).sort(), ['l-1', 'l-2', c.body.id].sort(), 'legacy and graph-born, one list');
    const n = await graph(s.baseUrl, 'SELECT (COUNT(?d) AS ?n) WHERE { ?d a scrum:Decision }');
    assert.equal(String(n.rows[0].n), '3', 'three nodes — l-1 is in BOTH the document and the event log and must not double');
    const l1 = await graph(s.baseUrl, 'SELECT (COUNT(?st) AS ?n) WHERE { <https://scrumboard.local/decision/l-1> scrum:statement ?st }');
    assert.equal(String(l1.rows[0].n), '1', 'one statement triple on the doubly-sourced node, not two');
    // the filters the tool exposes, answered from the graph
    const byTopic = await get(s.baseUrl, '/api/decisions?constrains=shared');
    assert.equal(byTopic.body.length, 3);
    const byLegacy = await get(s.baseUrl, '/api/decisions?constrains=legacy-1');
    assert.deepEqual(byLegacy.body.map((d) => d.id), ['l-1']);
    const byWho = await get(s.baseUrl, '/api/decisions?decidedBy=ada');
    assert.deepEqual(byWho.body.map((d) => d.id), [c.body.id]);
    const none = await get(s.baseUrl, '/api/decisions?constrains=nothing-constrains-this');
    assert.deepEqual(none.body, [], 'an unknown topic is an EMPTY LIST, never an error');
  } finally { await s.stop(); }
});

test('#1147 an obligation ABOUT a graph-born decision resolves — the second reader site moved with the first', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await post(s.baseUrl, '/api/decisions', DECISION(4));
    const about = `https://scrumboard.local/decision/${c.body.id}`;
    const o = await post(s.baseUrl, '/api/obligations', { owedBy: 'ada', by: 'ada', kind: 'promise', about, note: 'about a graph-born decision' });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    assert.equal(o.body.about, about);
    const dangling = await post(s.baseUrl, '/api/obligations', { owedBy: 'ada', by: 'ada', kind: 'promise', about: 'https://scrumboard.local/decision/does-not-exist', note: 'x' });
    assert.equal(dangling.status, 400, 'NEGATIVE CONTROL: a decision that does not exist anywhere is still refused');
  } finally { await s.stop(); }
});

test('#1147 a decision survives a RESTART from the event log alone (the log is the record)', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  let id, doc, eventLogDir;
  try {
    id = (await post(s.baseUrl, '/api/decisions', DECISION(5))).body.id;
    doc = s.readBoardFile();
    eventLogDir = s.boardFile.replace(/\.json$/, '') + '-events';
    assert.equal(docDecisionsOf(doc).length, 0, 'no document row to rebuild from — the log is the only source');
  } finally { await s.stop(); }
  const s2 = await startRestServer({ board: doc, env: { SCRUM_EVENT_LOG_DIR: eventLogDir } });
  try {
    const l = await get(s2.baseUrl, '/api/decisions');
    assert.deepEqual(l.body.map((d) => d.id), [id], 'rebuilt from the event log after a cold start');
  } finally { await s2.stop(); }
});

test('#1147 validation is unchanged: the same refusals, and a refused decision writes no event', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    for (const [body, re] of [
      [DECISION(6, { reopensIf: '' }), /reopensIf is required/],
      [DECISION(6, { constrains: [] }), /constrains must be a non-empty array/],
      [{ ...DECISION(6), decidedBy: undefined, by: undefined }, /decidedBy is required/],
    ]) {
      const r = await post(s.baseUrl, '/api/decisions', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, re);
    }
    assert.deepEqual((await get(s.baseUrl, '/api/decisions')).body, []);
  } finally { await s.stop(); }
});
