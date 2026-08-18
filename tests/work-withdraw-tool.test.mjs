/**
 * #886 fix 2 — `work_withdraw`: the declarer can close her own window.
 *
 * ⛔ THE DEFECT WAS A REFUSAL NAMING A REMEDY THAT DID NOT EXIST. The work
 * gate ended every refusal with "Wait for the grant, or withdraw the bid." The
 * surface offered declare · bid · nobid · contest · grant · list. There was no
 * withdraw, so the only two things a blocked seat could actually do were wait
 * out the clock or route around the rail — and a real seat, reading that
 * sentence, chose a third: she granted the work to herself, which recorded a
 * settlement that never happened.
 *
 * ⭐ THE FIX IS ALMOST ENTIRELY ABSENCE OF CODE. `withdraw()` has existed in
 * core/work-auction.mjs the whole time, with its guards written and its
 * terminal state (`WITHDRAWN`) already folded by `stateAt`. What was missing
 * was a tool and a registration — the protocol could express the remedy, and no
 * caller could reach it.
 *
 * ⚠️ Which is the shape worth remembering: the refusal message was not
 * describing a feature someone forgot to build. It was describing one that WAS
 * built and never wired to a surface. "The remedy does not exist" and "the
 * remedy is unreachable" read identically from the caller's side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workDeclare, workWithdraw, workList } from '../core/work-tools.mjs';
import { STATES } from '../core/work-auction.mjs';

const T0 = '2026-08-18T12:00:00.000Z';
const T1 = '2026-08-18T12:05:00.000Z';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'work-withdraw-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const openWindow = (dir) => workDeclare({
  dir, id: 'w-1', by: 'ada', card: 881, required: ['grace'], replyByMinutes: 60, now: T0,
});

test('#886 the declarer can withdraw her own open window', () => {
  withStore((dir) => {
    openWindow(dir);
    const r = workWithdraw({ dir, id: 'w-1', by: 'ada', now: T1 });
    assert.equal(r.state, STATES.WITHDRAWN, JSON.stringify(r));
  });
});

test('#886 a withdrawn window no longer counts as open — the gate stops refusing', () => {
  // ⭐ THE POINT OF THE TOOL. If withdraw recorded a transition that left the
  // window in `open`, the remedy the refusal names would still not work, and
  // the message would be lying in a new way.
  withStore((dir) => {
    openWindow(dir);
    assert.equal(workList({ dir, now: T1 }).open.length, 1, 'control: it is open first');

    workWithdraw({ dir, id: 'w-1', by: 'ada', now: T1 });
    const after = workList({ dir, now: T1 });
    assert.equal(after.open.length, 0, 'withdrawn means the window is gone from `open`');
    assert.equal(after.settled.length, 1, 'and it is still in the record — nothing is erased');
  });
});

test('#886 a seat who did NOT declare it cannot withdraw it', () => {
  // ⛔ Otherwise "withdraw" is a way to cancel someone else's claim on work,
  // which is the opposite of what a mutex is for.
  withStore((dir) => {
    openWindow(dir);
    assert.throws(() => workWithdraw({ dir, id: 'w-1', by: 'grace', now: T1 }),
      /did not declare/);
    assert.equal(workList({ dir, now: T1 }).open.length, 1, 'and the window survives the attempt');
  });
});

test('#886 withdraw refuses an unknown field — same `only()` contract as its siblings', () => {
  withStore((dir) => {
    openWindow(dir);
    assert.throws(() => workWithdraw({ dir, id: 'w-1', by: 'ada', to: 'grace', now: T1 }));
  });
});

test('#886 withdraw requires a clock, like every other tool on this surface', () => {
  withStore((dir) => {
    openWindow(dir);
    assert.throws(() => workWithdraw({ dir, id: 'w-1', by: 'ada' }), /now/);
  });
});
