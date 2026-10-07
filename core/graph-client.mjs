/**
 * #1558 slice — the ONLY door from Node to the graph executor.
 * Boundary agreed with a reviewer (#1558 03:10Z–03:14Z):
 *
 *   query(sparql)  SELECT only → {ok:true, head, rows} | {ok:false, status:'UNAVAILABLE', reason}
 *   ask(sparql)    ASK only    → {ok:true, boolean}    | {ok:false, status:'UNAVAILABLE', reason}
 *   update(intention)          → {outcome, receipt?, reason?, digest?}
 *   reconcile(intention)       → the same, from the stored receipt alone (no write)
 *   datasetIdentity()          → startup fencing only
 *
 * READ failures of any kind are UNAVAILABLE; a partial result is never ok:true.
 * WRITE outcomes (D2 §4): APPLIED / PRECONDITION_FAILED come from the stored
 * receipt; REJECTED is computed (validation, or intent collision); UNKNOWN means
 * the request may have been dispatched and no flushed acknowledgement arrived
 * (reconcile by opId, then replay the same intention); UNAVAILABLE only when the
 * request provably never left (connection refused before send).
 */
import { compile, canonicalize, digestOf, ValidationError } from './graph-compiler.mjs';
import { NS } from './graph-vocab.mjs';

const TERM_TYPES = new Set(['uri', 'literal', 'bnode']);

function validBinding(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  for (const t of Object.values(b)) {
    if (!t || typeof t !== 'object' || !TERM_TYPES.has(t.type) || typeof t.value !== 'string') return false;
    const keys = Object.keys(t);
    if (keys.some((k) => !['type', 'value', 'datatype', 'xml:lang'].includes(k))) return false;
    if (t.type !== 'literal' && (t.datatype != null || t['xml:lang'] != null)) return false;
    if (t.datatype != null && t['xml:lang'] != null) return false;
    if (t.datatype != null && typeof t.datatype !== 'string') return false;
    if (t['xml:lang'] != null && typeof t['xml:lang'] !== 'string') return false;
  }
  return true;
}

const refused = (e) => {
  const code = e?.cause?.code || e?.code;
  return code === 'ECONNREFUSED';
};

// #1570 — one process-wide observer of every executor call (core/executor-meter.mjs), set by the server at boot. Absent
// in tests and scripts, so nothing changes there. It sees label, kind, outcome, elapsed ms and the body (to hash).
let meter = null;
export function setExecutorMeter(m) { meter = m || null; }

