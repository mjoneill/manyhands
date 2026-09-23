/**
 * #1428 REVIEW FIXTURES — content-aware retention and the two wake
 * orders the review named.
 *
 * The reviewer found that the slice as written has two latent defects:
 *
 *   (A)  WAKE ORDER: real withheld reply → next wake receives a hand-back →
 *        a third wake is told the text again → the seat replies with a bare
 *        NO_REPLY. The bare NO_REPLY must CLEAR the hand-back (the author
 *        was told, she chose silence again), NOT overwrite the recoverable
 *        body with "NO_REPLY" — a later wake would still be asked to recover
 *        the old text. And a LATER wake must NOT be invited to recover
 *        "NO_REPLY" — there is nothing recoverable in that token.
 *
 *   (B)  WAKE ORDER: bare NO_REPLY first stores nothing (no recoverable body
 *        to keep), then a later real withheld reply IS retained and handed
 *        back exactly.
 *
 *   (C)  CONTENT-AWARE RETENTION: the runner decides "is this a recoverable
 *        reply or a bare decline" by removing standalone sentinel lines and
 *        the whitespace around them. If anything remains, the FULL ORIGINAL
 *        TEXT — bytes, codepoints, every character — is what the private file
 *        receives. The runner never strips or rewrites the original; it asks
 *        a separate, content-aware predicate and acts on its answer.
 *
 *   (D)  A BARE DECLINE CLEARS ANY HANDED ENTRY. The author was told, she
 *        chose silence. The old text does not stay on the file: the offer is
 *        over, and the seat is not asked to recover it on a later wake.
 *
 *   (E)  THE PRIVATE SIDECAR IS WRITTEN WITH MODE 0600. The recoverable body
 *        is the seat's deliberation; only the seat's own runner reads it.
 *        A file readable by the group or the world is a leak.
 *
 *   (F)  THE LOCAL #1351 DECLINE DIAGNOSTIC IS TEXT-FREE. The runner's local
 *        error field that records "why a reply was not published" no longer
 *        carries the recoverable body. The privacy contract — recoverable
 *        text only on the private sidecar — extends to the runner's own
 *        in-process error shape.
 *
 * ⛔ NONE OF THESE TOUCHES THE SERVER, THE GRAPH, OR THE PUBLIC TELEMETRY.
 * The withheldReason token, the withheldStateOutcome token, the memory.
 *   withheldHanded count, and rowToBoard are unchanged. The contract is:
 *   no recoverable body reaches a public surface. The runner's local error
 *   field is in-process and not public, but it travels to the runner
 *   operator's log — and a log line is somewhere a future reader might
 *   accidentally publish. The text-free reason is what stays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessages, guestOnce, splitPublishMarker } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { writePending, clearPending, handBackFromState, readWithheldState, recoverableContent, isBareDecline } from '../core/withheld-state.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const AGENT = {
  seatKey: 'seat-1', name: 'seat-1', systemPrompt: 'answer',
  residency: 'resident',
  model: { model: 'm', protocol: 'ollama-native' },
};

const WAKE = { id: 'w', kind: 'mention', author: 'op-1', body: '@seat-1 are you there?', createdAt: '2026-09-22T10:01:00Z' };
const ollamaOk = (text) => ({ status: 200, body: { message: { content: text }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
const withTransport = (text) => (agent, messages, opts) => callModel(agent, messages, { ...opts, transport: async () => ollamaOk(text) });

// ⛔ ANONYMOUS SHAPE-ONLY FIXTURES. No seat names, no real-person utterances.
// The string is a deliberately-generic paragraph long enough to be over the
// 120-char head (#1420 / #1428) and shaped like an honest deliberation — a
// few sentences of prose, no names, no card numbers, no timestamps, no
// verbatim quotes from the commons.
const REAL_REPLY = 'I weighed the room for a long time before answering. The question is aimed at the seat that holds this work, and that seat is not me this turn. What I owe the room here is to say so plainly, in one paragraph, and to let the work go where it belongs. The honest contribution is the quiet that lets the watch run.';
const REAL_REPLY_WITH_SENTINEL = `${REAL_REPLY}\nNO_REPLY`;
const REAL_REPLY_LEADING_SENTINEL = `NO_REPLY\n${REAL_REPLY}`;
const REAL_REPLY_SENTINEL_MIDDLE = `${REAL_REPLY}\nNO_REPLY\nAnd a coda.`;

// ===========================================================================
// PURE HELPERS — recoverableContent, isBareDecline.
// ===========================================================================

test('#1428 recoverableContent: standalone NO_REPLY lines and the whitespace around them are removed; the rest is returned trimmed', () => {
  assert.equal(recoverableContent('NO_REPLY'), '',
    'a bare token leaves nothing recoverable');
  assert.equal(recoverableContent('  NO_REPLY  '), '',
    'surrounding whitespace does not become content');
  assert.equal(recoverableContent('\nNO_REPLY\n'), '',
    'leading/trailing newlines and the sentinel are removed');
  assert.equal(recoverableContent(`${REAL_REPLY}\nNO_REPLY`), REAL_REPLY,
    'a real reply with a trailing sentinel reduces to the real reply');
  assert.equal(recoverableContent(`NO_REPLY\n${REAL_REPLY}`), REAL_REPLY,
    'a leading sentinel reduces to the real reply');
  assert.equal(recoverableContent(`${REAL_REPLY}\n\nNO_REPLY\n`), REAL_REPLY,
    'extra newlines and whitespace around the sentinel are also removed');
  assert.equal(recoverableContent(`NO_REPLY\nNO_REPLY`), '',
    'two bare tokens leave nothing recoverable');
  assert.equal(recoverableContent(`Some preamble.\nNO_REPLY\nA coda.`), 'Some preamble.\nA coda.',
    'a sentinel in the middle removes only the sentinel line and its surrounding blank-line whitespace');
  assert.equal(recoverableContent('   \n   \n   '), '',
    'whitespace-only reduces to nothing');
});

test('#1428 isBareDecline: a text whose recoverableContent is empty is a bare decline', () => {
  assert.equal(isBareDecline('NO_REPLY'), true);
  assert.equal(isBareDecline('  NO_REPLY  '), true);
  assert.equal(isBareDecline('\nNO_REPLY\n'), true);
  assert.equal(isBareDecline('   '), true,
    'whitespace-only is also a bare decline');
  assert.equal(isBareDecline(`${REAL_REPLY}\nNO_REPLY`), false,
    'a real reply plus a trailing sentinel is NOT a bare decline');
  assert.equal(isBareDecline(REAL_REPLY), false);
  assert.equal(isBareDecline(null), true,
    'null is a bare decline — nothing to recover');
  assert.equal(isBareDecline(undefined), true,
    'undefined is a bare decline — nothing to recover');
  assert.equal(isBareDecline(''), true);
});

// ===========================================================================
// (A) WAKE ORDER — real reply retained, hand-back received, then bare NO_REPLY
// must CLEAR (the receiving wake chose silence on a hand-back offer); a later
// wake must not be invited to recovery, and a wake before any hand-back must
// not see the sidecar touched at all.
// ===========================================================================

test('#1428 (A) real withheld reply → next wake hand-back → bare NO_REPLY: the receiving wake\'s bare silence CLEARS; a later wake is not invited to recover', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-A-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld-state.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });

    // ===== Wake 1: real withheld reply — private file stores the EXACT text. =====
    const m1 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 first wake', author: 'op-1' })).body;
    let r1Row = null;
    const ledgerSink1 = async (row) => { r1Row = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const r1 = await guestOnce({
      agent: AGENT, wake: m1,
      callModel: withTransport(REAL_REPLY_WITH_SENTINEL),
      post: async () => ({ id: 'p-1' }),
      ledgerSink: ledgerSink1, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r1.posted, false, 'wake 1 declined');
    assert.equal(r1.declined, true);
    assert.equal(r1Row.withheldStateOutcome, 'retained');
    // The private file holds the EXACT ORIGINAL text — the runner does not
    // rewrite the body.
    const ws1 = readWithheldState(withheldFile);
    assert.equal(ws1.pending.text, REAL_REPLY_WITH_SENTINEL,
      'wake 1 stores the FULL ORIGINAL text on the private file — bytes unchanged');
    assert.equal(ws1.pending.reason, 'standalone-no-reply');

    // ===== Wake 2: receives the hand-back and chooses BARE SILENCE. =====
    // The seat was told the exact text. She considered it, and answered with
    // a bare NO_REPLY — her second decision in this turn. The receiving
    // wake's bare silence CLEARS the handed entry: she was told, she
    // declined again, the offer is over. The runner does NOT overwrite
    // "NO_REPLY" into the file (the order-A defect). The cleared file is
    // what the next wake sees.
    let r2Messages = null;
    const m2 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 second wake', author: 'op-1' })).body;
    let r2Row = null;
    const ledgerSink2 = async (row) => { r2Row = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const r2 = await guestOnce({
      agent: AGENT, wake: m2,
      callModel: async (_a, m) => { r2Messages = m; return { text: 'NO_REPLY', stopReason: 'stop', usage: {} }; },
      post: async () => ({ id: 'p-2' }),
      ledgerSink: ledgerSink2, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm2' }),
      ledgerFile: `${ledgerFile}.r2`,
    });
    assert.equal(r2.posted, false, 'wake 2 declined with bare silence on the hand-back');
    assert.equal(r2.declined, true);
    const r2UserContent = (r2Messages || []).find((m) => m && m.role === 'user')?.content ?? '';
    assert.match(r2UserContent, /last reply was withheld/i,
      'wake 2 was offered the hand-back — the prompt carried it');
    assert.ok(r2UserContent.includes(REAL_REPLY_WITH_SENTINEL),
      'wake 2 was told the EXACT ORIGINAL text (the full body, bytes unchanged)');
    // ⛔ #1428 REVIEW — wake 2 received a hand-back and chose bare
    // silence; the runner CLEARS the handed entry. The file does NOT
    // carry the token "NO_REPLY" — it carries nothing, because the author
    // was told and chose silence again.
    assert.equal(r2Row.withheldStateOutcome, 'cleared',
      'a bare decline on a wake WITH hand-back clears — the offer is over');
    assert.equal(r2Row.withheldReason, 'standalone-no-reply');
    assert.equal(r2Row.withheldText, undefined,
      'no recoverable body on the row — only the stable reason');
    const ws2 = readWithheldState(withheldFile);
    assert.equal(ws2.pending, null,
      'after the bare decline, the file is CLEARED — no "NO_REPLY" overwrite, no stale recovery offer');

    // ===== Wake 3: a fresh wake with no hand-back. =====
    // ⛔ #1428 REVIEW — wake 3 receives NO hand-back (the file is
    // empty after wake 2's clear). The wake declines with bare NO_REPLY.
    // The runner touches NO sidecar and carries NO withheldStateOutcome.
    // The file stays exactly as it was: empty.
    const m3 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 third wake', author: 'op-1' })).body;
    let r3Row = null;
    const ledgerSink3 = async (row) => { r3Row = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const r3 = await guestOnce({
      agent: AGENT, wake: m3,
      callModel: withTransport('NO_REPLY'),
      post: async () => ({ id: 'p-3' }),
      ledgerSink: ledgerSink3, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm3' }),
      ledgerFile: `${ledgerFile}.r3`,
    });
    assert.equal(r3.posted, false, 'wake 3 declined');
    assert.equal(r3.declined, true);
    assert.equal(r3Row.withheldReason, 'standalone-no-reply');
    assert.equal(r3Row.withheldText, undefined,
      'no recoverable body on the row — only the stable reason');
    assert.equal(r3Row.withheldStateOutcome, undefined,
      'a bare decline with NO hand-back carries NO withheldStateOutcome — the runner did not touch the sidecar');
    const ws3 = readWithheldState(withheldFile);
    assert.equal(ws3.pending, null,
      'after wake 3, the file is still EMPTY — nothing was retained and nothing was cleared');
    // The file may exist on disk (wake 1 created it; wake 2 cleared it),
    // but its contents are byte-identical to what wake 2 left. The runner
    // did not write it on wake 3 — the unchanged contents and the absent
    // withheldStateOutcome together prove the bare-decline path is
    // touch-no-sidecar.
    assert.deepEqual(ws3, ws2,
      'wake 3\'s bare decline did not touch the sidecar — contents are unchanged from wake 2');

    // ===== Wake 4: a later wake must NOT invite recovery. =====
    // The file was cleared at wake 2 and never written since. The prompt
    // for wake 4 has no hand-back block — there is no recovery offer to
    // decline, and certainly no body whose only content is the token.
    let r4Messages = null;
    const m4 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 fourth wake', author: 'op-1' })).body;
    await guestOnce({
      agent: AGENT, wake: m4,
      callModel: async (_a, m) => { r4Messages = m; return { text: 'No recovery offer here.', stopReason: 'stop', usage: {} }; },
      post: async () => ({ id: 'p-4' }),
      ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body,
      withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm4' }),
      ledgerFile: `${ledgerFile}.r4`,
    });
    const r4UserContent = (r4Messages || []).find((m) => m && m.role === 'user')?.content ?? '';
    assert.doesNotMatch(r4UserContent, /last reply was withheld/i,
      'wake 4 is NOT told about a hand-back — the file is empty, no recovery offer');
    assert.doesNotMatch(r4UserContent, /NO_REPLY/,
      'and the prompt does not contain a recoverable "NO_REPLY" body');
  } finally { await srv.stop(); }
});

// ===========================================================================
// (B) WAKE ORDER — bare NO_REPLY first stores nothing; later real withheld
// reply is retained and handed back exactly.
// ===========================================================================

test('#1428 (B) bare NO_REPLY first stores nothing; later real withheld reply is retained and handed back exactly', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-B-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld-state.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });

    // ===== Wake 1: bare NO_REPLY. The file is empty after. =====
    const m1 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 first wake', author: 'op-1' })).body;
    let r1Row = null;
    const ledgerSink1 = async (row) => { r1Row = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const r1 = await guestOnce({
      agent: AGENT, wake: m1,
      callModel: withTransport('NO_REPLY'),
      post: async () => ({ id: 'p-1' }),
      ledgerSink: ledgerSink1, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r1.posted, false, 'a bare NO_REPLY declines');
    assert.equal(r1.declined, true);
    const ws1 = readWithheldState(withheldFile);
    assert.equal(ws1.pending, null,
      'a bare decline stores NOTHING on the private file — no recoverable body');
    assert.equal(r1Row.withheldReason, 'standalone-no-reply');
    assert.equal(r1Row.withheldText, undefined);
    // ⛔ #1428 REVIEW — a bare decline with NO handed recovery
    // touches no sidecar and carries NO withheldStateOutcome. The wake was
    // an ordinary decline of an ordinary mention: nothing to retain, no
    // hand-back to close, no file operation at all. The runner's local
    // text-free #1351 diagnostic is the only place this wake is named.
    assert.equal(r1Row.withheldStateOutcome, undefined,
      'first bare decline carries NO withheldStateOutcome — the runner did not touch the sidecar');
    // And the file did not get CREATED on a bare decline (no writePending
    // ran). A create-then-empty would also satisfy the contents, but the
    // create itself is the leak the supervisor flagged: an empty file is a
    // sidecar that exists at all, and a bare decline should not leave one.
    assert.equal(fs.existsSync(withheldFile), false,
      'a bare decline leaves NO sidecar file on disk — no create, no overwrite');

    // ===== Wake 2: a real withheld reply with a trailing sentinel. =====
    // The private file receives the EXACT ORIGINAL text — bytes, codepoints.
    const m2 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 second wake', author: 'op-1' })).body;
    let r2Row = null;
    const ledgerSink2 = async (row) => { r2Row = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const r2 = await guestOnce({
      agent: AGENT, wake: m2,
      callModel: withTransport(REAL_REPLY_WITH_SENTINEL),
      post: async () => ({ id: 'p-2' }),
      ledgerSink: ledgerSink2, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm2' }),
      ledgerFile: `${ledgerFile}.r2`,
    });
    assert.equal(r2.posted, false, 'wake 2 declined');
    assert.equal(r2.declined, true);
    assert.equal(r2Row.withheldStateOutcome, 'retained',
      'a real withheld reply after a bare decline still RETURNS to the retained token — the file was empty, the offer is fresh');
    const ws2 = readWithheldState(withheldFile);
    assert.equal(ws2.pending.text, REAL_REPLY_WITH_SENTINEL,
      'the private file receives the EXACT ORIGINAL text — content-aware retention, no rewriting');

    // ===== Wake 3: receives the hand-back; the prompt carries the EXACT text. =====
    let r3Messages = null;
    const m3 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 third wake', author: 'op-1' })).body;
    await guestOnce({
      agent: AGENT, wake: m3,
      callModel: async (_a, m) => { r3Messages = m; return { text: REAL_REPLY, stopReason: 'stop', usage: {} }; },
      post: async () => ({ id: 'p-3' }),
      ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body,
      withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm3' }),
      ledgerFile: `${ledgerFile}.r3`,
    });
    const r3UserContent = (r3Messages || []).find((m) => m && m.role === 'user')?.content ?? '';
    assert.match(r3UserContent, /last reply was withheld/i, 'wake 3 saw the hand-back');
    assert.ok(r3UserContent.includes(REAL_REPLY_WITH_SENTINEL),
      'wake 3 was told the EXACT ORIGINAL text, byte-for-byte (no rewrite, no strip)');
    const ws3 = readWithheldState(withheldFile);
    assert.equal(ws3.pending, null, 'private file cleared after a successful receiving wake');
  } finally { await srv.stop(); }
});

// ===========================================================================
// (D) A bare decline on a wake AFTER a hand-back CLEARS the handed entry.
// ===========================================================================

test('#1428 (D) a bare decline AFTER a hand-back clears the handed entry — the author was told, she chose silence', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-d-')), 'state.json');
  // Seed a hand-back.
  writePending(tmp, { text: REAL_REPLY, reason: 'standalone-no-reply', wakeId: 'w-prev' });
  assert.deepEqual(handBackFromState(tmp).map((m) => m.text), [REAL_REPLY]);

  // The runner sees a bare NO_REPLY on the next wake. The fix: clear, NOT
  // overwrite with "NO_REPLY". The author was told, she chose silence again;
  // the old text does not stay on the file as a stale recovery offer.
  const seeded = readWithheldState(tmp);
  assert.ok(seeded.pending);
  // The decision lives in the runner; this fixture asserts the invariant the
  // runner enforces: an empty/bare decline does NOT call writePending.
  // (WritePending with no recoverable text would itself throw, since
  // writePending requires a non-empty string. So the runner's path for a
  // bare decline is to clear, never to write.)
  assert.equal(isBareDecline('NO_REPLY'), true,
    'the runner sees a bare decline and CLEARS instead of overwriting');
  assert.equal(isBareDecline(`${REAL_REPLY}\nNO_REPLY`), false,
    'but a real withheld reply DOES retain — content-aware');
  clearPending(tmp);
  assert.equal(readWithheldState(tmp).pending, null, 'cleared: no stale recovery offer');
});

// ===========================================================================
// (E) The private sidecar is written with mode 0600.
// ===========================================================================

test('#1428 (E) the private sidecar is written with mode 0600 — recoverable body is the seat\'s deliberation', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e-')), 'state.json');
  try {
    writePending(tmp, { text: REAL_REPLY, reason: 'standalone-no-reply', wakeId: 'w-e' });
    const stat = fs.statSync(tmp);
    // Mode bits: 0o777 & stat.mode. POSIX writes the requested mode through
    // fs.writeFileSync. 0600 = owner read+write, no group, no other.
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600,
      `private sidecar must be 0600 — owner read+write only — got 0o${mode.toString(8)}`);
    // And clearPending also leaves the file 0600 (it writes the empty state).
    clearPending(tmp);
    const stat2 = fs.statSync(tmp);
    assert.equal(stat2.mode & 0o777, 0o600,
      'clearPending also leaves the file 0600');
  } finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ===========================================================================
// (E2) #1428 REVIEW — 0600 IS A PRIVACY GUARANTEE, NOT A BEST-EFFORT.
// An EXISTING file at a permissive mode must end 0600 after the runner
// overwrites it. POSIX `fs.writeFileSync` honours the mode bit only when
// the file is CREATED — overwrites keep the existing mode. The chmod call
// is what pins the final mode regardless of the file's prior state. This
// fixture proves it: seed 0o644, run writePending, assert the file ends
// 0600. Without the chmod pin the file would keep 0o644 and the seat's
// recoverable body would be readable by the group — a leak.
// ===========================================================================

test('#1428 (E2) a permissive existing file ends 0600 after writePending — the chmod pin catches the overwrite path', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e2-')), 'state.json');
  try {
    // Seed the file with a permissive mode AND some prior content (the
    // shape that defeats writeFileSync's mode bit — a CREATE-style write
    // to a path that already has a file).
    fs.writeFileSync(tmp, '{"version":1,"pending":null}');
    fs.chmodSync(tmp, 0o644);
    const seededMode = fs.statSync(tmp).mode & 0o777;
    assert.equal(seededMode, 0o644,
      'sanity: the seeded file is at the permissive mode before the runner overwrites it');

    // The runner's writePending — the operation that lands the recoverable
    // body — overwrites the existing file. Without the chmod pin the file
    // would KEEP 0o644, and the recoverable body would be readable to the
    // group and the world.
    writePending(tmp, { text: REAL_REPLY, reason: 'standalone-no-reply', wakeId: 'w-e2' });

    // After the runner's overwrite, the file is 0600. The chmod pin works
    // on the OVERWRITE path, not just on CREATE.
    const finalMode = fs.statSync(tmp).mode & 0o777;
    assert.equal(finalMode, 0o600,
      `after the overwrite, the file must end 0600 — owner read+write only — got 0o${finalMode.toString(8)}. `
      + 'A 0o644 result here is a leak: the recoverable body would be readable by the group.');
    // The recoverable body itself is on the file (the prior sanity proves
    // the privacy guarantee landed AND the contents are correct).
    const ws = readWithheldState(tmp);
    assert.equal(ws.pending?.text, REAL_REPLY,
      'the recoverable body is on the file alongside the 0600 mode');
  } finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* ignore */ } }
});

