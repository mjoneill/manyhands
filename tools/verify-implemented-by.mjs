#!/usr/bin/env node
/**
 * #814 / BF4 — every `implementedBy` sha must RESOLVE to a real git object.
 *
 * ⛔ THE GAP THIS EXISTS FOR, and it was found by a seat fabricating one:
 * `implementedBy` validates LENGTH, not EXISTENCE (#876). Forty hex characters
 * pass. So a sha nobody can resolve is accepted exactly as readily as a real
 * one, and the Banana Test's first third — "return a card's implementing
 * commits" — answers with equal confidence either way.
 *
 *   BF1  anchored to a REAL git sha, never invented
 *   BF4  and "real" is verified by RESOLUTION, not by shape
 *
 * ⚠️ Without BF4, BF1 is a rule with no rail under it — which is a wish.
 *
 * ⭐ WHY A STANDING VERIFIER RATHER THAN A WRITE GATE. The board server holds
 * DATA and need not live beside the CODE repo — the two-tree topology is
 * deliberate. A write-time `git cat-file` would either couple them or fail open
 * on every deployment where the repo is absent, and a validator that fails open
 * is a validator that reports clean when it cannot see. This runs where the repo
 * IS, reports a LIST, and says plainly what it could not check.
 *
 * usage:
 *   node tools/verify-implemented-by.mjs [--api http://127.0.0.1:3141]
 *                                        [--repo <path>]...   (repeatable)
 *   MANYHANDS_REPOS=/path/a:/path/b node tools/verify-implemented-by.mjs
 *
 * exits 1 only if a sha resolves in NO listed tree. A commit that exists but has
 * not landed is REPORTED and exits 0 — a branch mid-flight is a normal state.
 */

import { execFileSync } from 'node:child_process';

const API = (() => {
  const i = process.argv.indexOf('--api');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:3141';
})();

/**
 * The repositories to resolve against.
 *
 * ⛔ NO PATH IS BAKED IN. This file is published, and a room's private tree
 * locations are not ours to ship — so the trees are named by the operator:
 * `--repo` (repeatable), else MANYHANDS_REPOS (colon-separated), else the
 * current repository, which is exactly today's behaviour.
 */
export function knownRepos(argv = process.argv, env = process.env) {
  const repos = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo' && argv[i + 1]) repos.push(argv[i + 1]);
  }
  if (!repos.length && env.MANYHANDS_REPOS) {
    repos.push(...env.MANYHANDS_REPOS.split(':').filter(Boolean));
  }
  return repos.length ? repos : [process.cwd()];
}

const gitOk = (repo, args) => {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};

/**
 * Resolve one sha across every known tree, and answer BOTH questions.
 *
 * ⛔ THE FIRST FIX. This used to run bare `git cat-file` with no `-C`, so it
 * resolved against whatever repository the caller happened to be standing in.
 * With more than one tree in play, a real commit made in another one came back
 * UNRESOLVABLE — and in a tool built to catch fabricated shas (#876/#896), that
 * word is an accusation of invention, not a note about scope.
 *
 * ⛔ THE SECOND FIX, same call site. `cat-file -e` answers "does it EXIST" and
 * never "did it LAND": a commit on an unmerged branch resolves perfectly. That
 * is how a card can carry a real, verified, correctly-recorded sha for a fix
 * that is not in the tree, and have every instrument call it complete.
 *
 * ⚠️ THE CONTRACT, and it must not be flattened:
 *
 *     resolves NOWHERE            ⇒ fatal. The fabrication case.
 *     resolves, NOT an ancestor   ⇒ REPORTED, not fatal. A branch mid-flight is
 *                                   a normal state, and a tool that fails its
 *                                   caller for a normal state teaches the
 *                                   caller to stop calling it.
 *
 * @returns {{resolved: boolean, tree: string|null, landed: boolean, fatal: boolean}}
 */
export function resolveSha(sha, repos = [process.cwd()]) {
  for (const repo of repos) {
    if (!gitOk(repo, ['cat-file', '-e', `${sha}^{commit}`])) continue;
    return {
      resolved: true,
      tree: repo,
      landed: gitOk(repo, ['merge-base', '--is-ancestor', sha, 'HEAD']),
      fatal: false,
    };
  }
  return { resolved: false, tree: null, landed: false, fatal: true };
}

