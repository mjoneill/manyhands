/**
 * #1200 — THE ROSTER IS A QUERY, NOT A BOOT-TIME READ.
 *
 * Done-when, verbatim: two boards up; on one, an agent invited from Settings
 * appears in the other client's roster without a restart; resting it releases
 * a held claim and the release is in the event log with `actor` set.
 *
 * Two REST servers share ONE board file. Server A invites; server B, booted
 * before the invite and never restarted, serves the seat. That is the only
 * shape that can fail on a boot-time read — one server always agrees with
 * itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { readEvents } from '../core/event-log.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const MODEL = { model: 'gemma3:12b', protocol: 'ollama-native' };

test('#1200 an agent invited on server A is in server B\'s roster and inlined page WITHOUT a restart; resting it drops it from both', async () => {
  const a = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const b = await startRestServer({ boardFile: a.boardFile });
  try {
    const before = await api(b.baseUrl, 'GET', '/api/roster');
    assert.equal(before.status, 200); assert.equal(before.body.seats.gizmo, undefined, 'control: not there before the invite');
    const c = await api(a.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', name: 'Gizmo', emoji: '🔧', prompt: 'p', model: MODEL, by: 'ada' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const after = await api(b.baseUrl, 'GET', '/api/roster');
    assert.equal(after.body.seats.gizmo?.name, 'Gizmo', `server B, never restarted, serves the invite: ${JSON.stringify(after.body.seats)}`);
    assert.equal(after.body.seats.gizmo.glyph, '🔧'); assert.equal(after.body.seats.gizmo.agent, true, 'a board-defined colleague is marked as one');
    assert.match(after.body.seats.gizmo.color, /^#[0-9a-f]{6}$/i, 'a seat with no declared colour still gets a stable one');
    assert.equal(after.body.usingDefaults, false, 'an agent-only roster is not "no roster configured"');
    // The page inlines the roster for first paint — that too must be live.
    const page = await (await fetch(`${b.baseUrl}/`)).text();
    const m = page.match(/globalThis\.__SCRUM_ROSTER__=(\{.*?\});<\/script>/s);
    assert.ok(m, 'the inlined roster is present'); assert.equal(JSON.parse(m[1]).gizmo?.name, 'Gizmo', 'the inlined roster on server B carries the invite');
    const rest = await api(a.baseUrl, 'PATCH', '/api/agents/gizmo', { state: 'resting', by: 'ada' });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const gone = await api(b.baseUrl, 'GET', '/api/roster');
    assert.equal(gone.body.seats.gizmo, undefined, 'resting removes the seat from the roster on the OTHER server');
    // A seat in the file wins a key collision — a human is never repainted by an agent.
  } finally { await b.stop(); await a.stop(); }
});

test('#1200 resting an agent RELEASES its held claims: each release is an event with actor set, and ONE commons post names the cards; an idle rest posts nothing', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'p', model: MODEL, by: 'ada' });
    assert.equal(c.status, 201);
    const ids = [];
    for (const t of ['one', 'two', 'three']) { const r = await api(srv.baseUrl, 'POST', '/api/cards', { title: t, by: 'ada' }); assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push(r.body); }
    for (const card of ids.slice(0, 2)) { const r = await api(srv.baseUrl, 'POST', `/api/cards/${card.id}/claim`, { by: 'gizmo' }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
    const other = await api(srv.baseUrl, 'POST', `/api/cards/${ids[2].id}/claim`, { by: 'ada' }); assert.equal(other.status, 200);
    const convsBefore = (await api(srv.baseUrl, 'GET', '/api/conversations?limit=50')).body;
    const nBefore = (Array.isArray(convsBefore) ? convsBefore : convsBefore.messages ?? convsBefore.conversations ?? []).length;
    const rest = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { state: 'resting', by: 'ada' });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(rest.body.released.sort(), [ids[0].shortId, ids[1].shortId].sort(), 'the response names what it released');
    const get = async (id) => (await api(srv.baseUrl, 'GET', `/api/cards/${id}`)).body;
    assert.equal((await get(ids[0].id)).claimedBy, null); assert.equal((await get(ids[1].id)).claimedBy, null);
    assert.equal((await get(ids[2].id)).claimedBy, 'ada', 'another seat\'s claim is untouched');
    const events = readEvents(srv.boardFile.replace(/\.json$/, '') + '-events');
    const releases = events.filter((e) => e.entity?.kind === 'card' && e.op === 'update' && [ids[0].id, ids[1].id].includes(e.entity.id) && e.state?.claimedBy === null);
    assert.equal(releases.length, 2, `two release events: ${JSON.stringify(releases.map((e) => e.entity.id))}`);
    for (const e of releases) assert.equal(e.actor, 'ada', 'the actor is who set the state, not the resting agent');
    const convs = (await api(srv.baseUrl, 'GET', '/api/conversations?limit=50')).body;
    const list = Array.isArray(convs) ? convs : convs.messages ?? convs.conversations ?? [];
    const posts = list.filter((m) => /is resting/.test(m.body) && /#1/.test(m.body) && /#2/.test(m.body));
    assert.equal(posts.length, 1, `ONE post names both cards: ${JSON.stringify(list.slice(-3).map((m) => m.body))}`);
    assert.equal(list.length - nBefore, 1, 'exactly one post for the rest, not one per card');
    // Idle rest: nothing held, nothing posted.
    await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { state: 'invited', by: 'ada' });
    const again = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { state: 'resting', by: 'ada' });
    assert.deepEqual(again.body.released, []);
    const list2 = (await api(srv.baseUrl, 'GET', '/api/conversations?limit=50')).body;
    assert.equal((Array.isArray(list2) ? list2 : list2.messages ?? list2.conversations ?? []).length, list.length, 'an idle rest posts nothing');
    // Prompt versions and the agent survive rest — only the loop stops.
    const agent = (await api(srv.baseUrl, 'GET', '/api/agents?seat=gizmo')).body[0];
    assert.equal(agent.state, 'resting'); assert.equal(agent.prompt.version, 1);
  } finally { await srv.stop(); }
});

test('#1200 the file roster wins a key collision, and the boot-time read is gone from the source', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^const ROSTER = configureIdentities/m, 'the boot-time constant');
  assert.match(src, /function currentRoster\(/);
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /async function pollRoster\(/); assert.match(html, /setInterval\(pollRoster/);
  // collision rule is in the merge order: file seats spread LAST
  assert.match(src, /\{ \.\.\.agentSeats\(board\), \.\.\.fileSeats \}/);
});
