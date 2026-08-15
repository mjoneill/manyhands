/**
 * #805 blockers 3+4 — the legacy provenance sidecar.
 *
 * THE TWO DEFECTS THIS CLOSES, which turned out to be one:
 *
 *   3  The live caller discarded provenance it HAD. It passed
 *      `pool.map((body) => ({ slug: promptSlugFor(body), body }))` — no author,
 *      no evidencedBy, no influencedBy — while the bootstrap supported all
 *      three and the board carried the evidence.
 *
 *   4  Identity was the body hash, so two prompts with identical text collapsed
 *      into one lineage, and a REWORD started a new one. Identity inferred from
 *      content is not identity; it is a fingerprint of the current draft.
 *
 * Both close with one artifact: an explicit manifest that ASSIGNS identity and
 * CARRIES provenance, with the hash demoted to what it is good at — verifying
 * that the text on disk is still the text the provenance was written about.
 *
 * ⛔ WHY THIS IS DATA AND NOT SOURCE. The manifest's content is real: seat names
 * and a real person's name. Source in this repo is published; data is not
 * (.gitignore carries board-data.json, channel-config.json, roster.json). A
 * manifest in source would put the principal's name in a new public blob, which
 * is the class with no baseline escape. So the code is name-free and the names
 * live in an untracked sidecar, exactly as roster.json/roster.example.json
 * already does. #804's graph-native pool retires this file entirely.
 *
 * ⚠️⚠️ WHY VALIDATION IS ALL-OR-NOTHING, AND WHY THAT IS STRONGER THAN
 * FAIL-LOUD. A prompt version is IMMUTABLE and its write is enforced by a guard
 * that throws on same-@id-different-content. So a migration that mints one
 * version with provenance ABSENT closes the honesty window for that prompt
 * PERMANENTLY: the corrected node can never replace it, and the server that
 * later tries exits 1 instead of serving. Measured, two real boots — boot 1
 * without provenance serves happily, boot 2 with provenance refuses to start.
 *
 * A per-entity refusal mid-write is therefore itself a partial mint. Everything
 * here validates the WHOLE pool against the WHOLE manifest and throws before
 * the caller writes anything at all.
 */

import { createHash } from 'node:crypto';

/** sha256 of a prompt body — used to VERIFY content, never to define identity. */
export const bodyHash = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * The note attached to a prompt we genuinely have no provenance for.
 *
 * ⚠️ This is an EXPLICIT record of unknown origin, not an absence. The
 * distinction matters: absence reads as "nobody looked", and this says "we
 * looked, at migration time, and the sidecar did not cover this text." A later
 * reader can tell those apart, which is the whole point of the card.
 */
const UNKNOWN_NOTE = 'No provenance recorded in the migration manifest for this '
  + 'prompt. Recorded as explicitly unknown rather than left absent: the sidecar '
  + 'was present and did not cover this text. Not evidence that none exists.';

class ProvenanceError extends Error {}
const fail = (msg) => { throw new ProvenanceError(`tending provenance: ${msg}`); };

/** Identity = the manifest's lineage slug, plus an occurrence discriminator. */
export function lineageSlug(lineage, occurrence = 1) {
  if (!lineage || typeof lineage !== 'string') fail('a manifest entry needs a non-empty lineage slug');
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    fail(`occurrence must be a positive integer, got ${JSON.stringify(occurrence)}`);
  }
  // ⚠️ Occurrence 1 is BARE. Two identical bodies get `quiet-hour` and
  // `quiet-hour-2`, so the common case reads as a name rather than as a name
  // with bookkeeping stapled to it — and the discriminator only appears where
  // it is actually discriminating.
  return occurrence === 1 ? lineage : `${lineage}-${occurrence}`;
}

/** Shape-check the manifest before any of it is trusted. */
function readManifest(manifest) {
  if (manifest == null) return null;
  if (typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object');
  if (manifest.version !== 1) fail(`unsupported manifest version ${JSON.stringify(manifest.version)} — expected 1`);
  if (!Array.isArray(manifest.prompts)) fail('manifest.prompts must be an array');

  const seen = new Set();
  for (const [i, e] of manifest.prompts.entries()) {
    if (!e || typeof e !== 'object') fail(`manifest.prompts[${i}] is not an object`);
    const occ = e.occurrence ?? 1;
    const slug = lineageSlug(e.lineage, occ);
    if (seen.has(slug)) fail(`duplicate lineage+occurrence "${slug}" — identity must be unique`);
    seen.add(slug);
    if (typeof e.bodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.bodySha256)) {
      fail(`manifest entry "${slug}" needs a 64-hex bodySha256 — it is what verifies the text still matches`);
    }
  }
  return manifest;
}

/**
 * Resolve the pool into fully-provenanced prompt records, or throw.
 *
 * @param {object}   a
 * @param {string[]} a.pool            the live prompt bodies, in playlist order
 * @param {object}   [a.manifest]      parsed tending-provenance.json, or null if absent
 * @param {string[]} [a.knownDefaults] bodies we KNOW have real provenance (DEFAULT_POOL)
 * @returns {Array} prompt records for buildTendingEntities — complete, or nothing
 */
