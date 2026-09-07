/**
 * #1237 — IN USE. The resident answers a mention with nobody running a script:
 * a launchd tick runs guest-once every minute, so the runner must (1) scan by a
 * SINCE cursor rather than the newest 60 rows — a mention buried under a busy
 * night was invisible for good — and (2) hold a lock so the tick and a hand run
 * cannot answer one mention twice.
 *
 * The seam test spawns the REAL runner against a REAL test board and a fake
 * Ollama, because the pure pieces passing says nothing about the process that
 * launchd actually starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mentionScanPath, acquireLock, releaseLock } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wake-tick-'));

test('#1237 mentionScanPath: the scan is a SINCE cursor with a wide limit, never the newest-60 window', () => {
  const now = '2026-09-06T10:00:00.000Z';
  const withCursor = mentionScanPath({ lastAnsweredAt: '2026-09-06T02:22:18.782Z' }, now);
  assert.match(withCursor, /^\/api\/conversations\?/);
  assert.match(withCursor, /attachedTo=null/);
  assert.match(withCursor, /since=2026-09-06T02%3A22%3A18\.782Z|since=2026-09-06T02:22:18\.782Z/);
  assert.match(withCursor, /limit=(\d+)/);
  assert.ok(Number(withCursor.match(/limit=(\d+)/)[1]) >= 200, `limit must be wide, got ${withCursor}`);
  assert.doesNotMatch(withCursor, /limit=60(&|$)/);
  // First run ever: no cursor. Reach back a SHORT window, not a day — a first
  // tick that replays eight hours of old mentions one per minute is a flood.
  const first = mentionScanPath({}, now);
  const since = decodeURIComponent(first.match(/since=([^&]+)/)[1]);
  const ageMin = (Date.parse(now) - Date.parse(since)) / 60_000;
  assert.ok(ageMin > 0 && ageMin <= 15, `first-run window must be minutes, got ${ageMin} min`);
});

test('#1237 acquireLock: second holder is refused and told who holds it; release frees it; a stale lock is broken and named', () => {
  const dir = tmpdir(); const lock = path.join(dir, 'guest.lock');
  const a = acquireLock(lock, { pid: 111, now: Date.parse('2026-09-06T10:00:00Z'), staleMs: 10 * 60_000 });
  assert.equal(a.acquired, true);
  const b = acquireLock(lock, { pid: 222, now: Date.parse('2026-09-06T10:00:30Z'), staleMs: 10 * 60_000 });
  assert.equal(b.acquired, false); assert.equal(b.holder?.pid, 111);
  releaseLock(lock);
  const c = acquireLock(lock, { pid: 222, now: Date.parse('2026-09-06T10:01:00Z'), staleMs: 10 * 60_000 });
  assert.equal(c.acquired, true); releaseLock(lock);
  // stale: held for longer than staleMs → broken, and the break is reported
  acquireLock(lock, { pid: 333, now: Date.parse('2026-09-06T10:00:00Z'), staleMs: 10 * 60_000 });
  const d = acquireLock(lock, { pid: 444, now: Date.parse('2026-09-06T10:20:00Z'), staleMs: 10 * 60_000 });
  assert.equal(d.acquired, true); assert.equal(d.broke?.pid, 333);
  releaseLock(lock);
  assert.equal(fs.existsSync(lock), false);
});

/** A fake Ollama: answers /api/chat with one fixed reply, counts calls. */
// #1254 — the marker is on the FIXTURE, not added by the harness: this stub
// stands in for a model that INTENDED to publish, and under the inverted
// default a model says so by beginning with `REPLY:`. A stub that skips it is
// no longer modelling a reply, it is modelling a decline.
function fakeOllama(reply = 'REPLY: I am here.') {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: raw });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ calls, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}

function runOnce(env, extraArgs = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', 'gizmo', ...extraArgs], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#1237 SEAM: the real runner answers a mention buried under 80 newer posts exactly once, and two concurrent runs answer one mention exactly once', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const ollama = await fakeOllama('REPLY: Gizmo here: the board is for work.');
  const dir = tmpdir(); const stateFile = path.join(dir, 'gizmo.state.json');
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const c = await api('POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'guest', contextPolicy: 'artifact-only', by: 'ada' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const mention = await api('POST', '/api/conversations', { author: 'ada', body: '@gizmo what is the board for?' });
    assert.equal(mention.status, 201, JSON.stringify(mention.body));
    for (let i = 0; i < 80; i++) { const f = await api('POST', '/api/conversations', { author: 'bo', body: `filler ${i}` }); assert.equal(f.status, 201); }
    const posts = async () => { const r = await api('GET', '/api/conversations?attachedTo=null&limit=500'); const list = Array.isArray(r.body) ? r.body : r.body.conversations; return list.filter((m) => m.author === 'gizmo'); };
    assert.equal((await posts()).length, 0);

    const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile };
    const r1 = await runOnce(env);
    assert.equal(r1.code, 0, r1.err + r1.out);
    const after1 = await posts();
    assert.equal(after1.length, 1, `expected ONE gizmo post, got ${after1.length}: ${r1.out} ${r1.err}`);
    assert.equal(after1[0].body, 'Gizmo here: the board is for work.');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.lastAnsweredId, mention.body.id);
    assert.equal(state.lastAnsweredAt, mention.body.createdAt, 'the cursor is the answered mention\'s createdAt');
    assert.equal(ollama.calls.length, 1);

    // a second run with nothing new: no post, no model call
    const r2 = await runOnce(env);
    assert.equal(r2.code, 0, r2.err);
    assert.equal((await posts()).length, 1); assert.equal(ollama.calls.length, 1);

    // two CONCURRENT runs on one fresh mention → exactly one answer
    const m2 = await api('POST', '/api/conversations', { author: 'ada', body: '@gizmo and one more thing' });
    assert.equal(m2.status, 201);
    const [ra, rb] = await Promise.all([runOnce(env), runOnce(env)]);
    assert.ok(ra.code === 0 && rb.code === 0, ra.err + rb.err);
    const after3 = await posts();
    assert.equal(after3.length, 2, `expected exactly TWO gizmo posts total, got ${after3.length}\nA: ${ra.out}${ra.err}\nB: ${rb.out}${rb.err}`);
    assert.equal(ollama.calls.length, 2);
    assert.ok(/lock|held|another run/i.test(ra.out + ra.err + rb.out + rb.err), 'the loser says WHY it did nothing');
    assert.equal(fs.existsSync(`${stateFile}.lock`), false, 'the lock is released after the run');

    // #1237 — a DRY run keeps its ledger beside the state file (always
    // writable), never beside the module (the serve copy is read-only): it
    // ends clean, posts nothing, and the row is where the operator can read it.
    const before = (await posts()).length;
    const rd = await runOnce(env, ['--dry-run', '--once-id', m2.body.id]);
    assert.equal(rd.code, 0, `dry run must end clean: ${rd.err}`);
    assert.doesNotMatch(rd.err, /EACCES|ENOENT/);
    assert.equal((await posts()).length, before, 'a dry run posts nothing');
    const ledgerBeside = `${stateFile}.ledger.jsonl`;
    assert.ok(fs.existsSync(ledgerBeside), `dry-run ledger expected at ${ledgerBeside}`);
    assert.equal(fs.readFileSync(ledgerBeside, 'utf8').trim().split('\n').length, 1);
  } finally { await ollama.stop(); await srv.stop(); }
});
