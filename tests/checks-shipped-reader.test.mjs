/**
 * #1020 condition 3 — THE PROXY IS RETIRED WHERE IT IS READ, not only where it
 * is queued.
 *
 * The card's own words: fixing `board_ready` stops the QUEUE offering shipped
 * work; it does not stop a reader counting `column != done` and calling the
 * result "open defects". That is not hypothetical — it happened on
 * 2026-08-24 and the wrong number was published twice.
 *
 * ⛔ SO THE FIRST TWO COMMITS OF THIS CARD DID NOT DISCHARGE IT. `inDeployed`
 * reached `/api/ready` and stopped there: `readShaStamp` never passed it
 * through, so `/api/checks` — where a reader actually looks at sha state —
 * could not see it. The queue got smarter and every human and agent tally
 * stayed wrong, which is precisely the failure the condition names.
 *
 * ⚠️ The surface must say what it MEANS, not only what it holds. `shipped` and
 * `resolvable` are one word apart in English and a whole defect apart here: ten
 * of 381 live shas resolve in a root and are not in the deployed history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { readShaStamp } from '../core/sha-integrity.mjs';

const SHIPPED = 'a'.repeat(40);
const RESOLVED_ONLY = 'c'.repeat(40);

const mk = async (baseUrl, title, extra) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', column: 'backlog', ...extra }),
  });
  return r.json();
};

const stampBody = (extra) => ({
  resolvedAt: '2026-09-03T00:00:00.000Z', deployedSha: 'd'.repeat(40), status: 'measured',
  population: 'implementedBy ∪ acceptance[].evidence', enumerated: 2, checked: 2,
  roots: [{ root: '/pub', status: 'read', resolved: 2 }],
  resolvedBy: { [SHIPPED]: ['/pub'], [RESOLVED_ONLY]: ['/pub'] }, unresolved: [],
  ...extra,
});

test('#1020 c3 — readShaStamp carries inDeployed through, keyed by sha with the cards it is on', () => {
  const board = { cards: [{ shortId: 7, implementedBy: [SHIPPED] }, { shortId: 8, implementedBy: [RESOLVED_ONLY] }] };
  const out = readShaStamp(stampBody({ inDeployed: { [SHIPPED]: ['/pub'] } }), board);

  assert.deepEqual(out.inDeployed, [{ sha: SHIPPED, cards: [7], roots: ['/pub'] }],
    'a reader must be able to go from the sha to the CARDS it closes without another query — '
    + 'the same shape unresolved[] already uses, for the same reason');
  assert.ok(!out.inDeployed.some((r) => r.sha === RESOLVED_ONLY),
    'RESOLVED_ONLY resolves in /pub and is not in the deployed history. If it appears here, the '
    + 'reader surface has re-imported the resolution-is-not-ancestry defect');
});

test('#1020 c3 ⛔ the surface SAYS what shipped means — a word apart from resolvable, a defect apart', () => {
  const board = { cards: [{ shortId: 7, implementedBy: [SHIPPED] }] };
  const out = readShaStamp(stampBody({ inDeployed: { [SHIPPED]: ['/pub'] } }), board);
  assert.match(out.means || '', /inDeployed/,
    'means must name the new field: a counter nobody can interpret is the shape this endpoint was '
    + 'already burned by (#1146)');
  assert.match(out.means || '', /ancestor|history/i,
    'and it must say ANCESTRY, not existence — otherwise the next reader keys on resolvedBy');
});

test('#1020 c3 ⛔ an OLD stamp (no inDeployed) reports ABSENT, never an empty list', () => {
  const board = { cards: [{ shortId: 7, implementedBy: [SHIPPED] }] };
  const out = readShaStamp(stampBody({}), board);
  assert.ok(out.inDeployed === undefined,
    'an empty array reads as "nothing has shipped" — a false negative that would tell a reader every '
    + 'card is still open. Absence means the deploy has not re-stamped yet');
  assert.match(out.blindTo || '', /inDeployed|ancestry/i,
    'and the reader is TOLD why the field is missing, rather than left to infer it');
});

test('#1020 c3 WIRING — /api/checks exposes it, because that is where a reader looks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-shipped-'));
  const file = path.join(tmp, 'sha-integrity.json');
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_SHA_INTEGRITY_FILE: file } });
  try {
    const done = await mk(srv.baseUrl, 'in production', { implementedBy: [SHIPPED] });
    await mk(srv.baseUrl, 'resolves only', { implementedBy: [RESOLVED_ONLY] });
    fs.writeFileSync(file, JSON.stringify(stampBody({ inDeployed: { [SHIPPED]: ['/pub'] } })));

    const s = (await (await fetch(`${srv.baseUrl}/api/checks`)).json()).shaIntegrity;
    assert.deepEqual(s.inDeployed, [{ sha: SHIPPED, cards: [done.shortId], roots: ['/pub'] }],
      'the queue reading this is not enough: a seat tallying open work reads /api/checks, and the '
      + 'first two commits of this card left it blind');
  } finally { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
