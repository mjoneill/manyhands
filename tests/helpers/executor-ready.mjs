/**
 * #1716 — "the executor answered" is not "OUR executor answered".
 *
 *   waitExecutorReady(baseUrl, { dsid, headers, tries, intervalMs }) -> the counters
 *
 * Polls GET <baseUrl>/api/trial/counters. Resolves only when the REST's graph client reads OUR dataset (identity.datasetId
 * === dsid) AND, when the REST controls a trial executor (trialControl), its own child is running (executorRunning).
 * The executor's port comes from freePort(), which hands the number back unheld (#1140), so a stranger already on it
 * (another test's REST, say) answers /health with JSON and used to pass the old `counters.executor` check. Its 401 then
 * came back from every write as a bare 503 GRAPH_WRITE_UNAVAILABLE.
 *
 * A DIFFERENT dataset id never becomes ours, so it rejects at once. Everything else (no identity yet, child not up yet)
 * is retried until `tries` runs out, then rejects naming the last identity and executorRunning it saw.
 */
export async function waitExecutorReady(baseUrl, { dsid, headers = {}, tries = 200, intervalMs = 50 } = {}) {
  if (!dsid) throw new Error('waitExecutorReady needs the dsid this test expects');
  let last = null;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/trial/counters`, { headers, signal: AbortSignal.timeout(5000) });
      last = await res.json();
      lastErr = null;
    } catch (e) { last = null; lastErr = e; }
    const got = last?.identity?.datasetId;
    if (got !== undefined && got !== null && got !== dsid) {
      throw new Error(`the executor at this REST's executor URL is not ours (#1716): identity.datasetId=${JSON.stringify(got)}, expected ${JSON.stringify(dsid)}`);
    }
    const running = last?.trialControl ? last.executorRunning === true : true;
    if (got === dsid && running) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`executor never became ready as OURS (#1716) after ${tries} tries: identity=${JSON.stringify(last?.identity ?? null)}, `
    + `executorRunning=${JSON.stringify(last?.executorRunning ?? null)}, trialControl=${JSON.stringify(last?.trialControl ?? null)}`
    + (lastErr ? `, last error: ${lastErr.message}` : ''));
}
