/**
 * #1559 integration (hardening × supervisor): POST /checkpoint reads the commit marker
 * mid-request. A contradictory marker must REFUSE the checkpoint (a backup that cannot
 * say which commit it holds is not a backup) and must never kill the executor, the
 * same rule bb19875 set for writes and /health.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function start(store) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'cpm', '--create'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}

test('#1559 a checkpoint on a sound marker succeeds (twin)', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-'));
  const e = await start(store);
  try {
    const r = await fetch(`${e.base}/checkpoint`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).epoch, '1');
  } finally { e.p.kill('SIGKILL'); }
});

test('#1559 a checkpoint on a contradictory marker is REFUSED, and the executor keeps serving', { skip: SKIP }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-'));
  const e = await start(store);
  let exited = false; e.p.on('exit', () => { exited = true; });
  try {
    const plant = await fetch(`${e.base}/update`, { method: 'POST', body: 'INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:epoch> 7 } }', headers: { 'x-op-id': 'urn:ex:op/plant' } });
    assert.equal(plant.status, 200);
    const r = await fetch(`${e.base}/checkpoint`, { method: 'POST' }).catch((err) => ({ status: 'NO-RESPONSE', err }));
    assert.notEqual(r.status, 'NO-RESPONSE', 'the request got an answer');
    assert.equal(r.status, 409, 'refused, not a 200 and not a dropped connection');
    assert.match((await r.json()).error, /marker/);
    const h = await (await fetch(`${e.base}/health`)).json();
    assert.match(h.markerError, /marker rows/);
    assert.equal(exited, false, 'the process is alive');
  } finally { e.p.kill('SIGKILL'); }
});
