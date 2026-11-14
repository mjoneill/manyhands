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

export const publicItem = ({ sourceIri, runId, ...item }) => item;

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
function within(promise, ms) {
  let t;
  const late = new Promise((r) => { t = setTimeout(() => r(LATE), Math.max(0, ms)); t.unref?.(); });
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

// ── the state ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const POST_CAP = 2000;
const OPENED_CAP = 10000;
const READS_CAP = 20000;
const READS_FLUSH_MS = 10000;
export const RECALL_COUNTS_MEANS = 'offered: (post, source) pairs attached to posts decided at or after `since`. opened: distinct (post, run) pairs whose reading page '
  + 'was opened from an offer at or after `since` (a reopen counts once). postsWithRecall: posts that carry at least one item. unavailable: posts whose recall '
  + 'could not be computed (first failure at or after `since`), of which pendingRetries are still to be retried by later posts and gaveUp failed three times. '
  + 'A post where the search ran and nothing surfaced is in none of these. '
  + 'seats: per seat, readCarrying = distinct posts carrying a reading that the seat READ (GET /api/conversations/:id with its credential; the list is not a read, a read '
  + 'with no credential is not attributed) and opened = distinct (post, run) pairs it opened. "carried" (offered) is not "noticed" (readCarrying) is not "opened". '
  + 'An opening with no seat (the browser) counts in `opened` only.';

/**
 * The per-post decisions and the openings, in one small JSON file written atomically (temp + rename). A file that cannot
 * be read is NEVER overwritten: recall stays off until someone looks at it.
 *   entry: { seq, at, items: [...], sources: [...] }                          something surfaced
 *          { seq, at, none: true }                                              the search ran; nothing surfaced (or all quiet)
 *          { seq, at, unavailable, tries, lastReason, firstFailedAt, gaveUp? }  it could not look
 */
export function createRecallState({ file, cap = POST_CAP, openedCap = OPENED_CAP, readsCap = READS_CAP, flushMs = READS_FLUSH_MS, fsImpl = fs, now = () => Date.now(), log = (m) => console.error(m) }) {
  let st = null;
  let loadError = null;
  let readKeys = new Set();   // `${post}\u0000${seat}` already noted
  let flushTimer = null;
  function load() {
    try {
      const raw = fsImpl.existsSync(file) ? fsImpl.readFileSync(file, 'utf8') : null;
      if (raw == null) { st = { posts: {}, opened: [], reads: [] }; readKeys = new Set(); return { ok: true }; }
      const doc = JSON.parse(raw);
      if (!doc || typeof doc.posts !== 'object' || !Array.isArray(doc.opened)) throw new Error('not a recall state (posts, opened)');
      st = { posts: doc.posts, opened: doc.opened, reads: Array.isArray(doc.reads) ? doc.reads : [] };
      readKeys = new Set(st.reads.map((r) => `${r.post}\u0000${r.seat}`));
      return { ok: true };
    } catch (e) { st = null; loadError = `${path.basename(file)} cannot be read (${e.message}); recall is off until it is fixed or moved aside`; return { ok: false, error: loadError }; }
  }
  const need = () => { if (!st) throw new Error(`recall state not loaded: ${loadError ?? 'load() was not called'}`); };
  function save() {
    const ids = Object.keys(st.posts);
    if (ids.length > cap) {
      ids.sort((a, b) => st.posts[a].seq - st.posts[b].seq);
      for (const id of ids.slice(0, ids.length - cap)) delete st.posts[id];
    }
    if (st.opened.length > openedCap) st.opened = st.opened.slice(-openedCap);
    if (st.reads.length > readsCap) { st.reads = st.reads.slice(-readsCap); readKeys = new Set(st.reads.map((r) => `${r.post}\u0000${r.seat}`)); }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }   // this write carries any noted reads
    const tmp = `${file}.tmp-${process.pid}`;
    fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, posts: st.posts, opened: st.opened, reads: st.reads }));
    fsImpl.renameSync(tmp, file);
  }
  const iso = () => new Date(now()).toISOString();
  return {
    load,
    loaded: () => !!st,
    error: () => loadError,
    has: (id) => !!st && Object.hasOwn(st.posts, id),
    raw: (id) => (st && Object.hasOwn(st.posts, id) ? st.posts[id] : undefined),
    entries: () => (st ? Object.values(st.posts) : []),
    /** The field a reader sees, or undefined (absent) when nothing surfaced or nothing was decided. */
    publicOf(id) {
      const e = st && Object.hasOwn(st.posts, id) ? st.posts[id] : null;
      if (!e) return undefined;
      if (Array.isArray(e.items) && e.items.length) return { items: e.items.map(publicItem) };
      if (typeof e.unavailable === 'string') return { unavailable: e.unavailable, ...(e.gaveUp ? { gaveUp: true } : {}) };
      return undefined;
    },
    decide(id, entry) { need(); st.posts[id] = entry; save(); },
    /** The oldest posts still waiting to be retried, by sequence. */
    pending(n) { need(); return Object.entries(st.posts).filter(([, e]) => typeof e.unavailable === 'string' && !e.gaveUp).sort(([, a], [, b]) => a.seq - b.seq).slice(0, n).map(([id, e]) => ({ id, ...e })); },
    opened({ run, post, seat = null }) {
      need();
      const e = Object.hasOwn(st.posts, post) ? st.posts[post] : null;
      if (!e || !Array.isArray(e.items) || !e.items.length) return { ok: false, code: 'RECALL_POST_NOT_FOUND' };
      if (!e.items.some((i) => i.runId === run)) return { ok: false, code: 'RECALL_OFFER_NOT_FOUND' };
      st.opened.push({ run, post, seat: typeof seat === 'string' && seat ? seat : null, at: iso() });
      save();
      return { ok: true };
    },
    /**
     * A seat READ a post that carries a reading: noted once per (post, seat), in memory only. It rides the next state write
     * (a post's decision or an opening), or a debounced flush when none comes; never a file write on the read itself. A
     * restart before that write loses the batch: an undercount of "noticed", accepted for a read path that costs nothing.
     */
    noteRead(post, seat) {
      if (!st || typeof seat !== 'string' || !seat) return false;
      const e = Object.hasOwn(st.posts, post) ? st.posts[post] : null;
      if (!e || !Array.isArray(e.items) || !e.items.length) return false;
      const key = `${post}\u0000${seat}`;
      if (readKeys.has(key)) return false;
      readKeys.add(key);
      st.reads.push({ post, seat, at: iso() });
      if (!flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; try { save(); } catch (err) { log(`[#1689] noted reads not persisted yet: ${err?.message ?? err}`); } }, flushMs);
        flushTimer.unref?.();
      }
      return true;
    },
    counts(since = null) {
      need();
      const after = (t) => !since || (typeof t === 'string' && t >= since);
      let offered = 0, postsWithRecall = 0, unavailable = 0, pendingRetries = 0, gaveUp = 0;
      for (const e of Object.values(st.posts)) {
        if (Array.isArray(e.items) && e.items.length && after(e.at)) { offered += e.items.length; postsWithRecall++; }
        if (typeof e.unavailable === 'string' && after(e.firstFailedAt)) { unavailable++; if (e.gaveUp) gaveUp++; else pendingRetries++; }
      }
      const openedRows = st.opened.filter((o) => after(o.at));
      const opened = new Set(openedRows.map((o) => `${o.post}\u0000${o.run}`)).size;
      const seats = {};
      const seat = (k) => (seats[k] ??= { readCarrying: 0, opened: new Set() });
      for (const r of st.reads) if (after(r.at)) seat(r.seat).readCarrying++;   // already distinct per (post, seat)
      for (const o of openedRows) if (o.seat) seat(o.seat).opened.add(`${o.post}\u0000${o.run}`);
      for (const k of Object.keys(seats)) seats[k].opened = seats[k].opened.size;
      return { offered, opened, postsWithRecall, unavailable, pendingRetries, gaveUp, seats };
    },
  };
}

