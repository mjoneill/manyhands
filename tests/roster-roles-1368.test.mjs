/**
 * #1368 — the roster carries ROLES beside seats: `roles.po` names the seat
 * that holds the Product Owner grant, read from the board rather than
 * hardcoded, until #915's Role entity replaces it. Round-trips through
 * writeRoster (which owns the whole file), validates against the seats, and
 * reaches the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoster, loadRosterRoles, writeRoster, validateRoles } from '../core/roster-config.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-roles-')), 'roster.json');
const SEATS = { ada: { name: 'Ada', color: '#7cc4a0' }, bo: { name: 'Bo', color: '#c47c7c' } };

test('#1368 roles round-trip: write seats + roles, read both back; a save without roles KEEPS the roles', () => {
  const file = tmp();
  writeRoster({ seats: SEATS, roles: { po: 'ada' } }, file);
  assert.deepEqual(loadRoster(file), SEATS);
  assert.deepEqual(loadRosterRoles(file), { po: 'ada' });
  // a later save that says nothing about roles must not destroy them (the #619/_README lesson, again)
  writeRoster({ seats: SEATS }, file);
  assert.deepEqual(loadRosterRoles(file), { po: 'ada' });
  // and an explicit empty po clears it
  writeRoster({ seats: SEATS, roles: { po: '' } }, file);
  assert.deepEqual(loadRosterRoles(file), {});
});

test('#1368 validateRoles: po must name a seat in the roster; unknown role keys are refused', () => {
  assert.deepEqual(validateRoles({ po: 'ada' }, SEATS), { po: 'ada' });
  assert.deepEqual(validateRoles({ po: ' ' }, SEATS), {});
  assert.deepEqual(validateRoles(undefined, SEATS), {});
  assert.throws(() => validateRoles({ po: 'zed' }, SEATS), /po.*zed.*not a seat/i);
  assert.throws(() => validateRoles({ sm: 'ada' }, SEATS), /unknown role/i);
});

test('#1368 loadRosterRoles on a missing or roleless file is {} — never a throw', () => {
  assert.deepEqual(loadRosterRoles(path.join(os.tmpdir(), 'nope-' + Date.now() + '.json')), {});
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ seats: SEATS }));
  assert.deepEqual(loadRosterRoles(file), {});
});

test('#1368 API: GET /api/roster carries roles; POST /api/roster accepts and validates them; nobody in the board can be PO without being a seat', async () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ seats: SEATS }));
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: file } });
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    let g = await api('GET', '/api/roster');
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.roles, {}, 'no roles yet ⇒ an empty object, not undefined');
    const bad = await api('POST', '/api/roster', { seats: SEATS, roles: { po: 'nobody' } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const ok = await api('POST', '/api/roster', { seats: SEATS, roles: { po: 'bo' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.roles, { po: 'bo' });
    g = await api('GET', '/api/roster');
    assert.deepEqual(g.body.roles, { po: 'bo' }, 'the next read sees it — no restart');
  } finally { await srv.stop(); }
});
