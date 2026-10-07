#!/usr/bin/env node
// #1630 — the macOS sandbox profile a supervised builder runs inside (`sandbox-exec -f <profile> <command>`).
//
// On 2026-10-07 a builder under a "source only" instruction ran `lsof -ti:3141 | xargs kill` (which killed live REST),
// started its own server for the live port and rewrote the live board's columns. A prompt rule had already said
// not to. This profile makes those moves fail rather than relying on the builder's conduct:
//   (a) no outbound connection to a protected port: "localhost:P" covers 127.0.0.1 and ::1 (measured);
//   (b) no BINDING a protected port;
//   (c) no signal to any process outside the builder's own tree: deny ALL, then allow self and children.
//       `(deny signal (target others))` does NOT protect (measured twice);
//   (d) file writes only inside the worktree, the run's tmp directory and each --write-also directory. A linked git
//       worktree keeps its metadata in the main repository's .git, so the caller passes that. Reads are unrestricted.
// The protected ports are PARAMETERS so the rows can aim the profile at a decoy server, never at the live one.
//
//   node scripts/builder-sandbox.mjs [--protect-ports 3141,3143] --worktree <dir> --tmp <dir> [--write-also <dir>]...
// prints the profile and runs nothing.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_PROTECTED_PORTS = Object.freeze([3141, 3143]);

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const canon = (d, what) => {
  try { return realpathSync(resolve(d)); } catch { throw new Error(`builder-sandbox: ${what} ${JSON.stringify(d)} does not exist`); }
};

/** The profile text. Every port must be an integer 1–65535 and every directory must exist, or it throws, so a typo can
 * never yield a profile that protects nothing or allows a path nobody meant. */
export function buildProfile({ protectPorts = DEFAULT_PROTECTED_PORTS, worktree, tmp, writeAlso = [] }) {
  if (!worktree) throw new Error('builder-sandbox: --worktree is required');
  if (!tmp) throw new Error('builder-sandbox: --tmp is required');
  const ports = [...new Set(protectPorts.map((p) => {
    const n = Number(String(p).trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`builder-sandbox: bad protected port ${JSON.stringify(p)}`);
    return n;
  }))];
  if (!ports.length) throw new Error('builder-sandbox: at least one protected port');
  const writable = [...new Set([canon(worktree, 'worktree'), canon(tmp, 'tmp'), ...writeAlso.map((d) => canon(d, 'write-also'))])];
  return [
    '(version 1)',
    '(allow default)',
    ';; #1630 (a)(b): the protected ports are unreachable and unbindable from inside',
    ...ports.flatMap((p) => [
      `(deny network-outbound (remote ip ${quote(`localhost:${p}`)}))`,
      `(deny network-bind (local ip ${quote(`*:${p}`)}))`,
    ]),
    ';; #1630 (c): signals only within the builder\'s own tree',
    '(deny signal)',
    '(allow signal (target self))',
    '(allow signal (target children))',
    ';; #1630 (d): writes only where building happens (/dev for /dev/null and terminals)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((d) => `(subpath ${quote(d)})`).join(' ')} (subpath "/dev"))`,
    '',
  ].join('\n');
}

export function parseArgs(argv) {
  const out = { protectPorts: DEFAULT_PROTECTED_PORTS, writeAlso: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (k === '--protect-ports') { out.protectPorts = String(v ?? '').split(','); i++; }
    else if (k === '--worktree') { out.worktree = v; i++; }
    else if (k === '--tmp') { out.tmp = v; i++; }
    else if (k === '--write-also') { out.writeAlso.push(v); i++; }
    else throw new Error(`builder-sandbox: unknown argument ${JSON.stringify(k)}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(buildProfile(parseArgs(process.argv.slice(2)))); }
  catch (e) {
    process.stderr.write(`${e.message}\nusage: builder-sandbox.mjs [--protect-ports 3141,3143] --worktree <dir> --tmp <dir> [--write-also <dir>]...\n`);
    process.exit(64);
  }
}
