/**
 * #1689 — AMBIENT RECALL: when a room post touches something the room has READ, the reading surfaces on the post by itself,
 * with the sentence that matched; otherwise the post stays exactly as it was. The owner's words: "oh, we're talking about X
 * right now... there are articles we've read in the past on this... I can choose to read those."
 *
 * What was measured before this existed (2026-11-14, production data, the board's own embedder): cosine between a claim's
 * GIST and a post's text separates. 140 real posts: median top-claim score 0.526, p90 0.583; the five posts genuinely about a
 * document scored 0.67–0.78. Hand-written probes that never name a document: 6 of 7 on-topic at 0.635–0.761, 5 of 5
 * off-topic at 0.45–0.553. The board's card/source search could not do this (sources drown among the cards), so recall keeps
 * its own CLAIM-level index.
 *
 * The parts, each testable without a graph or a model (the server injects the I/O):
 *   config   knowledge-recall.json at the repo root, strict like knowledge-linking.json: no fallback in code. Invalid = OFF.
 *   index    one row per claim (its gist, or its quote when it has none), keyed by claim IRI under the embed model's name, in
 *            a file beside the search index. Kept current lazily: each call embeds one batch of what is new, and says how
 *            many claims exist and how many are embedded, so "not embedded yet" never reads as "nothing matched".
 *   engine   one text → at most one item per source, above the bar, best first; or available:false with the reason.
 *   state    per post, the decision made once (items, nothing, or unavailable), the openings, and the counts.
 *   hook     after a post's answer is sent: decide its recall, apply the quiet rule, and retry a few that could not be decided.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteOf } from './knowledge-delivery.mjs';
import { isRunId } from './knowledge-reading.mjs';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';

export const RECALL_CONFIG_FILE = fileURLToPath(new URL('../knowledge-recall.json', import.meta.url));

// ── config ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// #1851's rule, as for the linker: a threshold is config, never a hidden default. A missing file, key or a bad value turns
// recall OFF and says why; a recall made at a number nobody chose would look exactly like a real one.
const K_MAX = 5;   // POST /api/recall takes k from 1 to 5, so a default above it could never be asked for
const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v));
const intIn = (lo, hi) => (k) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? null : `${k} must be an integer from ${lo} to ${hi}, got ${show(v)}`);
const RULES = {
  minScore: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? null : `minScore must be a number from 0 to 1, got ${show(v)}`),
  maxItems: intIn(1, K_MAX)('maxItems'),
  quietPosts: intIn(0, 10000)('quietPosts'),
  minChars: intIn(1, 100000)('minChars'),
  deadlineMs: intIn(1, 120000)('deadlineMs'),
};

/** Validate a parsed config. Fails closed: one problem refuses the whole file. */
export function validateRecallConfig(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: `the recall config must be a JSON object with ${Object.keys(RULES).join(', ')}` };
  const problems = [];
  for (const [key, rule] of Object.entries(RULES)) {
    if (!(key in doc)) { problems.push(`${key} is missing (it has no default)`); continue; }
    const p = rule(doc[key]);
    if (p) problems.push(p);
  }
  // a misspelt key would validate, never apply, and look configured: refused by name
  const unknown = Object.keys(doc).filter((k) => !(k in RULES));
  if (unknown.length) problems.push(`unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => JSON.stringify(k)).join(', ')} (known: ${Object.keys(RULES).join(', ')})`);
  if (problems.length) return { ok: false, error: problems.join('; ') };
  return { ok: true, ...Object.fromEntries(Object.keys(RULES).map((k) => [k, doc[k]])) };
}

/** Read and validate the config file. Never throws. */
export function readRecallConfig(file = RECALL_CONFIG_FILE) {
  const name = path.basename(file);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `${name} cannot be read (${e.code || e.message})` }; }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { ok: false, error: `${name} is not JSON (${e.message})` }; }
  const v = validateRecallConfig(doc);
  return v.ok ? v : { ok: false, error: `${name}: ${v.error}` };
}

// ── claims ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const TEXT_SHAPE = 'gist, else anchorText';
const MAX_TEXT_CHARS = 6000;   // the search index's measured cap: a longer text is embedded from its head
const lit = (r, k) => (r[k] && typeof r[k].value === 'string' ? r[k].value : null);

