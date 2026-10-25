/**
 * #1747 — the capture manifest's CLOSED schema, shared by step 3 (cutover-candidate-1629.mjs) and step 4
 * (cutover-import-1629.mjs), so neither can bind a candidate to a capture the other would read differently.
 *
 * Every binding field is REQUIRED: a manifest that leaves one out must not quietly skip the check that field drives
 * (the descent check needs `incarnation`, the outbox binding needs `outboxManifestSha256`). An unknown key is refused,
 * so a misspelt field is never silently ignored.
 *
 * Returns null when the manifest is well-formed, or a sentence naming the first problem.
 */
const REQUIRED = ['sourceStore', 'files', 'documentSha256', 'outboxManifestSha256', 'datasetId', 'incarnation', 'capturedAt'];
const OPTIONAL = ['epoch', 'commitSeq', 'census'];   // recorded by step 2 for the record; nothing binds to them
const SHA = /^[0-9a-f]{64}$/;
const CLOCK_SKEW_MS = 60_000;

export function captureProblem(capture, now = Date.now()) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return 'the capture manifest is not a JSON object';
  for (const k of Object.keys(capture)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) return `the capture manifest has an unknown field ${JSON.stringify(k)}`;
  for (const k of REQUIRED) if (!(k in capture)) return `the capture manifest has no ${k}`;
  const str = (k) => typeof capture[k] === 'string' && capture[k].length > 0;
  for (const k of ['sourceStore', 'datasetId', 'incarnation']) if (!str(k)) return `the capture manifest's ${k} is not a non-empty string`;
  for (const k of ['documentSha256', 'outboxManifestSha256']) if (!str(k) || !SHA.test(capture[k])) return `the capture manifest's ${k} is not a sha256`;
  if (!Array.isArray(capture.files) || !capture.files.length) return 'the capture manifest lists no source store files';
  for (const [i, f] of capture.files.entries()) {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name || f.name.includes('/')
      || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !SHA.test(f.sha256)) return `the capture manifest's files[${i}] is not {name, size, sha256}`;
  }
  if (new Set(capture.files.map((f) => f.name)).size !== capture.files.length) return 'the capture manifest lists a source file twice';
  const at = typeof capture.capturedAt === 'string' ? Date.parse(capture.capturedAt) : NaN;
  if (!Number.isFinite(at)) return 'the capture manifest has no valid capturedAt';
  if (at > now + CLOCK_SKEW_MS) return `the capture manifest's capturedAt ${capture.capturedAt} is in the future`;
  return null;
}
