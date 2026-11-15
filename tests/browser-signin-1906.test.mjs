/**
 * #1906 — THE OWNER'S BROWSER SIGNS IN WITH A ONE-TIME CODE FROM THE TERMINAL, and gets an HttpOnly session cookie, so a write from
 * the board's pages is recorded as the human seat from proof rather than from a self-chosen body field.
 *
 * One row per "Done when" line on the card (1-7). The world is #1905's (tests/reading-attach-identity-1905.test.mjs at aa10b3f):
 * a whole board with the log-born unit ON and SCRUM_AUTH empty (observe, as the live board runs), a roster that marks one seat
 * `kind: "human"`, one agent seat with an act bearer, and a system seat. The write used throughout is POST /api/memories, a
 * log-born write route at this base (core/graph-auth.mjs LOGBORN_WRITE_ROUTES), whose versions name the writer.
 *
 *   R1  an anonymous browser write is still 401 and writes nothing (a pin of today's behaviour, so it is green before the build)
 *   R2  a valid code gives an HttpOnly, SameSite=Strict cookie; a used, an expired and a wrong code are each refused
 *   R3  a write with the cookie is recorded as the human seat; a body naming another seat is 403 SEAT_NOT_SELF; a bearer and a
 *       cookie naming different seats is refused as ambiguous
 *   R4  a cookie write with a foreign, a wrong-port or a missing Origin (and no Referer) is refused, with nothing written
 *   R5  after sign out the cookie is refused; --revoke-all refuses every session of the seat
 *   R6  no code, session id or hash in a URL, a log line, a board record, the listing, or the page's storage
 *   R7  the mint script refuses a seat the roster does not mark as a human person
 *
 * No seat name here is a real one: `hu` is the human, `ada` the agent, `board` the system seat.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'browser-signin-code.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };

const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'bs1906-fix-'));
const ROSTER = path.join(FIX, 'roster.json');
fs.writeFileSync(ROSTER, JSON.stringify({ seats: {
  hu: { name: 'Hu', glyph: 'h', color: '#c4a07c', kind: 'human' },
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' },
} }));
const TOK = mintToken();
const TOKENS = path.join(FIX, 'seat-tokens.json');
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }

// Every secret this run produces, so R6 can look for each of them (and their hashes) where none may be.
const SECRETS = { codes: [], sessions: [] };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let w, base, dataDir, store;
before(async () => {
  if (SKIP) return;
  // SCRUM_AUTH deliberately empty — observe, as the live board runs. The sessions store is left to its default, in the data folder.
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' } });
  base = w.rest.baseUrl;
  dataDir = path.dirname(w.boardFile);
  store = path.join(dataDir, 'browser-sessions.json');
});
after(async () => {
  if (w) await w.stop();
  fs.rmSync(FIX, { recursive: true, force: true });
});

/** The mint script, as the person at the terminal runs it, against THIS world's files (never the default). */
function mint(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--file', store, '--roster', ROSTER], { encoding: 'utf8', env: { ...process.env, SCRUM_BROWSER_SESSIONS: '', SCRUM_DATA_DIR: '', SCRUM_ROSTER_FILE: '' } });
  const code = (r.stdout || '').trim();
  if (r.status === 0 && code) SECRETS.codes.push(code);
  return { status: r.status, code, stderr: r.stderr || '' };
}
const memory = (title, extra = {}) => ({ owner: 'hu', title, body: 'b', ...extra });
const titles = async () => { const b = await (await fetch(`${base}/api/memories`)).json(); return (Array.isArray(b) ? b : b?.memories ?? []).map((m) => m.title); };
/** A same-origin browser write: JSON, the page's own Origin, the cookie if there is one. */
async function write(method, route, body, { cookie, origin, referer, bearer } = {}) {
  const headers = { 'content-type': 'application/json' };
  const o = origin === undefined ? base : origin;
  if (o !== null) headers.origin = o;
  if (referer) headers.referer = referer;
  if (cookie) headers.cookie = `mh_session=${cookie}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
/** Exchange a code for a session; returns the cookie VALUE (never printed) and the Set-Cookie line. */
async function signIn(code, { origin } = {}) {
  const r = await write('POST', '/api/session', { code }, { origin });
  const line = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mh_session=')) ?? null;
  const value = line ? line.slice('mh_session='.length).split(';')[0] : null;
  if (value) SECRETS.sessions.push(value);
  return { ...r, line, value };
}

test('R1 an anonymous browser write is still 401, and nothing is written', T, async () => {
  const r = await write('POST', '/api/memories', memory('r1-anon', { by: 'hu' }));
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.equal(r.body.code, 'GRAPH_WRITE_UNAUTHENTICATED');
  assert.equal(r.body.reason, 'AUTH_REQUIRED');
  const forged = await write('POST', '/api/memories', memory('r1-forged', { by: 'hu' }), { cookie: crypto.randomBytes(32).toString('base64url') });
  assert.equal(forged.status, 401, `a session id the board never issued is no credential: ${JSON.stringify(forged.body)}`);
  const t = await titles();
  assert.ok(!t.includes('r1-anon') && !t.includes('r1-forged'), 'nothing stored');
});

test('R2 a valid code gives an HttpOnly, SameSite=Strict cookie; a used, an expired and a wrong code are each refused', T, async () => {
  const m = mint(['--seat', 'hu']);
  assert.equal(m.status, 0, `the script mints for a human seat: ${m.stderr}`);
  assert.match(m.code, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/, 'a 26-character readable code, grouped');
  const s = await signIn(m.code);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.seat, 'hu');
  assert.ok(s.line, 'a Set-Cookie for mh_session');
  const attrs = s.line.split(';').map((x) => x.trim().toLowerCase());
  assert.ok(attrs.includes('httponly'), `HttpOnly: ${attrs.slice(1).join('; ')}`);
  assert.ok(attrs.includes('samesite=strict'), 'SameSite=Strict');
  assert.ok(attrs.includes('path=/'), 'Path=/');
  assert.ok(!attrs.some((a) => a.startsWith('domain=')), 'host-only: no Domain');
  assert.ok(!attrs.includes('secure'), 'no Secure: the board is plain http on loopback (documented on the card)');
  assert.match(s.value, /^[A-Za-z0-9_-]{43}$/, 'a 256-bit session id');

  const used = await signIn(m.code);
  assert.equal(used.status, 401, 'a used code is refused');
  assert.equal(used.body.code, 'CODE_USED');
  assert.equal(used.line, null, 'and sets no cookie');

  const wrong = await signIn('AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA');
  assert.equal(wrong.status, 401, 'a wrong code is refused');
  assert.equal(wrong.body.code, 'CODE_UNKNOWN');

  // An expired code: minted, then aged on disk past its ten minutes (a fixture edit to the test's own store, by hash only).
  const e = mint(['--seat', 'hu']);
  assert.equal(e.status, 0, e.stderr);
  const doc = JSON.parse(fs.readFileSync(store, 'utf8'));
  const norm = e.code.replace(/-/g, '');
  const row = doc.codes.find((c) => c.codeHash === sha(norm));
  assert.ok(row, 'the store holds the code by its hash');
  row.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(store, JSON.stringify(doc));
  const expired = await signIn(e.code);
  assert.equal(expired.status, 401, 'an expired code is refused');
  assert.equal(expired.body.code, 'CODE_EXPIRED');
  assert.equal(expired.line, null);

  const foreign = await signIn(mint(['--seat', 'hu']).code, { origin: 'http://attacker.example' });
  assert.equal(foreign.status, 403, 'a sign-in posted from another origin is refused (login CSRF)');
  assert.equal(foreign.line, null);
});

test('R3 a write with the cookie is recorded as the human seat; another seat\'s `by` is 403; a bearer for another seat is ambiguous', T, async () => {
  const s = await signIn(mint(['--seat', 'hu']).code);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const ok = await write('POST', '/api/memories', memory('r3-cookie', { by: 'hu' }), { cookie: s.value });
  assert.ok(ok.status === 200 || ok.status === 201, JSON.stringify(ok.body));
  const v = await (await fetch(`${base}/api/memories/${ok.body.id}/versions`)).json();
  const first = (v?.versions ?? v ?? [])[0];
  assert.equal(first?.author, 'hu', `recorded as the cookie's seat: ${JSON.stringify(v)}`);
  const noBy = await write('POST', '/api/memories', memory('r3-noby'), { cookie: s.value });
  assert.ok(noBy.status === 200 || noBy.status === 201, `a body with no by is the cookie's seat: ${JSON.stringify(noBy.body)}`);

  const other = await write('POST', '/api/memories', memory('r3-as-ada', { by: 'ada' }), { cookie: s.value });
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.equal(other.body.code, 'SEAT_NOT_SELF');
  const otherSeat = await write('PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 86400_000).toISOString() }, { cookie: s.value });
  assert.equal(otherSeat.status, 403, `#1569 seat-self holds for the cookie too: ${JSON.stringify(otherSeat.body)}`);
  assert.equal(otherSeat.body.code, 'SEAT_NOT_SELF');

  const both = await write('POST', '/api/memories', memory('r3-both', { by: 'ada' }), { cookie: s.value, bearer: TOK });
  assert.equal(both.status, 401, `a bearer for ada and a cookie for hu on one request: ${JSON.stringify(both.body)}`);
  assert.equal(both.body.code, 'AUTH_AMBIGUOUS');
  const t = await titles();
  assert.ok(t.includes('r3-cookie'));
  assert.ok(!t.includes('r3-as-ada') && !t.includes('r3-both'), 'nothing stored for the refused writes');
});