export function createGraphClient({ baseUrl, expectedDatasetId = null, timeoutMs = 5000, fetchImpl = fetch, label = 'unlabelled' } = {}) {
  if (!baseUrl) throw new Error('graph client: baseUrl required');
  const url = (p) => `${baseUrl.replace(/\/$/, '')}${p}`;

  async function send(path, body, headers = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = performance.now();
    let outcome = 'error';
    try {
      const r = await fetchImpl(url(path), { method: body == null ? 'GET' : 'POST', body, headers, signal: ac.signal });
      const text = await r.text();
      outcome = String(r.status);
      return { status: r.status, text };
    } catch (e) {
      outcome = ac.signal.aborted ? 'timeout' : (refused(e) ? 'refused' : 'error');
      throw e;
    } finally {
      clearTimeout(timer);
      if (meter) meter.record({ label, kind: path.replace(/^\//, '').split(/[/?]/)[0] || 'root', outcome, elapsedMs: performance.now() - t0, body: typeof body === 'string' ? body : undefined });
    }
  }

  async function readJson(path, body) {
    let res;
    try {
      res = await send(path, body);
    } catch (e) {
      return { ok: false, status: 'UNAVAILABLE', reason: `transport: ${e?.cause?.code || e?.name || e}` };
    }
    if (res.status !== 200) return { ok: false, status: 'UNAVAILABLE', reason: `http ${res.status}: ${res.text.slice(0, 200)}` };
    try {
      return { ok: true, json: JSON.parse(res.text) };
    } catch {
      return { ok: false, status: 'UNAVAILABLE', reason: 'response is not complete JSON' };
    }
  }

  async function query(sparql) {
    const r = await readJson('/query', sparql);
    if (!r.ok) return r;
    const j = r.json;
    if (!j?.head || !Array.isArray(j.head.vars) || !j.head.vars.every((v) => typeof v === 'string')) {
      return { ok: false, status: 'UNAVAILABLE', reason: 'not a SELECT result: head.vars missing' };
    }
    if (!Array.isArray(j?.results?.bindings)) return { ok: false, status: 'UNAVAILABLE', reason: 'results.bindings missing' };
    const vars = new Set(j.head.vars);
    for (const b of j.results.bindings) {
      if (!validBinding(b) || Object.keys(b).some((k) => !vars.has(k))) {
        return { ok: false, status: 'UNAVAILABLE', reason: 'malformed binding' };
      }
    }
    return { ok: true, head: j.head, rows: j.results.bindings };
  }

  async function ask(sparql) {
    const r = await readJson('/query', sparql);
    if (!r.ok) return r;
    if (typeof r.json?.boolean !== 'boolean') return { ok: false, status: 'UNAVAILABLE', reason: 'not an ASK result' };
    return { ok: true, boolean: r.json.boolean };
  }

  function outcomeFromReceipt(receipt, digest) {
    if (!receipt) return null;
    const stored = receipt.digest?.[0]?.value;
    if (stored !== digest) return { outcome: 'REJECTED', reason: 'intent-collision', receipt };
    const o = receipt.outcome?.[0]?.value;
    if (o === `${NS}APPLIED`) return { outcome: 'APPLIED', receipt };
    if (o === `${NS}PRECONDITION_FAILED`) return { outcome: 'PRECONDITION_FAILED', receipt };
    return { outcome: 'UNKNOWN', reason: `receipt has unrecognised outcome ${o}`, receipt };
  }

  // #1559 epoch fencing: the epoch this client believes it is writing into. Learned on first use
  // and kept; a restore promotion bumps the store's epoch, and writes carrying the old one are
  // refused (RECONCILE_REQUIRED) unless their opId already has a receipt. A caller that persists
  // pending intentions should persist the epoch with them and pass it explicitly.
  let knownEpoch = null;
  async function currentEpoch() {
    if (knownEpoch == null) {
      const id = await datasetIdentity();
      if (id.ok) knownEpoch = String(id.epoch);
    }
    return knownEpoch;
  }
  function refreshEpoch() { knownEpoch = null; }

  // #1574 R4a — A CLIENT FOR DATASET X NEVER WRITES INTO DATASET Y. The identity used to be checked only while learning
  // the epoch, and a failed check fell through to the write, so a client built for the wrong dataset applied it. Now the
  // first write confirms the store is the expected dataset before anything is sent: a mismatch is refused, an identity
  // that cannot be read is UNAVAILABLE, and in both cases nothing reached the store. Confirmed once per client.
  let identityConfirmed = expectedDatasetId == null;
  async function confirmIdentity() {
    if (identityConfirmed) return null;
    const id = await datasetIdentity();
    if (id.ok) { identityConfirmed = true; if (knownEpoch == null) knownEpoch = String(id.epoch); return null; }
    if (id.status === 'REFUSED') return { outcome: 'REJECTED', reason: `wrong dataset, nothing sent: ${id.reason}` };
    return { outcome: 'UNAVAILABLE', reason: `the store's dataset identity could not be read, nothing sent: ${id.reason || id.status || 'unreadable'}` };
  }

  async function update(intention, { epoch } = {}) {
    let compiled;
    try {
      compiled = compile(intention);
    } catch (e) {
      if (e instanceof ValidationError) return { outcome: 'REJECTED', reason: `validation: ${e.reason}`, policy: 'slice-v1' };
      throw e;
    }
    const { sparql, digest, canonical } = compiled;
    let fence;
    try { fence = await confirmIdentity(); } catch (e) { fence = { outcome: 'UNAVAILABLE', reason: `the store's dataset identity could not be read, nothing sent: ${e?.message || e}` }; }
    if (fence) return { ...fence, digest };
    let res;
    try {
      const ep = epoch != null ? String(epoch) : await currentEpoch();
      res = await send('/update', sparql, { 'x-op-id': canonical.opId, 'content-type': 'application/sparql-update', ...(ep != null ? { 'x-epoch': ep } : {}) });
    } catch (e) {
      if (refused(e)) return { outcome: 'UNAVAILABLE', reason: 'connection refused before send', digest };
      return { outcome: 'UNKNOWN', reason: `transport after dispatch: ${e?.cause?.code || e?.name || e}`, digest };
    }
    if (res.status === 409) {
      let j = null; try { j = JSON.parse(res.text); } catch { /* not the fence */ }
      if (j?.reconcileRequired) return { outcome: 'RECONCILE_REQUIRED', reason: `epoch changed (store ${j.reconcileRequired.storeEpoch}, this write ${j.reconcileRequired.callerEpoch}) and this opId has no receipt here: reconcile downstream, then refresh the epoch and use a fresh opId`, reconcileRequired: j.reconcileRequired, digest };
    }
    // #1559: a latched executor refuses BEFORE applying anything, so this is provably not applied
    if (res.status === 503) {
      let j = null; try { j = JSON.parse(res.text); } catch { /* not the latch */ }
      if (j?.degraded && j.sameOpAsFailed === true) {
        return { outcome: 'UNKNOWN', reason: 'an earlier attempt of this opId faulted and may have committed: reconcile by receipt after the executor restarts', degraded: j.degraded, digest };
      }
      if (j?.degraded) return { outcome: 'UNAVAILABLE', reason: `executor degraded (write refused before apply): ${j.degraded.reason}`, degraded: j.degraded, digest };
    }
    if (res.status !== 200) return { outcome: 'UNKNOWN', reason: `http ${res.status}: ${res.text.slice(0, 200)}`, digest };
    let j;
    try { j = JSON.parse(res.text); } catch { return { outcome: 'UNKNOWN', reason: 'acknowledgement is not complete JSON', digest }; }
    if (j.flushed !== true) return { outcome: 'UNKNOWN', reason: 'no flushed acknowledgement', digest };
    const out = outcomeFromReceipt(j.receipt, digest);
    if (!out) return { outcome: 'UNKNOWN', reason: 'no receipt after a flushed update', digest };
    return { ...out, digest, bodySha256: j.bodySha256 };
  }

  async function reconcile(intention) {
    let c;
    try { c = canonicalize(intention); } catch (e) {
      if (e instanceof ValidationError) return { outcome: 'REJECTED', reason: `validation: ${e.reason}` };
      throw e;
    }
    const digest = digestOf(c);
    const r = await readJson(`/receipt/${encodeURIComponent(c.opId)}`);
    if (!r.ok) return { outcome: 'UNKNOWN', reason: r.reason, digest };
    const out = outcomeFromReceipt(r.json.receipt, digest);
    return out ? { ...out, digest } : { outcome: 'ABSENT', reason: 'no receipt for this opId (replay the same intention)', digest };
  }

  async function datasetIdentity() {
    const r = await readJson('/health');
    if (!r.ok) return r;
    const { datasetId, epoch } = r.json || {};
    if (expectedDatasetId != null && datasetId !== expectedDatasetId) {
      return { ok: false, status: 'REFUSED', reason: `dataset identity mismatch: ${datasetId} != ${expectedDatasetId}` };
    }
    return { ok: true, datasetId, epoch };
  }

  return { query, ask, update, reconcile, datasetIdentity, refreshEpoch };
}
