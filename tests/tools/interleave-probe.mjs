/**
 * #558 — the instrument behind the numbers in tests/api-write-lock.test.mjs.
 *
 * That test's header cites "500 overlapped rounds lost nothing" and "60/60 lost
 * with one injected yield". This is the probe that produced both, committed so
 * the numbers have a receipt instead of a memory of one.
 *
 *   node tests/tools/interleave-probe.mjs <serverDir> [rounds]
 *
 * It fires /api/save and /api/conversations concurrently, N times, against a
 * hermetic server + temp board, and counts writes that were accepted with 2xx
 * and then vanished from disk.
 *
 * ⚠️ Run it BOTH ways or don't believe either result:
 *
 *   node tests/tools/interleave-probe.mjs . 500                  →  ⚪ 0 lost
 *   node tests/tools/interleave-probe.mjs . 60 --inject-yield    →  🔴 60 lost
 *
 * Both are copy-paste runnable from a clean checkout — that is the point, and
 * @minimo had to say so: the first version documented a positive control whose
 * yielding tree no committed command could build. `--inject-yield` now creates
 * and cleans its own, using the same injector as the automated behavior test
 * (tools/yielding-tree.mjs), so the one-round test and the many-round probe
 * cannot drift apart.
 *
 * ⭐ The point of keeping the positive control attached: a null result from an
 *   unvalidated probe is indistinguishable from a probe that never overlapped
 *   the requests at all. The 0-of-500 means something ONLY because the same
 *   code goes red 60 of 60 when a yield exists.
 *
 * Not a test — nothing here asserts. It is a measuring device, and it is slow
 * (500 rounds ≈ 40s), so it stays out of the suite deliberately.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { makeYieldingTree } from './yielding-tree.mjs';

const argv = process.argv.slice(2);
const INJECT = argv.includes('--inject-yield');
const positional = argv.filter((a) => !a.startsWith('--'));
const TARGET_DIR = path.resolve(positional[0] || '.');
const ROUNDS = Number(positional[1] || 200);

// --inject-yield builds its own throwaway tree with ONE await inserted at the
// real read→write seam, so the positive control is a committed command rather
// than a scratchpad someone has to rebuild. Same injector the behavior test
// uses (tools/yielding-tree.mjs), so the two cannot drift apart.
const yielding = INJECT ? makeYieldingTree(TARGET_DIR) : null;
const serverDir = yielding ? yielding.dir : TARGET_DIR;
if (yielding) {
  console.log(`fault injection ON — one ${yielding.pauseMs}ms yield after handleSave's readBoard()`);
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const CARD = (title) => ({
  id: 'card-a', shortId: 1, title, column: 'backlog', order: 0,
  assignees: ['unassigned'], labels: [], relationships: { relatedTo: [], blockedBy: [] },
});
const COLUMNS = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

const port = await freePort();
const boardFile = path.join(os.tmpdir(), `probe-558-${Date.now()}.json`);
fs.writeFileSync(boardFile, JSON.stringify({
  cards: [CARD('original')], columns: COLUMNS, conversations: [], nextShortId: 2, lastUpdated: null,
}, null, 2));
const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-558-attach-'));

const proc = spawn('node', ['server.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    SCRUM_PORT: String(port),
    SCRUM_BOARD_FILE: boardFile,
    SCRUM_ATTACHMENTS_DIR: attachDir,
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `probe-558-cfg-${Date.now()}.json`),
    SCRUM_MCP_NOTIFY_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 8000;
for (;;) {
  try { await fetch(`${base}/api/board`); break; } catch { /* not up */ }
  if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('server never came up'); }
  await new Promise((r) => setTimeout(r, 50));
}

const post = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

let lostComments = 0, lostSaves = 0, both = 0, rejected = 0;
try {
  for (let i = 0; i < ROUNDS; i++) {
    const sentinel = `sentinel-${i}-${Math.random().toString(36).slice(2)}`;
    const title = `renamed-${i}`;
    const [s, c] = await Promise.all([
      post('/api/save', { cards: [CARD(title)], columns: COLUMNS, nextShortId: 2, lastUpdated: new Date().toISOString() }),
      post('/api/conversations', { author: 'probe', body: sentinel }),
    ]);
    if (!s.ok || !c.ok) { rejected++; continue; }
    const text = fs.readFileSync(boardFile, 'utf8');
    const cOk = text.includes(sentinel);
    const sOk = text.includes(title);
    if (!cOk) lostComments++;
    if (!sOk) lostSaves++;
    if (cOk && sOk) both++;
  }
} finally {
  proc.kill('SIGKILL');
  try { fs.unlinkSync(boardFile); } catch {}
  try { fs.rmSync(attachDir, { recursive: true, force: true }); } catch {}
}

if (yielding) yielding.cleanup();

console.log(JSON.stringify({ target: TARGET_DIR, injectedYield: INJECT, ROUNDS, both, lostComments, lostSaves, rejected }, null, 2));
console.log(lostComments || lostSaves ? '🔴 LOSS DETECTED' : '⚪ no loss');
