/**
 * #1039 — /api/save must not BLANK a field the client simply never had.
 *
 * WHY THIS EXISTS. `handleSave` replaces `cards` wholesale from the client
 * (server.js ~L447). #230 added a guard for the failure that had already
 * happened: a stale client sending FEWER cards, which deleted them. That guard
 * compares IDs.
 *
 * ⇒ So it is blind to the failure that has not happened yet: a client that
 * sends ALL the ids and omits a FIELD. #209 proposes exactly such a client —
 * hydrate the board's list from a lightweight projection instead of pulling
 * 7.1 MB of descriptions on every load. A projection-hydrated browser sends
 * 930 ids with no `description` key, nothing disappears, the #230 guard stays
 * silent, and every body on the board is replaced with undefined.
 *
 * Measured 2026-08-24: the browser has NO granular card write path —
 * `grep "api/cards/" index.html` → 0, `grep -c PATCH` → 0. The only paths are
 * /api/attachments, /api/conversations, /api/load and /api/save. So /api/save
 * is the ONLY way a description is ever written, which is what makes a guard
 * here both necessary and sufficient.
 *
 * THE DISTINCTION THE FIX TURNS ON, and it is already in the wire format:
 *
 *     key ABSENT        the client never had it (a projection)  ⇒ PRESERVE
 *     description: ""   the user CLEARED it (index.html:2717 uses
 *                       .value.trim(), so an emptied box sends "")  ⇒ TAKE
 *     description: "x"  an ordinary edit  ⇒ TAKE
 *
 * ⇒ An omitted key means "no opinion", never "delete". That is ordinary PATCH
 * semantics applied per-card inside the whole-board save, and it makes partial
 * hydration safe BY CONSTRUCTION rather than by every client remembering.
 *
 * ⚠️ SCOPE: these tests pin `description` only, because that is the field #209
 * drops and the one carrying 85% of the payload. #1039's acceptance requires
 * whoever implements it to STATE whether the guard is description-only or
 * general — a partial guard that reads as general is worse than a narrow one
 * that says so.
 *
 * Fixture identities are ada/bex/cy per #808 — never real seat names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** A fully-hydrated card, as a browser that called /api/load would hold it. */
function fullCard(overrides = {}) {
  return {
    id: 'card-ada-1',
    shortId: 41,
    title: 'A card with a body worth losing',
    description: 'THE BODY THAT MUST SURVIVE — 2,400 words of findings, in effect.',
    type: 'task',
    assignees: ['ada'],
    labels: [],
    for: '',
    priority: 'p1',
    column: 'backlog',
    order: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    relationships: { relatedTo: [], blockedBy: [] },
    // ⚠️ A REAL starting version. Without it every save mints one via #534's
    // `!Number.isInteger(version)` backfill, and a fixture that starts at
    // `undefined` cannot tell a legitimate backfill from a shape-change bump.
    version: 3,
    ...overrides,
  };
}

