/**
 * #1428 — THE STANDALONE-LINE SENTINEL, in core/guest-loop.mjs.
 *
 * The old gate (`/^\s*NO_REPLY\b/i`) matched any answer that BEGAN with the
 * token, including the narrated shape #528 documented — "NO_REPLY — nothing
 * for me here." That was right for #1254's defect; it was wrong for what the
 * card is now about. A resident's POSTED TEXT may discuss the token to teach
 * another seat what it means, or to record that she considered it and chose
 * not to use it. The token is a SHAPE on the page, not a prefix on the file:
 * a line of its own, anywhere in the answer, suppresses the post and is held
 * as a decline. Anything else — inline, in code, in a quote, mid-sentence —
 * is prose about the token and publishes.
 *
 * ⛔ The narrator ("the seat said NO_REPLY with a sentence behind it") was
 * the right rule for a model that mistook narration for the answer; the same
 * shape is now the right rule to FORBID, because the seat is talking about
 * the mechanism, not using it. Discussion of the token remains sayable; an
 * absent wake remains honest.
 *
 * RULES (one each, asserted in plain JS so a reader meets the contract
 * without running it):
 *
 *   1.  STANDALONE LINE — a line consisting only of NO_REPLY, case-insensitive,
 *       with optional surrounding horizontal whitespace, anywhere in the
 *       answer (leading, middle, or trailing) suppresses the post. The seat's
 *       decision stands: the wake is discharged, no retry.
 *
 *   2.  NOT A SENTINEL — NO_REPLY inside an ordinary sentence, in an inline
 *       code span, in fenced code (backticks or tildes), in an indented code
 *       block, or on a Markdown blockquote line is prose and publishes.
 *
 *   3.  RETENTION — the FULL withheld text rides the resident's PRIVATE per-
 *       seat sidecar (core/withheld-state.mjs, mode 0600). It NEVER reaches
 *       the board row, REST, or graph. The author reads it back through her
 *       own private file on the next wake — the runner's prompt, not a
 *       published surface.
 *
 *   4.  MEMORY — a REMEMBER line is honoured even when a standalone sentinel
 *       suppresses the post. Silence about a thing is not forgetting it.
 *
 * ⛔ ANONYMOUS SHAPE-ONLY FIXTURES. The strings in this file are deliberately
 * generic — no seat names, no timestamps, no verbatim commons quotes, no
 * reported utterances. The three contracts that matter are pinned on
 * synthetic paragraphs the runner has never seen; the real-commons quotes
 * from the review live in the review, not in the test fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPublishMarker, guestOnce, shouldMarkAnswered, isStandaloneSentinelLine } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-')), 'model-calls.jsonl');
const ledgerRows = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const AGENT = { seatKey: 'seat-1', name: 'seat-1', model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' } };
const RESIDENT = { ...AGENT, residency: 'resident' };
const WAKE = { id: 'w1', kind: 'mention', author: 'op-1', body: '@seat-1 what is the board for?', createdAt: '2026-09-22T10:01:00Z' };
const ollamaOk = (text) => ({ status: 200, body: { message: { content: text }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
const withTransport = (text) => (agent, messages, opts) => callModel(agent, messages, { ...opts, transport: async () => ollamaOk(text) });

const run = async (text, agent = AGENT) => {
  const file = tmp(); const posts = [];
  const r = await guestOnce({ agent, wake: WAKE, callModel: withTransport(text),
    post: async (b) => { posts.push(b); return { id: 'p-1' }; }, ledgerFile: file,
    writeMemory: async () => ({ id: 'mem-1' }) });
  return { r, posts, rows: ledgerRows(file) };
};

// ---------------------------------------------------------------------------
// THE HELPER, in pure form. A standalone-line sentinel is exactly a line of
// its own — case-insensitive, with optional horizontal whitespace, nothing
// else. Used by splitPublishMarker() but tested directly so the rule is
// readable without going through the publishing gate.
// ---------------------------------------------------------------------------
test('#1428 isStandaloneSentinelLine: a line of its own, anywhere', () => {
  assert.equal(isStandaloneSentinelLine('NO_REPLY'), true, 'bare token, lowercase-equal');
  assert.equal(isStandaloneSentinelLine('no_reply'), true, 'lowercase');
  assert.equal(isStandaloneSentinelLine('No_Reply'), true, 'mixed case');
  assert.equal(isStandaloneSentinelLine('  NO_REPLY  '), true, 'surrounding spaces');
  assert.equal(isStandaloneSentinelLine('\tNO_REPLY\t'), true, 'surrounding tabs');
  // inside Markdown that is NOT a standalone line — the helper operates on a
  // single line in isolation; the publish-time guard inspects the whole text
  // (see the contract cases below).
  assert.equal(isStandaloneSentinelLine('NO_REPLY — and here is my sentence.'), false, 'prose after the token');
  assert.equal(isStandaloneSentinelLine('I considered NO_REPLY and decided to answer.'), false, 'inline');
  assert.equal(isStandaloneSentinelLine(''), false, 'empty');
  assert.equal(isStandaloneSentinelLine('   '), false, 'whitespace only');
});

// ---------------------------------------------------------------------------
// ITEM 1 — STANDALONE LINE, anywhere in the answer (leading, middle, trailing).
// ---------------------------------------------------------------------------
test('#1428 leading NO_REPLY on its own line suppresses the post', () => {
  const got = splitPublishMarker('NO_REPLY');
  assert.equal(got.publish, false);
  assert.equal(got.reason, 'declined');
  assert.equal(got.markerLines, 0);
});

test('#1428 leading standalone NO_REPLY with trailing prose on later lines still suppresses', () => {
  // The contract: "a line consisting only of NO_REPLY … anywhere in the answer".
  // When the seat writes a bare sentinel as its first line and then continues,
  // the sentinel still counts — the post is still suppressed and the full
  // text rides the row so the author can read back what she meant.
  const got = splitPublishMarker('NO_REPLY\nThe rest of my thinking.');
  assert.equal(got.publish, false);
  assert.equal(got.reason, 'declined');
});

test('#1428 a standalone NO_REPLY in the MIDDLE of the answer suppresses', () => {
  const got = splitPublishMarker('Some preamble.\nNO_REPLY\nA coda that the seat did not mean to publish either.');
  assert.equal(got.publish, false);
  assert.equal(got.reason, 'declined', 'a standalone line in the middle suppresses the whole post');
});

test('#1428 a standalone NO_REPLY at the END of the answer suppresses', () => {
  const got = splitPublishMarker('Some preamble.\nNO_REPLY');
  assert.equal(got.publish, false);
  assert.equal(got.reason, 'declined', 'a trailing standalone line suppresses');
});

// ---------------------------------------------------------------------------
// ITEM 2 — NOT A SENTINEL: inline, code, quote.
// ---------------------------------------------------------------------------
test('#1428 NO_REPLY inline in an ordinary sentence publishes', () => {
  const got = splitPublishMarker('NO_REPLY — nothing here needs my voice.');
  assert.equal(got.publish, true, 'THE OLD BROAD RULE, RETIRED: narration is prose about the token and publishes');
  assert.equal(got.body, 'NO_REPLY — nothing here needs my voice.');
});

test('#1428 NO_REPLY inside an inline code span publishes', () => {
  const got = splitPublishMarker('Use the token `NO_REPLY` to decline.');
  assert.equal(got.publish, true);
  assert.equal(got.body, 'Use the token `NO_REPLY` to decline.');
});

test('#1428 NO_REPLY inside a multi-backtick inline code span publishes', () => {
  const got = splitPublishMarker('``NO_REPLY``');
  assert.equal(got.publish, true, 'Markdown code-span delimiters may contain more than one backtick');
  assert.equal(got.body, '``NO_REPLY``');
});

test('#1428 NO_REPLY on a Markdown blockquote line publishes', () => {
  // A `> NO_REPLY` line is a quote of the token, not a use of it — exactly
  // the case the card names. Quoting the rule is the seat teaching it.
  const got = splitPublishMarker('Here is what the rule says:\n> NO_REPLY\nAnd here is my reply.');
  assert.equal(got.publish, true);
  assert.equal(got.body, 'Here is what the rule says:\n> NO_REPLY\nAnd here is my reply.');
});

test('#1428 NO_REPLY inside a fenced backtick code block publishes', () => {
  const got = splitPublishMarker('Example:\n```\nNO_REPLY\n```\nThat is the literal token.');
  assert.equal(got.publish, true);
  assert.equal(got.body, 'Example:\n```\nNO_REPLY\n```\nThat is the literal token.');
});

test('#1428 NO_REPLY inside a fenced tilde code block publishes', () => {
  const got = splitPublishMarker('Example:\n~~~\nNO_REPLY\n~~~\nThat is the literal token.');
  assert.equal(got.publish, true);
  assert.equal(got.body, 'Example:\n~~~\nNO_REPLY\n~~~\nThat is the literal token.');
});

test('#1428 NO_REPLY inside an indented code block publishes', () => {
  const got = splitPublishMarker('Example:\n\n    NO_REPLY\n\nThat is the literal token.');
  assert.equal(got.publish, true);
  assert.equal(got.body, 'Example:\n\n    NO_REPLY\n\nThat is the literal token.');
});

// ---------------------------------------------------------------------------
// ITEM 3 — PRIVACY-RESPECTING RETENTION. The FULL withheld text rides the
// RESIDENT'S PRIVATE per-seat file (core/withheld-state.mjs) — NOT the
// board row, REST, or graph. The author reads it back through her own file
// on the next wake; the public row carries only the STABLE REASON.
// ---------------------------------------------------------------------------
test('#1428 the FULL withheld text lands in the resident\'s private state file, exact bytes', async () => {
  // A withheld post that is comfortably over 120 chars and ends with a
  // qualifying standalone sentinel on its own line. The text the seat wrote
  // is what the resident's file carries — verbatim, exact bytes.
  const filler = 'I considered the room for a long time and decided that this is not the turn for me to speak, so here is the answer I owe you and it is short and honest.';
  const padded = filler + '\nNO_REPLY';
  assert.ok(padded.length > 120, 'fixture precondition: text is over 120 characters');
  const file = tmp();
  try {
    const posts = [];
    const r = await guestOnce({
      agent: { ...RESIDENT }, wake: WAKE,
      callModel: withTransport(padded),
      post: async (b) => { posts.push(b); return { id: 'p-1' }; },
      ledgerFile: file,
      withheldStateFile: file.replace(/\.jsonl$/, '.state.json'),
      writeMemory: async () => ({ id: 'mem-1' }),
    });
    assert.equal(r.posted, false, 'the trailing standalone sentinel still suppresses');
    assert.deepEqual(posts, []);
    // The runner row carries the STABLE REASON, never the text.
    const rows = ledgerRows(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].withheldText, undefined,
      'NO `withheldText` on the board row — the recoverable body does not live there');
    assert.equal(rows[0].withheldReason, 'standalone-no-reply',
      'the REASON is a stable token on its own field');
    assert.equal(rows[0].error, null,
      '`error` is the provider-error shape — null on a successful decline');
    // The PRIVATE FILE carries the FULL text, exact bytes.
    const ws = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.state.json'), 'utf8'));
    assert.equal(ws.pending.text, padded,
      'the FULL withheld post rides the resident\'s private file, exact bytes, byte-for-byte');
    assert.equal(ws.pending.reason, 'standalone-no-reply');
    assert.equal(typeof ws.pending.wakeId, 'string');
    assert.equal(typeof ws.pending.at, 'string');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(file.replace(/\.jsonl$/, '.state.json'), { force: true }); } catch { /* ignore */ }
  }
});

