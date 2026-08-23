/**
 * #534 slice 2 — OPT-IN compare-and-swap on card PATCH.
 *
 * The precondition #466 specified on 2026-07-25 and #534 has carried three
 * observed instances of, now on the surface that DESTROYS data rather than
 * forking it. Slice 1 (server-controlled monotonic version, incl. handleSave)
 * is what makes this honest; it must not ship without that, and test 5 is why.
 *
 * ⛔ OPT-IN BY CONSTRUCTION. A caller sending no `ifVersion` is unaffected —
 * that is every existing writer, the browser included. This adds a CAPABILITY;
 * it does not fix the DEFAULT, and claiming otherwise would be the overclaim
 * #534 exists to prevent.
 *
 * 400 vs 409, established in 7b4f909 on the memory surface and reused verbatim:
 *   400 = the shape is wrong    (checked OUTSIDE the lock, needs no board state)
 *   409 = the shape is right and the value is stale (INSIDE, before the mutation)
 * A type error answered with 409 sends a retrying client into a loop with no
 * exit, because 409 is the one a client may legitimately retry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const NEW_CARD = { title: 'cas probe', description: 'ORIGINAL', createdBy: 'ada' };

test('#534 omitting ifVersion is UNCHANGED behaviour — the precondition is opt-in', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;
    const u1 = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`, { descriptionAppend: ' +A' });
    assert.equal(u1.status, 200, 'a caller that does not opt in must never be refused');
    const u2 = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`, { descriptionAppend: ' +B' });
    assert.equal(u2.status, 200, 'still unaffected on a subsequent write');
    assert.equal(u2.body.description, 'ORIGINAL +A +B', 'and both edits landed');
  } finally { await s.stop(); }
});

test('#534 a CORRECT ifVersion is accepted and advances the version', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const ok = await api(s.baseUrl, 'PATCH', `/api/cards/${c.body.id}`,
      { descriptionAppend: ' +A', ifVersion: c.body.version });
    assert.equal(ok.status, 200, `a matching precondition must succeed: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.version, c.body.version + 1);
    assert.equal(ok.body.description, 'ORIGINAL +A');
  } finally { await s.stop(); }
});

test('#534 ⭐ a STALE ifVersion is REFUSED with 409, and the other writer survives', async () => {
  // ⭐⭐⭐ THE LOAD-BEARING TEST, and it is #534's founding incident as an
  // assertion: writer A holds a body read before writer B appended to it, and
  // full-replaces from that stale snapshot. Today that returns 200 and B's
  // paragraph is gone with nothing anywhere reporting it.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;
    const versionAHolds = c.body.version;

    // B appends. This is the write that must survive.
    const b = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`, { descriptionAppend: ' +B FINDING' });
    assert.equal(b.status, 200);
    assert.ok(b.body.version > versionAHolds, "B must have moved it, or this asserts nothing");

    // A full-replaces from its stale snapshot, declaring the version it read.
    const stale = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`,
      { description: 'ORIGINAL +A EDIT', ifVersion: versionAHolds });
    assert.equal(stale.status, 409, `a stale precondition must be refused: ${JSON.stringify(stale.body)}`);
    assert.equal(stale.body.currentVersion, b.body.version,
      'the 409 must carry the current version, or the caller can only retry blind');

    // ⭐ ANTI-VACUITY. A 409 that still wrote would be worse than no precondition
    // at all: the caller is told it yielded while its text landed.
    const after = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.equal(after.body.description, 'ORIGINAL +B FINDING',
      "B's write must survive and A's must not have landed");
    assert.equal(after.body.version, b.body.version, 'a refused write must not advance the version');
  } finally { await s.stop(); }
});

test('#534 a MALFORMED ifVersion is refused at the TYPE boundary with 400, never 409', async () => {
  // Same class as 7b4f909 on the memory surface. Coercion is NOT the fix:
  // Number('2abc') is NaN and NaN !== current for every current, so coercion
  // leaves the unclearable 409 intact on malformed input while silently
  // accepting null as 0 and true as 1.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;
    const v = c.body.version;

    for (const bad of [String(v), 1.5, null, true, Number.NaN, [], {}]) {
      const r = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`,
        { descriptionAppend: ' X', ifVersion: bad });
      assert.equal(r.status, 400,
        `ifVersion: ${JSON.stringify(bad)} must be 400 (malformed), not ${r.status}. `
        + `Got ${JSON.stringify(r.body)}`);
    }

    const after = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.equal(after.body.description, 'ORIGINAL', 'a refused request must not change the card');
    assert.equal(after.body.version, v, 'a refused request must not advance the version');

    const ok = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`,
      { descriptionAppend: ' OK', ifVersion: v });
    assert.equal(ok.status, 200, 'a well-formed integer precondition still succeeds');
  } finally { await s.stop(); }
});

test('#534 ⭐⭐ THE COUPLING: a whole-board SAVE between read and write cannot produce a FALSE PASS', async () => {
  // ⭐⭐⭐ This is the reason slice 1 had to land first, as an executable
  // assertion rather than an argument. The sequence, every step of which this
  // board has already reproduced:
  //
  //   1 card at vN            2 a seat reads it, holds vN
  //   3 another seat PATCHes  ⇒ vN+1
  //   4 the browser whole-board saves — WITHOUT slice 1 this writes the
  //     client's stale version back, or erases the field entirely
  //   5 the seat holding vN sends ifVersion: vN
  //
  // Before slice 1, step 5 PASSES against a card that moved twice — a
  // precondition reporting "you are current" in exactly the case it exists to
  // catch. This test fails loudly if handleSave ever stops computing the version.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;
    const versionSeatHolds = c.body.version;

    // 3 — another seat PATCHes.
    await api(s.baseUrl, 'PATCH', `/api/cards/${id}`, { descriptionAppend: ' +OTHER SEAT' });

    // 4 — the browser saves a board it hydrated BEFORE that PATCH: its copy of
    // the card still carries the old version and the old body.
    const board = await api(s.baseUrl, 'GET', '/api/board');
    const staleBoard = JSON.parse(JSON.stringify(board.body));
    for (const card of staleBoard.cards) {
      if (card.id === id) { card.version = versionSeatHolds; card.description = 'ORIGINAL'; }
    }
    const save = await api(s.baseUrl, 'POST', '/api/save', {
      cards: staleBoard.cards, columns: staleBoard.columns, nextShortId: staleBoard.nextShortId,
    });
    assert.ok(save.status < 400, `the save itself should not error: ${JSON.stringify(save.body)}`);

    // 5 — the seat still holding the ORIGINAL version tries to write.
    const attempt = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`,
      { description: 'CLOBBER FROM STALE SEAT', ifVersion: versionSeatHolds });
    assert.equal(attempt.status, 409,
      'a save must not be able to make a stale precondition pass. '
      + `Got ${attempt.status}: ${JSON.stringify(attempt.body)}`);
  } finally { await s.stop(); }
});

test('#534 ifVersion is a VERB, not a field — never stored, never reported as ignored', async () => {
  // #864's lesson, applied before it can bite: a verb in a field allowlist gets
  // stored as a noun. And reporting a field that WAS consumed in `ignoredFields`
  // tells the caller the opposite of what happened.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;
    const r = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`,
      { descriptionAppend: ' +A', ifVersion: c.body.version });
    assert.equal(r.status, 200);
    assert.ok(!(r.body.ignoredFields || []).includes('ifVersion'),
      `ifVersion was consumed, so it must not be reported ignored: ${JSON.stringify(r.body.ignoredFields)}`);

    const raw = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.equal(raw.body.ifVersion, undefined, 'ifVersion must never be stored on the card');
  } finally { await s.stop(); }
});
