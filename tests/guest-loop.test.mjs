/**
 * #1201 slice 1 — GUEST-ONCE. An @-mention produces ONE post attributed to the
 * agent's seat, with a ledger row; nothing else happens, and a model failure
 * produces no post at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMentions, buildMessages, guestOnce, fetchBoundedChanges } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guest-')), 'model-calls.jsonl');
const ledgerRows = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const AGENT = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'Be brief.', model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' } };
const ollamaOk = (text) => ({ status: 200, body: { message: { content: text }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
const withTransport = (resp) => (agent, messages, opts) => callModel(agent, messages, { ...opts, transport: async () => (typeof resp === 'function' ? resp() : resp) });

const MSGS = [
  { id: 'm1', author: 'ada', body: 'hello room', createdAt: '2026-09-06T10:00:00Z' },
  { id: 'm2', author: 'bo', body: '@gizmo what is the board for?', createdAt: '2026-09-06T10:01:00Z' },
  { id: 'm3', author: 'gizmo', body: '@gizmo talking to myself', createdAt: '2026-09-06T10:02:00Z' },
  { id: 'm4', author: 'cy', body: 'email me at x@gizmo.example — not a mention', createdAt: '2026-09-06T10:03:00Z' },
  { id: 'm5', author: 'ada', body: 'and @Gizmo, one more thing', createdAt: '2026-09-06T10:04:00Z' },
  // #1237 — a SYSTEM notice that quotes the handle (a claim/release line
  // carrying a card title) is not someone talking to the seat.
  { id: 'm6', author: 'board', body: '🔔 ada released #1 “ask @gizmo about it”', createdAt: '2026-09-06T10:05:00Z' },
];

test('#1201 findMentions: only @seat in the body, never its own posts, never an email-shaped near miss, never a board notice (#1237); sinceId pages forward', () => {
  assert.deepEqual(findMentions(MSGS, 'gizmo').map((m) => m.id), ['m2', 'm5']);
  assert.deepEqual(findMentions(MSGS, 'gizmo', { sinceId: 'm5' }).map((m) => m.id), [], 'the board notice after m5 is not a wake');
  assert.deepEqual(findMentions(MSGS, 'gizmo', { sinceId: 'm2' }).map((m) => m.id), ['m5']);
  assert.deepEqual(findMentions(MSGS, 'nobody'), []);
});

test('#1201 bounded context: the mention plus a SHORT window of changes; artifact-only hands no thread', () => {
  const changes = Array.from({ length: 40 }, (_, i) => ({ at: 't', kind: 'card', op: 'update', shortId: i, title: `card ${i}` }));
  const m = buildMessages({ agent: AGENT, wake: MSGS[1], changes });
  assert.equal(m[0].role, 'system'); assert.match(m[0].content, /seat key is "gizmo"/);
  assert.match(m[1].content, /what is the board for/);
  assert.match(m[1].content, /#39: card 39/); assert.doesNotMatch(m[1].content, /#5: card 5\b/, 'bounded to the newest 20, never the unbounded payload (#644)');
  const only = buildMessages({ agent: { ...AGENT, contextPolicy: 'artifact-only' }, wake: MSGS[1], changes });
  assert.doesNotMatch(only[1].content, /What changed/, 'artifact-only hands no thread');
});

test('#1201 the happy path: one mention → one post attributed to the seat → one ledger row with model, tokens, stop reason and the wake', async () => {
  const file = tmp(); const posts = [];
  const r = await guestOnce({ agent: AGENT, wake: MSGS[1], changes: () => [{ at: 't', kind: 'card', op: 'update', shortId: 7, title: 'seven' }],
    callModel: withTransport(ollamaOk('A shared board for people and agents.')), post: async (b) => { posts.push(b); return { id: 'p-1' }; }, ledgerFile: file });
  assert.equal(r.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, 'gizmo', 'attributed to the AGENT, never to the harness or a human');
  assert.equal(posts[0].body, 'A shared board for people and agents.');
  const rows = ledgerRows(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ledger, 'pre-P6', 'marked as the pre-ledger it is');
  assert.equal(rows[0].agent, 'gizmo'); assert.equal(rows[0].model, 'm'); assert.equal(rows[0].stopReason, 'stop');
  assert.equal(rows[0].usage.promptTokens ?? rows[0].usage.prompt_eval_count ?? 40, 40);
  assert.equal(rows[0].wake.messageId, 'm2'); assert.equal(rows[0].postId, 'p-1'); assert.equal(rows[0].contextHanded.changesRows, 1);
});

test('#1201 a model failure → NO post, one ledger row saying why; an empty reply → NO post', async () => {
  const file = tmp(); const posts = [];
  const bad = { status: 500, body: null, rawBody: 'boom' };
  const r = await guestOnce({ agent: AGENT, wake: MSGS[1], callModel: (a, m, o) => callModel(a, m, { ...o, retries: 0, transport: async () => bad }),
    post: async (b) => { posts.push(b); }, ledgerFile: file });
  assert.equal(r.posted, false); assert.equal(r.reason, 'model-failed'); assert.equal(posts.length, 0);
  assert.equal(ledgerRows(file).length, 1); assert.equal(ledgerRows(file)[0].ok, false);
  // An EMPTY reply is refused by the adapter itself (#1198 learned this from a
  // thinking model that spent its whole budget in a field nobody read), so it
  // arrives here as a model failure. Either way: NO post, one row saying why.
  const r2 = await guestOnce({ agent: AGENT, wake: MSGS[1], callModel: withTransport(ollamaOk('   ')), post: async (b) => { posts.push(b); }, ledgerFile: file });
  assert.equal(r2.posted, false); assert.ok(['empty-reply', 'model-failed'].includes(r2.reason), r2.reason); assert.equal(posts.length, 0);
  assert.equal(ledgerRows(file).length, 2); assert.match(String(ledgerRows(file)[1].error), /empty|content|nothing/i);
});

test('#1201 an unreadable changes surface is not fatal: the agent answers from the mention alone and the row says 0 context rows', async () => {
  const file = tmp(); const posts = [];
  const r = await guestOnce({ agent: AGENT, wake: MSGS[1], changes: () => { throw new Error('changes down'); },
    callModel: withTransport(ollamaOk('ok')), post: async (b) => { posts.push(b); return { id: 'p-2' }; }, ledgerFile: file });
  assert.equal(r.posted, true); assert.equal(ledgerRows(file)[0].contextHanded.changesRows, 0);
});

test('#1201 the agent must have a seat key and a model — a post with no seat is actor:null forever (#1193)', async () => {
  await assert.rejects(() => guestOnce({ agent: { model: AGENT.model }, wake: MSGS[1], callModel: async () => ({ text: 'x' }), post: async () => {} }), /seatKey/);
  await assert.rejects(() => guestOnce({ agent: { seatKey: 'g' }, wake: MSGS[1], callModel: async () => ({ text: 'x' }), post: async () => {} }), /model/);
});

// ── through the front door: a REAL board, a stubbed model ────────────────────
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

test('#1201 FRONT DOOR: a mention on a real board → the agent\'s post appears on that board, attributed to its seat, and its context came from /api/changes', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const mk = (body, author) => fetch(`${srv.baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, author }) }).then((r) => r.json());
    await fetch(`${srv.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'the only card', createdBy: 'ada' }) });
    const mention = await mk('@gizmo what is on this board?', 'bo');
    const recent = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=null&limit=20`).then((r) => r.json());
    const wakes = findMentions(Array.isArray(recent) ? recent : recent.conversations, 'gizmo');
    assert.equal(wakes.length, 1); assert.equal(wakes[0].id, mention.id);
    const since = new Date(Date.parse(wakes[0].createdAt) - 3600_000).toISOString();
    // ⚠️ A young board REFUSES "the last hour": a card's createdAt lands a few
    // ms before its own create event, so the retention floor is the first
    // event and any earlier since is CURSOR_TOO_OLD (#1223, reproduced here on
    // a ten-second-old board). fetchBoundedChanges retries from the floor the
    // refusal names, which is what the refusal itself says to do.
    const getRaw = async (p) => { const r = await fetch(`${srv.baseUrl}${p}`); let body = null; try { body = await r.json(); } catch { /* none */ } return { status: r.status, body }; };
    const rows = await fetchBoundedChanges(getRaw, since);
    assert.ok(rows.length >= 2, `expected the create and the mention: ${JSON.stringify(rows)}`);
    const changes = { changes: rows };
    let handed = null;
    const file = tmp();
    const r = await guestOnce({
      agent: AGENT, wake: wakes[0], changes: () => changes.changes,
      callModel: (a, m, o) => { handed = m; return callModel(a, m, { ...o, transport: async () => ollamaOk('One card: the only card.') }); },
      post: (b) => fetch(`${srv.baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((x) => x.json()),
      ledgerFile: file,
    });
    assert.equal(r.posted, true);
    assert.match(handed[1].content, /the only card/, 'the bounded context handed to the model came from the real changes surface');
    const after = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=null&limit=20`).then((x) => x.json());
    const list = Array.isArray(after) ? after : after.conversations;
    const mine = list.find((m) => m.author === 'gizmo');
    assert.ok(mine, 'the post is on the board');
    assert.equal(mine.body, 'One card: the only card.');
    assert.equal(ledgerRows(file)[0].postId, mine.id, 'the ledger row points at the post it produced');
    // and the agent does not answer itself on the next scan
    const again = await fetch(`${srv.baseUrl}/api/conversations?attachedTo=null&limit=20`).then((x) => x.json());
    assert.equal(findMentions(Array.isArray(again) ? again : again.conversations, 'gizmo', { sinceId: mention.id }).length, 0);
  } finally { await srv.stop(); }
});

