/**
 * #1020 — RESOLUTION IS NOT ANCESTRY, and the stamp must carry the difference.
 *
 * `board_ready` offers cards whose commits are already in production. The fix
 * needs one fact: is this card's implementing commit an ancestor of the sha
 * production is serving? The stamp already resolves every board sha against
 * every root (#1008), and the obvious move is to reuse `resolvedBy` — a sha
 * found in a root is shipped.
 *
 * ⛔⛔ THAT IS WRONG, AND IT WAS MEASURED WRONG BEFORE THIS TEST EXISTED.
 * On prod 2026-09-03 (deployedSha 18b28908a): 381 shas in `resolvedBy`, of
 * which 10 are NOT ancestors of the deployed sha. A commit lives in a clone
 * on a branch, an abandoned experiment, a local integration candidate — it
 * exists, `git cat-file` says so, and it never reached production.
 *
 * ⇒ Seven cards carry such a sha and #1029 IS ONE OF THEM, in backlog, offered
 * as ready today. Under resolvedBy-membership #1029 reads "shipped-unverified"
 * and leaves the queue — REAL UNSTARTED WORK HIDDEN BY THE FIX MEANT TO REVEAL
 * HIDDEN WORK. That is strictly worse than the defect, because today's error is
 * visible the moment you open the card.
 *
 * ⭐ So the predicate is ANCESTRY, computed where the git roots are. The reader
 * cannot compute it: production has no `.git` beside the export, which is the
 * whole reason #1008's stamp exists. A version that computed it in the reader
 * would pass every test on a dev box and be structurally blind in production.
 *
 * ⚠️ `inDeployed` is per (sha, root) and true only for the root that both
 * RESOLVED it and has it as an ancestor. Two roots can hold the same sha with
 * only one of them having it merged; asking "any root" would re-import the
 * defect one level up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyShaIntegrityAcrossRoots } from '../core/sha-integrity.mjs';

const A = 'a'.repeat(40);   // resolved AND an ancestor of deployed  → shipped
const B = 'b'.repeat(40);   // resolved, NOT an ancestor             → #1029's shape
const C = 'c'.repeat(40);   // resolved in NO root                   → unresolvable
const D = 'd'.repeat(40);   // the deployed sha itself
const DEPLOYED = D;

const board = () => ({
  cards: [
    { shortId: 1, implementedBy: [A] },
    { shortId: 2, implementedBy: [B] },
    { shortId: 3, implementedBy: [C] },
  ],
});

/** A root that knows which shas it holds and which are ancestors of a given sha. */
const root = (name, live, ancestors, { error, ancestorsError } = {}) => ({
  root: name,
  resolve: async () => { if (error) throw new Error(error); return new Set(live); },
  ancestors: async (of) => {
    if (ancestorsError) throw new Error(ancestorsError);
    return new Set((ancestors || {})[of] || []);
  },
});

test('#1020 a sha RESOLVED and an ANCESTOR of the deployed sha is marked inDeployed', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', [A, B], { [DEPLOYED]: [A] })],
    deployedSha: DEPLOYED,
  });
  assert.equal(r.status, 'measured');
  assert.deepEqual(r.inDeployed, { [A]: ['/pub'] },
    'only A is in the deployed history; the value names WHICH root vouched for it');
});

test('#1020 ⛔ THE DISCRIMINATOR — a sha that RESOLVES but is NOT an ancestor is NOT inDeployed', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', [A, B], { [DEPLOYED]: [A] })],
    deployedSha: DEPLOYED,
  });
  assert.deepEqual(r.resolvedBy[B], ['/pub'], 'B genuinely resolves — the root has the object');
  assert.ok(!(B in (r.inDeployed || {})),
    'B must NOT read as shipped. This is #1029 on the live board: resolved in a root, never merged. '
    + 'A fix keyed on resolvedBy would take it out of the queue and hide unstarted work.');
});

test('#1020 ⛔ an UNRESOLVABLE sha is neither resolved nor inDeployed', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', [A, B], { [DEPLOYED]: [A] })],
    deployedSha: DEPLOYED,
  });
  assert.ok(!(C in r.resolvedBy), 'C is in no root');
  assert.ok(!(C in (r.inDeployed || {})),
    'anti-vacuity: a sha that resolves nowhere must not fall through to "shipped" — '
    + 'a fabricated sha would otherwise close its own card');
  assert.deepEqual(r.unresolved, [{ sha: C, cards: [3] }]);
});

test('#1020 ⭐ inDeployed is per (sha, root): the root that RESOLVED it must be the one with it merged', async () => {
  // /pub holds A but has NOT merged it; /ops holds A and has. Only /ops vouches.
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', [A], { [DEPLOYED]: [] }), root('/ops', [A], { [DEPLOYED]: [A] })],
    deployedSha: DEPLOYED,
  });
  assert.deepEqual(r.resolvedBy[A].sort(), ['/ops', '/pub'], 'both roots hold the object');
  assert.deepEqual(r.inDeployed, { [A]: ['/ops'] },
    'only the root where it is an ancestor. Asking "any root" would re-import the defect one level up');
});

test('#1020 ⛔ NO deployedSha ⇒ NO inDeployed claim at all, and the stamp says why', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', [A, B], { [DEPLOYED]: [A] })],
  });
  assert.equal(r.status, 'measured', 'resolution still works without a deployed sha');
  assert.ok(r.inDeployed === undefined,
    'ABSENT, not empty. An empty map reads as "nothing is shipped" and would flip every card back '
    + 'to plain ready silently; absent means the question was never asked.');
  assert.match(r.ancestryBlindTo || '', /deployed/i,
    'the stamp must SAY that ancestry was not computed — a missing field with no explanation is the '
    + 'shape this room keeps mistaking for a measurement');
});

test('#1020 ⛔ a root whose ancestor walk FAILS resolves normally and vouches for nothing', async () => {
  const r = await verifyShaIntegrityAcrossRoots(board(), {
    roots: [root('/pub', [A, B], null, { ancestorsError: 'fatal: bad object' })],
    deployedSha: DEPLOYED,
  });
  assert.deepEqual(r.resolvedBy[A], ['/pub'], 'resolution is unaffected by an ancestry failure');
  assert.ok(!(A in (r.inDeployed || {})),
    'fail CLOSED: a root that could not answer must not vouch. The failure direction that matters is '
    + 'hiding work, so an unknown answer stays plain ready');
  assert.match(r.ancestryBlindTo || '', /\/pub/,
    'and it must be NAMED — a silently degraded root is the #1146 lesson');
});

test('#1020 a root with no ancestors() at all is tolerated (older resolver, no crash)', async () => {
  const legacy = { root: '/legacy', resolve: async () => new Set([A]) };
  const r = await verifyShaIntegrityAcrossRoots(board(), { roots: [legacy], deployedSha: DEPLOYED });
  assert.equal(r.status, 'measured');
  assert.ok(!(A in (r.inDeployed || {})), 'cannot vouch without being asked');
  assert.match(r.ancestryBlindTo || '', /\/legacy/);
});