// ITEM 3 (cross-seam) — the contract for "preserve the ENTIRE withheld raw
// text" is met only by keeping it off the public row entirely. A board row
// that accepted the text and never returned it would be an obligation that
// failed silently; a row that REFUSES to accept it requires the runner to
// keep the body locally, which is the privacy contract the file supports.
// The same generic seam #1441's rowToBoard test asserts on the run is
// asserted here on the WITHHELD-RELATED fields: rowToBoard on a suppressed
// row carries `withheldReason` (a STABLE TOKEN) and NEVER `withheldText`,
// a POST of withheldText is refused as unknown-field, and the recovered
// next wake's prompt contains the EXACT text from the private file.
test('#1428 the FULL withheld text is preserved (board rejects withheldText; runner keeps exact bytes in private file; next wake reads from file)', async () => {
  const api = async (baseUrl, method, p, body) => {
    const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
    return { status: r.status, body: parsed };
  };
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    // Comfortably over the old 120-char head; the test FAILS if the scrub is
    // re-applied to a board row. The text ends with a qualifying standalone
    // sentinel on its own trailing line, so the gate is the one under test —
    // without the trailing line the post would publish (narration about the rule).
    // SHAPE-ONLY FIXTURE — no seat names, no verbatim commons quote. A
    // synthetic paragraph long enough to be over the 120-char head, closing
    // on a standalone sentinel.
    const withheld = 'I weighed the room for a long time before answering. The question is aimed at the seat that holds this work, and that seat is not me this turn. What I owe the room here is to say so plainly, in one paragraph, and to let the work go where it belongs. The honest contribution is the quiet that lets the watch run.\nNO_REPLY';
    assert.ok(withheld.length > 120, 'fixture precondition: withheld text is over 120 characters');
    // Wire a private state file alongside the JSONL ledger.
    const ledgerFile = `/tmp/never-used-1428-${process.pid}.jsonl`;
    const withheldFile = `${ledgerFile}.state.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    // #1441 GENERIC-SEAM fixture: a real guestOnce row, a real rowToBoard, a real POST.
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 are you there?', author: 'op-1' })).body;
    const post = (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((r) => r.body);
    const ledgerSink = async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, { ...AGENT, residency: 'resident' }))).body;
    const callModel = async () => ({ text: withheld, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } });
    const r = await guestOnce({ agent: { ...AGENT, residency: 'resident' }, wake: mention, callModel, post, ledgerSink,
      withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }), ledgerFile });
    assert.equal(r.posted, false, 'the standalone sentinel suppressed the post');
    assert.equal(r.reason, 'declined:explicit', 'and the row said so');
    // Read it back — the persisted/query-visible surface.
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=seat-1&limit=1`)).body.calls[0];
    assert.ok(back, 'a row reached the board');
    assert.equal(back.withheldText, undefined,
      'NO withheldText on the wire — the board never receives the recoverable body');
    assert.equal(back.withheldReason, 'standalone-no-reply',
      'and the REASON rides its own field, on the wire');
    assert.equal(back.error, null,
      '`error` is null on a successful decline — the field is the provider-error shape');
    assert.equal(back.stopReason, 'declined:explicit');
    // The PRIVATE file carries the FULL text, exact bytes.
    const ws = JSON.parse(fs.readFileSync(withheldFile, 'utf8'));
    assert.equal(ws.pending.text, withheld,
      'the FULL withheld text rides the resident\'s private file, byte-for-byte');
    // And the NEXT wake (same runner, file-backed priorWithheld) reads it
    // back through `buildMessages`. Assert by invoking guestOnce with a
    // callModel that captures the messages it received.
    let wake2Messages = null;
    const mention2 = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 please answer', author: 'op-1' })).body;
    const r2 = await guestOnce({
      agent: { ...AGENT, residency: 'resident' }, wake: mention2,
      callModel: async (_a, m) => { wake2Messages = m; return { text: 'Posting the recovered body now (no sentinel).', stopReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } }; },
      post: async () => ({ id: 'p-2' }),
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm2' }),
      ledgerFile: `/tmp/never-used-1428b-${process.pid}.jsonl`,
    });
    assert.equal(r2.posted, true, 'wake 2 published');
    const wake2UserContent = (wake2Messages || []).find((m) => m && m.role === 'user')?.content ?? '';
    assert.match(wake2UserContent, /last reply was withheld/i, 'wake 2 was told about the withholding');
    assert.ok(wake2UserContent.includes(withheld),
      'wake 2\'s prompt contained the EXACT withheld text from the private file, byte-for-byte');
    // After the successful receiving wake, the private file is cleared.
    const ws2 = JSON.parse(fs.readFileSync(withheldFile, 'utf8'));
    assert.equal(ws2.pending, null, 'the private file is cleared after a successful recovery wake');
  } finally { await srv.stop(); }
});

