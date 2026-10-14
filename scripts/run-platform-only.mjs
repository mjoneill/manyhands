#!/usr/bin/env node
/**
 * #1690 — the Mac leg of the platform-split landing gate (decision 45a5d8e4).
 *
 *   node scripts/run-platform-only.mjs --manifest <path> --sha <40-hex> [--root <checkout>] [--receipt <path>]
 *
 * Runs ONLY the manifest's named tests: each listed file, restricted by an exact, anchored --test-name-pattern to
 * the names listed for it. A file the manifest does not list is never started, and a test the manifest does not
 * name is never run even when it shares a file with one that is named (commons 42090). This leg exists so the
 * heavy full suite does not have to run on the production host (10-14: 127 board 503s across six full runs); it
 * must never become that run again.
 *
 * Every named test must report a plain pass, and each file's test process must exit 0 without a signal. Skipped,
 * failed, renamed or missing tests, missing files or files outside the checkout, and a child that ends badly after
 * its rows passed all fail the leg and are named. The commit is verified, not declared: --root must be a git
 * checkout whose HEAD is --sha with no modified tracked file, and the receipt carries that HEAD's tree. Exit 0 clean · 1 mismatch · 2 could not check (missing, empty or malformed manifest;
 * no sha). The receipt records the leg, the sha, the manifest's content hash, the files actually run and the
 * verdict, for check-gate-pair.mjs. A sha that is not the checkout's HEAD, or a dirty tree, also exits 2.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CannotCheck, parseArgs, readManifest, parseTap, writeReceipt, verifyCheckout } from './platform-gate-lib.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main(argv) {
  const { flags } = parseArgs(argv);
  const root = path.resolve(flags.root ?? process.cwd());
  const { sha, tree } = verifyCheckout(root, flags.sha);
  const manifest = readManifest(flags.manifest);

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
    if (!abs.startsWith(root + path.sep)) {
      problems.push(`manifest file is outside the checkout and was not run: ${file}`);
      continue;
    }
    if (!fs.existsSync(abs)) {
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
      // Named coverage means an ordinary pass: a SKIP or a TODO ran nothing that counts (review of 8e4cbc4).
      else if (t.directive === 'SKIP') problems.push(`named test was skipped (${t.reason || 'no reason given'}): ${name} (${file})`);
      else if (t.directive === 'TODO') problems.push(`named test is marked TODO, which is not a pass (${t.reason || 'no reason given'}): ${name} (${file})`);
      else if (!t.ok) problems.push(`named test failed: ${name} (${file})`);
    }
    // The named rows passing is not enough: a child that exits non-zero or is killed after them did not end clean
    // (review of the first build).
    if (r.error) problems.push(`could not run ${file}: ${r.error.message}`);
    else if (r.signal) problems.push(`the test process for ${file} was killed by ${r.signal}`);
    else if (r.status !== 0) problems.push(`the test process for ${file} exited ${r.status}`);
  }

  const ok = problems.length === 0;
  writeReceipt(flags.receipt, {
    leg: 'mac', sha, tree, manifestSha256: manifest.sha256, ok, files: filesRun,
    tests: manifest.entries.map((e) => e.name), problems, at: new Date().toISOString(),
  });
  if (ok) {
    console.log(`platform-only leg: ${manifest.entries.length} named test(s) in ${filesRun.length} file(s) passed (sha ${sha}, tree ${tree}, manifest ${manifest.sha256})`);
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
