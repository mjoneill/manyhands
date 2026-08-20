/**
 * Test harness for server-side tests (#105).
 *
 * Spawns server.js and mcp-server.mjs as isolated child processes on free
 * ports, each pointed at a throwaway board-data file. Because each test run
 * gets its own ports + data file, these tests do NOT touch the live :3141 /
 * :3001 servers or the real board-data.json — no need to stop them first.
 * (#619 — the old note here said the BROWSER suite still needs the live server
 * stopped. That is stale and it cost real work: a seat declined to run 299
 * passing tests and shipped "verified by reasoning, not by test" instead.
 * run-tests.js loads index.html over `file://` with no server at all, and
 * Chromium refuses fetch in that sandbox, so the race it warned about cannot
 * occur. Read run-tests.js before believing otherwise.)
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.resolve(__dirname, '..', '..');

/** Ask the OS for a free TCP port on the loopback interface. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll an HTTP URL until it responds (any status) or the timeout elapses. */
export async function waitForHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    // ⚠️ The signal is what makes `timeoutMs` mean anything. The loop condition
    // is only evaluated BETWEEN attempts, so an unbounded `await fetch(url)`
    // against a peer that accepts the connection and never answers sits inside
    // this try for undici's full header timeout — measured at 301.0s on
    // node v22.23.1, against a stated bound of 8s. Bounding each attempt by the
    // time actually left is the difference between a timeout and a comment.
    // (A REFUSED connection was always fast and loud; only connect-and-hang
    // defeated the old shape, which is why it never showed up as a failure.)
    const remaining = Math.max(1, deadline - Date.now());
    try {
      await fetch(url, { signal: AbortSignal.timeout(remaining) });
      return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message ?? 'unknown'}`);
}

/** A minimal but valid board document. Override any field via `overrides`. */
export function makeBoardFixture(overrides = {}) {
  return {
    cards: [],
    columns: [
      { id: 'backlog', name: 'Backlog', order: 0 },
      { id: 'planned', name: 'Planned', order: 1 },
      { id: 'in-progress', name: 'In Progress', order: 2 },
      { id: 'done', name: 'Done', order: 3 },
    ],
    conversations: [],
    nextShortId: 1,
    lastUpdated: null,
    ...overrides,
  };
}

/**
 * Start an isolated REST server (server.js) on a free port with a temp board
 * file. Returns { baseUrl, boardFile, readBoardFile, stop }.
 */
export async function startRestServer({ board, staticDir, port, mcpNotifyUrl = '', env: extraEnv } = {}) {
  port = port ?? (await freePort());
  const boardFile = path.join(
    os.tmpdir(),
    `scrum-test-board-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(boardFile, JSON.stringify(board ?? makeBoardFixture(), null, 2));

  // Isolated attachments dir so #113 uploads in tests never touch the real attachments/.
  const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-test-attach-'));

  // Isolated channel-config file (#263) so config-API tests never touch the real one.
  const configFile = path.join(
    os.tmpdir(),
    `scrum-test-chan-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  // extraEnv first, then the isolation vars LAST so a test can never accidentally
  // override the throwaway board file / attachments dir and pollute real state.
  const env = {
    ...process.env,
    ...(extraEnv || {}),
    SCRUM_PORT: String(port),
    SCRUM_BOARD_FILE: boardFile,
    SCRUM_ATTACHMENTS_DIR: attachmentsDir,
    SCRUM_CHANNEL_CONFIG_FILE: configFile,
  };
  if (staticDir) env.SCRUM_STATIC_DIR = staticDir;
  // #218 — notify is OFF by default (''  disables it in server.js), set LAST so it
  // overrides any inherited SCRUM_MCP_NOTIFY_URL. A test run can therefore never
  // leak nudges to the live MCP/channel (the #203 footgun). Opt in by passing
  // mcpNotifyUrl explicitly (channel.test.mjs does, to test the notify path).
  env.SCRUM_MCP_NOTIFY_URL = mcpNotifyUrl;

  const proc = spawn('node', ['server.js'], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${baseUrl}/api/board`);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`REST server failed to start: ${e.message}\nstderr: ${stderr.join('')}`);
  }

  return {
    baseUrl,
    boardFile,
    attachmentsDir,
    configFile,
    /** Read the temp board file straight off disk (bypasses the API). */
    readBoardFile: () => JSON.parse(fs.readFileSync(boardFile, 'utf8')),
    /** #657 — the card-query miss log is part of the wire contract; tests
     * assert on it here rather than parsing raw process pipes themselves. */
    stderr: () => stderr.join(''),
    async waitForStderr(re, timeoutMs = 3000) {
      const t0 = Date.now();
      while (!re.test(stderr.join(''))) {
        if (Date.now() - t0 > timeoutMs) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return re.test(stderr.join(''));
    },
    async stop() {
      proc.kill('SIGKILL');
      try {
        fs.unlinkSync(boardFile);
      } catch {
        /* already gone */
      }
      try {
        fs.rmSync(attachmentsDir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(configFile);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Start an isolated MCP server (mcp-server.mjs) on a free port.
 * Pass `restApiBase` to point it at a REST server started above.
 * Returns { mcpUrl, healthUrl, stop }.
 */
export async function startMcpServer({ restApiBase, port, env: extraEnv } = {}) {
  port = port ?? (await freePort());
  const proc = spawn('node', ['mcp-server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      SCRUM_CHANNEL_STAGGER: 'off', // #256/#265 — keep channel tests instant; scheduling logic is unit-tested in channel-scheduler.test.mjs
      ...(restApiBase ? { SCRUM_BOARD_API: restApiBase } : {}),
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));
  // #359 — capture stdout too: response-leg observability is a logged behavior,
  // so tests need to assert on the server's own log lines.
  const stdout = [];
  proc.stdout.on('data', (d) => stdout.push(d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${baseUrl}/health`);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`MCP server failed to start: ${e.message}\nstderr: ${stderr.join('')}`);
  }

  // #787 — exit bookkeeping. `stop()` below SIGKILLs, which is why no test ever
  // exercised the SIGTERM path and why a shutdown that could never complete
  // survived in production unnoticed: the suite skipped the signal that hangs.
  let exited = null;                       // { code, signal } once it ends
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  return {
    mcpUrl: `${baseUrl}/mcp`,
    healthUrl: `${baseUrl}/health`,
    baseUrl,
    pid: proc.pid,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
    /** #787 — send a real signal. SIGTERM is the one production actually uses. */
    signal(sig) { try { proc.kill(sig); } catch { /* already gone */ } },
    /**
     * #787 — resolve when the process exits, or null at the deadline.
     * Returning null rather than throwing keeps "it hung" a VALUE a test can
     * assert on, instead of an error that reads like a broken test.
     */
    waitExit(ms = 8000) {
      const started = Date.now();
      return new Promise((resolve) => {
        if (exited) return resolve({ ...exited, ms: 0 });
        const timer = setTimeout(() => resolve(null), ms);
        proc.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, ms: Date.now() - started });
        });
      });
    },
    async stop() {
      proc.kill('SIGKILL');
    },
  };
}

/** Extract the first JSON-RPC message from a Streamable-HTTP response body. */
export function parseMcpResponse(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) {
      return JSON.parse(trimmed.slice(5).trim());
    }
  }
  return JSON.parse(text); // plain JSON fallback
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/**
 * Run the MCP initialize handshake and return a session handle with
 * { sessionId, callTool(name, args), listTools(), raw(payload) }.
 */
export async function mcpSession(mcpUrl, { headers: extraHeaders = {} } = {}) {
  const initRes = await fetch(mcpUrl, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'scrum-test-harness', version: '1.0.0' },
      },
    }),
  });
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error(`initialize returned no mcp-session-id (status ${initRes.status})`);
  }

  // The `instructions` string is one of the surfaces an AGENT actually reads —
  // it carries the seat list and the shift protocol. It used to be discarded
  // here, which made it the one agent-visible surface no test could see.
  let instructions = '';
  try {
    instructions = parseMcpResponse(await initRes.text())?.result?.instructions || '';
  } catch { /* a server that sends none is a valid server */ }

  const withSession = { ...MCP_HEADERS, ...extraHeaders, 'mcp-session-id': sessionId };

  await fetch(mcpUrl, {
    method: 'POST',
    headers: withSession,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  let nextId = 2;
  const rpc = async (method, params) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: withSession,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    return parseMcpResponse(await res.text());
  };

  return {
    sessionId,
    instructions,
    callTool: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    listTools: () => rpc('tools/list', {}),
    rpc,
  };
}

/**
 * Start a cross-wired REST + MCP pair (#119 channel notifier). Ports are
 * pre-allocated so each side can be told the other's address at spawn:
 * the REST server gets the MCP server's /internal/notify URL (so a commons
 * post fires a channel notification); the MCP server is pointed at the REST
 * server. Returns { rest, mcp, stop }.
 */
/**
 * #730 — ACQUIRE BOTH, OR LEAVE NOTHING RUNNING.
 *
 * The old shape started REST, then awaited MCP with no deadline and no
 * try/finally. A `startMcpServer` that threw or hung abandoned the REST server
 * already running — and an abandoned child is not merely untidy: the parent
 * holds its stdout/stderr (`stdio: ['ignore','pipe','pipe']`, needed for
 * `stderr()` / `waitForStderr()`), and an open child-stdio stream is an ACTIVE
 * HANDLE that keeps the test process's event loop alive with nothing left to do.
 *
 * Measured on a live 31-hour specimen (pgid 1337, forensics on #730):
 *   3403 fd 15u unix …310 -> …643   the test file process
 *   3527 fd  1u unix …643 -> …310   its abandoned server's STDOUT
 *   ⇒ same socket pair. No IPv4 sockets on 3403 at all — not awaiting a read.
 *
 * ⚠️ That specimen is CONSISTENT WITH a failed second acquisition; it does not
 * prove that history (MCP may have started and exited later). The cleanup hole
 * below is provable on its own, and that is what the tests pin.
 *
 * ⛔ A plain try/finally is NOT enough, for the same reason #736 gives on the
 * browser path: `finally` waits for the promise to SETTLE, and a hang never
 * settles. So the acquisition is raced against a deadline, and the teardown
 * runs on the timeout path too — a bare `Promise.race` turns a hang into a
 * failure while KEEPING the orphan, which is the defect wearing the fix's
 * clothes.
 *
 * `_startRest` / `_startMcp` are injection seams so the failure and hang paths
 * are testable without waiting for a real wedge.
 */
export async function startPair({
  board,
  mcpEnv,
  acquireTimeoutMs = 60_000,
  _startRest = startRestServer,
  _startMcp = startMcpServer,
} = {}) {
  const restPort = await freePort();
  const mcpPort = await freePort();
  const mcpNotifyUrl = `http://127.0.0.1:${mcpPort}/internal/notify`;

  const withDeadline = async (p, ms, label) => {
    let timer;
    try {
      return await Promise.race([
        p,
        // NOT unref'd: an unref'd deadline does not hold the event loop, so
        // when the awaited operation is the only thing running the process can
        // settle before the timer fires and the bound silently does not apply.
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const rest = await withDeadline(
    _startRest({ board, port: restPort, mcpNotifyUrl }), acquireTimeoutMs, 'REST acquisition',
  );

  let mcp;
  try {
    // #726 — let a caller tune MCP env (e.g. MCP_DEAF_GRACE_MS) so a test can
    // exercise a time-based threshold without sleeping the real interval.
    mcp = await withDeadline(
      _startMcp({ port: mcpPort, restApiBase: rest.baseUrl, env: mcpEnv }),
      acquireTimeoutMs, 'MCP acquisition',
    );
  } catch (e) {
    // The sibling is already running. Stop it before surfacing the failure,
    // and never let a teardown error mask the acquisition error that caused it.
    try { await rest.stop(); } catch { /* the original failure is the one that matters */ }
    throw e;
  }

  return {
    rest,
    mcp,
    async stop() {
      await mcp.stop();
      await rest.stop();
    },
  };
}

/**
 * Open the standalone SSE stream for an MCP session (a GET on /mcp) and
 * collect server-sent JSON-RPC messages. This is what a `claude --channels`
 * session does to receive `notifications/claude/channel` events.
 * Returns { messages, next(method, timeoutMs), close }.
 */
export async function openChannelStream(mcpUrl, sessionId) {
  const res = await fetch(mcpUrl, {
    method: 'GET',
    headers: { 'mcp-session-id': sessionId, Accept: 'text/event-stream' },
  });
  if (res.status !== 200) {
    throw new Error(`channel stream open failed: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const messages = [];
  const waiters = []; // { method, resolve }
  let buf = '';

  function handle(msg) {
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].method === msg.method) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  }

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of event.split('\n')) {
            const t = line.trimStart();
            if (t.startsWith('data:')) {
              try { handle(JSON.parse(t.slice(5).trim())); } catch { /* keepalive */ }
            }
          }
        }
      }
    } catch { /* stream closed */ }
  })();

  return {
    messages,
    /** Resolve with the first message whose JSON-RPC method matches. */
    next(method, timeoutMs = 4000) {
      const existing = messages.find((m) => m.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const entry = { method, resolve: null };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`));
        }, timeoutMs);
        entry.resolve = (m) => { clearTimeout(timer); resolve(m); };
        waiters.push(entry);
      });
    },
    close() { reader.cancel().catch(() => {}); },
  };
}

/**
 * #736 — acquire a REST server + browser, run the body, and guarantee that BOTH
 * are torn down on every settled path.
 *
 * Replaces the shape every puppeteer file used to carry:
 *
 *   const server  = await startRestServer({...});
 *   const browser = await puppeteer.launch({...});   // outside the try
 *   try { ... } finally { await browser.close(); await server.stop(); }
 *
 * where a launch that hung or threw skipped `finally` entirely and abandoned
 * server.js — whose live handles then pinned the test file's process open, so the
 * file never exited and `node --test` withheld every later file's output behind
 * it. This helper exists rather than a convention because a convention did not
 * survive: two fresh instances of the defect were written an hour after it was
 * described, simply by matching the surrounding file.
 *
 * Three things it does that the obvious fix does not:
 *   1. BOUNDS the acquisition (deadline + AbortSignal). Moving launch() inside a
 *      try is not enough — `finally` waits for the promise to SETTLE, and a hang
 *      never settles.
 *   2. Kills the process GROUP on a close timeout (`-pid`), because puppeteer
 *      spawns Chrome detached so the tree can be group-killed; a bare pid leaves
 *      renderers and swaps one orphan class for another.
 *   3. Stops the server on the TIMEOUT path too. A bare Promise.race turns a hang
 *      into a failure while keeping the orphan the fix exists to prevent.
 */
export async function withBrowserServer(body, {
  server: serverOpts = {},
  launch: launchOpts = {},
  launchTimeoutMs = 60_000,
  closeTimeoutMs = 15_000,
  _startServer = startRestServer,
  _launch = null,
  _kill = null,
} = {}) {
  const kill = _kill || ((target, sig) => { try { process.kill(target, sig); } catch { /* already gone */ } });

  /** Race a promise against a deadline. Never leaves the timer holding the loop. */
  const withDeadline = async (p, ms, label) => {
    let timer;
    try {
      return await Promise.race([
        p,
        // ⚠️ NOT unref'd. An unref'd deadline does not hold the event loop, so
        // when the awaited operation is the only thing running node resolves
        // before the timer can fire and the bound silently does not apply —
        // which is the same class of defect as waitForHttp's. Caught by the
        // hanging-launch test, which is exactly the case it had to cover.
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** SIGKILL the browser's whole process group; -pid, never pid. */
  const killBrowserGroup = (browser) => {
    const pid = browser?.process?.()?.pid;
    if (pid) kill(-pid, 'SIGKILL');
  };

  const server = await _startServer(serverOpts);

  let browser;
  try {
    const launcher = _launch || (await import('puppeteer')).default.launch;
    // AbortSignal so a bounded-out launch is told to stop, not merely abandoned.
    const ac = new AbortController();
    const launching = launcher({ ...launchOpts, signal: ac.signal });
    try {
      browser = await withDeadline(launching, launchTimeoutMs, 'puppeteer.launch()');
    } catch (e) {
      ac.abort();
      // A launch that lands AFTER the deadline still spawned Chrome. Adopt the
      // late result purely to kill its group, or it becomes the orphan class
      // this helper exists to remove.
      launching.then((late) => killBrowserGroup(late), () => {});
      throw e;
    }
  } catch (e) {
    // Acquisition failed. THIS is the path the old shape skipped.
    try { await server.stop(); } catch { /* teardown must not mask acquisition */ }
    throw e;
  }

  // #744 — a test that RESTARTS its server mid-body (roster-editor's #506 proves
  // a roster edit goes live only after a restart). If the body reassigned its own
  // `server` binding, teardown below would stop the ALREADY-STOPPED original and
  // leave the replacement running — this helper's own defect, reintroduced by it.
  // So the helper owns the generations: `ctx.server` is reassigned here, and the
  // teardown stops whatever is CURRENT.
  const ctx = {
    browser,
    server,
    async restart(overrides) {
      await ctx.server.stop();
      ctx.server = await _startServer({ ...serverOpts, ...(overrides || {}) });
      return ctx.server;
    },
  };

  let bodyErr;
  try {
    return await body(ctx);
  } catch (e) {
    bodyErr = e;
    throw e;
  } finally {
    try {
      await withDeadline(Promise.resolve(browser.close()), closeTimeoutMs, 'browser.close()');
    } catch {
      killBrowserGroup(browser);
    }
    // Unconditional, and last: reachable from the clean path, the body-throw
    // path, and the close-timeout path alike.
    // #744 — stop whatever generation is CURRENT, not the one we started with.
    try { await ctx.server.stop(); } catch (e) { if (!bodyErr) throw e; }
  }
}
