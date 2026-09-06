/**
 * core/semantic-search.mjs — item 13 of the plan (#1086 reopened; #1097's goal):
 * QUERY → CARD retrieval as a manyhands feature. The pure half.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED (#1095, frozen 59c5b8ea…, k=8):
 *   dense embedding (qwen3-embedding:8b)  9/9 findable targets in the top 8
 *   nomic                                  6/9
 *   title + recency                        3/9
 *   BM25                                   1/9   · fuzzy 0/9 · exact phrase 0/9
 *   five-most-recent CONTROL               0/9   (had to fail; did)
 * and: "no raw ranker implements the negative-set abstention contract" — a
 * ranker ALWAYS returns eight cards, so a genuine negative comes back as a
 * confident wrong answer. So the answer contract is part of the feature.
 *
 * NOT THIS (measured dead, #1098, nine mechanisms): card↔card similarity as
 * materialised edges. Do not rebuild those.
 *
 * THE CONTRACT — every search is exactly one of:
 *   answer   a clear top hit
 *   ask      ≥2 candidates within `askWithin` of the top — returned as the question
 *   abstain  the top cosine is below `abstainBelow` — or the index is empty
 * The two thresholds are the only guessed numbers in the build. They are
 * PUBLISHED on every verdict, env-tunable at the server, and their acceptance is
 * the frozen eval set through the LIVE embedder: N1–N3 must abstain, A1–A3 must
 * ask. Starting values from #1086's landmark: foreign ≈0.47, genuine ≈0.66.
 *
 * THE INDEX — a file beside the board data, NOT in it: one header line naming
 * the GENERATION {model, dims, textShape, builtAt}, then {id, hash, vec} rows.
 * Disposable by construction: delete the file and the generation is gone
 * (the owner's reframe on #1097 — "easy to ditch them all and start over").
 * Incremental: a card is re-embedded only when its text hash changes, at most
 * `maxEmbed` per call, and every answer carries `coverage` so a partial index
 * reads as partial — "could not search" must never look like "found nothing".
 *
 * Text shape is the MEASURED one, byte for byte: `# title\n\nbody`.
 * Pure: no I/O, no model. The server owns the embedder and the file.
 */

import { createHash } from 'node:crypto';

export const DEFAULTS = Object.freeze({ abstainBelow: 0.5, askWithin: 0.03, k: 8 });
export const TEXT_SHAPE = '# title\n\nbody';
// Measured 2026-08-30 on the serving embedder (qwen3-embedding:8b via Ollama):
// ~5.4 ms/token, hard-truncated at 4096 tokens, so a 107k-char card costs 21 s
// and a 25-card batch of them outlives node's 300 s fetch. 6000 chars ≈ 1700
// tokens ≈ 9 s. A long card is embedded from its HEAD (title + opening);
// 263 of 990 live cards were over 8000 chars when this was set.
export const MAX_TEXT_CHARS = 6000;
export const MAX_EMBED_CHARS = 60000;

export function cardText(card, { maxChars = MAX_TEXT_CHARS } = {}) {
  return `# ${card?.title ?? ''}\n\n${card?.description ?? ''}`.slice(0, maxChars);
}

