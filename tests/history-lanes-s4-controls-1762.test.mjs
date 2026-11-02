/**
 * #1762 S4 — the lane CONTROLS that do not depend on the new wire: what a lane already guarantees and S4 must not break.
 *
 * ROW AUTHOR's controls, black-box over HTTP, written before S4 changes the lane code. The S4 design (v2) and the reviewer's review name these as
 * binding: "a /api/changes read never moves a lane", "a query high-water is never a lane ACK", and the explicit-ack rules (#1576). They are GREEN on main
 * by design: they are regression guards for the cursor rewrite, not a statement that S4 exists. The rows that DO depend on S4's wire (the L1 phases,
 * the g1 position per part, the cursors.json move, frontier validation on the lane path) wait for the interface contract: the position's field name and
 * grammar, the error shapes and the migration's crash seams are not readable from the code and must be pinned with the row author.
 *
 *   LC1  a /api/changes read, however it is asked, never moves a lane: its acked, served and lag are identical before and after
 *   LC2  a /api/changes high-water is not a lane ACK: a lane owed events below it is still owed every one of them
 *   LC3  a /api/changes cursor presented as the ack token is refused 400 ACK_TOKEN_INVALID and moves nothing
 *   LC4  no token, a malformed token and a token of the wrong kind are all 400 ACK_TOKEN_INVALID and move nothing
 *   LC5  another lane's ack token is 409 ACK_FOREIGN_LANE and moves nothing
 *   LC6  a lane that was never registered cannot ack: 404 LANE_NOT_REGISTERED
 *   LC7  a repeated ack is a 200 no-op (ALREADY_ACKED) and never moves the cursor backward
 *   LC8  an ack that never arrives leaves the page replayable: the same page is served again
 *   LC9  re-registering a known lane KEEPS its cursor
 *
 * Observation point: `POST /api/cursors/register` on a KNOWN lane returns its envelope without moving it, so the lane's {acked, served} are read through it
 * (not `lag` or `head_seq`: those follow the log's head, and a refused request is itself logged).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const owned = [];
after(async () => { for (const s of owned) await s.stop().catch(() => {}); });

async function world() {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  owned.push(srv);
  const call = async (method, route, body) => {
    const r = await fetch(`${srv.baseUrl}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  };
  const card = async (i) => assert.equal((await call('POST', '/api/cards', { title: `lane control ${i}`, description: 'x', createdBy: 'ada' })).status, 201, `PRECONDITION: card ${i} written`);
  const register = (name) => call('POST', '/api/cursors/register', { registrySeatId: name });
  const idOf = (name) => `registry:${name}`;
  await register('cutoff.probe');
  const pull = (name, limit) => call('GET', `/api/cursors/pull?identity=${encodeURIComponent(idOf(name))}${limit ? `&limit=${limit}` : ''}`);
  const ack = (name, token) => call('POST', '/api/cursors/ack', { identity: idOf(name), ...(token === undefined ? {} : { token }) });
  /** the lane's state, read without moving it */
  // acked and served only: `lag` and `head_seq` follow the log's head, and a REFUSED request is itself logged (#1217), so they move for reasons that are not the lane's
  const state = async (name) => { const e = (await register(name)).json.envelope; return { acked: e.last_acked_seq, served: e.last_served_seq }; };
  /** the cutoff the controls use: the first event's own recorded time. (`since=2000-01-01` is refused 400 whenever a card's createdAt lands a millisecond before the first log event, which made these controls flaky.) */
  const since = async () => { const r = await pull('cutoff.probe', 1); return encodeURIComponent(r.json.events[0].recorded_at); };   // the probe lane is registered BEFORE any event, so it is owed the first one (a lane registered later starts at the head)
  return { srv, call, card, register, pull, ack, state, idOf, since };
}
const seqsOf = (r) => r.json.events.map((e) => e.seq);

