/**
 * #1952 — A PER-SEAT LOCAL LOG OF WITHHELD REPLIES.
 *
 * Measured 2026-11-15/16: a resident wrote a 174-token reply that ended in a
 * standalone NO_REPLY; the runner logged `declined:explicit` and nothing was
 * posted. The #1428 withheld file keeps only the NEWEST held-back reply and
 * clears it after one hand-back, declined model-call rows carry no text, and
 * the runner log carries only token counts. So "she never answered" could not
 * be checked: the reply was gone.
 *
 * Contract under test:
 *   1. Every time the runner parks text in the #1428 withheld file it ALSO
 *      appends an entry to a per-seat local log beside it (text, at, wake
 *      message id, wake kind, reason, token count, model).
 *   2. Bounded: the last 10 entries, and nothing older than 7 days; whichever
 *      bound is tighter wins. Written atomically (tmp + rename), mode 0600.
 *   3. The #1428 hand-back is unchanged: newest only, shown once, never
 *      auto-replayed. The log never feeds the prompt.
 *   4. The log never reaches the board row, REST, or the runner's log lines
 *      beyond counts.
 *   5. A corrupt, missing or unwritable log never breaks a wake (fail open;
 *      the failure is reported as a count, never with text).
 *   6. `scripts/withheld-log.mjs --seat <seat> [--state-file <path>]` prints
 *      the entries, newest first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guestOnce } from '../core/guest-loop.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { readWithheldState } from '../core/withheld-state.mjs';
import {
  appendWithheldLog, readWithheldLog, defaultWithheldLogPath,
  WITHHELD_LOG_MAX_ENTRIES, WITHHELD_LOG_MAX_AGE_MS,
} from '../core/withheld-log.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

const AGENT = {
  seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer',
  residency: 'resident',
  model: { model: 'model-x', protocol: 'openai-completions' },
};

const secret = () => crypto.randomBytes(16).toString('hex');
const heldText = (s) => `I thought about the perimeter check and here is what I found.\n${s}\nNO_REPLY`;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wh-log-1952-')); }

/** One wake through guestOnce, with the files a runner wires, capturing every surface. */
async function wake(dir, { text, id, kind = 'mention', at, tokens = 23, logFile, agent = AGENT, onPrompt = null } = {}) {
  const stateFile = path.join(dir, 'seat.state.json');
  const withheldStateFile = `${stateFile}.withheld-state.json`;
  const withheldLogFile = logFile === undefined ? defaultWithheldLogPath(stateFile) : logFile;
  const surfaces = { logs: [], errors: [], row: null };
  const r = await guestOnce({
    agent, wake: { id, kind, author: 'bo', body: '@gizmo are you there?', createdAt: at },
    callModel: async (_a, messages) => { if (onPrompt) onPrompt(messages); return { text, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: tokens } }; },
    post: async () => ({ id: `p-${id}` }),
    ledgerSink: async (row) => { surfaces.row = row; return { id: `l-${id}` }; },
    writeMemory: async () => ({ id: 'm1' }),
    withheldStateFile, withheldLogFile,
    ledgerFile: path.join(dir, 'ledger.jsonl'),
    now: () => at,
    log: (l) => surfaces.logs.push(String(l)),
    onError: (l) => surfaces.errors.push(String(l)),
  });
  return { r, ...surfaces, stateFile, withheldStateFile, withheldLogFile };
}

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-11-16T03:00:00.000Z');

test('#1952 the log path sits beside the state file', () => {
  assert.equal(defaultWithheldLogPath('/x/seat.state.json'), '/x/seat.state.json.withheld-log.json');
  assert.equal(defaultWithheldLogPath(null), null);
  assert.equal(WITHHELD_LOG_MAX_ENTRIES, 10);
  assert.equal(WITHHELD_LOG_MAX_AGE_MS, 7 * DAY);
});

