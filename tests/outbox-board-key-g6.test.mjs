/**
 * #1574 GATE 6 — BOARD-KEY-ONLY AUTHORISATION ON THE OUTBOX ROUTES, "an explicit gate, tested before cutover, not left to 'auth elsewhere'". The contract owner's 15:12Z ruling: an observe-mode harness cannot
 * establish it; it needs an AUTH-ENFORCED harness proving board access succeeds and non-board access is refused. This is that harness: a REAL REST server with `SCRUM_AUTH=required` and a seat-tokens file
 * holding a `board` credential, an ordinary `act` seat (`ada`), a `read` seat and an `admin` human (`owner`), minted with the same helpers `credentials-1343.test.mjs` uses. Written by the separate test author
 * BEFORE the build. Synthetic content. No executor is needed: an unknown obligation id is enough to tell "refused at the door" (401/403) from "reached the handler" (404 Obligation not found).
 *
 * STATUS (17:03Z): B1, B2, B4 and B5 are marked `todo`: the STANDING, EXECUTABLE STATEMENT of the gate that decision 012168e4 DEFERRED to #1343. They stay RED by design until #1343 enforces board-only on these
 * routes under `SCRUM_AUTH=required` (the observe-to-required switch is a separate decision), are reported as TODO so the suite stays green, and are not a #1574 cutover blocker (the builder's 17:03Z reading; the
 * contract owner confirmed it at 17:04Z: "retain B1/B2/B4/B5 as #1343's executable acceptance criteria. Gate 6 is deferred, not satisfied." That does not authorize an auth-mode change, and it supports no
 * claim that the live outbox is board-only). B0 stays a real, passing row.
 *
 * WHAT THE CODE DOES TODAY, read before writing the rows: `needFor(method, path)` in core/credentials.mjs classes every non-GET route as `act` except roles, agents, config and credentials (`admin`). The outbox
 * routes are not in that list, so ANY `act` seat clears them. The rows below pin the gate as written and are expected RED on `9320fbc` and `95561f5`.
 *
 *   B0  CONTROL (green today): with auth required, no credential is 401 AUTH_REQUIRED; a bogus token is 401 TOKEN_UNKNOWN; the board credential reaches `/publish` (404 for an unknown obligation) and `/complete`
 *       (404); a `read` token reading `GET /api/cards` is 200 and posting is 403. So the harness is enforcing, and the board key reaches the handlers.
 *   B1  /publish: an `act`-scoped seat that is not `board` is refused with 403; the board credential is not.
 *   B2  /complete: the same.
 *   B3  (DROPPED 17:03Z: the batch-complete and close-legacy routes will not be built under decision 012168e4.)
 *   B4  STRICT READING, SEPARATE ROW: an `admin`-scoped human (`owner`) is refused on /publish too. The gate says "board key only"; if owners should pass, drop this row. Flagged because it is the strict reading.
 *   B5  THE LISTING, SEPARATE ROW, from the C3a "Access" paragraph ("Both routes require the board key": `GET /api/outbox` and `/complete`), which the gate-6 sentence does not name: a non-board `act` seat reading
 *       `GET /api/outbox` is refused with 403. Flagged: drop it if the listing is meant to stay readable.
 *
 * NOT COVERED, by name: a board credential with each possible scope (the live key's scope is the builder's to state); that `/publish` by the board key still does everything it did (the existing C3b rows own
 * that, in observe mode); the publisher script's use of the key (it sends `Authorization: Bearer`, owned by the G12 rows); rotation and revocation (credentials-1343).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const H = 3600000;
const tmpFile = (name, doc) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-cred-')); const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(doc, null, 2)); return p; };
const cred = ({ plain, scope = 'act' }) => ({ tokenHash: hashToken(plain), scope, issuedAt: new Date(Date.now() - H).toISOString(), expiresAt: new Date(Date.now() + 24 * H).toISOString(), issuedBy: 'test', revokedAt: null, note: null });
const api = async (base, method, route, { body, token } = {}) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const fixture = () => makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'the card', description: '', type: 'task', column: 'backlog', order: 1, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } }], nextShortId: 2 });
async function enforced(body) {
  const t = { board: mintToken(), ada: mintToken(), probe: mintToken(), owner: mintToken() };
  const file = tmpFile('seat-tokens.json', { seats: {
    board: { credentials: [cred({ plain: t.board, scope: 'act' })] },
    ada: { credentials: [cred({ plain: t.ada, scope: 'act' })] },
    probe: { credentials: [cred({ plain: t.probe, scope: 'read' })] },
    owner: { credentials: [cred({ plain: t.owner, scope: 'admin' })] },
  } });
  const srv = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: 'required' } });
  try { return await body({ base: srv.baseUrl, t }); } finally { await srv.stop(); }
}
const reached = (r) => r.status !== 401 && r.status !== 403;

test('B0 CONTROL: auth is enforced, and the board credential reaches /publish and /complete', { timeout: 120000 }, async () => {
  await enforced(async ({ base, t }) => {
    const h = await api(base, 'GET', '/api/health'); assert.equal(h.body.auth.mode, 'required');
    const anon = await api(base, 'GET', '/api/cards'); assert.equal(anon.status, 401); assert.equal(anon.body.code, 'AUTH_REQUIRED');
    const bogus = await api(base, 'GET', '/api/cards', { token: mintToken() }); assert.equal(bogus.status, 401); assert.equal(bogus.body.code, 'TOKEN_UNKNOWN');
    assert.equal((await api(base, 'GET', '/api/cards', { token: t.probe })).status, 200, 'a read token reads');
    assert.equal((await api(base, 'POST', '/api/conversations', { token: t.probe, body: { author: 'probe', body: 'x' } })).status, 403, 'and cannot post');
    const pub = await api(base, 'POST', '/api/outbox/no-such:claim/publish', { token: t.board, body: {} });
    assert.equal(pub.status, 404, `the board credential reaches /publish (an unknown obligation is a 404): ${pub.status} ${pub.text.slice(0, 160)}`);
    const comp = await api(base, 'POST', '/api/outbox/no-such:claim/complete', { token: t.board, body: {} });
    assert.equal(comp.status, 404, `and /complete: ${comp.status} ${comp.text.slice(0, 160)}`);
  });
});

const DEFERRED = 'DEFERRED to #1343 (decision 012168e4; confirmed by the builder 17:03Z, the contract owner may say a row should block sooner): the standing, executable statement of board-key-only; RED by design until #1343 enforces it, and not a #1574 cutover blocker';
for (const [row, route] of [['B1', '/api/outbox/no-such:claim/publish'], ['B2', '/api/outbox/no-such:claim/complete']]) {
  test(`${row} ${route.endsWith('publish') ? '/publish' : '/complete'}: a non-board act seat is refused with 403; the board credential is not`, { timeout: 120000, todo: DEFERRED }, async () => {
    await enforced(async ({ base, t }) => {
      const asBoard = await api(base, 'POST', route, { token: t.board, body: {} });
      assert.ok(reached(asBoard), `the board credential is not refused: ${asBoard.status}`);
      const asAda = await api(base, 'POST', route, { token: t.ada, body: {} });
      assert.equal(asAda.status, 403, `an act-scoped seat that is not board is refused at the door (it answered ${asAda.status}: ${asAda.text.slice(0, 160)})`);
    });
  });
}

test('B4 STRICT READING (separate row): an admin-scoped human is refused on /publish too, since the gate says "board key only"', { timeout: 120000, todo: DEFERRED }, async () => {
  await enforced(async ({ base, t }) => {
    const asOwner = await api(base, 'POST', '/api/outbox/no-such:claim/publish', { token: t.owner, body: {} });
    assert.equal(asOwner.status, 403, `an admin human is not the board key (${asOwner.status}: ${asOwner.text.slice(0, 120)})`);
  });
});

test('B5 THE LISTING (separate row, from the C3a Access paragraph): a non-board act seat reading GET /api/outbox is refused with 403', { timeout: 120000, todo: DEFERRED }, async () => {
  await enforced(async ({ base, t }) => {
    assert.equal((await api(base, 'GET', '/api/outbox', { token: t.board })).status, 200, 'the board credential lists the outbox');
    const asAda = await api(base, 'GET', '/api/outbox', { token: t.ada });
    assert.equal(asAda.status, 403, `C3a: "both routes require the board key" (${asAda.status})`);
  });
});
