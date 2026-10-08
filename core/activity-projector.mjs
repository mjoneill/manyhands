/**
 * #1570 — the event log's activities and the work ledger's actions, projected INTO THE EXECUTOR.
 *
 * The old copy (core/graph-replica.mjs) derives three kinds of node the executor has never stored:
 * `prov:Activity` (one per event), `schema:Action` (one per work-ledger transition) and
 * `scrum:WorkObject`. graph_query cannot read the executor directly until those live there too.
 *
 * ONE projection, not two: the triples come from the same functions the old copy runs
 * (`projectActivityItem`, `projectWorkLedger`), built into a scratch in-memory store and shipped as
 * N-Triples. The declaration / decision / memory side projections are deliberately NOT run: the
 * executor already owns those subjects, and a replay of the log's history would add an old title or
 * end an open interval.
 *
 * ATOMIC PROGRESS. Each batch is ONE /update request carrying the batch's complete items AND the
 * cursor move, so a kill, a cut connection or an executor crash leaves both or neither (a pyoxigraph
 * update is one transaction). The cursor lives in its own named graph, outside the default graph
 * graph_query reads. Nothing is guarded by "does the type triple exist": triples are a set and the IRIs
 * are derived from seq / (id, seq), so a replay is a no-op. After any failed or ambiguous request the
 * next step re-reads the cursor from the executor — the executor, never this process, says what landed.
 *
 * NO FALLBACK. The log, the work store and the executor are passed in; nothing here defaults to a live
 * path or a live executor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import oxigraph from 'oxigraph';
import { SEGMENT_RE } from './event-log.mjs';
import { projectActivityItem, isProjectableEvent, projectWorkLedger } from './graph-replica.mjs';

export const BOOK_GRAPH = 'urn:scrum:bookkeeping:activity-projector';
const CURSOR = 'urn:scrum:bookkeeping:activity-projector:cursor';
const P_SEQ = 'urn:scrum:bookkeeping:eventSeq';
const P_WORK = 'urn:scrum:bookkeeping:workRows';

async function post(executorUrl, path, body, headers = {}, timeoutMs = 60_000) {
  const res = await fetch(`${executorUrl}${path}`, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

/** The cursor as the EXECUTOR holds it. Absent = start from zero. Two values for one field is refused. */
export async function readCursor(executorUrl) {
  const q = `SELECT ?p ?o WHERE { GRAPH <${BOOK_GRAPH}> { <${CURSOR}> ?p ?o } }`;
  const r = await post(executorUrl, '/query', q);
  if (r.status !== 200) throw new Error(`cursor read failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const seen = { [P_SEQ]: [], [P_WORK]: [] };
  for (const b of r.json.results.bindings) if (seen[b.p.value]) seen[b.p.value].push(Number(b.o.value));
  for (const [p, v] of Object.entries(seen)) if (v.length > 1) throw new Error(`cursor is ambiguous: ${v.length} values for ${p}`);
  return { seq: seen[P_SEQ][0] ?? 0, workRows: seen[P_WORK][0] ?? 0, present: seen[P_SEQ].length > 0 || seen[P_WORK].length > 0 };
}

async function storeEpoch(executorUrl) {
  const res = await fetch(`${executorUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  const j = await res.json();
  return j && j.epoch != null ? String(j.epoch) : null;
}

/**
 * STRICT, SINGLE READ of the log. Each segment the next batch could touch is read ONCE, every line is
 * validated, and the batch is projected from exactly those parsed objects: validation and projection see
 * the same bytes (#1641 review). The shared log reader skips a line it cannot parse, which is right for the
 * old copy's rebuild and wrong here, so it is not used.
 *
 * Bounded: segments are day-named and seq is monotonic with day, so segments are read in ascending order,
 * a segment already validated and wholly at or below the cursor is skipped by its memo, and reading stops
 * once the batch is full.
 *
 * ONE exception, and it is not corruption: the final line of the NEWEST segment with no trailing newline is
 * an append still in flight. It is reported as `pendingTail` (waiting), never projected and never refused.
 *
 * REFUSES, nothing sent: an unreadable line (naming segment and line); a missing log directory (MISSING
 * SOURCE); a cursor ahead of everything the log holds (SOURCE REGRESSION).
 */
const _segMemo = new Map();   // path -> {size, mtimeMs, maxSeq}: validated, complete segments
function parseSegmentStrict(logDir, f, isNewest) {
  const text = fs.readFileSync(path.join(logDir, f), 'utf8');
  const lines = text.split('\n');
  const events = []; let maxSeq = -Infinity; let pendingTail = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const inFlightTail = isNewest && i === lines.length - 1 && !text.endsWith('\n');
    let ev;
    try { ev = JSON.parse(l); } catch {
      if (inFlightTail) { pendingTail = { segment: f, line: i + 1 }; continue; }
      throw new Error(`UNREADABLE line ${i + 1} of ${f} in ${logDir}: not JSON — not skipped; nothing sent, cursor unchanged`);
    }
    if (!Number.isInteger(ev?.seq)) {
      if (inFlightTail) { pendingTail = { segment: f, line: i + 1 }; continue; }
      throw new Error(`UNREADABLE line ${i + 1} of ${f} in ${logDir}: no integer seq — not skipped; nothing sent, cursor unchanged`);
    }
    events.push(ev);
    if (ev.seq > maxSeq) maxSeq = ev.seq;
  }
  return { events, maxSeq, pendingTail, complete: !pendingTail };
}

export function readLogStrict(logDir, sinceSeq, limit) {
  let st = null; try { st = fs.statSync(logDir); } catch { /* reported below */ }
  if (!st || !st.isDirectory()) throw new Error(`MISSING SOURCE: the event log directory ${logDir} does not exist — nothing sent`);
  const files = fs.readdirSync(logDir).filter((f) => SEGMENT_RE.test(f)).sort();
  const out = []; let pendingTail = null; let maxSeen = -Infinity;
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]; const full = path.join(logDir, f); const isNewest = fi === files.length - 1;
    const fst = fs.statSync(full);
    const memo = _segMemo.get(full);
    if (memo && memo.size === fst.size && memo.mtimeMs === fst.mtimeMs && memo.maxSeq <= sinceSeq) { maxSeen = Math.max(maxSeen, memo.maxSeq); continue; }
    const seg = parseSegmentStrict(logDir, f, isNewest);
    if (seg.complete) _segMemo.set(full, { size: fst.size, mtimeMs: fst.mtimeMs, maxSeq: seg.maxSeq });
    else _segMemo.delete(full);
    maxSeen = Math.max(maxSeen, seg.maxSeq);
    if (seg.pendingTail) pendingTail = seg.pendingTail;
    for (const ev of seg.events) if (ev.seq > sinceSeq) out.push(ev);
    if (out.length >= limit && !isNewest) break;
  }
  out.sort((a, b) => a.seq - b.seq);
  if (!out.length && sinceSeq > 0 && maxSeen < sinceSeq) {
    throw new Error(`SOURCE REGRESSION: the cursor is at seq ${sinceSeq} but the log in ${logDir} holds nothing past seq ${maxSeen === -Infinity ? 'none' : maxSeen} — nothing sent`);
  }
  return { events: out.slice(0, limit), pendingTail };
}

