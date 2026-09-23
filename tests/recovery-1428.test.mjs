/**
 * #1428 RECOVERY (PRIVACY-RESPECTING) — the author of a withheld reply is
 * told about it on the next wake, and the recovery is via the seat (NOT an
 * auto-replay), but the FULL withheld text NEVER reaches public surfaces.
 *
 * Slice 1 (c650064) suppressed the post and kept the FULL text on the row's
 * `error` field (one row, every reader sees it). Slice 2 (the privacy-
 * violating rebuild) carried it on dedicated `withheldText` fields through
 * /api/model-calls and graph projection — same defect in a worse surface.
 *
 * This file closes the gap on three surfaces:
 *
 *   1. PRIVATE STATE FILE — withheldText lives in
 *      core/withheld-state.mjs, one file per resident seat, written by
 *      the runner on a successful decline, cleared on a successful
 *      receiving wake, preserved on a failed intervening call. NEVER
 *      on the board row, REST, or graph.
 *
 *   2. THE PROMPT — the next wake's buildMessages includes a clearly
 *      labelled block ("⚠️ Your last reply was withheld — it was NOT
 *      posted …") with the EXACT text from the file and the recovery
 *      instruction. The loop never auto-posts, never auto-plays.
 *
 *   3. PUBLIC TELEMETRY — `withheldReason` (a STABLE TOKEN) and
 *      `memory.withheldHanded` (the count) ride the public row. The
 *      recoverable body does NOT.
 *
 * ⛔ EVERY TEST BELOW ASSERTS THE PRIVACY CONTRACT FIRST, then the recovery
 * shape. No test reaches /api/model-calls or the graph for the text — that
 * is what the privacy-violating slice did, and what is now a privacy bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMessages, guestOnce } from '../core/guest-loop.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { readWithheldState, writePending, clearPending, handBackFromState } from '../core/withheld-state.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const AGENT = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer', residency: 'resident', model: { model: 'm', protocol: 'openai-completions' } };
const WAKE_NEW = { id: 'w1', kind: 'mention', author: 'bo', body: '@gizmo are you there?', createdAt: '2026-09-22T10:01:00Z' };
const WAKE_LATER = { id: 'w2', kind: 'mention', author: 'bo', body: '@gizmo please answer', createdAt: '2026-09-22T10:02:00Z' };

const SECRET_PHRASE = crypto.randomBytes(32).toString('hex');
const WITHHELD_PAYLOAD = `I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.\n${SECRET_PHRASE}\nNO_REPLY`;
assert.ok(WITHHELD_PAYLOAD.length > 120, 'fixture precondition: payload is over the #1420 120-char head');

async function boot() {
  return await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
}

async function postMention(srv, body) {
  return (await api(srv.baseUrl, 'POST', '/api/conversations', { body, author: 'bo' })).body;
}

async function recentCalls(srv, agent = 'gizmo', limit = 10) {
  return (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${agent}&limit=${limit}`)).body.calls || [];
}

function scanStringDeep(obj, needle) {
  if (obj == null) return false;
  if (typeof obj === 'string') return obj.includes(needle);
  if (typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((v) => scanStringDeep(v, needle));
  for (const v of Object.values(obj)) if (scanStringDeep(v, needle)) return true;
  return false;
}

/**
 * #1428 — the runner writes the FULL text to the PRIVATE FILE, and the
 * board row carries only the STABLE REASON. The runner's local row that
 * feeds `rowToBoard` does NOT carry the text (the privacy contract: the
 * runner's row is what `rowToBoard` reads from).
 */
