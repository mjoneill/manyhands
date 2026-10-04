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

/** Resolves {proc, ready, port, baseUrl} once the executor prints its ready line. */
export function startExecutor({ store, datasetId, create = false, port = 0 }) {
  const args = [EXEC, '--store', store, '--port', String(port), '--dataset-id', datasetId];
  if (create) args.push('--create');
  return new Promise((resolve, reject) => {
    const p = spawn(PY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    p.stdout.on('data', (d) => {
      out += d;
      if (!done && out.includes('\n')) {
        done = true;
        try {
          const ready = JSON.parse(out.split('\n')[0]);
          resolve({ proc: p, ready, port: ready.port, baseUrl: `http://127.0.0.1:${ready.port}` });
        } catch (e) { reject(e); }
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code, sig) => { if (!done) { done = true; reject(new Error(`executor exited ${code ?? sig}: ${err}`)); } });
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
