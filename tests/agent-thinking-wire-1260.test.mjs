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

test('#1260 the wire carries the MODEL\'s thinking; the agent\'s own field never arrives', async () => {
  // The live shape: the page says false, the model spec says true.
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: false,                                    // what the editor shows
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x', thinking: true },
  });

  assert.equal(sent.think, true,
    'MEASURED, NOT ASSUMED: the wire carries the MODEL value. This is the defect — '
    + 'the agent said false and the request thinks anyway.');

  // ⇒ CHARACTERISATION, ON PURPOSE. #1260 says the instance fix (agent overrides
  // model when set, inherits when unset) is a DECISION and not a value — it is a
  // behaviour change with tests, argued from the owner's stated intent, and it
  // should be decided rather than assumed by whoever happens to be in the file.
  // So this pins TODAY'S truth rather than shipping the change: the moment
  // someone implements the override, this assertion fails and they must come
  // here and say so deliberately. A record that cannot refuse anyone is what let
  // this live; this one can.
});

test('#1260 the agent field is inert in BOTH directions — it cannot turn thinking on either', async () => {
  // ⚠️ The mirror case, and the one a reader would assume works. If only the
  // false-over-true case were asserted, a "fix" that special-cased false would
  // pass while the field stayed unread.
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: true,
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x', thinking: false },
  });
  assert.equal(sent.think, false, 'the agent asking to think is ignored exactly as the agent asking not to is');
});

test('#1260 with no model-level value, the wire sends NO think flag at all — unset is a third state', async () => {
  // The load-bearing positive: this file must not be satisfiable by a wire that
  // always sends `think`. A model with no such flag is sent none, and the agent's
  // field does not fill the gap.
  const sent = await wireBodyFor({
    seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.',
    thinking: true,
    model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
  });
  assert.ok(!('think' in sent),
    'unset means unset: no flag on the wire, and the agent-level value does NOT supply one');
});
