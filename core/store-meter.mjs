/**
 * #1386 — THE STORE METER: is the in-process graph within the ceilings that
 * make decision d0c5839d a measured choice?
 *
 * d0c5839d (the owner, 2026-09-14) accepted (b) — event log durable, in-process
 * Oxigraph canonical, seq-keyed snapshot — on the condition of "a standing
 * meter that watches store size / RSS / warm start against the WASM ceiling;
 * (a1) is the named fallback." The reopen condition is "the meter crosses the
 * numeric ceilings", so without this file the condition is prose. #1389 (the
 * worker isolate) is reached by a number from here, not by a feeling.
 *
 * What is measured, and from where:
 *   triples          store.size — the replica's own count
 *   storeMB          process.memoryUsage().external — V8's external memory,
 *                    which is where a WebAssembly.Memory is accounted. MEASURED
 *                    2026-09-17: loading the prod snapshot (455k triples) moved
 *                    `external` 6.9 → 433.8 MB and `arrayBuffers` 3.9 → 0.0 —
 *                    the first cut read arrayBuffers and reported 0.1 MB for a
 *                    461k-triple store on prod, the exact zero-that-cannot-say-
 *                    which-zero (the first prod read, 15:50Z). The binding exports no memory
 *                    handle, so this is a PROXY and the payload names it as one;
 *                    a reading implausibly small for the triple count is itself
 *                    a row (`storeMB unmeasurable`), never a quiet zero.
 *   kbPerTriple      storeMB / triples — the number the 09-15/16 reads argued
 *                    about (1.4 KB at +60 s cold, 2.6 KB at 11 h): reported,
 *                    NOT a ceiling, because the criterion is the owner's ruling
 *   rssMB, heapMB    process.memoryUsage()
 *   boot             { path: 'warm'|'cold', ms, seq }  — recorded by server.js
 *                    at the boot that built the store
 *   replayTailMs     the first sync after boot (replays the log past the
 *                    snapshot's seq) — the "replay tail" ceiling
 *   snapshot         the sidecar beside the board: { seq, bytes, dumpedAt }
 *                    or null (absent until #884's first dump)
 *
 * Ceilings (env-overridable, defaults from the 09-14 proposal):
 *   SCRUM_METER_STORE_CEILING_MB     1536   resident store > 1.5 GB
 *   SCRUM_METER_RSS_CEILING_MB       4096   the process near Node's default heap ceiling
 *   SCRUM_METER_WARM_BOOT_CEILING_MS 10000  warm start > 10 s
 *   SCRUM_METER_REPLAY_CEILING_MS    60000  replay tail > 60 s
 *
 * ⛔ Rows are CROSSED ceilings only; zero rows means within bounds. A meter that
 * cannot read the process reports an error, never zero rows (#792/#880).
 * ⛔ Acting on a crossed ceiling is NOT this file (#1389 is the fallback build).
 */

const MB = 1048576;

export function meterCeilings(env = process.env) {
  const n = (k, d) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    storeMB: n('SCRUM_METER_STORE_CEILING_MB', 1536),
    rssMB: n('SCRUM_METER_RSS_CEILING_MB', 4096),
    warmBootMs: n('SCRUM_METER_WARM_BOOT_CEILING_MS', 10_000),
    replayTailMs: n('SCRUM_METER_REPLAY_CEILING_MS', 60_000),
  };
}

const mb = (bytes) => Math.round((bytes / MB) * 10) / 10;

/**
 * Pure. Reads nothing itself; every input is handed in so a test can lie to it.
 * @param {object} args
 * @param {{size:number}|null} args.store          the live replica, or null when not built
 * @param {NodeJS.MemoryUsage} args.memory          process.memoryUsage()
 * @param {{path:'warm'|'cold', ms:number, seq?:number}|null} args.boot
 * @param {number|null} args.replayTailMs           first sync after boot, ms
 * @param {{seq:number, bytes:number, dumpedAt:string}|null} args.snapshot
 * @param {object} [args.ceilings]
 * @returns {{ readings: object, crossed: Array<{measure:string, value:number, ceiling:number}> }}
 */