test('R3b a cookie write naming another seat as `owner` or `createdBy` is 403 SEAT_NOT_SELF, nothing written', T, async () => {
  const s = await signIn(mint(['--seat', 'hu']).code);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const owned = await write('POST', '/api/memories', memory('r3b-owner-ada', { owner: 'ada' }), { cookie: s.value });
  assert.equal(owned.status, 403, `a memory owned by another seat: ${JSON.stringify(owned.body)}`);
  assert.equal(owned.body.code, 'SEAT_NOT_SELF');
  const card = await write('POST', '/api/cards', { title: 'r3b-createdBy-ada', createdBy: 'ada' }, { cookie: s.value });
  assert.equal(card.status, 403, `a card credited to another seat: ${JSON.stringify(card.body)}`);
  assert.equal(card.body.code, 'SEAT_NOT_SELF');
  const mine = await write('POST', '/api/cards', { title: 'r3b-createdBy-self', createdBy: 'hu' }, { cookie: s.value });
  assert.ok(mine.status === 200 || mine.status === 201, `CONTROL: crediting itself is accepted: ${JSON.stringify(mine.body)}`);
  assert.ok(!(await titles()).includes('r3b-owner-ada'), 'the refused memory was not stored');
});

test('R4 a cookie write with a foreign, wrong-port or missing Origin is refused, with nothing written', T, async () => {
  const s = await signIn(mint(['--seat', 'hu']).code);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const port = new URL(base).port;
  const cases = [
    ['foreign', { origin: 'http://attacker.example' }],
    ['wrong-port', { origin: `http://127.0.0.1:${Number(port) === 65535 ? 1 : Number(port) + 1}` }],
    ['bare-loopback', { origin: 'http://localhost' }],
    ['null', { origin: 'null' }],
    ['missing', { origin: null }],
    ['foreign-referer', { origin: null, referer: 'http://attacker.example/page' }],
  ];
  for (const [name, h] of cases) {
    const r = await write('POST', '/api/memories', memory(`r4-${name}`, { by: 'hu' }), { cookie: s.value, ...h });
    assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'CSRF_ORIGIN', name);
  }
  const ct = await fetch(`${base}/api/seats/hu/state`, { method: 'DELETE', headers: { origin: base, cookie: `mh_session=${s.value}` } });
  assert.equal(ct.status, 415, 'a cookie write must be application/json, DELETE included');
  const viaReferer = await write('POST', '/api/memories', memory('r4-referer-ok', { by: 'hu' }), { cookie: s.value, origin: null, referer: `${base}/settings.html` });
  assert.ok(viaReferer.status === 200 || viaReferer.status === 201, `CONTROL: the board's own Referer stands in for a missing Origin: ${JSON.stringify(viaReferer.body)}`);
  const t = await titles();
  for (const [name] of cases) assert.ok(!t.includes(`r4-${name}`), `nothing stored for ${name}`);
  // the check is for COOKIE writes only: a seat's bearer write from a terminal (no Origin) is unchanged
  const seat = await write('POST', '/api/memories', { owner: 'ada', title: 'r4-bearer', body: 'b', by: 'ada' }, { origin: null, bearer: TOK });
  assert.ok(seat.status === 200 || seat.status === 201, JSON.stringify(seat.body));
});

