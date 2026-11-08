#!/usr/bin/env node
/**
 * #1810 — the knowledge-extraction service, ONE TICK per launch. launchd runs this on an interval in guestwake's
 * shape (scripts/launchd/com.scrumboard.extractor.plist.template): the OpenRouter key arrives in the ENVIRONMENT,
 * loaded from the Keychain by the job's own shell line, and nothing here reads it from a file or prints it.
 *
 * A tick: read the commons posts since the cursor, find https links shared by people, and for each new URL fetch the
 * bytes, keep them on disk, and run the extraction as a checkpointed LangGraph job (core/knowledge-extraction.mjs);
 * the job's assertions reach the graph as quoted reifiers, its run record reaches the board, every model call lands
 * in the ledger. Then print one JSON summary on stdout and exit 0. Any failure to START prints one line on stderr
 * naming what is missing (a variable's NAME, never a value) and exits 2, before any network call.
 *
 * A link is extracted once. If its job FAILED, a sharer re-posts it with the word "re-run" in the same post, and the
 * next tick makes one fresh attempt (job id `.r1`, then `.r2`, at most 3) whose summary names the failed run (#1841).
 * A link that once succeeded is never re-run.
 *
 * Environment (names, no values):
 *   OPENROUTER_API_KEY            the key, from the Keychain via the plist      (required, checked FIRST)
 *   SCRUM_BOARD_URL               REST                                           (default http://127.0.0.1:3141)
 *   SCRUM_SEAT_TOKEN_FILE         this seat's bearer token, one line             (required)
 *   SCRUM_GRAPH_EXECUTOR_URL      the graph executor                             (required)
 *   SCRUM_GRAPH_DATASET_ID        its dataset id                                 (required)
 *   SCRUM_EXTRACT_STATE_FILE      the cursor and its family (commit on a graph-served board, seq on a document-served
 *                                 one; chosen by asking the board). ABSENT on a fresh install: the first tick begins
 *                                 at the head and reads nothing older. Never seed it with "start" (#1837).   (required)
 *   SCRUM_EXTRACT_SOURCES_DIR     where fetched bytes are kept                   (required)
 *   SCRUM_EXTRACT_MODEL_KEY       the registry key of the model to run           (default deepseek-v4-flash, the owner's choice in 49176)
 *   SCRUM_EXTRACT_PROMPT          the extraction prompt text                     (default below)
 *   SCRUM_EXTRACT_SHARERS         comma-separated authors whose links become jobs (required: the PO's ruling, 51192 — the owner's
 *                                 shares, not seats' links; the roster cannot tell a person from a seat, so this is configuration)
 *   SCRUM_EXTRACT_ALLOW_HTTP_SOURCES=1     accept http:// links too          (tests on loopback only; never set in production)
 *   SCRUM_EXTRACT_ALLOW_PRIVATE_SOURCES=1  accept loopback/private hosts     (tests on loopback only; never set in production)
 */
import fs from 'node:fs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createExtractor } from '../core/knowledge-extraction.mjs';
import { createRestBoard, createOpenRouterModel } from '../core/knowledge-extraction-adapters.mjs';
import { createIntake } from '../core/knowledge-extraction-intake.mjs';
import { createFetcher } from '../core/knowledge-extraction-fetch.mjs';

const ACTOR = 'extractor';
const DEFAULT_PROMPT = 'Extract what this source says: its concepts, the claims it makes about them, and a short synopsis.';

function need(name, hint) {
  const v = process.env[name];
  if (typeof v !== 'string' || !v.trim()) {
    console.error(`extract-once: ${name} is not set${hint ? `. ${hint}` : ''}`);
    process.exit(2);
  }
  return v.trim();
}

