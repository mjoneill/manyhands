/**
 * #1562 — start the real graph executor (graph-executor/executor.py) on a
 * throwaway store, for tests. Fabricated data only.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
export const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
export const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;

export const tmpStore = (prefix = 'lg-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * Resolves {proc, ready, port, baseUrl} once the executor prints its ready line.
 * #1670 — on every startup failure (a first line that is not JSON, no ready line within readyTimeoutMs, a spawn error) the process is KILLED and gone before
 * the promise rejects: the caller never received a handle, so nothing else can clean it up, and its RocksDB lock must be released before anyone reopens the store.
 * A real executor prints its ready line in a second or two; 15 s is well over that and under the #1670 rows' 20 s outer bound.
 */
export function startExecutor({ store, datasetId, create = false, port = 0, readyTimeoutMs = 15_000, extraArgs = [] }) {
  const args = [EXEC, '--store', store, '--port', String(port), '--dataset-id', datasetId];
  if (create) args.push('--create');
  args.push(...extraArgs);
  return new Promise((resolve, reject) => {
    const p = spawn(PY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const fail = (e) => {
      if (done) return; done = true; clearTimeout(timer);
      if (p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return reject(e);   // never spawned, or already gone
      p.once('exit', () => reject(e)); p.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error(`executor printed no ready line within ${readyTimeoutMs} ms: ${err}`)), readyTimeoutMs);
    p.stdout.on('data', (d) => {
      out += d;
      if (!done && out.includes('\n')) {
        let ready;
        try { ready = JSON.parse(out.split('\n')[0]); } catch (e) { return fail(e); }
        done = true; clearTimeout(timer);
        resolve({ proc: p, ready, port: ready.port, baseUrl: `http://127.0.0.1:${ready.port}` });
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fail(e));
    p.on('exit', (code, sig) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`executor exited ${code ?? sig}: ${err}`)); } });
  });
}

/** SIGKILL, and resolve once the process is really gone (its RocksDB lock released). */
export function killExecutor(x) {
  return new Promise((resolve) => {
    if (!x?.proc || x.proc.exitCode !== null || x.proc.signalCode !== null) return resolve();
    x.proc.once('exit', () => resolve());
    x.proc.kill('SIGKILL');
  });
}
