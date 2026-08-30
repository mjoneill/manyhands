/**
 * #466 condition 2 — the browser's whole-board save is REFUSED when it would
 * revert a card that moved on since the tab loaded.
 *
 * The defect, verbatim from the card: "The client's value is OVERWRITTEN, never
 * COMPARED." `index.html` hydrates from `/api/load` and sends every card back —
 * `version` included, where the card has one — and `handleSave` did
 *
 *     const settled = { ...incomingCard, version: prior.version };
 *
 * so the one token that could detect a stale tab was discarded on arrival.
 * A tab loaded at v1 that saved after a seat PATCHed the card to v2 got a 200
 * and silently put v1's content back. CAS existed on PATCH (#534) and on the
 * memory store; the one caller that can lose the board owner's data did not opt in.
 *
 * THE RULE, and its edges are the tests:
 *   refuse iff  server has an integer version
 *           AND the client's DECLARED version ≠ it (absent counts as ≠)
 *           AND the content differs.
 *   · a stale number with IDENTICAL content is not a revert ⇒ accepted
 *   · a card with no server-side version cannot be compared ⇒ accepted, as
 *     today. That is vacuous on the unversioned share of the board (715 of
 *     988 on 2026-08-30) and closes only as cards get written — said here so
 *     nobody reads "the save is guarded" as "every card is guarded".
 *   · a 409 writes NOTHING. The save is one document; refusing half of it
 *     would be a partial apply nobody asked for.
 *
 * Every test reads the board BACK through /api/load after the save. A 409
 * that still wrote is the defect wearing a status code; a 200 that did not
 * write is #237's class.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const legacyCard = (id, shortId, title) => ({
  id, shortId, title, description: '', type: 'task', assignees: [], labels: [], for: '',
  priority: null, column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
  relationships: { relatedTo: [], blockedBy: [] },
});

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const load = (baseUrl) => api(baseUrl, 'GET', '/api/load').then((r) => r.body);
const save = (baseUrl, snapshot, mutate) => {
  const payload = {
    cards: snapshot.cards.map((c) => ({ ...c })),
    columns: snapshot.columns,
    nextShortId: snapshot.nextShortId,
    lastUpdated: new Date().toISOString(),
  };
  mutate(payload);
  return api(baseUrl, 'POST', '/api/save', payload);
};

/** A board with one server-versioned card (created through the API, so v1). */
async function withVersionedCard(fn) {
  const server = await startRestServer({ board: makeBoardFixture() });
  try {
    const created = await api(server.baseUrl, 'POST', '/api/cards', { title: 'original', createdBy: 'ada' });
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1, 'the fixture must start versioned, or the comparison never runs');
    await fn(server.baseUrl, created.body);
  } finally {
    await server.stop();
  }
}

