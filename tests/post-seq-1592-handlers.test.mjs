/**
 * #1592 v6 ADDENDUM — REFUSAL PLACEMENT, handler by handler. The frozen v6 file (sha256 f917a7d3…47bd) controls two of the post-creating
 * mutations on a corrupt board (a claim and POST /api/conversations). It says nothing about the others, and a state check that sits in one
 * handler does not establish it sits in the next. Copy this file beside v6 in tests/; v6 is untouched.
 *
 * Every handler that appends a post is driven TWICE, on the same setup:
 *   HEALTHY  a clean board: the mutation succeeds AND exactly one more post exists afterwards (so a refusal below is a refusal of something
 *            that really would have posted, not of a no-op);
 *   CORRUPT  the same board after its post numbering is damaged (one post numbered, the rest not, no epoch: the mixed state): the mutation is
 *            500 POST_SEQ_STATE_CORRUPT, the file is BYTE-IDENTICAL, the post count is unchanged, and the thing the mutation would have
 *            changed (the claim, the card's column, the node's text, the obligation) is exactly as it was.
 *
 * Handlers: release · agent rest · agent retire · a card entering done (the done-nudge) · wiki node create · wiki node update ·
 * outbox /publish of a publisher-mode obligation. (Claim and POST /api/conversations: v6 Q12.)
 * Placement is judged by the file: a change that committed and THEN failed to announce leaves a different file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort, waitForHttp, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const T0 = '2026-10-04T12:00:00.000Z';
async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function spawnServer(file, barrierDir) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: file, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592h-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `ps1592h-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `ps1592h-${port}`, SCRUM_TEST_BARRIER_DIR: barrierDir };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}
const posts = async (base) => (await api(base, 'GET', '/api/conversations')).body;
const post = (base, body) => api(base, 'POST', '/api/conversations', { body, author: 'ada' });

/** Damage a STOPPED board's numbering, in whichever shape the file has now: mixed numbering, no epoch, no counter. */
function corrupt(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ld = Array.isArray(d['@graph']);
  const list = ld ? d['@graph'].filter((e) => e && e['@type'] === 'Comment') : d.conversations;
  assert.ok(list.length >= 2, 'the setup must leave at least two posts to damage');
  const meta = ld ? (d['scrum:meta'] ||= {}) : d;
  delete meta.postSeqEpoch; delete meta.nextPostSeq;
  for (const p of list) { if (ld) { if (p._extra) { delete p._extra.postSeq; if (!Object.keys(p._extra).length) delete p._extra; } } else delete p.postSeq; }
  if (ld) list[0]._extra = { ...(list[0]._extra || {}), postSeq: 1 }; else list[0].postSeq = 1;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
}

