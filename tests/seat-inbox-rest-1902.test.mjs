/**
 * #1902 Half 1, slice 1 — EVERY SEAT'S INBOX, over REST, against a real scratch executor behind a counting proxy, observe
 * auth with real seat credentials (the shape production runs: conversations, deliveries and log-born units on).
 *
 * INTERFACE PINNED HERE:
 *   - rows: the reconciler offers each committed post to the seats it CONCERNS (core/seat-inbox.mjs), source `commit-feed`,
 *     from a cursor in <data dir>/seat-inbox-cursor.json. SCRUM_SEAT_INBOX=0 turns it off; SCRUM_SEAT_INBOX_TICK_MS paces it.
 *   - a delivery's wire gains `retrieved: { by, at }` once the seat's own credential has fetched its post (GET
 *     /api/conversations/:id), written after the answer. Never in `events`; never changes `state`.
 *   - latestFetched: one node per seat (latest-fetched/<seat>), the newest post its credential has fetched; written at most
 *     once per SCRUM_LATEST_FETCHED_MIN_MS (default 60 s) per seat, only upward.
 *   - GET /api/seats/attention → { at, observingSince, room: { latestSeq, latestAt }, seats: { <key>: { name, credential,
 *       unretrieved: { count, oldestOfferedAt, oldestAgeMs, means } , latestFetched: { seq, post, postAt, at, behindPosts,
 *       behindMs, means } | { observable: false, why }, lastPost, lastCredentialedRequest, runner? } }, means }
 *
 *   I1  a mention by key yields exactly one row for that seat, a mention by display name or alias the same; a post naming nobody none
 *   I2  a post committed while the reconciler was stopped gets its row after it restarts, once
 *   I3  the seat's own fetch marks its row once, after the answer; an anonymous fetch and another seat's fetch do not
 *   I4  a fetch never waits on the mark (the mark's write held 3 s, the GET answers at once); a fetch of a post with no row
 *       for that seat writes nothing
 *   I5  the runner path: claimed, turn-started, published apply to a marked row exactly as to an unmarked one; the mark is
 *       not a step and the state is the runner's
 *   I6  latestFetched moves on a newer fetch, never backwards, never on the board's own sending or an anonymous fetch, and
 *       is written at most once per interval per seat (the move inside the interval lands at its end)
 *   I7  the report: a seat with one unretrieved row shows count 1 and its age, latestFetched with the "maximum, not
 *       coverage" text and how far behind; a seat with no key and a seat with no credentialed reads are "not observable"
 *   I8  a redacted post leaves no content in its row, its steps, its mark or a latestFetched node
 *   L1  latency of a credentialed single-post GET (printed; compared by hand against the base commit)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const RS = 'https://scrumboard.local/ns#';
const DSID = 'si-rest-1902';
const MIN_MS = 1500;
// invented seats: ada and gizmo hold keys; kit and lee hold keys and are used by one row each; hal holds none
const KEYED = ['ada', 'gizmo', 'kit', 'lee', 'ash', 'pat'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'si-1902-'));
const DATA = path.join(TMP, 'data'); fs.mkdirSync(DATA);
const ROSTER = path.join(TMP, 'roster.json');
fs.writeFileSync(ROSTER, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmondo', glyph: 'g', color: '#c4a07c', aliases: ['Giz'] },
  kit: { name: 'Kit', glyph: 'k', color: '#a07cc4' }, lee: { name: 'Lee', glyph: 'l', color: '#7ca0c4' }, hal: { name: 'Hal', glyph: 'h', color: '#c47ca0' },
  // #1902 PO rows: a seat whose display name is a bare word, a seat whose key is a prefix of a common word, a human person
  nimbus: { name: 'Pippa', glyph: 'n', color: '#7cc4c4' }, ash: { name: 'Ash', glyph: 'w', color: '#c4c47c' }, pat: { name: 'Pat', glyph: 'p', color: '#c47c7c', kind: 'human' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' },
} }));
const TOK = Object.fromEntries(KEYED.map((s) => [s, mintToken()]));
const TOKENS = path.join(TMP, 'seat-tokens.json');
{
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(TOKENS, JSON.stringify({ seats: Object.fromEntries(KEYED.map((s) => [s, { credentials: [{ tokenHash: hashToken(TOK[s]), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }])) }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() < end, `${what} held within ${ms} ms`); await sleep(100); }
}

/** the executor proxy: counts /update bodies by what they write, and can hold the read mark's write */
function proxy(execUrl) {
  const st = { updates: [], holdRetrievedMs: 0, server: null, url: null };
  st.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const text = body.toString();
    if (req.method === 'POST' && req.url.startsWith('/update')) {
      st.updates.push({ at: Date.now(), retrieved: text.includes(`${RS}retrievedAt`), latest: text.includes(`${RS}latestFetchedSeq`) });
      if (st.holdRetrievedMs && text.includes(`${RS}retrievedAt`)) await sleep(st.holdRetrievedMs);
    }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body } : {}) });
      const t = await f.text();
      res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  return new Promise((r) => st.server.listen(0, '127.0.0.1', () => { st.url = `http://127.0.0.1:${st.server.address().port}`; r(st); }));
}

