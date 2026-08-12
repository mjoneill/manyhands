/**
 * #755 slice 2e — THE INPUT PATH, asserted through the actual entry point.
 *
 * ── WHY THESE ARE END-TO-END AND NOT SOURCE GREPS ───────────────────────────
 * `core/work-tools.mjs` shipped with a green unit suite and ZERO callers:
 * `grep work-tools mcp-server.mjs` returned nothing. That is the same defect
 * `sprint-review-cli.test.mjs` was written to close — "a module with no entry
 * point is not an instrument" — and a structural assertion that the import line
 * exists would close it the same way it was opened: by checking the surface the
 * repair touched.
 *
 * ⇒ So these boot the real MCP server as a subprocess and speak JSON-RPC to it,
 *   the way an agent does. A test that can pass while no seat can call the tool
 *   is not testing the thing that was missing.
 *
 * ── WHAT THIS BUYS, in the sprint's own terms ───────────────────────────────
 * Until now a bid was a commons post, and the only work object that ever
 * existed was hand-built with `node -e` during the 2c verification. So signal 1
 * was not "unmeasured pending effort" — it was UNMEASURABLE BY CONSTRUCTION:
 * no bid record could be created, so no bid could be counted, and Saturday
 * would close 1-of-3 signals dark no matter how the week went.
 *
 * ⚠️ It does NOT make bidding required. `decideCoveredAction` allows a seat
 * holding no open window, so this is a volunteer button and the rail sits
 * downstream of the volunteering. That limit is pre-registered on #755 and is
 * asserted below rather than left as prose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

/** A store OUTSIDE the repo — isGateArmed refuses anything inside the tree we publish. */
const storeDir = () => mkdtempSync(join(tmpdir(), 'work-tools-wiring-'));

const armed = (store) => ({ SCRUM_WORK_GATE: 'on', SCRUM_WORK_STORE: store });

/** Unwrap an MCP tool result's JSON payload. */
const payload = (res) => JSON.parse(res.result.content[0].text);

/** Boot REST + MCP with the given env, run `fn`, always tear down. */
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

// ── the entry point exists at all ───────────────────────────────────────────

test('#755-2e ⭐⭐ THE WORK TOOLS ARE REACHABLE BY AN AGENT — the seam that was missing', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    const names = (await session.listTools()).result.tools.map((t) => t.name);
    for (const t of ['work_declare', 'work_bid', 'work_nobid', 'work_contest', 'work_grant', 'work_list']) {
      assert.ok(names.includes(t), `${t} is not registered — the module still has no entry point`);
    }
  });
});

// ── #790 ⛔ THE ENVIRONMENT THE TEST BUILDS IS NOT THE ENVIRONMENT PROD RUNS ──
//
// The test above is a good end-to-end test — its own header argues at length
// against source greps, and it is right. It still could not see this, because
// `armed()` sets ONE flag and production sets TWO.
//
// The defect: `cardCreateHandler = isGateArmed() ? withThrottle(gated) : …`
// and then `if (cardCreateHandler === gatedCardCreate)` to register the work
// tools. With the throttle ARMED, `withThrottle` returns a WRAPPER, so that
// identity is false by construction and all six tools silently vanish. Every
// flag still reads `on`.
//
// ⚠️ The identity comparison was DELIBERATE — the comment beside it explains
// that it avoids a second `isGateArmed()` read so the gate and the tools
// "cannot drift apart," and a test asserts that single call. ⇒ The mechanism
// built to prevent drift is the one that caused it, and the test written to
// protect that mechanism asserts the exact expression that fails.
//
// ⭐ So the acceptance is a two-flag world, with a negative control: a build
// that simply always registers the six would pass the positive half alone.

const WORK_TOOLS = ['work_declare', 'work_bid', 'work_nobid', 'work_contest', 'work_grant', 'work_list'];

// The full 2×2 (@minimo's ask): registration must depend on the GATE and on
// nothing else. The two throttle-on rows are the ones nothing covered — and
// the gate-off rows are the negative control, without which "always register
// them" passes and quietly reintroduces the FLAG-OFF-MEANS-NOT-INSTALLED
// violation the gate's own comment forbids (gate off ⇒ no SCRUM_WORK_STORE
// ⇒ a bid would have nowhere to persist).
const MATRIX = [
  { gate: 'on', throttle: null, present: true },
  { gate: 'on', throttle: 'on', present: true },
  { gate: null, throttle: null, present: false },
  { gate: null, throttle: 'on', present: false },
];

for (const { gate, throttle, present } of MATRIX) {
  const label = `gate=${gate ?? 'off'} throttle=${throttle ?? 'off'}`;
  test(`#790 2×2 — ${label} ⇒ work tools ${present ? 'PRESENT' : 'ABSENT'}`, async () => {
    const env = {};
    if (gate) Object.assign(env, armed(storeDir()));
    if (throttle) env.SCRUM_CLAIM_THROTTLE = throttle;
    await withServers(env, async ({ session }) => {
      const names = (await session.listTools()).result.tools.map((t) => t.name);
      for (const t of WORK_TOOLS) {
        assert.equal(
          names.includes(t), present,
          `${label}: ${t} ${present ? 'vanished' : 'is registered'} — registration must track the GATE and nothing else`,
        );
      }
    });
  });
}

