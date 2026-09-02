/**
 * #596 — the agent-identity pre-commit rail.
 *
 * The rule: an agent session (CLAUDECODE or AI_AGENT in env) must commit
 * under a seat identity (*@manyhands.invalid). A human terminal carries no
 * agent marker and must NEVER be refused — that boundary is the card's
 * hard constraint, so it gets its own control here.
 *
 * Three controls (the third is the one that would embarrass us: a hook
 * that refuses everything is indistinguishable from a working hook until
 * it blocks a legitimate commit).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-commit');
const SEATS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'seat-identities.sh');

// A clean env with NO agent markers — the human-terminal baseline.
function baseEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.AI_AGENT;
  return env;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-596-'));
  const git = (args, env) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init', '-q'], baseEnv());
  // The tree's fallback human identity, as in the real repo.
  git(['config', 'user.name', 'Default Human'], baseEnv());
  git(['config', 'user.email', 'human@example.com'], baseEnv());
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.copyFileSync(HOOK, path.join(dir, '.githooks', 'pre-commit'));
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  // #751 phase 2 — the rail sources its seat list from a separate file. A
  // fixture without it exercises the FAIL-CLOSED path (which has its own test
  // below), not the rule under test.
  fs.copyFileSync(SEATS, path.join(dir, '.githooks', 'seat-identities.sh'));
  fs.chmodSync(path.join(dir, '.githooks', 'seat-identities.sh'), 0o755);
  // The dispatcher shim, exactly as installed in the live tree.
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n');
  fs.chmodSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
  return { dir, git };
}

function tryCommit({ git, dir }, { env, stamp }) {
  fs.appendFileSync(path.join(dir, 'f.txt'), 'x');
  git(['add', 'f.txt'], baseEnv());
  const args = ['commit', '-q', '-m', 'probe'];
  const idArgs = stamp
    ? ['-c', `user.name=${stamp.name}`, '-c', `user.email=${stamp.email}`]
    : [];
  try {
    git([...idArgs, ...args], env);
    return { ok: true };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr) };
  }
}

const SYNTHETIC = 'synthetic-owner';   // never a real local part

// #751 phase 2 — a VALID identity, derived from the shipped hook.
//
// After tightening, only the configured seats are valid: a synthetic name like
// `Ada` is refused no matter what address it carries, because the rule matches
// whole (name, address) PAIRS. So these tests can no longer invent a seat.
//
// ⇒ They derive one instead. `seatIdents()`/`parseShape()` (below — function
//   declarations, so hoisted) read the production hook, and the local part is
//   synthetic. The file therefore carries NO literal seat name of its own,
//   which is the property that kept real identities out of tracked content.
function aSeat(index = 0) {
  const shapes = seatIdents().map(parseShape).filter(Boolean);
  assert.ok(shapes.length > index, 'the hook must configure a seat to derive from');
  const s = shapes[index];
  return { name: s.name, email: `${SYNTHETIC}+${s.tag}@${s.domain}` };
}

test('agent env + default human identity → REFUSED, naming the fix', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, { env: { ...baseEnv(), CLAUDECODE: '1' } });
  assert.equal(r.ok, false, 'unstamped agent commit must refuse');
  assert.match(r.stderr, /#596/, 'refusal names the card');
  assert.match(r.stderr, /stamp your seat/, 'refusal names the fix');
});

test('AI_AGENT alone also triggers the rail (union of markers — not Claude-only)', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, { env: { ...baseEnv(), AI_AGENT: '1' } });
  assert.equal(r.ok, false, 'the rail must not be blind to non-Claude toolchains');
});

test('agent env + seat identity → PASSES (a correctly stamped commit is never blocked)', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, {
    env: { ...baseEnv(), CLAUDECODE: '1' },
    stamp: aSeat(),
  });
  assert.equal(r.ok, true, `stamped agent commit must pass: ${r.stderr ?? ''}`);
});

test('no agent env + any identity → PASSES (a human commit can never be refused)', () => {
  const repo = makeRepo();
  const r = tryCommit(repo, { env: baseEnv() });
  assert.equal(r.ok, true, 'the human-terminal boundary is absolute');
});

// ⚰️ The second detector (commit-msg) was RETIRED 2026-08-09 — its input could
// not distinguish a seat's accidental fallback from the owner legitimately
// crediting a seat, and its trigger was a voluntary trailer nobody emits
// reliably. Reasoning lives in .githooks/seat-identities.sh so the next person
// to consider rebuilding it reads it first. Its tests went with it.

test('committer slot is checked too: agent env + seat AUTHOR but default COMMITTER → REFUSED', () => {
  // The amend shape: --amend preserves the author and silently resets the
  // committer from config — half the identity verified, the other half fallen
  // back. Both slots must be seats.
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'x');
  repo.git(['add', 'f.txt'], baseEnv());
  let refused = false;
  try {
    repo.git(['commit', '-q', '-m', 'probe'], {
      ...baseEnv(), CLAUDECODE: '1',
      GIT_AUTHOR_NAME: aSeat().name, GIT_AUTHOR_EMAIL: aSeat().email,
      // committer falls back to the repo's default human config
    });
  } catch { refused = true; }
  assert.equal(refused, true, 'seat author + human committer must refuse — the amend gap');
});

test('the --author escape is closed: agent env + --author seat flag + default committer → REFUSED', () => {
  // git var GIT_AUTHOR_IDENT resolves --author inside pre-commit, so a
  // single-slot rail sees a seat and passes while the committer stays human —
  // demonstrated live before the both-slots fix. This pins the escape shut.
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'x');
  repo.git(['add', 'f.txt'], baseEnv());
  let refused = false;
  try {
    repo.git(['commit', '-q', `--author=${aSeat().name} <${aSeat().email}>`, '-m', 'probe'],
      { ...baseEnv(), CLAUDECODE: '1' });
  } catch { refused = true; }
  assert.equal(refused, true, '--author alone must not satisfy the rail');
});

// ── #751 — the seat SHAPES, tested against the shipped configuration ─────────
//
// ⚠️ WHY THIS EXISTS. #751 added three plus-address shapes to the hook and the
// suite did not notice: deleting all three left 9/9 green. A rail whose absence
// no test can see is drafted, not shipped — the same defect as the group-kill
// mutant (#745) and `verifyStopped`'s blind confirmation (#752), committed into
// the very commit that adds a rail.
//
// ⚠️ AND WHY IT READS THE HOOK RATHER THAN LISTING IDENTITIES. The real seat
// addresses are tagged variants of a person's address; writing them here would
// put a real-world identity into a tracked file, which is what the export gate
// exists to prevent and what killed the hashed-digest design. So the test
// PARSES the shipped `SEAT_IDENTS` block and materialises each shape with a
// SYNTHETIC local part. It therefore tests the configuration that ships,
// cannot drift from it, and carries no identity of its own.

/** The shipped SEAT_IDENTS entries, read from the production hook. */
function seatIdents() {
  const src = fs.readFileSync(SEATS, 'utf8');
  const m = src.match(/SEAT_IDENTS='([^']*)'/);
  assert.ok(m, 'seat-identities.sh must define SEAT_IDENTS — if this fails the rail was renamed or removed');
  return m[1].split('\n').filter(Boolean);
}

