/**
 * #760 — A COLUMN IS RESOLVED ON THE WRITE PATH, OR THE CARD LEAVES THE BOARD.
 *
 * Three measured specimens, all cards that rendered NOWHERE while reading back
 * exactly as sent:
 *   08-09  column:"review"    — #726 and #737, invisible for days
 *   09-04  column:"planned"   — swallowed #778, the card describing this defect
 *   09-05  column:"Backlog"   — the right word in the wrong case, three cards
 *   09-07  column:"planned"   — #915, third specimen, found by its author
 *
 * The asymmetry that names the bug: `card_list` REFUSES an unknown column and
 * says which ones exist; the WRITE path accepted any string and returned 200.
 * Same field, two verbs, and the permissive one was the one that persists.
 *
 * ⚠️ THE FIX IS A LIVE RESOLVE, NOT AN ENUM. #41 shipped user-creatable
 * columns, so a hardcoded allowlist would refuse a legitimate new column and
 * REST callers never see the MCP schema anyway. The test that pins this is
 * "a column created a moment ago is accepted" — it fails against an enum.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession } from './helpers/harness.mjs';

const mk = async (baseUrl, title, extra = {}) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', ...extra }),
  });
  return { status: r.status, body: await r.json() };
};

const patch = async (baseUrl, id, body) => {
  const r = await fetch(`${baseUrl}/api/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();
const list = async (baseUrl) => (await fetch(`${baseUrl}/api/cards`)).json();

test('#760 CREATE refuses a column that does not exist, and creates nothing', async () => {
  const p = await startPair();
  try {
    const before = (await list(p.rest.baseUrl)).length;

    // The 09-05 specimen exactly: the right word in the wrong case.
    const r = await mk(p.rest.baseUrl, 'capital B', { column: 'Backlog' });
    assert.equal(r.status, 400, 'an unknown column must be refused, not stored');
    assert.match(r.body.error, /Backlog/, 'the refusal quotes what was sent');
    assert.match(r.body.error, /backlog/, 'and names the valid ids, or the caller cannot repair it');
    assert.match(r.body.error, /done/, 'every valid id, not just the nearest one');

    const after = await list(p.rest.baseUrl);
    assert.equal(after.length, before, 'a refused create leaves no card behind');
  } finally { await p.stop(); }
});

test('#760 PATCH refuses a column that does not exist, and the card does not move', async () => {
  const p = await startPair();
  try {
    const card = (await mk(p.rest.baseUrl, 'stays put')).body;
    assert.equal(card.column, 'backlog');

    // The control from the card: PATCH {"column":"Nonsense"} used to return 200.
    const r = await patch(p.rest.baseUrl, card.id, { column: 'Nonsense', by: 'ada' });
    assert.equal(r.status, 400, 'an unknown column must be refused on PATCH too');
    assert.match(r.body.error, /Nonsense/);

    const after = await get(p.rest.baseUrl, card.id);
    assert.equal(after.column, 'backlog', 'the card is where it was');
    assert.equal(after.version, card.version,
      'a refused write is a NO-OP: the version must not move, or a concurrent '
      + 'writer\'s ifVersion is invalidated by a write that never happened');
  } finally { await p.stop(); }
});

test('#760 a real column still works on both write paths', async () => {
  const p = await startPair();
  try {
    const born = await mk(p.rest.baseUrl, 'born planned', { column: 'planned' });
    assert.equal(born.status, 201, JSON.stringify(born.body));
    assert.equal(born.body.column, 'planned');

    const moved = await patch(p.rest.baseUrl, born.body.id, { column: 'done', by: 'ada' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await get(p.rest.baseUrl, born.body.id)).column, 'done');
  } finally { await p.stop(); }
});

test('#760 the resolve is LIVE: a column created a moment ago is accepted', async () => {
  // ⛔ THE FALSIFIER FOR THE CHEAP FIX. A static enum, an MCP schema union or a
  // frozen constant all pass every other test in this file and fail this one.
  // #41 shipped add/remove custom columns, so refusing a new column is a
  // regression that would land looking like a fix.
  const p = await startPair();
  try {
    const c = await fetch(`${p.rest.baseUrl}/api/columns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Review' }),
    });
    // ⚠️ ONE read of the body. `await c.text()` inside the assert message
    // consumes it, and the next `c.json()` throws "Body has already been read"
    // — a test failing on its own diagnostic, not on the product.
    const colText = await c.text();
    assert.equal(c.status, 201, colText);
    const col = JSON.parse(colText);

    const card = (await mk(p.rest.baseUrl, 'into the new column', { column: col.id })).body;
    assert.equal(card.column, col.id, 'a column that exists is a column you can write to');

    const back = (await mk(p.rest.baseUrl, 'and back', {})).body;
    assert.equal((await patch(p.rest.baseUrl, back.id, { column: col.id, by: 'ada' })).status, 200);
  } finally { await p.stop(); }
});

test('#760 the two verbs now agree: what card_list refuses, card_move refuses', async () => {
  // The asymmetry as an assertion. The reader has refused this value since
  // #659 and named the valid ids; the writer accepted it and returned 200.
  // The value is the one that ate #915.
  const p = await startPair();
  try {
    const card = (await mk(p.rest.baseUrl, 'the asymmetry')).body;

    const session = await mcpSession(p.mcp.mcpUrl);
    const reader = await session.callTool('card_list', { column: 'no-such-column' });
    const writer = await session.callTool('card_move', { id: String(card.shortId), column: 'no-such-column', by: 'ada' });

    const readText = JSON.stringify(reader);
    const writeText = JSON.stringify(writer);
    assert.match(readText, /unknown column|no-such-column/, 'the reader refuses (it always did)');
    assert.match(writeText, /no-such-column/, 'and the writer names the same value back');
    assert.match(writeText, /400|unknown column/,
      'card_move must REFUSE. A 200 here is the whole defect: the card leaves '
      + 'every column view while the response says it moved.');

    assert.equal((await get(p.rest.baseUrl, card.id)).column, 'backlog',
      'and the card is still somewhere a person can see it');
  } finally { await p.stop(); }
});

test('#760 on CREATE, an absent/empty column still means "backlog" — the guard did not narrow the door', async () => {
  // The regression this nearly shipped: `column: null` has always meant "no
  // opinion" at create (`body.column || 'backlog'`), so resolving it would
  // refuse a write that worked yesterday — a regression wearing a fix's
  // clothes. PATCH is the opposite case and is asserted below.
  const p = await startPair();
  try {
    for (const column of [undefined, null, '']) {
      const r = await mk(p.rest.baseUrl, `column=${String(column)}`, column === undefined ? {} : { column });
      assert.equal(r.status, 201, `create with column=${JSON.stringify(column)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.column, 'backlog');
    }

    // ⇒ AND THE OTHER DIRECTION. On PATCH, null is not "no opinion": it is a
    // caller writing null OVER a real column, which is the invisible-card state
    // by another route.
    const card = (await mk(p.rest.baseUrl, 'not nullable')).body;
    const r = await patch(p.rest.baseUrl, card.id, { column: null, by: 'ada' });
    assert.equal(r.status, 400, 'PATCH column:null must be refused');
    assert.equal((await get(p.rest.baseUrl, card.id)).column, 'backlog');
  } finally { await p.stop(); }
});
