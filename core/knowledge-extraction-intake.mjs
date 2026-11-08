/**
 * #1810 PR B — the intake (R9): a share in the commons queues ONE job, and no seat touches it.
 *
 * Production creates posts through the graph unit, so REST's post handler is the wrong seam. The service POLLS: one
 * tick reads the posts since its cursor (seq mode, #1592: `GET /api/conversations?afterSeq=start|<token>&limit=N`
 * → `{conversations, nextAfterSeq}`), finds `https://` links in posts by a CONFIGURED SHARER (the PO's ruling, 51192:
 * what the owner shares, not what seats post all night; the roster cannot tell a person from a seat, so the list is
 * configuration the owner sets), and for each URL it has not seen starts a LangGraph job whose thread id is derived
 * from the URL. The saver's state IS the queue and the dedupe: a finished job reads back with its outcome and is
 * skipped. The cursor persists in a state file, so a post is read once.
 *
 * A job that DIES mid-run is not forgotten (51192 finding 1): it goes on the state file's PENDING list before it runs,
 * and every tick first RESUMES what is pending (from the saver's checkpoint, so the model is not asked again) before
 * reading new posts. A pending job that fails to resume three ticks running is dropped as failed, with its reason.
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
export const MAX_RESUME_ATTEMPTS = 3;
const ENTITY = 'https://scrumboard.local/entity/';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The https links in a text, in order, deduplicated, trailing punctuation stripped. http:// only when a caller says so. */
export function linksOf(text, { allowHttp = false } = {}) {
  const out = [];
  const re = allowHttp ? /https?:\/\/[^\s<>()[\]"']+/g : /https:\/\/[^\s<>()[\]"']+/g;   // a loopback test site; production never sets it
  for (const m of String(text ?? '').matchAll(re)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (url.length > 'https://'.length && !out.includes(url)) out.push(url);
  }
  return out;
}
export const jobIdFor = (url) => `job-${sha256(url)}`;

export function createIntake({ boardUrl, token = null, stateFile, sourcesDir, fetchSource, extractor, modelKey, prompt, sharers, limit = 200, allowHttp = false, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  for (const [k, v] of Object.entries({ boardUrl, stateFile, sourcesDir, fetchSource, extractor, modelKey })) if (!v) throw new Error(`createIntake needs ${k}`);
  if (typeof prompt !== 'string') throw new Error('createIntake needs the prompt text');
  if (!(sharers instanceof Set) || sharers.size === 0) throw new Error('createIntake needs sharers: the configured set of authors whose links become jobs (the PO\'s ruling, 51192). Empty means nobody, so nothing would ever run; refusing to construct.');
  const base = String(boardUrl).replace(/\/$/, '');

  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { cursor: typeof s.cursor === 'string' && s.cursor ? s.cursor : 'start', pending: Array.isArray(s.pending) ? s.pending : [] };
    } catch { return { cursor: 'start', pending: [] }; }
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
    const started = [], skipped = [], failed = [], resumed = [];
    let pending = [...st.pending];

    // 1. RESUME what died mid-run, before anything new: the checkpoint has the model's answer, so this costs no model call
    for (const p of st.pending) {
      try {
        const r = await extractor.resume({ jobId: p.jobId });
        resumed.push({ url: p.url, jobId: p.jobId, runId: r.runId, outcome: r.outcome, published: r.published.length, rejected: r.rejected.length });
        pending = pending.filter((x) => x.jobId !== p.jobId);
      } catch (e) {
        const attempts = (p.attempts ?? 1) + 1;
        if (attempts >= MAX_RESUME_ATTEMPTS) { failed.push({ url: p.url, jobId: p.jobId, reason: `resume gave up after ${attempts} attempts: ${e?.message ?? e}` }); pending = pending.filter((x) => x.jobId !== p.jobId); }
        else { failed.push({ url: p.url, jobId: p.jobId, reason: `resume: ${e?.message ?? e} (attempt ${attempts} of ${MAX_RESUME_ATTEMPTS}, still pending)` }); pending = pending.map((x) => (x.jobId === p.jobId ? { ...x, attempts } : x)); }
      }
      writeState({ cursor: st.cursor, pending });
    }

    // 2. NEW posts since the cursor
    const { conversations, nextAfterSeq } = await page(st.cursor);
    const seenThisTick = new Set(pending.map((p) => p.jobId));
    for (const post of conversations) {
      const author = String(post.author ?? '');
      if (NON_SOURCE_AUTHORS.includes(author)) continue;
      const links = linksOf(post.body, { allowHttp });
      if (!links.length) continue;
      if (!sharers.has(author)) { for (const url of links) skipped.push({ url, jobId: jobIdFor(url), reason: 'author is not a configured sharer' }); continue; }
      for (const url of links) {
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
        // PENDING before the run, so a death mid-run leaves a record the next tick resumes from
        pending = [...pending, { jobId, url, postId: post.id, since: now(), attempts: 1 }];
        writeState({ cursor: st.cursor, pending });
        try {
          const r = await extractor.run({ source, modelKey, prompt, jobId });
          started.push({ url, jobId, runId: r.runId, outcome: r.outcome, published: r.published.length, rejected: r.rejected.length });
          pending = pending.filter((x) => x.jobId !== jobId);
        } catch (e) { failed.push({ url, jobId, reason: `run: ${e?.message ?? e} (pending: the next tick resumes it)` }); }
      }
    }
    writeState({ cursor: nextAfterSeq, pending });
    return { started, resumed, skipped, failed, pending: pending.length, cursor: nextAfterSeq, read: conversations.length };
  }

  return { tick, readState };
}
