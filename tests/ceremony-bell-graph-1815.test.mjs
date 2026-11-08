/**
 * #1815 wiring, step A: the bell's reservation, its state and its events are GRAPH state decided by REST under the write
 * lock, the way #1786 holds the whisper's once-per-window guards. Several MCP processes run the tick; REST is the one writer,
 * so two ticks racing one bell get one 201 and one 409. The file store (fileBellStore) stays, for the pure tick's own rows.
 *
 * THE CONTRACT (one table, so a rename is one edit):
 *   POST  /api/ceremony-bells {key, value}  201 {reserved:true, key} for the first reservation of a key, 409 {already:true, key}
 *         for every later one. key = `${kind}@${slotISO}`; REST parses it and refuses (400) a key that does not parse. The
 *         node is a scrum:CeremonyBell at https://scrumboard.local/ceremony-bell/<encodeURIComponent(key)>, carrying
 *         scrum:bellKey, scrum:ceremonyKind, scrum:slotAt and scrum:bellState.
 *   PATCH /api/ceremony-bells {key, value}  200 {ok:true}; 404 for a key never reserved (the reservation is the only way a bell
 *         begins); 400 for a value field REST does not know (fail closed: an unmapped field would vanish on the way in).
 *         `opener` is an edge to the seat's person node; `postId` is an edge to the opener post.
 *   GET   /api/ceremony-bells?key=K  200 {key, value} with the value as last written; 404 for an unknown key.
 *   POST  /api/ceremony-bells/events {key?, event}  201 {id}; a scrum:CeremonyBellEvent linked to its bell by scrum:ofBell (no
 *         edge when there is no key, e.g. schedule-loaded), carrying scrum:outcome, scrum:bootId, scrum:bootAt and, when the
 *         recorder had dropped events, scrum:droppedSince and scrum:firstDropAt.
 *
 * ROWS:
 *   G1  two CONCURRENT reservations of one key: [201, 409]; exactly one CeremonyBell node, at its IRI, with kind and slot
 *   G1b a key that does not parse as kind@ISO is refused 400 and writes nothing
 *   G2  PATCH then GET round-trips the value; the graph holds the opener edge (person) and the opener-post edge (entity)
 *   G3  PATCH of a key never reserved is 404; PATCH with an unknown field is 400; neither writes
 *   G4  an event with a key is linked to its bell; an event without one is not; both carry bootId
 *   G5  a REST restart keeps the reservation (409) and the state (GET)
 *   G6  TWO restBellStores (two processes' worth) racing one ceremonyBellTick each, at the slot: exactly one opener post; the
 *       after-window tick reads the stored createdAt and records landed-on-time, through REST
 *   G7  the recorder: two event writes fail, the bell still posts, and the next event that lands carries droppedSince 2,
 *       firstDropAt, and the same bootId as every other event of that boot
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import fs from 'node:fs';
import { ceremonyBellTick, restBellStore, restRecorder } from '../core/ceremony-bell.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'cb-1815';
const RS = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const BELL = (key) => `https://scrumboard.local/ceremony-bell/${encodeURIComponent(key)}`;
const PERSON = (k) => `https://scrumboard.local/person/${k}`;
const ENTITY = (id) => `https://scrumboard.local/entity/${id}`;

async function world(body) {
  const store = tmpStore('cb-1815-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' };
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'cb-1815' });
  const q = async (s) => { const r = await gc.query(s); assert.ok(r.ok, r.reason); return r.rows; };
  const servers = [];
  let rest = null, boardFile = null;
  const start = async () => {
    if (rest) rest.kill();
    rest = await startRestServer(boardFile ? { boardFile, env } : { board: makeBoardFixture({ cards: [], conversations: [] }), env });
    boardFile = rest.boardFile; servers.push(rest);
    return rest;
  };
  const call = async (method, route, payload) => {
    const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
    const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
  };
  try { await body({ q, start, call, base: () => rest.baseUrl }); }
  finally { for (const r of servers.reverse()) await r.stop().catch(() => {}); await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}
const bells = async (q) => (await q(`SELECT DISTINCT ?s WHERE { ?s <${RDF_TYPE}> <${RS}CeremonyBell> }`)).map((r) => r.s.value);
const objects = async (q, s, p) => (await q(`SELECT ?o WHERE { <${s}> <${RS}${p}> ?o }`)).map((r) => r.o.value);
const events = async (q) => (await q(`SELECT DISTINCT ?e WHERE { ?e <${RDF_TYPE}> <${RS}CeremonyBellEvent> }`)).map((r) => r.e.value);

test('#1815 G1–G5 — the bell is reserved once, its state round-trips, its events link to it, and all of it survives a restart', T, async () => {
  await world(async ({ q, start, call, base }) => {
    await start();
    const KEY = 'review@2026-11-11T16:00:00.000Z';

    // G1
    const [a, b] = await Promise.all([
      call('POST', '/api/ceremony-bells', { key: KEY, value: { state: 'attempted', at: '2026-11-11T16:00:30.000Z' } }),
      call('POST', '/api/ceremony-bells', { key: KEY, value: { state: 'attempted', at: '2026-11-11T16:00:30.000Z' } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `G1: exactly one 201 and one 409 (${a.status} ${a.text.slice(0, 160)} / ${b.status} ${b.text.slice(0, 160)})`);
    assert.equal((a.status === 409 ? a : b).json?.already, true, 'G1: the loser is told {already:true}');
    assert.deepEqual(await bells(q), [BELL(KEY)], 'G1: exactly one CeremonyBell node, at its IRI');
    assert.deepEqual(await objects(q, BELL(KEY), 'ceremonyKind'), ['review'], 'G1: the ceremony kind, parsed from the key');
    assert.deepEqual(await objects(q, BELL(KEY), 'slotAt'), ['2026-11-11T16:00:00.000Z'], 'G1: the slot, parsed from the key');
    assert.deepEqual(await objects(q, BELL(KEY), 'bellState'), ['attempted'], 'G1: the reserved state');

    // G1b
    const bad = await call('POST', '/api/ceremony-bells', { key: 'review-at-four', value: { state: 'attempted' } });
    assert.equal(bad.status, 400, `G1b: an unparseable key is refused (${bad.status} ${bad.text.slice(0, 120)})`);
    assert.deepEqual(await bells(q), [BELL(KEY)], 'G1b: and nothing was written');

    // G2
    const POST_ID = crypto.randomUUID();
    const value = { state: 'posted', at: '2026-11-11T16:00:30.000Z', opener: 'seat-sm', openerSource: 'role', postId: POST_ID, createdAt: '2026-11-11T16:00:31.250Z' };
    const p = await call('PATCH', '/api/ceremony-bells', { key: KEY, value });
    assert.equal(p.status, 200, `G2: state written (${p.status} ${p.text.slice(0, 160)})`);
    const g = await call('GET', `/api/ceremony-bells?key=${encodeURIComponent(KEY)}`);
    assert.equal(g.status, 200, `G2: state read (${g.status})`);
    assert.deepEqual(g.json?.value, value, 'G2: the value round-trips exactly');
    assert.deepEqual(await objects(q, BELL(KEY), 'opener'), [PERSON('seat-sm')], 'G2: the opener is an edge to the seat');
    assert.deepEqual(await objects(q, BELL(KEY), 'openerPost'), [ENTITY(POST_ID)], 'G2: the opener post is an edge to the post');
    assert.deepEqual(await objects(q, BELL(KEY), 'bellState'), ['posted'], 'G2: one state, the latest');

    // G3
    const un = await call('PATCH', '/api/ceremony-bells', { key: 'retro@2026-11-11T17:00:00.000Z', value: { state: 'posted' } });
    assert.equal(un.status, 404, `G3: a key never reserved is 404 (${un.status})`);
    const unk = await call('PATCH', '/api/ceremony-bells', { key: KEY, value: { ...value, colour: 'blue' } });
    assert.equal(unk.status, 400, `G3: an unknown field is refused (${unk.status} ${unk.text.slice(0, 120)})`);
    assert.deepEqual((await call('GET', `/api/ceremony-bells?key=${encodeURIComponent(KEY)}`)).json?.value, value, 'G3: and the stored value is unchanged');
    assert.deepEqual(await bells(q), [BELL(KEY)], 'G3: no bell was created by a PATCH');

    // G3b (review of PR #165): a body that is not JSON is the CLIENT's error: 400 'invalid JSON', never a 500, and nothing written
    // ...and a body that parses but is not an object (`null`, a number) is refused the same way, never left unanswered
    for (const raw of ['{"key": ', 'null', '7']) {
      for (const [method, route] of [['POST', '/api/ceremony-bells'], ['PATCH', '/api/ceremony-bells'], ['POST', '/api/ceremony-bells/events']]) {
        const x = await fetch(`${base()}${route}`, { method, headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(30000) });
        const t = await x.text();
        assert.equal(x.status, 400, `G3b: ${method} ${route} with body ${raw} is 400 (${x.status} ${t.slice(0, 120)})`);
        assert.match(t, /invalid JSON/, `G3b: and says so (${t.slice(0, 120)})`);
      }
    }
    assert.deepEqual(await bells(q), [BELL(KEY)], 'G3b: no bell was created by a malformed body');
    assert.deepEqual(await events(q), [], 'G3b: and no event either');

    // G4
    const boot = { bootId: 'boot-g4', bootAt: '2026-11-11T15:00:00.000Z' };
    const e1 = await call('POST', '/api/ceremony-bells/events', { key: KEY, event: { type: 'bell', outcome: 'fired', tickAt: '2026-11-11T16:00:30.000Z', opener: 'seat-sm', openerSource: 'role', ...boot } });
    const e2 = await call('POST', '/api/ceremony-bells/events', { event: { type: 'schedule-loaded', tickAt: '2026-11-11T15:00:00.000Z', sha256: 'ab'.repeat(32), ...boot } });
    assert.equal(e1.status, 201, `G4: a bell event is recorded (${e1.status} ${e1.text.slice(0, 160)})`);
    assert.equal(e2.status, 201, `G4: a schedule event is recorded (${e2.status} ${e2.text.slice(0, 160)})`);
    const linked = (await q(`SELECT ?e WHERE { ?e <${RS}ofBell> <${BELL(KEY)}> }`)).map((r) => r.e.value);
    assert.equal(linked.length, 1, `G4: exactly the bell event links to the bell (${linked})`);
    assert.deepEqual(await objects(q, linked[0], 'outcome'), ['fired'], 'G4: with its outcome');
    const all = await events(q);
    assert.equal(all.length, 2, `G4: two events in all (${all})`);
    const loose = all.find((e) => e !== linked[0]);
    assert.deepEqual(await objects(q, loose, 'ofBell'), [], 'G4: the schedule event has no bell edge');
    for (const e of all) assert.deepEqual(await objects(q, e, 'bootId'), ['boot-g4'], `G4: every event carries its bootId (${e})`);

    // G5
    await start();
    const again = await call('POST', '/api/ceremony-bells', { key: KEY, value: { state: 'attempted' } });
    assert.equal(again.status, 409, `G5: still reserved after a restart (${again.status})`);
    assert.deepEqual((await call('GET', `/api/ceremony-bells?key=${encodeURIComponent(KEY)}`)).json?.value, value, 'G5: and the state survives');
  });
});

const SCHEDULE = [{ kind: 'review', weekday: 3, time: '16:00', preRead: '1815' }];
const SEATS = { seats: [{ seat: 'seat-sm', role: 'scrum-master' }, { seat: 'seat-po', role: 'po' }] };

test('#1815 G6 — two processes\' stores racing one bell through REST: one opener; the after-window check reads REST', T, async () => {
  await world(async ({ q, start, base }) => {
    await start();
    const posts = [];
    const post = async (p) => { posts.push(p); return { id: crypto.randomUUID(), createdAt: '2026-11-11T16:00:31.000Z' }; };
    const slowSeats = async () => { await new Promise((r) => setTimeout(r, 20)); return SEATS; };
    const recorded = [];
    const record = (e) => { recorded.push(e); };
    const [s1, s2] = [restBellStore({ base: base() }), restBellStore({ base: base() })];
    await Promise.all([
      ceremonyBellTick({ now: '2026-11-11T16:00:30Z', schedule: SCHEDULE, seatState: slowSeats, store: s1, post, record }),
      ceremonyBellTick({ now: '2026-11-11T16:00:30Z', schedule: SCHEDULE, seatState: slowSeats, store: s2, post, record }),
    ]);
    const openers = posts.filter((p) => p.kind === 'opener');
    assert.equal(openers.length, 1, `G6: exactly one opener across two processes' stores (${JSON.stringify(openers)})`);
    assert.ok(recorded.some((e) => e.outcome === 'suppressed-duplicate'), `G6: the loser recorded suppressed-duplicate (${recorded.map((e) => e.outcome)})`);
    const KEY = 'review@2026-11-11T16:00:00.000Z';
    assert.deepEqual(await objects(q, BELL(KEY), 'bellState'), ['posted'], 'G6: REST holds the posted state');

    await ceremonyBellTick({ now: '2026-11-11T16:06:00Z', schedule: SCHEDULE, seatState: slowSeats, store: restBellStore({ base: base() }), post, record });
    const last = recorded.at(-1);
    assert.equal(last.outcome, 'landed-on-time', `G6: the after-window tick read REST's createdAt (${JSON.stringify(last)})`);
    assert.equal(last.lagSeconds, 31, 'G6: 31 s after the slot');
    assert.equal(posts.filter((p) => p.kind === 'flag').length, 0, 'G6: no flag for an on-time opener');
  });
});

test('#1815 G7 — the recorder: dropped events do not stop the bell, and the next event that lands says how many were lost', T, async () => {
  await world(async ({ q, start, base }) => {
    await start();
    let failing = 2;
    const realFetch = globalThis.fetch;
    const flakyFetch = async (url, opts) => {
      if (String(url).includes('/api/ceremony-bells/events') && failing > 0) { failing--; throw new Error('injected: graph write refused'); }
      return realFetch(url, opts);
    };
    const logged = [];
    const record = restRecorder({ base: base(), bootId: 'boot-g7', bootAt: '2026-11-11T15:59:00.000Z', fetch: flakyFetch, log: (m) => logged.push(m) });
    const posts = [];
    const post = async (p) => { posts.push(p); return { id: crypto.randomUUID(), createdAt: '2026-11-11T16:00:31.000Z' }; };
    const SCHED_FILE_LESS = SCHEDULE;
    // tick 1 fires (event 1 dropped); tick 2 is a duplicate (event 2 dropped); tick 3 is a duplicate (event 3 lands)
    for (const now of ['2026-11-11T16:00:30Z', '2026-11-11T16:01:30Z', '2026-11-11T16:02:30Z']) {
      await ceremonyBellTick({ now, schedule: SCHED_FILE_LESS, seatState: async () => SEATS, store: restBellStore({ base: base() }), post, record });
    }
    await record.flush();
    assert.equal(posts.filter((p) => p.kind === 'opener').length, 1, 'G7: the bell posted although its event was dropped');
    assert.equal(logged.length, 2, `G7: each drop was logged (${JSON.stringify(logged)})`);
    const evs = await events(q);
    assert.equal(evs.length, 1, `G7: one event reached the graph (${evs})`);
    assert.deepEqual(await objects(q, evs[0], 'droppedSince'), ['2'], 'G7: it says two were dropped before it');
    assert.equal((await objects(q, evs[0], 'firstDropAt')).length, 1, 'G7: and when the first drop was');
    assert.deepEqual(await objects(q, evs[0], 'bootId'), ['boot-g7'], 'G7: with the boot it belongs to');
    assert.deepEqual(await objects(q, evs[0], 'bootAt'), ['2026-11-11T15:59:00.000Z'], 'G7: and that boot\'s start, where coverage begins');
  });
});
