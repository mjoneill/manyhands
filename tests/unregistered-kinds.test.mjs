/**
 * #1215 — THE UNREGISTERED-THING CHECK, through the front door.
 *
 * A write that carries a kind the registry has never heard of is ACCEPTED
 * (nothing lost), MARKED (a standing row names the type, the count and one
 * example), and CLEARED the moment the kind is registered — no resubmit, no
 * second act by the writer. The negative control is the half that matters: a
 * registered kind produces no row, or the check would fire on every card on the
 * board and be dismissed by lunchtime (#824's rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const rowFor = (checks) => (checks.standing || []).find((s) => s.id === 'unregistered-kinds');

// A board whose @graph carries one entity of a type this build has never
// declared. The document builder keeps unmodelled entities verbatim (#804), so
// it reaches the replica with its @type intact — exactly what a foreign
// colleague's first write would look like.
const board = () => {
  const b = makeBoardFixture({ cards: [{ id: 'u-1', shortId: 1, title: 'one', description: '', type: 'task',
    labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-09-01T00:00:00.000Z', relationships: {} }], nextShortId: 2 });
  b._unmodelled = [{ '@id': 'https://scrumboard.local/entity/zz-1', '@type': 'scrum:Gizmo', name: 'a thing nobody declared' }];
  return b;
};

test('#1215 an entity of an UNDECLARED scrum: type is accepted, and the standing check names the type, the count and an example', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const c = await api(srv.baseUrl, 'GET', '/api/checks');
    assert.equal(c.status, 200);
    const row = rowFor(c.body);
    assert.ok(row, 'the standing check exists');
    assert.equal(row.error, undefined, `the check ran: ${row?.error}`);
    const gizmo = (row.rows || []).find((r) => /Gizmo/.test(String(r.type)));
    assert.ok(gizmo, `the undeclared type is MARKED: ${JSON.stringify(row.rows)}`);
    assert.equal(String(gizmo.n), '1');
    assert.match(String(gizmo.example), /zz-1/, 'one example instance, so a reader can go and look');
  } finally { await srv.stop(); }
});

test('#1215 NEGATIVE CONTROL: a REGISTERED kind produces no row — scrum:Card has a thousand instances and must not be reported', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const c = await api(srv.baseUrl, 'GET', '/api/checks');
    const row = rowFor(c.body);
    const types = (row.rows || []).map((r) => String(r.type));
    // ⚠️ The graph returns PREFIXED short IRIs ("scrum:Card"), not full ones. A
    // first version matched /#Card$/, which can never match that spelling, so
    // the control passed with the registry join REMOVED — a test that cannot
    // fail is a decoration. Now it matches either spelling, and the sabotage
    // (join removed) makes exactly this assertion go red.
    const isCard = (t) => /(#|:)Card$/.test(t);
    const isColumn = (t) => /(#|:)Column$/.test(t);
    assert.ok(types.length >= 1, 'precondition: the check produced rows to inspect (the Gizmo row at least)');
    assert.ok(!types.some(isCard), `a declared kind must not be reported: ${types.join(', ')}`);
    assert.ok(!types.some(isColumn), `a declared kind must not be reported: ${types.join(', ')}`);
  } finally { await srv.stop(); }
});

test('#1215 CLEAR: registering the kind removes the row on the next read, with no second act by the writer', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const before = rowFor((await api(srv.baseUrl, 'GET', '/api/checks')).body);
    assert.ok((before.rows || []).some((r) => /Gizmo/.test(String(r.type))), 'precondition: the row is there');
    const reg = await api(srv.baseUrl, 'POST', '/api/kinds', {
      name: 'scrum:Gizmo', by: 'ada', definition: 'a thing a foreign colleague brought; declared after the fact, which is the point',
      createdBy: 'graph_assert',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const after = rowFor((await api(srv.baseUrl, 'GET', '/api/checks')).body);
    assert.ok(!(after.rows || []).some((r) => /Gizmo/.test(String(r.type))), `registered → cleared: ${JSON.stringify(after.rows)}`);
  } finally { await srv.stop(); }
});
