/**
 * #665 — the board becomes the ignition: when a card moves to done, the
 * board itself asks "what's the next pull?"
 *
 * The customer's diagnosis (2026-08-04): every step forward was a push from
 * him, not a pull from the team — and the queue-pop rule ("at every done,
 * pop the next runnable item") lived only in seats' intentions. This makes
 * the DONE TRANSITION itself post the question, so the prompt to continue
 * comes from the object, not from anyone's discipline. Rules decay; hooks
 * don't (the fold-procedure lesson, applied to momentum).
 *
 * Contract:
 *   - a PATCH that transitions a card INTO done appends one board-authored
 *     commons post naming the card and asking for the next pull
 *   - riding the SAME write as the transition (the #578 atomicity pattern —
 *     no window where the card is done and the room was never asked)
 *   - no nudge when the card was already done, or for non-done moves, or
 *     for patches that don't touch column
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const card = (shortId, column) => ({
  id: `c${shortId}`, shortId, title: `Card ${shortId}`, description: 'body',
  type: 'task', assignees: [], labels: [], for: '', priority: null,
  column, order: 0, createdAt: ts, updatedAt: ts,
  relationships: { relatedTo: [], blockedBy: [] },
});

test('moving a card into done posts the next-pull nudge; non-done moves and re-dones stay silent', async () => {
  const srv = await startRestServer({
    board: makeBoardFixture({
      cards: [card(1, 'in-progress'), card(2, 'backlog'), card(3, 'done')],
      nextShortId: 4,
    }),
  });
  const patch = (id, body) => fetch(`${srv.baseUrl}/api/cards/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const convs = async () => (await (await fetch(`${srv.baseUrl}/api/conversations`)).json());
  try {
    // 1 → done: nudge appears, board-authored, names the card.
    assert.equal((await patch('c1', { column: 'done' })).status, 200);
    let list = await convs();
    const nudges = list.filter((c) => c.author === 'board' && /next pull/i.test(c.body));
    assert.equal(nudges.length, 1, 'one nudge for one done-transition');
    assert.match(nudges[0].body, /#1\b/);

    // Non-done move: silent.
    assert.equal((await patch('c2', { column: 'in-progress' })).status, 200);
    // Already-done card patched (title only): silent.
    assert.equal((await patch('c3', { title: 'retitled while done' })).status, 200);
    // Already-done card "moved" to done again: silent.
    assert.equal((await patch('c3', { column: 'done' })).status, 200);

    list = await convs();
    assert.equal(list.filter((c) => c.author === 'board' && /next pull/i.test(c.body)).length, 1,
      'still exactly one nudge — no noise from non-transitions');
  } finally {
    await srv.stop();
  }
});
