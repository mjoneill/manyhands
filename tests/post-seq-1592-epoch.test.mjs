/**
 * #1592 v6 ADDENDUM 2 — the two corrupt states the frozen v6 table does not contain, found by the independent mutation run on acfd8bf:
 * removing the "epoch must be a UUID" rule changed no result (mutant D2 survived). Pinned here, with its sibling (an epoch with NO counter).
 * Both were accepted as stricter-than-the-ruling and then confirmed in review ("an epoch without valid sequencing state must not count as
 * migrated"). Same refusal contract as v6 Q12: post creation and a claim 500 POST_SEQ_STATE_CORRUPT, a valid seq read the same, malformed
 * requests still 400, the file byte-identical, the script exit 3 (and --dry-run the same). Copy beside v6 in tests/; v6 is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { freePort, waitForHttp, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const MIGRATE = process.env.MIGRATE_POST_SEQ || path.join(PROJECT_DIR, 'scripts', 'migrate-post-seq-1592.mjs');
const T = (n) => `2026-10-0${n}T12:00:00.000Z`;
const conv = (id, body, createdAt, extra = {}) => ({ id, body, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt, ...extra });
async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function spawnServer(file) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: file, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592e-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `ps1592e-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `ps1592e-${port}` };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}
const GOOD_EPOCH = '11111111-2222-4333-8444-555555555555';
const three = () => [conv('c1', 'a', T(1), { postSeq: 1 }), conv('c2', 'b', T(2), { postSeq: 2 }), conv('c3', 'c', T(3), { postSeq: 3 })];
const BOARDS = [
  ['a postSeqEpoch that is not a UUID (every post numbered, the counter valid)', { postSeqEpoch: 'forged', nextPostSeq: 4 }],
  ['a postSeqEpoch that is the empty string', { postSeqEpoch: '', nextPostSeq: 4 }],
  ['a valid epoch and every post numbered, but NO counter at all', { postSeqEpoch: GOOD_EPOCH }],
  ['a valid epoch and every post numbered, but a counter that is not a number', { postSeqEpoch: GOOD_EPOCH, nextPostSeq: '4' }],
];
const fileFor = (extra) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1592e-')); const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture({ conversations: three(), ...extra }), null, 2));
  return file;
};
const migrate = (file, ...flags) => { const r = spawnSync(process.execPath, [MIGRATE, '--board-file', file, ...flags], { encoding: 'utf8', timeout: 30000, cwd: PROJECT_DIR }); return { code: r.status, out: r.stdout, err: r.stderr }; };

for (const [label, extra] of BOARDS) {
  test(`E ${label}: the whole mutation is 500 POST_SEQ_STATE_CORRUPT, valid seq reads too, file byte-identical, script exit 3`, async () => {
    const file = fileFor(extra);
    const original = fs.readFileSync(file);
    const r = migrate(file); assert.equal(r.code, 3, `script: ${r.out}${r.err}`);
    assert.equal(migrate(file, '--dry-run').code, 3, '--dry-run reports the same refusal');
    assert.deepEqual(fs.readFileSync(file), original, 'a refused migration writes nothing');
    let a;
    try {
      a = await spawnServer(file);
      const card = (await api(a.base, 'POST', '/api/cards', { title: 'claim me', description: 'x', createdBy: 'ada' })).body;
      assert.ok(card?.id, 'precondition: a card is not a post and still commits');
      const settled = fs.readFileSync(file);
      const create = await api(a.base, 'POST', '/api/conversations', { body: 'refused', author: 'ada' });
      assert.equal(create.status, 500, create.text); assert.equal(create.body.code, 'POST_SEQ_STATE_CORRUPT');
      const claim = await api(a.base, 'POST', `/api/cards/${card.id}/claim`, { by: 'ada' });
      assert.equal(claim.status, 500, claim.text); assert.equal(claim.body.code, 'POST_SEQ_STATE_CORRUPT');
      for (const qs of ['?afterSeq=start', '?tail=2']) { const g = await api(a.base, 'GET', `/api/conversations${qs}`); assert.equal(g.status, 500, `${qs}: ${g.text}`); assert.equal(g.body.code, 'POST_SEQ_STATE_CORRUPT'); }
      assert.equal((await api(a.base, 'GET', '/api/conversations?afterSeq=garbage')).status, 400, 'validation still comes first');
      assert.equal((await api(a.base, 'GET', '/api/conversations')).status, 200, 'a no-cursor read is served');
      assert.deepEqual(fs.readFileSync(file), settled, 'nothing was written by any refused request');
    } finally { a?.stop(); }
  });
}
