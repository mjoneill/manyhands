#!/usr/bin/env node
/**
 * #1690 — the Mac leg of the platform-split landing gate (decision 45a5d8e4).
 *
 *   node scripts/run-platform-only.mjs --manifest <path> --sha <40-hex> [--root <dir>] [--receipt <path>]
 *
 * Runs ONLY the manifest's named tests: each listed file, restricted by an exact, anchored --test-name-pattern to
 * the names listed for it. A file the manifest does not list is never started, and a test the manifest does not
 * name is never run even when it shares a file with one that is named (commons 42090). This leg exists so the
 * heavy full suite does not have to run on the production host (10-14: 127 board 503s across six full runs); it
 * must never become that run again.
 *
 * Every named test must report a plain pass. Skipped, failed, renamed or missing tests, and missing files, fail
 * the leg and are named. Exit 0 clean · 1 mismatch · 2 could not check (missing, empty or malformed manifest;
 * no sha). The receipt records the leg, the sha, the manifest's content hash, the files actually run and the
 * verdict, for check-gate-pair.mjs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CannotCheck, parseArgs, readManifest, parseTap, writeReceipt, requireSha } from './platform-gate-lib.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main(argv) {
  const { flags } = parseArgs(argv);
  const sha = requireSha(flags.sha);
  const manifest = readManifest(flags.manifest);
  const root = path.resolve(flags.root ?? process.cwd());

  // Group names by file, in manifest order.
  const byFile = new Map();
  for (const e of manifest.entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e.name);
  }

  // A nested node --test would report through a parent's channel instead of printing TAP.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const problems = [];
  const filesRun = [];
  for (const [file, names] of byFile) {
    const abs = path.resolve(root, file);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) {
      problems.push(`manifest file is missing: ${file}`);
      continue;
    }
    const patterns = names.flatMap((n) => ['--test-name-pattern', `^${escapeRe(n)}$`]);
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...patterns, file], {
      cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000,
    });
    filesRun.push(file);
    const tests = parseTap(r.stdout ?? '');
    for (const name of names) {
      const t = tests.find((x) => x.name === name);
      if (!t) problems.push(`named test did not run (renamed or removed?): ${name} (${file})`);
      else if (t.directive === 'SKIP') problems.push(`named test was skipped (${t.reason || 'no reason given'}): ${name} (${file})`);
      else if (!t.ok) problems.push(`named test failed: ${name} (${file})`);
    }
    if (r.error) problems.push(`could not run ${file}: ${r.error.message}`);
  }

  const ok = problems.length === 0;
  writeReceipt(flags.receipt, {
    leg: 'mac', sha, manifestSha256: manifest.sha256, ok, files: filesRun,
    tests: manifest.entries.map((e) => e.name), problems, at: new Date().toISOString(),
  });
  if (ok) {
    console.log(`platform-only leg: ${manifest.entries.length} named test(s) in ${filesRun.length} file(s) passed (sha ${sha}, manifest ${manifest.sha256})`);
    return EXIT.CLEAN;
  }
  for (const p of problems) console.log(`⛔ ${p}`);
  console.log(`platform-only leg: ${problems.length} problem(s) (sha ${sha})`);
  return EXIT.MISMATCH;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`⛔ could not run the platform-only leg: ${e.message}`);
  process.exitCode = EXIT.CANNOT_CHECK;
}