/** `Seat <*+seat@example.com>` → {name, tag, domain} — a synthetic example on
 *  purpose: this file must carry no real identity of its own. */
function parseShape(entry) {
  const m = entry.match(/^(.+) <\*\+([^@]+)@(.+)>$/);
  return m ? { name: m[1], tag: m[2], domain: m[3] } : null;
}


test('#751 the shipped hook carries ONLY the plus-address shapes — legacy is gone', () => {
  const entries = seatIdents();
  const legacy = entries.filter((e) => e.includes('@manyhands.invalid'));
  const shapes = entries.map(parseShape).filter(Boolean);
  assert.equal(legacy.length, 0,
    `phase 2 tightened: the legacy wildcard is GONE, got ${JSON.stringify(legacy)}`);
  // ⚠️ EXACTLY three, never `>= 3`. A lower bound makes exception growth
  // SELF-APPROVING: add a fourth configured seat and every case below silently
  // adopts it, so the inventory grows and nothing anywhere goes red. That is
  // #753's failure mode — "nothing fails when an allowlist gets one entry
  // longer" — reproduced inside the rail written to close it.
  //
  // ⇒ A new seat SHOULD break this line. The repair is to come here, read what
  //   changed, and update the number deliberately — which is the only moment
  //   anyone is forced to look at the total.
  assert.equal(shapes.length, 3,
    `the seat inventory changed. If that was deliberate, update this number and say why: ${JSON.stringify(entries)}`);
  // Anti-vacuity, kept for the reader even though the equality above now
  // subsumes it: with zero shapes configured every case below iterates an
  // empty set and passes on nothing, which is how the shapes shipped untested.
  assert.ok(shapes.length > 0, 'no shapes configured: every case below would be vacuous');
});

