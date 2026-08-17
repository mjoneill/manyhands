/**
 * #824 — deterministic board linter. Zero tokens, no model, no inference.
 *
 * It compares two facts the system already holds — the commits on a branch, and
 * the shas cards claim via `implementedBy` — and states the difference.
 *
 * ⭐ ITS OBSERVATION POINT IS OUTSIDE THE BOARD, which is the only reason it can
 * see anything. "Work happened that no card claims" leaves NO board event: the
 * evidence is an absence, and an absence emits nothing.
 *
 * ⛔ OUTPUT IS A PUBLIC UNKNOWN, NEVER AN ACCUSATION.
 *      "I found an unattributed commit: 31df3f5."   ✅ what this supports
 *      "You worked without a card."                  ⛔ what it cannot support
 *   An unlinked commit is evidence of missing ATTRIBUTION, not proof of uncarded
 *   work. A commit can be perfectly carded and simply unlinked — five of
 *   2026-08-17's were, for an hour, until they were linked by hand.
 *
 * ═══ WHY TWO TIERS, WHICH IS THE WHOLE DESIGN ═══
 *
 * Measured on main at 291ed14: 239 commits, 79 with no card claiming them.
 * Emitting 79 findings would satisfy the card's own definition of a broken
 * check — "a rule that always fires trains the room to dismiss the instrument
 * inside a week, taking the working rules down with it." And it would be
 * DISHONEST: an untagged, unlinked commit is genuinely ambiguous, so a finding
 * against it is unfalsifiable by construction.
 *
 *   TIER A  tagged `type(#N)` AND unlinked   → a FINDING. The author declared a
 *                                              card; the graph disagrees. Both
 *                                              facts are structural, and it is
 *                                              actionable by one PATCH.
 *   TIER B  no tag, unlinked                 → a COUNT ONLY, never per-commit.
 *                                              Real signal in aggregate, no
 *                                              defensible claim per item.
 *
 * ⇒ Tier A on the same corpus: ONE finding. That is a check that can be
 *   satisfied, which is the bar this card sets.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
 * No prose reading. No judgement about what KIND of work a commit is. No
 * "not graph native" check — irreducibly semantic. No deploy-without-review:
 * impossible until Review is a typed artifact (#814), and until then it would
 * fire on every deploy forever.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A conventional-commit tag in SUBJECT-LEAD position — the author DECLARING
 *  "this commit implements N". A `#N` anywhere else in the subject is a
 *  mention, not a declaration, and must never become an edge. */