const PUBLISHER_OB = {
  announcementOutbox: {
    origins: { 'm-h': { mutationId: 'm-h', slots: ['claim'], origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', mode: 'publisher' } },
    entries: { 'm-h:claim': { obligationId: 'm-h:claim', mutationId: 'm-h', slot: 'claim', status: 'pending', mode: 'publisher',
      payload: { author: 'board', body: 'claimed m-h', mentions: [], notify: true, occurredAt: T0, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: 'm-h', slot: 'claim' } } },
  },
};
const newCard = async (base, extra = {}) => (await api(base, 'POST', '/api/cards', { title: 'a card', description: 'x', createdBy: 'ada', ...extra })).body;

/**
 * setup(base) -> ctx, run on a CLEAN board that already holds two posts; fire(base, ctx) -> response; untouched(base, ctx) -> a string that must
 * be the same before and after a REFUSED mutation (the state the mutation would have changed).
 */
const HANDLERS = [
  { name: 'release', fixture: {},
    setup: async (b) => { const c = await newCard(b); assert.equal((await api(b, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' })).status, 200); return { c }; },
    fire: (b, { c }) => api(b, 'DELETE', `/api/cards/${c.id}/claim`, { by: 'ada' }),
    state: async (b, { c }) => String((await api(b, 'GET', `/api/cards/${c.id}`)).body.claimedBy) },
  ...['resting', 'retired'].map((st) => ({ name: `agent ${st}`, fixture: {},
    setup: async (b) => {
      const mk = await api(b, 'POST', '/api/agents', { by: 'ada', seatKey: 'ada', prompt: 'p', model: { model: 'm', protocol: 'openai' } });
      assert.ok(mk.status < 300, `agent setup: ${mk.text}`);
      const c = await newCard(b); assert.equal((await api(b, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' })).status, 200); return { c };
    },
    fire: (b) => api(b, 'PATCH', '/api/agents/ada', { by: 'ada', state: st }),
    state: async (b, { c }) => String((await api(b, 'GET', `/api/cards/${c.id}`)).body.claimedBy) })),
  { name: 'a card entering done (the done-nudge)', fixture: {},
    setup: async (b) => ({ c: await newCard(b) }),
    fire: (b, { c }) => api(b, 'PATCH', `/api/cards/${c.id}`, { column: 'done', by: 'ada' }),
    state: async (b, { c }) => String((await api(b, 'GET', `/api/cards/${c.id}`)).body.column) },
  { name: 'wiki node create', fixture: {},
    setup: async () => ({}),
    fire: (b) => api(b, 'POST', '/api/nodes', { title: 'a page', body: 'text', createdBy: 'ada' }),
    state: async (b) => String(((await api(b, 'GET', '/api/nodes')).body?.nodes ?? (await api(b, 'GET', '/api/nodes')).body ?? []).length) },
  { name: 'wiki node update', fixture: {},
    setup: async (b) => { const mk = (await api(b, 'POST', '/api/nodes', { title: 'a page', body: 'text', createdBy: 'ada' })).body; const id = mk?.['@id'] ?? mk?.id; assert.ok(id, `node setup: ${JSON.stringify(mk)}`); return { id }; },
    fire: (b, { id }) => api(b, 'PATCH', `/api/nodes/${id}`, { body: 'changed text' }),
    state: async (b, { id }) => JSON.stringify((await api(b, 'GET', `/api/cards/${id}`)).body?.description ?? null) },   // a wiki node is a card; its body is the description
  { name: 'outbox /publish of a publisher-mode obligation', fixture: PUBLISHER_OB,
    setup: async () => ({}),
    fire: (b) => api(b, 'POST', `/api/outbox/${encodeURIComponent('m-h:claim')}/publish`, {}),
    state: async (b) => String((await api(b, 'GET', '/api/outbox')).body.entries.find((e) => e.obligationId === 'm-h:claim')?.status) },
];

async function scenario(h, damaged) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592h-'));
  const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(makeBoardFixture(h.fixture), null, 2));
  const barrierDir = path.join(dir, 'barriers'); fs.mkdirSync(barrierDir);
  let a, b; let ctx;
  try {
    a = await spawnServer(file, barrierDir);
    assert.equal((await post(a.base, 'seed one')).status, 201); assert.equal((await post(a.base, 'seed two')).status, 201);
    ctx = await h.setup(a.base);
    a.stop(); a = null;
    if (damaged) corrupt(file);
    b = await spawnServer(file, barrierDir);
    const bytes = fs.readFileSync(file);
    const n0 = (await posts(b.base)).length;
    const s0 = await h.state(b.base, ctx);
    const r = await h.fire(b.base, ctx);
    const n1 = (await posts(b.base)).length;
    return { r, bytes, bytesAfter: fs.readFileSync(file), n0, n1, s0, s1: await h.state(b.base, ctx), err: b.stderr() };
  } finally { a?.stop(); b?.stop(); }
}

for (const h of HANDLERS) {
  test(`H ${h.name}: HEALTHY it succeeds and posts exactly one notice; on a CORRUPT board it is 500 POST_SEQ_STATE_CORRUPT, file byte-identical, nothing changed, no post`, async () => {
    const ok = await scenario(h, false);
    assert.ok(ok.r.status < 300, `control (healthy board): ${ok.r.status} ${ok.r.text}\n${ok.err}`);
    assert.equal(ok.n1, ok.n0 + 1, 'control: the mutation really does append exactly one post, so refusing it below is meaningful');
    assert.notEqual(ok.s1, ok.s0, 'control: the mutation really does change its subject');
    const bad = await scenario(h, true);
    assert.equal(bad.r.status, 500, `corrupt board: ${bad.r.status} ${bad.r.text}`);
    assert.equal(bad.r.body?.code, 'POST_SEQ_STATE_CORRUPT');
    assert.deepEqual(bad.bytesAfter, bad.bytes, 'a refused mutation writes nothing: the change must not have committed before the announcement failed');
    assert.equal(bad.n1, bad.n0, 'no post was appended');
    assert.equal(bad.s1, bad.s0, 'and the thing the mutation would have changed is unchanged');
  });
}
