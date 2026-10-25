#!/usr/bin/env node
/**
 * #1744 — DRY-RUN launchd plist for the SCHEDULED card-reference-index check (contract amendment, rulings 46773/46781:
 * daily plus at every deploy, owned by the PO). PRINT ONLY: this script has no install mode and writes nothing outside
 * stdout (or --out). Installing the job is a separate, approved step, not part of this build.
 *
 *   node scripts/card-ref-index-plist.mjs --url http://127.0.0.1:PORT --dataset ID --log FILE
 *        [--hour H (default 4)] [--minute M (default 17)] [--code DIR] [--node PATH] [--label LABEL] [--out FILE]
 *
 * The job runs `scripts/card-ref-index-1744.mjs --verify-and-latch` once a day. Its exit status is the outcome:
 * 0 COMPLETE, 1 LATCHED (the index now refuses every index-dependent write), 2 CLOSURE UNCONFIRMED, 3 UNSTABLE.
 * STATED LIMIT: this is MONITORING, not continuous protection; consistent corruption can evade the runtime checks
 * between runs. The per-deploy run belongs in the deploy procedure and is not rendered here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plain = (v, name) => { if (!v || /[^A-Za-z0-9._/@:+-]/.test(String(v))) throw new Error(`${name} has characters this renderer will not put in a plist: '${v}'`); return String(v); };
const abs = (v, name) => { if (!path.isAbsolute(v)) throw new Error(`${name} must be an absolute path: ${v}`); return plain(v, name); };
const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer ${lo}..${hi}: ${v}`); return n; };

export function renderPlist({ url, dataset, log, hour = 4, minute = 17, code = ROOT, node = process.execPath, label = 'com.scrumboard.card-ref-index-verify' }) {
  plain(url, '--url');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`--url must be http://127.0.0.1:PORT: ${url}`);
  plain(dataset, '--dataset'); abs(log, '--log'); abs(code, '--code'); abs(node, '--node'); plain(label, '--label');
  const h = int(hour, 0, 23, '--hour'), m = int(minute, 0, 59, '--minute');
  const args = [node, path.join(code, 'scripts', 'card-ref-index-1744.mjs'), '--executor', url, '--dataset', dataset, '--verify-and-latch'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${code}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const out = renderPlist({ url: arg('--url'), dataset: arg('--dataset'), log: arg('--log'), hour: arg('--hour') ?? 4, minute: arg('--minute') ?? 17,
      code: arg('--code') ?? ROOT, node: arg('--node') ?? process.execPath, label: arg('--label') ?? undefined });
    if (arg('--out')) fs.writeFileSync(arg('--out'), out); else process.stdout.write(out);
  } catch (e) { console.error(`REFUSED ${e.message}`); process.exit(1); }
}