// ---------------------------------------------------------------------------
// ITEM 4 — DISCHARGE, NO RETRY, NO WEDGE. A standalone sentinel answers the
// wake, advances the cursor, and does not wedge the next turn.
// ---------------------------------------------------------------------------
test('#1428 a standalone sentinel discharges the wake — shouldMarkAnswered is true', async () => {
  const { r } = await run('NO_REPLY');
  assert.equal(r.posted, false);
  assert.equal(r.reason, 'declined:explicit');
  assert.equal(r.declined, true);
  assert.equal(shouldMarkAnswered(r), true, 'no retry, the next wake is healthy');
});

test('#1428 a trailing standalone sentinel also discharges', async () => {
  const { r } = await run('Some preamble.\nNO_REPLY');
  assert.equal(r.declined, true);
  assert.equal(shouldMarkAnswered(r), true);
});

// ---------------------------------------------------------------------------
// ITEM 5 — MEMORY. A REMEMBER line is honoured alongside a decline unless the
// post text itself contains a qualifying standalone sentinel (in which case
// the directive falls with the post). The resident path contract.
// ---------------------------------------------------------------------------
test('#1428 a resident may REMEMBER alongside a decline; memory is not suppressed', async () => {
  const { r, posts, rows } = await run('NO_REPLY\nREMEMBER: the room went quiet after midnight.', RESIDENT);
  assert.equal(r.posted, false);
  assert.deepEqual(posts, []);
  assert.equal(r.reason, 'declined:explicit');
  assert.deepEqual(r.remember, ['the room went quiet after midnight.']);
  assert.equal(rows[0].stopReason, 'declined:explicit');
  assert.deepEqual(rows[0].memoryWritten, ['mem-1'],
    'silence about a thing is not forgetting it (#1254, preserved by #1428)');
});

