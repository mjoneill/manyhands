#!/usr/bin/env node
/**
 * #1570 — project the event log's activities and the work ledger's actions into the executor.
 *
 *   node scripts/activity-projector.mjs --log <dir> --work <dir> --executor <url> [--once] [--batch N] [--tick-ms N]
 *
 * --once   run until caught up, then exit 0 (a run with nothing to do sends no update); exit 3 when the
 *          newest segment ends in an unterminated line — waiting for a complete record is not caught up
 * default  keep running: catch up, then look again every --tick-ms (1000)
 *
 * All three inputs are FLAGS and only flags. A missing one exits non-zero naming it; an environment
 * variable never stands in for one (a default that points at the live executor is how a test run
 * writes into production).
 */
import { projectUntilCaughtUp } from '../core/activity-projector.mjs';

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') { out.once = true; continue; }
    if (['--log', '--work', '--executor', '--batch', '--tick-ms'].includes(a)) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) { out.bad = `${a} needs a value`; break; }
      out[a.slice(2)] = v; i++; continue;
    }
    out.bad = `unknown argument ${a}`; break;
  }
  return out;
}

const args = parse(process.argv.slice(2));
const missing = ['log', 'work', 'executor'].filter((k) => !args[k]);
if (args.bad || missing.length) {
  console.error(`activity-projector: ${args.bad ?? `missing ${missing.map((k) => `--${k}`).join(', ')}`} (no defaults: every input is passed explicitly)`);
  process.exit(2);
}
const batchSize = args.batch ? Number(args.batch) : 500;
const tickMs = args['tick-ms'] ? Number(args['tick-ms']) : 1000;
if (!Number.isInteger(batchSize) || batchSize < 1) { console.error('activity-projector: --batch must be a positive integer'); process.exit(2); }
if (!Number.isInteger(tickMs) || tickMs < 100) { console.error('activity-projector: --tick-ms must be an integer >= 100'); process.exit(2); }

const opts = { logDir: args.log, workDir: args.work, executorUrl: args.executor.replace(/\/$/, ''), batchSize };
const log = (m) => console.log(`${new Date().toISOString()} activity-projector: ${m}`);

if (args.once) {
  try {
    const r = await projectUntilCaughtUp(opts, { log });
    if (r.pendingTail) {
      // NOT caught up: the newest segment ends in an unterminated line. Waiting is right; calling it done is not.
      console.error(`activity-projector: WAITING for a complete record at line ${r.pendingTail.line} of ${r.pendingTail.segment} (${r.projected} item(s) this run; cursor seq=${r.cursor.seq})`);
      process.exit(3);
    }
    log(`caught up: ${r.projected} item(s) this run; cursor seq=${r.cursor.seq} workRows=${r.cursor.workRows}`);
    process.exit(0);
  } catch (e) {
    console.error(`activity-projector: FAILED: ${e.message}`);
    process.exit(1);
  }
}
for (;;) {
  try {
    const r = await projectUntilCaughtUp(opts, { log });
    if (r.pendingTail) log(`waiting for a complete record at line ${r.pendingTail.line} of ${r.pendingTail.segment}`);
    else if (r.projected) log(`caught up: cursor seq=${r.cursor.seq} workRows=${r.cursor.workRows}`);
  } catch (e) {
    console.error(`${new Date().toISOString()} activity-projector: run failed, will look again: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, tickMs));
}
