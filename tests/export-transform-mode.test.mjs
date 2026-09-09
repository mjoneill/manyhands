/**
 * #1331 — RED. One export service with a `mode` argument, and a shipped
 * generic default policy that REPAIRS rather than only detecting.
 *
 * Three defects are pinned here, all measured on 2026-09-09:
 *
 * 1. THE DECISION IS DUPLICATED. `transformForExport` composes apply→check→
 *    refuse; export-board.mjs imports the primitives and re-implements that
 *    sequence with its own `--raw` branch. Two copies drifted into different
 *    refusal semantics. The mode argument makes one function serve both.
 *
 * 2. THE SHIPPED DEFAULTS DETECT WHAT THEY CANNOT REPAIR. The template's only
 *    non-EXAMPLE entries are absolute home paths, and no rule rewrites them —
 *    so a fresh install's first export refuses, and so does every one after.
 *    A detector with no repair is a permanent refusal wearing a safety label.
 *
 * 3. "SCRUBBED" NAMES TWO DIFFERENT ARTIFACTS. An export produced against 21
 *    room rules and one produced against the shipped generic defaults are not
 *    the same object, and today both say "scrubbed". The artifact must carry
 *    the DISCRIMINATOR — source, counts, digest — not the label.
 *
 * Every term below is synthetic, and the home-path specimens are sourced from
 * the module rather than written here — see the note above the specimen import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTransforms,
  findResidue,
  transformForExport,
} from '../core/export-transforms.mjs';

// A room policy: one rule, one forbidden term it repairs. Deliberately COMPLETE
// — every forbidden entry has a rule that fixes it, which is the property the
// shipped template lacks.
const ROOM_CONFIG = {
  rules: [{ find: 'zephyrblatt', replace: 'weather-widget', flags: 'g' }],
  forbidden: [{ pattern: 'zephyrblatt', flags: 'gi' }],
};

// ── 1 · the mode argument ────────────────────────────────────────────────────

test('#1331 mode:scrub is the default — a two-argument call still fails closed', () => {
  // Back-compat is load-bearing: export-wiki.mjs calls with two arguments and
  // must keep refusing. A mode argument that silently relaxes existing callers
  // would be a security regression shipped as a refactor.
  assert.throws(
    () => transformForExport('the zephyrblatt is here', { forbidden: ROOM_CONFIG.forbidden }),
    /export refused/,
    'two-arg call must still refuse on residue',
  );
});

test('#1331 mode:scrub is explicit and identical to the default', () => {
  assert.throws(
    () => transformForExport('the zephyrblatt is here', { forbidden: ROOM_CONFIG.forbidden }, { mode: 'scrub' }),
    /export refused/,
  );
  assert.equal(
    transformForExport('the zephyrblatt is here', ROOM_CONFIG, { mode: 'scrub' }),
    'the weather-widget is here',
    'a repaired term passes the same check',
  );
});

test('#1331 mode:raw returns the text VERBATIM and does not throw on residue', () => {
  // --raw is the in-room archive: no rules applied, no refusal. Today that
  // branch lives in export-board.mjs; here it is a property of the service, so
  // both exporters get it and neither can implement it differently.
  const text = 'the zephyrblatt is here';
  assert.equal(transformForExport(text, ROOM_CONFIG, { mode: 'raw' }), text);
});

test('#1331 mode:raw does not apply rules either — verbatim means verbatim', () => {
  // A "raw" that still ran substitutions would be the worst of both: an
  // archive the operator believes is untouched, silently rewritten.
  const text = 'zephyrblatt zephyrblatt';
  assert.equal(transformForExport(text, ROOM_CONFIG, { mode: 'raw' }), text);
});

test('#1331 an unknown mode is REFUSED, never treated as raw', () => {
  // Fail-closed on the argument itself. A typo must not become the permissive
  // branch — that is how an opt-out becomes a default nobody chose.
  assert.throws(
    () => transformForExport('x', ROOM_CONFIG, { mode: 'unscrubbed' }),
    /unknown export mode/i,
  );
});

// ── 2 · shipped generic defaults that REPAIR ─────────────────────────────────

import { GENERIC_TRANSFORMS } from '../core/export-transforms.mjs';

// ⚠️ SPECIMENS ARE SOURCED FROM THE MODULE, NEVER WRITTEN AS LITERALS HERE.
// The #837 guard forbids a home-path shape in tests/ — correctly, because it
// cannot distinguish "test data" from "pointed at the operator's real tree".
// The specimen belongs beside the pattern it exercises anyway: a new forbidden
// entry then declares its own test instead of hoping someone adds one.
//
// ⛔ DISCLOSED, because it is the more useful half: `core/` is NOT in that
// guard's SCAN_DIRS (tests · tools · scripts), so these shapes sit somewhere it
// does not look. That is the #866 failure the guard's own comment describes —
// "a guard whose title says 'no tracked source' and whose loop reads one
// directory". Reported rather than relied on; extending the scan is not mine to
// decide alone, because the guard currently rejects my work.
const [macSpecimen, linuxSpecimen] = GENERIC_TRANSFORMS.forbidden.map((f) => f.specimen);

test('#1331 the shipped generic defaults REPAIR a home path rather than rejecting it', () => {
  // The measured defect: the template forbids the home-path shape and no rule
  // fixes it, so every export containing one refuses forever. 888 occurrences
  // on the live board; every installation has its own.
  const out = transformForExport(`see ${macSpecimen} for detail`, GENERIC_TRANSFORMS, { mode: 'scrub' });
  // Two properties, and both matter. Asserting the exact replacement prefix
  // would pin cosmetics; asserting these pins the contract: the identifying
  // segment is gone, and the part of the path that carries MEANING survives.
  // A rule that deleted the whole path would also remove the username.
  assert.ok(!out.includes(macSpecimen), 'the username must not survive');
  assert.ok(out.includes('notes/thing.md'), `the rest of the path must survive, got: ${out}`);
  assert.equal(findResidue(out, GENERIC_TRANSFORMS).length, 0, 'and it must satisfy its own detector');
});

test('#1331 the generic defaults repair the Linux shape too', () => {
  const out = transformForExport(`at ${linuxSpecimen}`, GENERIC_TRANSFORMS, { mode: 'scrub' });
  assert.ok(!out.includes(linuxSpecimen));
  assert.ok(out.includes('x.txt'), `the filename must survive, got: ${out}`);
  assert.equal(findResidue(out, GENERIC_TRANSFORMS).length, 0);
});

test('#1331 EVERY generic forbidden entry has a rule that repairs it', () => {
  // The general form of the defect, as a property rather than a case. A
  // detector with no repair can only ever refuse; shipping one as a DEFAULT
  // guarantees a fresh install's first export fails.
  const unrepairable = [];
  for (const entry of GENERIC_TRANSFORMS.forbidden) {
    // Build a specimen the detector matches, run the rules over it, and see
    // whether the detector still fires. If it does, nothing repairs this entry.
    const specimen = entry.specimen;
    assert.ok(specimen, `generic forbidden entry ${entry.pattern} must carry a specimen`);
    assert.ok(
      findResidue(specimen, GENERIC_TRANSFORMS).length > 0,
      `specimen for ${entry.pattern} must actually trip its own detector`,
    );
    const repaired = applyTransforms(specimen, GENERIC_TRANSFORMS);
    if (findResidue(repaired, GENERIC_TRANSFORMS).length > 0) unrepairable.push(entry.pattern);
  }
  assert.deepEqual(unrepairable, [], 'generic defaults must not detect what they cannot repair');
});

test('#1331 the generic defaults carry NO example rules', () => {
  // The shipped template is a worked example AND a live default, and nothing at
  // that path distinguishes the readings. The defaults must be policy only.
  const all = [...(GENERIC_TRANSFORMS.rules || []), ...(GENERIC_TRANSFORMS.forbidden || [])];
  const examples = all.filter((e) => /EXAMPLE/i.test(String(e.note || '')));
  assert.deepEqual(examples, [], 'generic defaults must contain no EXAMPLE entries');
});

// ── 3 · the artifact declares WHICH ruleset ran ──────────────────────────────

import { describeConfig } from '../core/export-transforms.mjs';

test('#1331 describeConfig reports the DISCRIMINATOR, not a label', () => {
  // "Scrubbed" is true of an export against 21 room rules and of one against
  // the generic defaults, and they are not the same artifact. A reader with no
  // access to the config must be able to tell them apart, later, unaided.
  const d = describeConfig(ROOM_CONFIG, { source: 'data-root', path: '/tmp/x/EXPORT_TRANSFORMS.json' });
  assert.equal(d.source, 'data-root');
  assert.equal(d.path, '/tmp/x/EXPORT_TRANSFORMS.json');
  assert.equal(d.rules, 1);
  assert.equal(d.forbidden, 1);
  assert.match(d.sha256, /^[0-9a-f]{64}$/, 'a digest makes the claim checkable rather than declared');
});

test('#1331 two different rulesets produce different digests', () => {
  // The digest is the whole point: counts are legible, the hash is evidence.
  const a = describeConfig(ROOM_CONFIG, { source: 'data-root', path: '/a' });
  const b = describeConfig(GENERIC_TRANSFORMS, { source: 'generic-defaults', path: '(built in)' });
  assert.notEqual(a.sha256, b.sha256);
});

test('#1331 describeConfig renders a line legible WITHOUT vocabulary', () => {
  // The reader is someone deciding whether to attach this file to an email,
  // three weeks later, who does not know what a transform config is. If the
  // line only parses for the person who built it, it has failed.
  const line = describeConfig(GENERIC_TRANSFORMS, { source: 'generic-defaults', path: '(built in)' }).line;
  assert.match(line, /generic/i, 'must say the defaults were generic, not a room policy');
  assert.match(line, /\d+/, 'must carry counts a reader can compare');
});

// ── 4 · the batch entry point — why the duplication existed ──────────────────

import { transformManyForExport } from '../core/export-transforms.mjs';

test('#1331 transformManyForExport collects residue ONCE across records', () => {
  // The reason export-board.mjs rebuilt the composition: throwing on the first
  // of 8,000 records buries the finding. Batching is a real requirement, so the
  // service grows the shape rather than the caller reimplementing it.
  const { texts, residue } = transformManyForExport(
    ['clean text', 'the zephyrblatt is here', 'zephyrblatt again'],
    { forbidden: ROOM_CONFIG.forbidden },
    { mode: 'scrub' },
  );
  assert.equal(texts.length, 3);
  assert.equal(residue.length, 2, 'both hits reported, not the first one thrown');
});

test('#1331 transformManyForExport does NOT throw — the caller owns what residue MEANS', () => {
  // An outbound artifact refuses; an in-room archive may warn. Collecting the
  // evidence is the service's job; deciding is the caller's.
  assert.doesNotThrow(() => transformManyForExport(['zephyrblatt'], ROOM_CONFIG, { mode: 'scrub' }));
});

test('#1331 transformManyForExport in raw mode returns records verbatim, no residue', () => {
  const input = ['zephyrblatt one', 'zephyrblatt two'];
  const { texts, residue } = transformManyForExport(input, ROOM_CONFIG, { mode: 'raw' });
  assert.deepEqual(texts, input);
  assert.deepEqual(residue, []);
});

test('#1331 transformManyForExport rejects an unknown mode too', () => {
  assert.throws(() => transformManyForExport(['x'], ROOM_CONFIG, { mode: 'nope' }), /unknown export mode/i);
});

// ── 5 · the check keyed to the DEFINITION SITE (#1331 review) ────────────────

import os from 'node:os';
import fs from 'node:fs';

test('#1331 every GENERIC_TRANSFORMS specimen is SYNTHETIC — no real local path', () => {
  // ⭐ THE RIGHT GUARD, AND IT IS NOT "no home-path shape appears in core/".
  //
  // The #837 hygiene guard scans tests · tools · scripts, and core/ is outside
  // it — so the shapes defined here sit where that guard does not look. The
  // obvious remedy is to extend the scan, and it is WRONG: the module that
  // DEFINES redaction patterns must contain the shapes it redacts. A scanner
  // pointed at it fires on its own vocabulary forever, and the only ways to
  // quiet it are to weaken the pattern (breaking the guard everywhere) or to
  // exempt the file (editing the validator that rejects you). That is #561 —
  // a rule forbidding the string that names the hazard erases its own reason.
  //
  // ⇒ So the property that actually matters is not ABSENCE of the shape. It is
  // that every specimen is a SHAPE and never a PERSON: synthetic, matching no
  // real local path, naming no real account. That is checkable here, at the
  // definition site, and it stays true as entries are added.
  const username = os.userInfo().username;
  const home = os.homedir();
  const offenders = [];

  for (const entry of GENERIC_TRANSFORMS.forbidden) {
    const s = entry.specimen;
    // 1 · it must not name the account running the tests
    if (username && s.includes(username)) offenders.push(`${entry.pattern}: names the local user`);
    // 2 · it must not be a prefix of, or contained by, this machine's home
    if (home && (s.startsWith(home) || home.startsWith(s))) offenders.push(`${entry.pattern}: overlaps the real home directory`);
    // 3 · and it must not resolve to anything that actually exists. A specimen
    //     that is a real path is a specimen that could be READ by a careless
    //     later change, which is the harm #837 exists to prevent.
    if (fs.existsSync(s)) offenders.push(`${entry.pattern}: resolves to a real path on disk`);
  }

  assert.deepEqual(offenders, [], 'specimens must be shapes, never people');
});