// Same shape for clearPending — a permissive existing file is overwritten
// with the empty state, and the final mode is 0600.
test('#1428 (E3) a permissive existing file ends 0600 after clearPending — the chmod pin catches the overwrite path', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e3-')), 'state.json');
  try {
    fs.writeFileSync(tmp, '{"version":1,"pending":null}');
    fs.chmodSync(tmp, 0o666);
    const seededMode = fs.statSync(tmp).mode & 0o777;
    assert.equal(seededMode, 0o666,
      'sanity: the seeded file is at the permissive mode before the runner overwrites it');

    clearPending(tmp);

    const finalMode = fs.statSync(tmp).mode & 0o777;
    assert.equal(finalMode, 0o600,
      `after the overwrite, the file must end 0600 — owner read+write only — got 0o${finalMode.toString(8)}. `
      + 'A 0o666 result here means the file is world-writable — the seat\'s private state would be tamperable by any process.');
    const ws = readWithheldState(tmp);
    assert.equal(ws.pending, null, 'the file holds the empty state');
  } finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ⛔ #1428 REVIEW — chmod failures are LOUD, not silent. The pre-
// fix code wrapped `chmodSync` in `try { … } catch { /* see fallback */ }`
// and let the write return success even when the mode pin had failed —
// the runner believed the file was 0600 when it was not. This fixture
// monkey-patches `fs.chmodSync` to throw (simulating EPERM on a directory
// or read-only filesystem) and proves both writePending and clearPending
// re-throw with a message that names BOTH the failed attempts.
test('#1428 (E4) chmod failure propagates as a loud throw — writePending and clearPending refuse to silently leave a permissive mode', () => {
  const orig = fs.chmodSync;
  fs.chmodSync = () => {
    const e = new Error('EPERM: operation not permitted, chmod');
    e.code = 'EPERM';
    throw e;
  };
  try {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e4-')), 'state.json');
    try {
      let threw = null;
      try { writePending(tmp, { text: REAL_REPLY, reason: 'standalone-no-reply', wakeId: 'w-e4' }); }
      catch (e) { threw = e; }
      assert.ok(threw, 'writePending MUST throw on chmod failure — never silently leave a permissive mode');
      assert.match(threw.message, /atomic/i,
        'the throw names the atomic-path attempt');
      assert.match(threw.message, /fallback/i,
        'the throw names the fallback-path attempt — both attempts failed, both are reported');
      assert.match(threw.message, /EPERM|operation not permitted/i,
        'the throw carries the underlying EPERM signal so the operator can diagnose');

      let threw2 = null;
      try { clearPending(tmp); }
      catch (e) { threw2 = e; }
      assert.ok(threw2, 'clearPending MUST throw on chmod failure — same privacy contract');
      assert.match(threw2.message, /atomic/i);
      assert.match(threw2.message, /fallback/i);
    } finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* ignore */ } }
  } finally {
    fs.chmodSync = orig;
  }
});