export function readStoreMeter({ store, memory, boot = null, replayTailMs = null, snapshot = null, ceilings = meterCeilings() }) {
  if (!store || typeof store.size !== 'number') throw new Error('store not built — nothing to meter (a boot that has not built the replica yet reads as error, not as zero rows)');
  if (!memory || typeof memory.rss !== 'number') throw new Error('process memory unreadable');
  const triples = store.size;
  const externalBytes = memory.external ?? 0;
  const storeMB = mb(externalBytes);
  // Below ~0.2 KB/triple no WASM store this size exists (measured 0.95–2.6
  // KB/triple on prod); a reading under that is the accounting missing the
  // store, not a small store — say so as a row, never as a zero.
  const storeUnmeasurable = triples > 1000 && externalBytes < triples * 200;
  const readings = {
    triples,
    storeMB,
    storeMBmeans: 'process.memoryUsage().external — V8 external memory, where a WebAssembly.Memory is accounted (measured 2026-09-17: +427 MB for 455k triples); the oxigraph binding exports no memory handle, so this is a proxy and named as one. arrayBuffers does NOT see it (read 0.1 MB on prod, 15:50Z).',
    storeUnmeasurable,
    kbPerTriple: triples > 0 ? Math.round(externalBytes / triples / 1024 * 100) / 100 : null,
    rssMB: mb(memory.rss),
    heapMB: mb(memory.heapUsed),
    boot,
    replayTailMs,
    snapshot,
    ceilings,
    readAt: new Date().toISOString(),
  };
  const crossed = [];
  if (storeUnmeasurable) crossed.push({ measure: 'storeMB', value: storeMB, ceiling: ceilings.storeMB, unmeasurable: `external ${storeMB} MB for ${triples} triples is below any real store's size — the accounting is not seeing the WASM memory; the ceiling cannot be watched from this reading` });
  else if (storeMB > ceilings.storeMB) crossed.push({ measure: 'storeMB', value: storeMB, ceiling: ceilings.storeMB });
  if (readings.rssMB > ceilings.rssMB) crossed.push({ measure: 'rssMB', value: readings.rssMB, ceiling: ceilings.rssMB });
  if (boot && boot.path === 'warm' && boot.ms > ceilings.warmBootMs) crossed.push({ measure: 'warmBootMs', value: Math.round(boot.ms), ceiling: ceilings.warmBootMs });
  if (typeof replayTailMs === 'number' && replayTailMs > ceilings.replayTailMs) crossed.push({ measure: 'replayTailMs', value: Math.round(replayTailMs), ceiling: ceilings.replayTailMs });
  return { readings, crossed };
}

/** One line for the log — the trend a reader greps for. */
export function meterLine(readings, crossed = []) {
  const b = readings.boot ? `${readings.boot.path} ${Math.round(readings.boot.ms)}ms` : 'boot ?';
  const tail = typeof readings.replayTailMs === 'number' ? ` replay ${Math.round(readings.replayTailMs)}ms` : '';
  const snap = readings.snapshot ? ` snapshot seq=${readings.snapshot.seq} ${mb(readings.snapshot.bytes)}MB` : ' snapshot none';
  const x = crossed.length ? ` ⚠️ ${crossed.map((c) => c.unmeasurable ? `${c.measure} UNMEASURABLE (${c.value}MB for ${readings.triples} triples)` : `CROSSED ${c.measure}=${c.value}>${c.ceiling}`).join(' ')}` : '';
  return `graph-store-meter: ${readings.triples} triples · store ${readings.storeMB}MB (${readings.kbPerTriple ?? '?'} KB/triple) · rss ${readings.rssMB}MB · heap ${readings.heapMB}MB · boot ${b}${tail}${snap}${x}`;
}
