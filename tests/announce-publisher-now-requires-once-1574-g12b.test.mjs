/**
 * #1574 gate 12, ADDENDUM — `--now` REQUIRES `--once`. Written by a second test author after an independent mutation run on 9e8a35d
 * found that the frozen gate-12 file never pins the rejection: removing the build's `--now requires --once` check changed no result
 * (mutant G17 survived). The frozen file (sha256 0f601313…99ea7) is untouched; copy this file beside it in tests/.
 *
 * CONTRACT: a fixed `--now` instant in the long-running loop would freeze every backoff window forever, so `--now` without `--once`
 * is an ARGUMENT error: exit 2, nothing written to the status file, ZERO /publish calls, and the process does not run on. The valid
 * combinations still work in either argument order.
 *
 * HOW THE MUTANT SHOWS: without the check the process enters the loop and never exits, so the run is killed by this file's own
 * timeout (signal set, no exit code) and every assertion here fails; the status file would also exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHER = process.env.PUBLISHER_SCRIPT || path.join(HERE, '..', 'scripts', 'announce-publisher.mjs');
const T0 = '2026-10-04T12:00:00.000Z';
const NOW = '2031-01-01T00:00:00.000Z';

const seeded = () => makeBoardFixture({
  announcementOutbox: {
    origins: { 'm-1': { mutationId: 'm-1', slots: ['claim'], origin: { cardId: 'c1', version: 2 }, committedAt: T0, occurredAt: T0, originActor: 'ada', mode: 'publisher' } },
    entries: { 'm-1:claim': { obligationId: 'm-1:claim', mutationId: 'm-1', slot: 'claim', status: 'pending', mode: 'publisher',
      payload: { author: 'board', body: 'claimed m-1', mentions: [], notify: true, occurredAt: T0, originActor: 'ada', origin: { cardId: 'c1', version: 2 }, mutationId: 'm-1', slot: 'claim' } } },
  },
});

/** Counts every POST /api/outbox/:id/publish on the way to the board. */
async function startProxy(targetBase) {
  const target = new URL(targetBase); const p = { publishCalls: 0 };
  p.server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && /^\/api\/outbox\/[^/?]+\/publish$/.test(req.url.split('?')[0])) p.publishCalls++;
      const up = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.base = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

/** Runs the publisher with EXACTLY these arguments (no --once added) and kills it after `limitMs`. */
function run(base, args, limitMs = 8000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g12b-'));
  const key = path.join(dir, 'board.key'); fs.writeFileSync(key, 'sk-test-not-a-secret', { mode: 0o600 });
  const status = path.join(dir, 'publisher-status.json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISHER, '--board', base, '--key-file', key, '--status', status, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = []; child.stderr.on('data', (d) => err.push(String(d)));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, limitMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, err: err.join(''), statusExists: fs.existsSync(status), status: (() => { try { return JSON.parse(fs.readFileSync(status, 'utf8')); } catch { return null; } })() }); });
  });
}
const withBoard = async (body) => {
  const s = await startRestServer({ board: seeded(), env: {} });
  const proxy = await startProxy(s.baseUrl);
  try { return await body(s, proxy); } finally { await proxy.stop(); await s.stop(); }
};
const statusOf = async (base) => (await (await fetch(`${base}/api/outbox`)).json()).entries.find((e) => e.obligationId === 'm-1:claim')?.status;

test('N1 --now WITHOUT --once is rejected as an argument error: exit 2, quickly, no status file, ZERO /publish calls, nothing published', async () => {
  await withBoard(async (s, proxy) => {
    for (const args of [['--now', NOW], ['--now', '2032-02-29T00:00:00.000+00:00'], ['--now', NOW, '--batch', '3']]) {
      const r = await run(proxy.base, args);
      assert.equal(r.timedOut, false, `${args.join(' ')}: it must refuse and EXIT, not run on in a loop (killed by the timeout; signal ${r.signal})`);
      assert.equal(r.code, 2, `${args.join(' ')}: exit 2 expected, got ${r.code}: ${r.err}`);
      assert.ok(r.err.trim().length > 0, 'a refusal says why on stderr');
      assert.equal(r.statusExists, false, `${args.join(' ')}: a rejected invocation writes no status file`);
    }
    assert.equal(proxy.publishCalls, 0, 'no /publish call was made by any rejected run');
    assert.equal(await statusOf(s.baseUrl), 'pending', 'nothing was published');
  });
});

test('N2 (control) --now WITH --once is accepted in either argument order, runs one scan and exits 0 (so N1 cannot pass by rejecting --now everywhere)', async () => {
  for (const args of [['--once', '--now', NOW], ['--now', NOW, '--once']]) {
    await withBoard(async (s, proxy) => {
      const r = await run(proxy.base, args, 30000);
      assert.equal(r.timedOut, false, `${args.join(' ')}: ${r.err}`);
      assert.equal(r.code, 0, `${args.join(' ')}: exit 0 expected, got ${r.code}: ${r.err}`);
      assert.equal(r.statusExists, true, 'a completed scan writes its status');
      assert.ok(proxy.publishCalls >= 1, `${args.join(' ')}: the scan really ran (attempted the pending entry)`);
    });
  }
});