/**
 * STRICT, SINGLE READ of the work ledger, for the same reason: the ledger cursor is a ROW INDEX, so a
 * skipped line would shift every later index. Read once, every line validated (id, seq, transition.type),
 * and the batch projects these parsed rows. An unterminated LAST line is an append in flight: waiting.
 * REFUSES: a missing work directory; a missing ledger file (at any cursor); a cursor
 * past the ledger's row count (SOURCE REGRESSION).
 */
export const WORK_FILE = 'work-objects.jsonl';
export function readLedgerStrict(workDir, cursorRows) {
  let st = null; try { st = fs.statSync(workDir); } catch { /* reported below */ }
  if (!st || !st.isDirectory()) throw new Error(`MISSING SOURCE: the work store directory ${workDir} does not exist — nothing sent`);
  const full = path.join(workDir, WORK_FILE);
  // A missing ledger is refused even before the first projected row: a wrong path would otherwise read
  // as an empty ledger and look caught up (#1641 review). There is no "no-ledger" mode; nothing needs one.
  if (!fs.existsSync(full)) throw new Error(`MISSING SOURCE: ${WORK_FILE} is missing from ${workDir} (ledger cursor at row ${cursorRows}) — nothing sent`);
  const text = fs.readFileSync(full, 'utf8');
  const lines = text.split('\n');
  const rows = []; let pendingTail = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const inFlightTail = i === lines.length - 1 && !text.endsWith('\n');
    let r;
    try { r = JSON.parse(l); } catch {
      if (inFlightTail) { pendingTail = { segment: WORK_FILE, line: i + 1 }; continue; }
      throw new Error(`UNREADABLE line ${i + 1} of ${WORK_FILE} in ${workDir}: not JSON — not skipped; nothing sent, cursor unchanged`);
    }
    if (typeof r?.id !== 'string' || r.seq == null || !r.transition || !r.transition.type) {
      if (inFlightTail) { pendingTail = { segment: WORK_FILE, line: i + 1 }; continue; }
      throw new Error(`UNREADABLE line ${i + 1} of ${WORK_FILE} in ${workDir}: missing id, seq or transition.type — not skipped; nothing sent, cursor unchanged`);
    }
    rows.push(r);
  }
  if (rows.length < cursorRows) throw new Error(`SOURCE REGRESSION: the ledger cursor is at row ${cursorRows} but ${WORK_FILE} holds ${rows.length} row(s) — nothing sent`);
  return { rows, pendingTail };
}

const nTriples = (store) => store.match(null, null, null, oxigraph.defaultGraph()).map((q) => `${q.subject} ${q.predicate} ${q.object} .`);