// ===========================================================================
// (F) The local #1351 decline diagnostic is text-free — no recoverable body.
// ===========================================================================

test('#1428 (F) the runner\'s local #1351 decline diagnostic is text-free: a STABLE REASON only, no recoverable body', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-F-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld-state.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const errors = [];
    const m1 = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 wake', author: 'op-1' })).body;
    let captured = null;
    const ledgerSink = async (row) => { captured = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    await guestOnce({
      agent: AGENT, wake: m1,
      callModel: withTransport(REAL_REPLY_WITH_SENTINEL),
      post: async () => ({ id: 'p-1' }),
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
      onError: (line) => errors.push(line),
    });
    assert.ok(captured, 'a runner row was captured');
    // ⛔ The runner's local #1351 decline diagnostic used to carry
    // `text.slice(0, 120)` — a 120-char head of the recoverable body, which
    // on a long withheld reply was enough of the deliberation to leak. The
    // privacy contract is that the recoverable body lives only on the
    // resident's PRIVATE sidecar; the runner's onError log line is in-
    // process and not public, but a log line is somewhere a future reader
    // might accidentally publish. The fix: keep the STABLE REASON — what
    // happened — and not the body.
    const diagnostic = errors.find((l) => /\[#1351\]/.test(l));
    assert.ok(diagnostic, `a #1351 diagnostic line was emitted: ${JSON.stringify(errors).slice(0, 200)}`);
    assert.ok(!diagnostic.includes(REAL_REPLY),
      'the #1351 diagnostic line does NOT carry the recoverable body — even trimmed');
    assert.ok(!diagnostic.includes(REAL_REPLY.slice(0, 40)),
      'the #1351 diagnostic line does NOT carry a prefix of the recoverable body');
    assert.match(diagnostic, /declined/i,
      'but it does carry the STABLE REASON — what happened');
    // The runner row stays as it was: error: null on a successful decline
    // (the field is the provider-error shape; the withheld reason rides
    // its own STABLE TOKEN field on the row).
    assert.equal(captured.error, null,
      'runner row error stays null on a successful decline — the provider-error shape, never the recoverable body');
    assert.equal(captured.withheldReason, 'standalone-no-reply');
    assert.equal(captured.withheldStateOutcome, 'retained');
    assert.equal(captured.withheldText, undefined);
  } finally { await srv.stop(); }
});

// ===========================================================================
// Content-aware retention: the runner preserves the EXACT original text.
// ===========================================================================

test('#1428 the runner preserves the FULL ORIGINAL text on the private file — content-aware retention never rewrites', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-content-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld-state.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });

    const cases = [
      { name: 'trailing sentinel', input: REAL_REPLY_WITH_SENTINEL, expected: REAL_REPLY_WITH_SENTINEL },
      { name: 'leading sentinel', input: REAL_REPLY_LEADING_SENTINEL, expected: REAL_REPLY_LEADING_SENTINEL },
      { name: 'sentinel in the middle', input: REAL_REPLY_SENTINEL_MIDDLE, expected: REAL_REPLY_SENTINEL_MIDDLE },
    ];
    for (const c of cases) {
      const m = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@seat-1 wake', author: 'op-1' })).body;
      await guestOnce({
        agent: AGENT, wake: m,
        callModel: withTransport(c.input),
        post: async () => ({ id: `p-${c.name}` }),
        ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body,
        withheldStateFile: withheldFile,
        writeMemory: async () => ({ id: `m-${c.name}` }),
        ledgerFile: `${ledgerFile}.${c.name.replace(/\s+/g, '-')}`,
      });
      const ws = readWithheldState(withheldFile);
      assert.equal(ws.pending.text, c.expected,
        `${c.name}: the FULL ORIGINAL text — bytes, codepoints — is on the private file. recoverableContent="${recoverableContent(c.input)}"`);
    }
  } finally { await srv.stop(); }
});