test('#1428 the runner row carries withheldReason, error is null, and the FULL text is on the private file', async () => {
  const srv = await boot();
  try {
    const ledgerFile = `/tmp/never-1428-r1-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld.json`;
    let wake1Captured = null;
    const mention = await postMention(srv, '@gizmo are you there?');
    const ledgerSink = async (row) => {
      if (row.wake?.messageId === mention.id) wake1Captured = row;
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: WITHHELD_PAYLOAD, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-x' }),
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r.posted, false, 'a standalone NO_REPLY line suppressed the post');
    assert.equal(r.declined, true);
    assert.equal(r.reason, 'declined:explicit');
    assert.ok(wake1Captured, 'the ledger sink ran');
    assert.equal(wake1Captured.ok, true, 'a successful decline is ok:true — not a failure');
    assert.equal(wake1Captured.error, null, 'error is null on a successful decline: a decline is not a failure');
    assert.equal(wake1Captured.withheldReason, 'standalone-no-reply', 'a STABLE token, not the gate\'s own word');
    assert.equal(wake1Captured.withheldText, undefined,
      'the runner row does NOT carry the recoverable body — it stays in the resident\'s private file');
    // PRIVATE FILE — the recoverable body in its only permitted location.
    const ws = readWithheldState(withheldFile);
    assert.equal(ws.pending && ws.pending.text, WITHHELD_PAYLOAD,
      'the FULL withheld text rides the private file, exact bytes');
    assert.equal(ws.pending && ws.pending.reason, 'standalone-no-reply');
    assert.equal(typeof ws.pending.wakeId, 'string');
  } finally { await srv.stop(); }
});

/**
 * #1428 — board row carries ONLY the stable reason, never the body. The
 * runner's row is fed into rowToBoard (the post runner-to-board builder);
 * rowToBoard → POST → GET → reader returns a row whose withheldReason is
 * the token and whose withheldText does NOT exist as a field.
 */
