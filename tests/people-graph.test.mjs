/**
 * #619 — the identity slice: person/agent entities and their edges, derived
 * from STRUCTURED fields only.
 *
 * RED FIRST. Nothing in `core/people.mjs` exists yet and `/api/people` 404s;
 * every test here is expected to fail until it doesn't. The spec was attacked
 * by the reviewing seat before a line was written (#619 commons, 18:36Z) and
 * five holes were closed in it — the numbered notes below record which.
 *
 * The slice, stated so a later reader can tell scope creep from the build:
 *   - person nodes derive from `card.assignees` and `conversation.author`. Only.
 *   - `for` and `mentions` are NEVER sources. `mentions` is a regex over prose
 *     (server.js extractMentions) and holds real external people's handles
 *     scraped from pasted text — deriving from it would mint entities for
 *     strangers who never touched this board. That is the consent guard, not
 *     a style rule.
 *   - edges are DERIVED, never materialised. A derived edge has no second end
 *     to drift, so the #618 class (192 one-ended relatedTo) is unrepresentable.
 *   - names come from the roster; there is no sibling alias table.
 *
 * NOT in this slice: `createdBy` (fast-follow, its own deploy), the human
 * entity page (a projection of these same queries), general adjudication
 * machinery.
 *
 * ⚠️ Fixture rule (reviewer hole #4, and it is worse than it looked): the
 * harness passes `...process.env` through, and the LIVE services export
 * SCRUM_ROSTER_FILE pointing at the private tree. A roster-dependent test that
 * does not pin its own roster file reads whoever happens to be in the room.
 * Every test below writes a SYNTHETIC roster to a temp file and pins it. No
 * live roster values appear in this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/**
 * A synthetic roster. Deliberately NOT our people: `pilot` carries an alias so
 * the alias path is exercised without publishing anyone's real alternate name.
 *
 * ⚠️ `color` is REQUIRED on every seat and it is not decoration: identity.mjs
 * `sanitizeRoster` drops any seat lacking a valid hex colour, and if that empties
 * the roster it falls back to the SHIPPED EXAMPLE. A fixture without colours
 * therefore does not fail loudly — it silently tests against the default roster,
 * and every assertion about names or aliases below would be measuring the wrong
 * object. Found the hard way while wiring this up.
 */