/** The text a claim is embedded by: the model's one-line gist (measured to separate), else the verbatim quote. */
export const claimText = (c) => ((c.gist && c.gist.trim()) ? c.gist.trim() : String(c.quote ?? '').trim()).slice(0, MAX_TEXT_CHARS);
export const textHash = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');

/** Rows of recallClaimsQuery → one claim per IRI. A claim with neither gist nor quote has nothing to match and is left out. */
export function claimsOfRows(rows) {
  const byIri = new Map();
  for (const r of rows || []) {
    const iri = r.a?.value;
    if (!iri || byIri.has(iri)) continue;
    const runSeg = String(r.r?.value ?? '').split('/').pop();
    const c = {
      iri, gist: lit(r, 'gist'), quote: lit(r, 'span'),
      runId: isRunId(runSeg) ? runSeg : null,   // it goes into a URL: only `run-` + a lowercase UUID is ever emitted
      source: { iri: r.src?.value ?? null, title: lit(r, 'name'), url: lit(r, 'url') },
      readAt: lit(r, 'at'),
    };
    if (!claimText(c)) continue;
    byIri.set(iri, c);
  }
  return [...byIri.values()];
}

// ── ranking ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const round3 = (x) => Math.round(x * 1000) / 1000;
function norm(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); }

/** A post that LINKS the document does not need a pointer to it. */
export function ownUrlIn(text, url) {
  if (typeof url !== 'string' || !url || typeof text !== 'string') return false;
  const bare = url.replace(/\/+$/, '');
  return text.includes(url) || (bare.length > 8 && text.includes(bare));
}

/**
 * The items for one query vector: each source's BEST claim, only at or above minScore, best first, at most k, minus any
 * source whose url is in the text. `rows` maps claim IRI → { vec, norm }. Items carry `sourceIri` and `runId` for the
 * state; publicItem strips them.
 */
export function recallItems({ queryVec, claims, rows, minScore, k, text }) {
  const qn = norm(queryVec);
  const best = new Map();
  if (qn === 0) return [];
  for (const c of claims) {
    const row = rows.get(c.iri);
    if (!row || row.vec.length !== queryVec.length || row.norm === 0) continue;
    const key = c.source.iri ?? c.iri;   // a claim with no source stands alone: two unknowns are never one source
    if (ownUrlIn(text, c.source.url)) continue;
    let dot = 0; const v = row.vec;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
    const score = dot / (qn * row.norm);
    const had = best.get(key);
    if (!had || score > had.score || (score === had.score && c.iri < had.c.iri)) best.set(key, { c, score });
  }
  return [...best.values()]
    .filter((x) => x.score >= minScore)
    .sort((x, y) => y.score - x.score || x.c.iri.localeCompare(y.c.iri))
    .slice(0, Math.max(0, k))
    .map(({ c, score }) => {
      const { quote, truncated } = quoteOf(c.quote ?? '');
      return {
        source: { title: c.source.title, url: c.source.url },
        readingPage: c.runId ? `/reading.html?run=${c.runId}` : null,
        readAt: c.readAt,
        why: { gist: c.gist ?? null, quote, ...(truncated ? { quoteTruncated: true } : {}), claim: c.iri },
        score: round3(score),
        sourceIri: c.source.iri ?? c.iri, runId: c.runId,
      };
    });
}

export const publicItem = ({ sourceIri, runId, offer, ...item }) => item;

// ── the index file ────────────────────────────────────────────────────────────────────────────────────────────────────
// A header line {generation: {model, dims, textShape, builtAt}}, then {id, hash, vec} rows. A PROJECTION: delete it and the
// next calls re-embed. New rows are APPENDED (a torn last line is skipped on read); a new generation rewrites it whole.
const headerLine = (gen) => `${JSON.stringify({ generation: gen })}\n`;
const rowLine = (id, hash, vec) => `${JSON.stringify({ id, hash, vec: Array.from(vec, (x) => Number(x.toPrecision(7))) })}\n`;

/** Parse the index for `model`. Another model's file is not refused: it is discarded and re-embedded under this one. */
export function parseRecallIndex(text, { model }) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return { generation: null, rows: new Map(), discarded: null };
  let gen = null;
  try { gen = JSON.parse(lines[0])?.generation ?? null; } catch { /* below */ }
  if (!gen || typeof gen.model !== 'string' || !Number.isInteger(gen.dims)) return { generation: null, rows: new Map(), discarded: 'the file has no readable generation header' };
  if (gen.model !== model) return { generation: null, rows: new Map(), discarded: `it was built by ${gen.model}, and this server embeds with ${model}` };
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r && typeof r.id === 'string' && typeof r.hash === 'string' && Array.isArray(r.vec) && r.vec.length === gen.dims) {
      const vec = Float32Array.from(r.vec);
      rows.set(r.id, { hash: r.hash, vec, norm: norm(vec) });
    }
  }
  return { generation: gen, rows, discarded: null };
}

