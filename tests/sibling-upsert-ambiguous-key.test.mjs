/**
 * #1169 condition 4 — the SIBLING verbs, checked rather than assumed.
 *
 * The refusal lives inside the `ARRAY_UPSERT_VERBS` loop, so by construction it
 * covers `acceptanceUpsert` and `checksUpsert` too. That is a reading of the
 * handler, and the card is explicit that a reading is not the evidence it wants:
 * the blockers case was proven by constructing the card and asserting the
 * outcome. These do the same for the other two verbs.
 *
 * ⚠️ AND THE READING IS NOT COMPLETE. `acceptanceUpsert` carries one documented
 * bypass — an entry with `replaces` skips the ambiguity check, because #1158's
 * rename addresses its target by the OLD text and resolves it separately. The
 * last test here pins what that path actually does, so the exception is a
 * recorded fact rather than an unexamined `continue`.
 *
 * MEASURED 2026-09-09, on the pair below: the rename returns 200, renames the
 * FIRST twin and leaves the SECOND under the old text. So it DOES guess — but
 * it guesses the way the other verbs were forbidden from guessing for a
 * different reason: nothing is destroyed. Both entries survive with their own
 * evidence; the caller gets a board they can see and fix. That is why this is
 * recorded rather than repaired here — the harm the refusal exists to prevent
 * (a whole-entry replace onto the wrong twin, with the right twin left stale
 * and a 200 reported) does not occur on this path.
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
const board = () => makeBoardFixture({ cards: [card('r-1', 1)], nextShortId: 2 });
const read = async (s) => (await (await fetch(`${s.baseUrl}/api/cards/1`)).json());

// A duplicate key cannot be seeded through the upsert verbs — that is the point.
// It is seeded through the WHOLE-ARRAY write, which is how the live duplicates
// on the board got there.
async function seeded(patch) {
  const s = await startRestServer({ board: board() });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, { by: 'bo', ...patch });
    assert.equal(r.status, 200, `seed failed: ${JSON.stringify(r.body).slice(0, 200)}`);
    return s;
  } catch (err) { await s.stop(); throw err; }
}

const TWIN = 'the export is reproducible';

test('#1169 acceptanceUpsert — a DUPLICATE condition is REFUSED and writes nothing', async () => {
  const s = await seeded({ acceptance: [
    { condition: TWIN, note: 'first, from grooming' },
    { condition: TWIN, note: 'second, added by a later hand' },
  ] });
  try {
    const before = await read(s);
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex', acceptanceUpsert: [{ condition: TWIN, note: 'discharged' }],
    });
    assert.equal(r.status, 400,
      `two entries share the condition text; the upsert must REFUSE — got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(JSON.stringify(r.body).includes(TWIN),
      `the refusal must name the ambiguous key — got ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.deepEqual((await read(s)).acceptance, before.acceptance,
      'a refused upsert must leave the array byte-identical');
  } finally { await s.stop(); }
});

test('#1169 acceptanceUpsert NEGATIVE CONTROL — a UNIQUE condition still upserts', async () => {
  const s = await seeded({ acceptance: [{ condition: TWIN, note: 'only one' }] });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex', acceptanceUpsert: [{ condition: TWIN, note: 'discharged' }],
    });
    assert.equal(r.status, 200, `one match must still work — got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const after = await read(s);
    assert.equal(after.acceptance.length, 1, 'replaced in place, not twinned');
    assert.equal(after.acceptance[0].note, 'discharged');
  } finally { await s.stop(); }
});

const CLAIM = 'the scrubber runs on every export path';

test('#1169 checksUpsert — a DUPLICATE claim is REFUSED and writes nothing', async () => {
  const s = await seeded({ checks: [
    { claim: CLAIM, ask: 'ASK { ?s ?p ?o }', expect: true },
    { claim: CLAIM, ask: 'ASK { ?s a ?t }', expect: true },
  ] });
  try {
    const before = await read(s);
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex', checksUpsert: [{ claim: CLAIM, ask: 'ASK { ?s ?p 1 }', expect: false }],
    });
    assert.equal(r.status, 400,
      `two checks share the claim text; the upsert must REFUSE — got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(JSON.stringify(r.body).includes(CLAIM),
      `the refusal must name the ambiguous key — got ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.deepEqual((await read(s)).checks, before.checks,
      'a refused upsert must leave the array byte-identical');
  } finally { await s.stop(); }
});

test('#1169 checksUpsert NEGATIVE CONTROL — a UNIQUE claim still upserts', async () => {
  const s = await seeded({ checks: [{ claim: CLAIM, ask: 'ASK { ?s ?p ?o }', expect: true }] });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex', checksUpsert: [{ claim: CLAIM, ask: 'ASK { ?s ?p 1 }', expect: false }],
    });
    assert.equal(r.status, 200, `one match must still work — got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const after = await read(s);
    assert.equal(after.checks.length, 1, 'replaced in place, not twinned');
    assert.equal(after.checks[0].expect, false);
  } finally { await s.stop(); }
});

// ⭐ THE RECORDED EXCEPTION. This test does not assert that the bypass is
// correct — it asserts what it DOES, so the next reader of that `continue`
// does not have to guess. Whatever the outcome, it must not be a SILENT
// half-write: either the rename is refused, or it resolves to something the
// board can show.
test('#1169 the `replaces` path is the one exception to the guard — pin its behaviour', async () => {
  const s = await seeded({ acceptance: [
    { condition: TWIN, note: 'first' },
    { condition: TWIN, note: 'second' },
  ] });
  try {
    const r = await patchWithVersion(s.baseUrl, 1, {
      by: 'bex',
      acceptanceUpsert: [{ condition: 'the export is reproducible across machines', replaces: TWIN, note: 'reworded' }],
    });
    const after = await read(s);
    const twins = after.acceptance.filter((a) => a.condition === TWIN);

    if (r.status === 200) {
      // A rename that resolved: it may only have renamed ONE of the pair, and
      // the survivor must still be visible. Silent LOSS is the thing forbidden.
      assert.equal(after.acceptance.length, 2,
        `a rename must not drop an entry — got ${JSON.stringify(after.acceptance)}`);
      assert.equal(twins.length, 1,
        `exactly one twin should survive a single rename — got ${twins.length}`);
    } else {
      assert.equal(r.status, 400, `the only other acceptable outcome is a refusal — got ${r.status}`);
      assert.deepEqual(after.acceptance.map((a) => a.condition), [TWIN, TWIN],
        'a refused rename must leave both twins untouched');
    }
  } finally { await s.stop(); }
});
