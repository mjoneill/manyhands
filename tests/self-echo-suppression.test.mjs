/**
 * #258 — A SEAT'S OWN POST CAME BACK TO IT, AND THE FIX WAS PROMPT TEXT.
 *
 * From #258 as filed, 2026-06-18:
 *
 *   "A channel-receive connection carries no agent identity… it can't skip the
 *    author's own stream (→ why your posts echo back to you; the 'never reply to
 *    your own posts' rule is the duct tape)."
 *
 * ⛔ It sat open for two months while the room hand-executed the duct tape. On
 * 2026-08-19 two seats each discarded their own echo about a dozen times and
 * wrote "my own post, nothing to answer" as a housekeeping note. A third seat's
 * harness carries no such rule, so her seat deliberated on the echo and
 * PUBLISHED the deliberation — eight times in four minutes at one point, each
 * output feeding the next.
 *
 * ⭐ THAT IS A HARNESS LOTTERY, NOT A DISCIPLINE DIFFERENCE. The rule is prompt
 * text some seats were handed and others were not. This makes it unnecessary.
 *
 * ⚠️ THE FAILURE DIRECTION IS THE DESIGN. Suppression requires a session that
 * has posted under this exact author. An untagged session matches nothing and
 * receives everything, so the worst case is an echo that still arrives — never
 * a real message silently dropped, which is #624's failure mode and strictly
 * worse than the defect being fixed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, openChannelStream } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fanoutLines = (s) => s.split('\n').filter((l) => /\[#624\] fanout/.test(l));

// Posting through the MCP TOOL, not through REST. That distinction is the
// entire mechanism: the server sees `author` on the tool call and can tag the
// session. A REST post has no session to tag, and must keep working untouched.
const postViaTool = (sess, body, author) => sess.callTool('conversation_post', { body, author });

const postViaRest = (baseUrl, body, author) => fetch(`${baseUrl}/api/conversations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body, author }),
});

test('#258 an author with an open stream does NOT receive their own post', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const ada = await mcpSession(mcp.mcpUrl);
  const adaStream = await openChannelStream(mcp.mcpUrl, ada.sessionId);
  const grace = await mcpSession(mcp.mcpUrl);
  const graceStream = await openChannelStream(mcp.mcpUrl, grace.sessionId);
  await sleep(250);

  await postViaTool(ada, 'a post from ada', 'ada');
  await sleep(600);

  const [line] = fanoutLines(mcp.stdoutText());
  assert.ok(line, `a fanout line must exist. got: ${mcp.stdoutText().slice(-400)}`);
  assert.match(line, /delivered=1/, "only grace should receive it — ada wrote it");
  assert.match(line, /selfEcho=1/, 'and the suppression must be COUNTED, not silent');

  adaStream.close(); graceStream.close();
});

// ⭐ THE CONTROL. Without it, an implementation that suppressed EVERY session
// would pass the test above and deliver nothing to anyone — a fix that reads as
// working while silently deafening the room. Same shape as #894's staleSessions
// control: a signal that names everyone names no one.
test('#258 ⭐ CONTROL — a NON-author with an open stream still receives it', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const ada = await mcpSession(mcp.mcpUrl);
  const adaStream = await openChannelStream(mcp.mcpUrl, ada.sessionId);
  const grace = await mcpSession(mcp.mcpUrl);
  const graceStream = await openChannelStream(mcp.mcpUrl, grace.sessionId);
  await sleep(250);

  // grace has posted too, so BOTH sessions carry an author tag. If the filter
  // matched on "has any author" rather than "matches THIS author", this fails.
  await postViaTool(grace, 'a post from grace', 'grace');
  await sleep(600);

  const lines = fanoutLines(mcp.stdoutText());
  const line = lines[lines.length - 1];
  assert.match(line, /delivered=1/, 'ada must still receive a post she did not write');
  assert.match(line, /selfEcho=1/, 'exactly one suppressed — grace, not both');

  adaStream.close(); graceStream.close();
});

test('#258 ⛔ an UNTAGGED session receives everything — the fix fails toward an echo', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // A session that has only ever READ. Nothing has taught the server who it is,
  // which is the state every session is in until its first post.
  const lurker = await mcpSession(mcp.mcpUrl);
  const lurkerStream = await openChannelStream(mcp.mcpUrl, lurker.sessionId);
  await sleep(250);

  await postViaRest(rest.baseUrl, 'from someone with no session at all', 'ada');
  await sleep(600);

  const [line] = fanoutLines(mcp.stdoutText());
  assert.match(line, /delivered=1/, 'an untagged reader must receive everything');
  assert.match(line, /selfEcho=0/, 'and nothing is suppressed');
});

test('#258 selfEcho is printed even when it is ZERO', async (t) => {
  // A field that appears only when it fires is invisible on the healthy path,
  // so "the author had no open stream" and "the tag was never learned" read
  // identically — and the second is a silent regression of this whole fix.
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const reader = await mcpSession(mcp.mcpUrl);
  const readerStream = await openChannelStream(mcp.mcpUrl, reader.sessionId);
  await sleep(250);

  await postViaRest(rest.baseUrl, 'nobody here wrote this', 'somebody-else');
  await sleep(600);

  const [line] = fanoutLines(mcp.stdoutText());
  assert.match(line, /selfEcho=0/, 'the denominator must be on the line unconditionally');

  readerStream.close();
});

test('#258 the tag follows the LATEST author a session posts as', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const shifter = await mcpSession(mcp.mcpUrl);
  const shifterStream = await openChannelStream(mcp.mcpUrl, shifter.sessionId);
  const other = await mcpSession(mcp.mcpUrl);
  const otherStream = await openChannelStream(mcp.mcpUrl, other.sessionId);
  await sleep(250);

  await postViaTool(shifter, 'speaking as ada', 'ada');
  await sleep(400);
  await postViaTool(shifter, 'now speaking as grace', 'grace');
  await sleep(600);

  const lines = fanoutLines(mcp.stdoutText());
  assert.equal(lines.length, 2, 'two posts, two fanout lines');
  assert.match(lines[1], /selfEcho=1/, 'the second post is suppressed under the NEW author');

  // ⚠️ And the old identity must not linger: a post as `ada` now reaches the
  // session, because it is no longer speaking as ada.
  await postViaRest(rest.baseUrl, 'a later ada post', 'ada');
  await sleep(600);
  const after = fanoutLines(mcp.stdoutText());
  assert.match(after[2], /selfEcho=0/, 'a stale tag would suppress this wrongly');
  assert.match(after[2], /delivered=2/, 'both sessions receive it');

  shifterStream.close(); otherStream.close();
});
