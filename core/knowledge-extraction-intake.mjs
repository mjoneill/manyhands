/**
 * #1810 PR B — the intake (R9): a share in the commons queues ONE job, and no seat touches it.
 *
 * Production creates posts through the graph unit, so REST's post handler is the wrong seam. The service POLLS: one
 * tick reads the posts since its cursor — on a graph-served board the commit cursor (#1574: `GET
 * /api/conversations?afterCommit=<token>&limit=N` → `{conversations, nextAfterCommit}`, fenced by the executor's
 * incarnation), on a document-served board the post-sequence cursor (#1592: `afterSeq=<token>` → `{conversations,
 * nextAfterSeq}`); the family is chosen once, by asking the board (`afterCommit=tip`; 400 GRAPH_DISCOVERY_OFF means
 * document-served), and recorded in the state file as `mode`. A fresh install begins at the HEAD (tip / tail=1), never
 * at `start`: the first live tick (2026-11-08, #1837) showed that a graph-served board mints a new afterSeq epoch on
 * every read, so a saved `ps1.` token is always refused and the board's own advice, "resync from afterSeq=start", would
 * page the whole commons and pay for every link ever shared. A refused cursor re-seeds at the head and ANNOUNCES the
 * skipped window (state file, stderr, one commons post by this seat) so a share made in it can be re-shared.
 * It finds `https://` links in posts by a CONFIGURED SHARER (the PO's ruling, 51192:
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
import { linkPublished, linkSummary } from './knowledge-linking-supply.mjs';

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
/** #1841: a sharer's post saying "re-run" asks for ONE fresh attempt at a link whose job FAILED. Attempts are `.r1`, `.r2`, … */
export const RERUN_RE = /\bre-?run\b/i;
export const MAX_RERUNS = 3;

