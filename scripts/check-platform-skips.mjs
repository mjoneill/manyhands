#!/usr/bin/env node
/**
 * #1690 — the CI leg of the platform-split landing gate (decision 45a5d8e4).
 *
 *   node scripts/check-platform-skips.mjs <tap-file> --manifest <path> --sha <40-hex> [--receipt <path>]
 *
 * CI runs every test it can. The only skips it may show are the manifest's platform-only tests, each skipped as
 * UNAVAILABLE, and the manifest must equal that set exactly:
 *   · a manifest test that RAN, or does not appear at all, is refused (it is no longer platform-only, or it moved)
 *   · an UNAVAILABLE skip the manifest does not list is refused (the list grew without anyone deciding it)
 *   · a skip for ANY other reason, including a bare `# SKIP`, is refused (a skip is not a pass)
 * TODO rows are not skips and are not judged here.
 *
 * Exit 0 clean · 1 mismatch, naming each test · 2 could not check (empty or missing TAP, a TAP with no test
 * lines, a missing, empty or malformed manifest). The receipt records the leg, the sha, the manifest's content
 * hash and the verdict, for check-gate-pair.mjs.
 */
import fs from 'node:fs';
import { EXIT, CannotCheck, parseArgs, readManifest, parseTap, isPlatformSkip, writeReceipt, requireSha } from './platform-gate-lib.mjs';

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const tapFile = positional[0];
  if (!tapFile) throw new CannotCheck('no TAP file given');
  const sha = requireSha(flags.sha);
  const manifest = readManifest(flags.manifest);

  let text;
  try { text = fs.readFileSync(tapFile, 'utf8'); } catch (e) { throw new CannotCheck(`cannot read TAP ${tapFile}: ${e.code ?? e.message}`); }
  const tests = parseTap(text);
  if (tests.length === 0) throw new CannotCheck(`TAP ${tapFile} has no test lines`);

  const listed = new Set(manifest.entries.map((e) => e.name));
  const problems = [];

  // The runner reprints failing rows in a FAILURES section, so a name can appear twice; judge each name once,
  // and a name that skipped as UNAVAILABLE anywhere counts as skipped.
  const byName = new Map();
  for (const t of tests) {
    const prev = byName.get(t.name);
    if (!prev || (isPlatformSkip(t) && !isPlatformSkip(prev))) byName.set(t.name, t);
  }

  for (const name of listed) {
    const t = byName.get(name);
    if (!t) problems.push(`manifest test did not appear in the run: ${name}`);
    else if (!isPlatformSkip(t)) problems.push(`manifest test was not skipped as UNAVAILABLE (${t.directive ?? (t.ok ? 'ran' : 'failed')}): ${name}`);
  }
  for (const t of byName.values()) {
    if (t.directive !== 'SKIP') continue;
    if (!isPlatformSkip(t)) problems.push(`skipped for a reason that is not a platform skip (${t.reason || 'no reason given'}): ${t.name}`);
    else if (!listed.has(t.name)) problems.push(`UNAVAILABLE skip not listed in the manifest: ${t.name}`);
  }

  const ok = problems.length === 0;
  writeReceipt(flags.receipt, {
    leg: 'ci', sha, manifestSha256: manifest.sha256, ok,
    matched: ok ? listed.size : null, problems, at: new Date().toISOString(),
  });
  if (ok) {
    console.log(`platform skips: ${listed.size} of ${listed.size} manifest tests skipped as UNAVAILABLE, and no other skips (sha ${sha}, manifest ${manifest.sha256})`);
    return EXIT.CLEAN;
  }
  for (const p of problems) console.log(`⛔ ${p}`);
  console.log(`platform skips: ${problems.length} mismatch(es) against the manifest (sha ${sha})`);
  return EXIT.MISMATCH;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`⛔ could not check platform skips: ${e.message}`);
  // Any failure to finish the check, expected or not, fails closed.
  process.exitCode = EXIT.CANNOT_CHECK;
}
