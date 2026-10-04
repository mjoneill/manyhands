/**
 * #1561 launch — a guest seat's runner (scripts/guest-once.mjs, what launchd runs for
 * a resident) sends its own board key, read from SCRUM_SEAT_TOKEN_FILE, on its board calls:
 * unit 1's write routes refuse a keyless write. Twin: with no key file, no Authorization
 * header at all (today's behaviour). The real script runs against a recording stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PROJECT_DIR } from './helpers/harness.mjs';

async function recordingBoard() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'stand-in' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, stop: () => new Promise((r) => srv.close(r)) };
}
function runGuest(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(PROJECT_DIR, 'scripts', 'guest-once.mjs'), '--seat', 'keytest'], {
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

test('#1561 launch: the guest runner sends its seat key to the board', async () => {
  const b = await recordingBoard();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
  const f = path.join(d, 'token'); fs.writeFileSync(f, 'sk-test-guest-key\n', { mode: 0o600 });
  try {
    const r = await runGuest({ SCRUM_BOARD_URL: b.url, SCRUM_SEAT_TOKEN_FILE: f, SCRUM_GUEST_STATE_FILE: path.join(d, 'state.json') });
    assert.ok(b.seen.length > 0, `the runner reached the board: ${r.out}`);
    for (const s of b.seen) assert.equal(s.authorization, 'Bearer sk-test-guest-key', `${s.method} ${s.url}`);
    assert.ok(!r.out.includes('sk-test-guest-key'), 'the key is never printed');
  } finally { await b.stop(); }
});

test('#1561 launch: twin — with no key file the runner sends no Authorization header (unchanged)', async () => {
  const b = await recordingBoard();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
  try {
    await runGuest({ SCRUM_BOARD_URL: b.url, SCRUM_GUEST_STATE_FILE: path.join(d, 'state.json') });
    assert.ok(b.seen.length > 0);
    for (const s of b.seen) assert.equal(s.authorization, null, `${s.method} ${s.url}`);
  } finally { await b.stop(); }
});
