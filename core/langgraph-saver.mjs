/**
 * #1562 — a LangGraph JS checkpoint saver backed by the embedded-Oxigraph graph
 * executor. Design: research/2026-10-04-1562-saver-design-v0.1.md (v0.2
 * revisions supersede v0.1).
 *
 * The saver talks to the executor ONLY through core/graph-client.mjs:
 *   - every mutation is ONE guarded SPARQL update compiled from an `lg.*`
 *     intention (core/graph-compiler.mjs) with a deterministic opId receipt, so a
 *     lost acknowledgement is resolved by replaying the SAME intention;
 *   - getTuple and list are ONE SELECT each: checkpoint identities are selected
 *     (and LIMITed) in a subquery, then the payload, the channel blobs and ALL the
 *     pending writes of exactly those checkpoints are joined in the same query,
 *     so a LIMIT can never truncate writes.
 *
 * Records (IRIs minted by lgMint in the compiler):
 *   checkpoint  payload = the serde checkpoint WITHOUT channel_values (opaque,
 *               base64), metadata (opaque, base64) + one projected predicate per
 *               top-level metadata key for list({filter}), parent, step, branch;
 *   blob        one node per (channel, version) — channel_values are rebuilt from
 *               the checkpoint's channel_versions (the conformance suite requires
 *               delta storage);
 *   write       one node per (checkpoint, task, idx); the checkpoint need NOT
 *               exist (putWrites can precede put in async durability);
 *   branch      the PROCESS facts (status, head, waitingOn, incarnation) per
 *               branch, maintained by the transition table in the compiler;
 *   thread gen  bumped by deleteThread; it is part of every opId, so a deleted
 *               thread's ids can be written again.
 *
 * Fences against deleteThread (a reviewer's two requirements, 2026-10-04):
 *   - WRITES: every compiled lg.* update carries the thread generation the
 *     caller read as a precondition IN ITS OWN WHERE clause (compileLg), so the
 *     executor evaluates it atomically with the write. A put / putWrites /
 *     runTransition whose update lands after deleteThread bumped the generation
 *     is PRECONDITION_FAILED and writes nothing; the saver then raises
 *     ThreadDeletedError and does NOT rebuild the write for the new generation
 *     (that would attach an old generation's writes to a new one).
 *   - OLD RUNS: a run that keeps writing after the delete reads the NEW
 *     generation, so the generation guard alone cannot stop it. What its config
 *     still carries is its old checkpoint id, and deleteThread tombstones every
 *     checkpoint it removes with its generation (lg:deletedInGen). The compiled
 *     put (by its parent) and putWrites (by its checkpoint) refuse a tombstoned,
 *     not-live-again checkpoint inside the same WHERE. A put refused that way is
 *     followed by lg.reap: its own checkpoint is tombstoned and any writes for it
 *     accepted as writes-before-put are removed. (A configurable key was not
 *     used: LangGraph JS discards the config put returns, and the conformance
 *     suite compares getTuple's config with toEqual.)
 *   - RUNS: a LangGraph run passes ONE config.signal object (made per stream()
 *     call) on its getTuple at loop start and on every put / putWrites after.
 *     The generation the run was BORN in — the one its first getTuple read, in
 *     the same SELECT as the checkpoint — is kept per (signal, thread), and every
 *     write of that run is compiled for that generation, so the in-update guard
 *     refuses it once deleteThread has moved on, even for checkpoints the store
 *     has never seen. A call without a signal (a direct caller) uses the current
 *     generation and relies on the tombstones above.
 *     LangGraph makes a NEW signal per run even when the caller passes the same
 *     one to every invoke (Pregel.stream always combines it with its own fresh
 *     signal, and combineAbortSignals of two signals makes a new controller), so
 *     a reused caller signal still gives each run its own birth generation.
 *
 * strictGenerations (option, default false): the PRODUCTION mode. Every put and
 * putWrites must be built for the birth generation of a run that READ the
 * thread first (getTuple / list with that run's signal; on an empty thread the
 * same SELECT returns the generation, 0 if the thread never had one). A write
 * with no birth generation — no signal, or a signal this saver never saw read
 * the thread — is rejected with UnfencedWriteError BEFORE anything is sent; it
 * never falls back to the current generation. The atomic in-update generation
 * guard is then the fence on its own; tombstones and reap remain as defense in
 * depth. Default false keeps signal-less callers (the official conformance
 * suite) working, with the weaker non-strict fences.
 *   - READS: getTuple and list are ONE SELECT, evaluated by the engine against
 *     one store snapshot, so a concurrent deleteThread is seen entirely or not
 *     at all: the complete checkpoint with all its writes, or nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  BaseCheckpointSaver, WRITES_IDX_MAP, TASKS, INTERRUPT, RESUME, getCheckpointId, maxChannelVersion,
} from '@langchain/langgraph-checkpoint';
import { LG, lgMetaPredicate } from './graph-vocab.mjs';
import { lgMint } from './graph-compiler.mjs';

const enc = encodeURIComponent;
const lit = (s) => `"${enc(s)}"`; // the compiler's encoding: safe inside a SPARQL literal
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const dec = (s) => decodeURIComponent(s);
const STATUS = Object.fromEntries(['running', 'waiting', 'resumed', 'done', 'failed'].map((k) => [LG[k].slice(1, -1), k]));

export class SaverWriteError extends Error {
  constructor(message, result) { super(message); this.result = result; }
}

/** strictGenerations: a write with no birth generation from a prior read of its run. Nothing was sent. */
export class UnfencedWriteError extends Error {
  constructor(message) { super(message); this.name = 'UnfencedWriteError'; }
}

