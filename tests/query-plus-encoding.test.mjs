/**
 * #764 — a filter value containing a space must match, whichever way the space
 * was encoded on the wire.
 *
 * The MCP adapter builds its query with URLSearchParams, which form-encodes a
 * space as `+`. server.js parsed the query by hand with decodeURIComponent,
 * which does NOT turn `+` back into a space — so the server searched for a
 * literal `building+scrum+board`, matched nothing, and returned `200 OK` with
 * zero cards.
 *
 * ⛔ THE FAILURE WAS SILENT AND TOTAL. The board's most-used label carried 158
 * cards and was unqueryable by any agent using the MCP tool. Nothing errored;
 * the caller could not tell "no cards match" from "your query was mangled".
 *
 * ⚠️ This is not a label problem and the fix is not to rename the label. Every
 * filter on every route that accepts a value with a space had the same defect —
 * assignee names, `for`, column ids, any future filter. Renaming data to suit a
 * broken parser would have left the parser broken for the next value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const SPACED = 'building scrum board';

function boardWithSpacedLabel() {
  return makeBoardFixture({
    cards: [
      { id: 'c1', shortId: 1, title: 'carries the spaced label', description: '',
        type: 'task', labels: [SPACED], assignees: [], column: 'backlog', order: 0,
        createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
      { id: 'c2', shortId: 2, title: 'carries a different label', description: '',
        type: 'task', labels: ['unrelated'], assignees: [], column: 'backlog', order: 1,
        createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    ],
    nextShortId: 3,
  });
}

test('#764 a spaced label matches when encoded as %20', async () => {
  const s = await startRestServer({ board: boardWithSpacedLabel() });
  try {
    const res = await fetch(`${s.baseUrl}/api/cards?label=${encodeURIComponent(SPACED)}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.cardsTotal, 1, '%20-encoded spaces have always worked — this is the control');
    assert.equal(body.cards[0].shortId, 1);
  } finally { await s.stop(); }
});

test('#764 a spaced label ALSO matches when form-encoded as + — the actual defect', async () => {
  const s = await startRestServer({ board: boardWithSpacedLabel() });
  try {
    // Exactly what URLSearchParams produces, which is exactly what the MCP adapter sends.
    const qs = new URLSearchParams({ label: SPACED }).toString();
    assert.ok(qs.includes('+'), 'sanity: URLSearchParams must form-encode the space as + here');

    const res = await fetch(`${s.baseUrl}/api/cards?${qs}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(
      body.cardsTotal, 1,
      'a + encoded space must decode to a space — otherwise every MCP filter with a '
      + 'spaced value silently returns zero with a 200',
    );
    assert.equal(body.cards[0].shortId, 1);
  } finally { await s.stop(); }
});

test('#764 a genuine literal + in a value survives — %2B must NOT become a space', async () => {
  // ⚠️ The paired control. A fix that replaces every + with a space would pass the
  // test above and corrupt any value legitimately containing a plus. Percent-encoded
  // %2B is the escape hatch and must round-trip unchanged.
  const board = makeBoardFixture({
    cards: [
      { id: 'p1', shortId: 1, title: 'plus card', description: '', type: 'task',
        labels: ['c++'], assignees: [], column: 'backlog', order: 0,
        createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    ],
    nextShortId: 2,
  });
  const s = await startRestServer({ board });
  try {
    const qs = new URLSearchParams({ label: 'c++' }).toString();   // → label=c%2B%2B
    const res = await fetch(`${s.baseUrl}/api/cards?${qs}`);
    const body = await res.json();
    assert.equal(body.cardsTotal, 1, 'a percent-encoded plus must stay a plus, not become a space');
  } finally { await s.stop(); }
});

test('#764 the defect was never label-specific — assignee filters had it too', async () => {
  // The card is titled around one label because that is where it was noticed. The
  // parser is shared, so every spaced filter value on every route was affected.
  const board = makeBoardFixture({
    cards: [
      { id: 'a1', shortId: 1, title: 'assigned to a two-word seat', description: '',
        type: 'task', labels: [], assignees: ['ada grace'], column: 'backlog', order: 0,
        createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    ],
    nextShortId: 2,
  });
  const s = await startRestServer({ board });
  try {
    const qs = new URLSearchParams({ assignee: 'ada grace' }).toString();
    const res = await fetch(`${s.baseUrl}/api/cards?${qs}`);
    const body = await res.json();
    assert.equal(body.cardsTotal, 1, 'the parser is shared; the fix must reach every filter');
  } finally { await s.stop(); }
});