test('#466 ⛔ a stale tab that would REVERT a PATCHed card is refused 409, and nothing is written', async () => {
  await withVersionedCard(async (baseUrl, card) => {
    const staleTab = await load(baseUrl);                       // holds the card at v1
    const patched = await api(baseUrl, 'PATCH', `/api/cards/${card.id}`, { title: 'moved on by a seat' });
    assert.equal(patched.body.version, 2);

    const res = await save(baseUrl, staleTab, (p) => { p.cards[0].title = 'edited in the stale tab'; });
    assert.equal(res.status, 409, `expected a refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body.staleCards), 'the 409 must NAME the cards, not just say no');
    assert.deepEqual(res.body.staleCards, [{ id: card.id, shortId: card.shortId, yourVersion: 1, currentVersion: 2 }]);
    assert.match(res.body.error, /#1\b/, 'the human-readable error names the card');
    assert.match(res.body.error, /reload/i);

    const after = await load(baseUrl);
    assert.equal(after.cards[0].title, 'moved on by a seat', 'the 409 must not have written the stale content');
    assert.equal(after.cards[0].version, 2, 'the 409 must not have advanced the version');
  });
});

test('#466 NEGATIVE CONTROL — a CURRENT tab with a real edit is accepted and bumped', async () => {
  await withVersionedCard(async (baseUrl, card) => {
    await api(baseUrl, 'PATCH', `/api/cards/${card.id}`, { title: 'moved on by a seat' });
    const currentTab = await load(baseUrl);                     // holds v2
    assert.equal(currentTab.cards[0].version, 2);

    const res = await save(baseUrl, currentTab, (p) => { p.cards[0].title = 'edited by a current tab'; });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const after = await load(baseUrl);
    assert.equal(after.cards[0].title, 'edited by a current tab');
    assert.equal(after.cards[0].version, 3, 'a real edit from a current tab advances the version');
  });
});

test('#466 a stale NUMBER with IDENTICAL content is not a revert — accepted, version untouched', async () => {
  await withVersionedCard(async (baseUrl, card) => {
    const staleTab = await load(baseUrl);                       // v1, title "original"
    await api(baseUrl, 'PATCH', `/api/cards/${card.id}`, { title: 'same words, typed twice' });
    const current = await load(baseUrl);
    // The tab makes the SAME edit the seat made. Content now equals the server's;
    // only the number is behind. Refusing this would be refusing a number.
    const res = await save(baseUrl, staleTab, (p) => { p.cards[0] = { ...current.cards[0], version: 1 }; });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await load(baseUrl);
    assert.equal(after.cards[0].version, 2, 'nothing changed, so nothing bumps');
  });
});

test('#466 a client that carries NO version for a server-versioned card cannot prove currency — refused when it differs', async () => {
  await withVersionedCard(async (baseUrl, card) => {
    const staleTab = await load(baseUrl);
    await api(baseUrl, 'PATCH', `/api/cards/${card.id}`, { title: 'moved on by a seat' });

    const res = await save(baseUrl, staleTab, (p) => { delete p.cards[0].version; p.cards[0].title = 'from a tab with no token'; });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body.staleCards, [{ id: card.id, shortId: card.shortId, yourVersion: null, currentVersion: 2 }]);

    const after = await load(baseUrl);
    assert.equal(after.cards[0].title, 'moved on by a seat');
  });
});

test('#466 a LEGACY card with no server-side version passes as today — the guard is vacuous there, by name', async () => {
  const server = await startRestServer({ board: makeBoardFixture({ cards: [legacyCard('legacy-1', 9, 'never versioned')], nextShortId: 10 }) });
  try {
    const tab = await load(server.baseUrl);
    assert.equal(tab.cards[0].version, undefined, 'the fixture must be unversioned, or this tests the other branch');
    const res = await save(server.baseUrl, tab, (p) => { p.cards[0].title = 'edited'; });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await load(server.baseUrl);
    assert.equal(after.cards[0].title, 'edited');
    assert.equal(after.cards[0].version, 1, 'the first write stamps it, so the NEXT stale tab is caught');
  } finally {
    await server.stop();
  }
});

test('#466 a 409 is ATOMIC — the other card\'s legitimate edit in the same save does not land either', async () => {
  await withVersionedCard(async (baseUrl, card) => {
    const other = await api(baseUrl, 'POST', '/api/cards', { title: 'untouched by anyone else', createdBy: 'ada' });
    const staleTab = await load(baseUrl);                       // both at v1
    await api(baseUrl, 'PATCH', `/api/cards/${card.id}`, { title: 'moved on by a seat' });
    const beforeSave = await load(baseUrl);                     // the board as the PATCH left it

    const res = await save(baseUrl, staleTab, (p) => {
      for (const c of p.cards) {
        if (c.id === card.id) c.title = 'stale revert';
        if (c.id === other.body.id) c.title = 'a legitimate edit riding along';
      }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.staleCards.length, 1, 'only the stale card is named — the other was current');

    const after = await load(baseUrl);
    const otherAfter = after.cards.find((c) => c.id === other.body.id);
    assert.equal(otherAfter.title, 'untouched by anyone else', 'a refused save applies NOTHING, not "everything but the stale card"');
    assert.equal(otherAfter.version, 1);
    assert.equal(after.lastUpdated, beforeSave.lastUpdated, 'the board did not move');
  });
});
