/**
 * #1379 (#915 slice 2) — "who holds role X" has two answers on the board: the
 * OPEN seat declaration carrying `scrum:role` (#915, the graph) and the
 * roster's `roles[X]` (#1368's interim, a Settings select). One seam decides:
 * the declaration wins, the roster is the fallback, and the answer says which
 * source spoke so a disagreement is visible rather than silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRole, resolveRoleHolder } from '../core/roles.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

// A fetch that answers the two endpoints from fixtures — the pure half.
const fakeFetch = ({ seats = [], roster = {} } = {}) => async (url) => {
  const u = String(url);
  if (u.endsWith('/api/seats/state')) return { ok: true, json: async () => ({ seats }) };
  if (u.endsWith('/api/roster')) return { ok: true, json: async () => ({ seats: {}, roles: roster }) };
  return { ok: false, json: async () => ({}) };
};

test('#1379 the OPEN declaration wins and names its source; the roster is the fallback; neither → null', async () => {
  const decl = await resolveRole('po', { fetchImpl: fakeFetch({ seats: [{ seat: 'ada', mode: 'available', role: 'po' }], roster: {} }) });
  assert.deepEqual(decl, { seat: 'ada', source: 'declaration', declaration: 'ada', roster: null });

  const roster = await resolveRole('po', { fetchImpl: fakeFetch({ seats: [{ seat: 'ada', mode: 'unknown' }], roster: { po: 'bo' } }) });
  assert.deepEqual(roster, { seat: 'bo', source: 'roster', declaration: null, roster: 'bo' });

  const none = await resolveRole('po', { fetchImpl: fakeFetch() });
  assert.deepEqual(none, { seat: null, source: null, declaration: null, roster: null });

  // an EXPIRED or UNKNOWN row is not a holder even if the field lingers
  const expired = await resolveRole('po', { fetchImpl: fakeFetch({ seats: [{ seat: 'ada', mode: 'unknown', role: 'po', expired: true }], roster: {} }) });
  assert.equal(expired.declaration, null, 'an UNKNOWN row does not hold a role');
});

test('#1379 DISAGREEMENT is visible: both set, different → the declaration wins and the answer carries both', async () => {
  const r = await resolveRole('po', { fetchImpl: fakeFetch({ seats: [{ seat: 'ada', mode: 'resting', role: 'po' }], roster: { po: 'bo' } }) });
  assert.equal(r.seat, 'ada');
  assert.equal(r.source, 'declaration');
  assert.equal(r.roster, 'bo', 'the roster\'s different answer rides along — a reader can see the two disagree');
  // the string-returning seam the pages already call keeps its shape and follows the same rule
  assert.equal(await resolveRoleHolder('po', { fetchImpl: fakeFetch({ seats: [{ seat: 'ada', mode: 'resting', role: 'po' }], roster: { po: 'bo' } }) }), 'ada');
});

test('#1379 a dead seats endpoint does not lose the roster answer', async () => {
  const f = async (url) => (String(url).endsWith('/api/roster') ? { ok: true, json: async () => ({ roles: { po: 'bo' } }) } : { ok: false, json: async () => ({}) });
  assert.deepEqual(await resolveRole('po', { fetchImpl: f }), { seat: 'bo', source: 'roster', declaration: null, roster: 'bo' });
});

// ── served: a real declaration with a role, against a roster that names someone else ──
test('#1379 SERVED — a live declaration with role po beats a roster that names another seat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-1379-'));
  const rosterFile = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ roles: { po: 'bo' }, seats: { ada: { name: 'Ada' }, bo: { name: 'Bo' } } }));
  const srv = await startRestServer({
    board: makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'a card', column: 'backlog', createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z' }], nextShortId: 2 }),
    env: { SCRUM_ROSTER_FILE: rosterFile },
  });
  try {
    const api = async (m, p, b) => { const r = await fetch(`${srv.baseUrl}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const before = await resolveRole('po', { baseUrl: srv.baseUrl });
    assert.equal(before.source, 'roster', JSON.stringify(before));
    assert.equal(before.seat, 'bo');

    const minted = await api('POST', '/api/roles', { by: 'ada', key: 'po', name: 'Product Owner', definition: 'Owns Planned as the sprint; grooms WHY / WHAT / first move; every resident a full participant.', definedBy: 1 });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const decl = await api('PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(), role: 'po' });
    assert.equal(decl.status, 200, JSON.stringify(decl.body));

    let after;
    for (let i = 0; i < 40; i++) { after = await resolveRole('po', { baseUrl: srv.baseUrl }); if (after.source === 'declaration') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(after.seat, 'ada', JSON.stringify(after));
    assert.equal(after.source, 'declaration');
    assert.equal(after.roster, 'bo', 'and the disagreement is on the answer');
  } finally { await srv.stop(); }
});
