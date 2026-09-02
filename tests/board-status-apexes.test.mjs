/**
 * #1130 item 3 — THE FRONT DOOR. A stranger with curl, no seat and no SPARQL
 * asks the board what lives here and gets the apexes back: which cards declare
 * themselves the top of a body of work, and how much is contained under each.
 *
 * Membership is CONTAINMENT (the parent edge), never the label — the owner's
 * ruling of 2026-08-19. `members` counts descendants, so an apex with nothing
 * asserted under it honestly reports 0 rather than its label's popularity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const mk = async (baseUrl, title, extra = {}) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', ...extra }),
  });
  assert.equal(r.status, 201, `setup: create ${title}`);
  return r.json();
};

const status = async (baseUrl) => (await fetch(`${baseUrl}/api/board/status`)).json();

test('#1130 ⭐ /api/board/status lists the apexes with their containment counts', async () => {
  const srv = await startRestServer({ board: makeBoardFixture() });
  try {
    const apex = await mk(srv.baseUrl, 'north star', { type: 'goal', labels: ['apex:manyhands'] });
    const child = await mk(srv.baseUrl, 'child', { parent: apex.id });
    await mk(srv.baseUrl, 'grandchild', { parent: child.id });
    const empty = await mk(srv.baseUrl, 'second apex', { type: 'goal', labels: ['apex:orchard'] });
    // The shapes that are NOT apexes: a goal-typed root, a north-star label,
    // a card that merely carries the project label.
    await mk(srv.baseUrl, 'final exam', { type: 'goal' });
    await mk(srv.baseUrl, 'placeholder', { type: 'goal', labels: ['north-star', 'apex'] });
    await mk(srv.baseUrl, 'member by label', { labels: ['manyhands'] });

    const s = await status(srv.baseUrl);
    assert.deepEqual(s.apexes, [
      { shortId: apex.shortId, title: 'north star', label: 'manyhands', members: 2 },
      { shortId: empty.shortId, title: 'second apex', label: 'orchard', members: 0 },
    ]);
  } finally {
    await srv.stop();
  }
});

test('#1130 a board with no declared apex answers with an empty list, not an absent key', async () => {
  const srv = await startRestServer({ board: makeBoardFixture() });
  try {
    await mk(srv.baseUrl, 'lonely goal', { type: 'goal' });
    const s = await status(srv.baseUrl);
    assert.deepEqual(s.apexes, []);
  } finally {
    await srv.stop();
  }
});
