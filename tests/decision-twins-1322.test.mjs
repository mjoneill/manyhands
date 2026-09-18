/**
 * #1322 — decisions can point at each other (SUPERSEDES / DUPLICATE OF), the
 * list says which rulings are LIVE without prose archaeology, and the write
 * path refuses a TWIN: the same decider recorded twice inside a window, with
 * no relation named. Two seats recorded one ruling 35 s apart on 09-08 and
 * 5 s apart on 09-18; both times the only tool for marking it was prose
 * inside a third decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, startMcpServer, mcpSession } from './helpers/harness.mjs';

const json = async (r) => ({ status: r.status, body: await r.json() });
const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(json);
const get = (base, path) => fetch(`${base}${path}`).then(json);
const graph = (base, query) => post(base, '/api/graph', { query }).then((r) => r.body);
const D = (n, extra = {}) => ({
  statement: `ruling ${n}`, decidedBy: 'ada', constrains: [`topic-${n}`], reopensIf: `evidence ${n}`, ...extra,
});

test('#1322 TWIN RAIL — the same decider recorded twice inside the window with no relation named is REFUSED naming the sibling; a different decider is not', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = await post(s.baseUrl, '/api/decisions', D(1));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const twin = await post(s.baseUrl, '/api/decisions', D(2, { statement: 'the same ruling in other words' }));
    assert.equal(twin.status, 409, JSON.stringify(twin.body));
    assert.equal(twin.body.code, 'DECISION_TWIN');
    assert.deepEqual(twin.body.siblings.map((x) => x.id), [a.body.id], 'the refusal names the sibling');
    assert.match(twin.body.error, /duplicateOf|supersedes|force/, 'and says the three ways through');
    const other = await post(s.baseUrl, '/api/decisions', D(3, { decidedBy: 'bo' }));
    assert.equal(other.status, 201, 'a different decider inside the window is not a twin');
    const l = await get(s.baseUrl, '/api/decisions');
    assert.equal(l.body.length, 2, 'the refused twin wrote nothing');
  } finally { await s.stop(); }
});

test('#1322 the three ways through the rail: duplicateOf records the twin AS a twin, supersedes records an amendment, force records a distinct ruling', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = (await post(s.baseUrl, '/api/decisions', D(1))).body;
    const dup = await post(s.baseUrl, '/api/decisions', D(2, { duplicateOf: a.id }));
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.equal(dup.body.duplicateOf, a.id);
    const sup = await post(s.baseUrl, '/api/decisions', D(3, { supersedes: [a.id] }));
    assert.equal(sup.status, 201, JSON.stringify(sup.body));
    assert.deepEqual(sup.body.supersedes, [a.id]);
    const forced = await post(s.baseUrl, '/api/decisions', D(4, { force: true }));
    assert.equal(forced.status, 201, JSON.stringify(forced.body));
    // a short prefix resolves, an unknown id refuses, an ambiguous prefix refuses
    const byPrefix = await post(s.baseUrl, '/api/decisions', D(5, { decidedBy: 'cy', supersedes: [a.id.slice(0, 8)] }));
    assert.equal(byPrefix.status, 201, JSON.stringify(byPrefix.body));
    assert.deepEqual(byPrefix.body.supersedes, [a.id], 'an 8-char prefix is expanded to the full id — never stored short');
    const unknown = await post(s.baseUrl, '/api/decisions', D(6, { decidedBy: 'dee', supersedes: ['00000000-0000-0000-0000-000000000000'] }));
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.match(unknown.body.error, /no decision/);
  } finally { await s.stop(); }
});

test('#1322 ⭐ ACCEPTANCE 3 — the list says which rulings are LIVE: a superseded or duplicated decision is not, the marking is a NEW assertion (the old one is untouched), and a three-step chain reads as one live head', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = (await post(s.baseUrl, '/api/decisions', D(1))).body;                       // the original
    const b = (await post(s.baseUrl, '/api/decisions', D(2, { supersedes: [a.id] }))).body;   // amended once
    const c = (await post(s.baseUrl, '/api/decisions', D(3, { supersedes: [b.id] }))).body;   // amended again
    const t = (await post(s.baseUrl, '/api/decisions', D(4, { decidedBy: 'bo', duplicateOf: c.id }))).body;  // a twin of the head
    const all = (await get(s.baseUrl, '/api/decisions')).body;
    const by = Object.fromEntries(all.map((d) => [d.id, d]));
    assert.equal(by[a.id].live, false); assert.deepEqual(by[a.id].supersededBy, [b.id]);
    assert.equal(by[b.id].live, false); assert.deepEqual(by[b.id].supersededBy, [c.id]);
    assert.equal(by[c.id].live, true);  assert.deepEqual(by[c.id].duplicates, [t.id]);
    assert.equal(by[t.id].live, false); assert.equal(by[t.id].duplicateOf, c.id);
    assert.equal(by[a.id].statement, 'ruling 1', 'the superseded decision is not edited');
    const live = (await get(s.baseUrl, '/api/decisions?live=1')).body;
    assert.deepEqual(live.map((d) => d.id), [c.id], 'live=1 is the one query a reader needs');
    // the edges are in the graph, as decision → decision, not as strings
    const g = await graph(s.baseUrl, `SELECT ?x WHERE { <https://scrumboard.local/decision/${b.id}> scrum:supersedes ?x }`);
    assert.equal(g.rows?.length, 1); assert.equal(g.rows[0].x, `https://scrumboard.local/decision/${a.id}`, 'a decision IRI, never a string');
  } finally { await s.stop(); }
});

test('#1322 ⛔ NEGATIVE CONTROL — a decision that supersedes nothing gains no relation field; only `live: true` is new, and a second decider inside the window is not a twin', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = (await post(s.baseUrl, '/api/decisions', D(1))).body;
    const wire = (await get(s.baseUrl, '/api/decisions')).body[0];
    assert.deepEqual(Object.keys(wire).sort(), ['constrains', 'decidedAt', 'decidedBy', 'id', 'live', 'reopensIf', 'statement'].sort());
    assert.equal(wire.live, true);
    assert.equal(a.live, true, 'the create echo carries it too');
  } finally { await s.stop(); }
});

test('#1322 the rail is a WINDOW, not a lifetime: the same decider outside it records freely (legacy rows dated long ago count)', async () => {
  const old = {
    '@id': 'https://scrumboard.local/decision/old-1', '@type': 'scrum:Decision', identifier: 'old-1',
    'scrum:statement': 'an old ruling', 'scrum:decidedBy': 'ada', 'scrum:constrains': ['x'], 'scrum:reopensIf': 'y', dateCreated: '2026-08-01T00:00:00.000Z',
  };
  const s = await startRestServer({ board: makeBoardFixture({ decisions: [old] }) });
  try {
    const r = await post(s.baseUrl, '/api/decisions', D(1));
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally { await s.stop(); }
});

test('#1322 MCP: decision_create forwards duplicateOf / supersedes / force and surfaces the 409; decision_list forwards live', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  const m = await startMcpServer({ restApiBase: s.baseUrl });
  try {
    const sess = await mcpSession(m.mcpUrl);
    // the harness returns the raw JSON-RPC envelope: the tool text is at result.content[0].text
    const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);
    const a = JSON.parse(text(await sess.callTool('decision_create', D(1))));
    assert.ok(a.id, JSON.stringify(a));
    const twin = await sess.callTool('decision_create', D(2));
    assert.match(text(twin), /DECISION_TWIN/, 'the refusal reaches the tool caller');
    const dup = JSON.parse(text(await sess.callTool('decision_create', D(2, { duplicateOf: a.id }))));
    assert.equal(dup.duplicateOf, a.id);
    const live = JSON.parse(text(await sess.callTool('decision_list', { live: true })));
    assert.deepEqual(live.map((d) => d.id), [a.id]);
    const forced = JSON.parse(text(await sess.callTool('decision_create', D(3, { force: true }))));
    const rel = JSON.parse(text(await sess.callTool('decision_relate', { id: forced.id.slice(0, 8), by: 'ada', supersedes: [a.id] })));
    assert.equal(rel.id, forced.id); assert.deepEqual(rel.supersedes, [a.id]);
    const after = JSON.parse(text(await sess.callTool('decision_list', { live: true })));
    assert.deepEqual(after.map((d) => d.id), [forced.id], 'after the mark the amended ruling is the only live one');
  } finally { await m.stop(); await s.stop(); }
});

test('#1322 ⭐ ACCEPTANCE 2 — a twin seen AFTER the fact is marked by a NEW assertion (relate event): the statement is untouched, the mark survives a restart, and a mark naming no relation or itself is refused', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = (await post(s.baseUrl, '/api/decisions', D(1))).body;
    const b = (await post(s.baseUrl, '/api/decisions', D(2, { force: true }))).body;   // recorded as distinct, wrongly
    const r = await post(s.baseUrl, `/api/decisions/${b.id.slice(0, 8)}/relations`, { by: 'ada', duplicateOf: a.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.id, b.id, 'the prefix expands to the full id');
    let by = Object.fromEntries((await get(s.baseUrl, '/api/decisions')).body.map((d) => [d.id, d]));
    assert.equal(by[b.id].live, false); assert.equal(by[b.id].duplicateOf, a.id); assert.equal(by[b.id].statement, 'ruling 2');
    assert.deepEqual(by[a.id].duplicates, [b.id]); assert.equal(by[a.id].live, true);
    const none = await post(s.baseUrl, `/api/decisions/${a.id}/relations`, { by: 'ada' });
    assert.equal(none.status, 400);
    const self = await post(s.baseUrl, `/api/decisions/${a.id}/relations`, { by: 'ada', duplicateOf: a.id });
    assert.equal(self.status, 400, 'a decision cannot be a duplicate of itself');
    const noBy = await post(s.baseUrl, `/api/decisions/${a.id}/relations`, { duplicateOf: b.id });
    assert.equal(noBy.status, 400, 'by is required');
    const doc = s.readBoardFile(), eventLogDir = s.boardFile.replace(/\.json$/, '') + '-events';
    await s.stop();
    const s2 = await startRestServer({ board: doc, env: { SCRUM_EVENT_LOG_DIR: eventLogDir } });
    try {
      by = Object.fromEntries((await get(s2.baseUrl, '/api/decisions')).body.map((d) => [d.id, d]));
      assert.equal(by[b.id].duplicateOf, a.id, 'the mark is an EVENT: it survives a cold start from the log');
      assert.equal(by[b.id].live, false);
    } finally { await s2.stop(); }
  } finally { try { await s.stop(); } catch { /* already stopped above */ } }
});