/** A write built against a thread generation that deleteThread has since ended: nothing was written. */
export class ThreadDeletedError extends SaverWriteError {
  constructor(message, result) { super(message, result); this.name = 'ThreadDeletedError'; }
}

/** The assignee DECLARED in an interrupt payload ({assignee} on the value passed to interrupt()); never inferred. */
export function declaredAssignee(interruptWriteValue) {
  const it = Array.isArray(interruptWriteValue) ? interruptWriteValue[0] : interruptWriteValue;
  const v = it && typeof it === 'object' && 'value' in it ? it.value : it;
  return v && typeof v === 'object' && typeof v.assignee === 'string' ? v.assignee : null;
}

export class OxigraphSaver extends BaseCheckpointSaver {
  /**
   * @param {object} o
   * @param {ReturnType<import('./graph-client.mjs').createGraphClient>} o.client
   * @param {string} [o.scope]   partition of the store this saver reads and writes ([A-Za-z0-9_-])
   * @param {string} [o.actor]   the actor IRI on every receipt
   */
  constructor({ client, scope = 'default', actor = 'urn:ex:agent/langgraph-saver', serde, unknownRetries = 5, retryDelayMs = 50, strictGenerations = false } = {}) {
    super(serde);
    if (!client) throw new Error('OxigraphSaver: client required');
    this.client = client;
    this.scope = scope;
    this.actor = actor;
    this.unknownRetries = unknownRetries;
    this.retryDelayMs = retryDelayMs;
    this.strictGenerations = strictGenerations === true;
    // No in-process generation cache: a stale generation would reuse an old opId, and the
    // duplicate guard would then return that op's OLD receipt (APPLIED) for data a
    // deleteThread has since removed. The store is the only memory (D2 proofs A2 §5).
    // The one exception is deliberate: the generation a RUN was born in (see the header), keyed
    // by the run's own config.signal object and dropped with it. A stale value there is the
    // point — it is what makes the run's late writes fail.
    this._runGens = new WeakMap(); // signal -> Map(thread -> Promise<gen>)
  }

  _runMap(config) {
    const k = config?.signal;
    if (!k || typeof k !== 'object') return null;
    let m = this._runGens.get(k);
    if (!m) this._runGens.set(k, (m = new Map()));
    return m;
  }