const TAG = /^[a-z]+\(([^)]*#[\d][^)]*)\)/;

/**
 * Card numbers DECLARED by a subject-lead tag: only `#`-prefixed numbers.
 *
 * ⛔ NOT bare digits inside the tag. Found by running this against real history:
 * `feat(#661-F1)` means card #661, phase F1 — a bare-digit reader turns that
 * into "#661 and #1" and reports a card that was never named. That is this
 * repo's recurring defect in miniature: a diagnostic naming the right thing
 * with the wrong detail, which costs the reader more than silence would.
 *
 * ⚠️ It also means `fix(#805/6)` yields ['805'] — the `/6` shorthand for #806
 * is NOT expanded. Under-reading is deliberate: the tool reports what an author
 * literally wrote and leaves the shorthand for a human, because inventing #806
 * from `/6` is a guess, and a confident guess is the failure mode that makes a
 * graph untrustworthy. Missing, never wrong.
 */
export function tagCards(subject) {
  const m = TAG.exec(subject || '');
  return m ? (m[1].match(/#(\d+)/g) || []).map((s) => s.slice(1)) : [];
}

/** Commits reachable from `ref`, newest first. */
export function readCommits(ref = 'main', { cwd, since } = {}) {
  const args = ['log', '--format=%H%x1f%cI%x1f%s', ref];
  if (since) args.push(`--since=${since}`);
  const out = execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  return out ? out.split('\n').map((l) => {
    const [sha, date, subject] = l.split('\x1f');
    return { sha, date, subject };
  }) : [];
}

/** Shas any card claims. Accepts the /api/cards payload shape. */
export function claimedShas(cards) {
  return new Set(cards.flatMap((c) => c.implementedBy || []));
}

/**
 * A seat can silence a check without escalation (release condition 4).
 * One sha per line, `#` comments allowed. Silencing is RECORDED, not hidden:
 * the report always states how many were suppressed and by which file, so a
 * growing ignore list is itself visible.
 */
export function readIgnores(file) {
  if (!file || !fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter(Boolean),
  );
}

/**
 * The check. Returns findings + counts; never throws on ambiguity, never
 * decides anything a human should decide.
 */
export function lintUnattributedCommits({ commits, cards, ignores = new Set() }) {
  const claimed = claimedShas(cards);
  const findings = [];
  let untaggedUnlinked = 0;
  let suppressed = 0;

  for (const c of commits) {
    if (claimed.has(c.sha)) continue;
    if (ignores.has(c.sha)) { suppressed++; continue; }
    const cards_ = tagCards(c.subject);
    if (cards_.length === 0) { untaggedUnlinked++; continue; }
    findings.push({
      check: 'unattributed-commit',
      sha: c.sha,
      date: c.date,
      subject: c.subject,
      declaredCards: cards_,
      // Every output cites the artifacts it compared (release condition 1).
      // An uncited finding is invented process.
      compared: {
        commitFrom: 'git log',
        claimFrom: 'card.implementedBy via /api/cards',
        claim: 'this commit declares a card in its tag; no card claims this sha',
      },
    });
  }

  return {
    findings,
    tierBCount: untaggedUnlinked,
    suppressed,
    scanned: commits.length,
    linked: commits.length - findings.length - untaggedUnlinked - suppressed,
  };
}

/** Human-readable report. Deliberately states UNKNOWNs, never accusations. */
export function render(result, { ignoreFile } = {}) {
  const L = [];
  L.push(`board-lint · unattributed-commit`);
  L.push(`  scanned ${result.scanned} commits · ${result.linked} linked to a card`);
  L.push('');
  if (!result.findings.length) {
    L.push('  no findings — every commit declaring a card is linked to one.');
  } else {
    L.push(`  ${result.findings.length} UNKNOWN(S) — a commit declares a card, and no card claims it:`);
    for (const f of result.findings) {
      L.push(`    ${f.sha.slice(0, 8)}  ${f.date.slice(0, 16)}  tag names #${f.declaredCards.join(', #')}`);
      L.push(`      ${f.subject.slice(0, 72)}`);
    }
    L.push('');
    L.push('  ⇒ This is missing ATTRIBUTION, not proof of uncarded work. Resolve by');
    L.push('    linking the sha, or by silencing it if the tag was a mention.');
  }
  L.push('');
  L.push(`  tier B (no tag, unlinked): ${result.tierBCount} — counted, not itemised.`);
  L.push('    Individually unfalsifiable: a commit can be carded and simply unlinked.');
  L.push('    Itemising these would fire forever and train the room to ignore this tool.');
  if (result.suppressed) L.push(`  suppressed by ${ignoreFile}: ${result.suppressed}`);
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const api = process.env.SCRUM_API || 'http://localhost:3141';
  const ref = process.argv[2] || 'main';
  const ignoreFile = process.env.BOARD_LINT_IGNORE
    || path.join(process.cwd(), '.board-lint-ignore');
  const cards = await (await fetch(`${api}/api/cards`)).json();
  const result = lintUnattributedCommits({
    commits: readCommits(ref, { cwd: process.cwd() }),
    cards,
    ignores: readIgnores(ignoreFile),
  });
  console.log(render(result, { ignoreFile }));
  // Exit 0 regardless: this reports UNKNOWNs, it does not gate anything.
  // A linter that fails a build is a rule; this is an observation.
}
