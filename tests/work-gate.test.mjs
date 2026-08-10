/**
 * #755 slice 2b — the enforced adapter's DECISION, as a pure function.
 *
 * ── WHAT v1 ACTUALLY REFUSES, and why it is this narrow ─────────────────────
 * Signal 2 (v2) reads: "any covered action by a seat HOLDING AN OPEN WORK
 * OBJECT, taken without a recorded grant." So the gate refuses exactly that
 * and nothing else:
 *
 *   a seat whose own bid window is still open may not take a covered action.
 *
 * ⛔ It does NOT require a work object to exist before acting. A gate that
 *    refused every seat who never bid would break the board the instant it was
 *    armed, and would be a far larger claim than the evidence supports. The
 *    observed failure — measured on the protocol's own author, thirty seconds
 *    after she published the rule — was acting INSIDE her own open window.
 *    That is what this refuses.
 *
 * ── THE HUMAN PATH IS EXEMPT BY CONSTRUCTION, NOT BY A CHECK ────────────────
 * The board UI posts straight to server.js:3141. Only agents reach the board
 * through mcp-server.mjs. So the gate lives in the MCP tool ONLY, and the
 * browser cannot enter it — there is no `if (actor === null) allow` to get
 * wrong, because the owner's requests never arrive here at all. The test at
 * the bottom asserts that structurally.
 *
 * ── FLAG-OFF MEANS NOT INSTALLED ────────────────────────────────────────────
 * ⚠️ The steward's condition, and it changed the design: `if (!flagOn) return`
 *    puts the gate IN the path and makes its correctness the only thing
 *    between us and a rail nobody armed — one inverted boolean and the board
 *    refuses seats at 3am, while the suite stays green because tests run with
 *    the flag ON. Absence has no branch to get wrong.
 *
 *    It matters more than it looks: neither service has restarted since Aug
 *    7/8, so an UNRELATED restart is when this code first loads in prod. With
 *    absence that restart is a non-event; with a branch it is a live arming
 *    nobody scheduled and nobody witnessed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideCoveredAction, GATE_ENV } from '../core/work-gate.mjs';
import { declare, nobid, grant, start, contest } from '../core/work-auction.mjs';

const T0 = '2026-08-10T02:00:00.000Z';
const REPLY_BY = '2026-08-10T02:20:00.000Z';
const DURING = '2026-08-10T02:10:00.000Z';
const AFTER = '2026-08-10T02:30:00.000Z';

const openWindow = (by = 'ada') =>
  declare({ id: `wo-${by}`, by, at: T0, replyBy: REPLY_BY, required: ['ada', 'bo'] });

test('#755-2b a seat with NO work objects at all is allowed — v1 does not require a bid to act', () => {
  // A gate that demanded a prior bid from everyone would break the board the
  // moment it armed, and it is a much larger claim than the evidence supports.
  const d = decideCoveredAction({ actor: 'ada', workObjects: [], now: DURING });
  assert.equal(d.allow, true);
});

test('#755-2b ⭐⭐ a seat acting INSIDE ITS OWN OPEN WINDOW is REFUSED — the observed failure', () => {
  const d = decideCoveredAction({ actor: 'ada', workObjects: [openWindow('ada')], now: DURING });
  assert.equal(d.allow, false);
  assert.match(d.reason, /open work object/);
  assert.equal(d.workObjectId, 'wo-ada');
});

test('#755-2b the refusal names the deadline, so the refused seat knows what to wait for', () => {
  const d = decideCoveredAction({ actor: 'ada', workObjects: [openWindow('ada')], now: DURING });
  assert.match(d.reason, /2026-08-10T02:20/);
});

test('#755-2b SOMEONE ELSE\'s open window does not refuse you', () => {
  // The window is a mutex on the WORK, not on the actor's whole existence.
  const d = decideCoveredAction({ actor: 'bo', workObjects: [openWindow('ada')], now: DURING });
  assert.equal(d.allow, true);
});

test('#755-2b once the window is GRANTED, the grantee may act', () => {
  const wo = grant(openWindow('ada'), { by: 'bo', to: 'ada', at: DURING });
  assert.equal(decideCoveredAction({ actor: 'ada', workObjects: [wo], now: DURING }).allow, true);
});

test('#755-2b ⭐ a window that TIMED OUT to a grant lets the grantee act — no daemon had to run', () => {
  // The anti-deadlock property reaching the rail: a quiet room grants, and the
  // gate sees that purely by deriving state at `now`. Nothing wrote anything.
  const wo = openWindow('ada');
  assert.equal(decideCoveredAction({ actor: 'ada', workObjects: [wo], now: DURING }).allow, false);
  assert.equal(decideCoveredAction({ actor: 'ada', workObjects: [wo], now: AFTER }).allow, true);
});

test('#755-2b ⛔ a CONTESTED window keeps refusing even after replyBy — ARBITRATION_DUE is not a grant', () => {
  const wo = contest(openWindow('ada'), { by: 'bo', at: DURING });
  const d = decideCoveredAction({ actor: 'ada', workObjects: [wo], now: AFTER });
  assert.equal(d.allow, false);
  assert.match(d.reason, /contested/);
});

test('#755-2b a window closed by EARLY-CLOSE lets the grantee act before replyBy', () => {
  const wo = nobid(openWindow('ada'), { by: 'bo', at: DURING });
  assert.equal(decideCoveredAction({ actor: 'ada', workObjects: [wo], now: DURING }).allow, true);
});

test('#755-2b work already RUNNING does not refuse its own runner', () => {
  const wo = start(grant(openWindow('ada'), { by: 'bo', to: 'ada', at: DURING }), { by: 'ada', at: DURING });
  assert.equal(decideCoveredAction({ actor: 'ada', workObjects: [wo], now: DURING }).allow, true);
});

test('#755-2b ONE open window among many is enough to refuse', () => {
  const settled = grant(openWindow('ada'), { by: 'bo', to: 'ada', at: DURING });
  const stillOpen = declare({ id: 'wo-2', by: 'ada', at: T0, replyBy: REPLY_BY, required: ['ada', 'bo'] });
  const d = decideCoveredAction({ actor: 'ada', workObjects: [settled, stillOpen], now: DURING });
  assert.equal(d.allow, false);
  assert.equal(d.workObjectId, 'wo-2');
});

test('#755-2b ⛔ NO ACTOR ⇒ ALLOW. The human path can never be refused by this gate.', () => {
  // Belt: even if a browser request somehow reached this function, an absent
  // actor is allowed. Braces: the structural test below says it cannot.
  for (const actor of [null, undefined, '']) {
    assert.equal(decideCoveredAction({ actor, workObjects: [openWindow('ada')], now: DURING }).allow, true);
  }
});

test('#755-2b the decision REFUSES to read the wall clock — `now` is required, like stateAt', () => {
  assert.throws(() => decideCoveredAction({ actor: 'ada', workObjects: [] }), /now is required/);
});

test('#755-2b the decision is pure — no mutation of the work objects handed in', () => {
  const wo = openWindow('ada');
  const before = JSON.stringify(wo);
  decideCoveredAction({ actor: 'ada', workObjects: [wo], now: DURING });
  assert.equal(JSON.stringify(wo), before);
});

// ── the structural guarantees, asserted against the source ──────────────────

test('#755-2b ⭐⭐ THE HUMAN PATH IS EXEMPT BY CONSTRUCTION — server.js never references the gate', () => {
  // The board UI posts to server.js:3141. Only agents arrive via mcp-server.
  // If the gate is never mentioned in server.js, the owner's browser cannot
  // reach it — no runtime check to invert, no config to misread.
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal(serverSrc.includes('work-gate'), false, 'server.js reached the gate — the human path is no longer exempt by construction');
  assert.equal(serverSrc.includes('decideCoveredAction'), false);
});

test('#755-2b ⭐⭐ FLAG-OFF MEANS NOT INSTALLED — the gated handler is chosen at registration, not per call', () => {
  // The steward's condition. `if (!flagOn) return next()` inside the handler
  // would put the gate in the path permanently and make one inverted boolean
  // the whole safety story. Selecting the handler at registration time means
  // flag-off is ABSENCE: the gated function is never referenced.
  const mcpSrc = readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8');
  const gateSrc = readFileSync(new URL('../core/work-gate.mjs', import.meta.url), 'utf8');

  // The env var's NAME lives in exactly one module. mcp-server asks
  // `isGateArmed()` rather than re-deriving the flag — two places reading one
  // variable is two places that can disagree about what arms it.
  assert.ok(gateSrc.includes(GATE_ENV), `${GATE_ENV} must be named in core/work-gate.mjs`);
  assert.equal(mcpSrc.includes(GATE_ENV), false, 'the flag name leaked out of work-gate.mjs');

  // The handler is selected ONCE, at registration, outside any request.
  assert.match(mcpSrc, /const cardCreateHandler = isGateArmed\(\) \?/);
  assert.match(mcpSrc, /\}, cardCreateHandler\);/);

  // And `isGateArmed` is CALLED exactly once — a second call would mean
  // somebody added a per-request read, which is the branch this forbids.
  //
  // ⚠️ Comments are stripped first. The first version of this assertion counted
  // raw occurrences and failed on the explanatory comment directly above the
  // call — a check matching a different surface than the property it claims to
  // measure, which is the defect class this whole card is about. It found a
  // bug in itself rather than in the code.
  const code = mcpSrc.replace(/^\s*\/\/.*$/gm, '');
  assert.equal((code.match(/isGateArmed\(\)/g) || []).length, 1);
});

test('#755-2b the flag is OFF unless explicitly set to "on" — no truthy-by-accident', () => {
  // A config read that defaults truthy is exactly how a rail arms itself at
  // 3am. Only the literal string arms it.
  const src = readFileSync(new URL('../core/work-gate.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("=== 'on'"), 'the flag must be an exact-match against "on"');
});
