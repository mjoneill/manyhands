/**
 * #2029 slice 1 (i) — A GUEST SEAT CAN SEE AND GIVE REACTIONS.
 *
 * Before this, a guest seat had neither a read nor a write for reactions: a 👍 on its post could never reach it, even if it
 * went looking. Two tools join the surface, both granted per agent by name like every other (no grant means no tool):
 *
 * - `reactions_recent`, a READ: the reactions given since an instant, optionally only those on the seat's OWN posts.
 * - `reaction_add`, the seat's OWN reaction, the same class as link_decide: no seat parameter, the reactor is `by`, the
 *   seat the runner binds, and a smuggled seat or by never reaches the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TOOLS, toolsFor, makeExecutor } from '../core/board-tools.mjs';

function recorder() {
  const calls = [];
  return {
    calls,
    get: async (path) => { calls.push(['GET', path]); return { enabled: true, reactions: [] }; },
    post: async (path, body) => { calls.push(['POST', path, body]); return { id: 'p', reactions: [] }; },
  };
}

test('R1 both tools exist, are described for a small model, and nothing grants them by default', () => {
  const byName = new Map(BOARD_TOOLS.map((t) => [t.function.name, t.function]));
  for (const n of ['reactions_recent', 'reaction_add']) {
    assert.ok(byName.has(n), `${n} is on the surface`);
    assert.ok(byName.get(n).description.length > 40, `${n} has words a model can act on`);
    assert.equal(byName.get(n).parameters.properties.seat, undefined, `${n} has no seat parameter`);
    assert.equal(byName.get(n).parameters.properties.by, undefined, `${n} has no by parameter`);
  }
  assert.deepEqual(toolsFor({}).map((t) => t.function.name), [], 'no grants, no tools');
  assert.deepEqual(toolsFor({ toolGrants: ['reactions_recent'] }).map((t) => t.function.name), ['reactions_recent'], 'a grant yields exactly that tool');
});

test('R2 reactions_recent reads since an instant; mine:true keeps only reactions on the seat\'s OWN posts, bound to `by`', async () => {
  const r = recorder();
  const ex = makeExecutor({ get: r.get, post: r.post, by: 'guest' });
  await ex('reactions_recent', { since: '2026-11-22T10:00:00Z' });
  await ex('reactions_recent', { since: '2026-11-22T10:00:00Z', mine: true, author: 'someone-else' });
  assert.deepEqual(r.calls, [
    ['GET', '/api/reactions/recent?since=2026-11-22T10%3A00%3A00Z'],
    ['GET', '/api/reactions/recent?since=2026-11-22T10%3A00%3A00Z&author=guest'],
  ], 'mine aims at the bound seat; a smuggled author is ignored');
});

test('R3 reactions_recent refuses a missing or malformed since BEFORE any request, in a sentence', async () => {
  const r = recorder();
  const ex = makeExecutor({ get: r.get, post: r.post, by: 'guest' });
  await assert.rejects(() => ex('reactions_recent', {}), /since/);
  await assert.rejects(() => ex('reactions_recent', { since: 'yesterday' }), /since/);
  assert.equal(r.calls.length, 0, 'nothing reached the wire');
});

test('R4 reaction_add reacts AS the bound seat; a smuggled seat, by or onBehalfOf never reaches the wire', async () => {
  const r = recorder();
  const ex = makeExecutor({ get: r.get, post: r.post, by: 'guest' });
  await ex('reaction_add', { id: 'abc-123', emoji: '👍', by: 'otto', seat: 'otto', onBehalfOf: 'nell' });
  assert.deepEqual(r.calls, [['POST', '/api/conversations/abc-123/reactions', { emoji: '👍', on: true, by: 'guest' }]]);
});

test('R5 reaction_add refuses an empty id, a dot segment, or a missing emoji BEFORE any request', async () => {
  const r = recorder();
  const ex = makeExecutor({ get: r.get, post: r.post, by: 'guest' });
  await assert.rejects(() => ex('reaction_add', { emoji: '👍' }), /id/);
  await assert.rejects(() => ex('reaction_add', { id: '..', emoji: '👍' }), /not a post id/);
  await assert.rejects(() => ex('reaction_add', { id: 'abc' }), /emoji/);
  assert.equal(r.calls.length, 0);
});