// ── the hook ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const RETRIES_PER_TRIGGER = 2;
export const MAX_TRIES = 3;

/**
 * After a post's answer is sent: decide its recall, once. The work is QUEUED (one at a time, in the order posts were
 * answered) so the quiet rule sees every earlier decision; the caller never waits for it.
 *
 * A post whose recall could not be computed (the local embedder is evicted whenever another local model loads, #1530, so
 * this recurs exactly when the room is busy) is RETRIED, bounded, with no scheduler of its own: after a later post's recall
 * succeeds, up to RETRIES_PER_TRIGGER of the oldest unavailable posts are tried again, each at most MAX_TRIES times in all
 * (its first attempt is try 1). Success replaces its entry with its real answer, decided as of its own sequence; after the
 * last failure it stays unavailable with gaveUp and is never tried again. Recall OFF (not configured) stores nothing.
 */
export function createRecallHook({ engine, state, readConfig, readPostText, log = (m) => console.error(m), now = () => Date.now() }) {
  let queue = Promise.resolve();
  const iso = () => new Date(now()).toISOString();
  const decideFrom = (id, seq, items, cfg, extra = {}) => {
    const kept = applyQuiet({ items, seq, entries: state.entries(), quietPosts: cfg.quietPosts }).slice(0, cfg.maxItems);
    state.decide(id, kept.length ? { seq, at: iso(), items: kept, sources: kept.map((i) => i.sourceIri), ...extra } : { seq, at: iso(), none: true, ...extra });
  };
  async function retry(e, cfg) {
    let text = null;
    try { text = await readPostText(e.id); } catch (err) { text = undefined; log(`[#1689] post ${e.id} could not be re-read for its retry: ${err?.message ?? err}`); }
    const tries = (e.tries ?? 1) + 1;
    const failed = (reason) => {
      const { id, ...was } = e;
      state.decide(id, { ...was, unavailable: reason, lastReason: reason, tries, ...(tries >= MAX_TRIES ? { gaveUp: true } : {}) });
    };
    if (text === null) {   // gone (redacted or deleted): nothing will ever be computed for it
      const { id, ...was } = e;
      return state.decide(id, { ...was, unavailable: 'the post can no longer be read', lastReason: 'the post can no longer be read', gaveUp: true });
    }
    if (text === undefined) return failed('the post could not be re-read');
    const r = await engine.recall(text, { allSources: true });
    if (r.off) return;   // recall turned off since: not a try
    if (!r.available) return failed(r.reason);
    decideFrom(e.id, e.seq, r.items, cfg, { retried: tries });
  }
  async function run({ id, seq, text }) {
    if (!state.loaded() || state.has(id)) return;   // decided once; a re-read always gives the same answer
    const cfg = readConfig();
    if (!cfg.ok) return;
    const r = await engine.recall(text, { allSources: true });
    if (r.off) return;
    if (!r.available) {
      const at = iso();
      return state.decide(id, { seq, at, unavailable: r.reason, lastReason: r.reason, tries: 1, firstFailedAt: at });
    }
    decideFrom(id, seq, r.items, cfg);
    for (const e of state.pending(RETRIES_PER_TRIGGER)) await retry(e, cfg);
  }
  const hook = {
    engine,
    /** Queue one post's recall. Returns at once; never throws, never rejects. */
    afterPost(post) {
      queue = queue.then(() => run(post)).catch((e) => log(`[#1689] recall for post ${post?.id} failed: ${e?.message ?? e}`));
    },
    idle: () => queue.then(() => engine.idle?.()),
  };
  return hook;
}
