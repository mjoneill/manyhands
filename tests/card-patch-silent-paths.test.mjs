/**
 * #831 — the two remaining fail-silent paths in the PATCH loop.
 *
 * Both found by the three-list sweep, both #823-class, both in the same
 * `for (const [k, v] of Object.entries(patch))` loop, and both invisible to
 * the `ignoredFields` diagnostic that loop already carries.
 *
 * ── 1. `assignee` (VALIDATED_THEN_DISCARDED) ──────────────────────────────
 * `assignee` is in PATCHABLE_CARD_FIELDS, so the loop reaches `card[k] = v`
 * and writes a RAW `assignee` key onto the stored card. Create does not do
 * this — createCardFromPayload normalizes the singular alias into `assignees`.
 * So PATCH returns 200, reports nothing ignored, leaves `assignees` unchanged,
 * and leaves a phantom key behind.
 *
 * ⚠️ Worse than a silent drop: it WRITES something. A caller inspecting the
 * stored card sees `assignee: 'grace'` and reasonably concludes it worked.
 * The reverse-direction enumeration in #831's coverage check found two live
 * cards carrying that stray key — this is the path that put it there.
 *
 * ── 2. `createdBy` (DECLARED_NOT_CONSUMED) ────────────────────────────────
 * IMMUTABLE_CARD_FIELDS is skipped by a `continue` that runs BEFORE the
 * ignoredFields push. Refusing the field is CORRECT (#631 — authorship is a
 * fact about the past). Refusing it SILENTLY is the thing #823 exists to
 * prevent: 200, no diagnostic, intent voided.
 *
 * ⭐ `ignored` and `refused` are DIFFERENT FACTS and the response says so
 * separately. "I did not recognise this" and "I recognised it and will not let
 * you change it" call for different actions from the caller — collapsing them
 * would make a typo and a policy violation indistinguishable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

async function create(baseUrl, body = {}) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'patch probe', createdBy: 'ada', ...body }),
  });
  return res.json();
}

async function patch(baseUrl, shortId, body) {
  const res = await fetch(`${baseUrl}/api/cards/${shortId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'ada', ...body }),
  });
  return { status: res.status, body: await res.json() };
}

const fresh = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

// ── 1. the singular alias must normalize, exactly as create does ──────────

test('#831 PATCH assignee normalizes into assignees, and leaves no phantom key', async () => {
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl);
    assert.deepEqual(c.assignees, ['unassigned']);          // control: the before-state

    const r = await patch(server.baseUrl, c.shortId, { assignee: 'grace' });
    assert.equal(r.status, 200);

    const after = await fresh(server.baseUrl, c.shortId);
    assert.deepEqual(after.assignees, ['grace'], 'the alias must take effect, as it does at create');
    assert.equal(after.assignee, undefined, 'and must NOT leave a raw `assignee` key on the card');
  } finally {
    await server.stop();
  }
});

test('#831 PATCH assignee still refuses an invalid key', async () => {
  // The anti-overreach control: normalizing must not smuggle past validation.
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl);
    const bad = await patch(server.baseUrl, c.shortId, { assignee: 'not a key!!' });
    assert.equal(bad.status, 400, 'validateCardFields still guards the alias');

    const sentinel = await patch(server.baseUrl, c.shortId, { assignee: 'both' });
    assert.equal(sentinel.status, 400, '#508 retired sentinel stays refused');
  } finally {
    await server.stop();
  }
});

test('#831 PATCH assignees (plural) is unaffected', async () => {
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl);
    const r = await patch(server.baseUrl, c.shortId, { assignees: ['ada', 'grace'] });
    assert.equal(r.status, 200);
    const after = await fresh(server.baseUrl, c.shortId);
    assert.deepEqual(after.assignees, ['ada', 'grace']);
  } finally {
    await server.stop();
  }
});

// ── 2. an immutable field must be REFUSED OUT LOUD ───────────────────────

test('#831 PATCH reports an immutable field as refused, not silently dropped', async () => {
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl, { createdBy: 'ada' });
    const r = await patch(server.baseUrl, c.shortId, { createdBy: 'grace', title: 'renamed' });

    assert.equal(r.status, 200, '#249 forward-compat: the write still succeeds');
    assert.equal(r.body.title, 'renamed', 'control: the legal half of the patch landed');
    assert.deepEqual(r.body.refusedFields, ['createdBy'], 'the caller must learn their intent was voided');

    const after = await fresh(server.baseUrl, c.shortId);
    assert.equal(after.createdBy, 'ada', 'and authorship is still immutable (#631)');
  } finally {
    await server.stop();
  }
});

test('#831 refused and ignored are reported SEPARATELY', async () => {
  // A typo and a policy violation are different facts and want different
  // actions. Collapsing them into one list would make them indistinguishable.
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl);
    const r = await patch(server.baseUrl, c.shortId, {
      createdBy: 'grace',      // immutable  -> refused
      titel: 'typo',           // unknown    -> ignored
      title: 'real',           // known      -> applied
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.refusedFields, ['createdBy']);
    assert.deepEqual(r.body.ignoredFields, ['titel']);
    assert.equal(r.body.title, 'real');
  } finally {
    await server.stop();
  }
});

test('#831 a clean PATCH reports neither list', async () => {
  // The paired control #829 established: a guard that fires without
  // provocation is a false-alarm generator, and noise is what gets real
  // findings ignored.
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl);
    const r = await patch(server.baseUrl, c.shortId, { title: 'clean' });
    assert.equal(r.status, 200);
    assert.equal(r.body.refusedFields, undefined, 'nothing refused, so no key');
    assert.ok(
      r.body.ignoredFields === undefined || r.body.ignoredFields.length === 0,
      `nothing ignored either — got ${JSON.stringify(r.body.ignoredFields)}`,
    );
  } finally {
    await server.stop();
  }
});

test('#831 `by` is meta and is neither refused nor ignored', async () => {
  // #675 — `by` travels WITH the write and is not a field OF the card. It must
  // not show up in either diagnostic, or every well-formed patch reports noise.
  const server = await startRestServer();
  try {
    const c = await create(server.baseUrl);
    const r = await patch(server.baseUrl, c.shortId, { title: 'x' });   // `by` added by helper
    assert.equal(r.body.refusedFields, undefined);
    assert.ok(r.body.ignoredFields === undefined || !r.body.ignoredFields.includes('by'));
  } finally {
    await server.stop();
  }
});
