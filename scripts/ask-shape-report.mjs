#!/usr/bin/env node
/**
 * scripts/ask-shape-report.mjs — #1251 item 2, at the command line.
 *
 *   node scripts/ask-shape-report.mjs [path/to/board-data.json] [--json]
 *
 * Reads the board document and reports, per (agent, wakeKind): how many model
 * calls, how many made no tool call, how many posted text having made none,
 * and how many carried an unbacked-lookup flag.
 *
 * The header is the CONTROLS, deliberately printed before any number. If they
 * fail, every count below them is unreadable and the verdict says so instead
 * of reporting a zero. Read-only: it opens the document and writes nothing.
 */
import { readFileSync } from 'node:fs';
import { askShapeReport } from '../core/ask-shape.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
// #837 — no default that points at a live data tree or a home directory. The
// path is named by the caller or the run does not happen: a tool that reads
// live board data by default eventually prints live board data into a CI log.
const file = args.find((a) => !a.startsWith('--')) || process.env.SCRUM_BOARD_DATA;
if (!file) {
  console.error('usage: node scripts/ask-shape-report.mjs <path/to/board-data.json> [--json]');
  console.error('   or: SCRUM_BOARD_DATA=<path> node scripts/ask-shape-report.mjs');
  console.error('(no default path by design — see #837)');
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  console.error('(this is a read failure, NOT a report of zero model calls)');
  process.exit(2);
}

const r = askShapeReport(doc);

if (asJson) {
  console.log(JSON.stringify({ file, ...r }, null, 2));
  process.exit(r.controls.ok ? 0 : 1);
}

console.log(`#1251 ask-shape report — ${file}\n`);
console.log('CONTROLS (a count below is only readable if these pass)');
for (const c of r.controls.results) {
  const mark = c.pass ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${c.name.padEnd(26)} expect ${c.expect}, got ${c.error ? `ERROR ${c.error}` : c.got}`);
  if (!c.pass) console.log(`       proves: ${c.proves}`);
}
console.log('');

const pad = (v, n) => String(v).padStart(n);
console.log('  agent        wakeKind      calls  noTool  posted  noToolPosted  flags  recomputed');
for (const g of r.groups) {
  console.log(`  ${g.agent.padEnd(12)} ${g.wakeKind.padEnd(12)} ${pad(g.calls, 5)} ${pad(g.noTool, 7)} `
    + `${pad(g.posted, 7)} ${pad(g.noToolPosted, 13)} ${pad(g.stored, 6)} ${pad(g.recomputed, 11)}`);
}
const t = r.totals;
console.log(`  ${'TOTAL'.padEnd(25)} ${pad(t.calls, 5)} ${pad(t.noTool, 7)} ${pad(t.posted, 7)} `
  + `${pad(t.noToolPosted, 13)} ${pad(t.stored, 6)} ${pad(t.recomputed, 11)}`);

if (r.disagreements.length) {
  console.log(`\nSTORED vs RECOMPUTED disagree on ${r.disagreements.length} row(s) — the RECORD is stale:`);
  for (const d of r.disagreements.slice(0, 20)) {
    console.log(`  ${d.at || '(no time)'} ${d.agent}: stored=${d.stored} recomputed=${d.recomputed}`);
  }
}

console.log(`\nVERDICT [${r.verdict.code}]\n  ${r.verdict.says}`);
process.exit(r.controls.ok ? 0 : 1);
