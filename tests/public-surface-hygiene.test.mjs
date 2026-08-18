/**
 * #837 — WHAT A PUBLIC CI LOG IS ALLOWED TO CONTAIN.
 *
 * CI ships under one condition from the repo owner: the tests must not leak the
 * very things the release gates exist to catch. A public job log publishes
 * everything the suite prints, to anyone, permanently — so the log surface is
 * now part of the threat model rather than a side effect.
 *
 * ⛔ THE VOCABULARY ITSELF IS NOT IN THIS FILE AND MUST NEVER BE.
 *
 * The obvious guard — "assert no forbidden term appears in the tree" — requires
 * the forbidden terms, in the public repo, to prove the public repo has no
 * forbidden terms. That is circular, and it loses on its own terms: the check
 * would publish exactly what it protects. Hashing them is no better, because a
 * salted hash of a short common word is a dictionary lookup, which is security
 * theatre rather than security.
 *
 * ⇒ The real vocabulary guard lives in the PRIVATE pre-push gate, which holds
 *   the list and refuses a push that adds any of it. That rail exists, it works
 *   (verified behaviourally: it catches the terms, and passes innocent text and
 *   deliberate junk), and it guards PUBLICATION.
 *
 * ⇒ THIS file guards the two things that CAN be checked without naming
 *   anything: that the public template never becomes the real list, and that no
 *   test reaches for live data whose contents nobody has reviewed.
 *
 * ⚠️ Both are the same failure in different clothes — a future contributor being
 * helpful. Filling in an obviously-empty EXAMPLE list is a natural thing to do.
 * Pointing a test at the real board to make it realistic is a natural thing to
 * do. Neither is caught by any existing rail until the push, and one of them
 * would already have rendered into a public log by then.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.join(import.meta.dirname, '..');
const TESTS = import.meta.dirname;

/**
 * A pattern that is a plain sequence of word characters is a LITERAL TERM —
 * someone typed a word in. A pattern carrying regex machinery (classes,
 * anchors, quantifiers, alternation, escapes) is describing a SHAPE.
 *
 * The distinction is the whole check: shapes are safe to publish, words are the
 * thing we are keeping out.
 */
function isPlainWordLiteral(pattern) {
  return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(pattern);
}

test('#837 the public transforms file stays a TEMPLATE — never the real list', () => {
  // ⚠️ This file is tracked and public. Its `forbidden` entries are examples and
  // generic shapes. If someone pastes the live vocabulary in here "so the
  // example is useful", the repo publishes the list the private gate exists to
  // enforce — and it would look like a helpful contribution in review.
  const file = path.join(REPO, 'EXPORT_TRANSFORMS.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.ok(Array.isArray(doc.forbidden) && doc.forbidden.length > 0,
    'sanity: the forbidden list is populated, so an empty array cannot pass vacuously');

  // ⚠️ RATCHETED ON THE EXACT SET, not on a count, and NOT on the "EXAMPLE"
  // label. Three entries here are literal words today — they are placeholders
  // shipped as documentation. Exempting anything whose note SAYS "EXAMPLE"
  // would be an author-declared exemption, and a wrong label would then hide a
  // real term forever. Pinning the exact set trusts nothing: a new literal
  // changes it and fails, whatever its note claims.
  //
  // Notes are compared, never patterns — the failure message must not print the
  // very strings this test exists to keep out of public view.
  const EXPECTED_LITERAL_NOTES = [
    'EXAMPLE — internal mode name',
    'EXAMPLE — internal nickname',
    'EXAMPLE — private-repo commit hash',
  ];

  const literals = doc.forbidden.filter((e) => isPlainWordLiteral(e.pattern));
  assert.deepEqual(
    literals.map((e) => e.note || '(no note)').sort(), [...EXPECTED_LITERAL_NOTES].sort(),
    'the set of plain-word entries in EXPORT_TRANSFORMS.json changed.\n'
    + '  This file is PUBLIC. A literal word here publishes the vocabulary the\n'
    + '  private push gate exists to keep out of the repo.\n'
    + '  A NEW entry: express it as a SHAPE, or put it in the private gate.\n'
    + '  A REMOVED entry: good — delete it from EXPECTED_LITERAL_NOTES too.\n'
    + '  (Notes are shown, never patterns — on purpose.)',
  );
});

