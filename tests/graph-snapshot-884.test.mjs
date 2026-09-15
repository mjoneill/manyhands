/**
 * #884 — A BOOT LOADS THE STORE FROM A SNAPSHOT, NOT FROM A REPLAY.
 *
 * Measured 2026-09-15 on the prod shape (430k triples): cold build 18–37 s
 * depending on load; `store.dump` 1.2 s → 104 MB; `store.load` 0.9 s. Every
 * restart of the board was paying the cold build while the server answered
 * nothing — 13 deploys on 09-14 alone, and a boot that took 8 minutes under
 * the night's paging (#1388). The snapshot is the store's own n-quads dump
 * beside a sidecar that records the event-log position (`seq`) it was taken
 * at, plus the incremental sync's hash cache so the first sync after a warm
 * boot re-projects only what changed since — not all 30k entities.
 *
 * Rails, each with its sabotage:
 *   round-trip   what was dumped is what loads (size, hashes, seq)
 *   ahead-of-log a snapshot whose seq is beyond the log head is REFUSED —
 *                the #1211 shape (a restored backup) must fall to the cold
 *                path, said so, never trusted   (drop the check → case fails)
 *   corrupt      a bad .nq or sidecar is a cold boot, not a crash
 *   atomic       a failed write leaves the previous snapshot intact
 *   SEAM         a served boot with a snapshot + later events: the graph
 *                carries the later events, the log says WARM
 *                (skip the replay → the later activity is missing)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import oxigraph from 'oxigraph';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { writeSnapshot, readSnapshot, snapshotPaths, SNAPSHOT_FORMAT } from '../core/graph-snapshot.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snap-884-'));
const fixtureStore = () => buildGraphStore({ '@graph': [
  { '@id': 'https://scrumboard.local/entity/c1', '@type': 'schema:CreativeWork', identifier: '1', name: 'first card', additionalType: 'scrum:Card' },
  { '@id': 'https://scrumboard.local/entity/c2', '@type': 'schema:CreativeWork', identifier: '2', name: 'second card', additionalType: 'scrum:Card' },
] });
const cache = () => ({
  hashes: new Map([['https://scrumboard.local/entity/c1', 'h1'], ['https://scrumboard.local/entity/c2', 'h2']]),
  signals: new Map([['https://scrumboard.local/entity/c1', 's1']]),
});

test('#884 round-trip — what was dumped is what loads: triples, hashes, signals, seq, stamp', () => {
  const dir = tmpdir();
  const store = fixtureStore();
  const { hashes, signals } = cache();
  const w = writeSnapshot(dir, { store, seq: 42, at: '2026-09-15T12:00:00.000Z', docStamp: '2026-09-15T11:59:59.000Z', hashes, signals });
  assert.equal(w.triples, store.size);
  assert.ok(w.bytes > 0 && w.ms >= 0);
  const r = readSnapshot(dir, { logHeadSeq: 42, oxigraph });
  assert.equal(r.ok, true, `expected a warm read, got ${JSON.stringify(r)}`);
  assert.equal(r.store.size, store.size, 'every triple came back');
  assert.equal(r.seq, 42);
  assert.equal(r.at, '2026-09-15T12:00:00.000Z');
  assert.equal(r.docStamp, '2026-09-15T11:59:59.000Z');
  assert.deepEqual([...r.hashes], [...hashes], 'the hash cache survives, so the next sync reuses it');
  assert.deepEqual([...r.signals], [...signals]);
  assert.ok(r.ms >= 0);
});

test('#884 ahead-of-log — a snapshot whose seq is beyond the log head is REFUSED, not trusted (#1211 shape)', () => {
  const dir = tmpdir();
  writeSnapshot(dir, { store: fixtureStore(), seq: 500, at: '2026-09-15T12:00:00.000Z', docStamp: null, ...cache() });
  const r = readSnapshot(dir, { logHeadSeq: 120, oxigraph });   // the log only reaches 120: this snapshot is from a future the log does not have
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ahead-of-log');
  assert.match(String(r.detail), /500/, 'the refusal names the seq it saw');
  assert.match(String(r.detail), /120/, 'and the head it compared against');
  // Same seq as the head is fine: a clean shutdown snapshot IS at the head.
  assert.equal(readSnapshot(dir, { logHeadSeq: 500, oxigraph }).ok, true);
});

test('#884 missing / corrupt — a bad or absent snapshot is a cold boot with a reason, never a throw', () => {
  const dir = tmpdir();
  assert.deepEqual(readSnapshot(dir, { logHeadSeq: 10, oxigraph }).reason, 'missing');
  writeSnapshot(dir, { store: fixtureStore(), seq: 3, at: '2026-09-15T12:00:00.000Z', docStamp: null, ...cache() });
  const { nq, meta } = snapshotPaths(dir);
  fs.writeFileSync(nq, '<this is not> n-quads <at all> .\n');
  const bad = readSnapshot(dir, { logHeadSeq: 10, oxigraph });
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'corrupt');
  fs.writeFileSync(meta, '{ not json');
  assert.equal(readSnapshot(dir, { logHeadSeq: 10, oxigraph }).reason, 'corrupt');
  fs.writeFileSync(meta, JSON.stringify({ format: SNAPSHOT_FORMAT + 1, seq: 3 }));
  assert.equal(readSnapshot(dir, { logHeadSeq: 10, oxigraph }).reason, 'format', 'a snapshot from a different format is not guessed at');
});

test('#884 atomic — a failed write leaves the previous snapshot intact and readable', () => {
  const dir = tmpdir();
  writeSnapshot(dir, { store: fixtureStore(), seq: 7, at: '2026-09-15T12:00:00.000Z', docStamp: null, ...cache() });
  const before = fs.readFileSync(snapshotPaths(dir).nq, 'utf8');
  // A store whose dump throws mid-way: the write must fail BEFORE any rename.
  const broken = { size: 1, dump: () => { throw new Error('disk on fire'); } };
  assert.throws(() => writeSnapshot(dir, { store: broken, seq: 8, at: '2026-09-15T12:01:00.000Z', docStamp: null, ...cache() }), /disk on fire/);
  assert.equal(fs.readFileSync(snapshotPaths(dir).nq, 'utf8'), before, 'the .nq on disk is still the seq-7 dump');
  assert.equal(readSnapshot(dir, { logHeadSeq: 8, oxigraph }).seq, 7, 'and the sidecar still says 7, not 8');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'no temp file is left behind');
});

// ── THE LOUD SEAM — two served boots on one board directory ─────────────────
// Boot 1 (cold) takes a snapshot after N events; more events land after it;
// boot 2 must start WARM from the snapshot and still carry the later events.
async function sparql(baseUrl, query) {
  const res = await fetch(`${baseUrl}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const body = await res.json();
  assert.equal(res.status, 200, `graph query failed: ${JSON.stringify(body)}`);
  return body;
}
const createCard = async (baseUrl, title) => {
  const r = await fetch(`${baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, by: 'ada' }) });
  assert.equal(r.status, 201, `create ${title}`);
  return r.json();
};

test('#884 SEAM — a served boot loads the snapshot, replays the events after it, and says WARM', async () => {
  const env = { SCRUM_GRAPH_SNAPSHOT_EVERY: '2' };   // snapshot after every 2 events, so the test can straddle one
  const s1 = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }), env });
  let dir, boardCopy;
  try {
    await sparql(s1.baseUrl, 'SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity }');   // warm the store once (cold path)
    assert.ok(await s1.waitForStderr(/graph-replica: boot COLD/), 'a first boot with no snapshot says COLD');
    await createCard(s1.baseUrl, 'card A');
    await createCard(s1.baseUrl, 'card B');                       // event 2 → a snapshot is due
    await sparql(s1.baseUrl, 'ASK { ?a a prov:Activity }');       // the sync that notices seq 2 and writes it
    assert.ok(await s1.waitForStderr(/graph-replica: snapshot written .*seq=2/, 8000), `no snapshot after 2 events; stderr:\n${s1.stderr().slice(-600)}`);
    const later = await createCard(s1.baseUrl, 'card C — after the snapshot');   // seq 3, NOT in the snapshot
    await sparql(s1.baseUrl, 'ASK { ?a a prov:Activity }');       // make sure the event is logged before we copy
    // Copy the whole board directory: stop() unlinks the board file, and the
    // second boot must read the same log + snapshot the first one wrote.
    dir = path.dirname(s1.boardFile);
    boardCopy = path.join(tmpdir(), 'board-data.json');
    fs.cpSync(dir, path.dirname(boardCopy), { recursive: true });
    fs.renameSync(path.join(path.dirname(boardCopy), path.basename(s1.boardFile)), boardCopy);
    const evDir = path.join(path.dirname(boardCopy), path.basename(s1.boardFile).replace(/\.json$/, '') + '-events');
    if (fs.existsSync(evDir)) fs.renameSync(evDir, boardCopy.replace(/\.json$/, '') + '-events');
    assert.ok(fs.existsSync(path.join(path.dirname(boardCopy), 'graph-snapshot.nq')), 'the snapshot travelled with the copy');
    var laterId = later.id;
  } finally {
    await s1.stop();
  }
  const s2 = await startRestServer({ boardFile: boardCopy, env });
  try {
    const acts = await sparql(s2.baseUrl, `SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity ; prov:used <https://scrumboard.local/entity/${laterId}> }`);
    assert.ok(await s2.waitForStderr(/graph-replica: boot WARM from snapshot seq=2/), `second boot did not say WARM; stderr:\n${s2.stderr().slice(-800)}`);
    // The warm boot restored the sync cache: the first sync re-projects ONLY the
    // entity the snapshot did not have (card C), not every entity in the document.
    // Without the cache a warm boot is the cold boot's cost, one function later.
    const warmLine = s2.stderr().match(/boot WARM from snapshot seq=2 \((\d+) triples, (\d+) cached entities\)/);
    assert.ok(warmLine && Number(warmLine[2]) >= 2, `the WARM line names the cached entities it restored; got ${warmLine?.[0]}`);
    assert.ok(await s2.waitForStderr(/graph-replica: synced 1 updated, 0 removed/), `first sync after a warm boot must update ONE entity (card C); stderr:\n${s2.stderr().slice(-800)}`);
    assert.notEqual(acts.rows[0].n, '0', 'the event AFTER the snapshot was replayed into the graph');
    const cards = await sparql(s2.baseUrl, 'SELECT (COUNT(?c) AS ?n) WHERE { ?c a schema:CreativeWork ; schema:name ?t . FILTER(STRSTARTS(?t, "card")) }');
    assert.equal(cards.rows[0].n, '3', 'A and B from the snapshot, C from the sync — all three');
  } finally {
    await s2.stop();
  }
});

// ── SIGTERM — what launchd and deploy.sh send. The snapshot taken here is why
// the boot that follows a deploy is warm rather than a replay of the whole log.
import { execSync } from 'node:child_process';
test('#884 SIGTERM — a stopping server writes a snapshot at the log head before it exits', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }), env: { SCRUM_GRAPH_SNAPSHOT_EVERY: '1000000' } });
  const dir = path.dirname(s.boardFile);
  try {
    await createCard(s.baseUrl, 'card before the stop');
    await sparql(s.baseUrl, 'ASK { ?a a prov:Activity }');              // store warmed, seq 1 projected, no periodic snapshot (EVERY is huge)
    assert.equal(fs.existsSync(snapshotPaths(dir).nq), false, 'control: nothing snapshotted yet');
    const port = new URL(s.baseUrl).port;
    const pid = Number(execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).toString().trim().split('\n')[0]);
    assert.ok(pid > 0, 'found the server pid by its port');
    process.kill(pid, 'SIGTERM');
    const t0 = Date.now();
    while (!fs.existsSync(snapshotPaths(dir).meta) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await s.waitForStderr(/graph-replica: snapshot written \(SIGTERM\) seq=1/, 8000), `no SIGTERM snapshot; stderr:\n${s.stderr().slice(-600)}`);
    const r = readSnapshot(dir, { logHeadSeq: 1, oxigraph });
    assert.equal(r.ok, true, `the SIGTERM snapshot is readable at the head: ${JSON.stringify(r.reason)}`);
    assert.equal(r.seq, 1);
  } finally {
    await s.stop();
  }
});

import { sweepSnapshotTemps } from '../core/graph-snapshot.mjs';
test('#884 an interrupted write\'s temp files are swept, and only those', () => {
  const dir = tmpdir();
  writeSnapshot(dir, { store: fixtureStore(), seq: 1, at: '2026-09-15T12:00:00.000Z', docStamp: null, ...cache() });
  fs.writeFileSync(path.join(dir, 'graph-snapshot.nq.tmp-99999'), 'half a dump');
  fs.writeFileSync(path.join(dir, 'graph-snapshot.json.tmp-99999'), '{');
  fs.writeFileSync(path.join(dir, 'unrelated.tmp-1'), 'not ours');
  assert.equal(sweepSnapshotTemps(dir), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['graph-snapshot.json', 'graph-snapshot.nq', 'unrelated.tmp-1'], 'the real pair and a stranger\'s file survive');
  assert.equal(readSnapshot(dir, { logHeadSeq: 1, oxigraph }).ok, true);
});
