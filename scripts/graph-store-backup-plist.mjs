#!/usr/bin/env node
/**
 * #1566 T4 — DRY-RUN launchd plists for the backup TICK and the freshness MONITOR, and (#1590) the
 * independent WATCHER.
 * PRINT ONLY: this script has no install mode. It writes nothing outside stdout (or --out).
 * Installing is a DEPLOY and the DESTINATION is the owner's call: no off-volume destination is
 * authorized, and same-disk copies do not protect against loss of the volume.
 *
 *   node scripts/graph-store-backup-plist.mjs --job tick|monitor --dest DIR --url URL
 *        [--store DIR] [--checkpoint-dir DIR] [--interval SEC (tick: 900, monitor: 300)]
 *        [--code DIR] [--node PATH] [--python PY] [--label LABEL] [--out FILE] [--board URL --key-file FILE (monitor: deliver alerts to the commons as the board seat)]
 *   node scripts/graph-store-backup-plist.mjs --job watch --dest DIR --alert-state FILE --plist-dir DIR
 *        --config FILE --status FILE --interval SEC [--ack-file FILE] [--code DIR] [--node PATH] [--label LABEL] [--out FILE]
 *
 * --job watch renders graph-store-backup-watch.mjs. Every path and the interval are REQUIRED: the
 * watcher's contract forbids defaulting them, so the renderer does not either. It takes no URL, no
 * board and no key (the watcher sends nothing). The watcher finds this plist again by the script
 * named in ProgramArguments, so the plist must sit in --plist-dir under a *.plist name.
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
  node = process.execPath, python = null, label = null, home = os.homedir(), board = null, keyFile = null,
  alertState, plistDir, config, status, ackFile = null }) {
  if (job === 'watch') return renderWatch({ dest, alertState, plistDir, config, status, ackFile, interval, code, node, label, home, board, keyFile });
  if (job !== 'tick' && job !== 'monitor') throw new Error('--job must be tick, monitor or watch');
  abs(dest, '--dest'); abs(code, '--code'); abs(node, '--node'); plain(url, '--url');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`--url must be http://127.0.0.1:PORT: ${url}`);
  if (store) abs(store, '--store');
  if (checkpointDir) abs(checkpointDir, '--checkpoint-dir');
  if (python) abs(python, '--python');
  // #1578 — with --board the monitor job DELIVERS its alerts as commons posts (graph-store-backup-alert.mjs).
  if (board !== null && !keyFile) throw new Error('--board needs --key-file (the board seat credential)');
  if (keyFile) abs(keyFile, '--key-file');
  if (board !== null && (job !== 'monitor' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(plain(board, '--board')))) throw new Error('--board http://127.0.0.1:PORT is for --job monitor only');
  const iv = interval ?? (job === 'tick' ? 900 : 300);
  if (!Number.isInteger(iv) || iv < 1) throw new Error('--interval must be whole seconds >= 1');
  const lab = plain(label || `com.scrumboard.graph-store-backup-${job}`, '--label');
  const log = path.join(home, '.claude', `${lab}.log`);
  const dline = destinationLine(dest, store || checkpointDir);
  const args = job === 'tick'
    ? [node, path.join(code, 'scripts', 'graph-store-backup-schedule.mjs'), '--url', url, '--dest', dest,
      ...(checkpointDir ? ['--checkpoint-dir', checkpointDir] : []), ...(store ? ['--store', store] : []), ...(python ? ['--python', python] : [])]
    : board
      ? [node, path.join(code, 'scripts', 'graph-store-backup-alert.mjs'), '--dest', dest, '--board', board, '--key-file', keyFile, ...(store ? ['--store', store] : [])]
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

/**
 * #1590 — the WATCHER job. No defaults for anything the watcher must not default: every path and
 * the interval are required. The label follows the other two jobs (com.scrumboard.graph-store-backup-<job>).
 */
function renderWatch({ dest, alertState, plistDir, config, status, ackFile, interval, code, node, label, home, board, keyFile }) {
  if (board || keyFile) throw new Error('--board/--key-file are for --job monitor only');
  const req = [[dest, '--dest'], [alertState, '--alert-state'], [plistDir, '--plist-dir'], [config, '--config'], [status, '--status']];
  for (const [v, name] of req) { if (v == null || v === '') throw new Error(`${name} is required for --job watch (the watcher never defaults it)`); abs(v, name); }
  if (ackFile != null) abs(ackFile, '--ack-file');
  abs(code, '--code'); abs(node, '--node');
  if (!Number.isInteger(interval) || interval < 1) throw new Error('--interval SEC is required for --job watch: whole seconds >= 1, never a default');
  const lab = plain(label || 'com.scrumboard.graph-store-backup-watch', '--label');
  const log = path.join(home, '.claude', `${lab}.log`);
  const args = [node, path.join(code, 'scripts', 'graph-store-backup-watch.mjs'), '--dest', dest, '--alert-state', alertState,
    '--plist-dir', plistDir, '--config', config, '--status', status, ...(ackFile ? ['--ack-file', ackFile] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- #1590 graph-store backup watch. DRY RUN: rendered, not installed. Detection only: it writes one local status file and sends nothing. -->
<!-- It must be installed in --plist-dir under a *.plist name: the watcher finds its own interval there. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${lab}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${code}</string>
  <key>StartInterval</key><integer>${interval}</integer>
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
    '--code': 'code', '--node': 'node', '--python': 'python', '--label': 'label', '--out': 'out', '--board': 'board', '--key-file': 'keyFile',
    '--alert-state': 'alertState', '--plist-dir': 'plistDir', '--config': 'config', '--status': 'status', '--ack-file': 'ackFile' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--interval') a.interval = Number(argv[++i]);
    else if (k === '--print') { /* the only mode */ }
    else if (map[k]) a[map[k]] = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  if (a.job === 'watch') return a;                     // renderWatch names whatever is missing
  if (!a.job || !a.dest || !a.url) throw new Error('--job, --dest and --url are required');
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const xml = renderPlist(a);
    if (a.out) { fs.writeFileSync(a.out, xml); console.error(`rendered → ${a.out} (dry run: nothing installed)`); } else process.stdout.write(xml);
    if (a.job !== 'watch') console.error(destinationLine(a.dest, a.store || a.checkpointDir));
  } catch (e) { console.error(e.message); process.exit(2); }
}