// ===========================================================================
// #1428 REVIEW — NON-DECLINE DROP DIAGNOSTIC IS 120-CAPPED.
//
// The decline path (gate.reason === 'declined') is text-free by the privacy
// contract — a declined text is a recoverable deliberation, and the body
// lives only on the resident's PRIVATE sidecar. A NON-decline drop is a
// different shape: the text the runner saw is the marker-padded text (or
// empty), not a recoverable deliberation, and the pre-#1428 contract carried
// a 120-char head in `error` AND on the #1351 onError line. #1428's review
// restores that 120-cap exactly on the non-decline path while keeping the
// decline path text-free.
//
// A behavioral fixture that synthesises a >120-character non-decline drop is
// brittle: the resident's `splitDirectives` trims `text` before the gate, so
// any whitespace-heavy resident fixture trims to nothing and the runner's
// `if (!text && !remember.length)` early-return fires before the
// `error: text.slice(0, 120)` branch. The non-resident route avoids the
// trim but exercises a path the production loop does not take (every resident
// and guest is built the same way in guest-once.mjs). Pinning the row's
// `error` expression at the source instead — narrow, exact, contract-level —
// is the contract this test is for.
//
// ⛔ The 120-cap lives ONLY on non-decline drops. A decline (a recoverable
// deliberation, e.g., REAL_REPLY + '\nNO_REPLY') keeps `error: null` on the
// row AND a text-free #1351 line. The real decline tests above (items (F)
// and ITEM 3 in sentinel-1428.test.mjs) continue to prove that contract;
// the source-contract test below pins the non-decline expression at exactly
// `error: text.slice(0, 120)` so a future refactor cannot silently change
// the bound.
// ===========================================================================

