#!/usr/bin/env node
/**
 * #1690 — recover the CI leg's receipt from the job log of a specified run attempt.
 *
 *   gh run view <run> --attempt <n> --log > job.log
 *   node scripts/extract-ci-receipt.mjs job.log --run-id <run> --attempt <n> --head-sha <40-hex>
 *                                       [--job <name>] [--step <name>] [--out <file>]
 *
 * #837 keeps the receipt file on the runner, so check-platform-skips.mjs prints it as one `PLATFORM-RECEIPT <json>`
 * line. Only that line, in the checker step of the named job, counts: the suite prints whatever its tests print, and
 * a test that echoes the marker must not be able to supply the receipt. The log's lines are `<job>\t<step>\t<time> <text>`.
 * --job and --step default to the names in .github/workflows/ci.yml.
 *
 * The receipt must hold exactly the allowlisted fields with the right types, and its sha must be --head-sha (the
 * commit that run tested, from the run's own metadata). The output, with --out, is the file check-gate-pair.mjs reads.
 *
 * Exit 0 extracted · 1 the receipt's sha is not --head-sha, naming both · 2 cannot extract: a missing or empty log,
 * no marked line or more than one in that step, a field outside the allowlist, missing or of the wrong type, or a
 * missing --run-id, --attempt or --head-sha (fails closed).
 */
import fs from 'node:fs';
import { EXIT, CannotCheck, parseArgs, requireSha, RECEIPT_MARKER, MAX_PROBLEM } from './platform-gate-lib.mjs';

const DEFAULT_JOB = 'server suite';
const DEFAULT_STEP = 'Platform-only skips equal the manifest';

const HEX40 = /^[0-9a-f]{40}$/;
const FIELDS = {
  leg: (v) => v === 'ci',
  sha: (v) => typeof v === 'string' && HEX40.test(v),
  tree: (v) => typeof v === 'string' && HEX40.test(v),
  manifestSha256: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
  suiteExit: (v) => Number.isInteger(v),
  ok: (v) => typeof v === 'boolean',
  matched: (v) => v === null || Number.isInteger(v),
  problems: (v) => Array.isArray(v) && v.every((p) => typeof p === 'string' && p.length <= MAX_PROBLEM),
  at: (v) => typeof v === 'string',
};

function validate(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new CannotCheck('the marked line is not a JSON object');
  const extra = Object.keys(r).filter((k) => !(k in FIELDS));
  if (extra.length) throw new CannotCheck(`the receipt has fields outside the allowlist: ${extra.join(', ')}`);
  for (const [k, ok] of Object.entries(FIELDS)) {
    if (!(k in r)) throw new CannotCheck(`the receipt has no ${k}`);
    if (!ok(r[k])) throw new CannotCheck(`the receipt's ${k} is not valid`);
  }
  return r;
}

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const logFile = positional[0];
  if (!logFile) throw new CannotCheck('no log file given');
  for (const f of ['run-id', 'attempt']) {
    if (!flags[f] || !/^\d+$/.test(flags[f])) throw new CannotCheck(`--${f} must be a number, got ${flags[f] ? `"${flags[f]}"` : 'nothing'}`);
  }
  const headSha = requireSha(flags['head-sha']);
  const job = flags.job ?? DEFAULT_JOB;
  const step = flags.step ?? DEFAULT_STEP;
  const where = `run ${flags['run-id']} attempt ${flags.attempt}, job "${job}", step "${step}"`;

  let text;
  try { text = fs.readFileSync(logFile, 'utf8'); } catch (e) { throw new CannotCheck(`cannot read log ${logFile}: ${e.code ?? e.message}`); }
  if (!text.trim()) throw new CannotCheck(`log ${logFile} is empty`);

  const marked = [];
  for (const line of text.split(/\r?\n/)) {
    const [lineJob, lineStep, ...rest] = line.split('\t');
    if (lineJob !== job || lineStep !== step || rest.length === 0) continue;
    // `<timestamp> <text>`: the text starts after the first space.
    const body = rest.join('\t').replace(/^\S+ /, '');
    if (body.startsWith(`${RECEIPT_MARKER} `)) marked.push(body.slice(RECEIPT_MARKER.length + 1));
  }
  if (marked.length === 0) throw new CannotCheck(`no ${RECEIPT_MARKER} line in ${where}`);
  if (marked.length > 1) throw new CannotCheck(`ambiguous: ${marked.length} ${RECEIPT_MARKER} lines in ${where}, expected one`);

  let receipt;
  try { receipt = JSON.parse(marked[0]); } catch (e) { throw new CannotCheck(`the ${RECEIPT_MARKER} line in ${where} is not JSON: ${e.message}`); }
  validate(receipt);

  if (receipt.sha !== headSha) {
    console.log(`⛔ the receipt in ${where} is for ${receipt.sha}, not the run's head sha ${headSha}`);
    return EXIT.MISMATCH;
  }
  if (flags.out) fs.writeFileSync(flags.out, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`extracted the CI receipt from ${where}: sha ${receipt.sha}, tree ${receipt.tree}, ok ${receipt.ok}${flags.out ? `, written to ${flags.out}` : ''}`);
  return EXIT.CLEAN;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`⛔ could not extract the CI receipt: ${e.message}`);
  process.exitCode = EXIT.CANNOT_CHECK;
}
