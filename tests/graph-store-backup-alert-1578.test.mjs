/**
 * #1578 — the backup monitor's alerts are DELIVERED as commons posts, once per episode,
 * with a reminder cadence and a recovery post; a failed post is retried, never lost.
 * Pure decisions first, then the real script against a recording stand-in board.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { decide, alertOnce, queue } from '../scripts/graph-store-backup-alert.mjs';
import { renderPlist } from '../scripts/graph-store-backup-plist.mjs';

const MIN = 60_000;
const KEY = 'sk-board-seat-test-key';
const T0 = Date.parse('2026-10-04T20:00:00Z');
const stale = { verdict: 'STALE', alert: true, line: 'ALERT STALE newest copy age 40 min > 16 min' };
const nocopy = { verdict: 'NO-COPY', alert: true, line: 'ALERT NO-COPY no verified copy' };
const ok = { verdict: 'OK', alert: false, line: 'OK newest verified copy age 3 min' };

test('#1578 decide: the first alert OPENS an episode and posts', () => {
  const d = decide({ result: stale, prev: { episode: null }, nowMs: T0 });
  assert.match(d.post, /^⚠️ BACKUP ALERT STALE/);
  assert.equal(d.next.episode.verdict, 'STALE');
});

test('#1578 decide: the same verdict inside the reminder window posts NOTHING; after it, one reminder', () => {
  const prev = decide({ result: stale, prev: { episode: null }, nowMs: T0 }).next;
  assert.equal(decide({ result: stale, prev, nowMs: T0 + 59 * MIN }).post, null);
  const r = decide({ result: stale, prev, nowMs: T0 + 60 * MIN });
  assert.match(r.post, /still open since 2026-10-04T20:00:00/);
  assert.equal(r.next.episode.openedAt, prev.episode.openedAt, 'a reminder keeps the episode start');
});

test('#1578 decide: a DIFFERENT verdict opens a new episode at once', () => {
  const prev = decide({ result: stale, prev: { episode: null }, nowMs: T0 }).next;
  const d = decide({ result: nocopy, prev, nowMs: T0 + MIN });
  assert.match(d.post, /^⚠️ BACKUP ALERT NO-COPY/);
});

test('#1578 decide: OK after an alert posts ONE recovery and closes; OK with no episode is silent', () => {
  const prev = decide({ result: stale, prev: { episode: null }, nowMs: T0 }).next;
  const d = decide({ result: ok, prev, nowMs: T0 + 5 * MIN });
  assert.match(d.post, /^✅ backups recovered \(STALE since/);
  assert.equal(d.next.episode, null);
  assert.equal(decide({ result: ok, prev: d.next, nowMs: T0 + 10 * MIN }).post, null);
});

const stateIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alert-state-')), 'state.json');
const readSt = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// A DEST holding one copy that passes the monitor's cheap completeness check, stamped one minute
// before T0+5min, so the monitor reports OK at that clock.
function makeOkDest() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-okdest-'));
  const copy = path.join(dest, 'graph-store-20261004T200400Z');
  fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(copy, 'backup-manifest.json'), JSON.stringify({ files: [{ name: 'CURRENT', size: 16 }] }));
  return dest;
}

async function standInBoard(statuses) {
  const seen = [];
  let i = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
      const st = statuses[Math.min(i++, statuses.length - 1)];
      res.writeHead(st, { 'content-type': 'application/json' });
      res.end(JSON.stringify(st === 201 ? { id: `p${i}` } : { error: 'stand-in failure' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, stop: () => new Promise((r) => srv.close(r)) };
}

test('#1578 alertOnce: an empty DEST is NO-COPY, posted ONCE as `board`; the next run in the window posts nothing', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-dest-'));
  const stateFile = stateIn();
  const b = await standInBoard([201]);
  try {
    const r1 = await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 });
    assert.equal(r1.result.verdict, 'NO-COPY');
    assert.equal(r1.posted, 1);
    assert.equal(b.seen.length, 1);
    assert.equal(b.seen[0].method, 'POST');
    assert.equal(b.seen[0].url, '/api/conversations');
    assert.equal(b.seen[0].body.author, 'board');
    assert.equal(b.seen[0].authorization, `Bearer ${KEY}`, 'posted as the board seat, with its key');
    assert.match(b.seen[0].body.body, /BACKUP ALERT NO-COPY/);
    assert.equal(readSt(stateFile).episode.verdict, 'NO-COPY');
    assert.equal(fs.readdirSync(dest).length, 0, 'nothing is written into the monitored DEST');
    const r2 = await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 + 5 * MIN });
    assert.equal(r2.posted, 0);
    assert.equal(b.seen.length, 1, 'no second post inside the reminder window');
  } finally { await b.stop(); }
});

test('#1578 alertOnce: a FAILED post is kept PENDING and delivered first on the next run', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-dest-'));
  const stateFile = stateIn();
  const b = await standInBoard([500, 201]);
  try {
    const r1 = await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 });
    assert.equal(r1.posted, 0);
    assert.match(r1.deliveryError, /HTTP 500/);
    assert.equal(readSt(stateFile).pending.length, 1, 'the undelivered alert is kept');
    assert.ok(!fs.readFileSync(stateFile, 'utf8').includes(KEY), 'the key is never written to state');
    const r2 = await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 + 5 * MIN });
    assert.equal(r2.posted, 1, 'the pending alert, and no second copy of it');
    assert.equal(b.seen.length, 2);
    assert.match(b.seen[1].body.body, /BACKUP ALERT NO-COPY/);
    assert.equal(readSt(stateFile).pending.length, 0);
  } finally { await b.stop(); }
});

test('#1578 alertOnce: failed post, then the backups RECOVER before the retry: the alert AND the recovery are both delivered, in order', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-dest-'));
  const stateFile = stateIn();
  const b = await standInBoard([500, 201, 201]);
  try {
    await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 });                  // NO-COPY, post fails
    const st = readSt(stateFile);
    assert.equal(st.episode.verdict, 'NO-COPY');
    const okRun = await alertOnce({ key: KEY, dest: makeOkDest(), board: b.url, stateFile, nowMs: T0 + 5 * MIN });
    assert.equal(okRun.result.verdict, 'OK');
    assert.equal(okRun.posted, 2, 'the pending alert, then the recovery');
    assert.match(b.seen[1].body.body, /BACKUP ALERT NO-COPY/);
    assert.match(b.seen[2].body.body, /^✅ backups recovered \(NO-COPY since/);
    const after = readSt(stateFile);
    assert.equal(after.episode, null);
    assert.deepEqual(after.pending, []);
    assert.equal(after.lastVerdict, 'OK');
  } finally { await b.stop(); }
});

test('#1578 alertOnce: a MISSING DEST across successive runs posts UNAVAILABLE once (state lives outside DEST)', async () => {
  const dest = path.join(os.tmpdir(), `alert-missing-${process.pid}-${Date.now()}`);
  const stateFile = stateIn();
  const b = await standInBoard([201]);
  try {
    for (let k = 0; k < 4; k++) {
      const r = await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 + k * 5 * MIN });
      assert.equal(r.result.verdict, 'UNAVAILABLE');
    }
    assert.equal(b.seen.length, 1, 'one post for the episode, not one per run');
    assert.match(b.seen[0].body.body, /BACKUP ALERT UNAVAILABLE/);
  } finally { await b.stop(); }
});

test('#1578 alertOnce: an unreachable board is a delivery error, not a crash', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-dest-'));
  const r = await alertOnce({ key: KEY, dest, board: 'http://127.0.0.1:9', stateFile: stateIn(), nowMs: T0 });
  assert.equal(r.posted, 0);
  assert.ok(r.deliveryError);
});

test('#1578 plist: --board makes the MONITOR job run the alert deliverer; refused for the tick job', () => {
  const base = { dest: '/tmp/d', url: 'http://127.0.0.1:59143', code: '/opt/code', node: '/usr/bin/node' };
  const x = renderPlist({ ...base, job: 'monitor', board: 'http://127.0.0.1:59141', keyFile: '/opt/keys/board' });
  assert.match(x, /<string>--key-file<\/string>\s*<string>\/opt\/keys\/board<\/string>/);
  assert.match(x, /graph-store-backup-alert\.mjs/);
  assert.match(x, /<string>--board<\/string>\s*<string>http:\/\/127\.0\.0\.1:59141<\/string>/);
  const plain = renderPlist({ ...base, job: 'monitor' });
  assert.throws(() => renderPlist({ ...base, job: 'monitor', board: 'http://127.0.0.1:59141' }), /needs --key-file/);
  assert.match(plain, /graph-store-backup-monitor\.mjs/, 'without --board: unchanged');
  assert.throws(() => renderPlist({ ...base, job: 'tick', board: 'http://127.0.0.1:59141', keyFile: '/opt/keys/board' }), /monitor only/);
});

test('#1578 queue: a long outage keeps the opening alert and only the LATEST reminder', () => {
  let q = queue([], '⚠️ BACKUP ALERT STALE — open');
  for (let h = 1; h <= 10; h++) q = queue(q, `⚠️ BACKUP ALERT STALE still open since T. hour ${h}`);
  assert.deepEqual(q.map((p) => p.kind), ['open', 'remind']);
  assert.match(q[1].body, /hour 10$/);
  q = queue(q, '✅ backups recovered (STALE since T closed).');
  assert.deepEqual(q.map((p) => p.kind), ['open', 'remind', 'recover']);
});

test('#1578 alertOnce: a 10-hour board outage delivers the alert, ONE latest reminder, and the recovery, not ten reminders', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-dest-'));
  const stateFile = stateIn();
  const down = await standInBoard([500]);
  try { for (let k = 0; k <= 20; k++) await alertOnce({ key: KEY, dest, board: down.url, stateFile, nowMs: T0 + k * 30 * MIN }); }
  finally { await down.stop(); }
  assert.deepEqual(readSt(stateFile).pending.map((p) => p.kind), ['open', 'remind']);
  const up = await standInBoard([201]);
  try {
    const r = await alertOnce({ key: KEY, dest: makeOkDest(), board: up.url, stateFile, nowMs: T0 + 5 * MIN });
    assert.equal(r.posted, 3);
    const bodies = up.seen.map((x) => x.body.body);
    assert.match(bodies[0], /^⚠️ BACKUP ALERT NO-COPY — /);
    assert.match(bodies[1], /^⚠️ BACKUP ALERT NO-COPY still open since/);
    assert.match(bodies[2], /^✅ backups recovered \(NO-COPY since/);
  } finally { await up.stop(); }
});

test('#1578 alertOnce: EVERY run stamps lastRunAt and the verdict (a freshness signal for an independent watcher)', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-dest-'));
  const stateFile = stateIn();
  const b = await standInBoard([201]);
  try {
    await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 });
    assert.equal(readSt(stateFile).lastRunAt, new Date(T0).toISOString());
    await alertOnce({ key: KEY, dest, board: b.url, stateFile, nowMs: T0 + 5 * MIN });   // nothing posted on this run
    const st = readSt(stateFile);
    assert.equal(st.lastRunAt, new Date(T0 + 5 * MIN).toISOString(), 'a run that posts nothing still stamps');
    assert.equal(st.lastVerdict, 'NO-COPY');
  } finally { await b.stop(); }
});