// ── the engine ────────────────────────────────────────────────────────────────────────────────────────────────────────
const LATE = Symbol('late');
// The deadline timer is NOT unref'd: it is the one thing that settles this race when the awaited work never does, so it
// must be able to hold the event loop until it fires. An unref'd deadline beside an unref'd wait leaves nothing alive, and
// the process ends with the promise pending (node 22's test runner cancels every later row). It is cleared as soon as the
// race settles, so it never outlives the call.
function within(promise, ms) {
  let t;
  const late = new Promise((r) => { t = setTimeout(() => r(LATE), Math.max(0, ms)); });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}
export const RECALL_MEANS = 'Readings the room has done (sources the extractor read, #1810) whose claims a meaning search found close to this text: '
  + 'at most one item per source, its best-matching claim, only at or above `bar` (a cosine between the claim\'s one-line gist and the text). '
  + 'items: [] means the search ran and nothing cleared the bar. available:false means it could not look, with the reason: that is never "nothing matched". '
  + 'partial:true means some claims are not embedded yet (searched.embedded of searched.claims were searched); they are embedded a batch per call. '
  + 'A source whose own url is in the text is left out: a post that links the document needs no pointer to it.';

/**
 * The engine. Injected: readConfig() → the validated config; offReason() → why recall cannot run on this server (unit off,
 * no embedder) or null; queryClaims() → rows of recallClaimsQuery (throws when the graph cannot be read); embed(texts,
 * {timeoutMs}) → vectors (throws when the embedder cannot); the index file and the batch bounds.
 */