  /** The generation a write is built for: the run's birth generation if it has one, else the current. */
  _genFor(config, tid) {
    if (this.strictGenerations) {
      // never the current generation: only the one a read of THIS run established
      const k = config?.signal;
      const m = k && typeof k === 'object' ? this._runGens.get(k) : undefined;
      if (!m?.has(tid)) {
        throw new UnfencedWriteError(`strictGenerations: no birth generation for thread ${tid} — ${k && typeof k === 'object' ? 'this run (signal) never read the thread through this saver' : 'the config carries no run signal'}; nothing was sent`);
      }
      return m.get(tid);
    }
    const m = this._runMap(config);
    if (!m) return this._readGen(tid);
    if (!m.has(tid)) {
      const p = this._readGen(tid);
      m.set(tid, p); // concurrent first writes of one run share ONE read
      p.catch(() => m.delete(tid));
    }
    return m.get(tid);
  }

  /** A read registers the generation it saw as the run's birth generation (first read wins). */
  _bornAt(config, tid, gen) {
    const m = this._runMap(config);
    if (m && !m.has(tid)) m.set(tid, Promise.resolve(gen));
  }

  // ---------- writes ----------

  _op(kind, tid, gen, ...rest) {
    return `urn:ex:op/lg/${this.scope}/${kind}/${enc(tid)}/g${gen}/${rest.map((r) => enc(r)).join('/')}`.replace(/\/$/, '');
  }

  async _readGen(tid) {
    const r = await this.client.query(`SELECT ?g WHERE { <${lgMint.thread(this.scope, tid)}> ${LG.gen} ?g }`);
    if (!r.ok) throw new SaverWriteError(`graph unavailable reading thread generation: ${r.reason}`, r);
    return r.rows.length ? Number(r.rows[0].g.value) : 0;
  }