export function contentHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a?.length} vs ${b?.length})`);
  }
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Top-k rows by cosine to `queryVec`, descending: [{id, score, ...row minus vec}]. */
export function rank(queryVec, index, { k = DEFAULTS.k } = {}) {
  const scored = [];
  for (const row of index || []) {
    if (!row || !Array.isArray(row.vec)) continue;
    if (row.vec.length !== queryVec.length) {
      throw new Error(`rank: dimension mismatch — index row ${row.id} has ${row.vec.length}, query has ${queryVec.length}; the index was built by a different model`);
    }
    const { vec, ...rest } = row;
    scored.push({ ...rest, score: cosine(queryVec, vec) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(0, k));
}

/** The answer contract over a ranked list. Publishes the thresholds it used. */
export function decide(ranked, { abstainBelow = DEFAULTS.abstainBelow, askWithin = DEFAULTS.askWithin } = {}) {
  const base = { abstainBelow, askWithin };
  if (!ranked || ranked.length === 0) {
    return { ...base, verdict: 'abstain', top: null, contenders: [], reason: 'the index is empty — nothing was searched, so nothing was found' };
  }
  const top = ranked[0];
  if (top.score < abstainBelow) {
    return {
      ...base, verdict: 'abstain', top: null, contenders: [],
      reason: `top cosine ${round(top.score)} is below abstainBelow ${abstainBelow} — nothing in the index is close enough to answer with`,
    };
  }
  const contenders = ranked.filter((r) => top.score - r.score <= askWithin + 1e-12);
  if (contenders.length >= 2) {
    return { ...base, verdict: 'ask', top: null, contenders, reason: `${contenders.length} candidates within ${askWithin} of the top — which did you mean?` };
  }
  return { ...base, verdict: 'answer', top, contenders: [top], reason: null };
}

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * What the index needs to do to reflect `cards`: embed the new/changed (at
 * most maxEmbed), keep the unchanged, drop the deleted. `coverage` reports the
 * index as it IS — stale counts what is still stale, not what this batch fixes.
 */
export function planIndexUpdate(cards, rows, { maxEmbed = 50, maxEmbedChars = MAX_EMBED_CHARS } = {}) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const live = new Set();
  const toEmbed = [];
  const keep = [];
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    live.add(c.id);
    const text = cardText(c);
    const hash = contentHash(text);
    const have = byId.get(c.id);
    if (have && have.hash === hash) keep.push(have);
    else toEmbed.push({ id: c.id, text, hash });
  }
  const drop = [...byId.keys()].filter((id) => !live.has(id));
  const total = live.size;
  const stale = toEmbed.length;
  // Bounded by count AND by characters (one embedder call must finish inside
  // the fetch); a budget smaller than the first card still admits it, or the
  // index could never progress past that card.
  const batch = [];
  let chars = 0;
  for (const t of toEmbed) {
    if (batch.length >= Math.max(0, maxEmbed)) break;
    if (batch.length > 0 && chars + t.text.length > maxEmbedChars) break;
    batch.push(t); chars += t.text.length;
  }
  return {
    toEmbed: batch,
    keep, drop,
    coverage: { indexed: keep.length, total, stale },
  };
}

export function serializeIndex(generation, rows) {
  const lines = [JSON.stringify({ generation })];
  for (const r of rows) lines.push(JSON.stringify({ id: r.id, hash: r.hash, vec: r.vec }));
  return lines.join('\n') + '\n';
}

/** Parse an index file. Refuses a generation that is not the one the caller runs. */
export function parseIndex(text, { model, dims }) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { generation: null, rows: [] };
  let head;
  try { head = JSON.parse(lines[0]); } catch { throw new Error('search index: the header line is not JSON — delete the file to start a new generation'); }
  const gen = head?.generation;
  if (!gen || typeof gen.model !== 'string' || typeof gen.dims !== 'number') {
    throw new Error('search index: no generation header — delete the file to start a new generation');
  }
  // dims:null means "whatever the file says" — the server learns the dimension
  // from the embedder's first answer and checks it against the header then.
  if (gen.model !== model || (dims != null && gen.dims !== dims)) {
    throw new Error(`search index: generation mismatch — file is ${gen.model}/${gen.dims}, server runs ${model}/${dims}. Delete the file to rebuild under the current model.`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r && typeof r.id === 'string' && typeof r.hash === 'string' && Array.isArray(r.vec) && r.vec.length === gen.dims) rows.push(r);
  }
  return { generation: gen, rows };
}

// ── #1086 slice 2 — THE READER: a verdict from reading, not from a threshold ──
//
// Measured before this existed (card #1086, acceptance row 2, 2026-08-30): with
// thresholds the verdict matched 5/14 on the frozen #1095 set, and the reason
// was not the numbers — on 990 cards negatives score 0.57–0.61, asks 0.61–0.62,
// positives 0.62, so no abstainBelow separates them and askWithin 0.03 reads
// nearly everything as ask. Cosine says how CLOSE a card is; it cannot say
// whether the card ADDRESSES the question. That is a reading, so a model reads.
//
// The contract does not change: answer | ask | abstain. What changes is the
// instrument. The reader's verdict is published BESIDE the cosine one, never
// instead of it, with the model, the prompt version and the ledger row that
// made it, so a verdict on prod is reproducible from the row (#1202, #1203).
//
// Rails, each one a test:
//   · a pick must be one of the candidates handed to it — a model that names a
//     card it was not shown has not read; the reply is REFUSED, not coerced
//   · answer = exactly one pick · ask = two or more · abstain = none
//   · an unparseable reply, or a model that cannot be reached, is
//     available:false with the reason — NEVER an abstain. "the reader could
//     not read" and "the reader read and found nothing" are different facts.
//
// READER_PROMPT_VERSION is written once, before any score existed (the card's
// pre-registration). A rewrite after a score exists bumps the version and the
// card says so.
export const READER_PROMPT_VERSION = 'search-reader/v1';
export const READER_SNIPPET_CHARS = 500;
export const READER_SAMPLING = Object.freeze({ temperature: 0, seed: 42, maxTokens: 400 });
const VERDICTS = new Set(['answer', 'ask', 'abstain']);

/** The candidates as the reader sees them: numbered 1..K, title + the head of the body. */
export function readerCandidates(results, cardsById, { snippetChars = READER_SNIPPET_CHARS } = {}) {
  return results.map((r, i) => {
    const c = cardsById.get(r.id) ?? {};
    const body = String(c.description ?? '').replace(/\s+/g, ' ').trim();
    return { n: i + 1, id: r.id, shortId: c.shortId ?? null, title: String(c.title ?? ''), snippet: body.slice(0, snippetChars), score: r.score };
  });
}

export function readerPrompt(q, candidates) {
  const list = candidates.map((c) => `${c.n}. ${c.title}${c.snippet ? `\n   ${c.snippet}` : ''}`).join('\n');
  return [
    'A team keeps its work as cards on a board. Someone asked the board a question, and a search returned the cards below, ranked by similarity. Similarity is not relevance: a card that shares words or a topic with the question does not necessarily address it.',
    '',
    'Decide exactly one of:',
    '- answer: exactly one card directly addresses the question. Name it.',
    '- ask: two or more cards each plausibly address the question and the question does not say which is meant. Name them.',
    '- abstain: none of the cards addresses the question, even if some are about nearby topics.',
    '',
    'Reply with JSON only, no prose before or after, in exactly this shape:',
    '{"verdict":"answer" | "ask" | "abstain", "cards":[<candidate numbers>], "reason":"<one sentence>"}',
    'Use the candidate numbers as listed. For abstain, cards is [].',
    '',
    `QUESTION: ${q}`,
    '',
    'CANDIDATES:',
    list,
  ].join('\n');
}

/** Pure: the model's text → a verdict, or a refusal that says why. Never an abstain. */
export function parseReaderReply(text, candidates) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, reason: 'the reader returned no JSON object' };
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return { ok: false, reason: `the reader returned malformed JSON — ${e.message}` }; }
  const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  if (!VERDICTS.has(verdict)) return { ok: false, reason: `the reader returned verdict ${JSON.stringify(obj.verdict)} — not one of answer, ask, abstain` };
  const nums = Array.isArray(obj.cards) ? obj.cards : [];
  const byN = new Map(candidates.map((c) => [c.n, c]));
  const picks = []; const unknown = [];
  for (const x of nums) {
    const n = Number(x);
    const c = byN.get(n);
    if (c) { if (!picks.includes(c)) picks.push(c); } else unknown.push(x);
  }
  if (unknown.length) return { ok: false, reason: `the reader named candidate ${unknown.map(String).join(', ')}, which was not handed to it — a pick outside the candidates is not a reading` };
  if (verdict === 'answer' && picks.length !== 1) return { ok: false, reason: `answer names exactly one card; the reader named ${picks.length}` };
  if (verdict === 'ask' && picks.length < 2) return { ok: false, reason: `ask names two or more cards; the reader named ${picks.length}` };
  if (verdict === 'abstain' && picks.length !== 0) return { ok: false, reason: `abstain names no card; the reader named ${picks.length}` };
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 500) : '';
  return { ok: true, verdict, picks, reason };
}

/**
 * The reader. `callModel` is injected (#1198's adapter live; a stub in tests).
 * Returns the verdict envelope with what made it, or available:false with why.
 * Never throws for a model or parse failure: the search still answers by cosine.
 */
export async function read({ q, candidates, callModel, agent, sampling = READER_SAMPLING, now = () => Date.now() }) {
  const base = { model: agent?.model ?? null, promptVersion: READER_PROMPT_VERSION, sampling };
  if (!agent?.model || !agent?.protocol) return { ...base, available: false, reason: 'no reader model is configured — nothing was read', latencyMs: 0, usage: null };
  if (!candidates.length) return { ...base, available: false, reason: 'no candidates to read — the search returned nothing', latencyMs: 0, usage: null };
  const prompt = readerPrompt(q, candidates);
  const started = now();
  let out;
  try { out = await callModel(agent, [{ role: 'user', content: prompt }], { ...sampling }); }
  catch (e) { return { ...base, available: false, reason: `the reader could not be reached — ${e?.message ?? e}`, latencyMs: now() - started, usage: null, stopReason: null }; }
  const parsed = parseReaderReply(out?.text, candidates);
  const common = { ...base, latencyMs: now() - started, usage: out?.usage ?? null, stopReason: out?.stopReason ?? null, raw: String(out?.text ?? '').slice(0, 2000) };
  if (!parsed.ok) return { ...common, available: false, reason: parsed.reason };
  return { ...common, available: true, verdict: parsed.verdict, picks: parsed.picks, reason: parsed.reason };
}
