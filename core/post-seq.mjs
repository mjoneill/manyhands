/**
 * #1592 (unit 2 read slice, step 1) — an immutable post sequence on the DOCUMENT path, as pure helpers.
 *
 * WHY A SEQUENCE AND NOT A TIMESTAMP: every commons poller keys its since-cursor on a post's createdAt, so a post
 * that becomes visible LATE with an older time is skipped by every client whose cursor has moved on. `postSeq` is
 * allocated in the same document write that makes the post visible, so a late post gets a number HIGHER than every
 * cursor already served.
 *
 *   nextPostSeq    top-level, server-owned: the number the next post takes. Advanced only inside the write that
 *                  stores the post, so a crash before that write leaves neither the post nor an advanced counter.
 *   postSeqEpoch   top-level, server-owned UUID naming the numbering. A token from another epoch is refused with
 *                  POST_CURSOR_EPOCH_CHANGED and the client resyncs from afterSeq=start.
 *   postSeq        per post, an integer, strictly increasing and never reused (NOT gap-free: removal leaves gaps).
 *
 * Token form: `ps1.<postSeqEpoch>.<n>`.
 */
import crypto from 'node:crypto';

export const NEXT_POST_SEQ = 'nextPostSeq';
export const POST_SEQ_EPOCH = 'postSeqEpoch';
export const POST_SEQ = 'postSeq';
export const SEQ_PARAMS = Object.freeze(['afterSeq', 'beforeSeq', 'tail']);

const TOKEN_RE = /^ps1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d+)$/;

export const isEpoch = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const mintEpoch = () => crypto.randomUUID();
export const tokenFor = (epoch, n) => `ps1.${epoch}.${n}`;

/**
 * Allocate the next postSeq onto `conv` and advance the document's counter. MUST be called inside the write lock,
 * on the same `data` the caller then passes to writeBoard: the number and the post are one write.
 *
 * Any postSeq already on `conv` is overwritten — a client cannot choose its number. A board with no epoch yet (a
 * brand-new board whose first seq-mode read has not happened) gets one minted here, in the same write as the post.
 */
export function stampPostSeq(data, conv) {
  if (!isEpoch(data[POST_SEQ_EPOCH])) data[POST_SEQ_EPOCH] = mintEpoch();
  const stored = Number.isSafeInteger(data[NEXT_POST_SEQ]) && data[NEXT_POST_SEQ] > 0 ? data[NEXT_POST_SEQ] : 1;
  conv[POST_SEQ] = stored;
  data[NEXT_POST_SEQ] = stored + 1;
  return conv;
}

/**
 * The seq-mode request, validated WITHOUT the epoch. Returns {mode:null} when the request carries no seq parameter
 * (today's behaviour, untouched), {error:{status, body}} for a refusal, or {mode, n, limit, token|start} for a
 * syntactically valid page. Every check that does not need the epoch lives here so that the caller can refuse a bad
 * request BEFORE minting one: a refused request has no side effect (it never mints or persists the epoch).
 */
export function parseSeqSyntax(q, maxLimit) {
  const present = (k) => typeof q[k] === 'string';
  const seq = SEQ_PARAMS.filter(present);
  if (seq.length === 0) return { mode: null };
  // Two modes in one request is refused, naming the conflicting parameters: never a silent choice.
  const conflicts = [];
  if (present('afterSeq') && present('beforeSeq')) conflicts.push(['afterSeq', 'beforeSeq']);
  for (const s of ['afterSeq', 'beforeSeq']) for (const t of ['since', 'before']) if (present(s) && present(t)) conflicts.push([s, t]);
  if (present('tail')) for (const o of ['afterSeq', 'beforeSeq', 'since', 'before', 'limit']) if (present(o)) conflicts.push(['tail', o]);
  if (conflicts.length) {
    const names = [...new Set(conflicts.flat())];
    return { error: { status: 400, body: {
      error: `conflicting cursor parameters: ${conflicts.map(([a, b]) => `${a} with ${b}`).join(', ')} — each selects a different listing; send one`,
      code: 'CONFLICTING_CURSOR_PARAMS', params: names } } };
  }
  if (present('tail')) {
    if (!/^\d+$/.test(q.tail)) return { error: { status: 400, body: { error: `tail must be a non-negative integer, got ${JSON.stringify(q.tail)}`, code: 'BAD_TAIL' } } };
    return { mode: 'tail', limit: Math.min(Number(q.tail), maxLimit) };
  }
  let limit = maxLimit;
  if (present('limit') && q.limit !== '') {
    const n = parseInt(q.limit, 10);
    if (Number.isFinite(n) && n >= 0) limit = Math.min(n, maxLimit);
  }
  const param = present('afterSeq') ? 'afterSeq' : 'beforeSeq';
  const raw = q[param];
  if (param === 'afterSeq' && raw === 'start') return { mode: 'after', n: 0, limit, start: true };
  const m = TOKEN_RE.exec(raw);
  if (!m || !Number.isSafeInteger(Number(m[2]))) {
    return { error: { status: 400, body: {
      error: `${param} is not a post cursor: expected ps1.<epoch>.<n>${param === 'afterSeq' ? ' or the keyword start' : ''} (a time is never accepted here; use since/before for times)`,
      code: 'UNKNOWN_CURSOR', param } } };
  }
  return { mode: param === 'afterSeq' ? 'after' : 'before', n: Number(m[2]), limit, token: raw, tokenEpoch: m[1] };
}

/**
 * The epoch half, for a request parseSeqSyntax accepted: a token from another epoch is 409
 * POST_CURSOR_EPOCH_CHANGED naming the current one. Returns {error} or the request with its echo token settled.
 */
export function checkSeqEpoch(req, currentEpoch) {
  if (req.mode === 'tail') return req;
  if (req.start) return { ...req, token: tokenFor(currentEpoch, 0) };
  if (req.tokenEpoch !== currentEpoch) {
    return { error: { status: 409, body: {
      error: `the post numbering changed (cursor epoch ${req.tokenEpoch}, current epoch ${currentEpoch}) — resync: re-read from afterSeq=start`,
      code: 'POST_CURSOR_EPOCH_CHANGED', currentEpoch, resync: 'afterSeq=start' } } };
  }
  return req;
}

/**
 * Select one seq-mode page from an already-filtered post list. Posts without an integer postSeq are not
 * addressable by a seq cursor and are left out (a board with posts but no migration is not supported: migrate first).
 * Returns {conversations, nextAfterSeq}, ascending by postSeq.
 */
export function selectSeqPage(posts, req, epoch) {
  const numbered = posts.filter((c) => c && Number.isSafeInteger(c[POST_SEQ])).sort((a, b) => a[POST_SEQ] - b[POST_SEQ]);
  let page;
  if (req.mode === 'after') page = numbered.filter((c) => c[POST_SEQ] > req.n).slice(0, req.limit);
  else if (req.mode === 'before') { const below = numbered.filter((c) => c[POST_SEQ] < req.n); page = req.limit <= 0 ? [] : below.slice(-req.limit); }
  else page = req.limit <= 0 ? [] : numbered.slice(-req.limit);   // tail
  let nextAfterSeq;
  if (page.length) nextAfterSeq = tokenFor(epoch, page[page.length - 1][POST_SEQ]);
  else if (req.mode === 'tail') nextAfterSeq = tokenFor(epoch, numbered.length ? numbered[numbered.length - 1][POST_SEQ] : 0);
  else nextAfterSeq = req.token;
  return { conversations: page, nextAfterSeq };
}
