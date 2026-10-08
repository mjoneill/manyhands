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
import { readEvents, SEGMENT_RE } from './event-log.mjs';
import { readWorkObjectRows } from './work-store.mjs';
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
  return { seq: seen[P_SEQ][0] ?? 0, workRows: seen[P_WORK][0] ?? 0 };
}

async function storeEpoch(executorUrl) {
  const res = await fetch(`${executorUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  const j = await res.json();
  return j && j.epoch != null ? String(j.epoch) : null;
}

/**
 * STRICT READ of the history the next batch could touch. The shared log reader skips a line it cannot
 * parse (right for the old copy's rebuild); this projector must not advance past history it could not
 * read, so it checks the segments first and refuses, naming the segment and line.
 *
 * Bounded: segments are day-named and seq is monotonic with day, so walking NEWEST first and stopping
 * after the first segment whose every seq is at or below the cursor covers everything past the cursor.
 *
 * ONE exception, and it is not corruption: the final line of the newest segment with no trailing newline
 * is an append still in flight. It is treated as not-yet-written (readEvents skips it the same way, so it
 * cannot be projected), never as a refusal.
 */
const _checked = new Map();   // path -> {size, mtimeMs, maxSeq}: a segment unchanged since it passed is not re-read
export function strictCheckSegments(logDir, sinceSeq) {
  const files = (fs.existsSync(logDir) ? fs.readdirSync(logDir) : []).filter((f) => SEGMENT_RE.test(f)).sort();
  let pendingTail = null;
  for (let fi = files.length - 1; fi >= 0; fi--) {
    const f = files[fi];
    const full = path.join(logDir, f);
    const st = fs.statSync(full);
    const memo = _checked.get(full);
    if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) { if (memo.maxSeq <= sinceSeq) return { pendingTail }; continue; }
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    let maxSeq = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const inFlightTail = fi === files.length - 1 && i === lines.length - 1 && !text.endsWith('\n');
      let ev;
      try { ev = JSON.parse(l); } catch {
        if (inFlightTail) { pendingTail = { segment: f, line: i + 1 }; continue; }
        throw new Error(`UNREADABLE line ${i + 1} of ${f} in ${logDir}: not JSON — not skipped; nothing sent, cursor unchanged`);
      }
      if (!Number.isInteger(ev?.seq)) {
        if (inFlightTail) { pendingTail = { segment: f, line: i + 1 }; continue; }
        throw new Error(`UNREADABLE line ${i + 1} of ${f} in ${logDir}: no integer seq — not skipped; nothing sent, cursor unchanged`);
      }
      if (ev.seq > maxSeq) maxSeq = ev.seq;
    }
    if (text.endsWith('\n') || fi < files.length - 1) _checked.set(full, { size: st.size, mtimeMs: st.mtimeMs, maxSeq });
    if (maxSeq <= sinceSeq) return { pendingTail };
  }
  return { pendingTail };
}

const nTriples = (store) => store.match(null, null, null, oxigraph.defaultGraph()).map((q) => `${q.subject} ${q.predicate} ${q.object} .`);

/**
 * One batch: up to `batchSize` events after the cursor and up to `batchSize` work rows after it, in one
 * update with the cursor move. Returns {projected, cursor} — projected 0 means caught up and NOTHING was
 * sent. Throws on a refused or failed request; the caller re-reads the cursor before trying again.
 */
export async function projectBatch({ logDir, workDir, executorUrl, graph = BOOK_GRAPH, batchSize = 500 }) {
  for (const [k, v] of Object.entries({ logDir, workDir, executorUrl })) if (!v) throw new Error(`projectBatch: ${k} is required (no default)`);
  if (graph !== BOOK_GRAPH) throw new Error(`projectBatch: the cursor graph is ${BOOK_GRAPH}`);
  const cursor = await readCursor(executorUrl);
  const { pendingTail } = strictCheckSegments(logDir, cursor.seq);
  const events = readEvents(logDir, { sinceSeq: cursor.seq, limit: batchSize });
  const rows = readWorkObjectRows(workDir);
  const workSlice = rows.slice(cursor.workRows, cursor.workRows + batchSize);
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

  const sparql = [
    `DELETE WHERE { GRAPH <${BOOK_GRAPH}> { <${CURSOR}> ?p ?o } } ;`,
    'INSERT DATA {',
    ...nTriples(scratch),
    `GRAPH <${BOOK_GRAPH}> { <${CURSOR}> <${P_SEQ}> ${next.seq} . <${CURSOR}> <${P_WORK}> ${next.workRows} . }`,
    '}',
  ].join('\n');
  const epoch = await storeEpoch(executorUrl);
  const opId = `urn:ex:op/activity-projector/${crypto.randomUUID()}`;
  const r = await post(executorUrl, '/update', sparql, {
    'content-type': 'application/sparql-update', 'x-op-id': opId, ...(epoch != null ? { 'x-epoch': epoch } : {}),
  });
  if (r.status !== 200) throw new Error(`update refused: HTTP ${r.status} ${r.text.slice(0, 300)}`);
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