test('#1762 S4 LC1 CONTROL — a /api/changes read, however it is asked, never moves a lane', async () => {
  const w = await world();
  await w.register('lc1.lane');
  for (let i = 0; i < 5; i++) await w.card(i);
  const p = await w.pull('lc1.lane', 2);
  assert.equal(p.status, 200); assert.deepEqual(seqsOf(p), [1, 2], 'PRECONDITION: the page served two events');
  assert.equal((await w.ack('lc1.lane', p.json.ack_token)).status, 200, 'PRECONDITION: the lane acked them');
  const before = await w.state('lc1.lane');
  assert.deepEqual(before, { acked: 2, served: null }, 'PRECONDITION: the lane has acked 2 and has nothing served-but-unacked');
  const S0 = await w.since();
  const first = await w.call('GET', `/api/changes?since=${S0}&history=true&limitCards=2`);
  assert.equal(first.status, 200);
  for (const q of [`since=${S0}`, `since=${S0}&history=true`, `since=${S0}&history=true&limitCards=1`, `since=${encodeURIComponent(first.json.cursor)}`]) {
    const r = await w.call('GET', `/api/changes?${q}`);
    assert.equal(r.status, 200, `/api/changes?${q} answered (${r.status})`);
  }
  assert.deepEqual(await w.state('lc1.lane'), before, 'after five /api/changes reads the lane is exactly where it was: neither acked nor served moved');
});

test('#1762 S4 LC2 CONTROL — a /api/changes high-water is NOT a lane ACK: a lane owed events below it is still owed every one', async () => {
  const w = await world();
  await w.register('lc2.lane');
  for (let i = 0; i < 6; i++) await w.card(i);
  const head = (await w.call('GET', `/api/changes?since=${await w.since()}&history=true`)).json;
  assert.match(head.cursor, /^chg\d/, 'PRECONDITION: the query minted a high-water above everything the lane is owed');
  const after = await w.state('lc2.lane');
  assert.equal(after.acked, 0, 'the lane has acked nothing');
  const p = await w.pull('lc2.lane');
  assert.deepEqual(seqsOf(p), [1, 2, 3, 4, 5, 6], 'and is still served EVERY event it is owed, from the start: the query\'s high-water erased none of it');
});

test('#1762 S4 LC3 CONTROL — a /api/changes cursor presented as the ack token is refused and moves nothing', async () => {
  const w = await world();
  await w.register('lc3.lane');
  for (let i = 0; i < 3; i++) await w.card(i);
  assert.equal((await w.pull('lc3.lane')).status, 200);
  const chg = (await w.call('GET', `/api/changes?since=${await w.since()}`)).json.cursor;
  const before = await w.state('lc3.lane');
  const r = await w.ack('lc3.lane', chg);
  assert.equal(r.status, 400, `a query token is not an ack token (got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json.code, 'ACK_TOKEN_INVALID');
  assert.deepEqual(await w.state('lc3.lane'), before, 'and the lane did not move');
});

for (const [label, token] of [['no token', undefined], ['an empty token', ''], ['a malformed token', 'not-a-token'], ['a token of the wrong kind (valid base64url JSON, no lane)', Buffer.from(JSON.stringify({ log: 3 })).toString('base64url')]]) {
  test(`#1762 S4 LC4 CONTROL — ${label}: 400 ACK_TOKEN_INVALID and the lane does not move`, async () => {
    const w = await world();
    await w.register('lc4.lane');
    for (let i = 0; i < 3; i++) await w.card(i);
    assert.equal((await w.pull('lc4.lane')).status, 200);
    const before = await w.state('lc4.lane');
    const r = await w.ack('lc4.lane', token);
    assert.equal(r.status, 400, `(got ${r.status}: ${r.text.slice(0, 200)})`);
    assert.equal(r.json.code, 'ACK_TOKEN_INVALID');
    assert.deepEqual(await w.state('lc4.lane'), before, 'and nothing moved');
  });
}