test('#790 ⭐⭐ BENEFICIARY — with BOTH flags armed a seat can actually USE the surface, not just see it', async () => {
  // Raw tools/list proves construction, not beneficiary availability.
  // Registration is necessary and not sufficient — a tool can be listed and
  // still refuse every call. This is the two-flag world doing real work.
  const store = storeDir();
  await withServers({ ...armed(store), SCRUM_CLAIM_THROTTLE: 'on' }, async ({ session }) => {
    const declared = payload(await session.callTool('work_declare', {
      id: 'w-790-throttled', by: 'ada', card: 790, required: ['ada', 'bo'], replyByMinutes: 20,
    }));
    assert.equal(declared.state, 'bidding', `declare refused under the throttle: ${JSON.stringify(declared)}`);

    const listed = payload(await session.callTool('work_list', {}));
    assert.deepEqual(listed.open.map((o) => o.id), ['w-790-throttled']);
  });
});

test('#755-2e a declared work object REACHES DISK and comes back as OPEN state', async () => {
  const store = storeDir();
  await withServers(armed(store), async ({ session }) => {
    const declared = payload(await session.callTool('work_declare', {
      id: 'w-e2e-1', by: 'ada', card: 755, required: ['ada', 'bo'], replyByMinutes: 20,
    }));
    assert.equal(declared.state, 'bidding', `unexpected state: ${JSON.stringify(declared)}`);

    // The bytes, not the return value: a store that answers from memory would
    // pass the line above and lose everything on the next restart.
    const path = join(store, 'work-objects.jsonl');
    assert.ok(existsSync(path), 'nothing was written to the store');
    assert.match(readFileSync(path, 'utf8'), /"id":"w-e2e-1"/);

    const listed = payload(await session.callTool('work_list', {}));
    assert.deepEqual(listed.open.map((o) => o.id), ['w-e2e-1']);
  });
});

// ── ⭐⭐ the measured failure, refused through the real request path ──────────
//
// The defect this whole card exists for: the protocol's own author took a
// covered action INSIDE her own open bid window, thirty seconds after
// publishing the rule, with two seats watching. Until 2e there was no way for a
// seat to open a window at all, so the gate could refuse nobody.

test('#755-2e ⛔ A SEAT INSIDE ITS OWN OPEN WINDOW IS REFUSED card_create — end to end', async () => {
  await withServers(armed(storeDir()), async ({ session, rest }) => {
    await session.callTool('work_declare', {
      id: 'w-e2e-2', by: 'ada', card: 755, required: ['ada', 'bo'], replyByMinutes: 20,
    });

    const refused = payload(await session.callTool('card_create', {
      createdBy: 'ada', title: 'acting inside my own open window',
    }));
    assert.equal(refused.refused, true, `expected a refusal, got ${JSON.stringify(refused)}`);
    assert.equal(refused.rule, '#755 work gate');
    assert.equal(refused.workObjectId, 'w-e2e-2');

    // ⚠️ The refusal must be a REFUSAL, not a decorated success. Asserting on
    // the response shape alone would pass if the card were created anyway.
    const cards = await (await fetch(`${rest.baseUrl}/api/cards`)).json();
    const titles = (Array.isArray(cards) ? cards : cards.cards).map((c) => c.title);
    assert.equal(titles.includes('acting inside my own open window'), false, 'the card was created despite the refusal');
  });
});

test('#755-2e ⭐ a DIFFERENT seat is untouched — the window is a mutex on the WORK, not on a seat', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-e2e-3', by: 'ada', card: 755, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const made = payload(await session.callTool('card_create', { createdBy: 'cy', title: 'unrelated work' }));
    assert.equal(made.refused, undefined, 'a seat with no open window must not be gated');
    assert.equal(made.title, 'unrelated work');
  });
});

test('#755-2e ⭐⭐ AFTER THE WINDOW TIMES OUT the grantee may act — nothing fires, the state is derived', async () => {
  // Design B's whole claim, exercised against a live server: no timer runs at
  // replyBy. The window simply stops being open when `now` passes it, so the
  // refusal lifts without anything having been scheduled.
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-e2e-4', by: 'ada', card: 755, required: ['ada', 'bo'], replyByMinutes: 0.02, // 1.2s
    });
    const early = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'too soon' }));
    assert.equal(early.refused, true, 'sanity: the window should be open first');

    await new Promise((r) => setTimeout(r, 1600));

    const listed = payload(await session.callTool('work_list', {}));
    assert.deepEqual(listed.open, [], 'the window should have closed by timeout');
    assert.equal(listed.settled.find((o) => o.id === 'w-e2e-4').grantedTo, 'ada');

    const made = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'granted by timeout' }));
    assert.equal(made.refused, undefined, `still refused after the window closed: ${JSON.stringify(made)}`);
  });
});

