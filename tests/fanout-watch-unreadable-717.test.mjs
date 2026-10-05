/**
 * #717 — UNKNOWN IS NOT NONE: an attributed-write read that could not be made must never be reported as "no attributed write".
 * Pre-registered by the separate test author BEFORE the fix exists, against scripts/fanout-watch.mjs as served (29a9d79). Copy unchanged
 * into tests/ and build to it; if the contract needs a change the test changes first and the change is announced on #717.
 *
 * THE DEFECT (observed twice on 2026-10-05, 07:40Z and 08:10Z): the watch reads /api/changes under a 5 s timeout. When that read is lost to
 * board load the catch sets lastWriteBySeat = {} and the tick goes on, so a seat that wrote 62 s earlier is named "SEAT STOPPED ... no
 * board write attributed to it in that window", a sentence claiming a measurement of a window that was never read. (The seat's stale
 * MCP-request timestamp was REAL; what was false was reading an unreadable write check as proof of stoppage.)
 *
 * CONTRACT PINNED HERE
 *   UNREADABLE  the attributed-write read is UNREADABLE when the request times out, the connection fails, the status is not 2xx (even if
 *               the body parses as JSON), or the body is not JSON. In every one of those cases, on a tick where a seat has an open stream,
 *               a stale client request and a claim:
 *                 (1) NO seat is named STOPPED and nothing the watch posts contains the sentence that no board write was attributed;
 *                 (3) the watch DOES post, and the post says the attributed-write read was UNREADABLE and names the seat whose state it
 *                     could not confirm: a degraded observation, not silence and not an accusation. (Interpretation of "on a timeout the
 *                     posted line says UNREADABLE": a post exists. If the builder reads it as "log only", that is changed here FIRST.)
 *   POSITIVE    (2) when the read SUCCEEDS and the seat's last attributed write is older than the threshold (or there is none), the STOPPED
 *               alarm still fires, naming the seat, exactly as before. This is the guard against softening the watch.
 *   RESCUE      a successful read showing a write newer than the threshold still suppresses the alarm (unchanged).
 *   EPISODES    a degraded post must not consume the STOPPED episode: after a degraded tick, a later tick whose read succeeds and is
 *               genuinely stale STILL fires (it is not muted by the earlier post's cooldown or episode record).
 *               And the reverse (E2, a design point I am adding, open to objection BEFORE freeze): a degraded tick must not erase the record of an
 *               episode already named, or every load spike would re-state an accusation that was made once on a good read.
 *   BOUND       the degraded post is ONE per episode (the same seat and the same stale request), under the same per-signature cooldown the STOPPED
 *               alarm has: it is posted only on a tick where the client-request reading alone would have named the seat, and repeated degraded
 *               ticks post nothing more (B), while every tick still LOGS that the read was unreadable.
 *   UNCHANGED   an unreadable CLAIMS read still names no seat (existing behaviour, a control); a seat with no claim is never STOPPED.
 *
 * E2 PASSES TODAY (the served script keeps an already-named episode alive because it still lists the seat each tick). It is here to catch the
 * NATURAL fix, which blanks the stopped list on an unreadable read and so deletes the episode record, and re-accuses when reads recover.
 *
 * NOT PINNED, BY NAME: the exact wording of the degraded post beyond the words UNREADABLE and the seat name; how often a persistent
 * degraded condition re-posts (cooldown for the degraded post is the builder's call, but see EPISODES); the 5 s timeout length (the tests
 * wait for it); the floor alarm under a degraded read (not exercised here).
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

const FAULTS = [['the request TIMES OUT (the observed case)', 'hang'], ['the connection is destroyed', 'destroy'], ['HTTP 500 whose body is valid JSON', '500json'], ['HTTP 200 with a body that is not JSON', 'html']];

// ------------------------------------------------------------------ POSITIVE CONTROLS: the watch must not be softened
test('P1 a SUCCESSFUL read with no write by the seat: the STOPPED alarm still fires, naming alpha, claiming the absence it really measured', async () => {
  const stub = await startStub({ changes: { mode: 'ok', rows: [{ by: 'beta', at: ago(2 * MIN) }, { by: 'gamma', at: ago(5 * MIN) }] } });
  try {
    const r = await tick(stub, tmpState());
    const text = said(stub, r);
    assert.ok(named(text), `the alarm must fire and name alpha:\n${r.out}`);
    assert.match(text, /#717/, 'and name its claim');
  } finally { await stub.stop(); }
});
// (the write must PREDATE alpha's stale request at 52 min: a write AFTER the request is an "answered" episode (#1358), held quiet for the re-ask window)
test('P2 a SUCCESSFUL read showing alpha\'s last write OLDER than its stale request and the threshold: still STOPPED', async () => {
  const stub = await startStub({ changes: { mode: 'ok', rows: [{ by: 'alpha', at: ago(70 * MIN) }] } });
  try { const r = await tick(stub, tmpState()); assert.ok(named(said(stub, r)), `must fire:\n${r.out}`); } finally { await stub.stop(); }
});
test('P3 RESCUE (unchanged): a SUCCESSFUL read showing a write by alpha newer than the threshold suppresses the alarm', async () => {
  const stub = await startStub({ changes: { mode: 'ok', rows: [{ by: 'alpha', at: ago(3 * MIN) }] } });
  try { const r = await tick(stub, tmpState()); assert.equal(named(said(stub, r)), false, `alpha is working through another door:\n${r.out}`); assert.equal(stub.hits.changes, 1, 'the read really happened'); } finally { await stub.stop(); }
});
test('P4 a seat with NO claim is never STOPPED, however stale (the rail case, unchanged)', async () => {
  const stub = await startStub({ holdsClaim: false, changes: { mode: 'ok', rows: [] } });
  try { const r = await tick(stub, tmpState()); assert.equal(named(said(stub, r)), false, r.out); } finally { await stub.stop(); }
});
test('P5 an unreadable CLAIMS read names no seat (existing behaviour, a control)', async () => {
  for (const claims of ['destroy', '500']) {
    const stub = await startStub({ claims, changes: { mode: 'ok', rows: [] } });
    try { const r = await tick(stub, tmpState()); assert.equal(named(said(stub, r)), false, `claims=${claims}:\n${r.out}`); } finally { await stub.stop(); }
  }
});

// ------------------------------------------------------------------ THE DEFECT
for (const [label, mode] of FAULTS) {
  test(`U ${label}: no seat is named STOPPED, no "no board write attributed" claim is made, and the watch posts a degraded observation that says UNREADABLE and names alpha`, async () => {
    const stub = await startStub({ changes: { mode, rows: [{ by: 'alpha', at: ago(62 * 1000) }] } });   // alpha DID write 62 s ago: the true state the watch could not see
    try {
      const r = await tick(stub, tmpState());
      assert.equal(r.code, 0, `the tick still completes: ${r.err}`);
      assert.ok(stub.hits.changes >= 1, 'the changes read was attempted');
      const text = said(stub, r);
      assert.equal(named(text), false, `an unreadable write check cannot support STOPPED:\n${r.out}`);
      assert.doesNotMatch(text, NO_WRITE_CLAIM, 'and nothing posted may claim a measured absence of writes');
      assert.match(text, /UNREADABLE/i, `the post must say the attributed-write read was UNREADABLE (a degraded observation):\n${r.out}`);
      assert.match(text, /\balpha\b/, 'and name the seat whose state it could not confirm');
    } finally { await stub.stop(); }
  });
}
test('U-live the degraded post really goes out (a real POST, not only DRYRUN) and carries UNREADABLE and the seat, with no STOPPED accusation', async () => {
  const stub = await startStub({ changes: { mode: 'hang', rows: [] } });
  try {
    const r = await tick(stub, tmpState(), { live: true });
    assert.equal(r.code, 0, r.err);
    assert.equal(stub.posts.length, 1, `exactly one post this tick: ${JSON.stringify(stub.posts)}`);
    assert.equal(stub.posts[0].author, 'board');
    assert.match(stub.posts[0].body, /UNREADABLE/i); assert.match(stub.posts[0].body, /\balpha\b/);
    assert.doesNotMatch(stub.posts[0].body, /SEAT STOPPED|no board write/i);
  } finally { await stub.stop(); }
});

// ------------------------------------------------------------------ EPISODES: degraded must not blind the next real read
test('E a degraded tick does not consume the STOPPED episode: the next tick, with the read succeeding and alpha genuinely stale, STILL fires', async () => {
  const state = tmpState();
  const stub = await startStub({ changes: { mode: 'hang', rows: [] } });
  try {
    const t1 = await tick(stub, state);
    assert.equal(named(said(stub, t1)), false, `degraded tick must not accuse:\n${t1.out}`);
    stub.changes = { mode: 'ok', rows: [{ by: 'beta', at: ago(MIN) }] };
    const t2 = await tick(stub, state);
    assert.ok(named(said(stub, t2)), `the readable, genuinely stale read must fire; a degraded post must not mute it:\n${t2.out}`);
  } finally { await stub.stop(); }
});
test('E2 a REAL alarm is not repeated by a later degraded tick (no accusation re-stated off an unreadable read) and the episode survives for when reads recover', async () => {
  const state = tmpState();
  const stub = await startStub({ changes: { mode: 'ok', rows: [] } });
  try {
    assert.ok(named(said(stub, await tick(stub, state))), 'tick 1 fires on a good read');
    stub.changes = { mode: 'hang', rows: [] };
    const t2 = await tick(stub, state);
    assert.equal(named(said(stub, t2)), false, `a degraded tick must not restate STOPPED:\n${t2.out}`);
    stub.changes = { mode: 'ok', rows: [] };
    const t3 = await tick(stub, state);
    assert.equal(named(said(stub, t3)), false, 'the SAME episode, already named, is still inside its re-ask window after the degraded tick: not re-fired (unchanged)');
  } finally { await stub.stop(); }
});

// ------------------------------------------------------------------ BOUND: a load spike must not become a flood
test('B the degraded post is ONE per episode, not one per tick: a second and third degraded tick for the same seat and the same stale request post nothing more, with the observation still logged', async () => {
  const state = tmpState();
  const stub = await startStub({ changes: { mode: 'hang', rows: [] } });
  try {
    const t1 = await tick(stub, state, { live: true });
    assert.equal(stub.posts.length, 1, `the first degraded tick posts once:\n${t1.out}`);
    const t2 = await tick(stub, state, { live: true });
    const t3 = await tick(stub, state, { live: true });
    assert.equal(stub.posts.length, 1, `repeated degraded ticks must not repost: ${JSON.stringify(stub.posts.map((p) => p.body.slice(0, 80)))}`);
    for (const t of [t2, t3]) assert.match(t.out, /unreadable/i, 'but each tick still LOGS that the read was unreadable (a quiet post is not a quiet log)');
    assert.equal(named(stub.posts.map((p) => p.body).join('\n')), false, 'and none of them accuses');
  } finally { await stub.stop(); }
});