export function createIntake({ boardUrl, token = null, stateFile, sourcesDir, fetchSource, extractor, modelKey, prompt, sharers, limit = 200, allowHttp = false, fetchImpl = fetch, now = () => new Date().toISOString(), actor = 'extractor', log = (line) => process.stderr.write(`${line}\n`), report = null, link = null } = {}) {
  for (const [k, v] of Object.entries({ boardUrl, stateFile, sourcesDir, fetchSource, extractor, modelKey })) if (!v) throw new Error(`createIntake needs ${k}`);
  if (typeof prompt !== 'string') throw new Error('createIntake needs the prompt text');
  if (!(sharers instanceof Set) || sharers.size === 0) throw new Error('createIntake needs sharers: the configured set of authors whose links become jobs (the PO\'s ruling, 51192). Empty means nobody, so nothing would ever run; refusing to construct.');
  const base = String(boardUrl).replace(/\/$/, '');
  // #1862 — an optional run reporter (core/knowledge-extraction-report.mjs createAnnouncer). Absent: the tick posts no
  // run reports, as before. Present: one report when a job starts (or resumes), one when it ends or fails. A report can
  // NEVER fail a job: a throw or an { ok:false } is counted in the tick's reportErrors and the job carries on.
  let reportErrors = 0;
  async function tell(event) {
    if (typeof report !== 'function') return;
    try { const r = await report(event); if (r && r.ok === false) reportErrors += 1; } catch { reportErrors += 1; }
  }
  const withReports = (o) => (typeof report === 'function' ? { ...o, reportErrors } : o);
  // #1852 — an optional linker (core/knowledge-linking-supply.mjs createRunLinker). Absent: no run is linked, as before.
  // Present: a run that published is linked to our cards BEFORE its finish report, so the report can show the links. A run
  // is never failed by its linking: linkPublished returns the reason instead, and the job's entry in the summary carries it.
  async function finished(url, r) {
    const links = await linkPublished(link, r);
    await tell({ kind: 'finish', url, result: r, ...(links ? { links } : {}) });
    return links ? { links: linkSummary(links) } : {};
  }
  const headers = () => ({ ...(token ? { Authorization: `Bearer ${token}` } : {}) });

  /**
   * The cursor and its FAMILY. `commit` = the graph path's afterCommit (#1574: the executor's commitSeq, fenced by its
   * incarnation; the only discovery position on a graph-served board). `seq` = the document path's afterSeq (#1592),
   * which a graph-served board cannot hold (#1837: a new epoch per read). A file without a cursor, or holding the
   * word "start", has none: "start" would page the whole commons from post 1 and pay for every link ever shared.
   */
  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const cursor = typeof s.cursor === 'string' && s.cursor && s.cursor !== 'start' ? s.cursor : null;
      const mode = s.mode === 'commit' || s.mode === 'seq' ? s.mode : (cursor && cursor.startsWith('ps1.') ? 'seq' : cursor && /^g[bc]1\./.test(cursor) ? 'commit' : null);
      return { cursor: mode ? cursor : null, mode, pending: Array.isArray(s.pending) ? s.pending : [], resyncs: Array.isArray(s.resyncs) ? s.resyncs : [], updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null, lastReadAt: typeof s.lastReadAt === 'string' ? s.lastReadAt : null };
    } catch { return { cursor: null, mode: null, pending: [], resyncs: [], updatedAt: null, lastReadAt: null }; }
  }
  function writeState(st) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    const { updatedAt: _dropped, ...rest } = st;
    fs.writeFileSync(tmp, JSON.stringify({ ...rest, updatedAt: now() }, null, 2));
    fs.renameSync(tmp, stateFile);
  }

  async function get(qs) {
    const res = await fetchImpl(`${base}/api/conversations?${qs}`, { headers: headers() });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, ok: res.ok, body };
  }

  /**
   * The HEAD: where a cursor-less intake begins, and where a refused one resumes. The graph path first (tip = the live
   * head, nothing before it is read); only the one answer that means "this board is document-served" (400
   * GRAPH_DISCOVERY_OFF) falls through to the document path's tail. Any other failure is a throw: a server error must
   * never degrade onto the cursor family we left. Never `start`, on either path.
   */
  async function head() {
    const tip = await get('afterCommit=tip&limit=1');
    if (tip.ok) {
      if (typeof tip.body?.nextAfterCommit !== 'string') throw new Error('the commit-mode listing did not answer {conversations, nextAfterCommit}');
      return { mode: 'commit', cursor: tip.body.nextAfterCommit };
    }
    if (!(tip.status === 400 && tip.body?.code === 'GRAPH_DISCOVERY_OFF')) throw new Error(`GET /api/conversations (afterCommit=tip) → ${tip.status}${tip.body?.code ? ` ${tip.body.code}` : ''}`);
    const tail = await get('tail=1');
    if (!tail.ok) throw new Error(`GET /api/conversations (tail=1) → ${tail.status}${tail.body?.code ? ` ${tail.body.code}` : ''}`);
    if (typeof tail.body?.nextAfterSeq !== 'string') throw new Error('the seq-mode listing did not answer {conversations, nextAfterSeq}');
    return { mode: 'seq', cursor: tail.body.nextAfterSeq };
  }

  /** One page after the cursor, in its family. A 409 is the board refusing the cursor (epoch changed, token fenced): reported, never resolved here. */
  async function page({ mode, cursor }) {
    const param = mode === 'commit' ? 'afterCommit' : 'afterSeq';
    const r = await get(`${param}=${encodeURIComponent(cursor)}&limit=${limit}`);
    if (r.status === 409) return { refused: { status: 409, code: r.body?.code ?? null, error: r.body?.error ?? null } };
    if (!r.ok) throw new Error(`GET /api/conversations (${param}) → ${r.status}${r.body?.code ? ` ${r.body.code}` : ''}`);
    const next = mode === 'commit' ? r.body?.nextAfterCommit : r.body?.nextAfterSeq;
    if (!r.body || !Array.isArray(r.body.conversations) || typeof next !== 'string') throw new Error(`the ${mode}-mode listing did not answer {conversations, ${mode === 'commit' ? 'nextAfterCommit' : 'nextAfterSeq'}}`);
    return { conversations: r.body.conversations, next };
  }

  /**
   * A refused cursor: re-seed at the head and SAY SO. Every post between the last good read and now is never read, so
   * the window is written to the state file, to stderr, and to the commons as this seat, asking for a re-share. The
   * board's own advice ("resync from start") is not taken: that is the whole-history page, paid for.
   */
  async function resync(st, refused) {
    const h = await head();
    // the window opens at the last successful READ (`lastReadAt`), never at the file's last write: an owed-notice retry
    // or a pending-job record also writes the file, and a window measured from those would understate itself
    const record = { at: now(), from: st.cursor, to: h.cursor, mode: h.mode, reason: `${refused.status}${refused.code ? ` ${refused.code}` : ''}`, skippedSince: st.lastReadAt ?? st.updatedAt ?? null, announced: false, announcedAt: null };
    log(`extract-once: the board refused the saved cursor (${record.reason}); re-seeded at the head (${h.mode}). Posts since ${record.skippedSince ?? 'an unknown time'} were not read; a link shared in that window needs re-sharing.`);
    await announce(record);
    return { ...h, record };
  }

  /**
   * The notice is OWED until the board takes it: a record stays `announced:false` in the state file and is retried at
   * the start of every tick (the commons cue is the recovery; a line in a file is not). Delivered once, never again.
   */
  async function announce(record) {
    const since = record.skippedSince ?? 'an unknown time';
    const delayed = record.announcedAttempts ? ' (this notice was delayed: the board refused it when the window opened)' : '';
    record.announcedAttempts = (record.announcedAttempts ?? 0) + 1;
    try {
      const res = await fetchImpl(`${base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers() }, body: JSON.stringify({ author: actor, body: `Extraction skipped a window: the board refused my saved cursor (${record.reason}) and I resumed at the head at ${record.at}. Posts since ${since} were not read. If you shared a link in that window, please re-share it; nothing already queued was lost.${delayed}` }) });
      if (res.status === 201) { record.announced = true; record.announcedAt = now(); }
      else log(`extract-once: the skip notice was refused by the board (${res.status}); it stays owed and is retried next tick`);
    } catch (e) { log(`extract-once: the skip notice could not be posted (${e?.message ?? e}); it stays owed and is retried next tick`); }
    return record.announced === true;
  }

  /** Keep the fetched bytes on disk; the Source points at them and carries their hash. */
  function keep(text) {
    fs.mkdirSync(sourcesDir, { recursive: true });
    const file = path.join(sourcesDir, `${sha256(text)}.txt`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return `file://${path.resolve(file)}`;
  }

  async function tick() {
    let st = readState();
    reportErrors = 0;
    const started = [], skipped = [], failed = [], resumed = [];
    let pending = [...st.pending];

    // 0. NO CURSOR (a fresh install, or a file saying "start"): begin at the head. Nothing before this moment is read.
    if (!st.cursor) {
      const h = await head();
      st = { ...st, mode: h.mode, cursor: h.cursor, lastReadAt: now() };   // the seed is a read of the head
      writeState({ cursor: st.cursor, mode: st.mode, pending, resyncs: st.resyncs, lastReadAt: st.lastReadAt });
    }

    // 0b. OWED NOTICES first: a skipped window whose commons post failed is announced before anything else is read
    const announced = [];
    for (const r of st.resyncs) {
      if (r.announced === true) continue;
      if (await announce(r)) announced.push(r.at);
      writeState({ cursor: st.cursor, mode: st.mode, pending, resyncs: st.resyncs, lastReadAt: st.lastReadAt });
    }

    // 1. RESUME what died mid-run, before anything new: the checkpoint has the model's answer, so this costs no model call
    for (const p of st.pending) {
      try {
        await tell({ kind: 'start', url: p.url, modelKey, jobId: p.jobId, resumed: true });
        const r = await extractor.resume({ jobId: p.jobId });
        const linked = await finished(p.url, r);
        resumed.push({ url: p.url, jobId: p.jobId, runId: r.runId, outcome: r.outcome, published: r.published.length, rejected: r.rejected.length, ...linked });
        pending = pending.filter((x) => x.jobId !== p.jobId);
      } catch (e) {
        const attempts = (p.attempts ?? 1) + 1;
        if (attempts >= MAX_RESUME_ATTEMPTS) { failed.push({ url: p.url, jobId: p.jobId, reason: `resume gave up after ${attempts} attempts: ${e?.message ?? e}` }); pending = pending.filter((x) => x.jobId !== p.jobId); await tell({ kind: 'fail', url: p.url, reason: failed.at(-1).reason, retry: false }); }
        else { failed.push({ url: p.url, jobId: p.jobId, reason: `resume: ${e?.message ?? e} (attempt ${attempts} of ${MAX_RESUME_ATTEMPTS}, still pending)` }); pending = pending.map((x) => (x.jobId === p.jobId ? { ...x, attempts } : x)); await tell({ kind: 'fail', url: p.url, reason: failed.at(-1).reason, retry: true }); }
      }
      writeState({ cursor: st.cursor, mode: st.mode, pending, resyncs: st.resyncs, lastReadAt: st.lastReadAt });
    }

    // 2. NEW posts since the cursor — or, if the board refuses the cursor, re-seed at the head and report the window
    const got = await page(st);
    if (got.refused) {
      const r = await resync(st, got.refused);
      const resyncs = [...st.resyncs, r.record];
      writeState({ cursor: r.cursor, mode: r.mode, pending, resyncs, lastReadAt: r.record.at });   // the re-seed read the head
      if (r.record.announced) announced.push(r.record.at);
      return withReports({ started, resumed, skipped, failed, pending: pending.length, cursor: r.cursor, mode: r.mode, read: 0, resync: r.record, announced });
    }
    const { conversations, next } = got;
    const readAt = now();   // the READ happened now; the runs below can take minutes, and the window must open here, not after them
    const seenThisTick = new Set(pending.map((p) => p.jobId));
    for (const post of conversations) {
      const author = String(post.author ?? '');
      if (NON_SOURCE_AUTHORS.includes(author)) continue;
      const links = linksOf(post.body, { allowHttp });
      if (!links.length) continue;
      if (!sharers.has(author)) { for (const url of links) skipped.push({ url, jobId: jobIdFor(url), reason: 'author is not a configured sharer' }); continue; }
      const asksRerun = RERUN_RE.test(String(post.body ?? ''));
      for (const url of links) {
        let jobId = jobIdFor(url);
        if (seenThisTick.has(jobId)) { skipped.push({ url, jobId, reason: 'same tick: already handled' }); continue; }
        seenThisTick.add(jobId);
        let known = await extractor.state({ jobId });
        let rerunOf = null;
        if (known.outcome && asksRerun) {
          // walk the attempts: the base job, then .r1, .r2 … The first attempt with no outcome is where this one goes,
          // but only while every attempt before it FAILED. A link that once succeeded is never re-run.
          let last = known; let target = null;
          for (let n = 1; n <= MAX_RERUNS && last.outcome === 'failed'; n += 1) {
            const k = await extractor.state({ jobId: `${jobIdFor(url)}.r${n}` });
            if (!k.outcome) { target = { jobId: `${jobIdFor(url)}.r${n}`, k }; break; }
            last = k;
          }
          if (!target) {
            const why = last.outcome === 'failed' ? `re-run refused: ${MAX_RERUNS} re-runs already failed` : `known: ${last.outcome}; a re-run is only for a failed job`;
            skipped.push({ url, jobId, reason: why }); continue;
          }
          rerunOf = last.runId; jobId = target.jobId; known = target.k; seenThisTick.add(jobId);
        }
        if (known.outcome) { skipped.push({ url, jobId, reason: `known: ${known.outcome}` }); continue; }
        if (Array.isArray(known.next) && known.next.length) { skipped.push({ url, jobId, reason: `in progress: next ${known.next.join(',')}` }); continue; }
        let got;
        try { got = await fetchSource(url); } catch (e) { failed.push({ url, jobId, reason: `fetch: ${e?.message ?? e}` }); await tell({ kind: 'fail', url, reason: failed.at(-1).reason, retry: false }); continue; }
        if (!got || typeof got.text !== 'string') { failed.push({ url, jobId, reason: 'fetch: no text' }); await tell({ kind: 'fail', url, reason: 'fetch: no text', retry: false }); continue; }
        const contentUrl = keep(got.text);
        const source = ingestSource({ text: got.text, url, contentUrl, encodingFormat: got.encodingFormat ?? 'text/plain', retrievedAt: now(), wasDerivedFrom: `${ENTITY}${post.id}` });
        // PENDING before the run, so a death mid-run leaves a record the next tick resumes from
        pending = [...pending, { jobId, url, postId: post.id, since: now(), attempts: 1 }];
        writeState({ cursor: st.cursor, mode: st.mode, pending, resyncs: st.resyncs, lastReadAt: st.lastReadAt });
        await tell({ kind: 'start', url, modelKey, jobId });
        try {
          const r = await extractor.run({ source, modelKey, prompt, jobId });
          const entry = { url, jobId, runId: r.runId, ...(rerunOf ? { rerunOf } : {}), outcome: r.outcome, published: r.published.length, rejected: r.rejected.length };
          started.push(entry);
          pending = pending.filter((x) => x.jobId !== jobId);
          Object.assign(entry, await finished(url, r));
        } catch (e) { failed.push({ url, jobId, reason: `run: ${e?.message ?? e} (pending: the next tick resumes it)` }); await tell({ kind: 'fail', url, reason: failed.at(-1).reason, retry: true }); }
      }
    }
    writeState({ cursor: next, mode: st.mode, pending, resyncs: st.resyncs, lastReadAt: readAt });   // a successful read, stamped when it happened
    return withReports({ started, resumed, skipped, failed, pending: pending.length, cursor: next, mode: st.mode, read: conversations.length, announced });
  }

  return { tick, readState };
}