// ⛔ FIRST, before any network: the key. Its NAME is the only thing ever written anywhere.
const apiKey = need('OPENROUTER_API_KEY', 'The launchd job loads it from the Keychain into the environment (security find-generic-password -s OPENROUTER_API_KEY -w); nothing reads it from a file.');
const BOARD = (process.env.SCRUM_BOARD_URL || 'http://127.0.0.1:3141').replace(/\/$/, '');
const tokenFile = need('SCRUM_SEAT_TOKEN_FILE', 'The seat\'s bearer token, one line.');
const EXEC_URL = need('SCRUM_GRAPH_EXECUTOR_URL');
const DATASET = need('SCRUM_GRAPH_DATASET_ID');
const STATE_FILE = need('SCRUM_EXTRACT_STATE_FILE');
const SOURCES_DIR = need('SCRUM_EXTRACT_SOURCES_DIR');
const MODEL_KEY = (process.env.SCRUM_EXTRACT_MODEL_KEY || 'deepseek-v4-flash').trim();
const PROMPT = process.env.SCRUM_EXTRACT_PROMPT || DEFAULT_PROMPT;
const ALLOW_HTTP = process.env.SCRUM_EXTRACT_ALLOW_HTTP_SOURCES === '1';
const ALLOW_PRIVATE = process.env.SCRUM_EXTRACT_ALLOW_PRIVATE_SOURCES === '1';
const SHARERS = new Set(need('SCRUM_EXTRACT_SHARERS', 'Comma-separated authors whose shared links become jobs (the owner\'s key). Nothing runs for nobody.').split(',').map((x) => x.trim()).filter(Boolean));

let token;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { console.error(`extract-once: SCRUM_SEAT_TOKEN_FILE unreadable (${e.code || 'error'})`); process.exit(2); }
if (!token) { console.error('extract-once: SCRUM_SEAT_TOKEN_FILE is empty'); process.exit(2); }

const getJson = async (path) => {
  const r = await fetch(`${BOARD}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
};

async function main() {
  // the model, from the board's registry by key: the provider's model id and base url (never the key)
  const models = await getJson('/api/models');
  const entry = (Array.isArray(models) ? models : []).find((m) => m.key === MODEL_KEY);
  if (!entry) { console.error(`extract-once: no registered model with key ${JSON.stringify(MODEL_KEY)} (SCRUM_EXTRACT_MODEL_KEY)`); process.exit(2); }
  if (!entry.model || !entry.baseUrl) { console.error(`extract-once: registry entry ${MODEL_KEY} lacks model or baseUrl`); process.exit(2); }
  // the writer's allow-list: the registered predicates, by name
  const predicates = await getJson('/api/predicates');
  const registry = new Set((Array.isArray(predicates) ? predicates : predicates?.predicates ?? []).map((p) => p.name).filter(Boolean));
  if (!registry.has('scrum:relatedTo')) { console.error('extract-once: the registry does not hold scrum:relatedTo, the generic relation the writer publishes under; refusing to run'); process.exit(2); }

  const graphClient = createGraphClient({ baseUrl: EXEC_URL, expectedDatasetId: DATASET, timeoutMs: 30_000, label: 'extractor' });
  const board = createRestBoard({ baseUrl: BOARD, token, by: ACTOR });
  const model = createOpenRouterModel({ apiKey, baseUrl: entry.baseUrl, modelId: entry.model, ledger: board, by: ACTOR });
  const extractor = createExtractor({ graphClient, runs: board, model, registry, actor: ACTOR });
  const fetchSource = createFetcher({ allowHttp: ALLOW_HTTP, allowPrivate: ALLOW_PRIVATE });
  const intake = createIntake({ boardUrl: BOARD, token, stateFile: STATE_FILE, sourcesDir: SOURCES_DIR, fetchSource, extractor, modelKey: MODEL_KEY, prompt: PROMPT, sharers: SHARERS, allowHttp: ALLOW_HTTP });
  const summary = await intake.tick();
  console.log(JSON.stringify({ at: new Date().toISOString(), modelKey: MODEL_KEY, model: entry.model, ...summary }));
}

main().catch((e) => {
  // never the key: errors are reported by message, and the key is only ever in a header
  console.error(`extract-once: ${String(e?.message ?? e).replace(/Bearer \S+/g, 'Bearer [redacted]')}`);
  process.exit(1);
});