let exec, px, rest, gc, boardFile;
const EXEC_STORE = SKIP ? null : tmpStore('si-1902-store-');
const ENV = (extra = {}) => ({
  SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '', SCRUM_DATA_DIR: DATA,
  SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: px.url,
  SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1',
  SCRUM_SEAT_INBOX_TICK_MS: '300', SCRUM_LATEST_FETCHED_MIN_MS: String(MIN_MS), SCRUM_ATTENTION_MIN_MS: '0', ...extra,
});
async function boot(extra) {
  rest = await startRestServer({ ...(boardFile ? { boardFile } : { board: makeBoardFixture() }), env: ENV(extra) });
  boardFile = rest.boardFile;
}
before(async () => {
  if (SKIP) return;
  exec = await startExecutor({ store: EXEC_STORE, datasetId: DSID, create: true });
  px = await proxy(exec.baseUrl);
  gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'si-1902-test' });
  await boot();
});
after(async () => {
  if (rest) await rest.stop();
  if (px?.server) await new Promise((r) => { px.server.closeAllConnections?.(); px.server.close(() => r()); });
  if (exec) await killExecutor(exec);
  for (const d of [TMP, EXEC_STORE]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (method, route, payload, seat = null) => {
  const headers = { ...(seat ? { authorization: `Bearer ${TOK[seat]}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const t0 = performance.now();
  const r = await fetch(`${rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await r.text(); const ms = performance.now() - t0;
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json, ms };
};
const say = async (author, body) => { const r = await call('POST', '/api/conversations', { author, body }, author); assert.equal(r.status, 201, r.text); return r.json; };
const rowsFor = async (postId) => (await call('GET', `/api/deliveries?conversation=${encodeURIComponent(postId)}`)).json?.deliveries ?? [];
const rowOf = async (seat, postId) => (await rowsFor(postId)).find((d) => d.to === seat) ?? null;
const read = (postId, seat) => call('GET', `/api/conversations/${encodeURIComponent(postId)}`, null, seat);
/** A later post that concerns `seat`, waited on: once its row exists, the reconciler has passed every earlier post. */
async function barrier(seat = 'kit') { const p = await say('ada', `@${seat} barrier ${crypto.randomUUID()}`); await until(() => rowOf(seat, p.id), 20000, 'the barrier row'); return p; }
const latestNode = async (seat) => {
  const r = await gc.query(`SELECT ?seq ?post WHERE { <https://scrumboard.local/latest-fetched/${seat}> <${RS}latestFetchedSeq> ?seq ; <${RS}latestFetchedPost> ?post }`);
  assert.ok(r.ok, r.reason); return r.rows.length ? { seq: Number(r.rows[0].seq.value), post: r.rows[0].post.value.split('/').pop() } : null;
};

test('I1 a mention by key, by display name or by alias yields exactly one row for that seat; naming nobody yields none', T, async () => {
  const byKey = await say('ada', 'hello @gizmo, one for you');
  const byName = await say('ada', 'and @Gizmondo again');
  const byAlias = await say('ada', 'and @giz once more');
  const nobody = await say('ada', 'a note for the room, naming no one');
  for (const p of [byKey, byName, byAlias]) {
    const rows = await until(async () => { const r = await rowsFor(p.id); return r.length ? r : null; }, 20000, `a row for ${p.id}`);
    assert.deepEqual(rows.map((d) => d.to), ['gizmo'], `exactly one row, for gizmo (${p.body})`);
    assert.equal(rows[0].events[0].source, 'commit-feed');
  }
  await barrier();
  assert.deepEqual(await rowsFor(nobody.id), [], 'a post that names nobody concerns no seat');
  assert.deepEqual((await rowsFor(byKey.id)).filter((d) => d.to === 'ada'), [], 'the author is never offered her own post');
});

test('I2 a post committed while the reconciler was stopped gets its row after it restarts, once', T, async () => {
  rest.kill(); await boot({ SCRUM_SEAT_INBOX: '0' });
  const missed = await say('ada', '@gizmo this one lands while the reconciler is off');
  await sleep(1500);
  assert.deepEqual(await rowsFor(missed.id), [], 'PRECONDITION: no row while it is off');
  rest.kill(); await boot();
  const rows = await until(async () => { const r = await rowsFor(missed.id); return r.length ? r : null; }, 20000, 'the missed post\'s row');
  assert.deepEqual(rows.map((d) => d.to), ['gizmo']);
  await barrier(); await barrier();
  assert.equal((await rowsFor(missed.id)).length, 1, 'still exactly one row after more ticks');
});

test('I3 the seat\'s own fetch marks its row once, after the answer; an anonymous or another seat\'s fetch does not', T, async () => {
  const p = await say('ada', '@gizmo please look at this');
  await until(() => rowOf('gizmo', p.id), 20000, 'the row');
  assert.equal((await read(p.id, null)).status, 200);
  assert.equal((await read(p.id, 'kit')).status, 200);
  await sleep(1000);
  assert.equal((await rowOf('gizmo', p.id)).retrieved, undefined, 'an anonymous fetch and another seat\'s fetch mark nothing');
  const g = await read(p.id, 'gizmo');
  assert.equal(g.status, 200); assert.equal(g.json.retrieved, undefined, 'the answer itself carries nothing new');
  const row = await until(async () => { const d = await rowOf('gizmo', p.id); return d?.retrieved ? d : null; }, 20000, 'the mark');
  assert.equal(row.retrieved.by, 'gizmo');
  assert.ok(Date.parse(row.retrieved.at) > 0);
  const marks = px.updates.filter((u) => u.retrieved).length;
  await read(p.id, 'gizmo'); await sleep(800);
  assert.equal(px.updates.filter((u) => u.retrieved).length, marks, 'a second fetch writes no second mark');
  assert.deepEqual((await rowOf('gizmo', p.id)).retrieved, row.retrieved, 'the mark is unchanged');
});

test('I4 a fetch never waits on the mark; a fetch of a post with no row for that seat writes nothing', T, async () => {
  const p = await say('ada', '@gizmo a slow mark');
  await until(() => rowOf('gizmo', p.id), 20000, 'the row');
  px.holdRetrievedMs = 3000;
  try {
    const g = await read(p.id, 'gizmo');
    assert.equal(g.status, 200);
    assert.ok(g.ms < 1500, `the GET answered in ${g.ms.toFixed(0)} ms while its mark's write was held 3000 ms`);
    await until(async () => (await rowOf('gizmo', p.id))?.retrieved, 20000, 'the held mark, landing later');
  } finally { px.holdRetrievedMs = 0; }
  // a post for nobody, then a newer one gizmo reads (so the older read cannot move gizmo's latestFetched either)
  const none = await say('ada', 'nobody is named here');
  const newer = await say('ada', '@gizmo newer');
  await until(() => rowOf('gizmo', newer.id), 20000, 'the newer row');
  await read(newer.id, 'gizmo');
  await until(async () => (await latestNode('gizmo'))?.post === newer.id, 20000, 'gizmo\'s latestFetched at the newer post');
  await sleep(MIN_MS + 500);
  const n0 = px.updates.length;
  assert.equal((await read(none.id, 'gizmo')).status, 200);
  await sleep(MIN_MS + 1000);
  assert.equal(px.updates.length, n0, 'a fetch of a post with no row for that seat (and below its latestFetched) sends the executor no write');
});

test('I5 the runner path: claimed, turn-started, published apply to a marked row as to an unmarked one', T, async () => {
  const p = await say('ada', '@gizmo the runner\'s turn');
  const row = await until(() => rowOf('gizmo', p.id), 20000, 'the row');
  const step = async (state, extra = {}) => (await call('POST', '/api/deliveries/events', [{ id: row.id, by: 'gizmo', state, source: 'guest-runner', requestId: crypto.randomUUID(), ...extra }])).json.results[0];
  assert.equal((await step('runner-claimed')).status, 201);
  await read(p.id, 'gizmo');   // the runner reads the post with its seat's key, as guest-once does
  await until(async () => (await rowOf('gizmo', p.id))?.retrieved, 20000, 'the mark');
  assert.equal((await step('turn-started')).status, 201, 'turn-started follows claimed, mark or no mark');
  const out = await step('published');
  assert.equal(out.status, 201);
  const d = await rowOf('gizmo', p.id);
  assert.deepEqual(d.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'published'], 'the mark is not a step');
  assert.equal(d.state, 'published');
  assert.equal(d.retrieved.by, 'gizmo');
});

test('I6 latestFetched: up on a newer fetch, never back, never on the board\'s sending, at most once per interval', T, async () => {
  const a = await say('ada', '@lee first'); const b = await say('ada', '@lee second'); const c = await say('ada', '@lee third');
  await until(() => rowOf('lee', c.id), 20000, 'lee\'s rows');
  assert.equal(await latestNode('lee'), null, 'the board\'s sending (posts, rows) moves nothing');
  await read(c.id, null);
  await sleep(500);
  assert.equal(await latestNode('lee'), null, 'an anonymous fetch moves nothing');
  const w0 = px.updates.filter((u) => u.latest).length;
  await read(b.id, 'lee');
  await until(async () => (await latestNode('lee'))?.post === b.id, 20000, 'latestFetched at b');
  await read(c.id, 'lee');   // newer, inside the interval: held until it ends
  await sleep(300);
  assert.equal((await latestNode('lee')).post, b.id, 'not written again inside the interval');
  await until(async () => (await latestNode('lee'))?.post === c.id, 20000, 'the held move lands at the interval\'s end');
  const writes = px.updates.filter((u) => u.latest).slice(w0);
  assert.equal(writes.length, 2, 'two moves, two writes');
  assert.ok(writes[1].at - writes[0].at >= MIN_MS - 50, `the writes are ${writes[1].at - writes[0].at} ms apart (interval ${MIN_MS})`);
  await read(a.id, 'lee'); await sleep(MIN_MS + 800);
  assert.equal((await latestNode('lee')).post, c.id, 'an older fetch never moves it back');
  assert.equal(px.updates.filter((u) => u.latest).length, w0 + 2, 'and writes nothing');
});

test('I7 the report: one unretrieved row with its age, latestFetched with its meaning, and "not observable" where it cannot see', T, async () => {
  const other = await say('ada', 'something to read, naming no one');
  await read(other.id, 'kit');
  const ask = await say('ada', '@kit one ask that waits');
  await until(() => rowOf('kit', ask.id), 20000, 'kit\'s row');
  const forHal = await say('ada', '@hal hal holds no key');
  await until(() => rowOf('hal', forHal.id), 20000, 'hal\'s row');
  // kit's earlier barrier rows are unretrieved too: count them from the rows, and read every one but the ask
  const kitRows = (await call('GET', '/api/deliveries?to=kit&limit=1000')).json.deliveries;
  for (const d of kitRows) if (d.conversation !== ask.id && !d.retrieved) await read(d.conversation, 'kit');
  await until(async () => (await call('GET', '/api/deliveries?to=kit&limit=1000')).json.deliveries.filter((d) => !d.retrieved).length === 1, 20000, 'kit\'s other rows marked');
  const r = await until(async () => {
    const x = await call('GET', '/api/seats/attention');
    return x.status === 200 && x.json?.seats?.kit?.unretrieved?.count === 1 && x.json.seats.kit.latestFetched?.seq ? x : null;
  }, 20000, 'the report showing kit');
  const kit = r.json.seats.kit;
  assert.equal(kit.unretrieved.count, 1);
  assert.ok(kit.unretrieved.oldestAgeMs >= 0 && Number.isFinite(kit.unretrieved.oldestAgeMs));
  assert.match(kit.unretrieved.means, /ambiguous/);
  assert.match(kit.unretrieved.means, /hint may not have arrived/);
  assert.match(kit.unretrieved.means, /candidate concern, not proof an answer is owed/, 'a row is a post that names or concerns the seat, not an owed ask');
  assert.match(kit.unretrieved.means, /not an unanswered ask/);
  assert.match(r.json.means, /candidate concern, not proof an answer is owed/, 'the report says so at the top too');
  assert.match(kit.latestFetched.means, /maximum, not coverage/);
  assert.ok(Number.isInteger(r.json.room.latestSeq));
  assert.equal(kit.latestFetched.behindPosts, r.json.room.latestSeq - kit.latestFetched.seq);
  assert.ok(kit.latestFetched.behindPosts >= 1, 'the room moved on past what kit fetched');
  assert.equal(r.json.seats.hal.latestFetched.observable, false, 'a seat with no key: not observable');
  assert.match(r.json.seats.hal.latestFetched.why, /no key/);
  assert.equal(r.json.seats.hal.unretrieved.observable, false, 'with no key, "not retrieved" is not observable');
  assert.ok(r.json.seats.hal.unretrieved.count >= 1, 'its waiting rows are still counted');
  assert.equal(r.json.seats.lee.latestFetched.seq > 0, true);
  assert.equal(r.json.seats.ada.latestFetched.observable, false, 'a keyed seat with no credentialed single-post fetch: not observable, never zero');
  assert.equal(r.json.seats.board, undefined, 'a system seat is not reported');
  assert.equal(r.json.seats.ada.lastPost?.id != null, true, 'ada\'s last post');
  assert.ok(r.json.seats.kit.lastCredentialedRequest.at, 'kit made credentialed requests');
  assert.equal(r.json.seats.hal.lastCredentialedRequest.observable, false);
});

test('I8 a redacted post leaves no content in its row, its steps, its mark or a latestFetched node', T, async () => {
  const SECRET = `zebra-${crypto.randomUUID().slice(0, 8)}`;
  const p = await say('ada', `@gizmo the word is ${SECRET}`);
  const row = await until(() => rowOf('gizmo', p.id), 20000, 'the row');
  await sleep(MIN_MS + 200);
  await read(p.id, 'gizmo');
  await until(async () => (await rowOf('gizmo', p.id))?.retrieved && (await latestNode('gizmo'))?.post === p.id, 20000, 'mark and latestFetched');
  const red = await gc.update({ kind: 'post.redact', opId: `urn:ex:op/redact-${crypto.randomUUID()}`, actor: 'https://scrumboard.local/person/board', post: { id: p.id }, authorityRef: 'test:1902', occurredAt: new Date().toISOString() });
  assert.equal(red.outcome, 'APPLIED', JSON.stringify(red));
  const triples = await gc.query(`SELECT ?s ?p ?o WHERE { { BIND(<${row.id}> AS ?s) <${row.id}> ?p ?o } UNION { ?s <${RS}stepOf> <${row.id}> ; ?p ?o } UNION { BIND(<https://scrumboard.local/latest-fetched/gizmo> AS ?s) ?s ?p ?o } }`);
  assert.ok(triples.ok && triples.rows.length > 5, 'PRECONDITION: the row, its steps and the node were read');
  assert.equal(JSON.stringify(triples.rows).includes(SECRET), false, 'no triple of the row, its steps, its mark or the node carries the text');
  assert.equal(JSON.stringify(await rowOf('gizmo', p.id)).includes(SECRET), false);
  assert.equal((await call('GET', '/api/seats/attention')).text.includes(SECRET), false);
});

test('I9 PO rule: a bare name makes a row; ashtray is not ash; two seats one each; never the author; never a human person', T, async () => {
  const pippa = await say('ada', 'Pippa, can you look');
  const ashtray = await say('ada', 'pass me the ashtray');
  const two = await say('ada', 'Pippa and ash, both of you');
  const self = await say('ash', 'ash here, as ash');
  const human = await say('ada', 'Pat, can you look');
  await barrier();
  assert.deepEqual((await rowsFor(pippa.id)).map((d) => d.to), ['nimbus'], 'one row for the seat named Pippa');
  assert.deepEqual(await rowsFor(ashtray.id), [], 'ashtray is not ash');
  assert.deepEqual((await rowsFor(two.id)).map((d) => d.to).sort(), ['ash', 'nimbus'], 'one row each');
  assert.deepEqual(await rowsFor(self.id), [], 'a seat naming herself gets no row');
  assert.deepEqual(await rowsFor(human.id), [], 'a seat the roster marks kind: human gets no row');
});

test('L1 latency of a credentialed single-post GET (printed)', T, async () => {
  const p = await say('ada', '@gizmo latency');
  await until(() => rowOf('gizmo', p.id), 20000, 'the row');
  const ms = [];
  for (let i = 0; i < 30; i++) ms.push((await read(p.id, 'gizmo')).ms);
  ms.sort((x, y) => x - y);
  console.log(`# L1 credentialed GET /api/conversations/:id over 30: p50 ${ms[15].toFixed(1)} ms, p90 ${ms[27].toFixed(1)} ms, max ${ms[29].toFixed(1)} ms`);
  assert.ok(ms[15] < 1000);
});
