/**
 * #1558 slice — read-only counters on the LEGACY whole-document paths, so the
 * slice's measurement (frozen plan v0.2, M2/A1) can show a correction request
 * touches none of them. Counted twice: process-wide, and per request (the
 * request context the server already carries), so background work can neither
 * fake a request-path zero nor hide a request-path call.
 *
 * Counting is a few integer increments; it is always on. The one patch with
 * reach — wrapping globalThis.structuredClone — happens only when the trial
 * flag asks for it (installStructuredCloneCounter).
 */

export const LEGACY_PATHS = Object.freeze([
  'saveDomain', 'loadDomain', 'loadDomainShared', 'structuredClone',
  'graphReplicaSync', 'writeBoard', 'appendEvent',
]);

const global = Object.fromEntries(LEGACY_PATHS.map((k) => [k, 0]));
let contextGetter = () => null;

/** The server supplies its per-request context; counts land in ctx.legacy. */
export function setLegacyContext(getter) { contextGetter = getter; }

export function countLegacy(name) {
  global[name] = (global[name] || 0) + 1;
  let ctx = null;
  try { ctx = contextGetter(); } catch { ctx = null; }
  if (ctx) {
    ctx.legacy ??= Object.fromEntries(LEGACY_PATHS.map((k) => [k, 0]));
    ctx.legacy[name] = (ctx.legacy[name] || 0) + 1;
  }
}

export function legacyCounters() { return { ...global }; }

let cloneInstalled = false;
export function installStructuredCloneCounter() {
  if (cloneInstalled) return;
  const orig = globalThis.structuredClone;
  globalThis.structuredClone = function countedStructuredClone(v, o) {
    countLegacy('structuredClone');
    return orig(v, o);
  };
  cloneInstalled = true;
}
