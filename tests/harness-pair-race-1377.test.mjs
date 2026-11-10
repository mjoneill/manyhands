/**
 * #1377 — THE MECHANISM, measured from the failed CI attempts' own logs, not
 * from the rerun button:
 *
 *   34852855014 attempt 2 · #1158 (acceptance-upsert-replaces) · 0.27 s ·
 *     "MCP server failed to start: port 38027 was answered by a server I did
 *      not start (#1259) — lost the allocation race (#1140) (port was
 *      requested explicitly, so it is not retried)"
 *   34858791433 attempt 1 · #624 (fanout-loss) · 0.30 s · the same line,
 *      port 40293.
 *
 * Neither was a timeout and neither was "unrelated": both files use
 * startPair, which takes a free MCP port UP FRONT (the REST child needs the
 * notify URL), starts REST (seconds), then binds MCP on that pre-chosen port.
 * In that window another file, running concurrently, can bind the same port.
 * The harness then treats the port as explicit and refuses to retry — so a
 * race the harness already knows how to survive for a single server becomes
 * a red run for a pair.
 *
 * The repair: on a CONTENDED MCP start, stop the REST sibling, allocate fresh
 * ports, and start the pair again — bounded by the same START_ATTEMPTS a
 * single server gets. A non-contention failure still rejects at once (#730's
 * cleanup contract stands).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, makeBoardFixture } from './helpers/harness.mjs';

const contended = (port) => new Error(`MCP server failed to start: port ${port} was answered by a server I did not start (#1259) — lost the allocation race (#1140) (port was requested explicitly, so it is not retried)\nstderr: `);

test('#1377 a CONTENDED MCP start restarts the PAIR on fresh ports instead of failing the test', async () => {
  const restStarts = [];
  const mcpPorts = [];
  const stops = [];
  let attempt = 0;
  const pair = await startPair({
    board: makeBoardFixture(),
    _startRest: async ({ port, mcpNotifyUrl }) => { restStarts.push({ port, mcpNotifyUrl }); return { baseUrl: `http://127.0.0.1:${port}`, port, stop: async () => { stops.push(`rest:${port}`); } }; },
    _startMcp: async ({ port }) => {
      mcpPorts.push(port);
      attempt += 1;
      if (attempt === 1) throw contended(port);   // someone else got there first
      return { port, stop: async () => { stops.push(`mcp:${port}`); } };
    },
  });
  assert.equal(attempt, 2, 'the pair was started twice');
  assert.equal(restStarts.length, 2, 'REST was restarted too — its notify URL names the MCP port');
  assert.notEqual(mcpPorts[0], mcpPorts[1], 'the second attempt used a FRESH port, not the contended one');
  assert.ok(restStarts[1].mcpNotifyUrl.endsWith(`:${mcpPorts[1]}/internal/notify`), 'and the new REST points at the new MCP port');
  assert.deepEqual(stops, [`rest:${restStarts[0].port}`], 'the first REST was stopped before the retry (no orphan)');
  await pair.stop();
});

test('#1377 a NON-contention MCP failure still rejects at once and strands nothing (#730 unchanged)', async () => {
  const stops = [];
  let attempts = 0;
  await assert.rejects(() => startPair({
    board: makeBoardFixture(),
    _startRest: async ({ port }) => ({ baseUrl: `http://127.0.0.1:${port}`, port, stop: async () => { stops.push('rest'); } }),
    _startMcp: async () => { attempts += 1; throw new Error('injected: something else entirely'); },
  }), /something else entirely/);
  assert.equal(attempts, 1, 'no retry for a failure that is not the race');
  assert.deepEqual(stops, ['rest']);
});

test('#1377 contention on EVERY attempt is bounded and reported as the race, with the count', async () => {
  let attempts = 0;
  await assert.rejects(() => startPair({
    board: makeBoardFixture(),
    _startRest: async ({ port }) => ({ baseUrl: `http://127.0.0.1:${port}`, port, stop: async () => {} }),
    _startMcp: async ({ port }) => { attempts += 1; throw contended(port); },
  }), /allocation race.*pair attempt 4\/4/s);
  assert.equal(attempts, 4);
});

// #1873 — THE OTHER HALF. Measured on PR #212's CI (run 42856405749, 2026-11-10): #1118-A failed in 118 ms with
// "REST server failed to start: port 40991 was answered by a server I did not start (#1259) — lost the allocation
// race (#1140) (port was requested explicitly, so it is not retried)". The pair retry above wrapped only the MCP
// acquisition; REST's port is chosen up front too, so a contended REST start rejected straight out of startPair.
const restContended = (port) => new Error(`REST server failed to start: port ${port} was answered by a server I did not start (#1259) — lost the allocation race (#1140) (port was requested explicitly, so it is not retried)\nstderr: `);

test('#1873 a CONTENDED REST start restarts the pair on a fresh REST port instead of failing the test', async () => {
  const restPorts = [];
  let mcpStarts = 0;
  const pair = await startPair({
    board: makeBoardFixture(),
    _startRest: async ({ port }) => {
      restPorts.push(port);
      if (restPorts.length === 1) throw restContended(port);
      return { baseUrl: `http://127.0.0.1:${port}`, port, stop: async () => {} };
    },
    _startMcp: async ({ port }) => { mcpStarts += 1; return { port, stop: async () => {} }; },
  });
  assert.equal(restPorts.length, 2, 'REST was tried again');
  assert.notEqual(restPorts[0], restPorts[1], 'on a FRESH port, not the contended one');
  assert.equal(mcpStarts, 1, 'MCP never started for the lost attempt, and started once for the won one');
  await pair.stop();
});

test('#1873 a NON-contention REST failure still rejects at once, with no retry', async () => {
  let attempts = 0;
  await assert.rejects(() => startPair({
    board: makeBoardFixture(),
    _startRest: async () => { attempts += 1; throw new Error('injected: REST broke for another reason'); },
    _startMcp: async () => { throw new Error('MCP must not start when REST failed'); },
  }), /another reason/);
  assert.equal(attempts, 1);
});

test('#1873 REST contention on EVERY attempt is bounded and reported as the race, with the count', async () => {
  let attempts = 0;
  await assert.rejects(() => startPair({
    board: makeBoardFixture(),
    _startRest: async ({ port }) => { attempts += 1; throw restContended(port); },
    _startMcp: async () => { throw new Error('MCP must not start when REST failed'); },
  }), /allocation race.*pair attempt 4\/4/s);
  assert.equal(attempts, 4);
});
