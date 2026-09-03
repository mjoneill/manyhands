/**
 * #1008 — shaIntegrity resolves at DEPLOY time, against EVERY known root, and the
 * live endpoint reports the STAMP as a dated, root-attributed fact.
 *
 * The live server runs from a read-only export with no `.git` BY DESIGN (#535,
 * #586), so `git cat-file` there is structurally unmeasurable — measured on
 * 2026-08-23 and again on 2026-09-02 (373 enumerated, zero ever resolved). The
 * ruling on #1008 (Option B, check run) keeps the export git-free and moves the
 * resolving to where a clone exists: the deploy. #1112 item 4 refined the shape
 * after a real instance — the board spans TWO repositories (public clone, private
 * ops tree), and nine real commits resolve only in the second — so a single-root
 * fix converts a check that says nothing into one that says something FALSE.
 *
 * Two negative controls, both from #1008's acceptance, both kept here:
 *   · with NO readable root the verdict is still UNMEASURABLE, errors quoted;
 *   · a sha written AFTER the stamp is `unverified since stamp`, never `missing`
 *     — the serving tree lags the push by design, and "missing" is the word this
 *     room built to mean "someone made this up".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyShaIntegrityAcrossRoots, readShaStamp, SHA_POPULATION } from '../core/sha-integrity.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const board = () => ({
  cards: [
    { shortId: 1, implementedBy: [A] },
    { shortId: 2, acceptance: [{ condition: 'x', evidence: [B] }] },
    { shortId: 3, implementedBy: [C] },
  ],
});

const root = (name, live, error) => ({
  root: name,
  resolve: async () => { if (error) throw new Error(error); return new Set(live); },
});

test('#1008 ⭐ a sha is resolved if ANY readable root has it, and the answer says WHICH root', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), { roots: [root('/pub', [A]), root('/ops', [B])] });
  assert.equal(r.status, 'measured');
  assert.equal(r.population, SHA_POPULATION);
  assert.equal(r.enumerated, 3);
  assert.equal(r.checked, 3, 'every enumerated sha was put to at least one readable root');
  assert.deepEqual(r.roots.map((x) => [x.root, x.status, x.resolved]), [['/pub', 'read', 1], ['/ops', 'read', 1]]);
  assert.deepEqual(r.resolvedBy, { [A]: ['/pub'], [B]: ['/ops'] });
  assert.deepEqual(r.unresolved, [{ sha: C, cards: [3] }], 'unresolved means: in NO readable root');
});

test('#1008 one unreadable root does not blind the check — it is NAMED, and the verdict is partial', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), { roots: [root('/pub', [A]), root('/ops', null, 'not a git repository')] });
  assert.equal(r.status, 'measured');
  assert.equal(r.partial, true);
  assert.deepEqual(r.roots[1], { root: '/ops', status: 'unreadable', resolved: 0, error: 'not a git repository' });
  assert.deepEqual(r.unresolved.map((u) => u.sha), [B, C]);
  assert.match(r.blindTo, /\/ops/, 'the reader must be told which root could not answer');
});

test('#1008 ⛔⛔ NEGATIVE CONTROL — with NO readable root the verdict is UNMEASURABLE, never a clean zero', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', null, 'fatal: not a git repository'), root('/ops', null, 'ENOENT')],
  });
  assert.equal(r.status, 'unmeasurable');
  assert.equal('unresolved' in r, false);
  assert.equal(r.enumerated, 3);
  assert.match(r.missingInput, /\/pub.*not a git repository/s);
  assert.match(r.missingInput, /\/ops.*ENOENT/s);
});

test('#1008 an empty root list is a configuration error, not a clean board', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), { roots: [] });
  assert.equal(r.status, 'unmeasurable');
  assert.match(r.missingInput, /no root/i);
});

test('#1008 ⭐ the live endpoint reads the STAMP: dated, root-attributed, population stated', () => {
  const stamp = {
    resolvedAt: '2026-09-03T00:00:00.000Z', deployedSha: 'b186e229f5fac05b1c6be09d3429ea9fd003592a',
    status: 'measured', population: SHA_POPULATION, enumerated: 2, checked: 2,
    roots: [{ root: '/pub', status: 'read', resolved: 1 }, { root: '/ops', status: 'read', resolved: 0 }],
    resolvedBy: { [A]: ['/pub'] },
    unresolved: [{ sha: B, cards: [2] }],
  };
  const r = readShaStamp(stamp, board());
  assert.equal(r.status, 'stamped');
  assert.equal(r.resolvedAt, stamp.resolvedAt);
  assert.equal(r.population, SHA_POPULATION);
  assert.deepEqual(r.roots, stamp.roots);
  assert.deepEqual(r.unresolved, [{ sha: B, cards: [2] }], 'the planted fabrication is NAMED');
  assert.match(r.blindTo, /stamp|deploy/i);
});

test('#1008 ⛔ NEGATIVE CONTROL — a sha written AFTER the stamp is UNVERIFIED SINCE STAMP, never missing', () => {
  const stamp = {
    resolvedAt: '2026-09-03T00:00:00.000Z', status: 'measured', population: SHA_POPULATION,
    enumerated: 2, checked: 2, roots: [{ root: '/pub', status: 'read', resolved: 2 }],
    resolvedBy: { [A]: ['/pub'], [B]: ['/pub'] }, unresolved: [],
  };
  const r = readShaStamp(stamp, board()); // the live board also carries C, which the stamp never saw
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.unverifiedSinceStamp, [{ sha: C, cards: [3] }]);
  assert.equal(r.enumerated, 3, 'the live count, so the stamp cannot pose as current');
  assert.equal(r.checked, 2, 'what the stamp actually resolved');
});

test('#1008 a stamp that was itself unmeasurable reads as unmeasurable — a stamp is not a verdict by existing', () => {
  const stamp = { resolvedAt: '2026-09-03T00:00:00.000Z', status: 'unmeasurable', enumerated: 2, missingInput: 'x: ENOENT' };
  const r = readShaStamp(stamp, board());
  assert.equal(r.status, 'unmeasurable');
  assert.match(r.missingInput, /ENOENT/);
  assert.equal(r.resolvedAt, stamp.resolvedAt);
});

test('#1008 a stamp whose unresolved sha has since LEFT the board is not reported — the finding must be about the live board', () => {
  const stamp = {
    resolvedAt: '2026-09-03T00:00:00.000Z', status: 'measured', population: SHA_POPULATION,
    enumerated: 3, checked: 3, roots: [{ root: '/pub', status: 'read', resolved: 3 }],
    resolvedBy: {}, unresolved: [{ sha: 'd'.repeat(40), cards: [9] }],
  };
  const r = readShaStamp(stamp, board());
  assert.deepEqual(r.unresolved, []);
});

// #1146 — a sha that LEFT the board after the stamp is the only way the
// unresolved count can fall without anything resolving, and the payload said
// nothing about it: `enumerated` (live) drifted below `checked` (at-stamp)
// with no word for the difference. Departures get a name, with members.
test('#1146 ⭐ a sha that left the board since the stamp is NAMED under departedSinceStamp, with the cards it left, and the units are labelled', () => {
  const D = 'd'.repeat(40);
  const stamp = {
    resolvedAt: '2026-09-03T00:00:00.000Z', status: 'measured', population: SHA_POPULATION,
    enumerated: 4, checked: 4, roots: [{ root: '/pub', status: 'read', resolved: 3 }],
    resolvedBy: { [A]: ['/pub'], [B]: ['/pub'], [C]: ['/pub'] }, unresolved: [{ sha: D, cards: [9] }],
  };
  const r = readShaStamp(stamp, board());
  assert.deepEqual(r.unresolved, [], 'a departed sha is not accused');
  assert.deepEqual(r.departedSinceStamp, [{ sha: D, cards: [9] }], 'but it is NAMED, with the cards it was on at stamp time');
  assert.equal(r.checked, 4);
  assert.equal(r.enumerated, 3);
  assert.equal(r.checked, r.enumerated + r.departedSinceStamp.length - r.unverifiedSinceStamp.length,
    'checked (at stamp) = enumerated (live) + departures − arrivals');
  assert.match(r.means || '', /enumerated.*live/i);
  assert.match(r.means || '', /checked.*stamp/i);
});

test('#1146 a RESOLVED sha that left the board is a departure too — the list is about the population, not about failures', () => {
  const stamp = {
    resolvedAt: '2026-09-03T00:00:00.000Z', status: 'measured', population: SHA_POPULATION,
    enumerated: 4, checked: 4, roots: [{ root: '/pub', status: 'read', resolved: 4 }],
    resolvedBy: { [A]: ['/pub'], [B]: ['/pub'], [C]: ['/pub'], ['e'.repeat(40)]: ['/pub'] }, unresolved: [],
  };
  const r = readShaStamp(stamp, board());
  assert.deepEqual(r.departedSinceStamp.map((d) => d.sha), ['e'.repeat(40)]);
  assert.deepEqual(r.departedSinceStamp[0].cards, [], 'the stamp does not record cards for resolved shas; an empty list is honest, not a guess');
});

test('#1146 ⛔ the counter identity is ASSERTED: a stamp whose checked count does not reconcile is flagged, not served as if it did', () => {
  const good = {
    resolvedAt: '2026-09-03T00:00:00.000Z', status: 'measured', population: SHA_POPULATION,
    enumerated: 3, checked: 3, roots: [{ root: '/pub', status: 'read', resolved: 3 }],
    resolvedBy: { [A]: ['/pub'], [B]: ['/pub'], [C]: ['/pub'] }, unresolved: [],
  };
  assert.equal(readShaStamp(good, board()).inconsistent, undefined, 'a reconciling stamp carries no inconsistency');
  const bad = { ...good, checked: 7 };   // a stamp that claims to have checked more than it enumerated or that departed
  const r = readShaStamp(bad, board());
  assert.ok(r.inconsistent, 'the payload must SAY the numbers do not reconcile');
  assert.equal(r.inconsistent.checked, 7);
  assert.equal(r.inconsistent.expectedChecked, 3);
  assert.match(r.inconsistent.means, /do not quote/i);
});