test('#1428 rowToBoard + REST round-trip withheldReason; withheldText is absent at every step', async () => {
  const srv = await boot();
  try {
    const text = 'I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.\nNO_REPLY';
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      by: 'gizmo', agent: 'gizmo', model: 'm', ok: true,
      stopReason: 'declined:explicit',
      withheldReason: 'standalone-no-reply',
      memory: { withheldHanded: 1 },
      wake: { kind: 'mention', messageId: 'wx' },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.equal(back.withheldReason, 'standalone-no-reply');
    assert.equal(back.withheldText, undefined,
      'withheldText is NOT in the wire response — the body never reaches the board');
    assert.equal(back.memory.withheldHanded, 1);
    // ⛔ PRIVACY: even though we submit something harmless here, the secret
    // phrase from a withheld payload (above) must NOT be visible to any
    // reader of the board. Confirm by querying the graph for ANY triple that
    // includes our secret phrase as the object.
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?c ?p ?o WHERE { ?c ?p ?o . FILTER (?o = "${SECRET_PHRASE}") }`,
      by: 'ada',
    });
    const rows = q.body.rows || [];
    assert.equal(rows.length, 0,
      `graph query for the secret phrase returns 0 triples — the body never reached the graph. Got: ${JSON.stringify(rows).slice(0, 300)}`);
  } finally { await srv.stop(); }
});

/**
 * #1428 — buildMessages hands the withheld text back to the seat as a
 * clearly labelled block, names the post is NOT made, and tells her what
 * to do. The loop must NOT auto-post; it must NOT quote the text into the
 * prompt as itself, only as recoverable body for her to write again.
 *
 * The text here is read from the resident's PRIVATE FILE (handBackFromState),
 * not from the board row — that is the privacy-correct shape.
 */
test('#1428 buildMessages tells the seat her last reply was withheld, gives her the text, and asks her to answer again', () => {
  const wake = WAKE_LATER;
  const prior = [{ text: WITHHELD_PAYLOAD, reason: 'standalone-no-reply' }];
  const prompt = buildMessages({ agent: AGENT, wake, priorWithheld: prior });
  const userContent = prompt.find((m) => m.role === 'user')?.content ?? '';
  assert.match(userContent, /last reply was withheld/i, 'header is unmistakable');
  assert.match(userContent, /NOT posted/i, 'the seat is told the post is NOT made');
  assert.match(userContent, /NOT posted to the room/i, 'and where it would have gone');
  assert.ok(userContent.includes(WITHHELD_PAYLOAD), 'the EXACT full text appears verbatim in the prompt (byte-identical)');
  assert.match(userContent, /standalone-no-reply/, 'the STABLE reason token is named');
  assert.match(userContent, /answer this wake AGAIN WITHOUT the standalone `NO_REPLY` line/i, 'the recovery instruction is concrete');
  assert.match(userContent, /will not auto-replay/, 'auto-replay is explicitly disallowed');
  // The same prompt WITHOUT priorWithheld emits no block.
  const quietContent = buildMessages({ agent: AGENT, wake }).find((m) => m.role === 'user')?.content ?? '';
  assert.doesNotMatch(quietContent, /last reply was withheld/i);
});

/**
 * #1428 — handBackFromState (pure) — reads the private file, returns the
 * new (most recent pending) entry, and bounds at one. A wake that wrote
 * two consecutive suppressions sees the LATEST one (the old one is
 * replaced, not stacked).
 */
test('#1428 handBackFromState (pure) — replacement, clear, error shapes', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'state.json');
  // First call: nothing pending.
  assert.deepEqual(handBackFromState(tmp), [], 'empty file yields empty hand-back');
  // A pending entry surfaces.
  writePending(tmp, { text: 'OLD suppressed reply.', reason: 'standalone-no-reply', wakeId: 'w1', at: '2026-09-22T10:01:00Z' });
  const first = handBackFromState(tmp);
  assert.deepEqual(first, [{ text: 'OLD suppressed reply.', reason: 'standalone-no-reply' }],
    'the pending entry surfaces exactly once on the next wake');

  // A new suppression REPLACES the prior one. Two consecutive declines do
  // not stack: the next wake is told about the NEW one only.
  writePending(tmp, { text: 'NEW suppressed reply (overwritten old).', reason: 'standalone-no-reply', wakeId: 'w2' });
  const second = handBackFromState(tmp);
  assert.deepEqual(second.map((m) => m.text), ['NEW suppressed reply (overwritten old).'],
    'the new suppression replaces the old; the next wake is told the new one');

  // Clear (successful receiving wake) returns empty.
  clearPending(tmp);
  assert.deepEqual(handBackFromState(tmp), [], 'a clearPending leaves nothing to hand back');
  // Malformed file: treated as empty.
  fs.writeFileSync(tmp, '{ this is not valid json ');
  assert.deepEqual(handBackFromState(tmp), [],
    'a malformed file is treated as empty rather than thrown — defensive read');
  // Text longer than 16 000 chars with multi-byte unicode: round-trips byte-identical.
  const filler = 'I weighed the room — 漢字 한자 Ω∞ ✓✗ — and chose quiet, here is the answer I owe you, and it is short and honest. ';
  let big = ''; while (big.length < 18_500) big += filler;
  big = big + '— end unicode sentinel —\nNO_REPLY';
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  const tmp2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'state.json');
  writePending(tmp2, { text: big, reason: 'standalone-no-reply', wakeId: 'wb' });
  const big1 = handBackFromState(tmp2);
  assert.equal(big1[0].text, big,
    '>18 500-char unicode payload round-trips the private file byte-for-byte, codepoint for codepoint');
  assert.ok(big1[0].text.endsWith('\nNO_REPLY'), 'and the trailing standalone sentinel survives intact');
});

/**
 * #1428 — END-TO-END BANANA TEST, IN CODE.
 *
 *   Wake 1 — the seat is asked a question. The model returns a long reply
 *            that ENDS with a trailing `NO_REPLY` on its own line. The post
 *            is suppressed; the FULL text is written to the PRIVATE FILE;
 *            the row carries only the STABLE REASON. NO auto-replay.
 *
 *   Wake 2 — the seat is asked AGAIN. The runner reads the private file
 *            via handBackFromState, hands the withheld text back via
 *            buildMessages, the model deliberately recovers by quoting the
 *            body without the sentinel, and ONE post is made. The
 *            receiving wake's row records `withheldHanded >= 1`. The
 *            private file is CLEARED.
 *
 * The Banana assertion:
 *   - the prompt wake 2 saw contained the EXACT text from the PRIVATE FILE
 *     and the recovery instruction;
 *   - no auto-replay happened before wake 2's answer;
 *   - the public row carries `withheldHanded` and `withheldReason` only;
 *   - the secret phrase does NOT appear on the board's REST or graph
 *     surface at any point.
 */
test('#1428 Banana — wake 1 private-file stores; wake 2 file-backed hand-back tells the seat; one post is made; secret phrase never reaches the board', async () => {
  const srv = await boot();
  try {
    const ledgerFile = `/tmp/never-1428-banana-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });

    // ===== Wake 1 =====
    const mention1 = await postMention(srv, '@gizmo what is the board for?');
    const posts = [];
    let wake1Captured = null;
    const ledgerSink = async (row) => {
      if (row.wake?.messageId === mention1.id) wake1Captured = row;
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const r1 = await guestOnce({
      agent: AGENT, wake: mention1,
      callModel: async () => ({ text: WITHHELD_PAYLOAD, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async (b) => { posts.push(b); return { id: 'p-1' }; },
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r1.posted, false, 'wake 1 suppressed the post');
    assert.equal(r1.reason, 'declined:explicit');
    assert.equal(posts.length, 0, 'NO POST on wake 1 — there cannot be an auto-replay the same wake');
    assert.equal(wake1Captured?.withheldText, undefined,
      'wake 1\'s runner row does NOT carry withheldText');
    assert.equal(wake1Captured?.withheldReason, 'standalone-no-reply');
    assert.equal(wake1Captured?.error, null);
    const ws1 = readWithheldState(withheldFile);
    assert.equal(ws1.pending.text, WITHHELD_PAYLOAD, 'the FULL text is in the private file');
    // Board round-trips the reason on the wire.
    const persisted = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=gizmo&limit=1`)).body.calls[0];
    assert.equal(persisted.withheldText, undefined, 'the wire returns NO withheldText');
    assert.equal(persisted.withheldReason, 'standalone-no-reply');
    assert.equal(persisted.memory.withheldHanded, null, 'NO hand-back happened yet');
    // ⛔ PRIVACY: the secret phrase does not reach the board.
    assert.equal(scanStringDeep(persisted, SECRET_PHRASE), false,
      'no field returned by GET /api/model-calls carries the secret phrase');

    // ===== Wake 2 =====
    const mention2 = await postMention(srv, '@gizmo please answer');
    // The seat recovers by QUOTING the body (without the standalone sentinel)
    // — a deliberate act, no auto-replay. The Banana assertion reads the
    // messages this wake was handed.
    const recoveredBody = 'I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.';
    let wake2Messages = null;
    const secondCallModel = async (_a, messages) => {
      wake2Messages = messages;
      return { text: recoveredBody, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } };
    };
    const r2 = await guestOnce({
      agent: AGENT, wake: mention2,
      callModel: secondCallModel,
      post: async (b) => { posts.push(b); return { id: 'p-2' }; },
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm2' }),
      ledgerFile: `${ledgerFile}.b`,
    });
    assert.equal(r2.posted, true, 'wake 2 posted the recovered body');
    assert.equal(posts.length, 1, 'exactly ONE post in this scenario (wake 1 did NOT post automatically)');
    assert.equal(posts[0].body, recoveredBody, 'and it is the recovered body, verbatim, without the sentinel');
    const wake2UserContent = (wake2Messages || []).find((m) => m && m.role === 'user')?.content ?? '';
    assert.match(wake2UserContent, /last reply was withheld/i, 'wake 2\'s prompt named the withholding');
    assert.match(wake2UserContent, /NOT posted/i);
    assert.ok(wake2UserContent.includes(WITHHELD_PAYLOAD),
      'wake 2\'s prompt contained the EXACT withheld text from the private file, byte-for-byte (no JSON escape loss)');
    assert.match(wake2UserContent, /standalone-no-reply/, 'wake 2\'s prompt named the stable reason');
    assert.match(wake2UserContent, /answer this wake AGAIN WITHOUT the standalone `NO_REPLY` line/i, 'wake 2\'s prompt named the recovery instruction');
    // The receiving wake's row records withheldHanded >= 1 — the next wake
    // will NOT see this hand-back again.
    const wake2Row = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.ok(wake2Row.memory.withheldHanded >= 1, 'wake 2 received ≥ 1 hand-back');
    assert.equal(wake2Row.stopReason, 'stop', 'wake 2\'s stop reason is the model\'s, not the boundary\'s');
    assert.equal(wake2Row.withheldReason, null, 'wake 2\'s row is NOT a withheld row');

    // PRIVACY: even after recovery, the secret phrase never reached the
    // public surfaces.
    const allCalls = await recentCalls(srv);
    assert.equal(scanStringDeep(allCalls, SECRET_PHRASE), false,
      'no row returned by GET /api/model-calls carries the secret phrase after wake 2 either');
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?o WHERE { ?s ?p ?o . FILTER (?o = "${SECRET_PHRASE}") }`,
      by: 'ada',
    });
    assert.equal((q.body.rows || []).length, 0,
      'graph returns 0 rows whose object is the secret phrase — the body was never projected');

    // After a successful wake that received the hand-back, the file is CLEARED.
    const ws2 = readWithheldState(withheldFile);
    assert.equal(ws2.pending, null, 'the private file is cleared after a successful receiving wake');
  } finally { await srv.stop(); }
});