test('#837 POSITIVE CONTROL — a plain word IS detected as a literal', () => {
  // Without this, the assertion above is satisfied equally well by a detector
  // that never fires. The word here is innocuous and invented on purpose.
  assert.equal(isPlainWordLiteral('somelocalword'), true, 'a bare word must read as a literal');
  assert.equal(isPlainWordLiteral('zzz probe term'), true, 'a bare phrase too');
  assert.equal(isPlainWordLiteral('/Users/[^/]+/'), false, 'a path SHAPE is not a literal');
  assert.equal(isPlainWordLiteral('\\b\\w+@\\w+\\b'), false, 'a regex shape is not a literal');
});

test('#837 no tracked source reaches for LIVE board, roster or home-directory data', () => {
  // A test pointed at the real board would render real card titles and real
  // message text into a public job log, and no name-residue scan would
  // recognise it as anything but test output. The suite currently points every
  // data path at os.tmpdir(); this is what keeps that true.
  const offenders = [];
  const selfName = path.basename(new URL(import.meta.url).pathname);

  // ⛔ #866 — THIS SCANNED `tests/` ONLY, AND THE FIRST REAL LEAK WAS IN `tools/`.
  // A tool committed to this repo hardcoded an absolute path into the operator's
  // private data tree; the push gate caught it and this guard did not, because
  // this guard was not looking there. A guard whose title says "no tracked source"
  // and whose loop reads one directory is the lying-label class applied to itself.
  const SCAN_DIRS = ['tests', 'tools', 'scripts'];

  // ⚠️ EXEMPTIONS ARE EXPLICIT, REASONED, AND TESTED (see the test below this one).
  // An exemption that names a file which no longer exists is an exemption nobody
  // reviews, and a silently-stale allowlist is how a guard stops guarding.
  const ALLOWED_LIVE_READS = new Map([
    ['tests/field-triple-coverage.test.mjs',
      'RC0b deliberately enumerates keys from the LIVE board when one is reachable, '
      + 'because that is the only source that can surface a field written by a path '
      + 'nobody remembers. It degrades to PARTIAL and says so when no board answers.'],
    ['tests/boot-gate.test.mjs',
      'spawns its OWN server on the production port on purpose, to prove a second '
      + 'instance refuses to start. The port number is the subject of the test, not '
      + 'an attempt to read the operator board.'],
  ]);

  // ⚠️ THE LIVE-BOARD RULE APPLIES TO `tests/` ONLY, AND THE DISTINCTION IS REAL.
  // An operator TOOL that talks to a running board is doing its job — board-lint,
  // fanout-watch and suite-watch exist precisely to observe a live instance.
  // A TEST that talks to a running board borrows the operator's data, pollutes a
  // public CI log with it, and passes for a reason unrelated to the code under
  // test. Same string, opposite meaning, decided by which directory it is in.
  const LIVE_RULE_DIRS = new Set(['tests']);

  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(mjs|js|cjs)$/.test(entry.name)) continue;
      if (dir === 'tests' && entry.name === selfName) continue;  // documents its own patterns
      files.push([`${dir}/${entry.name}`, path.join(abs, entry.name)]);
    }
  }

  for (const [rel, absPath] of files) {
    const raw = fs.readFileSync(absPath, 'utf8');

    // ⚠️ COMMENTS ARE STRIPPED FIRST, because the property is "does a test READ
    // live data", not "does a test MENTION a path". The first version matched
    // prose and flagged a header comment describing where a watcher writes its
    // artifacts — a documentation line, harmless, and exactly the always-fires
    // rule this suite keeps rediscovering. A path in a string literal is a path
    // the test uses; a path in a comment is a path the test talks about.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');      // whole-line comments

    // An absolute home path, a tilde-relative one, or a dotted config dir under
    // a home directory — all hardcoded ways to reach data outside the repo.
    //
    // ⛔ EXPRESSED AS SHAPES, NEVER AS THE NAME OF THE PRIVATE TREE. The first
    // version of this loop matched a literal directory name, and the push gate
    // refused the commit: the check against publishing a private path published
    // it. That is this file's own subject arriving one level up, and the gate
    // caught what review would not have.
    for (const re of [
      /\/Users\/[A-Za-z0-9._-]+\//,      // macOS home
      /\/home\/[A-Za-z0-9._-]+\//,       // Linux home
      /(^|['"`\s])~\//m,                 // tilde-relative
      /\/\.[a-z][a-z0-9-]*\/workspace\//, // a dotted config dir holding a workspace
    ]) {
      if (re.test(src)) offenders.push(`${rel} — matches ${re}`);
    }

    // ⛔ #866 — THE SECOND MISSING THIRD. The title says "LIVE board" and nothing
    // here looked for one. A test can reach the operator's real board over a
    // LOOPBACK URL without any filesystem path at all — which is exactly how
    // #831 RC0b passed for weeks on borrowed production data, invisible to this
    // guard, until CI ran it on a machine with no board.
    const LIVE_BOARD = /127\.0\.0\.1:31\d\d|localhost:31\d\d/;
    if (LIVE_RULE_DIRS.has(rel.split('/')[0]) && LIVE_BOARD.test(src) && !ALLOWED_LIVE_READS.has(rel)) {
      offenders.push(`${rel} — reaches the LIVE board over a loopback URL`);
    }
  }

  assert.deepEqual(
    offenders, [],
    'a test hardcodes a home directory or the live data tree.\n'
    + '  Point it at os.tmpdir() with a fixture. A test that reads live board\n'
    + '  data prints live board data, and in CI that is a public, permanent log.',
  );
});

