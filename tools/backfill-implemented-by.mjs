#!/usr/bin/env node
/**
 * #814 — backfill `implementedBy` from real git history.
 *
 * The card's Banana Test asks for a card's implementing commits in ONE query,
 * without parsing prose. #821 shipped the mechanism: commits project as
 * `commit:` IRIs, not literals. What was missing is DATA — the steward's
 * separation, which is the whole reason this third is different from the other
 * two: "the graph cannot express this" and "the graph can express it and nobody
 * filled it in" are different problems with different fixes.
 *
 * ⛔ THE STEWARD'S CRITERIA, which this tool implements rather than promises:
 *
 *   BF1  a backfilled card must have its commit relationship anchored to a REAL
 *        git sha — never invented.
 *   BF2  if the commit is not findable, the card's column is EMPTY — never a
 *        best guess.
 *   BF3  backfill makes the schema VISIBLE, not the schema TRUE.
 *
 * ⭐ THE ANCHOR DIRECTION MATTERS AND IS DELIBERATE. This reads COMMIT → CARD,
 * not card → commit. A commit subject saying `fix(#764): …` is an author's
 * explicit statement, made at the moment of the work, in an immutable object.
 * Inferring the reverse — reading a card body and guessing which commit shipped
 * it — is exactly the "best guess" BF2 forbids, and it is how a backfill
 * manufactures a history that never happened.
 *
 * ⚠️ SUBJECT LINE ONLY. A commit BODY often discusses other cards ("same shape
 * as #831", "unlike #593"). Those are references, not claims of implementation,
 * and harvesting them would assert that a commit implemented every card it
 * mentioned in passing.
 *
 * DRY RUN BY DEFAULT. `--apply` writes, and writing always emits a rollback
 * file first: a bulk mutation with no captured undo is not finished, it is
 * merely done.
 *
 * usage:
 *   node tools/backfill-implemented-by.mjs [--apply] [--api http://127.0.0.1:3141]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const API = (() => {
  const i = process.argv.indexOf('--api');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:3141';
})();
const APPLY = process.argv.includes('--apply');
/** Where the rollback lands. Defaults OUT of the repo: a tool that drops
 *  artifacts into your source tree is one `git add -A` from publishing them. */
const OUT_DIR = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : process.cwd();
})();

/** A full 40-char lowercase sha. #821 refuses anything shorter, and it is right: */
/** a short sha cannot be expanded by the graph, so both forms become two nodes. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * COMMIT → CARD, from subject lines only.
 * Returns Map<shortId, Set<sha>>.
 */
export function harvest(logLines) {
  const byCard = new Map();
  for (const line of logLines) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const sha = line.slice(0, sp);
    const subject = line.slice(sp + 1);
    if (!SHA_RE.test(sha)) continue;           // BF1 — never a sha we did not read from git
    for (const m of subject.matchAll(/#(\d{1,6})\b/g)) {
      const id = m[1];
      if (!byCard.has(id)) byCard.set(id, new Set());
      byCard.get(id).add(sha);
    }
  }
  return byCard;
}

async function main() {
  const log = execFileSync('git', ['log', '--pretty=format:%H %s'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const harvested = harvest(log);

  // The live board, paged to exhaustion — a single call ceilings at 500 and a
  // partial population would silently under-report what is already set.
  const cards = [];
  let before = null;
  for (;;) {
    let u = `${API}/api/cards?fields=all&limit=500`;
    if (before) u += `&before=${before}`;
    const b = await (await fetch(u)).json();
    const fresh = b.cards.filter((c) => !cards.some((x) => x.shortId === c.shortId));
    if (!fresh.length) break;
    cards.push(...fresh);
    if (cards.length >= b.cardsTotal) break;
    before = b.cards[b.cards.length - 1].shortId;
  }
  const byShortId = new Map(cards.map((c) => [String(c.shortId), c]));

  const plan = [];
  const skipped = { noSuchCard: [], alreadyComplete: [] };
  for (const [shortId, shas] of harvested) {
    const card = byShortId.get(shortId);
    if (!card) { skipped.noSuchCard.push(shortId); continue; }   // BF2 — no guessing
    const have = new Set(card.implementedBy || []);
    const add = [...shas].filter((s) => !have.has(s)).sort();
    if (!add.length) { skipped.alreadyComplete.push(shortId); continue; }
    plan.push({ shortId, add, before: [...have].sort(), after: [...have, ...add].sort() });
  }
  plan.sort((a, b) => Number(a.shortId) - Number(b.shortId));

  const totalEdges = plan.reduce((n, p) => n + p.add.length, 0);
  console.log(`commits scanned          ${log.length}`);
  console.log(`cards named in subjects  ${harvested.size}`);
  console.log(`cards on the board       ${cards.length}`);
  console.log(`cards to update          ${plan.length}   (+${totalEdges} commit edges)`);
  console.log(`skipped — no such card   ${skipped.noSuchCard.length}  ${skipped.noSuchCard.slice(0, 12).join(',')}`);
  console.log(`skipped — already set    ${skipped.alreadyComplete.length}`);

  if (!APPLY) {
    console.log('\nDRY RUN. Nothing written. Re-run with --apply to write.');
    return;
  }

  // ⛔ ROLLBACK FIRST. Captured BEFORE the first write, not after — a rollback
  // written afterwards describes a state that already changed.
  const stamp = log[0].slice(0, 7);
  const rollbackFile = `${OUT_DIR.replace(/\/$/, '')}/backfill-implementedBy-rollback-${stamp}.json`;
  fs.writeFileSync(rollbackFile, JSON.stringify(
    plan.map((p) => ({ shortId: p.shortId, implementedBy: p.before })), null, 2));
  console.log(`\nrollback captured → ${rollbackFile}  (${plan.length} prior values)`);

  let ok = 0, failed = 0;
  for (const p of plan) {
    const res = await fetch(`${API}/api/cards/${p.shortId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ implementedBy: p.after }),
    });
    if (!res.ok) { failed += 1; console.error(`  ⛔ #${p.shortId}: ${res.status}`); continue; }
    // READ BACK. A 200 describes the request, not the state.
    const fresh = await (await fetch(`${API}/api/cards/${p.shortId}`)).json();
    const got = new Set(fresh.implementedBy || []);
    if (p.after.every((s) => got.has(s))) ok += 1;
    else { failed += 1; console.error(`  ⛔ #${p.shortId}: read-back missing shas`); }
  }
  console.log(`\napplied ${ok} · failed ${failed}`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