export function createRecallEngine({ readConfig, offReason = () => null, queryClaims, embed, model, indexFile, maxEmbed = 50, maxEmbedChars = 60000, fsImpl = fs, now = () => Date.now(), log = (m) => console.error(m) }) {
  let index = null;      // { generation, rows: Map }
  let batch = null;      // the one batch embedding in flight, shared by every caller
  const load = () => {
    if (index) return index;
    let text = '';
    try { text = fsImpl.existsSync(indexFile) ? fsImpl.readFileSync(indexFile, 'utf8') : ''; } catch (e) { log(`[#1689] recall index unreadable, starting a new one: ${e.message}`); }
    const p = parseRecallIndex(text, { model });
    if (p.discarded) log(`[#1689] recall index discarded (${p.discarded}): its claims are embedded again`);
    index = { generation: p.generation, rows: p.rows, rewrite: !!p.discarded };
    return index;
  };
  const writeWhole = () => {
    const tmp = `${indexFile}.tmp-${process.pid}`;
    let out = headerLine(index.generation);
    for (const [id, r] of index.rows) out += rowLine(id, r.hash, r.vec);
    fsImpl.writeFileSync(tmp, out);
    fsImpl.renameSync(tmp, indexFile);
    index.rewrite = false;
  };
  /** Start (or join) one batch of claims that have no current row. It runs to completion even when a caller stops waiting. */
  const startBatch = (pending) => {
    if (batch) return batch;
    const take = [];
    let chars = 0;
    for (const p of pending) {
      if (take.length >= Math.max(1, maxEmbed)) break;
      if (take.length && chars + p.text.length > maxEmbedChars) break;
      take.push(p); chars += p.text.length;
    }
    batch = (async () => {
      const vecs = await embed(take.map((t) => t.text));
      const dims = vecs[0]?.length;
      if (!index.generation || index.generation.dims !== dims) {
        // the first rows, or the embedder now answers in another dimension under the same name: a new generation
        if (index.generation) log(`[#1689] recall index: the embedder now returns ${dims} dimensions, not ${index.generation.dims}; starting a new generation`);
        index.generation = { model, dims, textShape: TEXT_SHAPE, builtAt: new Date(now()).toISOString() };
        index.rows = new Map(); index.rewrite = true;
      }
      let appended = '';
      take.forEach((t, i) => {
        const vec = Float32Array.from(vecs[i]);
        index.rows.set(t.id, { hash: t.hash, vec, norm: norm(vec) });
        appended += rowLine(t.id, t.hash, vec);
      });
      try {
        if (index.rewrite || !fsImpl.existsSync(indexFile)) writeWhole();
        else fsImpl.appendFileSync(indexFile, appended);
      } catch (e) { log(`[#1689] recall index not persisted (it costs re-embedding, not correctness): ${e.message}`); }
      return take.length;
    })().finally(() => { batch = null; });
    batch.catch(() => {});   // a failed batch is reported to the caller that awaits it; nobody else must see it unhandled
    return batch;
  };

  /**
   * One text → the answer body. `k` defaults to the config's maxItems; `allSources` (the hook) asks for every source above
   * the bar so the quiet rule can drop some and still fill maxItems. Never throws.
   */
  async function recall(text, { k = null, allSources = false } = {}) {
    const cfg = readConfig();
    if (!cfg.ok) return { available: false, off: true, reason: `recall is off: ${cfg.error}`, items: [] };
    const off = offReason();
    if (off) return { available: false, off: true, reason: off, items: [] };
    const t0 = now();
    const left = () => cfg.deadlineMs - (now() - t0);
    const fail = (reason) => ({ available: false, reason, items: [], bar: cfg.minScore });
    let rows;
    try {
      rows = await within(queryClaims(), left());
      if (rows === LATE) return fail(`the claims could not be read within ${cfg.deadlineMs} ms`);
    } catch (e) { return fail(`the claims could not be read: ${e?.message ?? e}`); }
    const claims = claimsOfRows(rows);
    const sources = new Set(claims.map((c) => c.source.iri ?? c.iri)).size;
    if (!claims.length) return { available: true, bar: cfg.minScore, partial: false, items: [], searched: { claims: 0, embedded: 0, sources: 0 }, means: RECALL_MEANS };
    load();
    // the text first, alone: it is the one thing this answer cannot be given without
    let qv;
    try {
      // the fetch's own timeout is a little past the deadline, so the deadline (not the abort) is what answers
      const got = await within(embed([String(text).slice(0, MAX_TEXT_CHARS)], { timeoutMs: Math.max(1, left()) + 250 }), left());
      if (got === LATE) return fail(`the embedder did not answer within ${cfg.deadlineMs} ms`);
      qv = got[0];
    } catch (e) { return fail(`the embedder is unavailable: ${e?.message ?? e}`); }
    if (index.generation && index.generation.dims !== qv.length) {
      log(`[#1689] recall index: the embedder now returns ${qv.length} dimensions, not ${index.generation.dims}; starting a new generation`);
      index.generation = null; index.rows = new Map(); index.rewrite = true;
    }
    const hashOf = new Map(claims.map((c) => [c.iri, textHash(claimText(c))]));   // once per claim per call
    const current = (c) => { const r = index.rows.get(c.iri); return !!r && r.hash === hashOf.get(c.iri); };
    const pending = claims.filter((c) => !current(c)).map((c) => ({ id: c.iri, text: claimText(c), hash: hashOf.get(c.iri) }));
    if (pending.length && left() > 0) {
      // the batch outlives this answer when it must: what it embeds is used by the next call (and persisted when it lands)
      try { await within(startBatch(pending), left()); } catch (e) { log(`[#1689] recall batch failed: ${e?.message ?? e}`); }
    }
    const searchable = new Map();
    let embedded = 0;
    for (const c of claims) if (current(c)) { searchable.set(c.iri, index.rows.get(c.iri)); embedded++; }
    const kk = allSources ? Infinity : (k ?? cfg.maxItems);
    const items = recallItems({ queryVec: qv, claims, rows: searchable, minScore: cfg.minScore, k: kk, text: String(text) });
    return { available: true, bar: cfg.minScore, partial: embedded < claims.length, items, searched: { claims: claims.length, embedded, sources }, means: RECALL_MEANS };
  }
  return { recall, idle: () => (batch ? batch.then(() => {}, () => {}) : Promise.resolve()) };
}

// ── the quiet rule ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A source already attached to any of the previous `quietPosts` posts (by post sequence) is not attached again: the scent
 * should drift past, not ring on every post of a long thread. Only EARLIER posts count, so a retried post is decided as of
 * its own sequence, and a later post that surfaced the same source keeps its stored answer (it is never rewritten).
 */
