/**
 * #805 blockers 3+4 — controls for the provenance sidecar.
 *
 * ⚠️ FIXTURE SEATS ARE FICTIONAL ('ada', 'bo'). A fixture naming a real seat
 * asserts that person did the thing, and then needs a publication-baseline key
 * to permit the name — which widens the exemption for every future match in
 * that file. (#808.)
 *
 * Every test below names the defect it fails under. The defects are not
 * hypothetical: blocker 3 shipped provenance-discarding code to origin/main,
 * and blocker 4's hash identity is what made a reworded prompt start a new
 * lineage while two identical prompts shared one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProvenance, bodyHash, lineageSlug } from '../core/tending-provenance.mjs';

const A = 'first prompt body';
const B = 'second prompt body';
const KNOWN = 'a known legacy default whose provenance we hold';

const entry = (over = {}) => ({
  lineage: 'greeting', bodySha256: bodyHash(A), author: 'ada', ...over,
});
const manifest = (prompts) => ({ version: 1, prompts });

// ── BLOCKER 4: IDENTITY COMES FROM THE MANIFEST, NEVER THE BODY ───────────

test('⭐⭐ two IDENTICAL bodies get DISTINCT lineages via occurrence', () => {
  // DEFECT: hash identity. Two prompts with the same text collapsed into one
  // lineage, so the second silently became the first — and because a version is
  // immutable, that collapse was permanent.
  const out = resolveProvenance({
    pool: [A, A],
    manifest: manifest([
      entry({ lineage: 'greeting', occurrence: 1 }),
      entry({ lineage: 'greeting', occurrence: 2 }),
    ]),
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.slug), ['greeting', 'greeting-2']);
  assert.equal(bodyHash(out[0].body), bodyHash(out[1].body), 'the bodies really are identical');
});

test('⭐ the SAME body under a different lineage yields a different identity', () => {
  // DEFECT: identity derived from content cannot be re-pointed. This asserts the
  // hash is NOT the identity — same bytes in, different slug out.
  const one = resolveProvenance({ pool: [A], manifest: manifest([entry({ lineage: 'greeting' })]) });
  const two = resolveProvenance({ pool: [A], manifest: manifest([entry({ lineage: 'farewell' })]) });
  assert.notEqual(one[0].slug, two[0].slug);
  assert.equal(bodyHash(one[0].body), bodyHash(two[0].body));
});

test('occurrence 1 is bare; the discriminator appears only where it discriminates', () => {
  assert.equal(lineageSlug('quiet-hour'), 'quiet-hour');
  assert.equal(lineageSlug('quiet-hour', 1), 'quiet-hour');
  assert.equal(lineageSlug('quiet-hour', 2), 'quiet-hour-2');
});

// ── BLOCKER 3: PROVENANCE IS CARRIED, AND ABSENCE STAYS ABSENT ────────────

test('⭐ author, influence, evidence and note all survive to the caller', () => {
  // DEFECT: the shipped live caller passed {slug, body} only, discarding all
  // four fields while the bootstrap supported every one of them.
  const [p] = resolveProvenance({
    pool: [A],
    manifest: manifest([entry({
      author: 'ada', influencedBy: 'bo',
      evidencedBy: ['git:2a6f4d0', 'b2d746ab-e9eb-4641-82bd-5b86074d15b9'],
      provenanceNote: 'register adopted room-wide',
    })]),
  });
  assert.equal(p.author, 'ada');
  assert.equal(p.influencedBy, 'bo');
  assert.deepEqual(p.evidencedBy, ['git:2a6f4d0', 'b2d746ab-e9eb-4641-82bd-5b86074d15b9']);
  assert.equal(p.provenanceNote, 'register adopted room-wide');
});

test('⭐ an UNSET author stays ABSENT — not null, not empty string', () => {
  // DEFECT: normalising missing provenance into a falsy value. The bootstrap's
  // own control asserts `'author' in v === false`, and the sidecar must not be
  // the thing that weakens it one layer up.
  const [p] = resolveProvenance({
    pool: [A], manifest: manifest([{ lineage: 'greeting', bodySha256: bodyHash(A) }]),
  });
  assert.equal('author' in p, false);
  assert.equal('influencedBy' in p, false);
  assert.equal('evidencedBy' in p, false);
});

// ── THE MISSING CASE: no silent downgrade of known authorship ─────────────

test('⛔⛔ a MISSING manifest REFUSES when a known legacy prompt is in the pool', () => {
  // DEFECT: this is the one that bricks prod. Migrating a known prompt without
  // its provenance mints an IMMUTABLE authorless version; the corrected node can
  // never replace it, and the next boot carrying the fix exits 1. Measured, two
  // real boots. So the refusal must happen here, before any write.
  assert.throws(
    () => resolveProvenance({ pool: [KNOWN, B], manifest: null, knownDefaults: [KNOWN] }),
    /known legacy prompt.*no manifest was supplied|IMMUTABLE/s,
  );
});

test('a MISSING manifest is fine when nothing known is at stake', () => {
  // Contract: custom prompts without evidence may record explicit unknown
  // provenance. Absence of a sidecar is not itself an error.
  const out = resolveProvenance({ pool: [A, B], manifest: null, knownDefaults: [KNOWN] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.slug), ['legacy-prompt-1', 'legacy-prompt-2']);
  for (const p of out) {
    assert.match(p.provenanceNote, /explicitly unknown/);
    assert.equal('author' in p, false, 'unknown means unknown — never a guess');
  }
});

test('⛔ a PRESENT manifest that omits a known prompt still refuses', () => {
  // DEFECT: covering two of three known prompts and calling it a migration. The
  // uncovered one would mint authorless and permanent, which the whole-manifest
  // rule exists to prevent — a partial manifest is a partial mint.
  assert.throws(
    () => resolveProvenance({
      pool: [A, KNOWN], manifest: manifest([entry()]), knownDefaults: [KNOWN],
    }),
    /known legacy prompt is in the pool and the manifest does not cover it/,
  );
});

// ── MALFORMED ─────────────────────────────────────────────────────────────

test('⛔ malformed manifests are refused, each for a stated reason', () => {
  const bad = [
    [{ version: 2, prompts: [] }, /unsupported manifest version/],
    [{ version: 1, prompts: {} }, /prompts must be an array/],
    [manifest([{ lineage: 'x', bodySha256: 'not-a-hash' }]), /64-hex bodySha256/],
    [manifest([{ bodySha256: bodyHash(A) }]), /non-empty lineage slug/],
    [manifest([entry({ occurrence: 0 })]), /occurrence must be a positive integer/],
    [manifest([entry({ lineage: 'g', occurrence: 1 }), entry({ lineage: 'g', occurrence: 1 })]),
      /duplicate lineage\+occurrence/],
  ];
  for (const [m, re] of bad) {
    assert.throws(() => resolveProvenance({ pool: [A], manifest: m }), re);
  }
});

// ── MISMATCHED: the hash doing its ONE real job ───────────────────────────

test('⛔⛔ an EDITED prompt is caught — the entry matches nothing and refuses', () => {
  // DEFECT: attaching a provenance claim to text it was not written about. If
  // the body is edited after the manifest is written, the stored sha stops
  // describing any current prompt. Silently proceeding would credit 'ada' with
  // words she did not write — the exact class the card exists to prevent.
  assert.throws(
    () => resolveProvenance({ pool: ['EDITED body'], manifest: manifest([entry({ lineage: 'greeting' })]) }),
    /matched no prompt in the pool.*greeting|Refusing to attach a provenance claim/s,
  );
});

test('⛔ more copies in the pool than the manifest declares is refused', () => {
  // DEFECT: reusing occurrence 1 for a second copy gives two distinct prompts
  // one identity — blocker 4 reintroduced through the back door.
  assert.throws(
    () => resolveProvenance({ pool: [A, A], manifest: manifest([entry({ occurrence: 1 })]) }),
    /pool contains 2 copies.*manifest declares 1/s,
  );
});

// ── ALL-OR-NOTHING ────────────────────────────────────────────────────────

test('⭐⭐ a fault ANYWHERE yields NOTHING — never a partial resolution', () => {
  // DEFECT: validating per-prompt while writing. Three good prompts and one bad
  // one, resolved incrementally, mints three immutable versions and then fails —
  // and those three are now unfixable. The caller must receive all or none, so
  // the failure has to precede the first write rather than interrupt the run.
  // ⚠️ THE FIRST DRAFT OF THIS CONTROL ASSERTED A FAULT THAT DID NOT EXIST. It
  // used a third body with no manifest entry, expecting a refusal — but an
  // uncovered body that leaves no orphan is INDISTINGUISHABLE from a genuinely
  // new custom prompt, and the contract says those are recorded as explicitly
  // unknown rather than refused. The resolver was right and the test was wrong.
  // The faulty input has to be one that really does fault: a KNOWN prompt the
  // manifest fails to cover, which is the prod-bricking case.
  let result = 'untouched';
  try {
    result = resolveProvenance({
      pool: [A, B, KNOWN],
      manifest: manifest([entry({ lineage: 'one' }), { lineage: 'two', bodySha256: bodyHash(B) }]),
      knownDefaults: [KNOWN],
    });
  } catch { /* expected */ }
  assert.equal(result, 'untouched',
    'two resolvable prompts must NOT escape alongside one that cannot — they would mint');

  // And the success path really does return every prompt — otherwise the
  // assertion above would pass for the wrong reason.
  const ok = resolveProvenance({
    pool: [A, B],
    manifest: manifest([entry({ lineage: 'one' }), { lineage: 'two', bodySha256: bodyHash(B) }]),
  });
  assert.equal(ok.length, 2, 'the control is only meaningful if the good case resolves fully');
});