test('#837 every live-read exemption names a file that still exists', () => {
  // ⚠️ #866 — an exemption is a hole in a guard, and a hole nobody can see is
  // worse than no guard. If an exempted file is renamed or deleted, the entry
  // becomes an unreviewable permanent hole that reads as deliberate. This makes
  // a stale exemption FAIL rather than linger.
  const EXEMPT = ['tests/field-triple-coverage.test.mjs', 'tests/boot-gate.test.mjs'];
  const missing = EXEMPT.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
  assert.deepEqual(missing, [], 'a live-read exemption names a file that no longer exists');

  // And each exempted file must actually still contain the thing it is exempted
  // FOR — an exemption for a pattern the file no longer has is equally stale.
  const stillNeeded = EXEMPT.filter((rel) =>
    /127\.0\.0\.1:31\d\d|localhost:31\d\d/.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));
  assert.deepEqual(
    EXEMPT, stillNeeded,
    'an exemption is no longer needed — the file no longer reaches a live board. Remove it.',
  );
});

test('#837 POSITIVE CONTROL — the live-data detector fires on a live-data path', () => {
  // The paired control for the check above: it must be capable of failing.
  // Built from fragments so this file does not itself contain a home path that
  // the check would have to exempt.
  const live = ['/Users', 'someone', 'project'].join('/') + '/';
  assert.match(live, /\/Users\/[A-Za-z0-9._-]+\//, 'the detector must match a real home path');
  assert.doesNotMatch('os.tmpdir()', /\/Users\/[A-Za-z0-9._-]+\//, 'and must not match a tmpdir call');
});

test('#837 the CI workflow emits no secrets, no env dump, and uploads no data', () => {
  // The workflow is the other half of the log surface. These are the edits most
  // likely to be made later, by someone debugging a red build, at the moment
  // they are least likely to be thinking about what a public log contains.
  const wf = path.join(REPO, '.github', 'workflows', 'ci.yml');
  assert.ok(fs.existsSync(wf), 'the CI workflow must exist — #837 is not satisfied by a plan');
  const src = fs.readFileSync(wf, 'utf8');

  const banned = [
    [/\$\{\{\s*secrets\./, 'references a secret — this workflow needs none, and a secret makes fork PRs an exfiltration surface'],
    [/^\s*run:\s*.*\bprintenv\b/m, 'dumps the environment'],
    [/^\s*run:\s*.*\bset -x\b/m, 'traces commands, which prints values'],
    [/upload-artifact/, 'uploads artifacts — data files must never leave the runner'],
  ];
  const hits = banned.filter(([re]) => re.test(src)).map(([, why]) => why);
  assert.deepEqual(hits, [], 'the CI workflow violates its own log-hygiene rules');

  assert.match(src, /permissions:\s*\n\s*contents:\s*read/,
    'the workflow must declare a least-privilege token rather than inherit repo defaults');
});
