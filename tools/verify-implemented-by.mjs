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
 * exits 1 if any sha does not resolve.
 */

import { execFileSync } from 'node:child_process';

const API = (() => {
  const i = process.argv.indexOf('--api');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:3141';
})();

/** Does this sha name an object in THIS repo? */
export function resolves(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
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

  const bad = [];
  for (const [sha, cardIds] of seen) {
    if (!resolves(sha)) bad.push({ sha, cards: cardIds });
  }

  console.log(`cards carrying implementedBy   ${cards.length}`);
  console.log(`distinct shas referenced       ${seen.size}`);
  console.log(`⛔ shas that DO NOT RESOLVE     ${bad.length}`);
  // ⭐ A LIST, NOT A COUNT. "3 unresolvable" is a number nobody can act on; the
  // shas with the cards carrying them are a repair queue.
  for (const b of bad) {
    console.log(`   ${b.sha}   on card(s) ${b.cards.join(', ')}`);
  }

  // ⚠️ NAME THE POPULATION THIS CANNOT SEE. A sha may be real and simply absent
  // from THIS clone — an unfetched branch, a commit that only exists on a peer's
  // machine. "Does not resolve here" is not "was invented", and reporting it as
  // the latter would be the confident-wrong-diagnosis this board keeps finding.
  console.log('\ncovers   : shas checked against the objects in THIS repository');
  console.log('blindTo  : a real commit that has not been fetched into this clone resolves as');
  console.log('           MISSING here. Unresolvable means UNVERIFIABLE FROM HERE, not fabricated —');
  console.log('           run `git fetch --all` before treating any line above as an invention.');

  if (bad.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
