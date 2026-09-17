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
 *   storeMB          process.memoryUsage().arrayBuffers — the WASM store's
 *                    linear memory lives in ONE ArrayBuffer (591 MB of 591.1 on
 *                    2026-09-15's heap snapshot, #1389); the oxigraph binding
 *                    does not export `memory`, so this is the honest proxy and
 *                    it is named as one on the payload
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
  const storeMB = mb(memory.arrayBuffers ?? 0);
  const readings = {
    triples,
    storeMB,
    storeMBmeans: 'process.memoryUsage().arrayBuffers — the WASM store\'s linear memory is one ArrayBuffer and dominates this number; the binding exports no memory handle, so this is a proxy and named as one',
    kbPerTriple: triples > 0 ? Math.round((memory.arrayBuffers ?? 0) / triples / 1024 * 100) / 100 : null,
    rssMB: mb(memory.rss),
    heapMB: mb(memory.heapUsed),
    boot,
    replayTailMs,
    snapshot,
    ceilings,
    readAt: new Date().toISOString(),
  };
  const crossed = [];
  if (storeMB > ceilings.storeMB) crossed.push({ measure: 'storeMB', value: storeMB, ceiling: ceilings.storeMB });
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
  const x = crossed.length ? ` ⚠️ CROSSED ${crossed.map((c) => `${c.measure}=${c.value}>${c.ceiling}`).join(' ')}` : '';
  return `graph-store-meter: ${readings.triples} triples · store ${readings.storeMB}MB (${readings.kbPerTriple ?? '?'} KB/triple) · rss ${readings.rssMB}MB · heap ${readings.heapMB}MB · boot ${b}${tail}${snap}${x}`;
}