/**
 * One batch: up to `batchSize` events after the cursor and up to `batchSize` work rows after it, in ONE
 * update with the cursor move, applied only if the cursor is still what this batch read (compare-and-set):
 * a second projector on the same executor applies nothing and is told so. Returns {projected, cursor} —
 * projected 0 means caught up and NOTHING was sent.
 */
export async function projectBatch({ logDir, workDir, executorUrl, graph = BOOK_GRAPH, batchSize = 500 }) {
  for (const [k, v] of Object.entries({ logDir, workDir, executorUrl })) if (!v) throw new Error(`projectBatch: ${k} is required (no default)`);
  if (graph !== BOOK_GRAPH) throw new Error(`projectBatch: the cursor graph is ${BOOK_GRAPH}`);
  const cursor = await readCursor(executorUrl);
  const log = readLogStrict(logDir, cursor.seq, batchSize);
  const ledger = readLedgerStrict(workDir, cursor.workRows);
  const pendingTail = log.pendingTail ?? ledger.pendingTail;
  const events = log.events;
  const workSlice = ledger.rows.slice(cursor.workRows, cursor.workRows + batchSize);
  if (!events.length && !workSlice.length) return { projected: 0, cursor, pendingTail };

  // MALFORMED INPUT FAILS CLOSED, naming the event. The old copy skips such events silently; here a
  // skip would advance the cursor past history nobody looked at. 0 of 91,506 live events were
  // malformed on 2026-10-08, so refusing costs nothing today and makes the first one visible.
  for (const ev of events) {
    if (!isProjectableEvent(ev)) {
      const missing = ['seq', 'op'].filter((k) => ev?.[k] == null || ev[k] === '').concat(ev?.entity?.id ? [] : ['entity.id']);
      throw new Error(`MALFORMED event at seq ${ev?.seq ?? '?'} in ${logDir}: missing ${missing.join(', ')} — not skipped; record a disposition before the projector can pass it`);
    }
  }
  const scratch = new oxigraph.Store();
  let items = 0;
  for (const ev of events) if (projectActivityItem(scratch, ev)) items++;
  projectWorkLedger(scratch, workSlice);
  items += workSlice.length;
  const next = { seq: events.length ? events.at(-1).seq : cursor.seq, workRows: cursor.workRows + workSlice.length };

  const guard = cursor.present
    ? `GRAPH <${BOOK_GRAPH}> { <${CURSOR}> <${P_SEQ}> ?s . <${CURSOR}> <${P_WORK}> ?w . <${CURSOR}> ?p ?o } FILTER(?s = ${cursor.seq} && ?w = ${cursor.workRows})`
    : `FILTER NOT EXISTS { GRAPH <${BOOK_GRAPH}> { <${CURSOR}> ?p0 ?o0 } }`;
  const sparql = [
    `DELETE { GRAPH <${BOOK_GRAPH}> { <${CURSOR}> ?p ?o } }`,
    'INSERT {',
    ...nTriples(scratch),
    `GRAPH <${BOOK_GRAPH}> { <${CURSOR}> <${P_SEQ}> ${next.seq} . <${CURSOR}> <${P_WORK}> ${next.workRows} . }`,
    '}',
    `WHERE { ${guard} }`,
  ].join('\n');
  const epoch = await storeEpoch(executorUrl);
  const opId = `urn:ex:op/activity-projector/${crypto.randomUUID()}`;
  const r = await post(executorUrl, '/update', sparql, {
    'content-type': 'application/sparql-update', 'x-op-id': opId, ...(epoch != null ? { 'x-epoch': epoch } : {}),
  });
  if (r.status !== 200) throw new Error(`update refused: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const after = await readCursor(executorUrl);
  if (after.seq !== next.seq || after.workRows !== next.workRows) {
    throw new Error(`CURSOR CONFLICT: expected the cursor to move to seq=${next.seq} workRows=${next.workRows}, found seq=${after.seq} workRows=${after.workRows} — another writer moved it; this batch applied nothing and will be retried from the executor's cursor`);
  }
  return { projected: items, cursor: next, pendingTail };
}

/**
 * Run until caught up (one batch at a time). A failed batch is not retried blindly: the next
 * projectBatch re-reads the cursor, so a request that did land is never re-counted and one that did not
 * is re-sent from where the executor says. `maxFailures` consecutive failures end the run with an error.
 */
export async function projectUntilCaughtUp(opts, { maxFailures = 5, retryMs = 1000, log = () => {} } = {}) {
  let total = 0; let failures = 0;
  for (;;) {
    try {
      const r = await projectBatch(opts);
      failures = 0;
      if (!r.projected) return { projected: total, cursor: r.cursor, pendingTail: r.pendingTail };
      total += r.projected;
      log(`projected ${r.projected} item(s); cursor seq=${r.cursor.seq} workRows=${r.cursor.workRows}`);
    } catch (e) {
      failures++;
      log(`batch failed (${failures}/${maxFailures}): ${e.message}`);
      if (failures >= maxFailures) throw e;
      await new Promise((res) => setTimeout(res, retryMs));
    }
  }
}
