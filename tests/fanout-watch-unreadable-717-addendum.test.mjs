/**
 * #717 ADDENDUM — four rows the frozen file (sha256 9608ef1d…4322) does not contain, found by reading the build and by the independent mutation run.
 * Copy beside the frozen file in tests/; the frozen file is untouched.
 *
 *   A1 a 200 whose body is valid JSON but has NO `changes` array is UNREADABLE (a malformed page is not an empty one). The builder chose this; it was
 *      not pinned, so a build that reads it as "no writes" passed every frozen row.
 *   A2 (control, guards the opposite error) a 200 with `{changes: []}` is a READABLE page with no writes: the STOPPED alarm still fires. "Unreadable"
 *      must not swallow a genuinely empty window.
 *   A3 an unreadable read with a seat that holds NO claim posts NOTHING: the degraded post exists only for a seat the client-request reading alone
 *      would have named, not for every stale seat.
 *   A4 an unreadable read with a seat whose last request is RECENT posts nothing either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = process.env.FANOUT_WATCH_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fanout-watch.mjs');
const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** A stub board: /channel/status, /api/cards, /api/changes (the mode is the fault being injected), POST /api/conversations (captured). */
async function startStub({ seatAge = 52 * MIN, holdsClaim = true, claims = 'ok', changes = { mode: 'ok', rows: [] } } = {}) {
  // the stale request's timestamp is FIXED here: an episode is keyed on (seat, lastClientRequestAt), so a value that moved on every tick would make every tick a new episode
  const s = { posts: [], hits: { changes: 0 }, changes, claims, seatAge, requestAt: ago(seatAge), holdsClaim, sockets: new Set() };
  s.server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url === '/channel/status') return json(200, { receivers: 3, sessions: 3, mode: 'soft', pending: 0, seats: { alpha: { streams: 1, lastClientRequestAt: s.requestAt }, beta: { streams: 1, lastClientRequestAt: ago(MIN) }, gamma: { streams: 1, lastClientRequestAt: ago(MIN) } } });
    if (url === '/api/cards') {
      if (s.claims === 'destroy') return req.socket.destroy();
      if (s.claims === '500') return json(500, { error: 'busy' });
      return json(200, s.holdsClaim ? [{ shortId: 717, claimedBy: 'alpha' }] : []);
    }
    if (url === '/api/changes') {
      s.hits.changes++;
      const m = s.changes.mode;
      if (m === 'hang') return;                                   // never answers: the watch's own 5 s timeout fires
      if (m === 'destroy') return req.socket.destroy();
      if (m === '500json') return json(500, { error: 'board is busy' });
      if (m === '500changes') return json(500, { error: 'busy', changes: [] });   // a non-2xx that ALSO carries a well-formed, empty `changes` array
      if (m === 'emptyobj') return json(200, {});                   // valid JSON, no `changes` array: malformed
      if (m === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>gateway</html>'); }
      return json(200, { changes: s.changes.rows });
    }
    if (url === '/api/conversations' && req.method === 'POST') {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => { try { s.posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { s.posts.push({ unparsable: true }); } json(201, { id: 'p' }); });
      return;
    }
    json(404, { error: 'no such route' });
  });
  s.server.on('connection', (sock) => { s.sockets.add(sock); sock.on('close', () => s.sockets.delete(sock)); });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${s.server.address().port}`;
  s.stop = () => new Promise((r) => { for (const k of s.sockets) k.destroy(); s.server.close(() => r()); });
  return s;
}
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f717-')), 'watch.state');

/** One watch tick against the stub. live=false: DRYRUN (the would-be post is on stdout); live=true: it really POSTs to the stub. */
function tick(stub, state, { live = false } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, SCRUM_STATUS_URL: `${stub.base}/channel/status`, SCRUM_POST_URL: `${stub.base}/api/conversations`, SCRUM_FANOUT_STATE: state, SCRUM_FANOUT_FLOOR: '3', ...(live ? {} : { SCRUM_FANOUT_DRYRUN: '1' }) };
    delete env.SCRUM_STOPPED_AFTER_MS; delete env.SCRUM_STOPPED_REFIRE_MS;
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 40000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
/** Everything the watch would say to the room this tick: DRYRUN's would-be post, or the real POST bodies the stub captured. */
const said = (stub, r) => [...r.out.split('\n').filter((l) => /DRYRUN would post:/.test(l)), ...stub.posts.map((p) => p.body ?? '')].join('\n');
const named = (text) => /SEAT STOPPED/.test(text) && /\balpha\b/.test(text);
const NO_WRITE_CLAIM = /no board write (is )?attributed|no board write attributed to it/i;


const quiet = (stub, r) => said(stub, r).trim().length === 0;
test('A1 a 200 with valid JSON but NO `changes` array is UNREADABLE: no STOPPED, no "no write" claim, one degraded post that says UNREADABLE and names alpha', async () => {
  const stub = await startStub({ changes: { mode: 'emptyobj', rows: [] } });
  try {
    const r = await tick(stub, tmpState());
    const text = said(stub, r);
    assert.equal(named(text), false, r.out); assert.doesNotMatch(text, NO_WRITE_CLAIM);
    assert.match(text, /UNREADABLE/i); assert.match(text, /\balpha\b/);
  } finally { await stub.stop(); }
});
test('A2 (control) a 200 with `{changes: []}` is a READABLE empty page: the STOPPED alarm still fires for a stale seat holding a claim, and nothing says UNREADABLE', async () => {
  const stub = await startStub({ changes: { mode: 'ok', rows: [] } });
  try {
    const r = await tick(stub, tmpState());
    const text = said(stub, r);
    assert.ok(named(text), `must fire:\n${r.out}`);
    assert.doesNotMatch(text, /UNREADABLE/i, 'a readable empty window is not a degraded observation');
  } finally { await stub.stop(); }
});
test('A3 an unreadable read with NO claim held by the stale seat posts NOTHING (the degraded post is for a seat the request-reading alone would name)', async () => {
  for (const mode of ['hang', '500json']) {
    const stub = await startStub({ holdsClaim: false, changes: { mode, rows: [] } });
    try { const r = await tick(stub, tmpState()); assert.equal(quiet(stub, r), true, `${mode}: no post expected:\n${r.out}`); assert.match(r.out, /unreadable/i, 'the read failure is still logged'); } finally { await stub.stop(); }
  }
});
test('A4 an unreadable read with the seat\'s last request RECENT (3 min) posts NOTHING', async () => {
  const stub = await startStub({ seatAge: 3 * MIN, changes: { mode: 'hang', rows: [] } });
  try { const r = await tick(stub, tmpState()); assert.equal(quiet(stub, r), true, `no post expected:\n${r.out}`); } finally { await stub.stop(); }
});

test('A5 a 500 that carries a well-formed EMPTY `changes` array is still UNREADABLE: no STOPPED, a degraded post naming alpha', async () => {
  const stub = await startStub({ changes: { mode: '500changes', rows: [] } });
  try {
    const r = await tick(stub, tmpState());
    const text = said(stub, r);
    assert.equal(named(text), false, `a non-2xx is not a read, whatever its body looks like:\n${r.out}`); assert.doesNotMatch(text, NO_WRITE_CLAIM);
    assert.match(text, /UNREADABLE/i); assert.match(text, /\balpha\b/);
  } finally { await stub.stop(); }
});
test('A6 on an unreadable tick the LOG names nobody stopped: no `stopped seats:` line, and it says the read was unreadable', async () => {
  for (const mode of ['hang', 'destroy', '500json']) {
    const stub = await startStub({ changes: { mode, rows: [] } });
    try {
      const r = await tick(stub, tmpState());
      assert.doesNotMatch(r.out, /stopped seats:/i, `${mode}: the log must not name a stopped seat off an unreadable read:\n${r.out}`);
      assert.match(r.out, /unreadable/i, `${mode}: and must say so`);
    } finally { await stub.stop(); }
  }
});
test('A7 a NEW stale request from the same seat is a NEW degraded episode: it is posted again (the episode is keyed on seat AND request, not the seat alone)', async () => {
  const state = tmpState();
  const stub = await startStub({ changes: { mode: 'hang', rows: [] } });
  try {
    await tick(stub, state, { live: true });
    assert.equal(stub.posts.length, 1, 'first episode posts once');
    await tick(stub, state, { live: true });
    assert.equal(stub.posts.length, 1, 'the same episode stays quiet');
    stub.requestAt = ago(41 * MIN);                       // alpha made a request since, and went stale AGAIN
    await tick(stub, state, { live: true });
    assert.equal(stub.posts.length, 2, `a new stale request is a new episode: ${JSON.stringify(stub.posts.map((x) => x.body.slice(0, 60)))}`);
  } finally { await stub.stop(); }
});