/** POST a whole-board save exactly the way index.html:1998-2009 does. */
async function save(server, cards, columns) {
  return fetch(`${server.baseUrl}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cards,
      columns,
      nextShortId: 42,
      lastUpdated: new Date().toISOString(),
    }),
  });
}

async function loadCard(server, id) {
  const board = await (await fetch(`${server.baseUrl}/api/load`)).json();
  return board.cards.find((c) => c.id === id);
}

test('#1039 a save that OMITS `description` must not blank the stored one', async () => {
  const server = await startRestServer({ board: makeBoardFixture({ cards: [fullCard()], nextShortId: 42 }) });
  try {
    const before = await loadCard(server, 'card-ada-1');
    assert.ok(before && before.description,
      'precondition: the fixture card must START with a description, or this test proves nothing');
    const original = before.description;

    // A projection-hydrated client: every id present, `description` never known.
    const projected = { ...fullCard() };
    delete projected.description;
    assert.ok(!('description' in projected), 'the payload under test must genuinely omit the key');

    const res = await save(server, [projected], (await (await fetch(`${server.baseUrl}/api/load`)).json()).columns);
    assert.ok(res.ok, `/api/save answered ${res.status}; the browser treats !ok as a failed save`);

    const after = await loadCard(server, 'card-ada-1');
    assert.ok(after, 'the card must still exist — #230 covers disappearance, this test is about blanking');
    assert.equal(after.description, original,
      'THE #1039 DEFECT: a client that never had the description just erased it. '
      + 'All ids were present so the #230 delete-guard stayed silent, and the board '
      + 'reported a successful save. An omitted key means "no opinion", never "delete". '
      + `Stored description is now ${JSON.stringify(after.description)}`);
  } finally {
    await server.stop();
  }
});

/**
 * Raised in review 2026-08-24T08:10Z, pinned as a test rather than trusted either way.
 *
 * Directly below the merge sits #534's version-stamping block, and
 * `cardContentKey` (server.js:2004) stringifies the WHOLE card excluding only
 * `version`. It therefore treats "field ABSENT" and "field CHANGED" identically
 * — correct for concurrency, wrong for a shape change.
 *
 * ⇒ Her concern: a projection save would not merely blank 930 descriptions
 * silently, it would stamp all 930 as legitimately EDITED on the way out. The
 * integrity signal would fire in the destruction's favour, and a wipe that
 * increments every version is indistinguishable from a bulk edit.
 *
 * ⭐ It is closed by ORDERING, not by intent: the version block maps over
 * `merged.cards`, which is already the carryForward result, so by the time
 * cardContentKey compares, the description has fallen through from storage and
 * the keys match. ⚠️ That block's loop variable is NAMED `incomingCard` while
 * holding the MERGED card, which is exactly what makes the other reading
 * plausible.
 *
 * ⇒ So this test is a REGRESSION GUARD ON THE ORDER: move the carryForward
 * below the version block and it fails. Without #1039 at all, it fails too —
 * every card's shape differs, so every card bumps.
 */
test('#1039 a projection save must not BUMP the version of a card it did not change', async () => {
  const stored = [
    fullCard(),
    fullCard({ id: 'card-bex-9', shortId: 49, title: 'Untouched', description: 'also untouched' }),
  ];
  const server = await startRestServer({ board: makeBoardFixture({ cards: stored, nextShortId: 50 }) });
  try {
    const before = await (await fetch(`${server.baseUrl}/api/load`)).json();
    const versionsBefore = Object.fromEntries(before.cards.map((c) => [c.id, c.version]));

    // Every id present, `description` never known — the #209 client.
    const projected = before.cards.map((c) => {
      const p = { ...c };
      delete p.description;
      return p;
    });
    const res = await save(server, projected, before.columns);
    assert.ok(res.ok, `/api/save answered ${res.status}`);

    const after = await (await fetch(`${server.baseUrl}/api/load`)).json();
    for (const c of after.cards) {
      assert.equal(c.version, versionsBefore[c.id],
        `${c.id} was stamped as EDITED by a save that changed nothing about it. `
        + 'A destruction that increments every version is indistinguishable from a bulk edit, '
        + 'and #534’s integrity signal would be supplying the legitimacy. '
        + `was v${versionsBefore[c.id]}, now v${c.version}`);
      assert.equal(c.description, stored.find((s) => s.id === c.id).description,
        'and the body must be intact — the two halves fail together or not at all');
    }
  } finally {
    await server.stop();
  }
});

test('#1039 NEGATIVE CONTROL — an explicit empty string still CLEARS the description', async () => {
  const server = await startRestServer({ board: makeBoardFixture({ cards: [fullCard()], nextShortId: 42 }) });
  try {
    const columns = (await (await fetch(`${server.baseUrl}/api/load`)).json()).columns;
    // index.html:2717 does `.value.trim()`, so an emptied edit box sends "" — present, not absent.
    const res = await save(server, [fullCard({ description: '' })], columns);
    assert.ok(res.ok, `/api/save answered ${res.status}`);

    const after = await loadCard(server, 'card-ada-1');
    assert.equal(after.description, '',
      'A user who deletes all the text in the description box must be able to. '
      + 'This is the control that stops the #1039 guard from becoming "descriptions '
      + 'are now immutable through the browser" — absent and empty MUST behave differently.');
  } finally {
    await server.stop();
  }
});

test('#1039 NEGATIVE CONTROL — an ordinary description EDIT still applies', async () => {
  const server = await startRestServer({ board: makeBoardFixture({ cards: [fullCard()], nextShortId: 42 }) });
  try {
    const columns = (await (await fetch(`${server.baseUrl}/api/load`)).json()).columns;
    const res = await save(server, [fullCard({ description: 'EDITED BY BEX' })], columns);
    assert.ok(res.ok, `/api/save answered ${res.status}`);

    const after = await loadCard(server, 'card-ada-1');
    assert.equal(after.description, 'EDITED BY BEX',
      'the common path: a real edit must still land. Conditions 1 and 2 are both about '
      + 'edge values, and a guard could satisfy them while breaking ordinary editing.');
  } finally {
    await server.stop();
  }
});

/**
 * ⚠️ #230's guard is THRESHOLDED, not absolute:
 *
 *     const MAX_CARDS_DROPPED_PER_SAVE = 2;
 *     if (removed.length > MAX_CARDS_DROPPED_PER_SAVE) → 409
 *
 * Deleting a card IS a legitimate browser action ("the browser deletes ONE card
 * per save, so legitimate saves never cross it"), so the guard targets the
 * stale-clobber SIGNATURE — many cards vanishing at once — not any deletion.
 *
 * ⛔ My first version of this control dropped ONE card and asserted 409. It got
 * 200 and the card was correctly gone, and I was one step from reporting that a
 * correct, shipped p1 guard "does not fire". The threshold constant sits eight
 * lines above the comparison, outside the grep window I had read.
 * ⇒ A GREP WINDOW THAT EXCLUDES THE CONSTANT MAKES A THRESHOLDED GUARD LOOK
 *   UNCONDITIONAL. Both arms are pinned below so the threshold cannot drift
 *   silently in either direction.
 */
test('#1039 NEGATIVE CONTROL — #230’s delete-guard still fires above its threshold', async () => {
  const extra = (n) => fullCard({ id: `card-cy-${n}`, shortId: 40 + n, title: `Card ${n}`, description: `body ${n}` });
  const stored = [fullCard(), extra(2), extra(3), extra(4)];
  const server = await startRestServer({ board: makeBoardFixture({ cards: stored, nextShortId: 50 }) });
  try {
    const columns = (await (await fetch(`${server.baseUrl}/api/load`)).json()).columns;

    // A stale client holding only the first card ⇒ 3 dropped, which is > 2.
    const res = await save(server, [fullCard()], columns);
    assert.equal(res.status, 409,
      '#230 must still refuse a save carrying the stale-clobber signature. This test touches '
      + 'the same handler as the #1039 guard, so the older protection has to be shown still '
      + `working rather than assumed. Got ${res.status}`);

    for (const id of ['card-cy-2', 'card-cy-3', 'card-cy-4']) {
      assert.ok(await loadCard(server, id), `the refused save must not have partially applied (${id} missing)`);
    }
  } finally {
    await server.stop();
  }
});

test('#1039 NEGATIVE CONTROL — a single legitimate deletion is still ALLOWED', async () => {
  const cy = fullCard({ id: 'card-cy-2', shortId: 42, title: 'Second card', description: 'also present' });
  const server = await startRestServer({ board: makeBoardFixture({ cards: [fullCard(), cy], nextShortId: 43 }) });
  try {
    const columns = (await (await fetch(`${server.baseUrl}/api/load`)).json()).columns;

    // Deleting ONE card is what the browser does; it must not be refused.
    const res = await save(server, [fullCard()], columns);
    assert.ok(res.ok,
      'Dropping ONE card is a legitimate browser delete and must still succeed. '
      + 'Without this arm, a future "tighten the guard" change could set the threshold '
      + `to 0 and break deletion entirely while the other control still passed. Got ${res.status}`);
    assert.equal(await loadCard(server, 'card-cy-2'), undefined, 'the deletion must actually apply');
  } finally {
    await server.stop();
  }
});