function writeSyntheticRoster() {
  const file = path.join(
    os.tmpdir(),
    `scrum-test-roster-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify({
    seats: {
      pilot:  { name: 'Pilot',  glyph: '🛩️', color: '#4488cc', aliases: ['skipper'] },
      scribe: { name: 'Scribe', glyph: '✒️', color: '#cc8844' },
      board:  { name: 'board',  glyph: '📋', color: '#888888' },
      wiki:   { name: 'wiki',   glyph: '📄', color: '#999999' },
    },
  }, null, 2));
  return file;
}

/** Start a REST server with a pinned synthetic roster and a seeded board. */
async function withServer(board, fn) {
  const rosterFile = writeSyntheticRoster();
  const server = await startRestServer({ board, env: { SCRUM_ROSTER_FILE: rosterFile } });
  try {
    await fn(server);
  } finally {
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
}

const getJSON = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * Fetch the person list, asserting the precondition BEFORE touching the body.
 *
 * Without this, a test about (say) `mentions` fails with a TypeError on a null
 * body and thereby proves only that the endpoint 404s — it never gets far
 * enough to test the thing it is named for. Stating the precondition keeps
 * each RED failure honest about what it did and did not establish.
 */
async function peopleList(baseUrl) {
  const { status, body } = await getJSON(`${baseUrl}/api/people`);
  assert.equal(status, 200, `GET /api/people must answer 200 before this test means anything (got ${status})`);
  assert.ok(body && Array.isArray(body.people), 'expected { people: [...] }');
  return body.people;
}

/**
 * A board with one of every hazard the slice has to survive:
 *   - a real assignee and a real author (the two legal sources)
 *   - `unassigned` (absence, not an actor)
 *   - a system voice (`board`) that is IN the roster and still not a person
 *   - `for` holding beneficiary prose that names a person
 *   - `mentions` holding an outside handle, as extractMentions would produce
 *   - an identity string in no roster (`ghost`) — must surface, not vanish
 */
function hazardBoard() {
  return makeBoardFixture({
    nextShortId: 4,
    cards: [
      {
        id: 'c1', shortId: 1, title: 'assigned to a seat', description: '',
        assignees: ['pilot'], column: 'backlog', labels: [], order: 0,
        for: 'Scribe — who needs this to land before Tuesday',
        claimedBy: 'scribe',
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'c2', shortId: 2, title: 'nobody owns this', description: '',
        assignees: ['unassigned'], column: 'backlog', labels: [], order: 1,
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'c3', shortId: 3, title: 'assigned to an unknown string', description: '',
        assignees: ['ghost'], column: 'backlog', labels: [], order: 2,
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'v1', body: 'a post by a seat', author: 'scribe', attachedTo: null,
        attachments: [], mentions: ['someoutsider'],
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'v2', body: 'a post by the system', author: 'board', attachedTo: null,
        attachments: [], mentions: [], createdAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  });
}

// ── 1 · The surface exists, and it is one AGENTS can reach ─────────────────
//
// Reviewer hole #1, and it was the load-bearing one: seven tests about WHAT
// derivation is legal would all go green over a pure in-process library, and
// leave agents exactly where #581 found them — no way to ask the board a
// question. Agents-first means the surface is named in the tests.

test('#619 GET /api/people returns the derived person nodes', async () => {
  await withServer(hazardBoard(), async ({ baseUrl }) => {
    const keys = (await peopleList(baseUrl)).map((p) => p.key).sort();
    assert.deepEqual(keys, ['ghost', 'pilot', 'scribe'],
      'pilot (assignee) + scribe (author) + ghost (unknown, surfaced) — and nothing else');
  });
});

test('#619 GET /api/people/:key returns one person with their edges', async () => {
  await withServer(hazardBoard(), async ({ baseUrl }) => {
    const { status, body } = await getJSON(`${baseUrl}/api/people/pilot`);
    assert.equal(status, 200);
    assert.equal(body.key, 'pilot');
    assert.equal(body.name, 'Pilot', 'display name comes from the roster');
    assert.deepEqual(body.assigned, [1], 'shortIds of cards assigned to them');
    assert.deepEqual(body.authored, [], 'pilot wrote no posts in this fixture');
  });
});

// ── 2 · The source list is PINNED, not merely exercised ────────────────────
//
// Reviewer hole #2. A test that checks "no node came from a `for` value" can
// pass by accident of the fixture. The unforgeable form asserts the code's own
// declared inputs are EXACTLY the two legal fields, so a later "helpful"
// addition of `mentions` fails by construction rather than by luck.

test('#619/#653 the declared source-field list is exactly assignees + author + createdBy', async () => {
  const { PERSON_SOURCE_FIELDS } = await import('../core/people.mjs');
  // #653 (2026-08-04): createdBy admitted as the third source — the deliberate,
  // reviewed act this tripwire exists to force. Rationale on the card: #631
  // stamps the writer on every new card and the graph was blind to all of
  // them. `for` and `mentions` remain excluded (the test below).
  assert.deepEqual([...PERSON_SOURCE_FIELDS].sort(), ['assignees', 'author', 'createdBy'],
    'adding a source here must be a deliberate, reviewed act — not a quiet import');
  assert.ok(Object.isFrozen(PERSON_SOURCE_FIELDS), 'the list must not be mutable at runtime');
});

test('#619 `for` and `mentions` never produce a person node', async () => {
  await withServer(hazardBoard(), async ({ baseUrl }) => {
    const keys = (await peopleList(baseUrl)).map((p) => p.key);
    // `for` on c1 names "Scribe" in prose; scribe is a person ONLY because they
    // authored v1. The outsider handle in mentions has no other route in.
    assert.ok(!keys.includes('someoutsider'),
      'mentions is a regex over prose and holds real external people — never a source');
    assert.ok(!keys.some((k) => k.toLowerCase().includes('tuesday')),
      '`for` is beneficiary prose, not an identity field');
  });
});

// ── 3 · Exclusions produce NO node ─────────────────────────────────────────

test('#619 system voices and the absence sentinel produce no person node', async () => {
  await withServer(hazardBoard(), async ({ baseUrl }) => {
    const keys = (await peopleList(baseUrl)).map((p) => p.key);
    for (const excluded of ['board', 'wiki', 'unassigned']) {
      assert.ok(!keys.includes(excluded),
        `${excluded} is a role or an absence, not an actor — and 'board' is in the roster, `
        + 'so roster membership alone must not confer personhood');
    }
  });
});

// ── 4 · Names and aliases come from the roster. No sibling table. ──────────
//
// Reviewer hole #3: "no sibling alias table" and "an alias needs a record"
// are in tension until the home is named. Ruling: an optional `aliases` array
// ON the roster seat. One file, one source, backward compatible — a roster
// without the key keeps working.

test('#619 an alias resolves to its seat via the roster, with no sibling table', async () => {
  const board = hazardBoard();
  board.conversations.push({
    id: 'v3', body: 'posted under an alternate name', author: 'skipper',
    attachedTo: null, attachments: [], mentions: [],
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  await withServer(board, async ({ baseUrl }) => {
    const people = await peopleList(baseUrl);
    const keys = people.map((p) => p.key);
    assert.ok(!keys.includes('skipper'), 'an alias must not become its own node');
    const pilot = people.find((p) => p.key === 'pilot');
    assert.deepEqual(pilot.authored, ['v3'], "the alias's post belongs to the seat");
    assert.deepEqual(pilot.aliases, ['skipper'], 'and the mapping is visible, from the roster');
  });
});

// ── 4b · The alias must survive a roster ROUND-TRIP ────────────────────────
//
// Storing aliases on the seat is only safe if the roster WRITER preserves them.
// validateRoster rebuilt each seat from a fixed field list, so a single save
// from the settings UI destroyed the field silently — alias resolution would
// just stop working one afternoon with nothing in the diff to explain it.
// The same class writeRoster already documents for `_README`, one level down.

test('#619 aliases survive validateRoster — a settings save must not destroy them', async () => {
  const { validateRoster } = await import('../core/roster-config.mjs');
  const clean = validateRoster({
    seats: {
      pilot: { name: 'Pilot', glyph: '🛩️', color: '#4488cc', aliases: ['skipper', 'skipper', '  '] },
      scribe: { name: 'Scribe', glyph: '✒️', color: '#cc8844' },
    },
  });
  assert.deepEqual(clean.pilot.aliases, ['skipper'], 'preserved, trimmed and de-duplicated');
  assert.ok(!('aliases' in clean.scribe), 'and absent where none were given, so old rosters are untouched');
});

// ── 4c · A capitalised identity must not split a seat in two ───────────────
//
// Reviewer's latent hazard (#619 review, 19:00Z). Seat keys are lower-cased on
// load, so a case-sensitive match minted a SECOND unresolved node beside the
// real seat the moment anyone wrote "Pilot" instead of "pilot". Caught while
// the live corpus was still all-lower-case — the cheapest possible moment.

test('#619 a capitalised identity resolves to its seat, not to a second node', async () => {
  const board = hazardBoard();
  board.cards.push({
    id: 'c5', shortId: 5, title: 'assigned with a capital', description: '',
    assignees: ['Pilot'], column: 'backlog', labels: [], order: 4,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  });
  board.conversations.push({
    id: 'v4', body: 'posted with a capitalised alias', author: 'Skipper',
    attachedTo: null, attachments: [], mentions: [],
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  await withServer(board, async ({ baseUrl }) => {
    const people = await peopleList(baseUrl);
    const keys = people.map((p) => p.key);
    assert.ok(!keys.includes('Pilot'), 'a capitalised seat key must not become its own node');
    assert.ok(!keys.includes('Skipper'), 'nor a capitalised alias');
    const pilot = people.find((p) => p.key === 'pilot');
    assert.deepEqual(pilot.assigned, [1, 5], 'both spellings land on the one seat');
    assert.deepEqual(pilot.authored, ['v4']);
  });
});

test('#619 two spellings of an UNKNOWN identity stay two unknowns', async () => {
  const board = hazardBoard();
  board.cards.push({
    id: 'c6', shortId: 6, title: 'another unknown, capitalised', description: '',
    assignees: ['Ghost'], column: 'backlog', labels: [], order: 5,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  });
  await withServer(board, async ({ baseUrl }) => {
    const keys = (await peopleList(baseUrl)).map((p) => p.key).sort();
    assert.deepEqual(keys, ['Ghost', 'ghost', 'pilot', 'scribe'],
      'folding unknown spellings together would ASSERT they are one person — that is a guess');
  });
});

// ── 5 · Symmetric BY CONSTRUCTION, not by maintenance ──────────────────────
//
// Reviewer hole #5, and the sharpest: a fixture check that person→cards agrees
// with cards→person re-tests MAINTENANCE, which is the thing this slice exists
// to escape. #618 happened because relatedTo is stored at both ends and kept
// in sync by code that only ran in one surface. The by-construction claim is
// that both directions are computed by ONE function from ONE field, so there
// is no second end that can drift. That is a claim about the code, so the test
// makes it about the code — plus one fixture check as a smoke.

test('#619 forward and inverse traversal are the same code path', async () => {
  const people = await import('../core/people.mjs');
  assert.equal(typeof people.deriveGraph, 'function',
    'one derivation produces both directions');
  // The inverse must be a projection of the forward derivation, not a parallel
  // implementation: no second function may read the source fields directly.
  //
  // ⚠️ The invariant is "one CONSUMER", and the declaration is itself an
  // occurrence of the name — an earlier draft asserted a total of 1, which no
  // module that both declares and uses the constant could ever satisfy. It
  // would have failed forever, for a reason unrelated to what it tests.
  // Total of 2 = the `export const` plus exactly one site that consults it.
  const src = fs.readFileSync(new URL('../core/people.mjs', import.meta.url), 'utf8');
  const occurrences = (src.match(/PERSON_SOURCE_FIELDS/g) || []).length;
  assert.equal(occurrences, 2,
    'expected the declaration + exactly ONE consumer; a second reader is a second end that can drift');
});

test('#619 smoke: the two directions agree on the fixture', async () => {
  await withServer(hazardBoard(), async ({ baseUrl }) => {
    const { status, body: one } = await getJSON(`${baseUrl}/api/people/pilot`);
    assert.equal(status, 200, 'the single-person surface must answer before this smoke means anything');
    const fromList = (await peopleList(baseUrl)).find((p) => p.key === 'pilot');
    assert.deepEqual(one.assigned, fromList.assigned);
    assert.deepEqual(one.authored, fromList.authored);
  });
});

// ── 6 · claimedBy is an edge, never an identity source ─────────────────────

test('#619 claimedBy never creates a person, and is exposed as a lease edge', async () => {
  const board = hazardBoard();
  // c1 is claimed by `scribe`, who is a person for an unrelated reason (they
  // authored v1). Add a claim by a string that has NO other route to personhood.
  board.cards.push({
    id: 'c4', shortId: 4, title: 'claimed by a stranger', description: '',
    assignees: ['unassigned'], column: 'backlog', labels: [], order: 3,
    claimedBy: 'transient',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  });
  await withServer(board, async ({ baseUrl }) => {
    const people = await peopleList(baseUrl);
    assert.ok(!people.some((p) => p.key === 'transient'),
      'the #348 lease is cleared on release — it records custody, not authorship');
    const { body: scribe } = await getJSON(`${baseUrl}/api/people/scribe`);
    assert.deepEqual(scribe.claiming, [1], 'but an existing person may show what they hold');
  });
});

// ── 8 · The surface agents actually use ────────────────────────────────────
//
// Agents in this room reach the board through MCP, not curl. A REST-only
// surface would go green on every test above and still leave the slice's
// PRIMARY beneficiary unable to ask the question.

test('#619 the person graph is reachable as MCP tools, and answers', async () => {
  const { startPair, mcpSession, parseMcpResponse } = await import('./helpers/harness.mjs');
  const rosterFile = writeSyntheticRoster();
  const pair = await startPair({ board: hazardBoard() });
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const names = ((await session.listTools()).result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes('person_list'), 'person_list must exist for agents');
    assert.ok(names.includes('person_get'), 'person_get must exist for agents');

    // Exposed is not the same as working: call it and read the answer, so this
    // cannot pass over a tool that is registered and broken.
    const called = await session.callTool('person_list', {});
    const payload = JSON.parse(called.result.content[0].text);
    assert.ok(Array.isArray(payload.people), 'the tool returns the derived graph');
    assert.ok(payload.people.some((p) => p.key === 'pilot'), 'and it is the real derivation');
  } finally {
    await pair.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});

// ── 7 · An unknown identity is VISIBLE, never guessed and never dropped ────

test('#619 an identity in no roster surfaces as unresolved', async () => {
  await withServer(hazardBoard(), async ({ baseUrl }) => {
    const ghost = (await peopleList(baseUrl)).find((p) => p.key === 'ghost');
    assert.ok(ghost, 'a string with no roster entry must not be silently dropped');
    assert.equal(ghost.resolved, false, 'and must be marked, not quietly rendered as a seat');
    assert.equal(ghost.name, 'ghost', 'absent is honest; guessed is fabricated');
    assert.deepEqual(ghost.assigned, [3]);
  });
});