export function applyQuiet({ items, seq, entries, quietPosts }) {
  const recent = new Set();
  for (const e of entries) {
    if (!Array.isArray(e.sources) || !Number.isSafeInteger(e.seq)) continue;
    if (e.seq < seq && e.seq >= seq - quietPosts) for (const s of e.sources) recent.add(s);
  }
  return items.filter((i) => !recent.has(i.sourceIri));
}

// ── the work queue (a file) ───────────────────────────────────────────────────────────────────────────────────────────
// #1689 (the owner's ruling): the RECORDS (offers, openings, reads) are graph nodes. What stays in a file is the JOB's own
// state: which posts were decided (so none is computed twice), which could not be and are waiting for a retry, and which
// gave up. Losing it costs a little recomputation and the pending retries, never a fact about the room.
const POST_CAP = 2000;
const atomicWrite = (fsImpl, file, text) => { const tmp = `${file}.tmp-${process.pid}`; fsImpl.writeFileSync(tmp, text); fsImpl.renameSync(tmp, file); };
function jsonFile(fsImpl, file, shape) {
  const raw = fsImpl.existsSync(file) ? fsImpl.readFileSync(file, 'utf8') : null;
  if (raw == null) return null;
  const doc = JSON.parse(raw);
  if (!shape(doc)) throw new Error('not the shape this file holds');
  return doc;
}

/**
 *   entry: { seq, at, offered: n }                                       offers APPLIED in the graph (the graph holds them)
 *          { seq, at, none: true }                                        the search ran; nothing surfaced (or all were quiet)
 *          { seq, at, unavailable, tries, lastReason, firstFailedAt, gaveUp? }   it could not look, or the offer write failed
 * A file that cannot be read is NEVER overwritten: recall stays off until someone looks at it.
 */
export function createRecallQueue({ file, cap = POST_CAP, fsImpl = fs }) {
  let posts = null;
  let loadError = null;
  function load() {
    try { posts = jsonFile(fsImpl, file, (d) => d && typeof d.posts === 'object')?.posts ?? {}; return { ok: true }; }
    catch (e) { posts = null; loadError = `${path.basename(file)} cannot be read (${e.message}); recall is off until it is fixed or moved aside`; return { ok: false, error: loadError }; }
  }
  const need = () => { if (!posts) throw new Error(`recall queue not loaded: ${loadError ?? 'load() was not called'}`); };
  function save() {
    const ids = Object.keys(posts);
    if (ids.length > cap) { ids.sort((a, b) => posts[a].seq - posts[b].seq); for (const id of ids.slice(0, ids.length - cap)) delete posts[id]; }
    atomicWrite(fsImpl, file, JSON.stringify({ version: 2, posts }));
  }
  return {
    load, loaded: () => !!posts, error: () => loadError,
    has: (id) => !!posts && Object.hasOwn(posts, id),
    raw: (id) => (posts && Object.hasOwn(posts, id) ? posts[id] : undefined),
    decide(id, entry) { need(); posts[id] = entry; save(); },
    /** Every post id held (to ask the graph which are redacted). */
    ids: () => (posts ? Object.keys(posts) : []),
    /** Drop posts that no longer exist as posts (redacted): their id is not kept here at all. → how many were dropped. */
    forget(ids) {
      if (!posts) return 0;
      let n = 0;
      for (const id of ids) if (Object.hasOwn(posts, id)) { delete posts[id]; n++; }
      if (n) save();
      return n;
    },
    /** The oldest posts still waiting for a retry, by sequence. */
    pending(n) { need(); return Object.entries(posts).filter(([, e]) => typeof e.unavailable === 'string' && !e.gaveUp).sort(([, a], [, b]) => a.seq - b.seq).slice(0, n).map(([id, e]) => ({ id, ...e })); },
    /** A post's `recall` when it could not be decided: { unavailable, gaveUp? }, else undefined. */
    unavailableOf(id) {
      const e = posts && Object.hasOwn(posts, id) ? posts[id] : null;
      return e && typeof e.unavailable === 'string' ? { unavailable: e.unavailable, ...(e.gaveUp ? { gaveUp: true } : {}) } : undefined;
    },
    counts(since = null) {
      need();
      let unavailable = 0, pendingRetries = 0, gaveUp = 0;
      for (const e of Object.values(posts)) {
        if (typeof e.unavailable !== 'string' || (since && !(typeof e.firstFailedAt === 'string' && e.firstFailedAt >= since))) continue;
        unavailable++; if (e.gaveUp) gaveUp++; else pendingRetries++;
      }
      return { unavailable, pendingRetries, gaveUp };
    },
  };
}

