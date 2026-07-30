/**
 * #558 — write-lock coverage for board read-modify-write paths.
 *
 * ── WHY THIS FILE LOOKS ODD, AND WHY IT HAS TO ────────────────────────────
 * The card originally asked for a test that stages the reported four-step
 * interleave over HTTP and fails on pre-fix code:
 *
 *   1. /api/save reads the board          (no lock held)
 *   2. a comment append takes the mutex, reads, writes
 *   3. /api/save writes its stale snapshot
 *   4. the comment is gone
 *
 * That test cannot exist against the code as written, and the reason is not
 * subtle once measured: `handleSave`'s read-modify-write contains no `await`,
 * and `core/store.mjs` is `readFileSync`/`writeFileSync`/`renameSync`. A
 * synchronous section on a single-threaded event loop cannot be preempted, so
 * step 2 can never land between steps 1 and 3. Measured, not assumed: 500
 * rounds of maximally-overlapped save-vs-comment lost nothing. 0 of 13
 * read→write spans in server.js contain an await.
 *
 * ⇒ The defect is LATENT. What protects us today is synchrony, not the mutex,
 *   and that property was written down nowhere. The first `await` added to
 *   that stretch — or an async store, which #530 would produce — converts it
 *   to silent data loss. Injecting exactly one yield made the loss happen in
 *   60 of 60 rounds.
 *
 * So the behavior test below FAULT-INJECTS that single yield at the real
 * read→write seam and then runs the real choreography over real HTTP against
 * a real file. Everything except the one inserted line is production code:
 * the routes, the lock, the store, the merge, the response. The injected
 * pause is the future, made present and deterministic.
 *
 *   pre-fix  → the pause sits OUTSIDE the lock → the comment is clobbered → RED
 *   post-fix → the pause sits INSIDE  the lock → the append waits   → GREEN
 *
 * ⚠️ SCOPE. This covers in-process, request-reachable concurrency only.
 *    `withWriteLock` is an in-process mutex: it does nothing about a raw
 *    out-of-process edit of board-data.json (a `python3` one-liner, say).
 *    That race is real, has cost us a card before, and belongs to #106.
 *    Nothing here may be cited as system-wide single-writer safety.
 *
 * Point either test at another checkout with SCRUM_LOCK_TEST_SERVER_DIR to run
 * the same choreography against a baseline or a fix branch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(process.env.SCRUM_LOCK_TEST_SERVER_DIR || path.join(__dirname, '..'));
const SERVER_SRC = path.join(SERVER_DIR, 'server.js');

// ═══════════════════════════════════════════════════════════════════
// 1 · SECONDARY GUARD — every request-reachable writeBoard() is locked
// ═══════════════════════════════════════════════════════════════════

/**
 * The one legitimate exception, and the reason it is one.
 *
 * `migrateBoardIfNeeded()` is a read-modify-write outside the lock, and it is
 * safe for a reason that has nothing to do with migration being special: it
 * runs to completion before `server.listen()`, so no request can be in flight
 * and no competing writer can exist. If it is ever moved after `listen()`, or
 * made async, it needs the lock like everything else.
 *
 * Found by @indigo enumerating the sites instead of trusting the invariant she
 * had just written — which is the same move that produced this whole card.
 */
const PRE_LISTEN_EXCEPTIONS = ['migrateBoardIfNeeded'];

/**
 * Blank out comments and string bodies, preserving every offset and newline.
 *
 * Necessary, and found the hard way: the first version of this file matched
 * `migrateBoardIfNeeded(` against the raw source and counted @indigo's new
 * explanatory COMMENT as a second call — so the test failed on the tree with
 * the good comment and passed on the tree without it. A source matcher that
 * cannot tell code from prose grades documentation as behaviour.
 *
 * Strings are blanked too because server.js contains `http://127.0.0.1`, and a
 * `//` inside a string would otherwise swallow the rest of the line as a
 * comment. Length is preserved so line numbers and offsets stay meaningful.
 */
function codeOnly(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
    } else if (c === '/' && d === '*') {
      blank(i++); blank(i++);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++); blank(i++);
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++; // keep the opening quote so the token still parses as a string
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') blank(i++);
        if (i < src.length) blank(i++);
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Byte ranges of every `withWriteLock(...)` callback body, by brace matching. */
function lockedRanges(src) {
  const ranges = [];
  const re = /withWriteLock\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let started = false;
    for (let i = m.index; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth === 0) { ranges.push([m.index, i]); break; }
      }
    }
  }
  return ranges;
}

