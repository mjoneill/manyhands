/**
 * #1413 — the four findings from the #1343 slice-2 review (73c7593), each
 * inert on an observe-mode loopback prod and a defect the morning
 * SCRUM_AUTH=required flips (or SCRUM_SEAT_TOKEN_FILE is set). One served
 * assertion per finding; the tests are the evidence — the `mismatched`
 * counter reads 0 on today's traffic for the wrong reason (every MCP tool
 * call supplies an actor; the browser is unbound), so a day of zeros proves
 * nothing.
 *
 *   A · /api/health.auth enumerated seat NAMES to an anonymous caller — in
 *       required it is the one open door, and it listed the roster that
 *       /api/agents sits behind. Now: counts to an unbound caller, names to a
 *       bound one.
 *   B · `mismatched` counted a body with NO actor field (assertActor returns a
 *       new object when it FILLS `by`). Now: a fill is silent; only a
 *       non-empty declared actor that differs from the seat counts.
 *   C · the adapter's bearerHeaders() fell through `store.bearer || SERVICE`,
 *       so an UNBOUND session's tool call reached REST AS the service seat.
 *       Now: inside a request store the store's bearer is used even when null;
 *       the service bearer only where there is no store at all.
 *   D · digest-state.json (runtime state) rode into the tree. Now: untracked
 *       and ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { startRestServer, startMcpServer, makeBoardFixture, mcpSession, PROJECT_DIR } from './helpers/harness.mjs';

const inH = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const cred = (plain, scope = 'act') => ({ tokenHash: hashToken(plain), scope, issuedAt: inH(-1), expiresAt: inH(24 * 30), issuedBy: 'test', revokedAt: null, note: null });
const api = async (base, method, p, { body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const fixture = () => makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'the card', column: 'backlog', createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z' }], nextShortId: 2 });
function tokensFile(extra = {}) {
  const t = { ada: mintToken(), read: mintToken(), svc: mintToken() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-1413-'));
  const file = path.join(dir, 'seat-tokens.json');
  fs.writeFileSync(file, JSON.stringify({ seats: {
    ada: { credentials: [cred(t.ada)] },
    probe: { credentials: [cred(t.read, 'read')] },
    svc: { credentials: [cred(t.svc)] },
    old: { token: mintToken() },   // a legacy row, so `legacy` is non-empty
    ...extra,
  } }));
  return { dir, file, t };
}

test('#1413 A — /api/health.auth gives an UNBOUND caller counts (seats, legacy as numbers) and a BOUND caller the names, in both modes', async () => {
  const { file, t } = tokensFile();
  for (const mode of ['observe', 'required']) {
    const srv = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: mode } });
    try {
      const anon = await api(srv.baseUrl, 'GET', '/api/health');
      assert.equal(anon.status, 200);
      assert.equal(anon.body.auth.mode, mode);
      assert.equal(anon.body.auth.seats, 4, `${mode}: an anonymous caller gets a COUNT`);
      assert.equal(anon.body.auth.legacy, 1, `${mode}: …and a count of legacy rows`);
      assert.equal(JSON.stringify(anon.body).includes('ada'), false, `${mode}: no seat name reaches an anonymous caller`);
      const bound = await api(srv.baseUrl, 'GET', '/api/health', { token: t.read });
      assert.deepEqual(bound.body.auth.seats, ['ada', 'probe', 'svc', 'old'], `${mode}: a bound reader gets the names`);
      assert.deepEqual(bound.body.auth.legacy, ['old']);
    } finally { await srv.stop(); }
  }
});

test('#1413 B — a bound seat\'s body with NO actor field is filled silently (mismatched stays 0); a non-empty DIFFERENT actor still counts', async () => {
  const { file, t } = tokensFile();
  const srv = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file } });
  try {
    const patched = await api(srv.baseUrl, 'PATCH', '/api/cards/c1', { body: { title: 'renamed, no by' }, token: t.ada });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const posted = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'ada', body: 'as myself' }, token: t.ada });
    assert.equal(posted.status, 201);
    const carried = await api(srv.baseUrl, 'PATCH', '/api/cards/c1', { body: { title: 'carries its own relay field', onBehalfOf: 'someone' }, token: t.ada });
    assert.equal(carried.status, 200, JSON.stringify(carried.body));
    let h = await api(srv.baseUrl, 'GET', '/api/health');
    assert.equal(h.body.auth.mismatched, 0, 'a fill, an agreement, and a body that CARRIES its own onBehalfOf are not mismatches');
    const relayed = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'bo', body: 'declared bo' }, token: t.ada });
    assert.equal(relayed.status, 201);
    h = await api(srv.baseUrl, 'GET', '/api/health');
    assert.equal(h.body.auth.mismatched, 1, 'a different declared actor is the one thing that counts');
  } finally { await srv.stop(); }
});

test('#1413 C — with a SERVICE bearer configured, an UNBOUND session\'s tool call reaches REST unbound (refused in required), never as the service seat; a BOUND session\'s call reaches it as itself', async () => {
  const { dir, file, t } = tokensFile();
  const svcFile = path.join(dir, 'svc.token');
  fs.writeFileSync(svcFile, t.svc + '\n', { mode: 0o600 });
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: 'required' } });
  let mcp;
  try {
    // the adapter in OBSERVE admits an unbound session; REST in REQUIRED is what tells us whose bearer the call carried
    mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: 'observe', SCRUM_SEAT_TOKEN_FILE: svcFile } });
    const mcpUrl = `${mcp.baseUrl}/mcp`;
    const unbound = await mcpSession(mcpUrl);
    const r = await unbound.callTool('conversation_post', { author: 'ada', body: 'from an unbound session' });
    const text = JSON.stringify(r);
    assert.ok(r.error || r.result?.isError, `an unbound session's write is REFUSED by REST, not laundered: ${text.slice(0, 300)}`);
    assert.match(text, /AUTH_REQUIRED|401/, text.slice(0, 300));
    const bound = await mcpSession(mcpUrl, { headers: { Authorization: `Bearer ${t.ada}` } });
    const ok = await bound.callTool('conversation_post', { author: 'ada', body: 'from a bound session' });
    assert.ok(!ok.error && !ok.result?.isError, JSON.stringify(ok).slice(0, 300));
    const list = await api(rest.baseUrl, 'GET', '/api/conversations?limit=10', { token: t.read });
    const rows = Array.isArray(list.body) ? list.body : list.body.messages;
    assert.equal(rows.filter((x) => x.author === 'svc').length, 0, 'nothing on the board is attributed to the service seat');
    assert.equal(rows.filter((x) => /from an unbound session/.test(x.body)).length, 0);
    assert.equal(rows.find((x) => /from a bound session/.test(x.body))?.author, 'ada');
  } finally { if (mcp) await mcp.stop(); await rest.stop(); }
});

test('#1413 D — digest-state.json is runtime state: not tracked, and ignored', () => {
  const tracked = execSync('git ls-files digest-state.json', { cwd: PROJECT_DIR, encoding: 'utf8' }).trim();
  assert.equal(tracked, '', 'not in the index');
  const ignore = fs.readFileSync(path.join(PROJECT_DIR, '.gitignore'), 'utf8');
  assert.match(ignore, /^digest-state\.json$/m, 'listed in .gitignore');
});