export function resolveProvenance({ pool, manifest = null, knownDefaults = [] }) {
  if (!Array.isArray(pool) || pool.length === 0) fail('pool must be a non-empty array');

  const m = readManifest(manifest);
  const knownHashes = new Set(knownDefaults.map(bodyHash));

  // ── the MISSING case ────────────────────────────────────────────────────
  // ⛔ A missing sidecar is only survivable when nothing in the pool is a prompt
  // we know the provenance of. If a known legacy default is present and the
  // manifest is absent, migrating anyway would mint that prompt as authorless —
  // permanently, per the immutability argument above. That is the silent
  // downgrade the contract forbids, and it fails here rather than at the write.
  if (!m) {
    const known = pool.filter((b) => knownHashes.has(bodyHash(b)));
    if (known.length) {
      fail(
        `the pool contains ${known.length} known legacy prompt(s) whose provenance is `
        + 'recorded, but no manifest was supplied. Migrating now would mint them as '
        + 'authorless, and a prompt version is IMMUTABLE — the correct author could '
        + 'never replace it and the next boot carrying it would exit 1. Supply '
        + 'tending-provenance.json (see tending-provenance.example.json), or remove '
        + 'the known prompts from the pool.',
      );
    }
    // Nothing known is at stake: every prompt is custom and recorded as
    // explicitly unknown. Identity still is not the hash — it is positional
    // lineage, which is stable for as long as the pool is.
    return pool.map((body, i) => ({
      slug: lineageSlug(`legacy-prompt-${i + 1}`),
      body,
      provenanceNote: UNKNOWN_NOTE,
    }));
  }

  // ── the PRESENT case: every entry must match, and every match must verify ──
  const byHash = new Map();
  for (const e of m.prompts) {
    const list = byHash.get(e.bodySha256) || [];
    list.push(e);
    byHash.set(e.bodySha256, list);
  }
  for (const [, list] of byHash) list.sort((a, b) => (a.occurrence ?? 1) - (b.occurrence ?? 1));

  const used = new Map();          // sha -> how many occurrences consumed
  const matchedEntries = new Set();
  const out = [];

  for (const body of pool) {
    const h = bodyHash(body);
    const list = byHash.get(h) || [];
    const n = used.get(h) || 0;
    const entry = list[n];

    if (!entry) {
      // ⛔ MISMATCHED: the manifest covers this text fewer times than the pool
      // uses it. Silently reusing occurrence 1 would give two distinct prompts
      // one identity — exactly blocker 4 — so it fails instead.
      if (list.length) {
        fail(
          `the pool contains ${n + 1} copies of the text for lineage "${list[0].lineage}" but the `
          + `manifest declares ${list.length}. Add an entry with occurrence ${n + 1}, or remove the `
          + 'duplicate. Identity comes from the manifest, so an undeclared copy has no identity.',
        );
      }
      if (knownHashes.has(h)) {
        fail(
          'a known legacy prompt is in the pool and the manifest does not cover it. Its '
          + 'provenance is recorded elsewhere and would be lost to an immutable authorless '
          + 'mint. Add it to the manifest rather than migrating without it.',
        );
      }
      // Custom prompt, explicitly unknown — permitted by the contract.
      out.push({
        slug: lineageSlug(`legacy-prompt-${out.length + 1}`),
        body,
        provenanceNote: UNKNOWN_NOTE,
      });
      continue;
    }

    used.set(h, n + 1);
    matchedEntries.add(entry);
    out.push({
      slug: lineageSlug(entry.lineage, entry.occurrence ?? 1),
      body,
      // ⚠️ ABSENT stays ABSENT. An unset author must not become a null, an empty
      // string, or a guess — buildTendingEntities' own control asserts exactly
      // this, and the sidecar is not permitted to weaken it.
      ...(entry.author ? { author: entry.author } : {}),
      ...(entry.influencedBy ? { influencedBy: entry.influencedBy } : {}),
      ...(entry.evidencedBy?.length ? { evidencedBy: [...entry.evidencedBy] } : {}),
      ...(entry.provenanceNote ? { provenanceNote: entry.provenanceNote } : {}),
    });
  }

  // ⛔ MISMATCHED, the other direction: a manifest entry that matched nothing.
  // Its bodySha256 no longer describes any prompt in the pool, which means the
  // text was EDITED after the provenance was written. Migrating would attach a
  // stale claim to whatever happens to be there now, so it fails and names the
  // lineage — that is the hash doing its real job, verification.
  const orphans = m.prompts.filter((e) => !matchedEntries.has(e));
  if (orphans.length) {
    fail(
      `manifest entr${orphans.length === 1 ? 'y' : 'ies'} `
      + `${orphans.map((e) => `"${lineageSlug(e.lineage, e.occurrence ?? 1)}"`).join(', ')} `
      + 'matched no prompt in the pool. The recorded bodySha256 does not describe any current '
      + 'text, so either the prompt was edited after its provenance was written (start a NEW '
      + 'version rather than re-pointing the old one) or the entry is stale. Refusing to attach '
      + 'a provenance claim to text it was not written about.',
    );
  }

  return out;
}
