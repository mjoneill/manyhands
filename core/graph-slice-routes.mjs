/**
 * #1558 slice — the flagged HTTP surface of the graph write/read path.
 * OFF unless SCRUM_GRAPH_EXECUTOR_URL is set; the trial controls are OFF unless
 * SCRUM_TRIAL_EXECUTOR_STORE is also set (this process then owns the executor).
 *
 *   POST /api/graph/correct      a correction intention → the D2 outcome (+ this request's legacy-path counts)
 *   POST /api/graph/assert       a plain assertion (binding, or a non-binding observation)
 *   POST /api/graph/grant|rule   trial bootstrap seeding — NEVER a production permission policy
 *   GET  /api/graph/authority    ?subject=&predicate=&scope= → the D1 envelope (a reviewer's resolver)
 *   GET  /api/trial/counters     process-wide legacy-path counters + executor health
 *   POST /api/trial/executor/stop|start   (trial only)
 *
 * ⚠️ KNOWN GAPS (#1559, named before anyone found them): the intention's actor
 * is NOT bound to the authenticated seat, and nothing checks WHO may create a
 * grant or rule. The trial's actors are fabricated. Both must close before any
 * real data reaches these routes.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from './graph-client.mjs';
import { legacyCounters } from './legacy-counters.mjs';
import { authorizeWrite, parseAdmins, trialBypassFromEnv } from './graph-auth.mjs';
import { STATUS_MEANING } from './authority-meaning.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function graphSliceConfig(env = process.env) {
  const url = env.SCRUM_GRAPH_EXECUTOR_URL || null;
  return {
    enabled: !!url,
    url,
    datasetId: env.SCRUM_GRAPH_DATASET_ID || null,
    trialStore: env.SCRUM_TRIAL_EXECUTOR_STORE || null,
    python: env.GRAPH_EXECUTOR_PYTHON || path.join(HERE, '..', 'graph-executor', '.venv', 'bin', 'python'),
    executorLog: env.SCRUM_TRIAL_EXECUTOR_LOG || null,
  };
}

async function loadResolverFactory() {
  try {
    const m = await import('./authority-resolver.mjs');
    return typeof m.createAuthorityResolver === 'function' ? m.createAuthorityResolver : null;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
}

/**
 * Build the slice. `getContext` returns the per-request context (where the
 * legacy counters land); `sendJSON`/`readBody` are the server's own helpers.
 */
