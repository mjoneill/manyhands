/**
 * #1810 PR B — the service's adapters: the board's run record over REST, and the OpenRouter model with the
 * model-call ledger. Both are the REAL ends of the seams core/knowledge-extraction.mjs injects (`runs`, `model`).
 *
 * createRestBoard: runs and procedures are document-born on the board (POST /api/runs, /api/procedures,
 *   /api/procedure-versions), written with the service's bearer seat token and `by`. A missing token or actor refuses
 *   to construct: this service never writes anonymously. `generated` is a documented no-op: REST's
 *   /api/runs/generated records ARTIFACTS (pointer + hash), and the run↔assertion link lives in the graph as
 *   scrum:ofRun on each assertion.
 *
 * createOpenRouterModel: POST {baseUrl}/chat/completions with the key in the Authorization header and the request body
 *   passed through, so the per-request ZDR fields (provider.zdr, provider.data_collection) reach the wire exactly as the
 *   extractor set them. The registry key on the body is translated to the provider's model id. The reply's
 *   choices[0].message.content is parsed as JSON; a non-200 is returned as its status with json null and never thrown.
 *   EVERY call, refused ones included, lands one model-call row through the board adapter (#1202: the one place that
 *   can record a call is the place that made it). The key is read into the header and nowhere else: never logged,
 *   never on the ledger row, never in an error message.
 */
import crypto from 'node:crypto';

const need = (v, what) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is required`); return v.trim(); };

export function createRestBoard({ baseUrl, token, by, fetchImpl = fetch } = {}) {
  const base = need(baseUrl, 'baseUrl').replace(/\/$/, '');
  const bearer = need(token, 'token: this service never writes to the board anonymously');
  const actor = need(by, 'by: the service actor');

  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${bearer}` },
      ...(body === undefined ? {} : { body: JSON.stringify({ ...body, by: actor }) }),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.error ?? text.slice(0, 200)}`);
    return json;
  }

  const procedureName = (chain) => `kx:${chain}`;
  const versionBody = ({ chain, modelKey, promptSha }) => `chain=${chain} model=${modelKey} prompt=sha256:${promptSha}`;

  /** One ProcedureVersion per (chain, model key, prompt sha): found by name and body, created when absent. */
  async function ensureProcedureVersion({ chain, modelKey, promptSha }) {
    need(chain, 'chain'); need(modelKey, 'modelKey'); need(promptSha, 'promptSha');
    const name = procedureName(chain), body = versionBody({ chain, modelKey, promptSha });
    const procs = await call('GET', '/api/procedures');
    const proc = (Array.isArray(procs) ? procs : []).find((p) => p.name === name);
    if (proc) {
      const have = (proc.versions || []).find((v) => v.body === body);
      if (have) return have.id;
      const v = await call('POST', '/api/procedure-versions', { procedure: proc.id, body });
      return v.id;
    }
    const created = await call('POST', '/api/procedures', { name, body });
    if (!created?.version?.id) throw new Error('POST /api/procedures answered without a version id');
    return created.version.id;
  }

  async function createRun({ op, performedUsing, used }) {
    const r = await call('POST', '/api/runs', { op: need(op, 'op'), performedUsing, used: [...(used || [])] });
    if (!r?.id) throw new Error('POST /api/runs answered without an id');
    return r.id;
  }

  async function generated({ run, iris }) {
    return { recorded: false, run, count: (iris || []).length,
      reason: 'REST\'s /api/runs/generated records artifacts (pointer + hash), not assertions; the run↔assertion link is scrum:ofRun on each assertion in the graph' };
  }

  async function recordModelCall(row) {
    return call('POST', '/api/model-calls', row);
  }

  return { ensureProcedureVersion, createRun, generated, recordModelCall, actor };
}

export function createOpenRouterModel({ apiKey, baseUrl = 'https://openrouter.ai/api/v1', modelId, fetchImpl = fetch, ledger = null, by = 'extractor', now = () => new Date().toISOString() } = {}) {
  const key = need(apiKey, 'apiKey: set OPENROUTER_API_KEY in the service\'s environment (never in a file)');
  const id = need(modelId, 'modelId: the provider\'s model id for the registry key');
  const base = need(baseUrl, 'baseUrl').replace(/\/$/, '');

  async function ledgerRow(row) {
    if (!ledger?.recordModelCall) return;
    try { await ledger.recordModelCall(row); } catch (e) { console.error(`[#1810] model-call row not recorded: ${e?.message ?? e}`); }
  }

  async function send(body) {
    const t0 = Date.now();
    // #1843: ONE id per call, on every row this call writes. The graph ledger (#1582) refuses a row without one.
    const requestId = `kx-${crypto.randomUUID()}`;
    const wire = { ...body, model: id };
    let res, text = '';
    try {
      res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(wire) });
      text = await res.text();
    } catch (e) {
      await ledgerRow({ requestId, by, agent: by, model: id, provider: 'openrouter', protocol: 'openai-completions', ok: false, error: `transport: ${e?.message ?? e}`.slice(0, 300), latencyMs: Date.now() - t0, at: now() });
      throw e;
    }
    const latencyMs = Date.now() - t0;
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (res.status !== 200) {
      await ledgerRow({ requestId, by, agent: by, model: id, provider: 'openrouter', protocol: 'openai-completions', ok: false, error: `http ${res.status}: ${(json?.error?.message ?? text).slice(0, 200)}`, latencyMs, at: now() });
      return { status: res.status, json: null };
    }
    const content = json?.choices?.[0]?.message?.content;
    let parsed = null; try { parsed = typeof content === 'string' ? JSON.parse(content) : content ?? null; } catch { parsed = null; }
    await ledgerRow({ requestId, by, agent: by, model: id, provider: 'openrouter', protocol: 'openai-completions', ok: true,
      tokensIn: json?.usage?.prompt_tokens ?? null, tokensOut: json?.usage?.completion_tokens ?? null,
      stopReason: json?.choices?.[0]?.finish_reason ?? null, latencyMs, at: now() });
    return { status: 200, json: parsed };
  }

  return { send, modelId: id };
}