test('#751 every configured shape ACCEPTS a matching identity (both slots)', () => {
  for (const shape of seatIdents().map(parseShape).filter(Boolean)) {
    const repo = makeRepo();
    const email = `${SYNTHETIC}+${shape.tag}@${shape.domain}`;
    const r = tryCommit(repo, {
      env: { ...baseEnv(), CLAUDECODE: '1' },
      stamp: { name: shape.name, email },
    });
    assert.equal(r.ok, true,
      `configured shape must pass: ${shape.name} <${email}> — ${r.stderr ?? ''}`);
  }
});

test('#751 a CROSSED name/tag pair is refused — every part legitimate, the combination not', (t) => {
  const shapes = seatIdents().map(parseShape).filter(Boolean);
  // ⚠️ SKIP, not `return`, and not a failure either — the two obvious options
  // are both wrong here and for opposite reasons.
  //
  //   bare `return`  the case passes green while testing nothing. A silent
  //                  skip, in the file whose entire subject is silent skips.
  //   assert         a second red for a root cause the inventory test above
  //                  already reports — one defect, two failures, and the
  //                  second one less informative than the first.
  //
  // ⇒ An explicit skip is neither: it CANNOT be read as a pass (TAP marks it
  //   `# SKIP` with this reason), and it does not cascade. Cardinality is the
  //   inventory test's job; this one declines to run rather than pretending.
  if (shapes.length < 2) {
    t.skip(`need ≥2 shapes to cross, found ${shapes.length} — see the inventory test, which owns this`);
    return;
  }
  for (const [i, shape] of shapes.entries()) {
    const other = shapes[(i + 1) % shapes.length];
    const repo = makeRepo();
    const email = `${SYNTHETIC}+${other.tag}@${other.domain}`;
    const r = tryCommit(repo, {
      env: { ...baseEnv(), CLAUDECODE: '1' },
      stamp: { name: shape.name, email },
    });
    assert.equal(r.ok, false,
      `crossed identity must refuse: ${shape.name} <${email}>`);
  }
});

test('#751 an UNTAGGED address at the same domain is refused — the human-fallback shape', () => {
  // The forbidden fallback and a required seat differ by one `+`. This is the
  // case the whole narrowing turns on.
  for (const shape of seatIdents().map(parseShape).filter(Boolean)) {
    const repo = makeRepo();
    const email = `${SYNTHETIC}@${shape.domain}`;
    const r = tryCommit(repo, {
      env: { ...baseEnv(), CLAUDECODE: '1' },
      stamp: { name: shape.name, email },
    });
    assert.equal(r.ok, false, `untagged address must refuse: ${shape.name} <${email}>`);
  }
});

test('#751 a mistyped tag and a foreign domain are both refused', () => {
  for (const shape of seatIdents().map(parseShape).filter(Boolean)) {
    const cases = [
      `${SYNTHETIC}+${shape.tag.slice(0, -1)}@${shape.domain}`,  // typo: one char short
      `${SYNTHETIC}+${shape.tag}@elsewhere.example`,             // right tag, wrong domain
    ];
    for (const email of cases) {
      const repo = makeRepo();
      const r = tryCommit(repo, {
        env: { ...baseEnv(), CLAUDECODE: '1' },
        stamp: { name: shape.name, email },
      });
      assert.equal(r.ok, false, `must refuse: ${shape.name} <${email}>`);
    }
  }
});

test('#751 the COMMITTER slot is checked against the shapes too, not just the author', () => {
  // The --amend gap, at the new addresses: author stamped, committer falls back.
  const shape = seatIdents().map(parseShape).filter(Boolean)[0];
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'x');
  repo.git(['add', 'f.txt'], baseEnv());
  let refused = false;
  try {
    repo.git(['commit', '-q', '-m', 'probe'], {
      ...baseEnv(),
      CLAUDECODE: '1',
      GIT_AUTHOR_NAME: shape.name,
      GIT_AUTHOR_EMAIL: `${SYNTHETIC}+${shape.tag}@${shape.domain}`,
      // committer left to the tree's human fallback
    });
  } catch { refused = true; }
  assert.equal(refused, true, 'seat author + human committer must refuse at the new addresses');
});

/**
 * #751 phase 2 — the rail FAILS CLOSED when its seat list is missing.
 *
 * The list lives in its own file so that any future rail consults the same
 * definition — two rails that can disagree about what a seat is eventually do,
 * and one had been inert for months on exactly that. But a separate file is a
 * new dependency, and the failure mode of a missing dependency is the one this
 * board keeps finding: a guard that cannot load its own rule must not wave
 * commits through.
 *
 * ⚠️ Discovered by accident and then pinned deliberately: the first version of
 * this suite's fixture copied only the hook, so every case exercised the
 * fail-closed path instead of the rule. 11 tests went red and the CAUSE was the
 * guard working. An incomplete fixture and a broken rail look identical from
 * the outside — so the fail-closed path gets its own test rather than being
 * something the suite hits by mistake.
 */
