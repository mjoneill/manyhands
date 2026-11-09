#!/usr/bin/env node
/**
 * #1854 slice 1 — run ONE file the owner named through the knowledge-extraction job (core/knowledge-extraction-file.mjs).
 *
 *   node scripts/extract-file.mjs <file.pdf> --asked-in <post id>
 *
 * `--asked-in` is the commons post in which the owner asked for this file to be extracted: it becomes the Source's
 * wasDerivedFrom, so the run is traceable to the ask. Each run is a paid model call, so a file whose job already has an
 * outcome is not run again (same bytes = same job, whatever the file is called).
 *
 * The wiring is extract-once's: the same model registry entry, the same predicate allow-list, the same graph client,
 * the same board adapter, the same extractor. Environment, by NAME (values are never printed):
 *   OPENROUTER_API_KEY (from the Keychain: security find-generic-password -s OPENROUTER_API_KEY -w)
 *   SCRUM_SEAT_TOKEN_FILE, SCRUM_GRAPH_EXECUTOR_URL, SCRUM_GRAPH_DATASET_ID, SCRUM_EXTRACT_SOURCES_DIR   (required)
 *   SCRUM_BOARD_URL, SCRUM_EXTRACT_MODEL_KEY, SCRUM_EXTRACT_PROMPT                                     (optional)
 */
import fs from 'node:fs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createExtractor } from '../core/knowledge-extraction.mjs';
import { createRestBoard, createOpenRouterModel } from '../core/knowledge-extraction-adapters.mjs';
import { extractFile, convertFile } from '../core/knowledge-extraction-file.mjs';

const ACTOR = 'extractor';
const DEFAULT_PROMPT = 'Extract what this source says: its concepts, the claims it makes about them, and a short synopsis.';
const fail = (msg, code = 2) => { console.error(`extract-file: ${msg}`); process.exit(code); };

const args = process.argv.slice(2);
const at = args.indexOf('--asked-in');
const askedIn = at >= 0 ? args[at + 1] : null;
const file = args.find((a, i) => !a.startsWith('--') && i !== at + 1);
if (!file || !askedIn) fail('usage: extract-file.mjs <file> --asked-in <post id>');
if (!fs.existsSync(file)) fail(`no such file: ${file}`);
// convert FIRST: an unsupported or empty file is refused before the key is even looked at, and before any network
try { convertFile(file); } catch (e) { fail(e.message); }

function need(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || !v.trim()) fail(`${name} is not set`);
  return v.trim();
}
const apiKey = need('OPENROUTER_API_KEY');
const BOARD = (process.env.SCRUM_BOARD_URL || 'http://127.0.0.1:3141').replace(/\/$/, '');
const tokenFile = need('SCRUM_SEAT_TOKEN_FILE');
const EXEC_URL = need('SCRUM_GRAPH_EXECUTOR_URL');
const DATASET = need('SCRUM_GRAPH_DATASET_ID');
const SOURCES_DIR = need('SCRUM_EXTRACT_SOURCES_DIR');
const MODEL_KEY = (process.env.SCRUM_EXTRACT_MODEL_KEY || 'deepseek-v4-flash').trim();
const PROMPT = process.env.SCRUM_EXTRACT_PROMPT || DEFAULT_PROMPT;

let token;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { fail(`SCRUM_SEAT_TOKEN_FILE unreadable (${e.code || 'error'})`); }
if (!token) fail('SCRUM_SEAT_TOKEN_FILE is empty');

const getJson = async (p) => {
  const r = await fetch(`${BOARD}${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return r.json();
};

async function main() {
  // the asking post must exist: a wasDerivedFrom pointing at nothing is a provenance claim nobody can check
  const post = await fetch(`${BOARD}/api/conversations/${encodeURIComponent(askedIn)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!post.ok) fail(`--asked-in ${askedIn}: the board answered ${post.status}; name the post that asked for this file`);
  const models = await getJson('/api/models');
  const entry = (Array.isArray(models) ? models : []).find((m) => m.key === MODEL_KEY);
  if (!entry?.model || !entry?.baseUrl) fail(`no usable registered model with key ${JSON.stringify(MODEL_KEY)}`);
  const predicates = await getJson('/api/predicates');
  const registry = new Set((Array.isArray(predicates) ? predicates : predicates?.predicates ?? []).map((p) => p.name).filter(Boolean));
  if (!registry.has('scrum:relatedTo')) fail('the registry does not hold scrum:relatedTo; refusing to run');

  const graphClient = createGraphClient({ baseUrl: EXEC_URL, expectedDatasetId: DATASET, timeoutMs: 30_000, label: 'extractor' });
  const board = createRestBoard({ baseUrl: BOARD, token, by: ACTOR });
  const model = createOpenRouterModel({ apiKey, baseUrl: entry.baseUrl, modelId: entry.model, ledger: board, by: ACTOR });
  const extractor = createExtractor({ graphClient, runs: board, model, registry, actor: ACTOR });
  const summary = await extractFile({ file, extractor, sourcesDir: SOURCES_DIR, modelKey: MODEL_KEY, prompt: PROMPT, askedIn });
  console.log(JSON.stringify({ at: new Date().toISOString(), modelKey: MODEL_KEY, model: entry.model, ...summary }, null, 2));
}

main().catch((e) => fail(String(e?.message ?? e).replace(/Bearer \S+/g, 'Bearer [redacted]'), 1));
