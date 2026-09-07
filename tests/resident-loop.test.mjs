/**
 * #1226 — THE RESIDENT: woken twice, it refers to something it wrote the
 * first time without being handed it.
 *
 * "Without being handed it" = the mentioning human hands nothing and the
 * prompt author hands nothing. The loop READS the agent's own memory store by
 * owner (its seat) and hands back what the AGENT wrote. The adapter's
 * protocols have no tool channel, so the write is a trailing `REMEMBER:`
 * line in the reply, stripped from the post.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitDirectives, findWakes, buildMessages, guestOnce, shouldMarkAnswered } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resident-')), 'model-calls.jsonl');
const RESIDENT = { seatKey: 'gizmo', name: 'Gizmo', residency: 'resident', systemPrompt: 'Be brief.', toolGrants: ['card_claim'], model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' } };
const GUEST = { ...RESIDENT, residency: 'guest', toolGrants: [] };
// #1254 — these fixtures were written when publishing was IMPLICIT. The gate
// inverted that default, so a fixture that stands for "the model produced a
// reply" now has to say so with the marker, exactly as a real seat does. The
// prefix is added here rather than at 30 call sites, and skipped when the
// fixture's first line is already a directive or a deliberate non-reply — those
// cases are the subject of their own tests. The gate itself is tested in
// tests/explicit-post.test.mjs, never here.
const publishable = (t) => (!String(t ?? '').trim() || /^\s*(REPLY:|REMEMBER:|CLAIM:|NO_REPLY)/i.test(String(t))) ? t : `REPLY: ${t}`;
const ollamaOk = (text) => ({ status: 200, body: { message: { content: publishable(text) }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
/** A stub model that ANSWERS FROM ITS PROMPT: it echoes the memory it was handed, and remembers what it was told to. */
const echoingModel = (seen) => (agent, messages, opts) => callModel(agent, messages, { ...opts, transport: async (req) => {
  const user = req.body.messages.find((m) => m.role === 'user').content;
  seen.push(req.body.messages);
  const memLine = (user.match(/^- \[.*?\] (.+)$/m) || [])[1];
  const told = (user.match(/remember that (.+?)(\.|$)/i) || [])[1];
  const reply = memLine ? `You told me earlier: ${memLine}` : 'I have nothing from before.';
  return ollamaOk(told ? `${reply}\nREMEMBER: ${told}` : reply);
} });

test('#1226 splitDirectives: REMEMBER and CLAIM lines come OUT of the post; anything else stays, in order', () => {
  const r = splitDirectives('Sure, the sprint ends Friday.\nREMEMBER: sprint ends Friday\nCLAIM: #12\nMore text.\n remember: not a directive mid-sentence');
  assert.equal(r.post, 'Sure, the sprint ends Friday.\nMore text.\n remember: not a directive mid-sentence'.trim());
  assert.deepEqual(r.remember, ['sprint ends Friday']); assert.deepEqual(r.claims, [12]);
  assert.deepEqual(splitDirectives('plain'), { post: 'plain', remember: [], claims: [] });
});

test('#1226 wake sources are DATA: mention by default; assignment only for unclaimed cards assigned to the seat not yet seen; schedule by interval', () => {
  const messages = [{ id: 'm1', author: 'ada', body: '@gizmo hi', createdAt: '2026-09-06T10:00:00Z' }];
  const cards = [
    { id: 'c1', shortId: 1, title: 'mine', assignees: ['gizmo'], claimedBy: null },
    { id: 'c2', shortId: 2, title: 'held', assignees: ['gizmo'], claimedBy: 'ada' },
    { id: 'c3', shortId: 3, title: 'not mine', assignees: ['ada'], claimedBy: null },
    { id: 'c4', shortId: 4, title: 'seen', assignees: ['gizmo'], claimedBy: null },
  ];
  assert.deepEqual(findWakes({ agent: RESIDENT, messages, cards }).map((w) => w.kind), ['mention'], 'default: mention only, even with an assignment waiting');
  const all = { ...RESIDENT, wakeOn: ['mention', 'assignment', 'schedule'], everyMinutes: 30 };
  const w = findWakes({ agent: all, messages, cards, state: { assignmentsSeen: ['c4'], lastScheduledAt: '2026-09-06T09:00:00Z' }, now: '2026-09-06T10:00:00Z' });
  assert.deepEqual(w.map((x) => `${x.kind}:${x.shortId ?? x.id}`), ['mention:m1', 'assignment:1', 'schedule:schedule:2026-09-06T10:00:00Z']);
  const soon = findWakes({ agent: all, messages: [], cards: [], state: { lastScheduledAt: '2026-09-06T09:45:00Z' }, now: '2026-09-06T10:00:00Z' });
  assert.deepEqual(soon, [], 'inside the interval: no schedule wake');
});