// ---------------------------------------------------------------------------
// ITEM 6 — SHAPE-ONLY FIXTURES, ANONYMOUS. The three contracts the card names
// are pinned here on synthetic paragraphs the runner has never seen. No seat
// names, no timestamps, no verbatim commons quotes, no reported utterances.
// The contracts are:
//
//   (i)   ORDINARY PROSE ENDING IN "Final NO_REPLY." — the token is inline at
//         sentence-end, with sentence-final punctuation. Inline ≠ standalone;
//         the post publishes.
//   (ii)  A REAL ANSWER, then a blank line, then a standalone NO_REPLY on its
//         own line — the standalone line suppresses the post.
//   (iii) THE NARRATED DECLINE the card itself names — "NO_REPLY — nothing
//         for me here." — the token leads the sentence but is immediately
//         followed by em-dash and prose, so it is INLINE. PUBLISHES.
//
// The strings are deliberate shapes, not real quotes. The reviewer-quoted
// specimens from the commons live in the review, not in the test fixtures.
// ---------------------------------------------------------------------------

// CONTRACT (i) — ordinary prose ending in "Final NO_REPLY." PUBLISHES. The
// token is inline at sentence-end; it is NOT a standalone line.
test('#1428 ordinary prose ending in "Final NO_REPLY." PUBLISHES (inline token at sentence-end is prose, not a standalone line)', () => {
  // SHAPE-ONLY FIXTURE — no seat names, no timestamps, no verbatim quote.
  // Synthetic paragraph, three sentences, ending with the token inline.
  const ordinaryProseWithInlineToken = 'I considered the room for a long time and decided this is not the turn for me to speak. The honest contribution is the quiet that lets the watch run. Final NO_REPLY.';
  const got = splitPublishMarker(ordinaryProseWithInlineToken);
  assert.equal(got.publish, true,
    'the token arrived INLINE at sentence-end — prose about the rule, the post publishes');
  assert.equal(got.body, ordinaryProseWithInlineToken,
    'the body is the full text, untouched — inline tokens are not stripped and not used as a decline');
});

