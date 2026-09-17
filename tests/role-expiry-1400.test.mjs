/**
 * #1400 — a re-declaration with a shorter expiry silently shortened a held role.
 *
 * Specimen (2026-09-16): the seat holding scrum-master declared to day 7 at
 * 16:36Z, then at 16:47Z declared again to carry a note — with a 3-hour expiry.
 * A new declaration ENDS the previous one, so the note's window replaced the
 * week's grant and the role lapsed at 19:00Z while its holder kept acting; the
 * board said nothing until a seat asked "who is SM?" at 05:43Z the next day.
 *
 * Two thin fixes: (1) the write's own result names the shortening — a seat
 * that reads its tool result cannot miss it; (2) a standing check `role-expiry`
 * rows a role expiring within 24 h and a role that lapsed in the last 7 days
 * whose holder has written since.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleShortening, roleExpiryRows } from '../core/role-expiry.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const T0 = '2026-09-16T16:47:10.000Z';
const at = (h) => new Date(Date.parse(T0) + h * 3600_000).toISOString();

// ── the pure half ────────────────────────────────────────────────────────────

test('#1400 roleShortening — a carried role re-declared to an EARLIER expiry names the shortening; later, equal, no role, or a different role does not', () => {
  const week = { seat: 'ada', role: 'scrum-master', expiresAt: at(24 * 7) };
  const s = roleShortening({ prior: week, next: { role: 'scrum-master', expiresAt: at(3) } });
  assert.ok(s, 'the specimen shape is a shortening');
  assert.equal(s.role, 'scrum-master');
  assert.equal(s.from, week.expiresAt);
  assert.equal(s.to, at(3));
  assert.match(s.warning, /shortens your scrum-master/);
  assert.match(s.warning, new RegExp(week.expiresAt.slice(0, 16)));
  assert.equal(roleShortening({ prior: week, next: { role: 'scrum-master', expiresAt: at(24 * 8) } }), null, 'extending is not a shortening');
  assert.equal(roleShortening({ prior: week, next: { role: 'scrum-master', expiresAt: week.expiresAt } }), null, 'same expiry');
  assert.equal(roleShortening({ prior: { ...week, role: null }, next: { role: null, expiresAt: at(1) } }), null, 'no role held: nothing to shorten');
  assert.equal(roleShortening({ prior: week, next: { role: null, expiresAt: at(1) } }), null, 'releasing the role is a release, said elsewhere, not a shortening');
  assert.equal(roleShortening({ prior: week, next: { role: 'po', expiresAt: at(1) } }), null, 'a different role is a different grant');
  assert.equal(roleShortening({ prior: null, next: { role: 'scrum-master', expiresAt: at(1) } }), null, 'a first declaration shortens nothing');
});

test('#1400 roleExpiryRows — expiring within 24 h is a row; lapsed within 7 d with a holder write SINCE is a row; a healthy week-long grant is not', () => {
  const now = at(0);
  const decls = [
    { seat: 'ada', role: 'scrum-master', expiresAt: at(12) },                     // expiring in 12 h → row
    { seat: 'bo', role: 'po', expiresAt: at(24 * 6) },                           // healthy → no row
    { seat: 'cy', role: 'scrum-master', expiresAt: at(-20) },                    // lapsed 20 h ago, wrote since → row
    { seat: 'di', role: 'po', expiresAt: at(-30) },                              // lapsed, silent since → NOT a row (nobody acting on a dead role)
    { seat: 'ed', role: 'po', expiresAt: at(-24 * 9) },                          // lapsed 9 days ago, wrote since → outside the 7-day window
    { seat: 'fi', role: null, expiresAt: at(1) },                                // no role: availability expiring is not this check's business
  ];
  const conversations = [
    { author: 'cy', createdAt: at(-2) },
    { author: 'di', createdAt: at(-40) },   // before the lapse — not "acting since"
    { author: 'ed', createdAt: at(-1) },
  ];
  const rows = roleExpiryRows({ decls, conversations, now });
  assert.deepEqual(rows.map((r) => [r.seat, r.state]).sort(), [['ada', 'expiring'], ['cy', 'lapsed-but-acting']]);
  const ada = rows.find((r) => r.seat === 'ada');
  assert.equal(ada.role, 'scrum-master'); assert.equal(ada.expiresAt, at(12)); assert.equal(ada.inHours, 12);
  const cy = rows.find((r) => r.seat === 'cy');
  assert.equal(cy.lastWriteAt, at(-2)); assert.equal(cy.lapsedHours, 20);
  assert.deepEqual(roleExpiryRows({ decls: [decls[1]], conversations, now }), [], 'a healthy grant alone: zero rows');
});

// ── the seam: REST, then /api/checks ─────────────────────────────────────────

const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const inH = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const fixture = () => makeBoardFixture({ cards: [{ id: 'role-card-1', shortId: 1, title: 'the role card', column: 'backlog', createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z' }], nextShortId: 2 });
const declare = (base, seat, body) => api(base, 'PUT', `/api/seats/${seat}/state`, { mode: 'available', acceptsRoutineWork: true, ...body });

test('#1400 served — re-declaring a held role with a shorter expiry puts the shortening IN THE WRITE\'S OWN RESULT; a longer one does not', async () => {
  const srv = await startRestServer({ board: fixture() });
  try {
    const minted = await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master', definition: 'Establishes Scrum here and holds the cadence; asks, never asserts.', definedBy: 1 });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const week = await declare(srv.baseUrl, 'ada', { role: 'scrum-master', expiresAt: inH(24 * 7 - 1) });
    assert.equal(week.status, 200, JSON.stringify(week.body));
    assert.equal(week.body.shortened, undefined, 'a first grant shortens nothing');
    // the specimen: a note-carrying re-declaration, role CARRIED (omitted), three-hour window
    const note = await declare(srv.baseUrl, 'ada', { note: 'state-file read at 17:15Z', expiresAt: inH(3) });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.equal(note.body.role, 'scrum-master', 'the role is carried forward (#915)');
    assert.ok(note.body.shortened, `the result names the shortening: ${JSON.stringify(note.body)}`);
    assert.equal(note.body.shortened.role, 'scrum-master');
    assert.equal(note.body.shortened.from, week.body.expiresAt);
    assert.equal(note.body.shortened.to, note.body.expiresAt);
    assert.match(note.body.warning, /shortens your scrum-master from .* to /);
    // and the grant is really shorter now — the warning describes a fact, not a hypothetical
    const state = await api(srv.baseUrl, 'GET', '/api/seats/state');
    assert.equal(state.body.seats.find((s) => s.seat === 'ada').expiresAt, note.body.expiresAt);
    // extending back out: no warning
    const back = await declare(srv.baseUrl, 'ada', { expiresAt: inH(24 * 6) });
    assert.equal(back.status, 200);
    assert.equal(back.body.shortened, undefined);
    assert.equal(back.body.warning, undefined);
  } finally { await srv.stop(); }
});

test('#1400 served — /api/checks carries a `role-expiry` standing row for a role expiring within 24 h, and none for a week-long grant', async () => {
  const srv = await startRestServer({ board: fixture() });
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'po', name: 'Product Owner', definition: 'Owns Planned as the sprint; grooms WHY / WHAT / first move for every card there.', definedBy: 1 })).status, 201);
    assert.equal((await declare(srv.baseUrl, 'ada', { role: 'po', expiresAt: inH(24 * 6) })).status, 200);
    let checks = await api(srv.baseUrl, 'GET', '/api/checks');
    let row = checks.body.standing.find((s) => s.id === 'role-expiry');
    assert.ok(row, 'the standing row exists');
    assert.equal(row.error, undefined, JSON.stringify(row));
    assert.deepEqual(row.rows, [], 'a six-day grant is not expiring');
    assert.equal((await declare(srv.baseUrl, 'ada', { expiresAt: inH(5) })).status, 200);   // carried role, now 5 h out
    checks = await api(srv.baseUrl, 'GET', '/api/checks');
    row = checks.body.standing.find((s) => s.id === 'role-expiry');
    assert.equal(row.rows.length, 1, JSON.stringify(row));
    assert.equal(row.rows[0].seat, 'ada'); assert.equal(row.rows[0].role, 'po'); assert.equal(row.rows[0].state, 'expiring');
    assert.ok(row.rows[0].inHours <= 5 && row.rows[0].inHours >= 4, `hours until lapse: ${row.rows[0].inHours}`);
  } finally { await srv.stop(); }
});