test('R5 after sign out the cookie is refused, and --revoke-all refuses every session', T, async () => {
  const s = await signIn(mint(['--seat', 'hu']).code);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const out = await write('DELETE', '/api/session', undefined, { cookie: s.value });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const cleared = (out.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mh_session='));
  assert.ok(cleared && /max-age=0/i.test(cleared), `the cookie is cleared: ${cleared}`);
  const after1 = await write('POST', '/api/memories', memory('r5-after-signout', { by: 'hu' }), { cookie: s.value });
  assert.equal(after1.status, 401, JSON.stringify(after1.body));

  const a = await signIn(mint(['--seat', 'hu']).code);
  const b = await signIn(mint(['--seat', 'hu']).code);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const live = await write('POST', '/api/memories', memory('r5-live', { by: 'hu' }), { cookie: a.value });
  assert.ok(live.status === 200 || live.status === 201, 'CONTROL: live before the revoke');
  const rv = mint(['--revoke-all', '--seat', 'hu']);
  assert.equal(rv.status, 0, rv.stderr);
  assert.equal(rv.code, '', 'revoking prints no code');
  for (const [name, c] of [['a', a.value], ['b', b.value]]) {
    const r = await write('POST', '/api/memories', memory(`r5-revoked-${name}`, { by: 'hu' }), { cookie: c });
    assert.equal(r.status, 401, `${name}: ${JSON.stringify(r.body)}`);
  }
  const t = await titles();
  assert.ok(t.includes('r5-live'));
  for (const n of ['r5-after-signout', 'r5-revoked-a', 'r5-revoked-b']) assert.ok(!t.includes(n), n);
});

test('R6 no code, session id or hash appears in a URL, a log line, a board record, the listing or the page\'s storage', T, async () => {
  // one more of each, so the row stands alone, and a refused exchange (the body of a refusal is the classic leak)
  const s = await signIn(mint(['--seat', 'hu']).code);
  assert.equal(s.status, 201);
  assert.equal((await signIn('BBBBB-BBBBB-BBBBB-BBBBB-BBBBBB')).status, 401);
  SECRETS.codes.push('BBBBB-BBBBB-BBBBB-BBBBB-BBBBBB');
  const list = await (await fetch(`${base}/api/sessions`, { headers: { cookie: `mh_session=${s.value}` } })).json();
  assert.ok(Array.isArray(list.sessions) && list.sessions.some((x) => x.seat === 'hu'), JSON.stringify(list));
  assert.equal(list.thisBrowser?.seat, 'hu', 'the listing says who this browser is signed in as');
  assert.ok(Array.isArray(list.events) && list.events.some((e) => e.op === 'code-minted') && list.events.some((e) => e.op === 'session-started'), 'mints and session starts are visible');

  const needles = [];
  for (const c of SECRETS.codes) { const n = c.replace(/-/g, ''); needles.push(c, n, sha(n)); }
  for (const id of SECRETS.sessions) needles.push(id, sha(id));
  assert.ok(SECRETS.sessions.length >= 5 && SECRETS.codes.length >= 8, `the run produced secrets to look for (${SECRETS.codes.length} codes, ${SECRETS.sessions.length} sessions)`);
  const hits = (where, text) => needles.filter((n) => text.includes(n)).map(() => where);

  const found = [];
  found.push(...hits('the listing', JSON.stringify(list)));
  found.push(...hits('server stderr', w.rest.stderr()));
  found.push(...hits('server stdout', w.rest.stdout ? w.rest.stdout() : ''));
  // the whole data folder: board, event log, events, every sidecar. The store itself may hold HASHES (that is its job), never a value.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(dataDir);
  assert.ok(files.includes(store), 'the store is in the data folder');
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'latin1'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }   // a writer's transient lock or temp file
    if (f === store) { found.push(...needles.filter((n) => !/^[0-9a-f]{64}$/.test(n) && text.includes(n)).map(() => 'the store (a value)')); continue; }
    found.push(...hits(path.relative(dataDir, f), text));
  }
  assert.deepEqual(found, [], `a secret was found in: ${[...new Set(found)].join(', ')}`);
  if ((fs.statSync(store).mode & 0o077) !== 0) assert.fail(`the store is readable by others: ${(fs.statSync(store).mode & 0o777).toString(8)}`);

  // the page: the code goes in a JSON body, never a URL (no name on the input, a POST form), and the page stores nothing
  const html = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
  const block = html.slice(html.indexOf('<!-- #1906'), html.indexOf('<!-- /#1906 -->'));
  assert.ok(block.length > 100, 'the sign-in block is marked in settings.html');
  const input = block.match(/<input[^>]*id="signin-code"[^>]*>/)?.[0];
  assert.ok(input, 'the code input');
  assert.ok(!/\bname=/.test(input), 'the code input has no name, so no form submission can carry it');
  assert.match(block, /<form[^>]*id="signin-form"[^>]*method="post"/, 'and its form is a POST');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(block), 'the sign-in block never touches browser storage or the cookie');

  // the run's own output, for the shell to scan afterwards (only when asked, and only into a path the caller chose)
  if (process.env.BS1906_SECRETS_OUT) fs.writeFileSync(process.env.BS1906_SECRETS_OUT, needles.join('\n') + '\n', { mode: 0o600 });
});