export function createGraphSlice({ config = graphSliceConfig(), getContext = () => null, sendJSON, readBody }) {
  if (!config.enabled) return { enabled: false, routes: [] };
  // FENCING (#1567 PC3): the slice never serves a store it was not told to serve.
  if (!config.datasetId) throw new Error('graph slice: SCRUM_GRAPH_DATASET_ID is required when SCRUM_GRAPH_EXECUTOR_URL is set (fencing)');
  const client = createGraphClient({ baseUrl: config.url, expectedDatasetId: config.datasetId });
  // #1559 WHO MAY WRITE: decided at startup (a flagged bypass without launcher isolation refuses
  // to start) and on every write (core/graph-auth.mjs).
  const trialBypass = (config.trialBypassFromEnv ?? trialBypassFromEnv)(config.env ?? process.env).active;
  const grantAdmins = parseAdmins((config.env ?? process.env).SCRUM_GRAPH_GRANT_ADMINS);
  // Checked on EVERY graph request, before anything is dispatched: an executor can be restarted
  // on another store behind the same URL, so a one-time startup check would go stale. ~1 ms.
  async function fence() {
    const id = await client.datasetIdentity();
    if (id.ok) return null;
    return id.status === 'REFUSED'
      ? `dataset-identity-mismatch: refused before dispatch (${id.reason})`
      : `executor unreadable: ${id.reason}`;
  }
  let resolver = null;

  // ── trial-owned executor ──
  let child = null;
  const port = Number(new URL(config.url).port);
  function startExecutor() {
    if (!config.trialStore) throw new Error('trial executor control is off (SCRUM_TRIAL_EXECUTOR_STORE unset)');
    if (child) return Promise.resolve({ already: true });
    const args = [path.join(HERE, '..', 'graph-executor', 'executor.py'), '--store', config.trialStore, '--port', String(port), '--dataset-id', config.datasetId];
    if (config.executorLog) args.push('--log', config.executorLog);
    // stdin stays open as a lifeline: if this server dies, even by SIGKILL, the pipe
    // closes and the executor exits instead of holding the store's lock as an orphan.
    args.push('--exit-on-stdin-eof');
    return new Promise((resolve, reject) => {
      const p = spawn(config.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; if (out.includes('\n') && !child) { child = p; resolve(JSON.parse(out.split('\n')[0])); } });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => { if (child === p) child = null; reject(new Error(`executor exited ${code}: ${err.slice(0, 300)}`)); });
    });
  }
  function stopExecutor() {
    if (!child) return { already: true };
    const p = child; child = null;
    p.kill('SIGKILL');
    return { stopped: true };
  }

  // D1 unavailable envelope — same keys as authority-resolver's own UNAVAILABLE branch (core/authority-resolver.mjs:82).
  // Coordinates are the requested ones (or null when the caller did not supply them); evaluationTime is the caller-supplied
  // string, or a server-supplied ISO string when the caller did not supply one. reason carries the exact current
  // explanation; observedRevision stays null.
  function unavailableEnvelope({ topic, predicate, scope, evaluationTime }, reason) {
    return {
      status: 'UNAVAILABLE',
      meaning: STATUS_MEANING.UNAVAILABLE,
      topic, predicate, scope, evaluationTime,
      observedRevision: null,
      currentAuthorities: [],
      otherAssertions: [],
      retirements: [],
      governingRules: [],
      reason,
      completeness: 'incomplete',
    };
  }

  async function write(req, res, kind) {
    const t0 = performance.now();
    let intention;
    try { intention = JSON.parse(await readBody(req)); } catch {
      return sendJSON(res, 400, { outcome: 'REJECTED', reason: 'validation: body is not JSON' });
    }
    // #1343's body door fills `by` with the authenticated seat on every POST under SCRUM_AUTH=required.
    // An intention has no `by`: remove ONLY that exact server fill. A caller-supplied `by` (which the door
    // rewrites into `onBehalfOf`) stays, and the compiler refuses it as an unknown field.
    if (req.auth?.enforced && intention && typeof intention === 'object' && intention.by === req.auth.seat
      && !Object.prototype.hasOwnProperty.call(intention, 'onBehalfOf')) {
      const { by: _serverFill, ...rest } = intention;
      intention = rest;
    }
    if (intention?.kind !== kind) {
      return sendJSON(res, 400, { outcome: 'REJECTED', reason: `validation: this route takes kind "${kind}"` });
    }
    // fence first: a store that is not this board's refuses everyone, whoever asks
    const fenced = await fence();
    if (fenced) return sendJSON(res, 200, { outcome: 'UNAVAILABLE', reason: fenced, ms: +(performance.now() - t0).toFixed(3), legacy: getContext()?.legacy ?? null });
    const refused = authorizeWrite({ auth: req.auth, kind, actor: intention.actor, admins: grantAdmins, trialBypass });
    if (refused) return sendJSON(res, 200, { outcome: 'REJECTED', reason: `validation: ${refused}`, ms: +(performance.now() - t0).toFixed(3), legacy: getContext()?.legacy ?? null });
    const r = await client.update(intention);
    const ctx = getContext();
    sendJSON(res, 200, { ...r, ms: +(performance.now() - t0).toFixed(3), legacy: ctx?.legacy ?? null });
  }

  async function authority(req, res) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    // Assemble coordinates and the evaluation time once, before the factory or fence, so the unavailable envelope
    // for any branch (resolver missing, executor unreadable, identity mismatch) carries the same shape.
    const coords = {
      topic: q.get('topic'), predicate: q.get('predicate'), scope: q.get('scope'),
      // the server supplies an explicit evaluation time when the caller omits one
      evaluationTime: q.get('evaluationTime') || new Date().toISOString(),
    };
    const ctx = getContext();
    const factory = await loadResolverFactory();
    if (!factory) return sendJSON(res, 503, { ...unavailableEnvelope(coords, 'resolver not installed'), legacy: ctx?.legacy ?? null });
    const fenced = await fence();
    if (fenced) return sendJSON(res, 200, { ...unavailableEnvelope(coords, fenced), legacy: ctx?.legacy ?? null });
    resolver ??= factory({ query: client.query });
    const envelope = await resolver.resolve(coords);
    sendJSON(res, 200, { ...envelope, legacy: ctx?.legacy ?? null });
  }

  async function counters(req, res) {
    const h = await client.datasetIdentity();
    let health = null;
    try { health = await (await fetch(`${config.url.replace(/\/$/, '')}/health`)).json(); } catch { health = null; }
    sendJSON(res, 200, { legacy: legacyCounters(), executor: health, identity: h, trialControl: !!config.trialStore, executorRunning: config.trialStore ? !!child : null,
      authPolicy: { trialUnboundActors: trialBypass, grantAdminCount: grantAdmins.size } });   // a count, not names: readable without a seat in observe mode (a reviewer review)
  }

  async function control(req, res, m) {
    if (!config.trialStore) return sendJSON(res, 404, { error: 'trial executor control is off' });
    try {
      const out = m[1] === 'stop' ? stopExecutor() : await startExecutor();
      sendJSON(res, 200, out);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
  }

  return {
    enabled: true,
    client,
    fence,         // #1561 — the log-born unit fences every read and write with the same check
    trialBypass,   // #1561 — and decides WHO writes with the same startup decision
    startExecutor,
    stopExecutor,
    routes: [
      { method: 'POST', re: /^\/api\/graph\/correct$/, fn: (req, res) => write(req, res, 'correction') },
      { method: 'POST', re: /^\/api\/graph\/assert$/, fn: (req, res) => write(req, res, 'assertion') },
      { method: 'POST', re: /^\/api\/graph\/grant$/, fn: (req, res) => write(req, res, 'grant') },
      { method: 'POST', re: /^\/api\/graph\/rule$/, fn: (req, res) => write(req, res, 'rule') },
      { method: 'GET', re: /^\/api\/graph\/authority$/, fn: (req, res) => authority(req, res) },
      { method: 'GET', re: /^\/api\/trial\/counters$/, fn: (req, res) => counters(req, res) },
      { method: 'POST', re: /^\/api\/trial\/executor\/(stop|start)$/, fn: (req, res, m) => control(req, res, m) },
    ],
  };
}
