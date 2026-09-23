/**
 * #1428 PRIVACY — DISK FAILURE MUST BE LOUD, NOT SILENT.
 *
 * The privacy-correct slice carries the recoverable body in the resident's
 * PRIVATE per-seat file (core/withheld-state.mjs). If neither the atomic
 * rename nor the fallback write actually lands the text, the runner MUST
 * know — and the public row MUST NOT receive anything recoverable as a
 * stand-in for "the file is fine". The slice was #1441-shaped: silently
 * pretending recoverability where nothing was retained. This file asserts
 * the slice is now LOUD on persistence failure, and that the privacy
 * contract still holds when it fires.
 *
 * Contract:
 *
 *   1. writePending / clearPending REPORT (throw or return a failure
 *      signal) when NEITHER the atomic rename NOR the direct fallback
 *      actually wrote the file. A deterministic invalid path — a child
 *      location under a regular file — makes both attempts fail without
 *      chmod assumptions.
 *
 *   2. guestOnce KEEPS THE TEXT DURABLE BEFORE THE PUBLIC ROW. The
 *      runner writes the resident's private file FIRST; only AFTER it
 *      is on disk does recordLedger run. The exception: the failure
 *      path, where the runner DOES NOT pretend the row is fine, and
 *      the public row carries an explicit local-only signal that
 *      recovery failed (a stable boolean / token — NEVER the text,
 *      NEVER a filesystem path).
 *
 *   3. Failed private persistence is LOUD: onError receives a diagnostic
 *      that names #1428 and the operation. The post remains suppressed.
 *      Nothing recoverable reaches rowToBoard, REST, or graph.
 *
 * The deterministic invalid path: a regular file, then a CHILD PATH
 * under it. `fs.writeFileSync(<child>, …)` returns ENOTDIR on every
 * supported platform (POSIX), and the rename source — `<file>.tmp-…` —
 * is similarly not creatable. Both attempts fail for the same reason:
 * the parent component is a file, not a directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePending, clearPending, readWithheldState, handBackFromState } from '../core/withheld-state.mjs';
import { guestOnce } from '../core/guest-loop.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const SECRET_PHRASE = crypto.randomBytes(32).toString('hex');
const WITHHELD_TEXT = `I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.\n${SECRET_PHRASE}\nNO_REPLY`;

const AGENT = {
  seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer',
  residency: 'resident',
  model: { model: 'm', protocol: 'openai-completions' },
};

/**
 * Build a deterministic invalid path: a CHILD path under a regular file.
 * Both `writeFileSync(target)` and `writeFileSync(<target>.tmp-…)` then
 * fail with ENOTDIR — the parent component is a file, not a directory,
 * so neither the atomic rename nor the direct fallback can land a byte.
 * The runner's `mkdirSync(path.dirname(target))` either succeeds silently
 * (when the parent already exists) or fails with EEXIST; both are
 * reported loudly by writeJsonAtomic.
 */
function invalidUnderRegularFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-disk-fail-'));
  const regPath = path.join(dir, 'a-regular-file');
  fs.writeFileSync(regPath, 'i am a regular file, not a directory');
  // CHILD path: writing here must fail with ENOTDIR on every supported
  // platform (POSIX), no chmod required. The tmp file lives alongside
  // (still under the regular-file parent), so it also fails ENOTDIR.
  const childPath = path.join(regPath, 'state.json');
  return { regPath, childPath, dir };
}

