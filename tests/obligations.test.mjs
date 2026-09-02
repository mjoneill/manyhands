/**
 * #1118 slice A — scrum:Obligation, the entity. "What did I PROMISE?" was one
 * of the two continuity questions with NO entity kind behind it: steward
 * roles, review-owed, tripwires all lived in desk-stamp prose. An obligation
 * is born in the graph (Decision aaf1774b): event-logged, projected, and its
 * `about` may name ANY node — a card, a memory, a decision, a predicate —
 * which is the any-node-type shape Option D (aad42bf5) promised and nothing
 * had yet exercised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';

const json = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: parsed };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1086', shortId: 1086, title: 'the reader', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 1087,
});

const STEWARD = { by: 'ada', holder: 'ada', about: 1086, kind: 'steward', note: 'Value Steward on slice 2 — not builder' };

test('#1118-A create → list → read back: an obligation is a node with a holder, a subject, a kind and an open status', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const c = await json(s.baseUrl, 'POST', '/api/obligations', STEWARD);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.holder, 'ada');
    assert.equal(c.body.about, 'u-1086', 'a card shortId resolves to the card @id — the node, not the number');
    assert.equal(c.body.kind, 'steward');
    assert.equal(c.body.status, 'open');
    assert.equal(c.body.createdBy, 'ada');
    assert.ok(c.body.id, 'has an id');
    assert.ok(c.body.createdAt);
    const all = await json(s.baseUrl, 'GET', '/api/obligations');
    assert.equal(all.body.length, 1);
    const mine = await json(s.baseUrl, 'GET', '/api/obligations?holder=ada&status=open');
    assert.equal(mine.body.length, 1, '"what do I hold open" is one filtered read');
    const none = await json(s.baseUrl, 'GET', '/api/obligations?holder=bo');
    assert.deepEqual(none.body, [], 'a holder with nothing open is an EMPTY LIST, never an error');
  } finally { await s.stop(); }
});

test('#1118-A refusals name what to do: missing by, unknown kind, a subject that names no node', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const nobody = await json(s.baseUrl, 'POST', '/api/obligations', { ...STEWARD, by: '' });
    assert.equal(nobody.status, 400); assert.match(nobody.body.error, /by/i);
    const kind = await json(s.baseUrl, 'POST', '/api/obligations', { ...STEWARD, kind: 'vibe' });
    assert.equal(kind.status, 400); assert.match(kind.body.error, /steward|review|promise|tripwire/);
    const dangling = await json(s.baseUrl, 'POST', '/api/obligations', { ...STEWARD, about: 'https://scrumboard.local/nope' });
    assert.equal(dangling.status, 400);
    assert.match(dangling.body.error, /node/i, 'a dangling subject is refused, not stored — an obligation about nothing is prose again');
    const noHolder = await json(s.baseUrl, 'POST', '/api/obligations', { ...STEWARD, holder: '' });
    assert.equal(noHolder.status, 400); assert.match(noHolder.body.error, /holder/i);
  } finally { await s.stop(); }
});

test('#1118-A ANY NODE: an obligation may be about a decision or a predicate, not only a card', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const p = await json(s.baseUrl, 'POST', '/api/predicates', { name: 'scrum:relatedTo', definition: 'to be defined by a non-author', by: 'ada' });
    assert.equal(p.status, 201);
    const pid = 'https://scrumboard.local/predicate/scrum%3ArelatedTo';
    const c = await json(s.baseUrl, 'POST', '/api/obligations', { by: 'bo', holder: 'bo', about: pid, kind: 'review', note: 'write the honest definition' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.about, pid);
    const byAbout = await json(s.baseUrl, 'GET', `/api/obligations?about=${encodeURIComponent(pid)}`);
    assert.equal(byAbout.body.length, 1, '"what is owed on this node" is one filtered read');
  } finally { await s.stop(); }
});

test('#1118-A discharge: PATCH status=discharged stamps who and when; a discharged one leaves the open set; re-discharging is a noop', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const c = await json(s.baseUrl, 'POST', '/api/obligations', STEWARD);
    const d = await json(s.baseUrl, 'PATCH', `/api/obligations/${encodeURIComponent(c.body.id)}`, { by: 'bo', status: 'discharged', note: 'review delivered' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.status, 'discharged');
    assert.equal(d.body.dischargedBy, 'bo');
    assert.ok(d.body.dischargedAt);
    const open = await json(s.baseUrl, 'GET', '/api/obligations?holder=ada&status=open');
    assert.deepEqual(open.body, []);
    const again = await json(s.baseUrl, 'PATCH', `/api/obligations/${encodeURIComponent(c.body.id)}`, { by: 'cy', status: 'discharged' });
    assert.equal(again.status, 200);
    assert.equal(again.body.dischargedBy, 'bo', 'already discharged: the first discharge stands, the second is a noop');
    const bad = await json(s.baseUrl, 'PATCH', `/api/obligations/${encodeURIComponent(c.body.id)}`, { by: 'bo', status: 'open' });
    assert.equal(bad.status, 400, 'reopening is not a status transition this verb offers');
    const missing = await json(s.baseUrl, 'PATCH', '/api/obligations/nope', { by: 'bo', status: 'lapsed' });
    assert.equal(missing.status, 404);
  } finally { await s.stop(); }
});

test('#1118-A BORN IN THE GRAPH: holder is a person EDGE, about is an entity EDGE, and "what does ada hold open" is one query', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const c = await json(s.baseUrl, 'POST', '/api/obligations', STEWARD);
    assert.equal(c.status, 201);
    const q = await json(s.baseUrl, 'POST', '/api/graph', {
      by: 'ada',
      query: 'SELECT ?o ?about ?kind ?status ?note WHERE { ?o a scrum:Obligation ; scrum:holder person:ada ; schema:about ?about ; scrum:obligationKind ?kind ; scrum:status ?status ; schema:text ?note }',
    });
    assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 300));
    assert.equal(q.body.rows.length, 1, `one open obligation for ada: ${JSON.stringify(q.body.rows)}`);
    assert.equal(String(q.body.rows[0].about), 'entity:u-1086', 'about is the card NODE, joinable');
    assert.equal(String(q.body.rows[0].kind), 'steward');
    assert.equal(String(q.body.rows[0].status), 'open');
    // and the join the continuity pack needs: obligation → the card's title
    const j = await json(s.baseUrl, 'POST', '/api/graph', {
      by: 'ada',
      query: 'SELECT ?title WHERE { ?o a scrum:Obligation ; scrum:holder person:ada ; schema:about ?c . ?c schema:name ?title }',
    });
    assert.equal(j.body.rows.length, 1);
    assert.equal(String(j.body.rows[0].title), 'the reader');
  } finally { await s.stop(); }
});

test('#1118-A the discharge reaches the graph too: status flips and dischargedBy is a person edge', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const c = await json(s.baseUrl, 'POST', '/api/obligations', STEWARD);
    await json(s.baseUrl, 'PATCH', `/api/obligations/${encodeURIComponent(c.body.id)}`, { by: 'bo', status: 'discharged' });
    const q = await json(s.baseUrl, 'POST', '/api/graph', {
      by: 'ada',
      query: 'SELECT ?status ?who ?when WHERE { ?o a scrum:Obligation ; scrum:status ?status ; scrum:dischargedBy ?who ; scrum:dischargedAt ?when }',
    });
    assert.equal(q.body.rows.length, 1, JSON.stringify(q.body));
    assert.equal(String(q.body.rows[0].status), 'discharged');
    assert.equal(String(q.body.rows[0].who), 'person:bo');
  } finally { await s.stop(); }
});

test('#1118-A ⭐ REACHABLE BY AN MCP-ONLY SEAT — create, list, close, all through the tools (#904, not repeated)', async () => {
  const p = await startPair();
  try {
    const session = await mcpSession(p.mcp.mcpUrl);
    // the subject is a PREDICATE, registered over MCP too — any node, over the door the seats use
    const reg = await session.callTool('predicate_register', { name: 'scrum:relatedTo', definition: 'owed a definition', by: 'ada' });
    assert.ok(!reg.result?.isError, JSON.stringify(reg).slice(0, 300));
    const pid = 'https://scrumboard.local/predicate/scrum%3ArelatedTo';
    const c = await session.callTool('obligation_create', { by: 'ada', holder: 'bo', about: pid, kind: 'review', note: 'define it honestly' });
    const text = c.result?.content?.[0]?.text;
    assert.ok(text && !c.result?.isError, `obligation_create failed: ${JSON.stringify(c).slice(0, 300)}`);
    const made = JSON.parse(text);
    assert.equal(made.holder, 'bo');
    assert.equal(made.about, pid, 'about survives the MCP path as the node id');
    assert.equal(made.note, 'define it honestly', 'note survives — zod strips unknown keys silently (#823)');
    const open = await session.callTool('obligation_list', { holder: 'bo', status: 'open' });
    assert.equal(JSON.parse(open.result.content[0].text).length, 1, 'an MCP seat can ask "what do I hold open"');
    const closed = await session.callTool('obligation_update', { id: made.id, by: 'bo', status: 'discharged', note: 'done' });
    const after = JSON.parse(closed.result.content[0].text);
    assert.equal(after.status, 'discharged');
    assert.equal(after.dischargedBy, 'bo');
    const none = await session.callTool('obligation_list', { holder: 'bo', status: 'open' });
    assert.deepEqual(JSON.parse(none.result.content[0].text), []);
  } finally { await p.stop(); }
});
