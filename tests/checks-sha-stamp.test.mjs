/**
 * #1008 — /api/checks reports the STAMP when SCRUM_SHA_INTEGRITY_FILE names one,
 * and falls back to the live resolver when it does not. The stamp is what makes
 * the check MEASURED in production, where no `.git` exists beside the server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

const mk = async (baseUrl, title, extra) => {
  const r = await fetch(`${baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, createdBy: 'ada', ...extra }) });
  assert.equal(r.status, 201);
  return r.json();
};

test('#1008 ⭐ with a stamp file, shaIntegrity is STAMPED: the fabrication is named, the post-stamp sha is not accused', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-stamp-'));
  const file = path.join(tmp, 'sha-integrity.json');
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_SHA_INTEGRITY_FILE: file } });
  try {
    const real = await mk(srv.baseUrl, 'real', { implementedBy: [A] });
    const fake = await mk(srv.baseUrl, 'fake', { implementedBy: [B] });
    fs.writeFileSync(file, JSON.stringify({
      resolvedAt: '2026-09-03T00:00:00.000Z', deployedSha: 'd'.repeat(40), status: 'measured',
      population: 'implementedBy ∪ acceptance[].evidence', enumerated: 2, checked: 2,
      roots: [{ root: '/pub', status: 'read', resolved: 1 }, { root: '/ops', status: 'read', resolved: 0 }],
      resolvedBy: { [A]: ['/pub'] }, unresolved: [{ sha: B, cards: [fake.shortId] }],
    }));
    const later = await mk(srv.baseUrl, 'written after the stamp', { implementedBy: [C] });
    const s = (await (await fetch(`${srv.baseUrl}/api/checks`)).json()).shaIntegrity;
    assert.equal(s.status, 'stamped');
    assert.equal(s.resolvedAt, '2026-09-03T00:00:00.000Z');
    assert.deepEqual(s.unresolved, [{ sha: B, cards: [fake.shortId] }]);
    assert.deepEqual(s.unverifiedSinceStamp, [{ sha: C, cards: [later.shortId] }]);
    assert.equal(s.enumerated, 3);
    assert.deepEqual(s.roots.map((r) => r.root), ['/pub', '/ops']);
    assert.ok(real);
  } finally {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('#1008 a configured stamp file that is ABSENT is reported as such — not silently the live path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-stamp-'));
  const file = path.join(tmp, 'never-written.json');
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_SHA_INTEGRITY_FILE: file } });
  try {
    await mk(srv.baseUrl, 'real', { implementedBy: [A] });
    const s = (await (await fetch(`${srv.baseUrl}/api/checks`)).json()).shaIntegrity;
    assert.equal(s.status, 'unmeasurable');
    assert.match(s.missingInput, /stamp/i);
    assert.match(s.missingInput, /never-written\.json/);
  } finally {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