function scanStringDeep(obj, needle) {
  if (obj == null) return false;
  if (typeof obj === 'string') return obj.includes(needle);
  if (typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((v) => scanStringDeep(v, needle));
  for (const v of Object.values(obj)) if (scanStringDeep(v, needle)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// UNIT: writeJsonAtomic surfaces failure when neither atomic nor fallback
// writes the file. The deterministic invalid path makes BOTH attempts fail
// with ENOTDIR, so a passing test would only happen if the implementation
// actually reported it.
// ---------------------------------------------------------------------------
test('#1428 writePending THROWS / REPORTS when neither atomic nor fallback persistence succeeds (invalid path)', () => {
  const { childPath, dir } = invalidUnderRegularFile();
  try {
    // Use the child-under-regular-file path. Both writeFileSync(tmp) and
    // writeFileSync(<file>, …) fail with ENOTDIR (parent component is a
    // file). mkdirSync(path.dirname(target)) may also fail with EEXIST
    // (parent is a file). All three are reported by writeJsonAtomic.
    let threw = null;
    let result = null;
    try { result = writePending(childPath, { text: 'recoverable body', reason: 'standalone-no-reply', wakeId: 'w-disk' }); }
    catch (e) { threw = e; }
    assert.ok(threw || (result && result.failed === true),
      'writePending EITHER throws or returns { failed: true } — it must NOT silently report success on a disk failure');
    // The file at childPath does not exist — nothing recoverable landed.
    assert.equal(fs.existsSync(childPath), false,
      'the invalid path was not created — no JSON was written under the regular-file parent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#1428 clearPending THROWS / REPORTS when neither atomic nor fallback persistence succeeds (invalid path)', () => {
  const { childPath, dir } = invalidUnderRegularFile();
  try {
    let threw = null;
    let result = null;
    try { result = clearPending(childPath); }
    catch (e) { threw = e; }
    assert.ok(threw || (result && result.failed === true),
      'clearPending EITHER throws or returns { failed: true } on a disk failure — a silent false-positive clear is a leak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// INTEGRATION: the runner's local row that feeds rowToBoard does NOT carry
// the recoverable body — only the runner file at the SEAT'S PATH matters.
// ---------------------------------------------------------------------------
test('#1428 the private file already contains the EXACT text at the moment ledgerSink is invoked for a suppressed reply', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-durable-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });

    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo are you there?', author: 'bo' })).body;
    let capturedRow = null;
    let capturedFileAtSink = null;
    const ledgerSink = async (row) => {
      capturedRow = row;
      // AT THE MOMENT ledgerSink is invoked, the private file MUST already
      // contain the exact recoverable text — that is what "durable before
      // telemetry" means. A row that races the file write is exactly the
      // shape #1441 documented and #1428 was meant to delete.
      capturedFileAtSink = readWithheldState(withheldFile);
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: WITHHELD_TEXT, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-x' }),
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r.posted, false, 'the standalone sentinel suppressed the post');
    assert.equal(r.declined, true);
    assert.ok(capturedRow, 'ledgerSink ran');
    assert.ok(capturedFileAtSink, 'file was readable at sink time');
    assert.equal(capturedFileAtSink.pending && capturedFileAtSink.pending.text, WITHHELD_TEXT,
      'at the moment ledgerSink ran, the resident\'s private file already contained the EXACT text');
    assert.equal(capturedFileAtSink.pending.reason, 'standalone-no-reply');
    // The board row does NOT carry the recoverable body.
    const board = rowToBoard(capturedRow, AGENT);
    assert.equal(JSON.stringify(board).includes(SECRET_PHRASE), false,
      'rowToBoard output is FREE of the secret phrase');
  } finally { await srv.stop(); }
});

// ---------------------------------------------------------------------------
// INTEGRATION: when private persistence FAILS, the runner is LOUD, the post
// remains suppressed, and the secret phrase never reaches the public row.
// The local ledger outcome signals recovery failure WITHOUT putting the text
// on rowToBoard/REST/graph.
// ---------------------------------------------------------------------------
test('#1428 failed private persistence is LOUD; post stays suppressed; secret phrase does NOT reach rowToBoard, REST, or graph', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  // withheldStateFile under a regular file — both atomic and fallback fail.
  const { childPath: invalidChildPath, dir } = invalidUnderRegularFile();
  try {
    const ledgerFile = `/tmp/never-1428-fail-${process.pid}-${Date.now()}.jsonl`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo are you there?', author: 'bo' })).body;
    const errors = [];
    let sinkCount = 0;
    let capturedRow = null;
    const ledgerSink = async (row) => {
      sinkCount += 1;
      capturedRow = row;
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: WITHHELD_TEXT, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-x' }),
      ledgerSink, withheldStateFile: invalidChildPath,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
      onError: (line) => errors.push(line),
    });

    // ⛔ LOUD: onError receives at least one diagnostic that names #1428
    // and the operation.
    const loud = errors.filter((l) => /#1428/.test(l) && /(retain|clear|withheld-state)/i.test(l));
    assert.ok(loud.length >= 1,
      `onError received a #1428 / operation-named diagnostic on persistence failure. Saw: ${JSON.stringify(errors)}`);

    // ⛔ Post remains suppressed — a failed private write MUST NOT cause
    // an auto-publish. The seat's deliberate NO_REPLY stands.
    assert.equal(r.posted, false, 'the standalone sentinel still suppresses — even when the file write fails');
    assert.equal(r.declined, true);

    // ⛔ The local ledger outcome signals recovery failure WITHOUT putting
    // text on rowToBoard. Local shape only.
    assert.ok(r.ledger, 'guestOnce returned a local ledger');
    assert.equal(r.ledger.recoveryFailed, true,
      'local ledger outcome indicates recovery failure (a stable boolean / token, not the text)');

    // ⛔ THE RAIL: every completed model call leaves one row. ledgerSink IS
    // invoked exactly once even on retain-failed; the public row carries the
    // STABLE outcome token, not the recoverable body, not a path.
    assert.equal(sinkCount, 1,
      'ledgerSink IS invoked once on retain-failed — the rail "every model call leaves one row" holds');
    assert.ok(capturedRow, 'a row reached the board');
    assert.equal(capturedRow.ok, true, 'the model call succeeded — ok:true');
    assert.equal(capturedRow.declined, true, 'the deliberate decline stands — declined:true');
    assert.equal(capturedRow.withheldReason, 'standalone-no-reply', 'stable reason on the row');
    assert.equal(capturedRow.withheldStateOutcome, 'retain-failed',
      'STABLE outcome token on the row — names the failed operation');
    assert.equal(capturedRow.error, null, 'error is null on a successful call');
    assert.equal(capturedRow.postId, null, 'postId is null on a decline');

    // ⛔ NOTHING recoverable reached rowToBoard / REST / graph. The runner row
    // does not carry the secret phrase; the path itself never rides either.
    assert.equal(capturedRow.withheldText, undefined,
      'withheldText is NEVER on the runner row');
    assert.equal(capturedRow.withheldStateFile, undefined,
      'the FILESYSTEM PATH is NEVER on the runner row — the token replaces it');
    assert.equal(scanStringDeep(capturedRow, SECRET_PHRASE), false,
      'no field on the runner row carries the secret phrase on disk-failure');
    assert.equal(scanStringDeep(capturedRow, '/tmp/never-1428-fail'), false,
      'no field on the runner row carries the filesystem path on disk-failure');

    // ⛔ GET /api/model-calls returns ONE text-free row with the retain-failed token.
    const calls = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=10')).body.calls || [];
    assert.equal(calls.length, 1, 'exactly one row on the board on retain-failed');
    assert.equal(calls[0].withheldStateOutcome, 'retain-failed',
      'GET /api/model-calls returns the STABLE retain-failed token');
    assert.equal(calls[0].withheldReason, 'standalone-no-reply');
    assert.equal(calls[0].withheldText, undefined, 'GET /api/model-calls does NOT return withheldText');
    assert.equal(scanStringDeep(calls, SECRET_PHRASE), false,
      'no GET of /api/model-calls carries the secret phrase on disk-failure');
    assert.equal(scanStringDeep(calls, '/tmp/never-1428-fail'), false,
      'no GET of /api/model-calls carries the filesystem path on disk-failure');

    // ⛔ The graph seat can query the STABLE token. Vocabulary accepts the
    // predicate; a SPARQL query for the row carrying the token returns one row.
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?r ?o WHERE { ?c a scrum:ModelCall ; scrum:withheldReason ?r ; scrum:withheldStateOutcome ?o . }`,
      by: 'ada',
    });
    const rows = q.body.rows || [];
    assert.equal(rows.length, 1, `graph returns the row carrying both tokens. Got: ${JSON.stringify(rows).slice(0, 300)}`);
    assert.equal(String(rows[0].r?.value ?? rows[0].r ?? ''), 'standalone-no-reply');
    assert.equal(String(rows[0].o?.value ?? rows[0].o ?? ''), 'retain-failed');

    // ⛔ A direct SPARQL for the phrase returns no rows.
    const q2 = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?o WHERE { ?s ?p ?o . FILTER (?o = "${SECRET_PHRASE}") }`,
      by: 'ada',
    });
    assert.equal((q2.body.rows || []).length, 0,
      `graph returns 0 rows whose object is the secret phrase on disk-failure. Got: ${JSON.stringify(q2.body.rows).slice(0, 300)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await srv.stop();
  }
});

// ---------------------------------------------------------------------------
// INTEGRATION: when private retention succeeds AND the wake receives a hand-
// back, the file is cleared BEFORE the public row is recorded. The same
// durable-before-telemetry invariant as the store path.
// ---------------------------------------------------------------------------
test('#1428 a successful receiving wake clears the private file BEFORE ledgerSink is invoked', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-clear-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const mention = await (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo please answer', author: 'bo' })).body;
    // Seed a pending entry that the second wake will receive.
    writePending(withheldFile, { text: WITHHELD_TEXT, reason: 'standalone-no-reply', wakeId: 'w-seed' });
    let fileAtSink = null;
    const ledgerSink = async (row) => {
      fileAtSink = readWithheldState(withheldFile);
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const recovered = 'I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.';
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: recovered, stopReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } }),
      post: async () => ({ id: 'p-y' }),
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile: `${ledgerFile}.clear`,
    });
    assert.equal(r.posted, true, 'the second wake posts the recovered body');
    assert.ok(fileAtSink, 'file was readable at sink time');
    assert.equal(fileAtSink.pending, null,
      'by the time ledgerSink runs, the private file is already CLEARED — clear precedes the public row');
  } finally { await srv.stop(); }
});

// ---------------------------------------------------------------------------
// #1428 DIAGNOSTIC-ROW CORRECTION — every completed model call leaves one row,
// even when the private-state retain/clear fails. The recovered row carries a
// STABLE outcome token (`withheldStateOutcome`) and nothing else: no withheld
// text, no filesystem path. The token's five values: retained, cleared,
// retain-failed, clear-failed, omitted/null on unrelated rows.
// ---------------------------------------------------------------------------
test('#1428 retain-failed: ledgerSink IS invoked once; row carries withheldStateOutcome=retain-failed; ok:true; declined:true; posted:false; error:null; withheldReason=standalone-no-reply', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  // withheldStateFile under a regular file — both atomic and fallback fail.
  const { childPath: invalidChildPath, dir } = invalidUnderRegularFile();
  try {
    const ledgerFile = `/tmp/never-1428-diagnostic-${process.pid}-${Date.now()}.jsonl`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo are you there?', author: 'bo' })).body;
    const errors = [];
    let sinkCount = 0;
    let capturedRow = null;
    const ledgerSink = async (row) => {
      sinkCount += 1;
      capturedRow = row;
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: WITHHELD_TEXT, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-x' }),
      ledgerSink, withheldStateFile: invalidChildPath,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
      onError: (line) => errors.push(line),
    });

    // ⛔ LOUD: onError receives a #1428 / retain diagnostic.
    const loud = errors.filter((l) => /#1428/.test(l) && /retain/i.test(l));
    assert.ok(loud.length >= 1,
      `onError received a #1428 / retain-named diagnostic. Saw: ${JSON.stringify(errors)}`);

    // ⛔ THE RAIL: every completed model call leaves one row.
    assert.equal(sinkCount, 1,
      'ledgerSink was invoked EXACTLY ONCE — the rail "every model call leaves one row" holds even on private-state failure');
    assert.ok(capturedRow, 'the captured row exists');

    // ⛔ The retained row's stable shape:
    //   ok:true for the successful model call;
    //   declined:true / posted:false (the seat's deliberate NO_REPLY stands);
    //   error:null;
    //   withheldReason='standalone-no-reply';
    //   withheldStateOutcome='retain-failed' — the stable token.
    assert.equal(capturedRow.ok, true, 'the model call succeeded — ok:true');
    assert.equal(capturedRow.declined, true, 'the deliberate decline stands — declined:true');
    assert.equal(capturedRow.withheldReason, 'standalone-no-reply',
      'withheldReason is the STABLE TOKEN, not free text');
    assert.equal(capturedRow.withheldStateOutcome, 'retain-failed',
      'withheldStateOutcome names the private-state failure as a STABLE string');
    assert.equal(capturedRow.error, null, 'error is null on a successful call');
    // `posted` is the RETURNED object (the runner's reply outcome); the row
    // itself records `postId: null` for a suppressed reply.
    assert.equal(r.posted, false, 'posted is false — the sentinel suppressed');
    assert.equal(capturedRow.postId, null, 'the runner row carries postId:null on a decline');

    // ⛔ Local result may also carry recoveryFailed:true (existing convention).
    assert.equal(r.recoveryFailed, true,
      'local result carries recoveryFailed:true alongside the stable public token');

    // ⛔ NOTHING recoverable reached rowToBoard / REST / graph.
    assert.equal(capturedRow.withheldText, undefined,
      'withheldText is NEVER on the runner row — privacy contract preserved on failure');
    assert.equal(scanStringDeep(capturedRow, SECRET_PHRASE), false,
      'no field on the runner row carries the secret phrase');

    // ⛔ The board row, the wire response, and the graph query are all text-free.
    const board = rowToBoard(capturedRow, AGENT);
    assert.equal(board.withheldText, undefined,
      'rowToBoard output does NOT carry withheldText — the recoverable body lives only in the private file');
    assert.equal(JSON.stringify(board).includes(SECRET_PHRASE), false,
      'rowToBoard output is FREE of the secret phrase');
    assert.equal(board.withheldStateOutcome, 'retain-failed',
      'rowToBoard output carries the STABLE withheldStateOutcome token');
    assert.equal(board.withheldReason, 'standalone-no-reply',
      'rowToBoard output carries the STABLE withheldReason token');
    assert.equal(board.withheldText, undefined,
      'rowToBoard output NEVER carries withheldText');

    const calls = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=10')).body.calls || [];
    assert.equal(calls.length, 1, 'exactly ONE row reached the board');
    assert.equal(calls[0].withheldReason, 'standalone-no-reply');
    assert.equal(calls[0].withheldStateOutcome, 'retain-failed',
      'GET /api/model-calls returns the stable withheldStateOutcome token');
    assert.equal(calls[0].withheldText, undefined,
      'GET /api/model-calls does NOT return withheldText');
    assert.equal(scanStringDeep(calls, SECRET_PHRASE), false,
      'no GET of /api/model-calls carries the secret phrase');

    // ⛔ The graph seat can query the stable token — the predicate is declared
    // and the vocabulary accepts it.
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?r ?o WHERE { ?c a scrum:ModelCall ; scrum:withheldReason ?r ; scrum:withheldStateOutcome ?o . }`,
      by: 'ada',
    });
    const rows = q.body.rows || [];
    assert.equal(rows.length, 1, `graph returns the row carrying both tokens. Got: ${JSON.stringify(rows).slice(0, 300)}`);
    const row0 = rows[0];
    const rVal = String(row0.r?.value ?? row0.r ?? '');
    const oVal = String(row0.o?.value ?? row0.o ?? '');
    assert.equal(rVal, 'standalone-no-reply');
    assert.equal(oVal, 'retain-failed');
    assert.equal(scanStringDeep(rows, SECRET_PHRASE), false,
      'graph projection carries no recoverable body — the stable token only');

    // ⛔ A query for the secret phrase on the graph returns zero rows.
    const q2 = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?o WHERE { ?s ?p ?o . FILTER (?o = "${SECRET_PHRASE}") }`,
      by: 'ada',
    });
    assert.equal((q2.body.rows || []).length, 0,
      'graph returns 0 rows whose object is the secret phrase even on retain-failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await srv.stop();
  }
});

test('#1428 clear-failed: a successful receiving wake that fails to clear the private file records withheldStateOutcome=clear-failed; ok:true; the post stands', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  // Seed the file in a valid location, then make it impossible to clear by
  // moving the file path under a regular file after seeding.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-clear-fail-'));
  const regPath = path.join(dir, 'a-regular-file');
  fs.writeFileSync(regPath, 'i am a regular file, not a directory');
  // Use a separate path that we can seed; the failing path is invalid.
  const validFile = path.join(dir, 'valid.json');
  writePending(validFile, { text: WITHHELD_TEXT, reason: 'standalone-no-reply', wakeId: 'w-seed' });
  // Invalid path for clear — both atomic and fallback fail.
  const invalidClearPath = path.join(regPath, 'state.json');
  try {
    const ledgerFile = `/tmp/never-1428-clear-failed-${process.pid}-${Date.now()}.jsonl`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo please answer', author: 'bo' })).body;
    const errors = [];
    let sinkCount = 0;
    let capturedRow = null;
    const ledgerSink = async (row) => {
      sinkCount += 1;
      capturedRow = row;
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body;
    };
    const recovered = 'I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.';
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      // priorWithheld is overridden to a function that reads the seeded file, so the
      // wake receives the hand-back and the runner attempts to clear.
      priorWithheld: async () => handBackFromState(validFile, { cap: 5 }),
      callModel: async () => ({ text: recovered, stopReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } }),
      post: async () => ({ id: 'p-y' }),
      ledgerSink, withheldStateFile: invalidClearPath,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
      onError: (line) => errors.push(line),
    });

    // ⛔ LOUD: onError receives a #1428 / clear diagnostic.
    const loud = errors.filter((l) => /#1428/.test(l) && /clear/i.test(l));
    assert.ok(loud.length >= 1,
      `onError received a #1428 / clear-named diagnostic. Saw: ${JSON.stringify(errors)}`);

    // ⛔ THE RAIL: every completed model call leaves one row.
    assert.equal(sinkCount, 1,
      'ledgerSink was invoked EXACTLY ONCE — the rail "every model call leaves one row" holds even on clear failure');
    assert.ok(capturedRow, 'the captured row exists');

    // ⛔ The cleared row's stable shape:
    //   ok:true for the successful model call;
    //   the post STANDS — clear-failed does not pretend the post did not happen;
    //   withheldStateOutcome='clear-failed' — the STABLE token.
    assert.equal(capturedRow.ok, true, 'the model call succeeded — ok:true');
    assert.equal(capturedRow.withheldStateOutcome, 'clear-failed',
      'withheldStateOutcome names the private-state CLEAR failure as a STABLE string');
    assert.ok(capturedRow.withheldReason == null,
      'withheldReason is absent/null on a successful (non-declined) wake');
    assert.ok(capturedRow.error == null, 'error is absent/null on a successful wake');
    // ⛔ Public row is recorded exactly once — recorded count is 1.
    assert.equal(r.posted, true, 'the post STANDS — clear-failed does not roll back the post');

    // ⛔ The post id and postedText are present on the row.
    assert.ok(capturedRow.postId, 'the post id is on the row');
    assert.equal(capturedRow.postedText, recovered, 'postedText carries the recovered body');

    // ⛔ NOTHING recoverable reached rowToBoard / REST / graph.
    assert.equal(capturedRow.withheldText, undefined,
      'withheldText is NEVER on the runner row');
    assert.equal(scanStringDeep(capturedRow, SECRET_PHRASE), false,
      'no field on the runner row carries the secret phrase on clear-failed');

    // ⛔ The board row, the wire response, and the graph query are all text-free.
    const board = rowToBoard(capturedRow, AGENT);
    assert.equal(board.withheldText, undefined,
      'rowToBoard output does NOT carry withheldText on clear-failed');
    assert.equal(JSON.stringify(board).includes(SECRET_PHRASE), false,
      'rowToBoard output is FREE of the secret phrase on clear-failed');
    assert.equal(board.withheldStateOutcome, 'clear-failed',
      'rowToBoard output carries the STABLE clear-failed token');

    const calls = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=10')).body.calls || [];
    assert.equal(calls.length, 1, 'exactly ONE row reached the board on clear-failed');
    assert.equal(calls[0].withheldStateOutcome, 'clear-failed',
      'GET /api/model-calls returns the clear-failed stable token');
    assert.equal(calls[0].withheldText, undefined,
      'GET /api/model-calls does NOT return withheldText on clear-failed');
    assert.equal(scanStringDeep(calls, SECRET_PHRASE), false,
      'no GET of /api/model-calls carries the secret phrase on clear-failed');

    // ⛔ A query for the secret phrase on the graph returns zero rows.
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?o WHERE { ?s ?p ?o . FILTER (?o = "${SECRET_PHRASE}") }`,
      by: 'ada',
    });
    assert.equal((q.body.rows || []).length, 0,
      'graph returns 0 rows whose object is the secret phrase on clear-failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await srv.stop();
  }
});

test('#1428 successful retained path carries withheldStateOutcome=retained; successful clear path carries withheldStateOutcome=cleared', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-token-${process.pid}-${Date.now()}.jsonl`;
    const withheldFile = `${ledgerFile}.withheld.json`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const mention1 = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo please answer', author: 'bo' })).body;
    let row1 = null;
    const ledgerSink = async (row) => { if (row.wake?.messageId === mention1.id) row1 = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const r1 = await guestOnce({
      agent: AGENT, wake: mention1,
      callModel: async () => ({ text: WITHHELD_TEXT, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-x' }),
      ledgerSink, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r1.posted, false);
    assert.equal(row1?.withheldStateOutcome, 'retained',
      'a successful retain carries the STABLE retained token');
    assert.equal(row1?.withheldReason, 'standalone-no-reply');
    assert.equal(row1?.withheldText, undefined);

    const mention2 = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo please answer again', author: 'bo' })).body;
    let row2 = null;
    const ledgerSink2 = async (row) => { if (row.wake?.messageId === mention2.id) row2 = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    const recovered = 'I weighed the room for a long time — the question is aimed at the seat that holds the work, and I am not that seat this turn; what I owe the room is to say so plainly.';
    const r2 = await guestOnce({
      agent: AGENT, wake: mention2,
      callModel: async () => ({ text: recovered, stopReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } }),
      post: async () => ({ id: 'p-y' }),
      ledgerSink: ledgerSink2, withheldStateFile: withheldFile,
      writeMemory: async () => ({ id: 'm2' }),
      ledgerFile: `${ledgerFile}.2`,
    });
    assert.equal(r2.posted, true, 'wake 2 posts the recovered body');
    assert.equal(row2?.withheldStateOutcome, 'cleared',
      'a successful clear carries the STABLE cleared token');
    assert.ok(row2?.withheldReason == null,
      'withheldReason is absent/null on a successful non-decline wake');
    assert.equal(row2?.withheldText, undefined);
  } finally { await srv.stop(); }
});

test('#1428 unrelated rows (no decline, no hand-back, no state file) carry NO withheldStateOutcome token', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const ledgerFile = `/tmp/never-1428-unrelated-${process.pid}-${Date.now()}.jsonl`;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo please answer', author: 'bo' })).body;
    let capturedRow = null;
    const ledgerSink = async (row) => { capturedRow = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
    // No withheldStateFile (omitted), and the answer is plain text — neither
    // a decline nor a hand-back. The runner must omit withheldStateOutcome.
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: 'REPLY: ordinary answer.', stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-z' }),
      ledgerSink,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile,
    });
    assert.equal(r.posted, true);
    assert.ok(capturedRow?.withheldStateOutcome == null,
      'an unrelated row has NO withheldStateOutcome token (omitted/null)');
    assert.ok(capturedRow?.withheldReason == null,
      'an unrelated row has NO withheldReason');
    const wire = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.ok(wire.withheldStateOutcome == null,
      'GET /api/model-calls returns null on unrelated rows');
  } finally { await srv.stop(); }
});