test('R7 the mint script refuses a seat the roster does not mark as a human person', T, async () => {
  const before = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')).codes?.length ?? 0 : 0;
  for (const seat of ['ada', 'board', 'nobody']) {
    const r = mint(['--seat', seat]);
    assert.notEqual(r.status, 0, `${seat} is refused`);
    assert.equal(r.code, '', `${seat}: nothing on stdout`);
    assert.match(r.stderr, /not marked as a human person|not in the roster/, seat);
  }
  const afterN = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')).codes?.length ?? 0 : 0;
  assert.equal(afterN, before, 'no code row was written');
  // and the server refuses to start a session for a seat the live roster no longer marks human (the script's check is not the only one)
  const m = mint(['--seat', 'hu']);
  const r0 = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
  fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ...r0.seats, hu: { ...r0.seats.hu, kind: undefined } } }));
  try {
    const s = await signIn(m.code);
    assert.equal(s.status, 403, JSON.stringify(s.body));
    assert.equal(s.body.code, 'SEAT_NOT_HUMAN');
    assert.equal(s.line, null);
  } finally { fs.writeFileSync(ROSTER, JSON.stringify(r0)); }
});

test('R8 the honest limit is written on the settings page and in the script\'s --help', () => {
  const sentence = /Anyone with a shell on this machine can run the mint script, and that includes the AI seats\./;
  assert.match(fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8'), sentence);
  // the page also says what signing in is NOT: it proves who writes; it is not a protected board (#1343's boundary is separate)
  assert.match(fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8'), /it does not password-protect the board or disable anonymous REST\/MCP access/);
  const h = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, sentence);
});

test('R9 the events file keeps only the last 1,000 lines', async () => {
  const { appendSessionEvent, eventsPathFor, EVENTS_KEPT } = await import('../core/browser-sessions.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs1906-ev-'));
  try {
    const st = path.join(d, 'browser-sessions.json');
    for (let i = 0; i < EVENTS_KEPT + 5; i++) appendSessionEvent(st, { op: 'code-refused', reason: `n${i}` });
    const lines = fs.readFileSync(eventsPathFor(st), 'utf8').split('\n').filter(Boolean);
    assert.equal(EVENTS_KEPT, 1000);
    assert.equal(lines.length, EVENTS_KEPT);
    assert.equal(JSON.parse(lines.at(-1)).reason, `n${EVENTS_KEPT + 4}`, 'the newest is kept');
    assert.equal(JSON.parse(lines[0]).reason, 'n5', 'the oldest five are gone');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
