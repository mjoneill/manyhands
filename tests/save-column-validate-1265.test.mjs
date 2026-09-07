/**
 * #1265 — the LAST unguarded column write: `/api/save`.
 *
 * #760 closed `card_create` and `PATCH /api/cards/:id` by resolving the column
 * against the board's own column list. `/api/save` was left, and it is the one
 * surface that could still write any string at all: it takes the `cards` array
 * WHOLESALE, so a column value arrives from the client untouched.
 *
 * #760's four specimens are what this prevents — a card rendered in no column
 * at all, invisible for days, because "planned" or "Backlog" is not an id:
 *
 *     08-09  "review"    #726 #737 invisible for days
 *     09-04  "planned"   #778
 *     09-05  "Backlog"   three cards
 *     09-07  "planned"   #915
 *
 * ⛔ AND IT NEEDS A DIFFERENT RULE FROM #760's, which is why it was left a note
 * rather than folded into that fix. `/api/save` can legitimately ADD a column
 * and move cards into it IN THE SAME REQUEST — `deleteColumn` does exactly that
 * with the Orphanage. So validating against the STORED columns would refuse a
 * correct save. The set to check against is the one the save is ESTABLISHING.
 *
 * That distinction is the whole card, so it is the test written first below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const COLUMNS = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'in-progress', name: 'In Progress' },
  { id: 'done', name: 'Done' },
];

const card = (over = {}) => ({
  id: 'c1', shortId: 1, title: 'a card', column: 'backlog', description: '', version: 1, ...over,
});

const fixture = () => ({
  cards: [card()],
  columns: COLUMNS.map((c) => ({ ...c })),
  nextShortId: 2,
});

async function withServer(fn) {
  const rest = await startRestServer({ board: fixture() });
  try {
    return await fn(rest);
  } finally {
    await rest.stop();
  }
}

const save = (rest, payload) =>
  fetch(`${rest.baseUrl}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const board = async (rest) => (await fetch(`${rest.baseUrl}/api/load`)).json();

test('#1265 ⭐ THE RULE — a save may ADD a column and move a card into it IN ONE REQUEST', async () => {
  // The falsifier. An implementation that checks against the STORED columns
  // refuses this, and it is a legitimate save: deleteColumn does exactly this
  // shape when it creates the Orphanage and moves the orphans into it.
  await withServer(async (rest) => {
    const res = await save(rest, {
      columns: [...COLUMNS, { id: 'orphanage', name: 'Orphanage' }],
      cards: [card({ column: 'orphanage' })],
    });
    assert.equal(res.status, 200, `a column introduced by this same save must be valid: ${await res.text()}`);
    const after = await board(rest);
    assert.equal(after.cards[0].column, 'orphanage');
    assert.ok(after.columns.some((c) => c.id === 'orphanage'), 'and the column is there');
  });
});

test('#1265 — a column that exists NOWHERE is refused, and the valid ids are named', async () => {
  await withServer(async (rest) => {
    const res = await save(rest, { cards: [card({ column: 'planned' })] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /planned/, 'the refusal names the bad value');
    for (const id of ['backlog', 'in-progress', 'done']) {
      assert.ok(body.error.includes(id), `the refusal must name the valid id ${id}`);
    }
  });
});

test('#1265 ⛔ A REFUSAL WRITES NOTHING — not the card, not the columns, not the version', async () => {
  // #760's acceptance carried this property and it matters more here: the save
  // is ONE document, so a partial apply would be a board nobody asked for. And
  // a version that moved on a refused write would invalidate a concurrent
  // writer's ifVersion for a write that never happened.
  await withServer(async (rest) => {
    const before = await board(rest);
    const res = await save(rest, {
      columns: [...COLUMNS, { id: 'newcol', name: 'New' }],
      cards: [card({ column: 'planned', title: 'CHANGED' })],
    });
    assert.equal(res.status, 400);

    const after = await board(rest);
    assert.equal(after.cards[0].column, 'backlog', 'the column did not move');
    assert.equal(after.cards[0].title, before.cards[0].title, 'the title did not change');
    assert.equal(after.cards[0].version, before.cards[0].version, 'the version did not move');
    assert.equal(after.columns.length, before.columns.length, 'the new column was not created either');
  });
});

test('#1265 — case matters: "Backlog" is refused while "backlog" is accepted', async () => {
  // The 09-05 specimen: three cards written to "Backlog", the NAME, not the id.
  await withServer(async (rest) => {
    assert.equal((await save(rest, { cards: [card({ column: 'Backlog' })] })).status, 400);
    assert.equal((await save(rest, { cards: [card({ column: 'backlog', title: 'ok' })] })).status, 200);
  });
});

test('#1265 — a column NAME is refused even when it is a real column\'s name', async () => {
  // "In Progress" is a real column's display name and is not an id. This is the
  // specimen class, not a synthetic string.
  await withServer(async (rest) => {
    const res = await save(rest, { cards: [card({ column: 'In Progress' })] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /In Progress/);
  });
});

test('#1265 — an omitted `columns` validates against the STORED set (absent means no opinion)', async () => {
  // #1039's rule: an absent key is a projection, never a delete. A client that
  // sends only cards is still bound by the columns the board already has.
  await withServer(async (rest) => {
    assert.equal((await save(rest, { cards: [card({ column: 'done' })] })).status, 200);
    assert.equal((await save(rest, { cards: [card({ column: 'nope' })] })).status, 400);
  });
});

test('#1265 — a card with NO column, or null, is not refused', async () => {
  // Matching create, where `column` absent has always meant "no opinion".
  // Refusing it would be a regression wearing a fix's clothes — the exact trap
  // this card names about `column: null` at create.
  await withServer(async (rest) => {
    assert.equal((await save(rest, { cards: [{ id: 'c2', shortId: 2, title: 'no column', version: 1 }] })).status, 200);
    assert.equal((await save(rest, { cards: [{ id: 'c3', shortId: 3, title: 'null column', column: null, version: 1 }] })).status, 200);
  });
});

test('#1265 — EVERY bad card is named, not just the first', async () => {
  // A refusal that names one of four sends the client back three more times.
  await withServer(async (rest) => {
    const res = await save(rest, {
      cards: [
        card({ id: 'a', shortId: 10, column: 'planned' }),
        card({ id: 'b', shortId: 11, column: 'review' }),
        card({ id: 'c', shortId: 12, column: 'backlog' }),
      ],
    });
    assert.equal(res.status, 400);
    const err = (await res.json()).error;
    assert.match(err, /planned/);
    assert.match(err, /review/);
  });
});

test('#1265 — a REMOVED column cannot be left behind under a card', async () => {
  // The mirror of the Orphanage case: a save that deletes a column must not
  // strand a card pointing at it. Validating against the incoming set catches
  // this for free, and validating against the stored set would MISS it.
  await withServer(async (rest) => {
    const res = await save(rest, {
      columns: COLUMNS.filter((c) => c.id !== 'done'),
      cards: [card({ column: 'done' })],
    });
    assert.equal(res.status, 400, 'a card left in a column this save deletes must refuse');
    assert.match((await res.json()).error, /done/);
  });
});
