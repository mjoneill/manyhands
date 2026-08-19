/**
 * #909 — a seat can test its own RECEIVE path again, after #258 removed the only
 * instrument that did.
 *
 * ⛔ THE GAP, stated precisely, because the two halves look identical from a
 * caller's chair and fail independently:
 *
 *     conversation_post's return   the WRITE landed.  request/response path.
 *     the echo (removed by #258)   the FANOUT reached MY STREAM.  push path.
 *
 * #624 is exactly this: a deaf seat still gets tool returns, so every write looks
 * fine while it receives nothing, and no tool call reveals or repairs it. Until
 * #258 a seat's own post coming back was the one signal from inside a seat that
 * tested the push path. Removing it was right — it was also the whole instrument.
 *
 * ── THE DESIGN DECISION THE CARD LEFT OPEN, AND WHY ────────────────────────
 *
 * #909 named two options: (A) carry the count from the fanout this post
 * triggered, (B) report the current receiver set at response time. It said B is
 * probably right and A is probably a trap, and left the choice to whoever built
 * it. Reading the path settles it:
 *
 *   `conversation_post` returns `await apiCall('POST', '/api/conversations')`.
 *   The fanout runs later, when REST notifies MCP back. There is nothing to
 *   report at response time without making the write path WAIT on the read path
 *   — and coupling those is the thing #624 is about.
 *
 * ⇒ So: B. And then the naming trap the card flagged (#593/#845, a label that
 * promises more than it measures) forced a better answer than `delivered`.
 *
 * ⭐ THE FIELD IS NOT A DELIVERY COUNT AND MUST NOT BE NAMED LIKE ONE. What the
 * echo actually answered was never "how many got it" — it was "IS MY RECEIVE
 * PATH ALIVE?" So that is what this returns, as the fact it is:
 *
 *     reach: { yourStreamOpen: boolean, otherListeners: N }
 *
 * `yourStreamOpen` is the restored instrument. `otherListeners` is the part the
 * echo never gave: whether anyone ELSE is actually there.
 *
 * ⚠️ Both are measured AT POST TIME and neither claims per-message delivery.
 * A seat whose stream dies one millisecond later gets `true` and is wrong — that
 * is honest for a point-in-time reading and is why the field is not called
 * `delivered`, which would be a lie with a timestamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, openChannelStream } from './helpers/harness.mjs';

const post = async (session, body, author = 'ada') => {
  const res = await session.callTool('conversation_post', { body, author });
  const text = res.result?.content?.[0]?.text;
  assert.ok(text, `unexpected tool result: ${JSON.stringify(res).slice(0, 300)}`);
  return JSON.parse(text);
};

test('#909 ⛔ THE INSTRUMENT: a seat with NO open stream is told so', async () => {
  // This is the case that was invisible before. The write succeeds, the message
  // is real, and the seat receives nothing — #624's exact shape. Prior to this
  // field the only signal was the echo, and after #258 there was none at all.
  const p = await startPair();
  try {
    const s = await mcpSession(p.mcp.mcpUrl);
    const out = await post(s, 'posted with no stream open');

    assert.equal(out.reach.yourStreamOpen, false,
      'a seat holding no SSE stream must be TOLD its receive path is dead — that is the whole card');
    assert.ok(out.id, 'and the write itself still succeeded, which is the point: these fail independently');
  } finally { await p.stop(); }
});

test('#909 ⭐ PAIRED CONTROL: with a stream open, the same field says true', async () => {
  // Without this, the assertion above is satisfied by a field hardcoded to false.
  const p = await startPair();
  try {
    const s = await mcpSession(p.mcp.mcpUrl);
    const stream = await openChannelStream(p.mcp.mcpUrl, s.sessionId);
    try {
      const out = await post(s, 'posted with my stream open');
      assert.equal(out.reach.yourStreamOpen, true,
        'the field must distinguish a live receive path from a dead one, or it measures nothing');
    } finally { await stream.close(); }
  } finally { await p.stop(); }
});

test('#909 ⛔ ACCEPTANCE CONTROL: otherListeners differs when the room is deaf', async () => {
  // #909 acceptance 2, verbatim: "with every other session's stream CLOSED, the
  // number must differ from the healthy case. A field that returns the same
  // value whether the room is listening or deaf is decoration."
  const p = await startPair();
  try {
    const author = await mcpSession(p.mcp.mcpUrl);
    const listener = await mcpSession(p.mcp.mcpUrl);

    const deaf = await post(author, 'nobody is listening yet');
    assert.equal(deaf.reach.otherListeners, 0, 'baseline: a session with no stream is not a listener');

    const stream = await openChannelStream(p.mcp.mcpUrl, listener.sessionId);
    try {
      const heard = await post(author, 'now someone is');
      assert.equal(heard.reach.otherListeners, 1, 'an open stream elsewhere must be counted');
      assert.notEqual(heard.reach.otherListeners, deaf.reach.otherListeners,
        'THE CONTROL: the value must MOVE between deaf and listening, or the field is decoration');
    } finally { await stream.close(); }
  } finally { await p.stop(); }
});

test('#909 the author\'s own stream is counted in yourStreamOpen, never in otherListeners', async () => {
  // ⚠️ The off-by-one that would make the number quietly wrong: if the author's
  // own stream leaked into `otherListeners`, a seat alone in an empty room would
  // read 1 and conclude someone was there.
  const p = await startPair();
  try {
    const s = await mcpSession(p.mcp.mcpUrl);
    const stream = await openChannelStream(p.mcp.mcpUrl, s.sessionId);
    try {
      const out = await post(s, 'alone in the room with my own stream open');
      assert.equal(out.reach.yourStreamOpen, true);
      assert.equal(out.reach.otherListeners, 0,
        'a seat alone must not read its own stream as company');
    } finally { await stream.close(); }
  } finally { await p.stop(); }
});

test('#909 ⛔ THE NAME DOES NOT PROMISE DELIVERY — #593/#845, the lying-label class', async () => {
  // The card flagged this explicitly: "If B is chosen, the field must NOT be
  // called `delivered`. A name that promises per-message delivery while
  // reporting receiver count is the lying-label class, and this room has paid
  // for it repeatedly."
  const p = await startPair();
  try {
    const s = await mcpSession(p.mcp.mcpUrl);
    const out = await post(s, 'checking the vocabulary');

    assert.deepEqual(Object.keys(out.reach).sort(), ['otherListeners', 'yourStreamOpen'],
      'the shape is two point-in-time facts; anything else has been added without this test seeing it');
    assert.equal('delivered' in out, false, 'no top-level `delivered` — this does not measure delivery');
    assert.equal('delivered' in out.reach, false, 'and not inside `reach` either');
  } finally { await p.stop(); }
});

test('#909 REST callers are unaffected — the field rides the MCP tool response only', async () => {
  // ⚠️ Scope discipline. `reach` is a fact about MCP sessions and streams; the
  // REST route has no session to report on, and inventing one there would put a
  // meaningless key in every browser response.
  const p = await startPair();
  try {
    const r = await fetch(`${p.rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'from REST', author: 'ada' }),
    });
    const body = await r.json();
    assert.equal(r.status, 201);
    assert.equal('reach' in body, false, 'REST has no stream to report on and must not pretend otherwise');
  } finally { await p.stop(); }
});
