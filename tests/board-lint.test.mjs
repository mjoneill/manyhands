/**
 * #824 — tests for the deterministic board linter.
 *
 * ⚠️ THE FAILURE THIS FILE EXISTS TO PREVENT is not "the linter misses a
 * finding." It is "the linter fires on something it cannot defend." The card is
 * explicit: output is a public UNKNOWN, never an accusation, and a rule that
 * always fires trains the room to dismiss the instrument within a week.
 *
 * So the load-bearing assertions here are the NEGATIVE ones — the cases where
 * the linter must stay silent even though something looks irregular.
 *
 * Pure functions over fixtures: no git, no server, no network. The check is
 * deterministic by construction and the tests hold it to that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintUnattributedCommits, tagCards, claimedShas, render } from '../tools/board-lint.mjs';

const sha = (n) => String(n).repeat(40).slice(0, 40);
const commit = (n, subject, date = '2026-08-17T12:00:00Z') => ({ sha: sha(n), date, subject });

test('#824 — tagCards reads the SUBJECT-LEAD tag only, never a mention', () => {
  assert.deepEqual(tagCards('fix(#841): closes the #823 gap on a third route'), ['841'],
    'a #N in the prose is a mention and must not become an edge');
  assert.deepEqual(tagCards('feat(#802/#804): two cards'), ['802', '804']);
  assert.deepEqual(tagCards('feat(#653+#665): a plus separator'), ['653', '665']);

  // ⛔ Both of these were found by running the tool against real history, and
  // both are the same rule: only a `#`-prefixed number is a DECLARATION.
  assert.deepEqual(tagCards('feat(#661-F1): the claim chip'), ['661'],
    '`F1` is a phase label — a bare-digit reader reports a card #1 nobody named');
  assert.deepEqual(tagCards('fix(#805/6): abbreviated second member'), ['805'],
    '`/6` shorthand for #806 is NOT expanded — a confident guess is the failure mode');
  assert.deepEqual(tagCards('feat: parked — no card declared'), []);
  assert.deepEqual(tagCards('docs: see #530 for context'), [],
    'a card number outside the tag position declares nothing');
  assert.deepEqual(tagCards(''), []);
});

test('#824 — a tagged, unlinked commit is a FINDING, and it cites its sources', () => {
  const r = lintUnattributedCommits({
    commits: [commit(1, 'fix(#805/6): replay carries tending through the same door')],
    cards: [{ shortId: 805, implementedBy: [sha(9)] }],
  });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.deepEqual(f.declaredCards, ['805']);
  assert.ok(f.compared.commitFrom && f.compared.claimFrom,
    'release condition 1: an uncited finding is invented process');
  assert.equal(r.tierBCount, 0);
});

test('#824 — ⛔ a LINKED commit is silent even when its tag names other cards', () => {
  // The negative that matters most: the graph is the authority on whether a
  // commit is attributed. If a card claims the sha, there is nothing unknown
  // about it, whatever its tag says.
  const r = lintUnattributedCommits({
    commits: [commit(1, 'fix(#831): the PATCH loop’s last two silent paths')],
    cards: [{ shortId: 842, implementedBy: [sha(1)] }],   // #842 claims a #831-tagged commit
  });
  assert.equal(r.findings.length, 0,
    'a hand-asserted edge whose tag names a different card is LEGITIMATE and must not fire');
  assert.equal(r.linked, 1);
});

test('#824 — ⛔ untagged unlinked commits are COUNTED, never itemised', () => {
  // 79 of these exist on main. Itemising them would be a rule that always
  // fires — the card names that as the way an instrument dies.
  const r = lintUnattributedCommits({
    commits: [
      commit(1, 'feat: parked — an authored, expiring "not yet"'),
      commit(2, 'chore: bump deps'),
      commit(3, 'docs: rewrite the runbook'),
    ],
    cards: [],
  });
  assert.equal(r.findings.length, 0, 'no defensible per-commit claim exists for these');
  assert.equal(r.tierBCount, 3, 'but the aggregate is real signal and is reported');
});

test('#824 — a seat can silence a finding, and the silencing is itself reported', () => {
  const commits = [commit(1, 'fix(#500): a mention-shaped tag we decided not to link')];
  const open = lintUnattributedCommits({ commits, cards: [] });
  assert.equal(open.findings.length, 1, 'control: it fires when not silenced');

  const quiet = lintUnattributedCommits({ commits, cards: [], ignores: new Set([sha(1)]) });
  assert.equal(quiet.findings.length, 0, 'release condition 4: silenced without escalation');
  assert.equal(quiet.suppressed, 1,
    '…but never hidden — a growing ignore list must stay visible in the report');
});

test('#824 — the report states an UNKNOWN, and never accuses a person', () => {
  const out = render(lintUnattributedCommits({
    commits: [commit(1, 'fix(#805/6): replay carries tending')],
    cards: [],
  }));
  assert.match(out, /UNKNOWN/);
  assert.match(out, /missing ATTRIBUTION, not proof of uncarded work/);
  // The card's own forbidden sentence, in every form the renderer could produce.
  assert.ok(!/\byou\b|\bworked without\b|failed to/i.test(out),
    'the instrument cannot support a claim about a person, so it must not make one');
});

test('#824 — an empty corpus is clean, not vacuous', () => {
  const r = lintUnattributedCommits({ commits: [], cards: [] });
  assert.equal(r.findings.length, 0);
  assert.equal(r.scanned, 0);
  assert.match(render(r), /no findings/);
});

test('#824 — claimedShas flattens every card’s edges', () => {
  assert.deepEqual(
    [...claimedShas([{ implementedBy: [sha(1), sha(2)] }, { implementedBy: [sha(3)] }, {}])].sort(),
    [sha(1), sha(2), sha(3)].sort(),
  );
});
