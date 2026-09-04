/**
 * #1169 — blockersUpsert keys on a target that is NOT unique.
 *
 * A card may legitimately carry two blockers naming the same person: one
 * cleared months ago, one open now. That is the normal shape of a long-running
 * card where the same human was asked two different questions. The upsert keys
 * on the TARGET, `findIndex` returns the FIRST match, and the write is a whole
 * entry replace — so the caller's note and owner land on the wrong entry, the
 * entry they meant stays untouched, and the API returns 200.
 *
 * Live specimen: a card read "blocked on <person>" for 1h45m after the block
 * was answered, and a prior clearing note was destroyed. Recovered only from a
 * read taken 90 seconds earlier.
 *
 * The remedy under test is the cheapest of the three shapes on the card:
 * REFUSE on ambiguity. It converts a silent wrong write into a loud stop and
 * leaves the caller the whole-array write under ifVersion, which is the only
 * safe spelling today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { patchWithVersion } from './helpers/versioned-patch.mjs';

const card = (id, shortId) => ({
  id, shortId, title: `card ${shortId}`, description: '', type: 'task',
  labels: [], assignees: [], column: 'backlog', order: shortId,
  createdAt: '2026-08-01T00:00:00.000Z',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
});
const board = () => makeBoardFixture({ cards: [card('r-1', 1), card('r-2', 2)], nextShortId: 3 });

// TWO blockers, ONE target. Legitimate: two different questions to one person.
const CLEARED = { person: 'ada', status: 'cleared', owner: 'bo', note: 'FIRST question, answered 08-24' };
const OPEN    = { person: 'ada', status: 'open',    owner: 'bo', note: 'SECOND question, still open' };

async function seeded(blockers, { blockedBy } = {}) {
  const s = await startRestServer({ board: board() });
  try {
    if (blockedBy) {
      const e = await patchWithVersion(s.baseUrl, 1, { by: 'bo', relationships: { blockedBy } });
      assert.equal(e.status, 200, `edge seed failed: ${JSON.stringify(e.body).slice(0, 200)}`);
    }
    const r = await patchWithVersion(s.baseUrl, 1, { by: 'bo', blockers });
    assert.equal(r.status, 200, `seed failed: ${JSON.stringify(r.body).slice(0, 200)}`);
    return s;
  } catch (err) { await s.stop(); throw err; }   // a failed seed must not leak a server
}
const read = async (s) => (await (await fetch(`${s.baseUrl}/api/cards/1`)).json());

test('#1169 an AMBIGUOUS target is REFUSED and writes NOTHING', async () => {
  const s = await seeded([CLEARED, OPEN]);
  try {
    const before = await read(s);
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex',
      blockersUpsert: [{ person: 'ada', status: 'cleared', owner: 'bex', note: 'answered' }],
    });

    assert.equal(r.status, 400,
      `two blockers name 'ada'; the upsert cannot know which was meant, so it must REFUSE — `
      + `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    // ⛔ NAMING THE AMBIGUITY IS THE REMEDY. "invalid request" leaves the caller
    // exactly where the silent wrong-write did.
    const msg = JSON.stringify(r.body);
    assert.ok(msg.includes('ada'), `the refusal must name the ambiguous target — got ${msg.slice(0, 200)}`);

    // ⭐ AND NOTHING MAY HAVE BEEN WRITTEN. A refusal that half-applied would be
    // worse than the defect: the caller is told no and the board says yes.
    const after = await read(s);
    assert.deepEqual(after.blockers, before.blockers,
      'a refused upsert must leave the array byte-identical');
  } finally { await s.stop(); }
});

test('#1169 NEGATIVE CONTROL — exactly ONE match still upserts, and does not touch the other target', async () => {
  const s = await seeded(
    [CLEARED, { card: 2, status: 'open', owner: 'bo', note: 'a card blocker' }],
    { blockedBy: [2] },   // #1041 — ownership must describe an edge that EXISTS
  );
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex',
      blockersUpsert: [{ person: 'ada', status: 'open', owner: 'bo', note: 'reopened' }],
    });
    assert.equal(r.status, 200, `one match must still work — got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const after = await read(s);
    const ada = after.blockers.filter((b) => b.person === 'ada');
    assert.equal(ada.length, 1, 'still exactly one ada entry');
    assert.equal(ada[0].status, 'open', 'and it was updated');
    assert.ok(after.blockers.some((b) => b.card === 2), 'the untouched card blocker survives');
  } finally { await s.stop(); }
});

test('#1169 NEGATIVE CONTROL — ZERO matches still INSERTS', async () => {
  const s = await seeded([CLEARED]);
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex',
      blockersUpsert: [{ person: 'bex', status: 'open', owner: 'bex', note: 'a new target' }],
    });
    assert.equal(r.status, 200, `zero matches must insert — got ${r.status}`);
    const after = await read(s);
    assert.equal(after.blockers.length, 2, 'inserted beside the existing entry');
  } finally { await s.stop(); }
});
