/**
 * #1563 — the board WITHOUT board-data.json: an explicit, fail-closed mode (design v2, docs/1563-board-without-document-design-v2.md §3, §4).
 * TEST AUTHOR's, written before any build, against v2's rows D0–D8.
 *
 * THE WORLD: the whole-board fixture (tests/helpers/whole-board-1645.mjs, plain: its document is kept) migrated into a real executor, then a REST
 * restarted under EVERY authoritative unit (cards, columns, conversations, logborn, smallkinds, deliveries) and production's sources, with the
 * board file PRESENT, ABSENT or UNREADABLE (chmod 000) as each row says. The fixture's document is copied aside first and put back after each
 * stop, because the test harness's stop() unlinks the board file (found while writing these rows; see #1710).
 *
 * TWO INSTRUMENTS (v2 §0b.7), and a row needs BOTH at zero:
 *   the runtime's own counter of attempted opens of BOARD_DATA_FILE, read from /api/health (OPENS below: the location is the builder's to name);
 *   the TEST's own recorder (tests/helpers/fs-store-recorder.mjs, SCRUM_FS_RECORD_ALL=1): every fs attempt the REST process makes, through a
 *   module hook the server cannot see or skip. A caught-and-defaulted read is invisible to every route and VISIBLE here.
 * D0 proves the recorder can see a board open (in today's mode it must record one), so a recorder that records nothing cannot pass D1.
 *
 * NAMES THE BUILDER MAY CHANGE, IN ONE PLACE EACH: MODE_ENV and its values; OPENS (the build exposes the counters as `graph.document` on
 * /api/health, legacyCounters() plus fileKey and stat: point OPENS at their sum once the field names exist); REPLICA_RETIRED.
 *
 *   D0  CONTROL: mode unset, file present: every probed route answers as today, and the recorder DOES record the board file being opened
 *   D1  THE PROOF: mode off, file UNREADABLE: REST boots; every probed route answers with content (200/201, the fixture's own card, and a new
 *       post numbered 3, continuing from the graph's 1 and 2);
 *       the runtime counter is exactly 0 (a number, not missing) AND the recorder saw no attempt on the board file
 *   D2  NO RE-SEED: mode off, file ABSENT: after a read and a write (a card, a post) the file still does not exist; both instruments 0
 *   D3  FAIL-CLOSED BOOT: mode off with one authoritative unit (logborn) unset: REST does not start, and its output names that unit
 *   D4  lastUpdated (design answer 43564: the named refusal is retired, D3's boot refusal is the enforcement; the one document field a route
 *       still serves is /api/board/status `lastUpdated`): mode off, file absent, after a card write: lastUpdated is a valid ISO time, no earlier
 *       than that write's own time, and never null
 *   D5  ROSTER: mode off, file absent: a post by a roster seat keeps its author and resolves a mention of another roster seat, exactly as the
 *       same post does in today's mode; and an agent added at runtime is then resolvable as a mention (the roster cache is not keyed on the file)
 *   D6  NODE APIs + COLD BUILD (design answer 43542/43564): mode off, file absent: GET /api/nodes lists the fixture's cards and a card made
 *       in this run, GET /api/nodes/<that card> is 200 and names it (the units answer: #1709's fix); a request that would cold-build the
 *       replica (POST /api/graph source:replica) is 503 REPLICA_RETIRED; neither instrument sees a board-file open
 *   D7a OWNER UNAVAILABLE AT BOOT: mode off, executor unreachable: REST does not start, and the refusal names the executor, NOT a missing
 *       owner (under the build's fail-closed boot every off-mode start refuses until the owners land, so "did not start" alone would pass for
 *       the wrong reason)
 *   D7b OWNER UNAVAILABLE AT RUNTIME: booted, then the executor stopped, an
 *       executor-owned read is a 503 with a code, never a 200 with [] or {}
 *   D8  READ-OFF: mode read-off, file present: reads attempt no open of the board file (recorder); a write updates the file (the mirror is
 *       still written); a REST restarted with the mode UNSET then serves that write (the rollback window is real)
 *
 * Mutants this file is built to catch (v2 §4): re-seed on write (D2); silent [] for a retired or unavailable record (D7); a caught-and-defaulted
 * file read (D1, on the recorder, while every route still answers). NOT covered, by name: prod's data shape (D1 on a copy of prod is the card's
 * own live step); the event log's growth; concurrent writers; the read-off → off transition itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, killExecutor } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer, freePort } from './helpers/harness.mjs';

// ── the builder's names ──
const MODE_ENV = 'SCRUM_BOARD_DOCUMENT';
const MODE = { off: 'off', readOff: 'read-off' };
const OPENS = (health) => health?.document?.attemptedOpens;   // the runtime's counter of attempted opens of BOARD_DATA_FILE
const REPLICA_RETIRED = 'REPLICA_RETIRED';   // D6: the replica's cold build in mode off (design answer, 43542/43564)

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
// Rows that need a REST BOOTED in mode off or read-off. The build's fail-closed boot refuses until every document-only field has an
// owner, and two do not yet: outbox (#1629) and labelAliases (#1640). So these are TODO (reported on every run, never failing CI)
// until both land; then delete OWNERS_PENDING and every row must pass as a plain test. Measured 2026-10-18 on the build with both
// marked owned: 9/9 (the PO's scratch check at 30b32f4).
const OWNERS_PENDING = { todo: 'mode off cannot boot until outbox (#1629) and labelAliases (#1640) have owners: delete OWNERS_PENDING when they land' };
const TO = { ...T, ...OWNERS_PENDING };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, 'helpers', 'fs-store-recorder.mjs');
const ROSTER = path.join(os.tmpdir(), `r1563-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, grace: { name: 'Grace', glyph: 'g', color: '#c47ca0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch { /* best effort */ } });

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
// the routes of the cold-start probe recorded on #1645 (v30–v31), each with what "answers with content" means on this fixture
const ROUTES = [
  ['GET', '/api/health', null, (j) => j.ok === true], ['GET', '/api/version', null, (j) => Object.hasOwn(j, 'sha')],   // sha is null outside a git checkout
  ['GET', '/api/cards', null, (j) => JSON.stringify(j).includes('card 1')], ['GET', '/api/cards/1', null, (j) => j.shortId === 1],
  ['GET', '/api/columns', null, (j) => JSON.stringify(j).includes('backlog')], ['GET', '/api/board/status', null, (j) => j.cardsTotal === 3],
  ['GET', '/api/ready', null, (j) => Array.isArray(j.ready)], ['GET', '/api/checks?fresh=1', null, (j) => Array.isArray(j.standing)],
  ['GET', '/api/conversations?limit=3', null, (j) => JSON.stringify(j).includes('a board post')], ['GET', '/api/memories', null, (j) => Array.isArray(j) || Array.isArray(j?.memories)],
  ['GET', '/api/decisions', null, (j) => Array.isArray(j) || Array.isArray(j?.decisions)], ['GET', '/api/seats/state', null, (j) => j && typeof j === 'object'],
  ['GET', '/api/graph/vocabulary', null, (j) => j.ok === true], ['GET', '/api/predicates', null, (j) => Array.isArray(j)],
  ['GET', '/api/graph/neighbors?node=1', null, (j) => j.exists === true], ['GET', '/api/kinds', null, (j) => j && typeof j === 'object'],
  ['POST', '/api/graph', { query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 2' }, (j) => j.rows?.length === 2],
  // the fixture's graph holds posts 1 and 2: a new post must CONTINUE from the graph's max (#1710: with no document it reused 1)
  ['POST', '/api/conversations', { body: 'a #1563 probe post', author: 'ada' }, (j) => j.author === 'ada' && j.postSeq === 3],
  ['POST', '/api/cards', { title: 'a #1563 probe card', createdBy: 'ada' }, (j) => j.title === 'a #1563 probe card'],
];

/** One fixture world: the executor and the kept document; `rest(opts)` starts a REST over it in the state a row names. */
async function world(body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const running = [];
  const rest = async ({ mode = null, file = 'present', env = {}, record = true, executorUrl = w.exec.baseUrl } = {}) => {
    if (file === 'present') fs.writeFileSync(w.boardFile, kept);   // 'as-is' leaves the file exactly as the last REST left it
    if (file === 'absent') fs.rmSync(w.boardFile, { force: true });
    if (file === 'unreadable') { fs.writeFileSync(w.boardFile, kept); fs.chmodSync(w.boardFile, 0o000); }
    const rec = record ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r1563-rec-')), 'fs.txt') : null;
    const recEnv = rec ? { SCRUM_FS_RECORD: rec, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${RECORDER}` } : {};
    const r = await startRestServer({ boardFile: w.boardFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: executorUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, ...(mode ? { [MODE_ENV]: mode } : {}), ...recEnv, ...env } });
    running.push(r);
    const boardOpens = () => (rec && fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split('\n').filter((l) => l === w.boardFile || l === fs.realpathSync.native(path.dirname(w.boardFile)) + '/' + path.basename(w.boardFile)).length : 0);
    const recorded = () => (rec && fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).length : 0);
    const call = async (method, route, payload) => {
      const x = await fetch(`${r.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    const stop = async () => { const i = running.indexOf(r); if (i >= 0) running.splice(i, 1); try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ } const had = fs.existsSync(w.boardFile) ? fs.readFileSync(w.boardFile) : null; await r.stop(); if (had) fs.writeFileSync(w.boardFile, had); };
    return { r, call, boardOpens, recorded, stop };
  };
  try { await body({ w, rest, kept }); } finally {
    // the executor MUST be stopped whatever failed above: a leaked executor keeps the test runner alive forever (found 2026-10-18:
    // a row that left the board file chmod 000 made the restore below throw before w.stop(), and the run hung 50 min)
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    for (const r of [...running]) await r.stop().catch(() => {});
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* the world is going anyway */ }
    await w.stop();
  }
}
async function allRoutes(s, label) {
  for (const [m, route, payload, serves] of ROUTES) {
    const x = await s.call(m, route, payload);
    assert.ok(x.status === 200 || x.status === 201, `${label}: ${m} ${route} answered ${x.status} (${x.text.slice(0, 160)})`);
    assert.ok(x.json && serves(x.json), `${label}: ${m} ${route} answered with the fixture's content (${x.text.slice(0, 200)})`);
  }
}

test('#1563 (D0 CONTROL) mode unset, file present: every probed route answers as today, and the recorder DOES see the board file opened', T, async () => {
  await world(async ({ rest }) => {
    const s = await rest();
    await allRoutes(s, 'D0');
    assert.ok(s.recorded() > 0, 'CONTROL: the recorder recorded this process\'s file attempts');
    assert.ok(s.boardOpens() > 0, 'CONTROL: in today\'s mode the recorder sees the board file opened, so it CAN see what D1 asserts is absent');
  });
});

test('#1563 (D1) mode off, file UNREADABLE: REST boots, every probed route answers with content, and NEITHER instrument sees a board-file open', TO, async () => {
  await world(async ({ rest }) => {
    const s = await rest({ mode: MODE.off, file: 'unreadable' });
    await allRoutes(s, 'D1');
    const h = (await s.call('GET', '/api/health')).json;
    assert.equal(typeof OPENS(h), 'number', `the runtime exposes its attempted-open counter (got ${JSON.stringify(h?.document)})`);
    assert.equal(OPENS(h), 0, 'the runtime counted no attempted open of the board file');
    assert.ok(s.recorded() > 0, 'PRECONDITION: the recorder is live in this process');
    assert.equal(s.boardOpens(), 0, 'and the TEST\'s recorder saw no attempt on the board file (a caught-and-defaulted read would show here)');
  });
});

test('#1563 (D2) mode off, file ABSENT: after a read and two writes the file still does not exist, and neither instrument sees an open', TO, async () => {
  await world(async ({ w, rest }) => {
    const s = await rest({ mode: MODE.off, file: 'absent' });
    assert.equal((await s.call('GET', '/api/cards')).status, 200);
    assert.equal((await s.call('POST', '/api/cards', { title: 'a #1563 D2 card', createdBy: 'ada' })).status, 201, 'a card write is accepted');
    const p = await s.call('POST', '/api/conversations', { body: 'a #1563 D2 post', author: 'ada' });
    assert.equal(p.status, 201, 'a post write is accepted'); assert.equal(p.json?.postSeq, 3, 'and it continues from the graph\'s highest number (1 and 2 are taken; #1710)');
    assert.equal(fs.existsSync(w.boardFile), false, 'no board file was re-seeded');
    assert.equal(OPENS((await s.call('GET', '/api/health')).json), 0); assert.equal(s.boardOpens(), 0);
  });
});

test('#1563 (D3) mode off with one authoritative unit unset: REST refuses to start and names the unit', T, async () => {
  await world(async ({ rest }) => {
    let started = null, err = null;
    try { started = await rest({ mode: MODE.off, file: 'absent', env: { SCRUM_GRAPH_UNIT_LOGBORN: '' } }); } catch (e) { err = e; }
    if (started) await started.stop();
    assert.equal(started, null, 'REST must not start with an authoritative unit off in mode off');
    assert.match(String(err?.message), /logborn/i, `and its output names the missing unit (${String(err?.message).slice(-300)})`);
  });
});

test('#1563 (D4) mode off: /api/board/status lastUpdated comes from the store, a valid time no earlier than the last write, never null', TO, async () => {
  await world(async ({ rest }) => {
    const s = await rest({ mode: MODE.off, file: 'absent' });
    const t0 = Date.now();
    assert.equal((await s.call('POST', '/api/cards', { title: 'a #1563 D4 card', createdBy: 'ada' })).status, 201, 'PRECONDITION: a write');
    const st = (await s.call('GET', '/api/board/status')).json;
    assert.equal(typeof st?.lastUpdated, 'string', `lastUpdated is served, never null (got ${JSON.stringify(st?.lastUpdated)})`);
    const at = Date.parse(st.lastUpdated);
    assert.ok(Number.isFinite(at), `and it is a valid time (${st.lastUpdated})`);
    assert.ok(at >= t0 - 1000, `and no earlier than this row's own write (${st.lastUpdated} vs write at ${new Date(t0).toISOString()})`);
    assert.equal(s.boardOpens(), 0, 'and serving it opened no board file');
  });
});

test('#1563 (D5) roster: mode off, file absent: author and mention resolve as today, and an agent added at runtime becomes resolvable', TO, async () => {
  await world(async ({ rest }) => {
    const today = await rest();
    const a = (await today.call('POST', '/api/conversations', { body: 'hello @grace', author: 'ada' })).json; await today.stop();
    assert.ok(a?.mentions?.includes('grace'), `PRECONDITION: today a roster seat is resolved as a mention (${JSON.stringify(a)})`);
    const s = await rest({ mode: MODE.off, file: 'absent' });
    const b = (await s.call('POST', '/api/conversations', { body: 'hello @grace', author: 'ada' })).json;
    assert.equal(b?.author, 'ada', 'the author is kept'); assert.deepEqual(b?.mentions, a.mentions, 'and the mention resolves exactly as today');
    const ag = await s.call('POST', '/api/agents', { seatKey: 'zed1563', name: 'Zed', prompt: 'a fixture agent', model: { model: 'm', protocol: 'openai' }, by: 'ada' });
    assert.equal(ag.status, 201, `PRECONDITION: the agent is created (${ag.text.slice(0, 160)})`);
    const c = (await s.call('POST', '/api/conversations', { body: 'hello @zed1563', author: 'ada' })).json;
    assert.ok(c?.mentions?.includes('zed1563'), `an agent added at runtime is resolvable at once: the roster cache is not keyed on a file that is not there (${JSON.stringify(c)})`);
  });
});

test('#1563 (D6) mode off: the node APIs answer from the units, and a replica cold build is refused REPLICA_RETIRED, with no file open', TO, async () => {
  await world(async ({ rest }) => {
    const s = await rest({ mode: MODE.off, file: 'absent' });
    const made = await s.call('POST', '/api/cards', { title: 'a #1563 D6 card', createdBy: 'ada' });
    assert.equal(made.status, 201, 'PRECONDITION: a card made in this run');
    const list = await s.call('GET', '/api/nodes');
    assert.equal(list.status, 200, list.text.slice(0, 160));
    const ids = list.json.nodes.map((n) => String(n.identifier));
    for (const id of ['1', '2', '3', String(made.json.shortId)]) assert.ok(ids.includes(id), `GET /api/nodes lists card #${id} (have ${ids.join(',')})`);
    const one = await s.call('GET', `/api/nodes/${made.json.shortId}`);
    assert.equal(one.status, 200, one.text.slice(0, 160)); assert.equal((one.json.node ?? one.json).name, 'a #1563 D6 card', 'and the page names it');
    const cold = await s.call('POST', '/api/graph', { query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', source: 'replica' });
    assert.equal(cold.status, 503, `a replica cold build is refused in mode off (got ${cold.status}: ${cold.text.slice(0, 160)})`);
    assert.equal(cold.json?.code, REPLICA_RETIRED, 'by its code');
    assert.equal(OPENS((await s.call('GET', '/api/health')).json), 0); assert.equal(s.boardOpens(), 0, 'and no instrument saw a board-file open');
  });
});

test('#1563 (D7a) owner unavailable at boot: mode off with the executor unreachable, REST refuses to start, and the refusal is ABOUT the executor', TO, async () => {
  await world(async ({ rest }) => {
    let started = null, err = null;
    const dead = `http://127.0.0.1:${await freePort()}`;
    try { started = await rest({ mode: MODE.off, file: 'absent', executorUrl: dead }); } catch (e) { err = e; }
    if (started) await started.stop();
    assert.equal(started, null, 'REST must not start degraded when an owner cannot be read');
    // a refusal for ANOTHER reason (a missing owner, a unit off) would pass a bare "did not start": name the cause
    const msg = String(err?.message);
    assert.match(msg, /executor|ECONNREFUSED|could not be read|unreachable/i, `and it says the executor could not be read (${msg.slice(-300)})`);
    assert.doesNotMatch(msg, /without an owner/i, `not that a document-only field lacks an owner, which is a different refusal (${msg.slice(-300)})`);
  });
});

test('#1563 (D7b) owner unavailable at runtime: booted in mode off, then the executor stopped, an executor-owned read is a 503 with a code', TO, async () => {
  await world(async ({ w, rest }) => {
    const s = await rest({ mode: MODE.off, file: 'absent' });
    assert.equal((await s.call('GET', '/api/memories')).status, 200, 'PRECONDITION: the owner answers while the executor is up');
    await killExecutor(w.exec);
    const x = await s.call('GET', '/api/memories');
    assert.equal(x.status, 503, `with the executor gone, an executor-owned read is a 503, never [] (got ${x.status}: ${x.text.slice(0, 160)})`);
    assert.ok(typeof x.json?.code === 'string' && x.json.code.length > 0, 'and it says why, by code');
  });
});

test('#1563 (D8) read-off: reads open nothing; a write still updates the mirror; mode unset afterwards serves that write', TO, async () => {
  await world(async ({ w, rest }) => {
    const s = await rest({ mode: MODE.readOff, file: 'present' });
    for (const r of ['/api/cards', '/api/cards/1', '/api/board/status', '/api/conversations?limit=3']) assert.equal((await s.call('GET', r)).status, 200, r);
    assert.ok(s.recorded() > 0, 'PRECONDITION: the recorder is live');
    assert.equal(s.boardOpens(), 0, 'reads attempted no open of the board file');
    const before = fs.readFileSync(w.boardFile, 'utf8');
    const made = await s.call('POST', '/api/cards', { title: 'a #1563 D8 card', createdBy: 'ada' });
    assert.equal(made.status, 201);
    assert.notEqual(fs.readFileSync(w.boardFile, 'utf8'), before, 'the write still updated the mirror');
    await s.stop();
    const back = await rest({ mode: null, file: 'as-is', record: false });   // the file exactly as read-off left it (stop() keeps it)
    const x = await back.call('GET', `/api/cards/${made.json.shortId}`);
    assert.equal(x.status, 200); assert.equal(x.json?.title, 'a #1563 D8 card', 'mode unset serves the write: the rollback window is real');
  });
});
