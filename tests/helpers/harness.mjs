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
    try {
      await fetch(url);
      return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
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

  return {
    mcpUrl: `${baseUrl}/mcp`,
    healthUrl: `${baseUrl}/health`,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
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
export async function startPair({ board, mcpEnv } = {}) {
  const restPort = await freePort();
  const mcpPort = await freePort();
  const mcpNotifyUrl = `http://127.0.0.1:${mcpPort}/internal/notify`;
  const rest = await startRestServer({ board, port: restPort, mcpNotifyUrl });
  // #726 — let a caller tune MCP env (e.g. MCP_DEAF_GRACE_MS) so a test can
  // exercise a time-based threshold without sleeping the real interval.
  const mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl, env: mcpEnv });
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