test('#1226 the prompt: a resident is handed ITS OWN memory and the REMEMBER protocol; a guest gets neither; an unreadable memory is never called empty', () => {
  const wake = { kind: 'mention', id: 'm1', author: 'ada', body: '@gizmo hi', createdAt: 't' };
  const r = buildMessages({ agent: RESIDENT, wake, memories: [{ body: 'sprint ends Friday', updatedAt: 't0' }] });
  assert.match(r[0].content, /REMEMBER: <one line>/); assert.match(r[0].content, /CLAIM: #<number>/);
  // #1240 — the wording changed and the GUARANTEE grew: the store is still
  // introduced as this seat's own words, and is now also marked unverified,
  // because a line that reads as a board fact is how one wake's guess became
  // the whole room's premise.
  assert.match(r[1].content, /What YOU SAID on earlier wakes/); assert.match(r[1].content, /sprint ends Friday/);
  assert.match(r[1].content, /NOT facts about the board/);
  const g = buildMessages({ agent: GUEST, wake, memories: [{ body: 'sprint ends Friday' }] });
  assert.doesNotMatch(g[0].content, /REMEMBER/); assert.doesNotMatch(g[1].content, /sprint ends Friday/, 'a guest is handed no memory even if some exists');
  const empty = buildMessages({ agent: RESIDENT, wake, memories: [] });
  assert.match(empty[1].content, /written nothing on earlier wakes/);
  const sched = buildMessages({ agent: RESIDENT, wake: { kind: 'schedule', createdAt: 't' }, memories: [] });
  assert.match(sched[1].content, /scheduled wake/);
});

test('#1226 WOKEN TWICE: the second wake refers to what the FIRST wrote, read from the memory store by owner — the human handed nothing', async () => {
  const store = []; const posts = []; const seen = []; const file = tmp();
  const memories = async (owner) => store.filter((m) => m.owner === owner);
  const writeMemory = async (m) => { const row = { id: `mem-${store.length + 1}`, ...m, updatedAt: `t${store.length}` }; store.push(row); return row; };
  const post = async (b) => { posts.push(b); return { id: `p${posts.length}` }; };
  const wake1 = { kind: 'mention', id: 'm1', author: 'ada', body: '@gizmo please remember that the retro is on Tuesday.', createdAt: 't1' };
  const r1 = await guestOnce({ agent: RESIDENT, wake: wake1, callModel: echoingModel(seen), post, memories, writeMemory, ledgerFile: file });
  assert.equal(r1.posted, true); assert.deepEqual(r1.remember, ['the retro is on Tuesday']);
  assert.doesNotMatch(posts[0].body, /REMEMBER/, 'the directive is not in the post');
  assert.equal(store.length, 1); assert.equal(store[0].owner, 'gizmo'); assert.equal(store[0].body, 'the retro is on Tuesday');
  assert.deepEqual(r1.ledger.memoryWritten, ['mem-1']); assert.equal(r1.ledger.memory.handed, 0);
  // Second wake: a DIFFERENT human, who says nothing about Tuesday.
  const wake2 = { kind: 'mention', id: 'm2', author: 'bo', body: '@gizmo when is it?', createdAt: 't2' };
  const r2 = await guestOnce({ agent: RESIDENT, wake: wake2, callModel: echoingModel(seen), post, memories, writeMemory, ledgerFile: file });
  assert.equal(r2.posted, true);
  assert.match(posts[1].body, /the retro is on Tuesday/, `the second post refers to what the first wrote: ${posts[1].body}`);
  assert.equal(r2.ledger.memory.handed, 1, 'the row says one memory was handed');
  assert.doesNotMatch(seen[1].find((m) => m.role === 'user').content, /bo: .*Tuesday/, 'control: the second human did not say it');
  // A guest, same store: handed nothing, remembers nothing.
  const r3 = await guestOnce({ agent: GUEST, wake: wake2, callModel: echoingModel(seen), post, memories, writeMemory, ledgerFile: file });
  assert.doesNotMatch(posts[2].body, /Tuesday/); assert.equal(store.length, 1);
});

test('#1226 an unreadable memory store does not read as empty, and a memory write failure does not suppress the post; a claim needs the grant', async () => {
  const posts = []; const seen = []; const file = tmp(); const errors = [];
  const post = async (b) => { posts.push(b); return { id: 'p' }; };
  const wake = { kind: 'mention', id: 'm1', author: 'ada', body: '@gizmo please remember that x is y.', createdAt: 't1' };
  const r = await guestOnce({ agent: RESIDENT, wake, callModel: echoingModel(seen), post, memories: async () => { throw new Error('board blocking'); }, writeMemory: async () => { throw new Error('refused'); }, ledgerFile: file, onError: (l) => errors.push(l) });
  assert.equal(r.posted, true); assert.equal(r.ledger.memory.state, 'unreadable');
  assert.match(seen[0].find((m) => m.role === 'user').content, /could not be read this wake/);
  assert.doesNotMatch(seen[0].find((m) => m.role === 'user').content, /written nothing on earlier wakes/);
  assert.equal(r.ledger.memoryWritten[0].error, 'refused'); assert.ok(errors.some((l) => /memory write failed/.test(l)));
  // Claims: granted → sink called; not granted → refused on the row, sink NOT called.
  const claimed = [];
  const claimingModel = (a, m, o) => callModel(a, m, { ...o, transport: async () => ollamaOk('Taking it.\nCLAIM: #7') });
  const g = await guestOnce({ agent: RESIDENT, wake, callModel: claimingModel, post, memories: async () => [], claimCard: async (n, seat) => claimed.push([n, seat]), ledgerFile: file });
  assert.deepEqual(claimed, [[7, 'gizmo']]); assert.deepEqual(g.claims, [{ card: 7, ok: true }]);
  const ng = await guestOnce({ agent: { ...RESIDENT, toolGrants: [] }, wake, callModel: claimingModel, post, memories: async () => [], claimCard: async (n, seat) => claimed.push([n, seat]), ledgerFile: file });
  assert.equal(claimed.length, 1, 'no grant → the sink is never called'); assert.equal(ng.claims[0].ok, false); assert.match(ng.claims[0].reason, /grant/);
  // A memory-only reply (no post text) settles the wake.
  const memOnly = (a, m, o) => callModel(a, m, { ...o, transport: async () => ollamaOk('REMEMBER: keep this') });
  const mo = await guestOnce({ agent: RESIDENT, wake, callModel: memOnly, post, memories: async () => [], writeMemory: async (m) => ({ id: 'x' }), ledgerFile: file });
  assert.equal(mo.posted, false); assert.equal(mo.reason, 'memory-only'); assert.equal(shouldMarkAnswered(mo), true);
});

test('#1226 FRONT DOOR: on a real board the memory lands as a scrum:Memory owned by the seat, and the runner reads it back by owner; wakeOn/everyMinutes are fields of the agent node', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const c = await api('POST', '/api/agents', { seatKey: 'gizmo', prompt: 'p', model: { model: 'm', protocol: 'ollama-native' }, residency: 'resident', wakeOn: ['mention', 'schedule'], everyMinutes: 15, by: 'ada' });
    assert.equal(c.status, 201, JSON.stringify(c.body)); assert.deepEqual(c.body.wakeOn, ['mention', 'schedule']); assert.equal(c.body.everyMinutes, 15);
    const bad = await api('PATCH', '/api/agents/gizmo', { wakeOn: ['telepathy'], by: 'ada' }); assert.equal(bad.status, 400);
    const up = await api('PATCH', '/api/agents/gizmo', { residency: 'guest', by: 'ada' }); assert.equal(up.body.residency, 'guest');
    const w = await api('POST', '/api/memories', { title: 'the retro is on Tuesday', body: 'the retro is on Tuesday', owner: 'gizmo', by: 'gizmo', tags: ['agent-memory', 'gizmo'] });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const mine = await api('GET', '/api/memories?owner=gizmo');
    const list = Array.isArray(mine.body) ? mine.body : mine.body.memories;
    assert.equal(list.length, 1); assert.equal(list[0].body, 'the retro is on Tuesday');
    const g = await api('POST', '/api/graph', { query: 'SELECT ?w ?e ?o WHERE { ?a a scrum:Agent ; scrum:seatKey "gizmo" ; scrum:wakeOn ?w ; scrum:everyMinutes ?e . ?m a scrum:Memory ; scrum:owner ?o }' });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.deepEqual(g.body.rows.map((r) => r.w).sort(), ['mention', 'schedule']); assert.equal(g.body.rows[0].e, '15'); assert.match(String(g.body.rows[0].o), /gizmo$/);
    const src = fs.readFileSync(new URL('../scripts/guest-once.mjs', import.meta.url), 'utf8');
    assert.match(src, /\/api\/memories\?owner=/); assert.match(src, /agent-memory/); assert.match(src, /findWakes\(/);
  } finally { await srv.stop(); }
});