test('#1952 several declines in a row are ALL kept, with every field; the #1428 file still holds only the newest', async () => {
  const dir = tmpDir();
  try {
    const s = [secret(), secret(), secret()];
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await wake(dir, { text: heldText(s[i]), id: `msg-${i}`, kind: i === 2 ? 'channel' : 'mention', at: iso(T0 + i * 60_000), tokens: 20 + i });
      assert.equal(last.r.declined, true);
    }
    const { entries, status } = readWithheldLog(last.withheldLogFile);
    assert.equal(status, 'ok');
    assert.equal(entries.length, 3, 'three declines in a row: three entries');
    assert.deepEqual(entries.map((e) => e.text), s.map(heldText), 'every withheld text kept, byte for byte, oldest first on disk');
    assert.deepEqual(entries[2], {
      text: heldText(s[2]), at: iso(T0 + 120_000), wakeId: 'msg-2', wakeKind: 'channel',
      reason: 'standalone-no-reply', tokens: 22, model: 'model-x',
    });
    assert.equal(readWithheldState(last.withheldStateFile).pending.text, heldText(s[2]),
      '#1428 file unchanged in shape: it holds only the newest held-back reply');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 a bare NO_REPLY and a published reply add nothing to the log; a non-resident seat writes no log', async () => {
  const dir = tmpDir();
  try {
    await wake(dir, { text: 'NO_REPLY', id: 'bare', at: iso(T0) });
    await wake(dir, { text: 'hello room', id: 'pub', at: iso(T0 + 1000) });
    const lf = defaultWithheldLogPath(path.join(dir, 'seat.state.json'));
    assert.equal(fs.existsSync(lf), false, 'nothing was withheld, so no log was written');
    await wake(dir, { text: heldText(secret()), id: 'guest', at: iso(T0 + 2000), agent: { ...AGENT, residency: 'guest' } });
    assert.equal(fs.existsSync(lf), false, 'a guest-residency seat owns no withheld file and no log');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 the count bound holds: twelve declines keep the newest ten', async () => {
  const dir = tmpDir();
  try {
    const s = Array.from({ length: 12 }, secret);
    let last;
    for (let i = 0; i < 12; i += 1) last = await wake(dir, { text: heldText(s[i]), id: `m${i}`, at: iso(T0 + i * 60_000) });
    const { entries } = readWithheldLog(last.withheldLogFile);
    assert.equal(entries.length, 10);
    assert.deepEqual(entries.map((e) => e.wakeId), s.slice(2).map((_, i) => `m${i + 2}`), 'the two oldest dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 the age bound holds: entries older than 7 days are dropped, and the tighter bound wins', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'x.withheld-log.json');
    const entry = (i, at) => ({ text: `t${i}`, at: iso(at), wakeId: `w${i}`, wakeKind: 'mention', reason: 'standalone-no-reply', tokens: 1, model: 'm' });
    // Five old (8 days back), three fresh: the age bound is the tighter one here.
    for (let i = 0; i < 5; i += 1) appendWithheldLog(f, entry(i, T0 - 8 * DAY + i), { now: T0 - 8 * DAY + i });
    for (let i = 5; i < 8; i += 1) appendWithheldLog(f, entry(i, T0 - DAY + i), { now: T0 - DAY + i });
    let { entries } = readWithheldLog(f);
    assert.equal(entries.length, 8, 'appended within the window of each write, all eight were kept');
    const out = appendWithheldLog(f, entry(8, T0), { now: T0 });
    ({ entries } = readWithheldLog(f));
    assert.deepEqual(entries.map((e) => e.wakeId), ['w5', 'w6', 'w7', 'w8'], 'the 8-day-old entries are gone; fewer than 10 remain');
    assert.equal(out.kept, 4);
    // Just inside 7 days survives; just past it does not.
    const g = path.join(dir, 'y.withheld-log.json');
    appendWithheldLog(g, entry('in', T0 - 7 * DAY + 1000), { now: T0 - 7 * DAY + 1000 });
    appendWithheldLog(g, entry('out', T0 - 7 * DAY - 1000), { now: T0 - 7 * DAY - 1000 });
    appendWithheldLog(g, entry('now', T0), { now: T0 });
    assert.deepEqual(readWithheldLog(g).entries.map((e) => e.wakeId), ['win', 'wnow']);
    // An entry whose `at` cannot be read is not kept forever.
    const h = path.join(dir, 'z.withheld-log.json');
    fs.writeFileSync(h, JSON.stringify({ version: 1, entries: [{ ...entry('bad', T0), at: 'not a date' }] }), { mode: 0o600 });
    appendWithheldLog(h, entry('ok', T0), { now: T0 });
    assert.deepEqual(readWithheldLog(h).entries.map((e) => e.wakeId), ['wok']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 the log file is mode 0600, including when it existed at a wider mode, and leaves no tmp file', async () => {
  const dir = tmpDir();
  try {
    const first = await wake(dir, { text: heldText(secret()), id: 'a', at: iso(T0) });
    assert.equal(fs.statSync(first.withheldLogFile).mode & 0o777, 0o600);
    fs.chmodSync(first.withheldLogFile, 0o644);
    await wake(dir, { text: heldText(secret()), id: 'b', at: iso(T0 + 1000) });
    assert.equal(fs.statSync(first.withheldLogFile).mode & 0o777, 0o600, 'a widened file is pinned back to 0600 on the next write');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), [], 'atomic write: no tmp file left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 the #1428 hand-back is unchanged: newest only, once, and the log never feeds the prompt', async () => {
  const dir = tmpDir();
  try {
    const [a, b] = [secret(), secret()];
    await wake(dir, { text: heldText(a), id: 'w1', at: iso(T0) });
    await wake(dir, { text: heldText(b), id: 'w2', at: iso(T0 + 1000) });
    let prompt3 = null;
    const w3 = await wake(dir, { text: 'here is my answer', id: 'w3', at: iso(T0 + 2000), onPrompt: (m) => { prompt3 = JSON.stringify(m); } });
    assert.equal(w3.r.posted, true);
    assert.ok(prompt3.includes(b), 'the newest withheld reply is handed back on the next wake');
    assert.equal(prompt3.includes(a), false, 'the older one, kept only in the log, is NOT handed back');
    assert.equal(readWithheldState(w3.withheldStateFile).pending, null, 'the receiving wake cleared the #1428 file');
    let prompt4 = null;
    await wake(dir, { text: 'again', id: 'w4', at: iso(T0 + 3000), onPrompt: (m) => { prompt4 = JSON.stringify(m); } });
    assert.equal(prompt4.includes(a) || prompt4.includes(b), false, 'shown once: a later wake sees neither, though the log still holds both');
    assert.equal(readWithheldLog(w3.withheldLogFile).entries.length, 2, 'clearing the hand-back does not clear the log');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 no withheld text on public surfaces: board row, REST, runner log lines', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const dir = tmpDir();
  try {
    const s = secret();
    const w = await wake(dir, { text: heldText(s), id: 'pub-1', at: iso(T0) });
    assert.equal(readWithheldLog(w.withheldLogFile).entries[0].text.includes(s), true, 'the local log does hold it');
    const board = rowToBoard(w.row, AGENT);
    assert.equal(JSON.stringify(w.row).includes(s), false, 'runner row free of the text');
    assert.equal(JSON.stringify(board).includes(s), false, 'board row free of the text');
    const posted = await fetch(`${srv.baseUrl}/api/model-calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(board) });
    assert.ok(posted.status < 300, `the row is accepted as-is (${posted.status}) — no new field leaks onto it`);
    const got = await (await fetch(`${srv.baseUrl}/api/model-calls?agent=gizmo&limit=10`)).text();
    assert.equal(got.includes(s), false, 'REST read-back free of the text');
    const lines = [...w.logs, ...w.errors].join('\n');
    assert.equal(lines.includes(s), false, 'runner log lines free of the text');
    assert.equal(lines.includes('I thought about'), false, 'not even the head of it');
    assert.ok(w.logs.some((l) => /\[#1952\] gizmo withheld-log: 1 kept/.test(l)), `a count-only log line names the log: ${lines}`);
  } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 a corrupt log does not break the wake: the wake proceeds, the bad file is moved aside, the error is a count', async () => {
  const dir = tmpDir();
  try {
    const lf = defaultWithheldLogPath(path.join(dir, 'seat.state.json'));
    fs.writeFileSync(lf, '{ this is not json', { mode: 0o600 });
    const s = secret();
    const w = await wake(dir, { text: heldText(s), id: 'c1', at: iso(T0) });
    assert.equal(w.r.declined, true);
    assert.equal(w.row.withheldStateOutcome, 'retained', 'the #1428 hand-back store is untouched by the log');
    assert.equal(readWithheldState(w.withheldStateFile).pending.text, heldText(s));
    assert.deepEqual(readWithheldLog(lf).entries.map((e) => e.wakeId), ['c1'], 'a fresh log was started');
    const aside = fs.readdirSync(dir).filter((n) => n.includes('withheld-log.json.corrupt-'));
    assert.equal(aside.length, 1, 'the unreadable log is kept aside, not destroyed');
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ this is not json');
    assert.ok(w.errors.some((l) => /\[#1952\].*corrupt=1/.test(l)), `the corruption is reported as a count: ${w.errors.join(' | ')}`);
    assert.equal(w.errors.join('\n').includes(s), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 a missing log is the normal first case; an unwritable log fails open with a count-only error', async () => {
  const dir = tmpDir();
  try {
    const reg = path.join(dir, 'a-regular-file');
    fs.writeFileSync(reg, 'not a directory');
    const s = secret();
    const w = await wake(dir, { text: heldText(s), id: 'u1', at: iso(T0), logFile: path.join(reg, 'log.json') });
    assert.equal(w.r.declined, true, 'the wake completes');
    assert.equal(w.row.withheldStateOutcome, 'retained', 'the hand-back store still succeeded');
    assert.equal(w.r.recoveryFailed, undefined, 'a log failure is not a #1428 recovery failure');
    assert.ok(w.errors.some((l) => /\[#1952\] withheld-log append failed for gizmo \(errors=1/.test(l)), w.errors.join(' | '));
    assert.equal([...w.logs, ...w.errors].join('\n').includes(s), false);
    assert.deepEqual(readWithheldLog(path.join(dir, 'never-written.json')), { entries: [], status: 'missing' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1952 scripts/withheld-log.mjs prints the entries newest first, from --state-file or SCRUM_GUEST_STATE_FILE', () => {
  const dir = tmpDir();
  try {
    const stateFile = path.join(dir, 'scrum-guest-wake-gizmo.state.json');
    const lf = defaultWithheldLogPath(stateFile);
    const e = (i) => ({ text: `body number ${i}\nNO_REPLY`, at: iso(T0 + i * 1000), wakeId: `wake-${i}`, wakeKind: 'mention', reason: 'standalone-no-reply', tokens: 100 + i, model: 'model-x' });
    for (let i = 0; i < 3; i += 1) appendWithheldLog(lf, e(i), { now: T0 + i * 1000 });
    const cli = path.join(PROJECT_DIR, 'scripts', 'withheld-log.mjs');
    const env = { ...process.env, SCRUM_GUEST_STATE_FILE: '' };
    const r = spawnSync(process.execPath, [cli, '--seat', 'gizmo', '--state-file', stateFile], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const i0 = r.stdout.indexOf('wake-0'); const i1 = r.stdout.indexOf('wake-1'); const i2 = r.stdout.indexOf('wake-2');
    assert.ok(i2 >= 0 && i2 < i1 && i1 < i0, `newest first:\n${r.stdout}`);
    for (const needle of ['body number 2', 'standalone-no-reply', '102', 'model-x', 'mention', iso(T0 + 2000)]) assert.ok(r.stdout.includes(needle), `prints ${needle}`);
    const viaEnv = spawnSync(process.execPath, [cli, '--seat', 'gizmo'], { env: { ...process.env, SCRUM_GUEST_STATE_FILE: stateFile }, encoding: 'utf8' });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.ok(viaEnv.stdout.includes('wake-2'));
    const none = spawnSync(process.execPath, [cli, '--seat', 'gizmo', '--state-file', path.join(dir, 'other.state.json')], { env, encoding: 'utf8' });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /no withheld replies/i);
    const bad = spawnSync(process.execPath, [cli], { env, encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'no --seat is a usage error');
    const traversal = spawnSync(process.execPath, [cli, '--seat', '../x'], { env, encoding: 'utf8' });
    assert.notEqual(traversal.status, 0, 'a seat key is a name, never a path');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
