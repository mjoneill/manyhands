/**
 * #884 — THE STORE'S SNAPSHOT: a boot loads it instead of rebuilding.
 *
 * Every restart re-read the whole event log (213 MB, 31k activities) and
 * re-projected every entity of the 63 MB document into a fresh WASM store —
 * 13–37 s at rest, 8 minutes under the paging of 2026-09-15 (#1388) — and the
 * server answered nothing meanwhile. Measured on the prod shape (430k
 * triples): `store.dump` 1.2 s → 104 MB n-quads; `store.load` 0.9 s. So a
 * warm boot is a second.
 *
 * Two files beside the board, written ATOMICALLY (tmp + rename, sidecar last):
 *   graph-snapshot.nq    the store, application/n-quads
 *   graph-snapshot.json  { format, seq, at, docStamp, triples, bytes, dumpedAt,
 *                          hashes, signals }
 * `seq`/`at` is the event-log position the store's activities reach —
 * the boot replays only events after it. `hashes`/`signals` is the
 * incremental sync's per-entity cache (#714/#1157): without it the first sync
 * after a warm boot would re-project all 30k entities and the boot would cost
 * what it cost before, one function later.
 *
 * ⛔ A SNAPSHOT AHEAD OF THE LOG IS REFUSED. A restored backup (#1211's
 * shape) can put a snapshot on disk whose seq the log has never reached;
 * trusting it would report activities that did not happen. Missing, corrupt
 * and foreign-format snapshots all answer the cold path with a reason —
 * never a throw, never a guess. The reason goes in the boot log.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_FORMAT = 1;
const NQ = 'graph-snapshot.nq';
const META = 'graph-snapshot.json';

export function snapshotPaths(dir) {
  return { nq: path.join(dir, NQ), meta: path.join(dir, META) };
}

/**
 * A SIGKILL mid-dump leaves `graph-snapshot.*.tmp-<pid>` (~100 MB) beside the
 * board with nothing to reap it. Called at boot before the read: removes
 * every temp file the writer's naming produces, returns how many.
 */
export function sweepSnapshotTemps(dir) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    if ((f.startsWith(NQ + '.tmp-') || f.startsWith(META + '.tmp-'))) {
      try { fs.unlinkSync(path.join(dir, f)); n += 1; } catch { /* gone already */ }
    }
  }
  return n;
}

/**
 * Dump `store` and its sync cache beside the board. Atomic: both files are
 * written under temp names and renamed only after both succeed, the sidecar
 * last — a reader that sees the sidecar sees the .nq it describes.
 */
export function writeSnapshot(dir, { store, seq, at, docStamp = null, hashes, signals }) {
  const t = performance.now();
  const { nq, meta } = snapshotPaths(dir);
  const tmpNq = `${nq}.tmp-${process.pid}`;
  const tmpMeta = `${meta}.tmp-${process.pid}`;
  try {
    const text = store.dump({ format: 'application/n-quads' });
    fs.writeFileSync(tmpNq, text);
    const body = {
      format: SNAPSHOT_FORMAT,
      seq: Number.isFinite(seq) ? seq : 0,
      at: typeof at === 'string' ? at : null,
      docStamp: typeof docStamp === 'string' ? docStamp : null,
      triples: store.size,
      bytes: Buffer.byteLength(text),
      dumpedAt: new Date().toISOString(),
      hashes: hashes instanceof Map ? [...hashes] : [],
      signals: signals instanceof Map ? [...signals] : [],
    };
    fs.writeFileSync(tmpMeta, JSON.stringify(body));
    fs.renameSync(tmpNq, nq);
    fs.renameSync(tmpMeta, meta);
    return { triples: body.triples, bytes: body.bytes, seq: body.seq, ms: performance.now() - t };
  } catch (e) {
    for (const f of [tmpNq, tmpMeta]) { try { fs.unlinkSync(f); } catch { /* never written */ } }
    throw e;
  }
}

/**
 * Load the snapshot if it is usable against a log whose head is `logHeadSeq`.
 * Answers `{ ok: true, store, seq, at, docStamp, hashes, signals, triples, ms }`
 * or `{ ok: false, reason, detail }` with reason one of
 * `missing` · `format` · `ahead-of-log` · `corrupt`.
 */
export function readSnapshot(dir, { logHeadSeq, oxigraph }) {
  const t = performance.now();
  const { nq, meta } = snapshotPaths(dir);
  if (!fs.existsSync(nq) || !fs.existsSync(meta)) return { ok: false, reason: 'missing', detail: `${NQ} or ${META} absent in ${dir}` };
  let m;
  try { m = JSON.parse(fs.readFileSync(meta, 'utf8')); }
  catch (e) { return { ok: false, reason: 'corrupt', detail: `sidecar unreadable: ${e.message}` }; }
  if (!m || m.format !== SNAPSHOT_FORMAT) return { ok: false, reason: 'format', detail: `sidecar format ${m?.format} ≠ ${SNAPSHOT_FORMAT}` };
  const seq = Number.isFinite(m.seq) ? m.seq : 0;
  const head = Number.isFinite(logHeadSeq) ? logHeadSeq : 0;
  if (seq > head) return { ok: false, reason: 'ahead-of-log', detail: `snapshot seq=${seq} is beyond the log head seq=${head} — a restored backup? refusing to trust it` };
  let store;
  try {
    store = new oxigraph.Store();
    store.load(fs.readFileSync(nq, 'utf8'), { format: 'application/n-quads' });
  } catch (e) { return { ok: false, reason: 'corrupt', detail: `${NQ} would not load: ${e.message}` }; }
  if (Number.isFinite(m.triples) && store.size !== m.triples) {
    return { ok: false, reason: 'corrupt', detail: `${NQ} loaded ${store.size} triples, sidecar says ${m.triples}` };
  }
  return {
    ok: true, store, seq, at: typeof m.at === 'string' ? m.at : null, docStamp: typeof m.docStamp === 'string' ? m.docStamp : null,
    hashes: new Map(Array.isArray(m.hashes) ? m.hashes : []),
    signals: new Map(Array.isArray(m.signals) ? m.signals : []),
    triples: store.size, ms: performance.now() - t,
  };
}