// ── the read cache of offers (a file, a PROJECTION of the graph) ──────────────────────────────────────────────────────
/**
 * The offers each post carries, keyed by post id, so a post read adds no executor query. Rebuilt from the graph with ONE
 * query (offersQuery) when the file is missing or unreadable; added to when an offer write is APPLIED. Delete it and the next
 * process gives back the same `recall` on the same posts.
 */
export function createOfferProjection({ file, fsImpl = fs, log = (m) => console.error(m) }) {
  let posts = null;          // id → { seq, items }
  let building = null;
  const save = () => { try { atomicWrite(fsImpl, file, JSON.stringify({ version: 1, posts })); } catch (e) { log(`[#1689] offer cache not persisted (it is rebuilt from the graph): ${e.message}`); } };
  const self = {
    ready: () => !!posts,
    /** Load from the file alone (no query). True when the cache is now loaded. */
    loadFile() {
      if (posts) return true;
      try {
        const doc = jsonFile(fsImpl, file, (d) => d && typeof d.posts === 'object');
        if (doc) { posts = doc.posts; return true; }
      } catch (e) { log(`[#1689] offer cache unreadable, it is rebuilt from the graph: ${e.message}`); }
      return false;
    },
    /** Load from the file, or (missing, unreadable) rebuild from `rebuild()` → Map id → {seq, items}. Single-flight. */
    ensure(rebuild) {
      if (self.loadFile()) return Promise.resolve(true);
      building ??= (async () => {
        const m = await rebuild();
        posts = Object.fromEntries(m);
        save();
        return true;
      })().finally(() => { building = null; });
      return building;
    },
    add(id, seq, items) { if (!posts) return; posts[id] = { seq, items: [...items].sort(byScore) }; save(); },
    has: (id) => !!posts && Object.hasOwn(posts, id),
    publicOf(id) { const e = posts && Object.hasOwn(posts, id) ? posts[id] : null; return e && e.items.length ? { items: e.items.map(publicItem) } : undefined; },
    entries: () => (posts ? Object.values(posts).map((e) => ({ seq: e.seq, sources: e.items.map((i) => i.sourceIri) })) : []),
    itemFor(id, runId) { const e = posts && Object.hasOwn(posts, id) ? posts[id] : null; return e ? e.items.find((i) => i.runId === runId) ?? null : null; },
    hasItems: (id) => !!posts && Object.hasOwn(posts, id) && posts[id].items.length > 0,
    ids: () => (posts ? Object.keys(posts) : []),
    /** Drop redacted posts from the cache (the graph no longer holds their offers, so a rebuild agrees). → how many. */
    forget(ids) {
      if (!posts) return 0;
      let n = 0;
      for (const id of ids) if (Object.hasOwn(posts, id)) { delete posts[id]; n++; }
      if (n) save();
      return n;
    },
  };
  return self;
}

export const RECALL_COUNTS_MEANS = 'Read from the graph\'s records. offered: offers (one per post and source) made at or after `since`. postsWithRecall: posts carrying at least one. '
  + 'opened: offers opened at least once (by a seat or by a browser with no seat). seats: per seat, readCarrying = posts carrying an offer that the seat READ '
  + '(GET /api/conversations/:id with its credential; the list is not a read, a read with no credential is not attributed) and opened = offers it opened. '
  + '"carried" (offered) is not "noticed" (readCarrying) is not "opened". From the job\'s queue: unavailable = posts whose recall could not be computed or '
  + 'whose offer could not be written (first failure at or after `since`), of which pendingRetries will be retried by later posts and gaveUp failed three times. '
  + 'A post where the search ran and nothing surfaced is in none of these.';

// ── the hook ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const RETRIES_PER_TRIGGER = 2;
export const MAX_TRIES = 3;

