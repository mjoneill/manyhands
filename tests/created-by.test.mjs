/**
 * #631 — `createdBy`: record who wrote a card, at the moment it is written.
 *
 * RED FIRST. Nothing below passes yet.
 *
 * WHY THIS FIELD EXISTS. Cards carried no authorship at all: 0 of 569 had any
 * author key, and the only author-ish one — `claimedBy` — is the #348 lease,
 * cleared on release. It records custody, not writing. The gap is LOSSY in a
 * way no later work repairs: a card filed before the field exists has an author
 * nobody can recover. Reconstructing eight of them on the night they were filed,
 * by the people who filed them, cost two agents, six broken instruments, one
 * false accusation and forty minutes.
 *
 * DECLARED, NOT AUTHENTICATED. The writer asserts who they are; the server
 * records it. That is not a new trust model — it is the one already live for
 * `conversation.author` (server.js requires non-empty and validates no further).
 * Server-side identity would need caller resolution the MCP tool path does not
 * have (17 tools, 0 read `extra`), and that is a different slice.
 *
 * ⚠️ FIVE WRITE SURFACES, not two. A card and a wiki page are ONE record, and
 * `POST /api/nodes` builds its payload as a hand-picked subset — so a card made
 * through the wiki surface would silently have no author even after the shared
 * constructor learns the field. That is the `collectRoster()` shape from earlier
 * today, third instance: THE SHARED FUNCTION IS NEVER THE GUARANTEE, THE CALLERS
 * ARE. Both creation paths are tested here for that reason.
 *
 * NOT in this slice: backfill of existing cards (absent is honest, guessed is
 * fabricated) · server-side identity resolution · "directed by" as a separate
 * provenance edge · any change to /api/people derivation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startPair, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const json = (extra = {}) => ({ headers: { 'Content-Type': 'application/json' }, ...extra });

function apiTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer({ board: makeBoardFixture() });
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  });
}

const post = (baseUrl, path, body) =>
  fetch(`${baseUrl}${path}`, json({ method: 'POST', body: JSON.stringify(body) }));
const patch = (baseUrl, path, body) =>
  fetch(`${baseUrl}${path}`, json({ method: 'PATCH', body: JSON.stringify(body) }));

// ── Surface 1 · POST /api/cards ────────────────────────────────────────────

apiTest('#631 POST /api/cards records createdBy and persists it', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', { title: 'a card with an author', createdBy: 'pilot' });
  assert.equal(res.status, 201);
  const card = await res.json();
  assert.equal(card.createdBy, 'pilot');

  const fetched = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.equal(fetched.createdBy, 'pilot', 'stored, not merely echoed');
});

// ── Surface 2 · POST /api/nodes — the one a shared constructor does NOT cover ──
//
// handleCreateNode calls createCardFromPayload with a hand-built subset
// ({title, description, type}). Teaching the constructor about createdBy does
// nothing for this path. If this test passes while the route still filters, the
// test is wrong — not the route.

apiTest('#631 POST /api/nodes (the wiki surface) records createdBy too', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/nodes', { title: 'a wiki page', body: 'text', createdBy: 'scribe' });
  assert.equal(res.status, 201);
  const node = await res.json();
  // The node surface speaks schema.org: the field arrives as `creator` (#631's
  // mapping, provisional pending #632). Asserting the WIRE NAME each surface
  // actually uses, not a name the test wishes for.
  assert.equal(node.creator, 'scribe',
    'a card created through the wiki surface must carry its author — same record, second door');
  assert.ok(!(node.board?._extra?.createdBy),
    'and it must be a first-class node property, not buried in the legacy _extra bag');

  // one record, two projections
  const asCard = await (await fetch(`${baseUrl}/api/cards/${node.identifier}`)).json();
  assert.equal(asCard.createdBy, 'scribe', 'the same write, read back through the board surface');
});

// ── Surface 3 · PATCH /api/cards — immutable ───────────────────────────────
//
// ⚠️ TWO INDEPENDENT GUARDS hold this, and it matters for anyone mutation-testing
// it later. A mutant that removes `createdBy` from IMMUTABLE_CARD_FIELDS SURVIVES
// — because #249's `PATCHABLE_CARD_FIELDS` allowlist already ignores unknown keys
// and stops the write first. Proven with a two-condition mutant: add createdBy to
// PATCHABLE and it still holds (immutable guard doing the work); remove it from
// IMMUTABLE as well and this test fails.
//
// So the immutable-set entry is real defence-in-depth, currently shadowed. Stated
// because a single surviving mutant reads as "untested" and this is the opposite:
// it is guarded twice, and no single mutation can demonstrate either guard alone.

apiTest('#631 createdBy cannot be rewritten through PATCH /api/cards', async ({ baseUrl }) => {
  const { shortId } = await (await post(baseUrl, '/api/cards', { title: 'owned', createdBy: 'pilot' })).json();
  await patch(baseUrl, `/api/cards/${shortId}`, { createdBy: 'someone-else', title: 'renamed' });

  const after = await (await fetch(`${baseUrl}/api/cards/${shortId}`)).json();
  assert.equal(after.createdBy, 'pilot', 'authorship is a fact about the past, not an editable field');
  assert.equal(after.title, 'renamed', 'and the rest of the patch still applied');
});

// ── Surface 4 · PATCH /api/nodes — immutable BY CONSTRUCTION ───────────────
//
// handleUpdateNode writes an explicit allowlist (title/body/parent/attachments)
// rather than looping the patch keys, so it cannot write createdBy at all. This
// asserts the property rather than assuming the implementation keeps it.

apiTest('#631 createdBy cannot be rewritten through PATCH /api/nodes either', async ({ baseUrl }) => {
  const created = await (await post(baseUrl, '/api/nodes', { title: 'page', body: 'x', createdBy: 'scribe' })).json();
  const id = created.identifier;
  // try both spellings — the board name and the schema.org name
  await patch(baseUrl, `/api/nodes/${id}`, { createdBy: 'imposter', creator: 'imposter', body: 'edited' });

  const after = await (await fetch(`${baseUrl}/api/cards/${id}`)).json();
  assert.equal(after.createdBy, 'scribe');
  assert.equal(after.description, 'edited', 'the legitimate part of the patch still applied');
});

// ── Absent is honest ───────────────────────────────────────────────────────

apiTest('#631 a card created without createdBy stores null — never a guess', async ({ baseUrl }) => {
  const card = await (await post(baseUrl, '/api/cards', { title: 'anonymous', assignees: ['pilot'] })).json();
  assert.equal(card.createdBy, null,
    'not "unassigned", not the assignee, not the claimant — absent is honest, guessed is fabricated');
});

apiTest('#631 an existing card without the field is left alone, not migrated', async () => {
  const board = makeBoardFixture({
    nextShortId: 2,
    cards: [{
      id: 'old-1', shortId: 1, title: 'filed before the field existed', description: '',
      assignees: ['pilot'], labels: [], column: 'backlog', order: 0,
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    }],
  });
  const server = await startRestServer({ board });
  try {
    const card = await (await fetch(`${server.baseUrl}/api/cards/1`)).json();
    assert.ok(card.createdBy == null, 'no backfill, no invention — the past stays unknown');
  } finally {
    await server.stop();
  }
});

// ── Surface 5 · the MCP tool must make it IMPOSSIBLE to forget ─────────────
//
// The whole point of REQUIRED here: an optional field is a field agents omit,
// and one surface quietly diverging from another is exactly how #618 got 192
// one-ended edges and #628 shipped unusable payloads. The schema is the guard.

test('#631 MCP card_create REQUIRES createdBy — an agent cannot forget it', async () => {
  const pair = await startPair({ board: makeBoardFixture() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const tool = ((await session.listTools()).result?.tools ?? []).find((t) => t.name === 'card_create');
    assert.ok(tool, 'card_create exists');
    const required = tool.inputSchema?.required ?? [];
    assert.ok(required.includes('createdBy'),
      'createdBy must be REQUIRED in the schema — optional is how a surface diverges');

    // and it round-trips through the real transport
    const called = await session.callTool('card_create', { title: 'via mcp', createdBy: 'pilot' });
    const card = JSON.parse(called.result.content[0].text);
    assert.equal(card.createdBy, 'pilot');
  } finally {
    await pair.stop();
  }
});
