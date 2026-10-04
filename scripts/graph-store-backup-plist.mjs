#!/usr/bin/env node
/**
 * #1566 T4 — DRY-RUN launchd plists for the backup TICK and the freshness MONITOR.
 * PRINT ONLY: this script has no install mode. It writes nothing outside stdout (or --out).
 * Installing is a DEPLOY and the DESTINATION is the owner's call: no off-volume destination is
 * authorized, and same-disk copies do not protect against loss of the volume.
 *
 *   node scripts/graph-store-backup-plist.mjs --job tick|monitor --dest DIR --url URL
 *        [--store DIR] [--checkpoint-dir DIR] [--interval SEC (tick: 900, monitor: 300)]
 *        [--code DIR] [--node PATH] [--python PY] [--label LABEL] [--out FILE]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { destinationLine } from './graph-store-backup-schedule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plain = (v, name) => { if (!v || /[^A-Za-z0-9._/@:+-]/.test(v)) throw new Error(`${name} has characters this renderer will not put in a plist: '${v}'`); return v; };
const abs = (v, name) => { if (!path.isAbsolute(v)) throw new Error(`${name} must be an absolute path: ${v}`); return plain(v, name); };

export function renderPlist({ job, dest, url, store = null, checkpointDir = null, interval = null, code = ROOT,
  node = process.execPath, python = null, label = null, home = os.homedir() }) {
  if (job !== 'tick' && job !== 'monitor') throw new Error('--job must be tick or monitor');
  abs(dest, '--dest'); abs(code, '--code'); abs(node, '--node'); plain(url, '--url');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`--url must be http://127.0.0.1:PORT: ${url}`);
  if (store) abs(store, '--store');
  if (checkpointDir) abs(checkpointDir, '--checkpoint-dir');
  if (python) abs(python, '--python');
  const iv = interval ?? (job === 'tick' ? 900 : 300);
  if (!Number.isInteger(iv) || iv < 1) throw new Error('--interval must be whole seconds >= 1');
  const lab = plain(label || `com.scrumboard.graph-store-backup-${job}`, '--label');
  const log = path.join(home, '.claude', `${lab}.log`);
  const dline = destinationLine(dest, store || checkpointDir);
  const args = job === 'tick'
    ? [node, path.join(code, 'scripts', 'graph-store-backup-schedule.mjs'), '--url', url, '--dest', dest,
      ...(checkpointDir ? ['--checkpoint-dir', checkpointDir] : []), ...(store ? ['--store', store] : []), ...(python ? ['--python', python] : [])]
    : [node, path.join(code, 'scripts', 'graph-store-backup-monitor.mjs'), '--dest', dest, ...(store ? ['--store', store] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- #1566 graph-store backup ${job}. DRY RUN: rendered, not installed. -->
<!-- ${dline} -->
<!-- The destination is the owner's call; no off-volume destination is authorized. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${lab}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${code}</string>
  <key>StartInterval</key><integer>${iv}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function parseArgs(argv) {
  const a = {};
  const map = { '--job': 'job', '--dest': 'dest', '--url': 'url', '--store': 'store', '--checkpoint-dir': 'checkpointDir',
    '--code': 'code', '--node': 'node', '--python': 'python', '--label': 'label', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--interval') a.interval = Number(argv[++i]);
    else if (k === '--print') { /* the only mode */ }
    else if (map[k]) a[map[k]] = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.job || !a.dest || !a.url) throw new Error('--job, --dest and --url are required');
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const xml = renderPlist(a);
    if (a.out) { fs.writeFileSync(a.out, xml); console.error(`rendered → ${a.out} (dry run: nothing installed)`); } else process.stdout.write(xml);
    console.error(destinationLine(a.dest, a.store || a.checkpointDir));
  } catch (e) { console.error(e.message); process.exit(2); }
}
