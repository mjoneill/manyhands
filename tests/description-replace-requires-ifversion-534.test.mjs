/**
 * #534 condition 2 — a full `description` REPLACE without `ifVersion` is REFUSED (room decision 3464b457, 2026-11-07).
 *
 * `description` replaces the whole body. Card compare-and-swap shipped 08-24 as OPT-IN, so a seat that sends a full
 * replace built from a stale read silently deletes whatever arrived since — and nothing tells either writer. Measured
 * again 2026-11-09 03:02Z on #1847: a replace built from v5 landed nine seconds after v6 and v6 vanished from the card.
 * #1132 already requires the precondition for the three whole-array fields; this applies the same rail to the body.
 *
 * The decision names three proofs THROUGH THE REAL MCP PATH:
 *   1. a missing ifVersion on a full replace is refused;
 *   2. the current ifVersion succeeds;
 *   3. a concurrent prepend survives a stale replace.
 * Controls: descriptionAppend / descriptionPrepend stay unconditioned (they compose under the write lock), other fields
 * and create are untouched, and an EMPTY description is a replace (a clear) like any other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, startPair, mcpSession } from './helpers/harness.mjs';

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'one', description: 'the original body', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z', relationships: {}, version: 3 },
  ],
  nextShortId: 2,
});

const text = (r) => r.result?.content?.[0]?.text ?? '';
const cardOf = async (session) => JSON.parse(text(await session.callTool('card_get', { id: '1' })));

test('D1 (proof 1, REST) a full description replace with no ifVersion is REFUSED, names the fix, and writes nothing — an empty body (a clear) too', async () => {
  const s = await startRestServer({ board: board() });
  try {
    for (const description of ['a rewritten body', '']) {
      const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'ada', description });
      assert.equal(r.status, 400, `${JSON.stringify(description)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /ifVersion/, 'names the precondition');
      assert.match(r.body.error, /descriptionAppend|descriptionPrepend/, 'names the verbs that need none');
      const after = (await api(s.baseUrl, 'GET', '/api/cards/1')).body;
      assert.equal(after.description, 'the original body', 'nothing was written');
      assert.equal(after.version, 3, 'and the version did not move');
    }
  } finally { await s.stop(); }
});

test('D2 (proofs 1 and 2, MCP) card_update with description and no ifVersion is refused; with the version just read it lands', async () => {
  const p = await startPair({ board: board() });
  try {
    const session = await mcpSession(p.mcp.mcpUrl);
    const refused = await session.callTool('card_update', { id: '1', by: 'ada', description: 'rewritten' });
    assert.ok(refused.result?.isError || /ifVersion/.test(text(refused)), `refused: ${text(refused).slice(0, 200)}`);
    assert.match(text(refused), /ifVersion/);
    assert.equal((await cardOf(session)).description, 'the original body', 'the refusal wrote nothing');
    const v = (await cardOf(session)).version;
    const ok = await session.callTool('card_update', { id: '1', by: 'ada', ifVersion: v, description: 'rewritten', return: 'id' });
    assert.ok(!ok.result?.isError, text(ok).slice(0, 200));
    assert.equal((await cardOf(session)).description, 'rewritten', 'with the current version the replace lands');
  } finally { await p.stop(); }
});

test('D3 (proof 3, MCP) a concurrent prepend SURVIVES a stale replace: the replace built from the old read is a 409, and the prepend is still there', async () => {
  const p = await startPair({ board: board() });
  try {
    const session = await mcpSession(p.mcp.mcpUrl);
    const read = await cardOf(session);   // writer A reads v3 and starts composing a full rewrite
    const pre = await session.callTool('card_update', { id: '1', by: 'bo', descriptionPrepend: 'CORRECTION FIRST\n', return: 'id' });
    assert.ok(!pre.result?.isError, `the prepend needs no precondition: ${text(pre).slice(0, 200)}`);
    const stale = await session.callTool('card_update', { id: '1', by: 'ada', ifVersion: read.version, description: `${read.description} (edited)` });
    assert.ok(stale.result?.isError || /moved on|409/.test(text(stale)), `the stale replace is refused: ${text(stale).slice(0, 200)}`);
    const now = await cardOf(session);
    assert.ok(now.description.startsWith('CORRECTION FIRST\n'), `the prepend survived: ${JSON.stringify(now.description.slice(0, 60))}`);
    assert.ok(!now.description.includes('(edited)'), 'and the stale body did not land');
  } finally { await p.stop(); }
});

test('D5 (#1782) a card with NO stored version: two writers who both read it and send ifVersion 0 cannot both win — the first stamps version 1, the second is a 409, and its body does not land', async () => {
  // #1782 asked whether `ifVersion: 0` matching a MISSING version lets a stale writer through. It cannot, as long as
  // every accepted write stamps a version (bumpCardVersion, #534's one rule): "missing" then means "never written since
  // import", which is exactly what a 0-sender read. The browser sends 0 for such a card (index.html, #1583), so
  // refusing 0 outright would break its edits; this row pins the property that makes accepting it safe.
  const s = await startRestServer({ board: makeBoardFixture({
    cards: [{ id: 'u-9', shortId: 9, title: 'imported', description: 'as imported', type: 'task', labels: [], assignees: [],
      column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} }],
    nextShortId: 10,
  }) });
  try {
    const before = (await api(s.baseUrl, 'GET', '/api/cards/9')).body;
    assert.ok(!Number.isInteger(before.version) || before.version === 0, `CONTROL: the fixture card carries no version (${before.version})`);
    const first = await api(s.baseUrl, 'PATCH', '/api/cards/9', { by: 'ada', ifVersion: 0, description: 'ada rewrote it' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.version, 1, 'the first accepted write stamps version 1');
    const second = await api(s.baseUrl, 'PATCH', '/api/cards/9', { by: 'bo', ifVersion: 0, description: 'bo rewrote it from the same read' });
    assert.equal(second.status, 409, `the second writer read the same version-less card and is refused: ${JSON.stringify(second.body)}`);
    assert.equal((await api(s.baseUrl, 'GET', '/api/cards/9')).body.description, 'ada rewrote it', 'ada\'s write survived');
  } finally { await s.stop(); }
});

test('D4 CONTROLS: append and prepend need no ifVersion; title, column and labels are untouched; create with a description still works', async () => {
  const s = await startRestServer({ board: board() });
  try {
    for (const patch of [{ descriptionAppend: '\nmore' }, { descriptionPrepend: 'first\n' }, { title: 'renamed' }, { column: 'planned' }, { labels: ['x'] }]) {
      const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', { by: 'ada', ...patch });
      assert.equal(r.status, 200, `${Object.keys(patch)[0]} without ifVersion: ${JSON.stringify(r.body)}`);
    }
    const c = await api(s.baseUrl, 'POST', '/api/cards', { title: 'fresh', createdBy: 'ada', description: 'a new body' });
    assert.equal(c.status, 201, `create has no prior version to compare: ${JSON.stringify(c.body)}`);
    assert.equal(c.body.description, 'a new body');
  } finally { await s.stop(); }
});
