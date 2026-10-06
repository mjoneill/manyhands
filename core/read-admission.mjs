/**
 * #1574 A1–A5 — ADMISSION CONTROL ON EXECUTOR WORK, not on HTTP requests.
 *
 * The executor does not cancel a query when its caller goes away. So a read whose HTTP answer has timed out is still WORK at
 * the executor, and must keep its slot until the executor has actually answered. Otherwise abandoned queries and their retries
 * pile up behind a cap that only counts live requests (attempt 1, 2026-10-06: 150–300 % CPU with no client connected).
 *
 *   - At most `max` graph reads are RUNNING at the executor, shared by every reader made from one gate.
 *   - At most `queueMax` more WAIT for a slot; beyond that a read is refused at once (a fast 503 to the caller).
 *   - Each read has a caller DEADLINE. A read still waiting when its deadline passes leaves the queue and is never sent. A read
 *     already running answers {ok:false} at the deadline, but its slot is released only when the executor's own answer arrives.
 *   - The underlying request is never aborted (not by the deadline, not by a timer) and never retried.
 */
// NO abort timer underneath (the contract owner's ruling, 2026-10-06 01:01Z): a timer is not evidence that executor work stopped. A slot is freed only by the
// executor's answer or by the connection actually failing (the executor gone). The client below is built with a timeout so
// long it never fires in practice; if completion becomes unknowable the capacity stays occupied and the gate fails closed.
export const NO_ABORT_MS = 2147483647;
export function createReadGate({ max = 8, queueMax = 128 } = {}) {
  let running = 0;
  let lost = 0;   // slots whose query was SENT and whose connection then failed: the executor may still be computing
  const waiting = [];   // { start, cancelled }
  const next = () => {
    while (running < max && waiting.length) {
      const w = waiting.shift();
      if (w.cancelled) continue;
      running++;
      w.start();
    }
  };
  const stats = () => ({ running, lost, waiting: waiting.filter((w) => !w.cancelled).length, max, queueMax });

  /** A reader over `client` (a graph client created with a timeout of at least hardTimeoutMs) answering within `deadlineMs`. */
  function reader(client, deadlineMs) {
    return {
      async query(sparql) {
        if (running >= max && waiting.filter((w) => !w.cancelled).length >= queueMax) {
          return { ok: false, status: 'UNAVAILABLE', reason: 'overloaded: the graph read queue is full' };
        }
        return new Promise((resolve) => {
          let settled = false;
          const answer = (r) => { if (!settled) { settled = true; resolve(r); } };
          const entry = {
            cancelled: false,
            start: () => {
              // the slot is held until the EXECUTOR answers, whatever the caller's deadline did
              // An ANSWER (ok or a refusal the executor itself sent) proves the work ended: the slot is freed. A failure of the
              // connection AFTER dispatch proves nothing about the executor (attempt 1's BrokenPipe case): the slot stays
              // occupied, counted as lost, until explicit recovery: restart the EXECUTOR (ending the abandoned work), then REST. A REST restart alone forgets the lost slots while the executor may still be computing. With every slot lost the gate fails closed.
              Promise.resolve(client.query(sparql)).then((r) => {
                const reason = String((r && r.reason) || '');
                // ECONNREFUSED: nothing was dispatched (the executor is down), so nothing can still be running: free the slot
                // a truncated body (premature EOF after the headers) is as ambiguous as a dropped connection: only a COMPLETE
                // response, an error one included, proves the executor finished
                const sent = r && r.ok === false && ((/^transport:/.test(reason) && !/ECONNREFUSED/.test(reason)) || /not complete JSON/.test(reason));
                answer(r);
                if (sent) { lost++; return; }
                running--; next();
              }, (e) => { answer({ ok: false, status: 'UNAVAILABLE', reason: String(e?.message || e) }); lost++; });
            },
          };
          setTimeout(() => {
            if (settled) return;
            entry.cancelled = true;   // if still waiting, it is never sent; if running, its slot stays held until it finishes
            answer({ ok: false, status: 'UNAVAILABLE', reason: `timeout: no answer within ${deadlineMs} ms` });
          }, deadlineMs).unref?.();
          waiting.push(entry);
          next();
        });
      },
    };
  }
  return { reader, stats, hardTimeoutMs: NO_ABORT_MS };
}