test('#751 pre-commit FAILS CLOSED when seat-identities.sh is unreadable', () => {
  const repo = makeRepo();
  // ⚠️ ISOLATE THE RAIL UNDER TEST. The first version installed BOTH hooks,
    // so either one refusing satisfied "the commit was refused" — and a mutant
    // that disabled pre-commit's fail-closed passed, because commit-msg refused
    // instead. The assertion could not fail for the reason it claimed.
    // Measured: mutant applied, suite green, guard genuinely fail-OPEN.
    fs.rmSync(path.join(repo.dir, '.githooks', 'seat-identities.sh'));
    const r = tryCommit(repo, { env: { ...baseEnv(), CLAUDECODE: '1' }, stamp: aSeat() });
  assert.equal(r.ok, false,
    'pre-commit must refuse when it cannot read the seat list — an unreadable list is not an empty one');
  // ⇒ WHICH rail refused, not merely THAT something did. The original version
  //   installed a second hook too, so its refusal satisfied this assertion and
  //   a mutant that disabled THIS one passed. See the note below.
  assert.match(r.stderr, /^pre-commit \(#596\):/m,
    `the refusal must come from pre-commit itself, not from a neighbouring hook: ${r.stderr}`);
  assert.match(r.stderr, /seat-identities\.sh/,
    'and it must name the file it could not read, not fail anonymously');
});

// ── #877 — a seat does not commit in the SHARED dev checkout ──────────────────
// Keyed on `git config manyhands.sharedTree true`, set once in that tree. A
// fixture without the flag (every test above) is untouched; a flagged PRIMARY
// tree refuses an agent's commit even when correctly stamped; a linked
// WORKTREE of that same flagged repo passes; the owner's terminal passes.

function flagShared({ git }) { git(['config', 'manyhands.sharedTree', 'true'], baseEnv()); }

test('#877 flagged shared tree + agent + a correct seat stamp → REFUSED, naming the worktree way out', () => {
  const repo = makeRepo();
  flagShared(repo);
  const r = tryCommit(repo, { env: { ...baseEnv(), CLAUDECODE: '1' }, stamp: aSeat() });
  assert.equal(r.ok, false, 'a seat must not commit in the shared checkout even with a valid identity');
  assert.match(r.stderr, /#877/, 'refusal names the card');
  assert.match(r.stderr, /worktree\.sh new/, 'refusal names the way out');
});

test('#877 flagged shared tree + the OWNER\'s terminal (no agent marker) → passes untouched', () => {
  const repo = makeRepo();
  flagShared(repo);
  const r = tryCommit(repo, { env: baseEnv() });
  assert.equal(r.ok, true, `the owner commits in his own checkout: ${r.stderr}`);
});

test('#877 a LINKED WORKTREE of the flagged repo + agent + seat stamp → passes (that is where seats build)', () => {
  const repo = makeRepo();
  flagShared(repo);
  // The worktree needs a commit to branch from: make one as the owner.
  const seed = tryCommit(repo, { env: baseEnv() });
  assert.equal(seed.ok, true, seed.stderr);
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-877-wt-'));
  fs.rmSync(wtDir, { recursive: true });
  repo.git(['worktree', 'add', '-q', '-b', 'card/1-probe', wtDir], baseEnv());
  // The dispatcher resolves the hook through show-toplevel, so the worktree
  // needs the same .githooks the primary has — a worktree checks out tracked
  // files, and .githooks was never committed in this fixture. Copy it in.
  fs.mkdirSync(path.join(wtDir, '.githooks'), { recursive: true });
  for (const f of ['pre-commit', 'seat-identities.sh']) {
    fs.copyFileSync(path.join(repo.dir, '.githooks', f), path.join(wtDir, '.githooks', f));
    fs.chmodSync(path.join(wtDir, '.githooks', f), 0o755);
  }
  const wt = { dir: wtDir, git: (args, env) => execFileSync('git', args, { cwd: wtDir, env, stdio: 'pipe' }) };
  const r = tryCommit(wt, { env: { ...baseEnv(), CLAUDECODE: '1' }, stamp: aSeat() });
  assert.equal(r.ok, true, `a seat's stamped commit in a linked worktree must pass: ${r.stderr}`);
  const unstamped = tryCommit(wt, { env: { ...baseEnv(), CLAUDECODE: '1' } });
  assert.equal(unstamped.ok, false, 'and #596 still applies there: an unstamped seat commit is refused');
  assert.match(unstamped.stderr, /#596/);
});
