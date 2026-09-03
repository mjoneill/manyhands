/**
 * #1020 — THE SEAM, end to end: stamp file on disk → GET /api/ready.
 *
 * The unit tests either side of this one both pass on a version where the two
 * halves are never introduced. That is the failure this room keeps finding —
 * `projectActivities` and `projectLabelAliases` each existed, were unit-tested,
 * and had no caller (#725, and again in the same file); the queue's own
 * `implementedBy` blindness (#1020) is a third. A wiring test is the only one
 * that can tell "the code exists" from "the code runs".
 *
 * ⚠️ THE FAIL-OPEN DIRECTION IS ASSERTED, not assumed: with no stamp, an
 * unreadable stamp, or a stamp predating the field, the queue must be exactly
 * what it was. The cost of marking wrongly is a card that leaves the queue and
 * stops being offered — hidden work, which is worse than the defect this card
 * fixes, because today's error is at least visible when you open the card.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const SHIPPED = 'a'.repeat(40);
const UNSHIPPED = 'c'.repeat(40);

const mk = async (baseUrl, title, extra) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', column: 'backlog', ...extra }),
  });
  return r.json();
};

const ready = async (baseUrl) => (await (await fetch(`${baseUrl}/api/ready?limit=50`)).json()).ready;
const reasonsFor = (rows, shortId) => (rows.find((r) => r.shortId === shortId) || {}).reasons;

const stamp = (extra) => JSON.stringify({
  resolvedAt: '2026-09-03T00:00:00.000Z', deployedSha: 'd'.repeat(40), status: 'measured',
  population: 'implementedBy ∪ acceptance[].evidence', enumerated: 2, checked: 2,
  roots: [{ root: '/pub', status: 'read', resolved: 2 }],
  // BOTH shas resolve — the stamp can see them in a root. Only one is in the
  // deployed history, which is the entire distinction this card turns on.
  resolvedBy: { [SHIPPED]: ['/pub'], [UNSHIPPED]: ['/pub'] }, unresolved: [],
  ...extra,
});

test('#1020 WIRING — a stamp with inDeployed reaches /api/ready and marks the shipped card', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-shipped-'));
  const file = path.join(tmp, 'sha-integrity.json');
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_SHA_INTEGRITY_FILE: file } });
  try {
    const shipped = await mk(srv.baseUrl, 'already in production', { implementedBy: [SHIPPED] });
    const open = await mk(srv.baseUrl, 'resolves but never merged', { implementedBy: [UNSHIPPED] });
    fs.writeFileSync(file, stamp({ inDeployed: { [SHIPPED]: ['/pub'] } }));

    const rows = await ready(srv.baseUrl);
    const a = reasonsFor(rows, shipped.shortId);
    assert.ok(a, 'the card STAYS in the queue — a relabel, not a filter');
    assert.ok(a.some((r) => r.startsWith(`shipped-unverified:${SHIPPED}`)),
      `expected shipped-unverified with the sha, got ${JSON.stringify(a)}`);

    assert.deepEqual(reasonsFor(rows, open.shortId), ['column:backlog', 'unclaimed', 'no-open-blockers'],
      '#1029\'s shape: it RESOLVES in a root and is not in the deployed history. If this ever reads '
      + 'shipped, the wiring is keyed on resolvedBy and is hiding unstarted work');
  } finally { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('#1020 ⛔ NO stamp file configured ⇒ the queue is untouched', async () => {
  const srv = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await mk(srv.baseUrl, 'has a commit, no stamp exists', { implementedBy: [SHIPPED] });
    assert.deepEqual(reasonsFor(await ready(srv.baseUrl), c.shortId),
      ['column:backlog', 'unclaimed', 'no-open-blockers'],
      'without the deploy having spoken, nothing is claimed about what shipped');
  } finally { await srv.stop(); }
});

test('#1020 ⛔ an OLD stamp (no inDeployed field) marks nothing — and does not throw', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-shipped-old-'));
  const file = path.join(tmp, 'sha-integrity.json');
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_SHA_INTEGRITY_FILE: file } });
  try {
    const c = await mk(srv.baseUrl, 'stamped before the field existed', { implementedBy: [SHIPPED] });
    fs.writeFileSync(file, stamp({}));   // pre-#1020 stamp: resolvedBy only
    assert.deepEqual(reasonsFor(await ready(srv.baseUrl), c.shortId),
      ['column:backlog', 'unclaimed', 'no-open-blockers'],
      'a deploy that has not re-stamped yet must not have its resolvedBy read as ancestry — '
      + 'this is the upgrade window, and it is exactly when the wrong answer would ship');
  } finally { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('#1020 ⛔ an UNREADABLE stamp marks nothing and the queue still answers', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-shipped-bad-'));
  const file = path.join(tmp, 'sha-integrity.json');
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_SHA_INTEGRITY_FILE: file } });
  try {
    const c = await mk(srv.baseUrl, 'stamp is corrupt', { implementedBy: [SHIPPED] });
    fs.writeFileSync(file, '{ this is not json');
    const rows = await ready(srv.baseUrl);
    assert.ok(Array.isArray(rows), 'the queue must still answer — a broken stamp is not an outage');
    assert.deepEqual(reasonsFor(rows, c.shortId), ['column:backlog', 'unclaimed', 'no-open-blockers']);
  } finally { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