/** The nearest preceding `function name(` — whose body a given offset sits in. */
function enclosingFunction(src, offset) {
  const head = src.slice(0, offset);
  const matches = [...head.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)];
  return matches.length ? matches[matches.length - 1][1] : '(top level)';
}

test('#558 — every request-reachable writeBoard() runs inside withWriteLock', () => {
  const src = codeOnly(fs.readFileSync(SERVER_SRC, 'utf8'));
  const ranges = lockedRanges(src);

  // Call sites only — skip the `function writeBoard(data) {` declaration.
  const sites = [];
  const re = /writeBoard\(/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/^\s*function\s+writeBoard/.test(line)) continue;
    sites.push({
      offset: m.index,
      line: src.slice(0, m.index).split('\n').length,
      fn: enclosingFunction(src, m.index),
      locked: ranges.some(([a, b]) => m.index > a && m.index < b),
    });
  }

  // A coverage claim is only established by enumerating the set — so fail loudly
  // if the enumeration itself came back empty rather than passing vacuously.
  assert.ok(sites.length >= 12, `expected to find the writeBoard call sites, found ${sites.length}`);

  const unlocked = sites.filter((s) => !s.locked);
  const unexpected = unlocked.filter((s) => !PRE_LISTEN_EXCEPTIONS.includes(s.fn));

  assert.deepEqual(
    unexpected.map((s) => `${s.fn}() at server.js:${s.line}`),
    [],
    'these read-modify-write sites are reachable from a request and run OUTSIDE withWriteLock',
  );

  // And the exception must still be there — if the boot migration grew a lock,
  // or was renamed, this list is stale and should be re-derived, not trusted.
  assert.deepEqual(
    unlocked.map((s) => s.fn).sort(),
    [...PRE_LISTEN_EXCEPTIONS].sort(),
    'the set of unlocked writeBoard sites changed; re-derive PRE_LISTEN_EXCEPTIONS',
  );
});

/**
 * The exception above is only safe because of an ORDERING, so the ordering has
 * to be asserted rather than described.
 *
 * Caught by @minimo reviewing this file: as first written, the test named
 * `migrateBoardIfNeeded` as safe "because it runs before listen()" and then
 * checked no such thing. Move that call below `server.listen()` and the
 * exception set is unchanged, the test stays green, and an unlocked
 * read-modify-write becomes reachable while requests are in flight.
 *
 * ⇒ Which is this card's own defect, one level up: a safety claim asserted in
 *   prose next to a check that does not cover it. The comment at server.js:410
 *   cost us a wrong public conclusion for exactly this reason.
 */