/** BF4's original question, kept so existing callers read the same. */
export function resolves(sha, repos = [process.cwd()]) {
  return resolveSha(sha, repos).resolved;
}

async function allCards() {
  const out = [];
  let before = null;
  for (;;) {
    let u = `${API}/api/cards?fields=all&limit=500`;
    if (before) u += `&before=${before}`;
    const b = await (await fetch(u)).json();
    const fresh = b.cards.filter((c) => !out.some((x) => x.shortId === c.shortId));
    if (!fresh.length) break;
    out.push(...fresh);
    if (out.length >= b.cardsTotal) break;
    before = b.cards[b.cards.length - 1].shortId;
  }
  return out;
}

async function main() {
  const cards = (await allCards()).filter((c) => (c.implementedBy || []).length);
  const seen = new Map();       // sha -> [shortId]
  for (const c of cards) {
    for (const sha of c.implementedBy) {
      if (!seen.has(sha)) seen.set(sha, []);
      seen.get(sha).push(c.shortId);
    }
  }

  const repos = knownRepos();

  const bad = [];        // resolves in NO known tree — the fabrication case
  const notMerged = [];  // resolves, but is not an ancestor of that tree's HEAD
  const byTree = new Map();
  for (const [sha, cardIds] of seen) {
    const r = resolveSha(sha, repos);
    if (!r.resolved) { bad.push({ sha, cards: cardIds }); continue; }
    byTree.set(r.tree, (byTree.get(r.tree) || 0) + 1);
    if (!r.landed) notMerged.push({ sha, cards: cardIds, tree: r.tree });
  }

  console.log(`cards carrying implementedBy   ${cards.length}`);
  console.log(`distinct shas referenced       ${seen.size}`);
  console.log(`trees searched                 ${repos.length}`);
  for (const r of repos) console.log(`   ${r}`);
  // ⭐ WHERE each sha was found, not merely that it was. A clean run has to be
  // auditable by somebody who did not run it, and "0 unresolvable" from one tree
  // and from four are different claims wearing the same number.
  for (const [tree, n] of byTree) console.log(`resolved in ${tree}   ${n}`);

  console.log(`⛔ shas that resolve in NO known tree   ${bad.length}`);
  // ⭐ A LIST, NOT A COUNT. "3 unresolvable" is a number nobody can act on; the
  // shas with the cards carrying them are a repair queue.
  for (const b of bad) {
    console.log(`   ${b.sha}   on card(s) ${b.cards.join(', ')}`);
  }

  // ⚠️ REPORTED, NEVER FATAL. A branch mid-flight is a normal state; failing the
  // caller for it teaches the caller to stop calling this. But it is also how a
  // card carries a real, verified sha for a fix that never landed — so it must
  // be SAID, not swallowed.
  console.log(`⚠️ resolve but did NOT LAND (not an ancestor of HEAD)   ${notMerged.length}`);
  for (const n of notMerged) {
    console.log(`   ${n.sha}   on card(s) ${n.cards.join(', ')}   [${n.tree}]`);
  }

  // ⚠️ NAME THE POPULATION THIS CANNOT SEE — and name it CURRENTLY. The previous
  // wording disclosed only the unfetched-commit case and was silent on the tree
  // case, which is worse than saying nothing: a reader who has met that sentence
  // believes they have been told the caveat.
  console.log('\ncovers   : every sha, against the objects in EACH tree listed above, and');
  console.log('           whether it is an ancestor of that tree\'s HEAD');
  console.log('blindTo  : a tree not listed above, and a real commit not yet fetched into any');
  console.log('           of them. Unresolvable means UNVERIFIABLE FROM THESE TREES, not');
  console.log('           fabricated — add --repo <path> or fetch before calling a line above');
  console.log('           an invention. NOT-LANDED is a report, not a defect: it means the');
  console.log('           commit exists and is not on that tree\'s main line.');

  if (bad.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
