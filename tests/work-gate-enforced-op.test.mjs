/**
 * #889 — move the gate onto an op it can actually scope, and build the
 * agreement rail that a comment has claimed for weeks.
 *
 * ⛔ THE STATE THIS REPLACES. `ENFORCED_OPS` was ['create'] and the only wrapped
 * tool was `card_create` — which brings a card into existence and therefore
 * names none at decision time. After #886 scoped the gate to the declared card,
 * the rail could never match its own enforced op:
 *
 *     production, same corpus, before/after #890
 *     0 / 39 · does not fire        ← read as "39 acts, zero bypasses"
 *     UNMEASURABLE                  ← not one of the 39 COULD have been a bypass
 *
 * ⇒ `update` is the smallest honest replacement. The declared work happens on a
 *   card that already exists, so editing THAT card is the action the window is
 *   a mutex over. `claim` is deliberately NOT added: claims are already a
 *   compare-and-set under a write lock, and a bid window on top would be
 *   strictly weaker and twenty minutes slower.
 *
 * ⭐⭐⭐ AND THE AGREEMENT TEST BELOW DID NOT EXIST. work-gate.mjs says, above
 * the constant, "This list is what the instrument believes; wrapping is what
 * makes it true. A test asserts the two agree." **There was no such test.** I
 * grepped for it while moving the list and found the sentence and nothing else.
 *
 * ⚠️ That is the same class as everything else this card touches — a claim about
 * a runtime property, written in a comment, believed by every reader, checked by
 * nobody. The comment was right about what SHOULD exist; it was wrong that it
 * did. So the rail is built here, behaviourally: for every op in ENFORCED_OPS,
 * the corresponding tool must actually REFUSE inside an open window. A source
 * grep would pass against a tool that imports the gate and ignores it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENFORCED_OPS, UNSCOPABLE_OPS } from '../core/work-gate.mjs';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

// ⚠️ Shapes copied from tests/work-tools-wiring.test.mjs, not invented. My first
// draft of this file called a `startMcpServer(armed(dir))` helper that does not
// exist and asserted on a `restCallCount()` that nothing exposes — an invented
// fixture is an unchecked claim wearing a test's clothes.
const storeDir = () => mkdtempSync(join(tmpdir(), 'work-gate-enforced-op-'));
const armed = (store) => ({ SCRUM_WORK_GATE: 'on', SCRUM_WORK_STORE: store });
const payload = (res) => JSON.parse(res.result.content[0].text);

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'the declared card', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    { id: 'u-2', shortId: 2, title: 'an unrelated card', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 3,
});

async function withServers(env, fn) {
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env });
  try {
    await fn({ rest, mcp, session: await mcpSession(mcp.mcpUrl) });
  } finally {
    await mcp.stop();
    await rest.stop();
  }
}

test('#889 the enforced op is one the gate can SCOPE — no unscopable op may be enforced', () => {
  // ⛔ THE INVARIANT THAT MAKES #890's R4 UNREACHABLE BY ACCIDENT. If an
  // unscopable op is ever enforced again, signal 2 goes unmeasurable in
  // production and the rail silently covers nothing. This fails on the commit
  // that would reintroduce it, rather than in a sprint report six weeks later.
  const bad = [...ENFORCED_OPS].filter((op) => UNSCOPABLE_OPS.includes(op));
  assert.deepEqual(bad, [],
    `${bad.join(', ')} cannot be scoped to a card, so the gate can never refuse it and any `
    + 'compliance number over it is measuring a population that cannot contain a violation');
});

test('#889 ⭐⭐⭐ AGREEMENT — every enforced op is a tool that ACTUALLY refuses', async () => {
  // The rail work-gate.mjs has claimed for weeks and never had. Behavioural on
  // purpose: "the tool imports the gate" is satisfiable by a tool that calls it
  // and throws the answer away.
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-889', by: 'ada', card: 1, required: ['ada', 'bo'], replyByMinutes: 20,
    });

    const TOOL_FOR_OP = { update: 'card_update', move: 'card_move', create: 'card_create' };
    for (const op of ENFORCED_OPS) {
      const tool = TOOL_FOR_OP[op];
      assert.ok(tool, `ENFORCED_OPS names "${op}" and this test does not know which tool performs it — `
        + 'add the mapping, or the agreement claim is unverifiable for that op');

      const args = op === 'move'
        ? { id: '1', column: 'done', by: 'ada' }
        : { id: '1', title: 'edited inside my own open window', by: 'ada' };
      const res = payload(await session.callTool(tool, args));
      assert.equal(res.refused, true,
        `${tool} performs the enforced op "${op}" and did NOT refuse inside an open window on the `
        + 'same card — the list claims coverage the wiring does not provide');
    }
  });
});

test('#889 ⛔ THE MEASURED FAILURE, end to end — editing the card you declared', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-889b', by: 'ada', card: 1, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const res = payload(await session.callTool('card_update', {
      id: '1', title: 'acting on my own declared work', by: 'ada',
    }));
    assert.equal(res.refused, true, JSON.stringify(res));
    assert.equal(res.workObjectId, 'w-889b');
    assert.match(res.reason, /work_withdraw/, 'the refusal must name a remedy that exists');

    // ⚠️ A refusal that still writes is worse than no refusal at all.
    const fresh = payload(await session.callTool('card_get', { id: '1' }));
    assert.notEqual(fresh.title, 'acting on my own declared work', 'the edit landed despite the refusal');
  });
});

test('#889 ⭐ a DIFFERENT card is untouched — the whole point of #886, now with teeth', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-889c', by: 'ada', card: 1, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const res = payload(await session.callTool('card_update', {
      id: '2', title: 'unrelated work proceeds', by: 'ada',
    }));
    assert.equal(res.refused, undefined, `a window on #1 must not gate #2: ${JSON.stringify(res)}`);
    assert.equal(res.title, 'unrelated work proceeds');
  });
});

test('#889 ⛔ A UUID TARGET IS RESOLVED, not waved through', async () => {
  // ⚠️ THE BYPASS THIS CLOSES. `card_update` takes "Card UUID or shortId", and
  // work objects store a shortId. A gate that compared the raw argument would
  // fail-open on every UUID — and the bypass would be one `card_get` away from
  // anyone who noticed, while the rail reported itself armed.
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-889d', by: 'ada', card: 1, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const card = payload(await session.callTool('card_get', { id: '1' }));
    assert.ok(card.id && card.id !== '1', 'fixture sanity: the uuid is not the shortId');

    const res = payload(await session.callTool('card_update', {
      id: card.id, title: 'same card, addressed by uuid', by: 'ada',
    }));
    assert.equal(res.refused, true,
      'addressing the declared card by UUID walked straight through the gate');
  });
});

test('#889 ⚠️ with NO open windows the update goes through untouched', async () => {
  // ⛔ THE FAILURE MODE THAT MATTERS MORE THAN THE RAIL. card_update is the
  // board's most common write. A gate that refused, errored, or hung when
  // nothing was declared would be a self-inflicted outage on the hot path —
  // strictly worse than the coordination defect it exists to prevent.
  //
  // ⚠️ My first draft asserted this by counting REST calls through a
  // `restCallCount()` the harness does not have. Pinning the OBSERVABLE
  // property — the edit lands, unrefused — is both true and checkable; the
  // round-trip count was a claim about the implementation I could not measure.
  await withServers(armed(storeDir()), async ({ session }) => {
    const res = payload(await session.callTool('card_update', { id: '1', title: 'quiet edit', by: 'ada' }));
    assert.equal(res.refused, undefined, JSON.stringify(res));
    assert.equal(res.title, 'quiet edit');
  });
});

test('#889 ⚠️ NO ACTOR ⇒ ALLOWED, and that boundary is named rather than discovered', async () => {
  // ⛔ THE FAIL-OPEN, PINNED. `by` is optional on card_update and card_move —
  // declared, not authenticated — so a tool call that omits it reaches the gate
  // with no actor and the gate allows it. That is deliberate (an absent actor is
  // the human path, and refusing the owner in his own board is worse than
  // under-refusing an agent) and it is also the rail's widest hole.
  //
  // ⚠️ Naming what a rail CANNOT see, in the same commit that builds it, is the
  // whole discipline: an unstated fail-open is indistinguishable from a rail
  // that works. If `by` ever becomes required, this test fails and tells the
  // next reader the hole was closed on purpose.
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-889e', by: 'ada', card: 1, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const res = payload(await session.callTool('card_update', { id: '1', title: 'anonymous edit' }));
    assert.equal(res.refused, undefined,
      'an actorless call is the human path — if this now refuses, `by` became required and '
      + 'this test is the place to record that');
  });
});

test('#889 the moved card records WHO moved it — `by` is forwarded, not swallowed', async () => {
  // The field was added for the gate; a field accepted and then dropped is the
  // validated-then-discarded shape, and it would have made card_move the only
  // write whose author the event log never learns.
  await withServers(armed(storeDir()), async ({ session, rest }) => {
    const res = payload(await session.callTool('card_move', { id: '2', column: 'done', by: 'ada' }));
    assert.equal(res.refused, undefined, JSON.stringify(res));
    assert.equal(res.column, 'done');
    assert.equal(res.ignoredFields, undefined, 'the server rejected `by` as unknown');

    // ⚠️ /api/changes REFUSES a cursor older than the log's retention rather than
    // answering partially — a good rail, and my first draft tripped it by asking
    // since the epoch. Ask it where the log starts, then ask from there.
    const probe = await (await fetch(`${rest.baseUrl}/api/changes?since=1970-01-01T00:00:00.000Z`)).json();
    const since = probe.oldest_retained;
    assert.ok(since, `expected the refusal to name the log's start: ${JSON.stringify(probe).slice(0, 200)}`);

    const events = await (await fetch(`${rest.baseUrl}/api/changes?since=${encodeURIComponent(since)}`)).json();

    // ⚠️ A THIRD SURFACE FOR THE SAME FACT, and my first assertion used the
    // wrong one's keys. The raw event log says {actor, entity: {shortId}}; this
    // projection says {by, shortId} at the top level. Neither is wrong and the
    // rename is invisible until you assert across them — the same
    // two-surfaces-one-name shape that already cost this room a duplicated
    // investigation today (#891).
    const move = (events.changes || []).find((e) => e.kind === 'card' && e.shortId === 2);
    assert.equal(move?.by, 'ada', `the move was recorded without its actor: ${JSON.stringify(move)}`);
  });
});
