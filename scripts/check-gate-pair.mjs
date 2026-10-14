#!/usr/bin/env node
/**
 * #1690 — one commit, one manifest: does a CI receipt and a Mac receipt make a complete landing gate?
 *
 *   node scripts/check-gate-pair.mjs <ci-receipt> <mac-receipt>
 *
 * Both legs must name the same 40-character sha, the same tree and the same manifest content hash, the CI suite
 * must have exited 0, and both legs must be clean. A
 * green Mac receipt from an older head cannot complete a newer CI run (commons 42088). Exit 0 complete · 1 the
 * legs disagree or one is red, naming both values · 2 a receipt is missing, unreadable or lacks its sha, tree,
 * manifest hash, verdict or (CI) suite exit.
 */
import fs from 'node:fs';
import { EXIT, CannotCheck } from './platform-gate-lib.mjs';

function read(file, leg) {
  if (!file) throw new CannotCheck(`no ${leg} receipt given`);
  let r;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new CannotCheck(`cannot read ${leg} receipt ${file}: ${e.code ?? e.message}`); }
  if (typeof r?.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(r.sha)) throw new CannotCheck(`${leg} receipt ${file} has no sha`);
  if (typeof r.manifestSha256 !== 'string' || !r.manifestSha256) throw new CannotCheck(`${leg} receipt ${file} has no manifest hash`);
  if (typeof r.tree !== 'string' || !r.tree) throw new CannotCheck(`${leg} receipt ${file} has no tree`);
  if (typeof r.ok !== 'boolean') throw new CannotCheck(`${leg} receipt ${file} has no verdict`);
  if (leg === 'CI' && !Number.isInteger(r.suiteExit)) throw new CannotCheck(`CI receipt ${file} has no suite exit status`);
  return r;
}

function main([ciFile, macFile]) {
  const ci = read(ciFile, 'CI');
  const mac = read(macFile, 'Mac');
  const problems = [];
  if (ci.sha.toLowerCase() !== mac.sha.toLowerCase()) problems.push(`the legs tested different commits: CI ${ci.sha}, Mac ${mac.sha}`);
  // The sha is a label; the tree is what was tested. A PR's merge ref can carry a head-sha label over another tree.
  if (ci.tree !== mac.tree) problems.push(`the legs tested different trees: CI ${ci.tree}, Mac ${mac.tree}`);
  if (ci.suiteExit !== 0) problems.push(`the CI suite exited ${ci.suiteExit}, not 0`);
  if (ci.manifestSha256 !== mac.manifestSha256) problems.push(`the legs read different manifests: CI ${ci.manifestSha256}, Mac ${mac.manifestSha256}`);
  if (!ci.ok) problems.push(`the CI leg is not clean (sha ${ci.sha})`);
  if (!mac.ok) problems.push(`the Mac leg is not clean (sha ${mac.sha})`);
  if (problems.length === 0) {
    console.log(`landing gate complete: CI and Mac legs both clean at ${ci.sha} (tree ${ci.tree}), manifest ${ci.manifestSha256}`);
    return EXIT.CLEAN;
  }
  for (const p of problems) console.log(`⛔ ${p}`);
  return EXIT.MISMATCH;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`⛔ could not check the gate pair: ${e.message}`);
  process.exitCode = EXIT.CANNOT_CHECK;
}
