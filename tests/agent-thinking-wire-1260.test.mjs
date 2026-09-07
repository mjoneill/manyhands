/**
 * #1260 — WHAT THE EDITOR SHOWS AND WHAT THE WIRE CARRIES, MEASURED AT THE WIRE.
 *
 * An agent carries a top-level `thinking`. It is in AGENT_PATCH_FIELDS, so it is
 * writable. It is returned by GET /api/agents, so the settings page shows it.
 * ⛔ Nothing on the call path reads it:
 *
 *   core/guest-loop.mjs   callModel(agent.model, …)   ← passes the MODEL SPEC
 *   core/model-adapter.mjs  thinking: opts.thinking ?? agent.thinking
 *                                                     ← `agent` here IS that spec,
 *                                                       so this is model.thinking
 *
 * ⇒ A seat configured `thinking: false` can think on every turn, and the page a
 * human checks states the opposite of the behaviour.
 *
 * ⚠️⚠️ WHY THIS WENT UNSEEN, AND IT IS THE WHOLE LESSON. A test already existed
 * named "#1196 thinking is stored, read back, AND REACHES THE LOOP". It asserts a
 * PATCH round-trip and a GET. It never invokes the loop. The name claimed exactly
 * the property that is broken, and a green test with that name is why nobody
 * looked. ⇒ A TEST NAME IS A PASSIVE INSTRUMENT: it cannot refuse anyone, it can
 * only be believed. This file asserts at the WIRE instead, where a claim can fail.
 *
 * ⛔ AND A GREP CANNOT ANSWER THIS QUESTION. `grep 'agent\.thinking' core/` reports
 * the field as consumed — twice — because the identifier `agent` names the board
 * record in one file and the model spec in another. Deriving "what the loop reads"
 * from the NAME would have produced a passing audit over a live defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guestOnce } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wire-1260-')), 'model-calls.jsonl');
const ollamaOk = (text) => ({ status: 200, body: { message: { content: `REPLY: ${text}` }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
const WAKE = { id: 'm1', author: 'ada', body: 'hello room', createdAt: '2026-09-06T10:00:00Z' };

/** Run one wake and hand back the body the transport actually received. */
async function wireBodyFor(agent) {
  let sent = null;
  await guestOnce({
    agent,
    wake: WAKE,
    callModel: (a, m, o) => callModel(a, m, {
      ...o,
      // ⚠️ `body` is an OBJECT here, not a JSON string — the protocol hands the
      // transport a structure and the real fetch serialises it. Parsing it threw
      // before the assignment, leaving `sent` null and every assertion below
      // failing on null rather than on the product. Loud, and caught in one run;
      // a harness that had defaulted to `{}` instead would have reported three
      // clean passes about nothing.
      transport: async (req) => { sent = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; return ollamaOk('ok'); },
    }),
    post: async () => ({ id: 'p-1' }),
    ledgerFile: tmp(),
  });
  return sent;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⚖️ THE OVERRIDE WAS IMPLEMENTED, 2026-09-07, and this block exists because
 * this file demanded that whoever implemented it say so here.
 *
 * The three tests below were written as CHARACTERISATION — they pinned today's
 * broken truth so that anyone implementing the fix would be stopped at this file
 * and made to state the change rather than absorb it. That worked exactly as
 * designed: all three went red the moment the override landed, and this block is
 * me coming here and saying so.
 *
 * RULED by the board owner, 2026-09-07: "the agent's value OVERRIDES the model's
 * when set, and INHERITS it when unset" — recommended by both building seats,
 * decided by him. Recorded on #1260 and in the decision log.
 *
 * ⇒ WHAT CHANGED IN EACH, and why each still earns its place:
 *   1  false-over-true — was "the model wins"; now the seat wins. THE defect.
 *   2  true-over-false — the mirror. Still the guard against a fix that only
 *      special-cases `false`; it just asserts the other outcome now.
 *   3  agent set, model unset — was "the agent does NOT supply a flag". Under the
 *      ruling it DOES: set is set, whichever side sets it. ⚠️ The property that
 *      test was really protecting — that this file cannot be satisfied by a wire
 *      which always sends `think` — is NOT lost: it moved to the neither-side-sets
 *      case, asserted below on both branches.
 * ──────────────────────────────────────────────────────────────────────────── */

test('#1260 the agent\'s thinking OVERRIDES the model\'s — the seat said false, the wire says false', async () => {
  // The live shape that started this: the page said false, the model spec said true,
  // and the request thought anyway. Now the page and the wire agree.
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: false,
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x', thinking: true },
  });
  assert.equal(sent.think, false,
    'the seat\'s value wins over the model\'s. This assertion is the inverse of the one '
    + 'it replaced, and that inversion IS the fix.');
});

