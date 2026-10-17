/**
 * #1343 slice 2 — the agent-token scheme, built. The scheme (slice 1, reviewed
 * on the card 2026-09-17) in one breath: an opaque `mh_` + 43-char token, kept
 * as its SHA-256 in `seat-tokens.json`, with a scope (read | act | admin), an
 * expiry, and revocation as an event; one middleware on both servers whose
 * MODE is `SCRUM_AUTH` — `observe` (bind if known, admit everyone: #703's
 * fail-open, the loopback default) or `required` (absent / unknown / expired /
 * revoked → 401 with a reason; scope enforced; the actor asserted by the
 * server from the credential, a disagreeing body recorded as onBehalfOf).
 *
 * Sabotage profiles (distinct, each named in the scheme):
 *   (a) hash lookup skipped   → an unknown bearer binds        (test: unknown → 401 TOKEN_UNKNOWN)
 *   (b) expiry ignored        → the expired credential binds   (test: expired → 401 TOKEN_EXPIRED naming the seat)
 *   (c) scope not enforced    → a `read` token posts           (test: read → GET 200, POST 403 SCOPE_INSUFFICIENT)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mintToken, hashToken, TOKEN_SHAPE, loadCredentials, resolveBearer, authDecision,
  needFor, assertActor, credentialExpiryRows, migrateCredentialsDoc, AUTH_MODES, readAuthMode, redactSecrets,
} from '../core/credentials.mjs';
import { startRestServer, startMcpServer, makeBoardFixture, mcpSession, PROJECT_DIR } from './helpers/harness.mjs';

const H = 3600_000, D = 24 * H;
const NOW = '2026-09-18T12:00:00.000Z';
const at = (h) => new Date(Date.parse(NOW) + h * H).toISOString();
const inH = (h) => new Date(Date.now() + h * H).toISOString();

const tmpFile = (name, doc) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-cred-'));
  const p = path.join(dir, name);
  if (doc !== undefined) fs.writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
  return p;
};
const cred = (over = {}) => {
  const { plain, ...rest } = over;
  return { tokenHash: hashToken(plain ?? mintToken()), scope: 'act', issuedAt: at(-1), expiresAt: at(24 * 30), issuedBy: 'test', revokedAt: null, note: null, ...rest };
};

// ── the pure half ────────────────────────────────────────────────────────────

test('#1343 format — a minted token is mh_ + 43 base64url chars, unique, and the at-rest form is its SHA-256 hex; TOKEN_SHAPE recognises a value and not the bare prefix', () => {
  const a = mintToken(), b = mintToken();
  assert.match(a, /^mh_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(hashToken(a), createHash('sha256').update(a).digest('hex'));
  assert.equal(hashToken(a).length, 64);
  assert.ok(TOKEN_SHAPE.test(`Authorization: Bearer ${a}`));
  assert.ok(!TOKEN_SHAPE.test('mh_ is the prefix'), 'the prefix alone is prose, not a value');
  assert.ok(!TOKEN_SHAPE.test('mh_' + 'x'.repeat(20)), 'a short tail is not a token');
});

test('#1343 load — absent file is DORMANT; the hashed shape loads by hash; a LEGACY plaintext row still binds (hashed in memory) and is reported so the migration is not forgotten; heartbeat_s survives', () => {
  const warns = [];
  const dormant = loadCredentials(path.join(os.tmpdir(), 'no-such-file-1343.json'), { warn: (m) => warns.push(m) });
  assert.equal(dormant.dormant, true);
  assert.equal(dormant.byHash.size, 0);

  const plain = mintToken(), legacyPlain = mintToken();
  const file = tmpFile('seat-tokens.json', {
    seats: {
      ada: { heartbeat_s: 30, credentials: [cred({ plain, note: 'terminal' })] },
      old: { token: legacyPlain, heartbeat_s: 45 },          // #703's shape, pre-migration
    },
  });
  const creds = loadCredentials(file, { warn: (m) => warns.push(m) });
  assert.equal(creds.dormant, false);
  assert.deepEqual(creds.legacy, ['old'], 'the plaintext seat is named, never its value');
  assert.ok(warns.some((w) => /old/.test(w) && /migrate/.test(w) && !w.includes(legacyPlain)), `a warning names the seat and the cure, never the value: ${JSON.stringify(warns)}`);
  const ada = resolveBearer(`Bearer ${plain}`, creds, { now: NOW });
  assert.equal(ada.seat, 'ada'); assert.equal(ada.scope, 'act'); assert.equal(ada.heartbeat_s, 30);
  const old = resolveBearer(`bearer ${legacyPlain}`, creds, { now: NOW });   // scheme case-insensitive, as #703
  assert.equal(old.seat, 'old'); assert.equal(old.scope, 'act', 'a migrated-in-memory legacy row is act, what every seat does today'); assert.equal(old.heartbeat_s, 45);
  assert.equal(JSON.stringify([...creds.byHash.entries()]).includes(plain), false, 'the loaded structure never holds a plaintext');
  assert.equal(JSON.stringify([...creds.byHash.entries()]).includes(legacyPlain), false, 'not even a legacy one');
});

test('#1343 resolve — no header is null; unknown is unbound-with-reason; expired and revoked name the SEAT and the reason', () => {
  const live = mintToken(), expired = mintToken(), revoked = mintToken();
  const file = tmpFile('seat-tokens.json', { seats: {
    ada: { credentials: [cred({ plain: live }), cred({ plain: expired, expiresAt: at(-2) }), cred({ plain: revoked, revokedAt: at(-3) })] },
  } });
  const creds = loadCredentials(file);
  assert.equal(resolveBearer(undefined, creds, { now: NOW }), null);
  assert.equal(resolveBearer('Basic abc', creds, { now: NOW }), null, 'not a bearer scheme: unbound, no reason to give');
  assert.deepEqual(resolveBearer(`Bearer ${mintToken()}`, creds, { now: NOW }), { seat: null, reason: 'unknown' });
  const e = resolveBearer(`Bearer ${expired}`, creds, { now: NOW });
  assert.equal(e.seat, null); assert.equal(e.reason, 'expired'); assert.equal(e.seatHint, 'ada'); assert.equal(e.expiresAt, at(-2));
  const r = resolveBearer(`Bearer ${revoked}`, creds, { now: NOW });
  assert.equal(r.reason, 'revoked'); assert.equal(r.seatHint, 'ada');
  assert.equal(resolveBearer(`Bearer ${live}`, creds, { now: NOW }).seat, 'ada');
  // dormant file: nothing to mismatch against — every bearer is simply unbound (the #703 rollout precondition)
  assert.equal(resolveBearer(`Bearer ${live}`, loadCredentials('/nonexistent/x.json'), { now: NOW }), null);
});

test('#1343 decision — observe admits everyone and binds the known; required refuses absent/unknown/expired/revoked with a code, and enforces scope by ORDER read < act < admin', () => {
  const bound = (scope) => ({ seat: 'ada', scope, heartbeat_s: 60 });
  for (const binding of [null, { seat: null, reason: 'unknown' }, { seat: null, reason: 'expired', seatHint: 'ada' }]) {
    const d = authDecision({ binding, mode: 'observe', need: 'act' });
    assert.equal(d.ok, true, `observe admits ${JSON.stringify(binding)}`);
    assert.equal(d.seat, null);
  }
  assert.deepEqual(authDecision({ binding: bound('read'), mode: 'observe', need: 'act' }), { ok: true, seat: 'ada', scope: 'read', enforced: false }, 'observe binds but does not refuse on scope — today\'s behaviour, counted not blocked');

  const req = (binding, need) => authDecision({ binding, mode: 'required', need });
  assert.equal(req(null, 'read').status, 401); assert.equal(req(null, 'read').code, 'AUTH_REQUIRED');
  assert.equal(req({ seat: null, reason: 'unknown' }, 'read').code, 'TOKEN_UNKNOWN');                              // (a)
  const ex = req({ seat: null, reason: 'expired', seatHint: 'ada', expiresAt: at(-2) }, 'read');
  assert.equal(ex.status, 401); assert.equal(ex.code, 'TOKEN_EXPIRED'); assert.match(ex.error, /EXPIRED/); assert.match(ex.error, /ada/);   // (b)
  assert.equal(req({ seat: null, reason: 'revoked', seatHint: 'ada' }, 'read').code, 'TOKEN_REVOKED');
  assert.deepEqual(req(bound('read'), 'read'), { ok: true, seat: 'ada', scope: 'read', enforced: true });
  const sc = req(bound('read'), 'act');                                                                              // (c)
  assert.equal(sc.status, 403); assert.equal(sc.code, 'SCOPE_INSUFFICIENT'); assert.match(sc.error, /read/); assert.match(sc.error, /act/);
  assert.equal(req(bound('act'), 'admin').code, 'SCOPE_INSUFFICIENT');
  assert.equal(req(bound('act'), 'act').ok, true);
  assert.equal(req(bound('admin'), 'act').ok, true);
  assert.equal(req(bound('admin'), 'admin').ok, true);
  assert.equal(req(bound('act'), null).ok, true, 'a route that needs nothing (the liveness door) admits a bound seat too');
  assert.equal(req(null, null).ok, true, '…and an anonymous caller');
  assert.throws(() => authDecision({ binding: bound('act'), mode: 'require', need: 'act' }), /SCRUM_AUTH/, 'a misspelt mode is refused, never defaulted to observe');
});

test('#1343 needFor — GET/HEAD/OPTIONS are read; a mutation is act; roster, roles, config and credentials mutations are admin; /api/health is the free liveness door in every mode', () => {
  assert.equal(needFor('GET', '/api/cards'), 'read');
  assert.equal(needFor('HEAD', '/api/cards'), 'read');
  assert.equal(needFor('POST', '/api/conversations'), 'act');
  assert.equal(needFor('PUT', '/api/seats/ada/state'), 'act');
  assert.equal(needFor('DELETE', '/api/cards/x'), 'act');
  assert.equal(needFor('POST', '/api/roles'), 'admin');
  assert.equal(needFor('PATCH', '/api/roles/po'), 'admin');
  assert.equal(needFor('POST', '/api/agents'), 'admin');
  assert.equal(needFor('POST', '/api/config'), 'admin');
  assert.equal(needFor('POST', '/api/credentials'), 'admin');
  assert.equal(needFor('GET', '/api/roles'), 'read', 'reading the roles is a read');
  assert.equal(needFor('GET', '/api/health'), null, 'no credential is needed to ask whether the process is up — it carries no board content');
  assert.equal(needFor('GET', '/index.html'), 'read', 'the UI\'s pages are board content too — no anonymous side door');
});

test('#1343 assertActor — in required mode the server sets the actor from the credential: an agreeing body is untouched, a disagreeing `by`/`author` becomes onBehalfOf, a missing one is filled', () => {
  assert.deepEqual(assertActor({ by: 'ada', title: 't' }, 'ada'), { by: 'ada', title: 't' });
  assert.deepEqual(assertActor({ by: 'bo', title: 't' }, 'ada'), { by: 'ada', onBehalfOf: 'bo', title: 't' });
  assert.deepEqual(assertActor({ author: 'bo', body: 'x' }, 'ada'), { author: 'ada', onBehalfOf: 'bo', body: 'x' });
  assert.deepEqual(assertActor({ title: 't' }, 'ada'), { by: 'ada', title: 't' });
  assert.deepEqual(assertActor([1, 2], 'ada'), [1, 2], 'a non-object body is not an actor claim');
  assert.deepEqual(assertActor({ by: 'bo' }, null), { by: 'bo' }, 'no bound seat: nothing to assert (observe mode never calls this)');
});

test('#1343 credentialExpiryRows — within 72 h is `expiring`; lapsed within 7 d and NOT revoked is `expired`; revoked, healthy, or long-lapsed are not rows', () => {
  const file = tmpFile('seat-tokens.json', { seats: {
    ada: { credentials: [cred({ expiresAt: at(10), note: 'terminal' })] },                    // expiring → row
    bo: { credentials: [cred({ expiresAt: at(24 * 20) })] },                                  // healthy
    cy: { credentials: [cred({ expiresAt: at(-30) })] },                                      // lapsed 30 h, unrevoked → row
    di: { credentials: [cred({ expiresAt: at(-30), revokedAt: at(-40) })] },                 // revoked → not a row
    ed: { credentials: [cred({ expiresAt: at(-24 * 9) })] },                                  // lapsed 9 d → outside the window
  } });
  const rows = credentialExpiryRows({ credentials: loadCredentials(file), now: NOW });
  assert.deepEqual(rows.map((r) => [r.seat, r.state]).sort(), [['ada', 'expiring'], ['cy', 'expired']]);
  const ada = rows.find((r) => r.seat === 'ada');
  assert.equal(ada.inHours, 10); assert.equal(ada.scope, 'act'); assert.equal(ada.expiresAt, at(10)); assert.equal(ada.note, 'terminal');
  assert.equal(JSON.stringify(rows).includes('tokenHash'), false, 'a row names the credential by seat + note, never by hash');
  assert.deepEqual(credentialExpiryRows({ credentials: loadCredentials('/nonexistent/x.json'), now: NOW }), [], 'dormant: no rows');
});

test('#1343 migrateCredentialsDoc — a #703 plaintext file becomes hashes with scope act, 90-day expiry, heartbeat kept, the README rewritten; a second run changes nothing; a value never survives', () => {
  const t1 = mintToken(), t2 = mintToken();
  const doc = { _README: ['old words'], seats: { ada: { token: t1, heartbeat_s: 30 }, bo: { token: t2 } } };
  const { doc: out, migrated } = migrateCredentialsDoc(doc, { now: NOW, issuedBy: 'migration' });
  assert.deepEqual(migrated, ['ada', 'bo']);
  assert.equal(out.seats.ada.heartbeat_s, 30);
  assert.equal(out.seats.ada.token, undefined);
  assert.equal(out.seats.ada.credentials.length, 1);
  const c = out.seats.ada.credentials[0];
  assert.equal(c.tokenHash, hashToken(t1)); assert.equal(c.scope, 'act'); assert.equal(c.issuedAt, NOW); assert.equal(c.expiresAt, at(24 * 90)); assert.equal(c.issuedBy, 'migration'); assert.equal(c.revokedAt, null);
  assert.equal(JSON.stringify(out).includes(t1), false); assert.equal(JSON.stringify(out).includes(t2), false);
  assert.ok(Array.isArray(out._README) && out._README.some((l) => /hash/i.test(l)));
  const again = migrateCredentialsDoc(out, { now: at(1), issuedBy: 'migration' });
  assert.deepEqual(again.migrated, []);
  assert.deepEqual(again.doc, out);
});

test('#1343 readAuthMode — unset is observe; observe and required are the modes; anything else THROWS at boot (a typo must not silently run open)', () => {
  assert.deepEqual(AUTH_MODES, ['observe', 'required']);
  assert.equal(readAuthMode(undefined), 'observe');
  assert.equal(readAuthMode(''), 'observe');
  assert.equal(readAuthMode('required'), 'required');
  assert.equal(readAuthMode('Observe'), 'observe');
  assert.throws(() => readAuthMode('require'), /SCRUM_AUTH/);
  assert.throws(() => readAuthMode('on'), /observe|required/);
});

test('#1343 redactSecrets — the mh_ token shape is scrubbed (the push gate mirrors this list), so a pasted value never lands in a log or the refusal ledger', () => {
  const v = mintToken();
  assert.equal(redactSecrets(`token ${v} here`), 'token mh_[REDACTED] here');
  assert.equal(redactSecrets('mh_ is the prefix'), 'mh_ is the prefix');
});

// ── the seam: REST served ────────────────────────────────────────────────────

const script = (args, env = {}) => spawnSync('node', [path.join(PROJECT_DIR, 'scripts', 'credential.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

const api = async (base, method, p, { body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const fixture = () => makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'the card', column: 'backlog', createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z' }], nextShortId: 2 });

function tokensFile() {
  const t = { ada: mintToken(), read: mintToken(), admin: mintToken(), expired: mintToken(), soon: mintToken() };
  const file = tmpFile('seat-tokens.json', { seats: {
    ada: { credentials: [cred({ plain: t.ada, scope: 'act' })] },
    probe: { credentials: [cred({ plain: t.read, scope: 'read' })] },
    owner: { credentials: [cred({ plain: t.admin, scope: 'admin' })] },
    gone: { credentials: [cred({ plain: t.expired, expiresAt: inH(-2) })] },
    soon: { credentials: [cred({ plain: t.soon, expiresAt: inH(10), note: 'rotating' })] },
  } });
  return { file, t };
}

test('#1343 served (observe) — /api/health names the mode; an unauthenticated write is admitted; a known bearer binds without rewriting the actor; scope is not enforced; the credential-expiry standing row rides /api/checks', async () => {
  const { file, t } = tokensFile();
  const srv = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file } });
  try {
    const h = await api(srv.baseUrl, 'GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.auth.mode, 'observe');
    assert.equal(h.body.auth.credentials, 5);
    assert.equal(JSON.stringify(h.body).includes(t.ada), false);
    const anon = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'ada', body: 'unauthenticated, admitted' } });
    assert.equal(anon.status, 201, JSON.stringify(anon.body));
    const bound = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'bo', body: 'bound as ada, declared bo' }, token: t.ada });
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    assert.equal(bound.body.author, 'bo', 'observe does not rewrite the actor — the mismatch is COUNTED, not corrected (#703 Q3)');
    const readTokenPost = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'probe', body: 'read scope, observe mode' }, token: t.read });
    assert.equal(readTokenPost.status, 201, 'observe: scope is not enforced');
    const checks = await api(srv.baseUrl, 'GET', '/api/checks');
    const row = checks.body.standing.find((s) => s.id === 'credential-expiry');
    assert.ok(row, 'the standing row exists');
    assert.equal(row.error, undefined, JSON.stringify(row));
    assert.deepEqual(row.rows.map((r) => [r.seat, r.state]).sort(), [['gone', 'expired'], ['soon', 'expiring']], JSON.stringify(row.rows));
    const h2 = await api(srv.baseUrl, 'GET', '/api/health');
    assert.equal(h2.body.auth.refused, 0, 'observe refuses nothing');
    assert.equal(h2.body.auth.mismatched, 1, 'the bound-as-ada-declared-bo write is counted where the room looks');
    // a mint AFTER boot is live without a restart (the file is re-read on mtime change, ≤ 2 s behind)
    const minted = script(['mint', '--seat', 'late', '--scope', 'act', '--file', file, '--by', 'test']);
    assert.equal(minted.status, 0, minted.stderr);
    await new Promise((r) => setTimeout(r, 2300));
    const asLate = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'bo', body: 'minted after boot' }, token: minted.stdout.trim() });
    assert.equal(asLate.status, 201);
    const h3 = await api(srv.baseUrl, 'GET', '/api/health');
    assert.equal(h3.body.auth.credentials, 6, 'the new credential is counted');
    assert.equal(h3.body.auth.mismatched, 2, 'and it BOUND — the declared-bo write under it was counted as a mismatch, which only a bound seat produces');
  } finally { await srv.stop(); }
});

test('#1343 served (required) — absent 401; unknown 401 (a); expired 401 naming the seat (b); read token reads and cannot post (c); act token posts AS ITSELF with a disagreeing author as onBehalfOf; admin is needed for /api/roles; /api/health stays open; the bearer is never logged', async () => {
  const { file, t } = tokensFile();
  const srv = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: 'required' } });
  try {
    const h = await api(srv.baseUrl, 'GET', '/api/health');
    assert.equal(h.status, 200, 'the liveness door is open without a credential');
    assert.equal(h.body.auth.mode, 'required');

    const absent = await api(srv.baseUrl, 'GET', '/api/cards');
    assert.equal(absent.status, 401); assert.equal(absent.body.code, 'AUTH_REQUIRED');
    const page = await fetch(`${srv.baseUrl}/index.html`);
    assert.equal(page.status, 401, 'the UI is board content: no anonymous side door');

    const unknown = await api(srv.baseUrl, 'GET', '/api/cards', { token: mintToken() });                 // (a)
    assert.equal(unknown.status, 401); assert.equal(unknown.body.code, 'TOKEN_UNKNOWN');

    const expired = await api(srv.baseUrl, 'GET', '/api/cards', { token: t.expired });                  // (b)
    assert.equal(expired.status, 401); assert.equal(expired.body.code, 'TOKEN_EXPIRED');
    assert.match(expired.body.error, /EXPIRED/); assert.match(expired.body.error, /gone/);

    const readOk = await api(srv.baseUrl, 'GET', '/api/cards', { token: t.read });                       // (c)
    assert.equal(readOk.status, 200, JSON.stringify(readOk.body));
    const readPost = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'probe', body: 'read scope posting' }, token: t.read });
    assert.equal(readPost.status, 403); assert.equal(readPost.body.code, 'SCOPE_INSUFFICIENT');

    const asSelf = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'ada', body: 'as myself' }, token: t.ada });
    assert.equal(asSelf.status, 201, JSON.stringify(asSelf.body));
    assert.equal(asSelf.body.author, 'ada'); assert.equal(asSelf.body.onBehalfOf ?? null, null);
    const relayed = await api(srv.baseUrl, 'POST', '/api/conversations', { body: { author: 'bo', body: 'declared bo, bound ada' }, token: t.ada });
    assert.equal(relayed.status, 201, JSON.stringify(relayed.body));
    assert.equal(relayed.body.author, 'ada', 'the server asserts the actor from the credential');
    assert.equal(relayed.body.onBehalfOf, 'bo', 'the disagreement is recorded, as conversation_post does');
    const claim = await api(srv.baseUrl, 'POST', '/api/cards/c1/claim', { body: { by: 'bo' }, token: t.ada });
    assert.ok([200, 201].includes(claim.status), JSON.stringify(claim.body));
    assert.equal(claim.body.holder, 'ada', 'a claim is held by the credential\'s seat, whatever the body said');

    const roleAsAct = await api(srv.baseUrl, 'POST', '/api/roles', { body: { by: 'ada', key: 'scribe', name: 'Scribe', definition: 'Writes the minutes and keeps them where the room can find them.', definedBy: 1 }, token: t.ada });
    assert.equal(roleAsAct.status, 403); assert.equal(roleAsAct.body.code, 'SCOPE_INSUFFICIENT');
    const roleAsAdmin = await api(srv.baseUrl, 'POST', '/api/roles', { body: { by: 'owner', key: 'scribe', name: 'Scribe', definition: 'Writes the minutes and keeps them where the room can find them.', definedBy: 1 }, token: t.admin });
    assert.equal(roleAsAdmin.status, 201, JSON.stringify(roleAsAdmin.body));

    const h2 = await api(srv.baseUrl, 'GET', '/api/health');
    assert.ok(h2.body.auth.refused >= 5, `refusals are counted where the room looks: ${JSON.stringify(h2.body.auth)}`);

    const log = srv.stderr();
    for (const [name, v] of Object.entries(t)) assert.equal(log.includes(v), false, `the ${name} bearer must never reach a log line`);
  } finally { await srv.stop(); }
});

// ── the seam: MCP door + inherited credential ────────────────────────────────

test('#1343 served (required, MCP) — initialize without a bearer is refused at the door; with an act bearer the session binds and a tool call reaches REST carrying that credential (inherited, never re-declared)', async () => {
  const { file, t } = tokensFile();
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: 'required' } });
  let mcp;
  try {
    mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_SEAT_TOKENS: file, SCRUM_AUTH: 'required' } });
    const mcpUrl = `${mcp.baseUrl}/mcp`;
    await assert.rejects(() => mcpSession(mcpUrl), /401|no mcp-session-id/, 'no bearer: no session');
    await assert.rejects(() => mcpSession(mcpUrl, { headers: { Authorization: `Bearer ${t.expired}` } }), /401|no mcp-session-id/, 'an expired bearer: no session');
    const s = await mcpSession(mcpUrl, { headers: { Authorization: `Bearer ${t.ada}` } });
    const posted = await s.callTool('conversation_post', { author: 'bo', body: 'through the adapter, bound ada' });
    assert.equal(posted.error, undefined, JSON.stringify(posted).slice(0, 300));
    assert.notEqual(posted.result?.isError, true, JSON.stringify(posted).slice(0, 300));
    const list = await api(rest.baseUrl, 'GET', '/api/conversations?limit=5', { token: t.read });
    const rows = Array.isArray(list.body) ? list.body : list.body.messages;
    const mine = rows.find((r) => /through the adapter/.test(r.body));
    assert.ok(mine, JSON.stringify(rows).slice(0, 300));
    assert.equal(mine.author, 'ada', 'REST asserted the actor from the credential the adapter forwarded');
    assert.equal(mine.onBehalfOf, 'bo');
    const health = await (await fetch(`${mcp.baseUrl}/health`)).json();
    assert.equal(health.auth?.mode, 'required');
    assert.equal(health.auth.credentials, 5);
    // the adapter re-reads the file too: a seat minted now can open a session ≤ 2 s later, no restart
    const minted = script(['mint', '--seat', 'late', '--scope', 'act', '--file', file, '--by', 'test']);
    assert.equal(minted.status, 0, minted.stderr);
    await new Promise((r) => setTimeout(r, 2300));
    const late = await mcpSession(mcpUrl, { headers: { Authorization: `Bearer ${minted.stdout.trim()}` } });
    assert.ok(late.sessionId, 'the late-minted seat has a session');
    assert.equal((await (await fetch(`${mcp.baseUrl}/health`)).json()).auth.credentials, 6);
    const log = mcp.stderrText() + mcp.stdoutText();
    for (const [name, v] of Object.entries(t)) assert.equal(log.includes(v), false, `the ${name} bearer must never reach the adapter's log`);
  } finally { if (mcp) await mcp.stop(); await rest.stop(); }
});

// ── the mint script ──────────────────────────────────────────────────────────


test('#1343 scripts/credential.mjs — mint prints the plaintext ONCE and stores the hash; --write-runner-file writes 0600 and prints nothing; list names seats and scopes and never a value; revoke is an event; migrate rewrites a #703 file in place', () => {
  const file = tmpFile('seat-tokens.json', { seats: { old: { token: mintToken(), heartbeat_s: 30 } } });
  const runner = path.join(path.dirname(file), 'private', 'guest.token');

  const m = script(['mint', '--seat', 'ada', '--scope', 'act', '--file', file, '--by', 'test', '--note', 'terminal']);
  assert.equal(m.status, 0, m.stderr);
  const plain = m.stdout.trim();
  assert.match(plain, /^mh_[A-Za-z0-9_-]{43}$/, 'stdout is the token and nothing else, so it can be piped');
  let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.seats.ada.credentials[0].tokenHash, hashToken(plain));
  assert.equal(doc.seats.ada.credentials[0].scope, 'act');
  assert.equal(doc.seats.ada.credentials[0].issuedBy, 'test');
  assert.equal(doc.seats.ada.credentials[0].note, 'terminal');
  assert.ok(Date.parse(doc.seats.ada.credentials[0].expiresAt) - Date.now() > 29 * D, 'default expiry 30 d');
  assert.equal(fs.readFileSync(file, 'utf8').includes(plain), false);

  const r = script(['mint', '--seat', 'guest', '--scope', 'act', '--days', '90', '--file', file, '--by', 'test', '--write-runner-file', runner]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'a runner-file mint prints nothing — the value went to the file');
  assert.equal(fs.statSync(runner).mode & 0o777, 0o600);
  const guestPlain = fs.readFileSync(runner, 'utf8').trim();
  assert.match(guestPlain, /^mh_[A-Za-z0-9_-]{43}$/);
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.seats.guest.credentials[0].tokenHash, hashToken(guestPlain));
  assert.ok(Date.parse(doc.seats.guest.credentials[0].expiresAt) - Date.now() > 89 * D);

  const bad = script(['mint', '--seat', 'x', '--scope', 'root', '--file', file, '--by', 'test']);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /scope/);
  const noBy = script(['mint', '--seat', 'x', '--scope', 'act', '--file', file]);
  assert.notEqual(noBy.status, 0); assert.match(noBy.stderr, /--by/);

  const l = script(['list', '--file', file]);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /ada\s+act/); assert.match(l.stdout, /guest\s+act/); assert.match(l.stdout, /old\s+.*plaintext/i);
  assert.equal(l.stdout.includes(plain), false); assert.equal(l.stdout.includes(guestPlain), false);
  assert.equal(TOKEN_SHAPE.test(l.stdout), false);

  const mg = script(['migrate', '--file', file, '--by', 'test']);
  assert.equal(mg.status, 0, mg.stderr);
  assert.match(mg.stdout, /old/);
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.seats.old.token, undefined); assert.equal(doc.seats.old.heartbeat_s, 30); assert.equal(doc.seats.old.credentials.length, 1);
  assert.equal(TOKEN_SHAPE.test(fs.readFileSync(file, 'utf8')), false, 'after migration the file holds no value');
  const mg2 = script(['migrate', '--file', file, '--by', 'test']);
  assert.equal(mg2.status, 0); assert.match(mg2.stdout, /nothing to migrate/i);

  const rv = script(['revoke', '--seat', 'ada', '--file', file, '--by', 'test']);
  assert.equal(rv.status, 0, rv.stderr);
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.seats.ada.credentials.length, 1, 'revocation is an event, not a deletion');
  assert.ok(Date.parse(doc.seats.ada.credentials[0].revokedAt) > 0);
  const creds = loadCredentials(file);
  assert.equal(resolveBearer(`Bearer ${plain}`, creds, { now: new Date().toISOString() }).reason, 'revoked');
  assert.equal(resolveBearer(`Bearer ${guestPlain}`, creds, { now: new Date().toISOString() }).seat, 'guest');
});

test('#1343 SECRET_SHAPES — server.js carries the mh_ shape so the push gate\'s mirror can', () => {
  const src = fs.readFileSync(path.join(PROJECT_DIR, 'server.js'), 'utf8');
  assert.match(src, /mh_\[A-Za-z0-9_-\]\{43\}/, 'SECRET_SHAPES carries the mh_ shape');
});