test('#1762 S4 LC5 CONTROL — another lane\'s ack token is 409 ACK_FOREIGN_LANE and moves neither lane', async () => {
  const w = await world();
  await w.register('lc5.a'); await w.register('lc5.b');
  for (let i = 0; i < 3; i++) await w.card(i);
  const pa = await w.pull('lc5.a'); await w.pull('lc5.b');
  const beforeA = await w.state('lc5.a'), beforeB = await w.state('lc5.b');
  const r = await w.ack('lc5.b', pa.json.ack_token);
  assert.equal(r.status, 409, `lane A's token presented for lane B (got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json.code, 'ACK_FOREIGN_LANE');
  assert.deepEqual([await w.state('lc5.a'), await w.state('lc5.b')], [beforeA, beforeB], 'neither lane moved');
});

test('#1762 S4 LC6 CONTROL — a lane that was never registered cannot ack: 404 LANE_NOT_REGISTERED', async () => {
  const w = await world();
  await w.register('lc6.real');
  for (let i = 0; i < 2; i++) await w.card(i);
  await w.pull('lc6.real');
  // a token that NAMES the unregistered lane (so the lane-identity check passes and the missing registration is what is left)
  const token = Buffer.from(JSON.stringify({ v: 1, lane: w.idOf('lc6.never-registered'), log: 1, via: null, graph: null })).toString('base64url');
  const r = await w.ack('lc6.never-registered', token);
  assert.equal(r.status, 404, `(got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json.code, 'LANE_NOT_REGISTERED');
});

test('#1762 S4 LC7 CONTROL — a repeated ack is a 200 no-op and never moves the cursor backward', async () => {
  const w = await world();
  await w.register('lc7.lane');
  for (let i = 0; i < 4; i++) await w.card(i);
  const p1 = await w.pull('lc7.lane', 2);
  assert.equal((await w.ack('lc7.lane', p1.json.ack_token)).status, 200);
  const p2 = await w.pull('lc7.lane', 2);
  assert.deepEqual(seqsOf(p2), [3, 4]);
  assert.equal((await w.ack('lc7.lane', p2.json.ack_token)).status, 200);
  const at4 = await w.state('lc7.lane');
  const again = await w.ack('lc7.lane', p1.json.ack_token);              // the OLDER page's token, after a later page was acked
  assert.equal(again.status, 200, `an older token after a later ack is a no-op, not an error (got ${again.status}: ${again.text.slice(0, 200)})`);
  assert.equal(again.json.advanced, false, `and it reports that it advanced nothing (got ${again.text.slice(0, 200)})`);
  assert.deepEqual(await w.state('lc7.lane'), at4, 'and the cursor did not move backward');
});

test('#1762 S4 LC8 CONTROL — an ack that never arrives leaves the page replayable: the same page is served again', async () => {
  const w = await world();
  await w.register('lc8.lane');
  for (let i = 0; i < 3; i++) await w.card(i);
  const first = await w.pull('lc8.lane');
  const second = await w.pull('lc8.lane');
  assert.deepEqual(seqsOf(second), seqsOf(first), 'with no ack in between, the lane is owed the same events again');
  assert.equal((await w.state('lc8.lane')).acked, 0, 'and acked never moved');
});

test('#1762 S4 LC9 CONTROL — re-registering a KNOWN lane keeps its cursor', async () => {
  const w = await world();
  await w.register('lc9.lane');
  for (let i = 0; i < 3; i++) await w.card(i);
  const p = await w.pull('lc9.lane');
  assert.equal((await w.ack('lc9.lane', p.json.ack_token)).status, 200);
  const r1 = await w.register('lc9.lane'), r2 = await w.register('lc9.lane');
  assert.equal(r1.json.fresh, false, 'a known lane is not fresh');
  assert.deepEqual([r1.json.envelope.last_acked_seq, r2.json.envelope.last_acked_seq], [3, 3], 'and keeps the cursor it had');
});

test('#1762 S4 LC10 CONTROL — an ack that claims MORE than was served to the lane is 409 ACK_BEYOND_SERVED and moves nothing', async () => {
  const w = await world();
  await w.register('lc10.lane');
  for (let i = 0; i < 5; i++) await w.card(i);
  const p = await w.pull('lc10.lane', 2);
  assert.deepEqual(seqsOf(p), [1, 2], 'PRECONDITION: two events served');
  const before = await w.state('lc10.lane');
  assert.deepEqual(before, { acked: 0, served: 2 });
  const token = Buffer.from(JSON.stringify({ v: 1, lane: w.idOf('lc10.lane'), log: 5, via: null, graph: null })).toString('base64url');   // claims it received 5
  const r = await w.ack('lc10.lane', token);
  assert.equal(r.status, 409, `(got ${r.status}: ${r.text.slice(0, 200)})`);
  assert.equal(r.json.code, 'ACK_BEYOND_SERVED');
  assert.deepEqual(await w.state('lc10.lane'), before, 'the lane did not move: it may only ack what it was actually served');
});
