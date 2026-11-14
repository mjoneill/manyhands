#!/usr/bin/env node
/**
 * #1851 (#1848 slice 2) — ONE LINKING RUN over one extraction Run: read its published claims from the graph, search each with
 * the board's own meaning search (POST /api/search, no model call of ours, nothing paid), and write the new "bears on" links
 * as one guarded link.propose. A pair that already has a link in ANY status is never proposed again.
 *
 *   node scripts/link-run.mjs --run <run IRI> --min-score <0..1> [--per-assertion 3] [--k 8] [--dry-run]
 *
 * --dry-run proposes and prints, and writes nothing: read it beside what you expected before you write. Prints ONE JSON summary
 * on stdout. A refused search or graph read writes nothing and exits 1 with the reason. A missing variable or flag exits 2
 * naming it (a NAME, never a value), before any network.
 *
 * Since #1852 the extractor links each run it publishes, at the values in the tracked knowledge-linking.json. This script is
 * unchanged and still takes its threshold as a flag: it is how a run whose links were not made is linked afterwards, and how
 * a different threshold is read with --dry-run before anyone changes that file.
 *
 * Environment (names, no values):
 *   SCRUM_BOARD_URL           REST                                (default http://127.0.0.1:3141)
 *   SCRUM_SEAT_TOKEN_FILE     the bearer token for the search      (required)
 *   SCRUM_GRAPH_EXECUTOR_URL  the graph executor                   (required)
 *   SCRUM_GRAPH_DATASET_ID    its dataset id                       (required)
 *   SCRUM_LINK_ACTOR          the seat key recorded as proposer    (default extractor: the same service that published the claims)
 */
import fs from 'node:fs';
import { createGraphClient } from '../core/graph-client.mjs';
import { linkRun, createRestSearch } from '../core/knowledge-linking.mjs';

const fail = (msg) => { console.error(`link-run: ${msg}`); process.exit(2); };
function need(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || !v.trim()) fail(`${name} is not set`);
  return v.trim();
}
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const tokenFile = need('SCRUM_SEAT_TOKEN_FILE');
const EXEC_URL = need('SCRUM_GRAPH_EXECUTOR_URL');
const DATASET = need('SCRUM_GRAPH_DATASET_ID');
const BOARD = (process.env.SCRUM_BOARD_URL || 'http://127.0.0.1:3141').replace(/\/$/, '');
const ACTOR = (process.env.SCRUM_LINK_ACTOR || 'extractor').trim();
const run = flag('--run');
if (!run || !/^https:\/\/scrumboard\.local\//.test(run)) fail('--run <run IRI> is required (https://scrumboard.local/…)');
const minRaw = flag('--min-score');
if (minRaw == null) fail('--min-score <0..1> is required: the threshold is config, never a hidden default');
const minScore = Number(minRaw);
if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) fail('--min-score must be a number in [0, 1]');
const perAssertion = Number(flag('--per-assertion') ?? 3);
const k = Number(flag('--k') ?? 8);
if (!Number.isInteger(perAssertion) || perAssertion < 1) fail('--per-assertion must be an integer >= 1');
if (!Number.isInteger(k) || k < perAssertion) fail('--k must be an integer >= --per-assertion');
const dryRun = argv.includes('--dry-run');

let token;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { fail(`SCRUM_SEAT_TOKEN_FILE is unreadable (${e.code || 'error'})`); }
if (!token) fail('SCRUM_SEAT_TOKEN_FILE is empty');

const graphClient = createGraphClient({ baseUrl: EXEC_URL, expectedDatasetId: DATASET, timeoutMs: 30_000, label: 'link-run' });
const search = createRestSearch({ base: BOARD, token, by: ACTOR, k });
const r = await linkRun({ graphClient, search, run, minScore, perAssertion, model: () => search.model(), actor: `https://scrumboard.local/person/${ACTOR}`, dryRun });
const summary = { run, minScore, perAssertion, k, dryRun, model: search.model(), ...r,
  ...(r.links ? { links: r.links.map((l) => ({ card: l.shortId, score: l.score, query: l.query, assertion: l.assertion })) } : {}) };
console.log(JSON.stringify(summary, null, 2));
process.exit(r.ok ? 0 : 1);