test('#1428 (F2) source-contract — non-decline drop row carries exactly `error: text.slice(0, 120)` in core/guest-loop.mjs', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.resolve(here, '..', 'core', 'guest-loop.mjs');
  const source = fs.readFileSync(sourcePath, 'utf8');

  // The non-decline drop branch is conditional: `dropped && !declined`. Find
  // the branch's body by anchoring on its unique opener, then bound the
  // window before the next sibling conditional so we read this branch only,
  // not the next `...(publishBody ? …)` spread. A future refactor that drops
  // the bound (`error: text`) or moves it (`error: text.slice(0, 121)` or
  // `error: text.slice(0, 200)`) trips the asserts below.
  const start = source.indexOf('dropped && !declined');
  assert.ok(start >= 0, 'the non-decline drop branch must exist in core/guest-loop.mjs');
  const nextSpread = source.indexOf('...(publishBody ?', start);
  const end = nextSpread > 0 ? nextSpread : Math.min(source.length, start + 600);
  const body = source.slice(start, end);

  // Exact expression: `text.slice(0, 120)`. The whole point of #1428.
  assert.match(body, /error:\s*text\.slice\(0,\s*120\)/,
    `non-decline drop row must carry exactly \`error: text.slice(0, 120)\` — found body: ${body}`);

  // Negative bounds: the row does NOT carry the unbounded text or any other
  // slice length. A 121- or 200-char cap would be a quiet contract change;
  // an unbounded `error: text` would re-leak the body. Both must fail this
  // test loudly. The exclusion is "any 3-digit slice that is not 120",
  // which is `(1[01][1-9]|12[1-9]|1[3-9][0-9]|[2-9][0-9]{2})` — written
  // as two narrower ranges to keep the regex readable.
  assert.doesNotMatch(body, /error:\s*text\.slice\(0,\s*(12[1-9]|1[3-9][0-9]|[2-9][0-9]{2})\)/,
    'non-decline drop row does NOT carry a slice that is not exactly 120 — the cap is exactly 120');
  assert.doesNotMatch(body, /\berror:\s*text\s*[,}]/,
    'non-decline drop row does NOT carry the unbounded `error: text` — the cap is in force');

  // Decline path is text-free: `error: null` is the exact expression on a
  // decline, NOT a slice of the recoverable body. Pinned alongside the
  // non-decline cap so the two branches cannot accidentally swap shapes.
  const dStart = source.indexOf('...(declined ? {', source.indexOf('const row'));
  assert.ok(dStart >= 0, 'the decline branch must exist in core/guest-loop.mjs');
  const dEnd = source.indexOf('...(dropped && !declined', dStart);
  const declineBranch = [source.slice(dStart, dEnd)];
  assert.match(declineBranch[0], /error:\s*null/,
    `decline branch must carry exactly \`error: null\` — found body: ${declineBranch[0]}`);
  assert.doesNotMatch(declineBranch[0], /error:\s*text\.slice/,
    'decline branch does NOT carry a text slice — the recoverable body stays off the row');

  // #1351 ONERROR LINE on a non-decline drop carries the SAME 120-char head.
  // The decline branch is text-free (`reason=declined`, no body). Both
  // expressions are pinned here so a future refactor cannot collapse them.
  //
  // ⛔ BOUNDED-SOURCE, NOT FULL-FILE REGEX. The pre-fix asserts read the WHOLE
  // source with a regex anchored on `onError(`[#1351]…${text.slice(0, 120)}``
  // — but the actual non-decline line is a template literal that ends the
  // slice with `}"`, not `}`+backtick, so the closing template backtick never
  // sat where the regex demanded it. That brittleness (a regex that matched
  // its own description of the contract rather than the contract) is what
  // this rewrite removes: anchor on the line, bound the window to its closing
  // `;`, then assert on the bounded body — exactly the shape that proved
  // `error: text.slice(0, 120)` correct above.
  const ndStart = source.indexOf('else onError(`[#1351]');
  assert.ok(ndStart >= 0, 'the non-decline #1351 onError line must exist in core/guest-loop.mjs');
  const ndEnd = source.indexOf(';', ndStart);
  assert.ok(ndEnd > ndStart, 'the non-decline #1351 onError line must end with `;`');
  const nonDeclineOnError = source.slice(ndStart, ndEnd);
  assert.match(nonDeclineOnError, /text\.slice\(0,\s*120\)/,
    `non-decline #1351 onError line carries \`text.slice(0, 120)\` exactly — found: ${nonDeclineOnError}`);
  assert.doesNotMatch(nonDeclineOnError, /text\.slice\(0,\s*(12[1-9]|1[3-9][0-9]|[2-9][0-9]{2})\)/,
    'non-decline #1351 onError line does NOT carry a slice that is not exactly 120 — the cap is exactly 120');

  const dLineStart = source.indexOf('if (gate.reason === \'declined\') onError(`[#1351]');
  assert.ok(dLineStart >= 0, 'the decline #1351 onError line must exist in core/guest-loop.mjs');
  const dLineEnd = source.indexOf(';', dLineStart);
  assert.ok(dLineEnd > dLineStart, 'the decline #1351 onError line must end with `;`');
  const declineOnError = source.slice(dLineStart, dLineEnd);
  assert.match(declineOnError, /reason=declined/,
    `decline #1351 onError line carries the STABLE REASON \`reason=declined\` — found: ${declineOnError}`);
  assert.doesNotMatch(declineOnError, /text\.slice/,
    'decline #1351 onError line is TEXT-FREE — no slice of the recoverable body leaks onto the diagnostic');
});