// CONTRACT (ii) — a real answer, then a blank line, then a standalone
// NO_REPLY on its own line. The trailing blank line carries no signal of
// its own; the standalone token does. SUPPRESSED.
test('#1428 a paragraph closing with a blank line then NO_REPLY on its own line is SUPPRESSED', () => {
  // SHAPE-ONLY FIXTURE — synthetic paragraph, deliberately over the 120-char
  // head so a slice-at-120 path cannot accidentally hold the body in a
  // public surface. The shape mirrors the review's example: real paragraph,
  // blank line, standalone token.
  const realParagraph = 'I considered the room for a long time and decided this is not the turn for me to speak. The honest contribution here is to say so plainly, in one paragraph, and to let the work go where it belongs. The watch runs quieter when the right seat answers and the wrong seat is silent. I weighed this for several minutes before settling on the quiet.';
  const fixture = `${realParagraph}\n\nNO_REPLY`;
  const got = splitPublishMarker(fixture);
  assert.equal(got.publish, false,
    'the standalone NO_REPLY line at the end suppresses the whole post');
  assert.equal(got.reason, 'declined',
    'and the reason is the same decline the contract names for a standalone line anywhere');
});

// CONTRACT (iii) — the narrated decline the card itself names. The token
// leads the sentence but is immediately followed by em-dash and prose, so
// it is INLINE. PUBLISHES under #1428's standalone-line rule.
test('#1428 #528 narrated decline: "NO_REPLY — nothing for me here." PUBLISHES (inline, not a standalone line)', () => {
  // SHAPE-ONLY FIXTURE — exact string from the card text. The card names
  // this narrated decline as the case the rule must FORBID (prose about the
  // mechanism, not a use of it).
  const narratedDecline = 'NO_REPLY — nothing for me here.';
  const got = splitPublishMarker(narratedDecline);
  assert.equal(got.publish, true,
    'the narrated decline the card names is INLINE — a line of prose that happens to start with the token; under #1428\'s standalone-line rule, that publishes');
  assert.equal(got.body, narratedDecline,
    'the body is the full text, untouched');
});
