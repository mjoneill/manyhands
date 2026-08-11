/**
 * #755 BRANCH E — the throttle WIRED, asserted through a real MCP session.
 *
 * A unit test of `decideThrottle` cannot tell you whether any seat can reach it.
 * That was the defect the work tools shipped with (green suite, zero callers)
 * and the one `sprint-review-cli.test.mjs` exists to prevent, so this speaks
 * JSON-RPC to a subprocess the way an agent does.
 *
 * ── WHAT THE WIRING HAD TO PRESERVE ─────────────────────────────────────────
 * ⚠️ Three shipped assertions in work-gate.test.mjs are keyed to the SOURCE of
 * the handler-selection line — the exact expression, the exact registration,
 * and `isGateArmed()` appearing exactly once. So the throttle composes AROUND
 * that line rather than replacing it:
 *
 *     const withThrottle = isThrottleArmed() ? wrap : (inner) => inner;
 *     const cardCreateHandler = isGateArmed() ? withThrottle(gated) : withThrottle(plain);
 *
 * ⇒ Both flags stay independent, both are read once, and flag-off remains
 *   ABSENCE — `(inner) => inner` is not a branch inside the request path.
 *
 * ── AND THE FLAGS MUST NOT BE ONE FLAG ──────────────────────────────────────
 * ⛔ SCRUM_WORK_GATE already carries two consequences (the gate's refusal AND
 * the six work tools). The gate is a candidate for removal; the throttle is a
 * candidate for keeping. Sharing a flag would make "remove the gate, keep the
 * throttle" impossible without a code change, so the combinations are asserted
 * below rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

const payload = (res) => JSON.parse(res.result.content[0].text);
const THROTTLE_ON = { SCRUM_CLAIM_THROTTLE: 'on' };

async function withServers(env, fn) {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env });
  try {
    await fn({ rest, mcp, session: await mcpSession(mcp.mcpUrl) });
  } finally {
    await mcp.stop();
    await rest.stop();
  }
}

// ── the behaviour, end to end ───────────────────────────────────────────────

test('#755-E-wiring ⭐⭐ A SECOND SEAT INSIDE THE COOLDOWN IS REFUSED — and no card is created', async () => {
  await withServers(THROTTLE_ON, async ({ session, rest }) => {
    const first = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'first in' }));
    assert.equal(first.title, 'first in', 'the first create must succeed');

    const second = payload(await session.callTool('card_create', { createdBy: 'bo', title: 'racing bo' }));
    if (second.refused !== true) {
      const since = new Date(Date.now() - 60000).toISOString();
      const probe = await fetch(`${rest.baseUrl}/api/changes?since=${encodeURIComponent(since)}&limit=50`);
      const body = await probe.text();
      assert.fail(`NO REFUSAL. /api/changes => HTTP ${probe.status} ${body.slice(0, 400)}`);
    }
    assert.equal(second.refused, true);
    assert.equal(second.rule, '#755 claim cooldown');
    assert.ok(second.retryAfterSeconds > 0, 'a refusal must name a finite positive wait');
    assert.match(second.message, /already been claimed or acknowledged/i);

    // ⚠️ A refusal must be a REFUSAL, not a decorated success.
    const cards = await (await fetch(`${rest.baseUrl}/api/cards`)).json();
    const titles = (Array.isArray(cards) ? cards : cards.cards).map((c) => c.title);
    assert.equal(titles.includes('racing bo'), false, 'the card was created despite the refusal');
  });
});

test('#755-E-wiring ⛔ THE SAME SEAT IS NOT THROTTLED — bulk filing is not a collision', async () => {
  await withServers(THROTTLE_ON, async ({ session }) => {
    await session.callTool('card_create', { createdBy: 'ada', title: 'batch one' });
    const second = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'batch two' }));
    assert.equal(second.refused, undefined, `same seat was throttled: ${JSON.stringify(second)}`);
    assert.equal(second.title, 'batch two');
  });
});

test('#755-E-wiring ⛔ WITH THE FLAG OFF NOTHING IS THROTTLED — absence, not a branch', async () => {
  await withServers({}, async ({ session }) => {
    await session.callTool('card_create', { createdBy: 'ada', title: 'unthrottled one' });
    const second = payload(await session.callTool('card_create', { createdBy: 'bo', title: 'unthrottled two' }));
    assert.equal(second.refused, undefined, 'the throttle fired with its flag unset');
    assert.equal(second.title, 'unthrottled two');
  });
});

test('#755-E-wiring ⛔ a truthy-but-not-"on" flag does NOT arm it', async () => {
  // A rail that arms on 'true'/'1'/'' is how one arms itself at 3am.
  for (const v of ['true', '1', 'ON', 'yes', '']) {
    await withServers({ SCRUM_CLAIM_THROTTLE: v }, async ({ session }) => {
      await session.callTool('card_create', { createdBy: 'ada', title: `v-${v}-one` });
      const second = payload(await session.callTool('card_create', { createdBy: 'bo', title: `v-${v}-two` }));
      assert.equal(second.refused, undefined, `armed on ${JSON.stringify(v)}`);
    });
  }
});

// ── ⛔ the two flags are INDEPENDENT, so every option stays reachable ────────

test('#755-E-wiring ⭐⭐ THE THROTTLE ARMS WITHOUT THE GATE — "remove the gate, keep the throttle"', async () => {
  // The option that currently looks most defensible. If it needed a code change
  // it would not be an option, it would be a commitment.
  await withServers(THROTTLE_ON, async ({ session }) => {
    const names = (await session.listTools()).result.tools.map((t) => t.name);
    assert.equal(names.includes('work_declare'), false, 'the work tools armed without SCRUM_WORK_GATE');

    await session.callTool('card_create', { createdBy: 'ada', title: 'gateless one' });
    const second = payload(await session.callTool('card_create', { createdBy: 'bo', title: 'gateless two' }));
    assert.equal(second.refused, true, 'the throttle did not fire without the gate');
  });
});

test('#755-E-wiring the flag NAME lives in one module only', () => {
  // Two places reading one variable is two places that can disagree about what
  // arms it — the same rule the gate's flag already follows.
  const mcpSrc = readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8');
  const modSrc = readFileSync(new URL('../core/claim-throttle.mjs', import.meta.url), 'utf8');
  assert.ok(modSrc.includes('SCRUM_CLAIM_THROTTLE'), 'the flag name must be defined in core/claim-throttle.mjs');
  assert.equal(mcpSrc.includes('SCRUM_CLAIM_THROTTLE'), false, 'the flag name leaked out of its module');
});

test('#755-E-wiring ⚠️ the throttle FAILS OPEN when it cannot ask REST', async () => {
  // If the previous-action lookup fails, the correct answer is ALLOW. A rail
  // whose failure mode is "the board stops accepting cards" is worse than the
  // problem it solves.
  const mcp = await startMcpServer({ restApiBase: 'http://127.0.0.1:1', env: THROTTLE_ON });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('card_create', { createdBy: 'ada', title: 'rest is down' });
    const text = JSON.stringify(res);
    // The create itself will fail (REST is unreachable) — but it must fail as a
    // REST error, never as a throttle refusal.
    assert.equal(text.includes('#755 claim cooldown'), false, 'the throttle refused when it simply could not look');
  } finally {
    await mcp.stop();
  }
});
