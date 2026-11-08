/**
 * #1810 PR B — the intake (R9): a share in the commons queues ONE job, and no seat touches it.
 *
 * Production creates posts through the graph unit, so REST's post handler is the wrong seam. The service POLLS: one
 * tick reads the posts since its cursor (seq mode, #1592: `GET /api/conversations?afterSeq=start|<token>&limit=N`
 * → `{conversations, nextAfterSeq}`), finds `https://` links in bodies written by people (never by `board` or
 * `system`: a notice is not a share), and for each URL it has not seen starts a LangGraph job whose thread id is
 * derived from the URL. The saver's state IS the queue and the dedupe: a job that finished reads back with its
 * outcome and is skipped; one in flight is skipped as in progress. The cursor persists in a state file, so a tick
 * that dies resumes from the posts it had not read, and a post is read once.
 *
 * The bytes a source fetched are kept on disk under `sourcesDir` (pointer + hash: the graph never holds them), and
 * the Source carries `prov:wasDerivedFrom` the FIRST post that shared it. A URL whose fetch fails is a failed job for
 * this tick, recorded with its reason and not retried until someone shares it again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ingestSource } from './knowledge-extraction.mjs';

export const NON_SOURCE_AUTHORS = Object.freeze(['board', 'system']);
const ENTITY = 'https://scrumboard.local/entity/';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The https links in a text, in order, deduplicated, trailing punctuation stripped. http:// is not a source. */
export function linksOf(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/https:\/\/[^\s<>()[\]"']+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (url.length > 'https://'.length && !out.includes(url)) out.push(url);
  }
  return out;
}
export const jobIdFor = (url) => `job-${sha256(url)}`;

export function createIntake({ boardUrl, token = null, stateFile, sourcesDir, fetchSource, extractor, modelKey, prompt, limit = 200, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  for (const [k, v] of Object.entries({ boardUrl, stateFile, sourcesDir, fetchSource, extractor, modelKey })) if (!v) throw new Error(`createIntake needs ${k}`);
  if (typeof prompt !== 'string') throw new Error('createIntake needs the prompt text');
  const base = String(boardUrl).replace(/\/$/, '');

  function readState() {
    try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return { cursor: typeof s.cursor === 'string' && s.cursor ? s.cursor : 'start' }; }
    catch { return { cursor: 'start' }; }
  }
  function writeState(st) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: now() }, null, 2));
    fs.renameSync(tmp, stateFile);
  }

  async function page(cursor) {
    const res = await fetchImpl(`${base}/api/conversations?afterSeq=${encodeURIComponent(cursor)}&limit=${limit}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`GET /api/conversations (afterSeq) → ${res.status}`);
    const j = await res.json();
    if (!j || !Array.isArray(j.conversations) || typeof j.nextAfterSeq !== 'string') throw new Error('the seq-mode listing did not answer {conversations, nextAfterSeq}');
    return j;
  }

  /** Keep the fetched bytes on disk; the Source points at them and carries their hash. */
  function keep(text) {
    fs.mkdirSync(sourcesDir, { recursive: true });
    const file = path.join(sourcesDir, `${sha256(text)}.txt`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return `file://${path.resolve(file)}`;
  }

  async function tick() {
    const st = readState();
    const { conversations, nextAfterSeq } = await page(st.cursor);
    const started = [], skipped = [], failed = [];
    const seenThisTick = new Set();
    for (const post of conversations) {
      if (NON_SOURCE_AUTHORS.includes(String(post.author))) continue;
      for (const url of linksOf(post.body)) {
        const jobId = jobIdFor(url);
        if (seenThisTick.has(jobId)) { skipped.push({ url, jobId, reason: 'same tick: already handled' }); continue; }
        seenThisTick.add(jobId);
        const known = await extractor.state({ jobId });
        if (known.outcome) { skipped.push({ url, jobId, reason: `known: ${known.outcome}` }); continue; }
        if (Array.isArray(known.next) && known.next.length) { skipped.push({ url, jobId, reason: `in progress: next ${known.next.join(',')}` }); continue; }
        let got;
        try { got = await fetchSource(url); } catch (e) { failed.push({ url, jobId, reason: `fetch: ${e?.message ?? e}` }); continue; }
        if (!got || typeof got.text !== 'string') { failed.push({ url, jobId, reason: 'fetch: no text' }); continue; }
        const contentUrl = keep(got.text);
        const source = ingestSource({ text: got.text, url, contentUrl, encodingFormat: got.encodingFormat ?? 'text/plain', retrievedAt: now(), wasDerivedFrom: `${ENTITY}${post.id}` });
        try {
          const r = await extractor.run({ source, modelKey, prompt, jobId });
          started.push({ url, jobId, runId: r.runId, outcome: r.outcome, published: r.published.length, rejected: r.rejected.length });
        } catch (e) { failed.push({ url, jobId, reason: `run: ${e?.message ?? e}` }); }
      }
    }
    writeState({ cursor: nextAfterSeq });
    return { started, skipped, failed, cursor: nextAfterSeq, read: conversations.length };
  }

  return { tick, readState };
}