  /**
   * Apply one intention built for the current thread generation. UNKNOWN is
   * resolved by replaying the SAME intention (D2 §4).
   *
   * A PRECONDITION_FAILED caused by a moved generation means a deleteThread
   * landed between the generation read and this update; the update's own
   * generation guard already made it write nothing. A FENCED write (put,
   * putWrites, runTransition) belongs to the deleted generation and is NOT
   * rebuilt for the new one: it raises ThreadDeletedError (or, with
   * allowPreconditionFailed, returns the PRECONDITION_FAILED result). Only
   * deleteThread itself (fenced: false) is rebuilt for the new generation.
   */
  async _apply(tid, build, { allowPreconditionFailed = false, fenced = true, config = null } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const gen = fenced ? await this._genFor(config, tid) : await this._readGen(tid);
      const intention = build(gen);
      let r = await this.client.update(intention);
      for (let k = 0; r.outcome === 'UNKNOWN' && k < this.unknownRetries; k++) {
        await new Promise((res) => setTimeout(res, this.retryDelayMs * (k + 1)));
        r = await this.client.update(intention);
      }
      if (r.outcome === 'APPLIED') return r;
      if (r.outcome === 'PRECONDITION_FAILED') {
        const now = await this._readGen(tid);
        if (now !== gen) {
          if (!fenced) continue; // deleteThread: delete whatever generation is current now
          if (allowPreconditionFailed) return r;
          throw new ThreadDeletedError(`${intention.kind} ${intention.opId}: thread deleted (generation ${gen} -> ${now}); nothing was written`, r);
        }
        if (allowPreconditionFailed) return r;
        throw new SaverWriteError(`${intention.kind} ${intention.opId}: PRECONDITION_FAILED`, r);
      }
      throw new SaverWriteError(`${intention.kind} ${intention.opId}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`, r);
    }
    throw new SaverWriteError('thread generation kept moving; gave up after 3 attempts', null);
  }

  async put(config, checkpoint, metadata, newVersions) {
    const tid = config?.configurable?.thread_id;
    if (tid === undefined || tid === null) {
      throw new Error('Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.');
    }
    const thread = String(tid);
    const ns = config.configurable.checkpoint_ns ?? '';
    const parentCid = config.configurable.checkpoint_id ?? null;
    const { channel_values: values = {}, ...rest } = checkpoint;
    const [[pt, pbytes], [mt, mbytes]] = await Promise.all([this.serde.dumpsTyped(rest), this.serde.dumpsTyped(metadata)]);
    const blobs = await Promise.all(Object.entries(newVersions ?? {}).map(async ([channel, version]) => {
      if (!Object.prototype.hasOwnProperty.call(values, channel)) return { channel, version: String(version), type: 'empty', value: '' };
      const [type, bytes] = await this.serde.dumpsTyped(values[channel]);
      return { channel, version: String(version), type, value: b64(bytes) };
    }));
    const meta = [];
    for (const [key, v] of Object.entries(metadata ?? {})) {
      if (v === undefined) continue;
      let j;
      try { j = JSON.stringify(v); } catch { continue; }
      if (j !== undefined) meta.push({ key, value: b64(Buffer.from(j, 'utf8')) });
    }
    const step = Number.isSafeInteger(metadata?.step) ? metadata.step : null;
    const lg = {
      scope: this.scope, thread, ns, cid: checkpoint.id, parentCid, step,
      payloadType: pt, payload: b64(pbytes), metaType: mt, metadata: b64(mbytes), meta,
      channelVersions: Object.entries(checkpoint.channel_versions ?? {}).map(([channel, v]) => ({ channel, version: String(v) })),
      blobs,
    };
    try {
      await this._apply(thread, (gen) => ({
        kind: 'lg.put', opId: this._op('put', thread, gen, `ns:${ns}`, checkpoint.id), actor: this.actor, lg: { ...lg, gen },
      }), { config });
    } catch (e) {
      if (!(e instanceof ThreadDeletedError) && e?.result?.outcome !== 'PRECONDITION_FAILED') throw e;
      // fenced: the generation moved under this put, or (generation unchanged) its parent is
      // tombstoned. Either way an old run's checkpoint can never be stored: reap it (lg.reap applies
      // only when the parent IS tombstoned), then report.
      if (parentCid != null) await this._reap(thread, ns, checkpoint.id, parentCid).catch(() => {}); // best effort: the put is refused either way
      if (e instanceof ThreadDeletedError) throw e;
      throw new ThreadDeletedError(`lg.put ${checkpoint.id}: its parent ${parentCid} was removed by deleteThread; nothing was written`, e.result);
    }
    return { configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  /** Defense in depth after a refused put (see the header); never what makes a stale write fail. */
  _reap(thread, ns, cid, parentCid) {
    return this._apply(thread, (gen) => ({
      kind: 'lg.reap', opId: this._op('reap', thread, gen, `ns:${ns}`, cid), actor: this.actor,
      lg: { scope: this.scope, thread, ns, gen, cid, parentCid },
    }), { allowPreconditionFailed: true, fenced: false });
  }

  async putWrites(config, writes, taskId) {
    const tid = config?.configurable?.thread_id;
    const cid = config?.configurable?.checkpoint_id;
    if (tid === undefined || tid === null) throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.');
    if (cid === undefined || cid === null) throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.');
    if (!writes?.length) return;
    const thread = String(tid);
    const ns = config.configurable.checkpoint_ns ?? '';
    const resumer = typeof config.configurable.resumer === 'string' ? config.configurable.resumer : null;
    const byIdx = new Map(); // one node per (task, idx): a later entry with the same idx wins, as in MemorySaver
    await Promise.all(writes.map(async ([channel, value], i) => {
      const idx = WRITES_IDX_MAP[channel] ?? i;
      const [type, bytes] = await this.serde.dumpsTyped(value);
      byIdx.set(i, { idx, channel, type, value: b64(bytes), assignee: channel === INTERRUPT ? declaredAssignee(value) : null });
    }));
    const dedup = new Map();
    for (let i = 0; i < writes.length; i++) { const w = byIdx.get(i); dedup.set(w.idx, w); }
    const ws = [...dedup.values()];
    const h = createHash('sha256').update(JSON.stringify([ws, resumer])).digest('hex').slice(0, 24);
    try {
      await this._apply(thread, (gen) => ({
        kind: 'lg.putWrites', opId: this._op('writes', thread, gen, `ns:${ns}`, cid, String(taskId), h), actor: this.actor,
        lg: { scope: this.scope, thread, ns, gen, cid, taskId: String(taskId), resumer, writes: ws },
      }), { config });
    } catch (e) {
      if (e instanceof ThreadDeletedError || e?.result?.outcome !== 'PRECONDITION_FAILED') throw e;
      // the generation did not move, so the refusal is the tombstone fence
      throw new ThreadDeletedError(`lg.putWrites ${cid}: that checkpoint was removed by deleteThread; nothing was written`, e.result);
    }
  }

  async deleteThread(threadId) {
    const thread = String(threadId);
    await this._apply(thread, (gen) => ({
      kind: 'lg.deleteThread', opId: this._op('delete', thread, gen), actor: this.actor, lg: { scope: this.scope, thread, gen },
    }), { fenced: false });
  }

  /**
   * The CALLER's terminal transition after invoke returns (design §4): done or
   * failed, for the branch whose head is `config`'s checkpoint. Returns
   * 'APPLIED' or 'PRECONDITION_FAILED' (not the head, or not running/resumed).
   */
  async markRun(config, to) {
    const thread = String(config.configurable.thread_id);
    const ns = config.configurable.checkpoint_ns ?? '';
    const cid = config.configurable.checkpoint_id;
    const r = await this._apply(thread, (gen) => ({
      kind: 'lg.runTransition', opId: this._op('run', thread, gen, `ns:${ns}`, cid, to), actor: this.actor,
      lg: { scope: this.scope, thread, ns, gen, cid, to },
    }), { allowPreconditionFailed: true, config });
    return r.outcome;
  }

  // ---------- reads (one SELECT each) ----------

  /**
   * Process facts of the branch holding `config`'s checkpoint, or of the
   * latest checkpoint's branch in (thread, ns) when no checkpoint_id is given.
   */
  async getProcess(config) {
    const thread = config?.configurable?.thread_id;
    if (thread === undefined) return undefined;
    const ns = config.configurable.checkpoint_ns ?? '';
    const cid = getCheckpointId(config);
    const pick = cid
      ? `<${lgMint.cp(this.scope, String(thread), ns, cid)}> ${LG.branch} ?b .`
      : `{ SELECT ?c WHERE { ?c a ${LG.Checkpoint} ; ${LG.inScope} <${lgMint.scope(this.scope)}> ; ${LG.thread} ${lit(String(thread))} ; ${LG.ns} ${lit(ns)} ; ${LG.checkpointId} ?cid } ORDER BY DESC(?cid) LIMIT 1 }
    ?c ${LG.branch} ?b .`;
    const r = await this.client.query(`SELECT ?b ?st ?hid ?inc ?step ?wat ?won ?rb ?err WHERE {
    ${pick}
    ?b ${LG.status} ?st ; ${LG.headId} ?hid ; ${LG.incarnation} ?inc .
    OPTIONAL { ?b ${LG.asOfStep} ?step } OPTIONAL { ?b ${LG.waitingAt} ?wat } OPTIONAL { ?b ${LG.waitingOn} ?won }
    OPTIONAL { ?b ${LG.resumedBy} ?rb } OPTIONAL { ?b ${LG.lastErrorAt} ?err }
  }`);
    if (!r.ok) throw new Error(`graph unavailable: ${r.reason}`);
    if (r.rows.length === 0) return undefined;
    if (r.rows.length !== 1) throw new Error(`process facts are not single-valued (${r.rows.length} rows)`);
    const x = r.rows[0];
    const v = (t) => (t ? dec(t.value) : null);
    return {
      branch: x.b.value, status: STATUS[x.st.value] ?? x.st.value, head: dec(x.hid.value), incarnation: Number(x.inc.value),
      asOfStep: x.step ? Number(x.step.value) : null, waitingAt: v(x.wat), waitingOn: v(x.won), resumedBy: v(x.rb), lastErrorAt: v(x.err),
    };
  }

  _tupleQuery({ thread, ns, cid, before, filter, limit }) {
    const f = [];
    if (thread !== undefined) f.push(`?cp ${LG.thread} ${lit(String(thread))} .`);
    if (ns !== undefined) f.push(`?cp ${LG.ns} ${lit(ns)} .`);
    if (cid) f.push(`FILTER(?cid = ${lit(cid)})`);
    if (before) f.push(`FILTER(?cid < ${lit(before)})`);
    for (const [key, v] of Object.entries(filter ?? {})) {
      if (v === undefined) { f.push(`FILTER NOT EXISTS { ?cp ${lgMetaPredicate(key)} ?any }`); continue; }
      f.push(`?cp ${lgMetaPredicate(key)} "${b64(Buffer.from(JSON.stringify(v), 'utf8'))}" .`);
    }
    // with a thread: the thread generation, from the SAME snapshot (a run's birth generation)
    const genRow = thread !== undefined ? `{ BIND("g" AS ?k) OPTIONAL { <${lgMint.thread(this.scope, String(thread))}> ${LG.gen} ?tg } }\n  UNION ` : '';
    return `SELECT ?cp ?cid ?tid ?ns ?k ?pcid ?pt ?pv ?mt ?mv ?ch ?bt ?bv ?wt ?wi ?wc ?wvt ?wv ?tg WHERE {
  ${genRow}{
  { SELECT ?cp ?cid ?tid ?ns WHERE {
      ?cp a ${LG.Checkpoint} . ?cp ${LG.inScope} <${lgMint.scope(this.scope)}> .
      ?cp ${LG.checkpointId} ?cid . ?cp ${LG.thread} ?tid . ?cp ${LG.ns} ?ns .
      ${f.join('\n      ')}
    } ORDER BY DESC(?cid) ?tid ?ns${limit !== undefined ? ` LIMIT ${limit}` : ''} }
  { BIND("c" AS ?k) ?cp ${LG.payloadType} ?pt . ?cp ${LG.payload} ?pv . ?cp ${LG.metaType} ?mt . ?cp ${LG.metadata} ?mv . OPTIONAL { ?cp ${LG.parentId} ?pcid } }
  UNION { BIND("b" AS ?k) ?cp ${LG.usesBlob} ?bl . ?bl ${LG.channel} ?ch . ?bl ${LG.blobType} ?bt . ?bl ${LG.blobValue} ?bv }
  UNION { BIND("w" AS ?k) ?w ${LG.checkpoint} ?cp . ?w ${LG.taskId} ?wt . ?w ${LG.idx} ?wi . ?w ${LG.channel} ?wc . ?w ${LG.valueType} ?wvt . ?w ${LG.value} ?wv }
  UNION { BIND("s" AS ?k) ?cp ${LG.parent} ?par . ?w ${LG.checkpoint} ?par . ?w ${LG.channel} ${lit(TASKS)} . ?w ${LG.taskId} ?wt . ?w ${LG.idx} ?wi . ?w ${LG.valueType} ?wvt . ?w ${LG.value} ?wv }
  }
}`;
  }

  async _tuples(opts) {
    const r = await this.client.query(this._tupleQuery(opts));
    if (!r.ok) throw new Error(`graph unavailable: ${r.reason}`); // never an empty result in place of a failed read
    const by = new Map();
    for (const row of r.rows) {
      if (row.k.value === 'g') {
        if (opts.config) this._bornAt(opts.config, String(opts.thread), row.tg ? Number(row.tg.value) : 0);
        continue;
      }
      const key = row.cp.value;
      if (!by.has(key)) by.set(key, { cid: dec(row.cid.value), tid: dec(row.tid.value), ns: dec(row.ns.value), c: null, blobs: new Map(), writes: [], sends: [] });
      const e = by.get(key);
      const k = row.k.value;
      if (k === 'c') e.c = row;
      else if (k === 'b') e.blobs.set(dec(row.ch.value), { type: dec(row.bt.value), value: row.bv.value });
      else (k === 'w' ? e.writes : e.sends).push({ task: dec(row.wt.value), idx: Number(row.wi.value), channel: k === 'w' ? dec(row.wc.value) : TASKS, type: dec(row.wvt.value), value: row.wv.value });
    }
    const ord = (a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : a.idx - b.idx);
    const out = [];
    for (const e of by.values()) {
      if (!e.c) continue;
      const checkpoint = await this.serde.loadsTyped(dec(e.c.pt.value), unb64(e.c.pv.value));
      const channel_values = {};
      for (const [ch] of Object.entries(checkpoint.channel_versions ?? {})) {
        const bl = e.blobs.get(ch);
        if (bl && bl.type !== 'empty') channel_values[ch] = await this.serde.loadsTyped(bl.type, unb64(bl.value));
      }
      checkpoint.channel_values = channel_values;
      const pcid = e.c.pcid ? dec(e.c.pcid.value) : undefined;
      if (checkpoint.v < 4 && pcid !== undefined) {
        // pending-sends migration, as MemorySaver: the parent's TASKS writes become this checkpoint's TASKS channel
        checkpoint.channel_values[TASKS] = await Promise.all(e.sends.sort(ord).map((w) => this.serde.loadsTyped(w.type, unb64(w.value))));
        checkpoint.channel_versions ??= {};
        const vs = Object.values(checkpoint.channel_versions);
        checkpoint.channel_versions[TASKS] = vs.length > 0 ? maxChannelVersion(...vs) : this.getNextVersion(undefined);
      }
      const pendingWrites = await Promise.all(e.writes.sort(ord).map(async (w) => [w.task, w.channel, await this.serde.loadsTyped(w.type, unb64(w.value))]));
      const tuple = {
        config: { configurable: { thread_id: e.tid, checkpoint_ns: e.ns, checkpoint_id: e.cid } },
        checkpoint,
        metadata: await this.serde.loadsTyped(dec(e.c.mt.value), unb64(e.c.mv.value)),
        pendingWrites,
      };
      if (pcid !== undefined) tuple.parentConfig = { configurable: { thread_id: e.tid, checkpoint_ns: e.ns, checkpoint_id: pcid } };
      out.push(tuple);
    }
    out.sort((a, b) => {
      const x = a.config.configurable; const y = b.config.configurable;
      if (x.checkpoint_id !== y.checkpoint_id) return x.checkpoint_id < y.checkpoint_id ? 1 : -1;
      if (x.thread_id !== y.thread_id) return x.thread_id < y.thread_id ? -1 : 1;
      return x.checkpoint_ns < y.checkpoint_ns ? -1 : x.checkpoint_ns > y.checkpoint_ns ? 1 : 0;
    });
    return out;
  }

  async getTuple(config) {
    const thread = config?.configurable?.thread_id;
    if (thread === undefined || thread === null) return undefined;
    const ns = config.configurable.checkpoint_ns ?? '';
    const cid = getCheckpointId(config);
    const [t] = await this._tuples({ thread, ns, cid: cid || undefined, limit: 1, config });
    return t;
  }

  async *list(config, options = {}) {
    const { before, limit, filter } = options ?? {};
    if (limit !== undefined && limit <= 0) return;
    const c = config?.configurable ?? {};
    const tuples = await this._tuples({
      thread: c.thread_id ?? undefined, ns: c.checkpoint_ns, cid: c.checkpoint_id || undefined,
      before: before?.configurable?.checkpoint_id, filter, limit, config,
    });
    for (const t of tuples) yield t;
  }

  /** String versions with a random suffix (as the Postgres saver): a fork can never collide with a sibling's blob. */
  getNextVersion(current) {
    const n = current === undefined ? 0 : typeof current === 'number' ? current : parseInt(String(current).split('.')[0], 10);
    return `${String(n + 1).padStart(32, '0')}.${randomBytes(8).toString('hex')}`;
  }
}