test('#1260 the override works in BOTH directions — a seat can turn thinking ON as well as off', async () => {
  // ⚠️ Kept from the characterisation set unchanged in purpose: a "fix" that
  // special-cased false would pass the test above and fail this one.
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: true,
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x', thinking: false },
  });
  assert.equal(sent.think, true, 'the seat asking to think is honoured exactly as the seat asking not to is');
});

test('#1260 the agent supplies the flag when the model has none — set is set, whichever side sets it', async () => {
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: true,
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
  });
  assert.equal(sent.think, true,
    'INHERITS when unset means the MODEL inherits from the SEAT here — the seat is the '
    + 'one with a value. The old assertion (no flag) was the defect seen from the other side.');
});

test('#1260 with NEITHER side setting it, the wire sends no think flag — unset is still a third state', async () => {
  // ⭐ THE LOAD-BEARING POSITIVE, inherited from the test above and now standing on
  // its own: this file must not be satisfiable by a wire that always sends `think`.
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
  });
  assert.ok(!('think' in sent), 'no value anywhere means no flag on the wire');
});

/* ────────────────────────────────────────────────────────────────────────────
 * #1260, SECOND CALL SITE — 2026-09-07.
 *
 * ⛔ THE THREE TESTS ABOVE ALL RUN THE NO-TOOL PATH. `wireBodyFor` passes no
 * tools, so `useTools` is false and guest-loop takes:
 *
 *     callModel(agent.model, messages, { ...(agent.model.sampling || {}) })
 *
 * ⚠️ PRODUCTION DOES NOT TAKE THAT BRANCH. The board's resident agents each carry
 * tool grants and scripts/guest-once.mjs supplies an executor, so the live path
 * is runToolLoop → callModel, a DIFFERENT line with its own `opts`.
 *
 * ⇒ A fix applied only to the tested line would turn all three tests above
 * green and leave every real turn unchanged. The class-ending test would have
 * certified the class closed while the defect ran in production — which is the
 * same shape as the "#1196 … AND REACHES THE LOOP" test that never invoked the
 * loop, arriving one layer down in the file written to replace it.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Same as wireBodyFor, but with a tool grant — the path production actually runs. */
async function wireBodyForWithTools(agent) {
  let sent = null;
  await guestOnce({
    agent,
    wake: WAKE,
    tools: [{ type: 'function', function: { name: 'card_get', description: 'x', parameters: { type: 'object', properties: {} } } }],
    execute: async () => ({ ok: true, result: 'x' }),
    callModel: (a, m, o) => callModel(a, m, {
      ...o,
      transport: async (req) => { sent = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; return ollamaOk('ok'); },
    }),
    post: async () => ({ id: 'p-1' }),
    ledgerFile: tmp(),
  });
  return sent;
}

test('#1260 THE TOOL PATH carries the agent\'s thinking too — the branch production actually runs', async () => {
  const sent = await wireBodyForWithTools({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: false,
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x', thinking: true },
    toolGrants: ['card_get'],
  });
  assert.equal(sent.think, false,
    'the agent said false on the TOOL path — the one every tool-granted resident takes on each '
    + 'live turn. If this passes while the no-tool tests fail, only half the fix landed.');
});

test('#1260 the tool path sends NO think flag when neither agent nor model sets one', async () => {
  // The positive control for the tool branch: this file must not be satisfiable
  // by a wire that always carries `think`.
  const sent = await wireBodyForWithTools({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
    toolGrants: ['card_get'],
  });
  assert.ok(!('think' in sent), 'unset on both sides means no flag, on the tool path as well');
});