test('#558 — the unlocked boot migration runs before listen(), which is why it is safe', () => {
  const raw = fs.readFileSync(SERVER_SRC, 'utf8');
  const src = codeOnly(raw);
  assert.equal(src.length, raw.length, 'codeOnly() must preserve offsets');
  assert.ok(src.includes('function handleSave'), 'codeOnly() blanked real code');

  for (const fn of PRE_LISTEN_EXCEPTIONS) {
    // Invocations, not the declaration: `migrateBoardIfNeeded();` at top level.
    const calls = [...src.matchAll(new RegExp(`(^|[^\\w.])${fn}\\s*\\(`, 'gm'))]
      .filter((m) => !/^\s*(async\s+)?function\s/.test(
        src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index)),
      ));

    assert.equal(
      calls.length, 1,
      `${fn} is called ${calls.length} times; the pre-listen safety argument covers exactly one boot-time call`,
    );

    const listen = src.search(/\.listen\s*\(/);
    assert.notEqual(listen, -1, 'could not find the server .listen() call');

    const callLine = src.slice(0, calls[0].index).split('\n').length;
    const listenLine = src.slice(0, listen).split('\n').length;

    assert.ok(
      calls[0].index < listen,
      `${fn}() is invoked at server.js:${callLine}, AFTER .listen() at server.js:${listenLine} — `
      + 'it is an unlocked read-modify-write and requests can now be in flight while it runs. '
      + 'Either move it back above listen() or give it the lock like every other write path.',
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2 · PRIMARY BEHAVIOR TEST — one injected yield at the real seam
// ═══════════════════════════════════════════════════════════════════

/** The line present in both baseline and fixed `handleSave`; the seam itself. */
const SEAM = 'const existing = readBoard();';
const PAUSE_MS = 400;

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A throwaway copy of SERVER_DIR whose only difference from production is one
 * `await` immediately after handleSave's `readBoard()`. Everything else — core/,
 * node_modules, the static pages — is symlinked, so the server under test is
 * the real server.
 */
function makeYieldingTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-558-yield-'));
  for (const entry of fs.readdirSync(SERVER_DIR)) {
    if (entry === 'server.js' || entry === '.git') continue;
    fs.symlinkSync(path.join(SERVER_DIR, entry), path.join(dir, entry));
  }
  const src = fs.readFileSync(SERVER_SRC, 'utf8');
  const at = src.indexOf(SEAM);
  assert.notEqual(at, -1, `could not find the read→write seam (${SEAM}) in ${SERVER_SRC}`);
  assert.equal(src.indexOf(SEAM, at + 1), -1, 'the seam anchor is not unique; the patch would be ambiguous');
  const cut = src.indexOf('\n', at) + 1;
  const patched = src.slice(0, cut)
    + `\n      // ── #558 FAULT INJECTION (test only): the one yield production\n`
    + `      // code does not have yet, and will the moment the store goes async.\n`
    + `      await new Promise((r) => setTimeout(r, ${PAUSE_MS}));\n\n`
    + src.slice(cut);
  fs.writeFileSync(path.join(dir, 'server.js'), patched);
  return dir;
}

async function startYieldingServer() {
  const dir = makeYieldingTree();
  const port = await freePort();
  const boardFile = path.join(dir, 'board-under-test.json');
  const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-558-attach-'));

  fs.writeFileSync(boardFile, JSON.stringify({
    cards: [card('original')],
    columns: COLUMNS,
    conversations: [],
    nextShortId: 2,
    lastUpdated: null,
  }, null, 2));

  const proc = spawn('node', ['server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      SCRUM_PORT: String(port),
      SCRUM_BOARD_FILE: boardFile,
      SCRUM_ATTACHMENTS_DIR: attachmentsDir,
      SCRUM_CHANNEL_CONFIG_FILE: path.join(dir, 'channel-config-under-test.json'),
      SCRUM_MCP_NOTIFY_URL: '', // never nudge the live channel from a test (#218)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    try { await fetch(`${baseUrl}/api/board`); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`server under test never came up\nstderr: ${stderr.join('')}`);
    }
    await sleep(50);
  }

  return {
    baseUrl,
    readBoardFile: () => fs.readFileSync(boardFile, 'utf8'),
    stop() {
      proc.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    },
  };
}

const COLUMNS = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

function card(title) {
  return {
    id: 'card-a', shortId: 1, title, column: 'backlog', order: 0,
    assignees: ['unassigned'], labels: [], relationships: { relatedTo: [], blockedBy: [] },
  };
}

const post = (baseUrl, route, body) => fetch(baseUrl + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('#558 — a comment appended during a paused /api/save is not clobbered', async () => {
  const srv = await startYieldingServer();
  try {
    const sentinel = 'sentinel-do-not-lose-me';

    // 1 · /api/save reads the board, then parks at the injected yield.
    const saving = post(srv.baseUrl, '/api/save', {
      cards: [card('renamed-by-save')],
      columns: COLUMNS,
      nextShortId: 2,
      lastUpdated: new Date().toISOString(),
    });

    // 2 · While it is parked, a comment append runs the full locked path.
    //     Pre-fix nothing holds the lock, so it reads, writes, and completes
    //     inside the window. Post-fix it queues behind the save.
    await sleep(PAUSE_MS / 2);
    const appended = await post(srv.baseUrl, '/api/conversations', {
      author: 'test-writer',
      body: sentinel,
    });

    // 3 · The save resumes and writes the snapshot it read at step 1.
    const saved = await saving;

    assert.equal(saved.status, 200, 'the save was accepted');
    assert.equal(appended.status, 201, 'the comment was accepted');

    // 4 · Both writes were accepted with 2xx, so both must be on disk.
    const disk = srv.readBoardFile();
    assert.ok(
      disk.includes(sentinel),
      'the comment was accepted with 201 and then silently discarded by the save '
      + '— the save wrote a board snapshot taken before the comment existed',
    );
    assert.ok(disk.includes('renamed-by-save'), "the save's own change survived");
  } finally {
    srv.stop();
  }
});