/**
 * After a post's answer is sent: decide its recall, once. QUEUED (one at a time, in the order posts were answered) so the
 * quiet rule sees every earlier decision; the caller never waits for it.
 *
 * An offer EXISTS only once its graph write is APPLIED (`writeOffers`, injected): only then does the post carry it. A write
 * that is refused, unknown or late leaves the post unavailable for the retry below. `writeOffers` recognises a write that
 * landed although it was reported as failed (the IRI is derived from post and source, so the retry is refused as not fresh,
 * and the node read back is the answer): such a post gets its offers exactly once.
 *
 * Bounded retry, no scheduler of its own: the local embedder is evicted whenever another local model loads (#1530), so
 * "unavailable" recurs exactly when the room is busy. After a later post's recall succeeds, up to RETRIES_PER_TRIGGER of the
 * oldest unavailable posts are tried again, each at most MAX_TRIES times in all (the first attempt is try 1); success
 * decides the post as of its OWN sequence (only earlier posts quiet it, and a later post's offers are never rewritten); the
 * last failure leaves it unavailable with gaveUp. Recall OFF (not configured) stores nothing.
 */
export function createRecallHook({ engine, queue, projection, ready = async () => {}, readConfig, readPostText, writeOffers, log = (m) => console.error(m), now = () => Date.now() }) {
  let chain = Promise.resolve();
  const iso = () => new Date(now()).toISOString();
  /** → true when decided (offers written, or nothing to offer); a reason string when the write failed. */
  async function decideFrom(id, seq, items, cfg, extra = {}) {
    const kept = applyQuiet({ items, seq, entries: projection.entries(), quietPosts: cfg.quietPosts }).slice(0, cfg.maxItems);
    if (!kept.length) { queue.decide(id, { seq, at: iso(), none: true, ...extra }); return true; }
    let w;
    try { w = await writeOffers(id, seq, kept); } catch (e) { w = { ok: false, reason: `the offer could not be written: ${e?.message ?? e}` }; }
    if (!w.ok) return w.reason;
    projection.add(id, seq, w.items);
    queue.decide(id, { seq, at: iso(), offered: w.items.length, ...extra });
    return true;
  }
  async function retry(e, cfg) {
    let text = null;
    try { text = await readPostText(e.id); } catch (err) { text = undefined; log(`[#1689] post ${e.id} could not be re-read for its retry: ${err?.message ?? err}`); }
    const tries = (e.tries ?? 1) + 1;
    const { id, ...was } = e;
    const failed = (reason) => queue.decide(id, { ...was, unavailable: reason, lastReason: reason, tries, ...(tries >= MAX_TRIES ? { gaveUp: true } : {}) });
    // gone (redacted): nothing is kept about it, not even that it failed — a redaction takes the post's recall with it
    if (text === null) { queue.forget([id]); projection.forget([id]); return; }
    if (text === undefined) return failed('the post could not be re-read');
    if (projection.has(id)) return queue.decide(id, { seq: e.seq, at: iso(), offered: projection.publicOf(id)?.items.length ?? 0, retried: tries });   // already in the graph (a rebuilt cache found it)
    const r = await engine.recall(text, { allSources: true });
    if (r.off) return;   // recall turned off since: not a try
    if (!r.available) return failed(r.reason);
    const d = await decideFrom(id, e.seq, r.items, cfg, { retried: tries });
    if (d !== true) failed(d);
  }
  async function run({ id, seq, text }) {
    if (!queue.loaded() || queue.has(id)) return;   // decided once; a re-read always gives the same answer
    const cfg = readConfig();
    if (!cfg.ok) return;
    await ready();                                  // the quiet rule reads the offer cache
    if (projection.has(id)) return;
    const r = await engine.recall(text, { allSources: true });
    if (r.off) return;
    const at = iso();
    const unavailable = (reason) => queue.decide(id, { seq, at, unavailable: reason, lastReason: reason, tries: 1, firstFailedAt: at });
    if (!r.available) return unavailable(r.reason);
    const d = await decideFrom(id, seq, r.items, cfg);
    if (d !== true) return unavailable(d);
    for (const e of queue.pending(RETRIES_PER_TRIGGER)) await retry(e, cfg);
  }
  return {
    engine,
    /** Queue one post's recall. Returns at once; never throws, never rejects. */
    afterPost(post) {
      chain = chain.then(() => run(post)).catch((e) => log(`[#1689] recall for post ${post?.id} failed: ${e?.message ?? e}`));
    },
    idle: () => chain.then(() => engine.idle?.()),
  };
}