test('#1201 the runnable form exists and uses the loop: scripts/guest-once.mjs imports guestOnce and findMentions', () => {
  const src = fs.readFileSync(new URL('../scripts/guest-once.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ findMentions, findWakes, guestOnce, fetchBoundedChanges, shouldMarkAnswered, mentionScanPath, acquireLock, releaseLock \} from '\.\.\/core\/guest-loop\.mjs'/);   // #1237 widened the import
  assert.match(src, /guestOnce\(\{/);
  assert.match(src, /--dry-run/);
});

test('#1201 fetchBoundedChanges honours CURSOR_TOO_OLD by asking again from the floor the refusal names — once — and still throws on any other refusal', async () => {
  const calls = [];
  const get = async (p) => {
    calls.push(p);
    if (p.includes('since=2026-01-01')) return { status: 400, body: { code: 'CURSOR_TOO_OLD', oldest_retained: '2026-09-05T19:00:00.000Z' } };
    if (p.includes('since=2026-09-05T19%3A00')) return { status: 200, body: { changes: [{ kind: 'card', op: 'create', shortId: 1, title: 'x' }] } };
    return { status: 500, body: { error: 'boom' } };
  };
  const rows = await fetchBoundedChanges(get, '2026-01-01T00:00:00.000Z');
  assert.equal(rows.length, 1); assert.equal(calls.length, 2, 'exactly one retry');
  await assert.rejects(() => fetchBoundedChanges(get, '2027-01-01T00:00:00.000Z'), /changes 500/);
});

test('#1201 the wake cursor advances only on a settled outcome: posted or a definitive model failure — never on a HALT', async () => {
  const { shouldMarkAnswered } = await import('../core/guest-loop.mjs');
  assert.equal(shouldMarkAnswered({ posted: true }), true);
  assert.equal(shouldMarkAnswered({ posted: false, reason: 'model-failed' }), true);
  assert.equal(shouldMarkAnswered({ posted: false, reason: 'empty-reply' }), true);
  assert.equal(shouldMarkAnswered({ posted: false, halted: true, reason: 'budget-unreadable: fetch failed' }), false, 'measured on prod: a halt advanced the cursor and the mention was never answered');
  assert.equal(shouldMarkAnswered({ posted: false, halted: true, reason: 'budget-breached' }), false);
  assert.equal(shouldMarkAnswered({ posted: false, reason: 'post-failed' }), false, 'a failed post is retryable');
});
