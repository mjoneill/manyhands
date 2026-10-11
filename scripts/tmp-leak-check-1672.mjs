#!/usr/bin/env node
/**
 * #1672 — on-demand per-file temp-leak detector. For each named test file: run it alone (`node --test <file>`) with TMPDIR at a fresh private directory, sample the directory while it runs,
 * and report what is left when the file ends. Exit 1 if any file leaves anything, or if a file did not really run (nothing to measure).
 *
 *   node scripts/tmp-leak-check-1672.mjs [--bound-ms N] tests/foo.test.mjs [tests/bar.test.mjs ...]
 *
 * Why it exists next to the runner's own report: it attributes a leak to a file without running the suite, and it is the acceptance evidence for a sweep ("57 and 11 at 69931f0").
 * What it does not do: judge a file that leaks only when a test fails, or only under suite load; paths outside TMPDIR.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let boundMs = 600000;
if (args[0] === '--bound-ms') { boundMs = Number(args[1]); args.splice(0, 2); }
if (!args.length) { console.error('usage: tmp-leak-check-1672.mjs [--bound-ms N] <test file> ...'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const bytesOf = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() ? fs.readdirSync(p).reduce((n, e) => n + bytesOf(path.join(p, e)), 0) : st.size; } catch { return 0; } };
const tmpStorePrefixes = (file) => [...new Set([...fs.readFileSync(path.resolve(ROOT, file), 'utf8').matchAll(/tmpStore\('([^']+)'\)/g)].map((m) => m[1]))];
const tally = (tap, name) => Number((new RegExp(`^# ${name} (\\d+)`, 'm').exec(tap) || [])[1] ?? NaN);

let anyLeak = false;
for (const file of args) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tmp-leak-check-'));
  try {
    const env = { ...process.env, TMPDIR: tmp }; delete env.NODE_TEST_CONTEXT;
    let tap = '';
    const child = spawn(process.execPath, ['--test', path.resolve(ROOT, file)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => { tap += d; });
    let peak = 0; const timer = setInterval(() => { peak = Math.max(peak, entries(tmp).length); }, 200);
    const code = await Promise.race([new Promise((r) => child.once('exit', (c) => r(c))), sleep(boundMs).then(() => 'TIMEOUT')]);
    clearInterval(timer);
    if (code === 'TIMEOUT') { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    const left = entries(tmp); peak = Math.max(peak, left.length);
    const prefixes = tmpStorePrefixes(file);
    const fromStore = left.filter((n) => prefixes.some((p) => n.startsWith(p)));
    const ran = tally(tap, 'pass') >= 1 && tally(tap, 'skipped') === 0;
    const total = left.reduce((n, e) => n + bytesOf(path.join(tmp, e)), 0);
    console.log(`${file}: ${left.length} entr${left.length === 1 ? 'y' : 'ies'} left, ${total} bytes (${fromStore.length} from tmpStore ${JSON.stringify(prefixes)}); exit ${code}; pass ${tally(tap, 'pass')} fail ${tally(tap, 'fail')} skipped ${tally(tap, 'skipped')}; peak ${peak}`);
    for (const n of left) console.log(`  ${n}`);
    if (code === 'TIMEOUT') { console.log('  NOT MEASURED: the file did not end within the bound'); anyLeak = true; }
    else if (!ran) { console.log('  NOT MEASURED: the file did not really run (no pass, or a skip)'); anyLeak = true; }
    else if (left.length) anyLeak = true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
process.exit(anyLeak ? 1 : 0);