// ── the records, in the graph ─────────────────────────────────────────────────────────────────────────────────────────
// #1689 (the owner's ruling on storage): what recall OFFERED, what was OPENED, and which seats READ a post that carried an
// offer are records, so they are graph nodes, small and separate, never a rewrite of the post. Each IRI is derived from what
// it is about, so a repeat (a retry after a write that did land, a re-open, a re-read) names the same node and is refused.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** The compiler's own terms, for the server's count queries: never a hand-typed predicate IRI. */
export const RECALL_TERMS = TM;
export const POST_IRI = (id) => `https://scrumboard.local/entity/${id}`;
export const offerIri = (post, source) => `https://scrumboard.local/recall/${sha(`${post}\n${source}`)}`;
export const openingIri = (offer, actor) => `${offer}/opened/${sha(actor)}`;
export const readIri = (post, actor) => `https://scrumboard.local/recall/read/${sha(`${post}\n${actor}`)}`;
const op = () => `urn:ex:op/${crypto.randomUUID()}`;

/** All of one post's offers in ONE `recall.offer`. `offers`: [{ source, assertion, score, bar }]. */
export function offerIntention({ post, offers, actor, at, opId = op() }) {
  return { kind: 'recall.offer', opId, actor, post, at, offers: offers.map((o) => ({ iri: offerIri(post, o.source), source: o.source, assertion: o.assertion, score: o.score, bar: o.bar })) };
}
export function openIntention({ offer, actor, via, at, opId = op() }) {
  return { kind: 'recall.open', opId, actor, offer, opening: openingIri(offer, actor), via, at };
}
export function readIntention({ post, actor, at, opId = op() }) {
  return { kind: 'recall.read', opId, actor, post, read: readIri(post, actor), at };
}

/**
 * Every offer (or those on `posts`), joined to what a reader is shown: the claim's gist and quote, its run (for the reading
 * page) and when that run finished, the source's title and url, and the post's sequence (for the quiet rule).
 */
export function offersQuery(posts = null) {
  const pin = posts && posts.length ? `VALUES ?post { ${posts.map((p) => `<${p}>`).join(' ')} } ` : '';
  return `SELECT ?o ?post ?seq ?src ?a ?sc ?bar ?gist ?span ?r ?rat ?name ?url WHERE { ${pin}?o a <${TM.RecallOffer}> ; <${TM.offerOn}> ?post ; <${TM.offeredSource}> ?src ; `
    + `<${TM.fromAssertion}> ?a ; <${TM.score}> ?sc ; <${TM.minScore}> ?bar OPTIONAL { ?post <${TM.postSeq}> ?seq } `
    + `OPTIONAL { ?a <${TM.gist}> ?gist } OPTIONAL { ?a <${TM.anchorText}> ?span } `
    + `OPTIONAL { ?a <${TM.ofRun}> ?r OPTIONAL { ?rep a <${TM.ExtractionReport}> ; <${TM.ofRun}> ?r ; <${TM.at}> ?rat } } `
    + `OPTIONAL { ?src <${TM.name}> ?name } OPTIONAL { ?src <${TM.url}> ?url } }`;
}

/** Items sort the same way however they were made: best score first, then the claim's IRI. */
const byScore = (x, y) => y.score - x.score || String(x.why.claim).localeCompare(String(y.why.claim));

/** Rows of offersQuery → Map postId → { seq, items } (items as a post carries them, plus sourceIri, runId and offer). */
export function offersOfRows(rows) {
  const out = new Map();
  const seen = new Set();
  for (const r of rows || []) {
    const o = r.o?.value; const post = r.post?.value;
    if (!o || !post || seen.has(o) || !post.startsWith(POST_IRI(''))) continue;
    seen.add(o);
    const id = post.slice(POST_IRI('').length);
    const runSeg = String(r.r?.value ?? '').split('/').pop();
    const runId = isRunId(runSeg) ? runSeg : null;
    const { quote, truncated } = quoteOf(lit(r, 'span') ?? '');
    const item = {
      source: { title: lit(r, 'name'), url: lit(r, 'url') },
      readingPage: runId ? `/reading.html?run=${runId}` : null,
      readAt: lit(r, 'rat'),
      why: { gist: lit(r, 'gist'), quote, ...(truncated ? { quoteTruncated: true } : {}), claim: r.a.value },
      score: Number(r.sc.value),
      sourceIri: r.src.value, runId, offer: o,
    };
    const e = out.get(id) ?? { seq: r.seq ? Number(r.seq.value) : null, items: [] };
    e.items.push(item);
    out.set(id, e);
  }
  for (const e of out.values()) e.items.sort(byScore);
  return out;
}