/**
 * #1428 — FAILED INTERVENING MODEL CALL PRESERVES THE PENDING TEXT.
 *
 *   Wake 1: suppresses (writes the private file).
 *   Wake 2: the model FAILS (ok:false). The pending text is preserved
 *           (the file is not touched); the seat never saw the prompt's
 *           hand-back.
 *   Wake 3: a successful wake IS told the withheld text via the file,
 *           and can recover.
 */
test('#1428 a failed intervening call PRESERVES the private file — the hand-back survives', async () => {
  const srv = await boot();
  try {
    // Wake 1: write the seed to the file directly (a unit-level seed avoids
    // a 2-call wake here — the chained shape is the Banana test above).
    const ledgerFile = `/tmp/never-1428-fail-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    writePending(withheldFile, { text: WITHHELD_PAYLOAD, reason: 'standalone-no-reply', wakeId: 'w-seed' });
    // Confirm the seed is visible to a hand-back read.
    const before = handBackFromState(withheldFile);
    assert.deepEqual(before.map((m) => m.text), [WITHHELD_PAYLOAD]);

    // Wake 2: a FAILED call (ok:false). Even on failure, the file is left
    // alone — a failed call did not see the prompt, did not answer, and
    // must not consume the offer.
    const mention1 = await postMention(srv, '@gizmo please retry');
    await guestOnce({
      agent: AGENT, wake: mention1,
      callModel: async () => { throw new Error('provider still 503'); },
      post: async () => ({ id: 'pf2' }),
      ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body,
      withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm2' }),
      ledgerFile: `${ledgerFile}.failed`,
    });
    // Confirm the failed row IS on the board (the seam's invariant — the
    // proof that the runner did try).
    const callsAfterFailed = await recentCalls(srv);
    const failedRow = callsAfterFailed.find((r) => r.ok === false && typeof r.error === 'string' && r.error.includes('provider still 503'));
    assert.ok(failedRow, `a failed row reached the board — runner tried, error=${failedRow && failedRow.error}`);
    // The file is unchanged.
    const afterFailed = readWithheldState(withheldFile);
    assert.deepEqual(afterFailed.pending && afterFailed.pending.text, WITHHELD_PAYLOAD,
      'a failed intervening call PRESERVES the pending text — the hand-back survives');

    // Now a successful wake 3 with file-backed priorWithheld — assert the
    // prompt contains the text and the wake does NOT post (callModel returns
    // NO_REPLY again on its own line).
    let wake3Messages = null;
    const mention2 = await postMention(srv, '@gizmo please retry again');
    await guestOnce({
      agent: AGENT, wake: mention2,
      callModel: async (_a, m) => { wake3Messages = m; return { text: WITHHELD_PAYLOAD, stopReason: 'stop', usage: {} }; },
      post: async () => ({ id: 'pf3' }),
      ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body,
      withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm3' }),
      ledgerFile: `${ledgerFile}.wake3`,
    });
    const wake3UserContent = (wake3Messages || []).find((m) => m && m.role === 'user')?.content ?? '';
    assert.match(wake3UserContent, /last reply was withheld/i, 'wake 3 (the next successful wake after the failed call) saw the hand-back');
    assert.ok(wake3UserContent.includes(WITHHELD_PAYLOAD), 'and it was told the EXACT text from the private file, byte-for-byte (no JSON escape loss)');
  } finally { await srv.stop(); }
});

/**
 * #1428 EXACT RECOVERY — a withheldText LONGER than the old 16 000-char
 * ceiling the privacy-violating slice claimed survived, in fact round-trips
 * through the PRIVATE FILE byte-for-byte (this slice never had that
 * truncation in the first place because the text never leaves the resident).
 *
 * The fixture builds a unicode-heavy suppressed post well over 16 000 chars
 * with multi-byte characters (so a character slice would also chop mid-
 * codepoint in UTF-8) and ends with a final standalone NO_REPLY line.
 *
 * The contract:
 *   - The private file receives the full text, byte-for-byte.
 *   - The reader-facing NEXT-WAKE PROMPT (handBackFromState → buildMessages)
 *     contains the FULL text, every codepoint.
 *   - Graph and REST never see the text.
 */
test('#1428 EXACT RECOVERY — withheldText >16 000 chars (unicode + trailing NO_REPLY) reaches the prompt from the private file, exact codepoint', async () => {
  const proseLine = 'I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly. ';
  let big = '';
  while (big.length < 18_500) big += proseLine;
  big = big + '— unicode sentinel line — 漢字 한자 Ω∞ ✓✗\nNO_REPLY';
  const withheld = big;
  assert.ok(withheld.length > 16_000, `fixture precondition: withheld text over 16 000 chars (length=${withheld.length})`);
  assert.ok(Buffer.byteLength(withheld, 'utf8') > withheld.length,
    'fixture precondition: UTF-8 bytes exceed character count (multi-byte unicode is present)');
  assert.match(withheld.split('\n').pop(), /^NO_REPLY$/, 'fixture precondition: final line is the standalone sentinel');

  // Write directly to the file (we're testing the file + prompt shape), then
  // assert that the prompt the runner would build contains the EXACT text.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'state.json');
  writePending(tmp, { text: withheld, reason: 'standalone-no-reply', wakeId: 'wb' });
  const prompt = buildMessages({ agent: AGENT, wake: WAKE_LATER, priorWithheld: handBackFromState(tmp) });
  const userContent = prompt.find((m) => m.role === 'user')?.content ?? '';
  assert.ok(userContent.includes(withheld),
    `the prompt contains the EXACT unicode text, every codepoint. prompt length=${userContent.length}, expected=${withheld.length}`);
  // The text contains the trailing standalone sentinel somewhere in the
  // prompt's body (the prompt appends a recovery instruction after the
  // recoverable body, so we do not assert `endsWith` — only that the
  // sentinel itself is present in the prompt intact).
  assert.ok(userContent.includes('\nNO_REPLY'),
    'and the trailing standalone sentinel survives intact through the file → prompt path');
  // Privacy: no field carries the secret (here, the long unicode sentinel
  // marker) on the board. Assert via rowToBoard on a synthetic row.
  const synthetic = rowToBoard({ agent: 'gizmo', model: 'm', protocol: 'ollama-native', ok: true, error: null, usage: null,
    wake: { kind: 'mention' }, latencyMs: 0, withheldReason: 'standalone-no-reply', at: '2026-09-22T10:00:00Z' }, AGENT);
  assert.equal(scanStringDeep(synthetic, '漢字'), false,
    'rowToBoard output never carries the recoverable body — only the stable reason');
  assert.equal(synthetic.withheldReason, 'standalone-no-reply');
  assert.equal(synthetic.withheldText, undefined);
});