test('#755-2e a nobid from the other required seat closes the window EARLY', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-e2e-5', by: 'ada', card: 755, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const after = payload(await session.callTool('work_nobid', { id: 'w-e2e-5', by: 'bo' }));
    assert.equal(after.state, 'granted');
    assert.equal(after.grantedBy, 'early-close');
    assert.equal(after.grantedTo, 'ada');
  });
});

test('#755-2e a contest sends it to ARBITRATION rather than granting', async () => {
  await withServers(armed(storeDir()), async ({ session }) => {
    await session.callTool('work_declare', {
      id: 'w-e2e-6', by: 'ada', card: 755, required: ['ada', 'bo'], replyByMinutes: 20,
    });
    const after = payload(await session.callTool('work_contest', { id: 'w-e2e-6', by: 'bo' }));
    assert.equal(after.state, 'arbitration_due');
  });
});

// ── flag-off means NOT INSTALLED, at the tool surface too ───────────────────

test('#755-2e ⛔ WITH THE GATE OFF THE TOOLS ARE ABSENT, not present-and-inert', async () => {
  // Same discipline as the gated card_create handler: "off" is absence, never a
  // branch that one inverted boolean could flip. It also has a plain operational
  // reason — with no SCRUM_WORK_STORE there is nowhere for a declaration to go,
  // and a tool that accepts a bid it cannot persist is worse than no tool.
  await withServers({}, async ({ session }) => {
    const names = (await session.listTools()).result.tools.map((t) => t.name);
    for (const t of ['work_declare', 'work_bid', 'work_nobid', 'work_contest', 'work_grant', 'work_list']) {
      assert.equal(names.includes(t), false, `${t} is registered with the gate off`);
    }
    // ...and the board still works. A rail whose failure mode is "the board
    // stops working" is worse than the problem it solves.
    const made = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'gate off, board fine' }));
    assert.equal(made.title, 'gate off, board fine');
  });
});

// ── PII: the tool surface adds no free-text field ──────────────────────────

test('#755-2e ⛔ NO FREE-TEXT FIELD EXISTS ON THE TOOL SURFACE — the guard is the schema', async () => {
  // work-auction refuses unknown fields and carries no title/description, and
  // work-store asserts that survives to disk. This asserts it survives to the
  // surface an agent actually types into — the last place a "just a short note"
  // field could be added without any other test noticing.
  await withServers(armed(storeDir()), async ({ session }) => {
    const tools = (await session.listTools()).result.tools.filter((t) => t.name.startsWith('work_'));
    assert.ok(tools.length >= 6);
    for (const t of tools) {
      const props = Object.entries(t.inputSchema?.properties || {});
      for (const [name, schema] of props) {
        const isFreeText = schema.type === 'string' && !schema.enum;
        const allowed = ['id', 'by', 'to'].includes(name); // opaque keys, not prose
        assert.ok(!isFreeText || allowed, `${t.name}.${name} is a free-text field — PII can arrive here`);
      }
    }
  });
});

test('#755-2e ⭐⭐ AN UNKNOWN FIELD NEVER REACHES DISK — but it is STRIPPED, not refused', async () => {
  // ⚠️ This test was written asserting a REFUSAL and went red. The measured
  // behaviour is that the MCP SDK parses arguments against the declared shape
  // and DROPS unknown keys before the handler runs — so `only()` inside
  // work-tools, which does refuse them, is never reached from this surface.
  // Two guards, and the outer one silently pre-empts the inner one.
  //
  // ⇒ The PII property still holds, and it holds where it matters: the field
  //   does not reach the log, and is not echoed back. That is asserted below
  //   against the BYTES, not the response.
  //
  // ⚠️ What is NOT true is the stronger claim — a seat who puts context in a
  //   `description` gets a SUCCESS with their intent discarded and no warning.
  //   Recorded here as measured behaviour rather than fixed inside a wiring
  //   commit, and carried to #755 as a known edge.
  const store = storeDir();
  await withServers(armed(store), async ({ session }) => {
    const res = await session.callTool('work_declare', {
      id: 'w-e2e-7', by: 'ada', card: 755, required: ['ada'], replyByMinutes: 20,
      description: 'a private detail that must never be logged',
    });
    const text = JSON.stringify(res);
    assert.equal(text.includes('private detail'), false, 'the dropped free text was echoed back');

    const onDisk = readFileSync(join(store, 'work-objects.jsonl'), 'utf8');
    assert.equal(onDisk.includes('private detail'), false, '⛔ free text reached the work-object log');
    assert.equal(onDisk.includes('description'), false, '⛔ an undeclared key reached the work-object log');
  });
});

// ── ⚠️ THE HONEST LIMIT, asserted so it cannot be quietly forgotten ─────────

test('#755-2e ⚠️ A SEAT THAT NEVER DECLARES IS NEVER GATED — this is a volunteer button', async () => {
  // The card's collapse question is "does it fire without being remembered?"
  // and the answer is NO, by construction. Writing that as a passing test means
  // Saturday reads it as a measured property rather than a caveat in prose that
  // a summariser can drop.
  await withServers(armed(storeDir()), async ({ session }) => {
    const made = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'never declared anything' }));
    assert.equal(made.refused, undefined);
    assert.equal(made.title, 'never declared anything');
  });
});
