/**
 * #1905 done-when 5 — A PERSON SIGNED IN THROUGH THE BROWSER ATTACHES A CLAIM TO A CARD FROM THE READING PAGE.
 *
 * The page's rules live in core/reading-attach.mjs (browser-safe, no node imports, like core/recall-line.mjs), so they are tested
 * here under node; reading.html builds the form and calls them. The world for the I rows is #1906's: a whole board with the
 * log-born unit ON and SCRUM_AUTH empty (observe, as the live board runs), one human seat signed in with a one-time code.
 *
 *   P1  reading.html carries an "Attach to a card" control built from the module, with the reason capped at the server's max
 *   P2  the request is POST /api/links/attach, same-origin credentials, JSON { claim, card, reason } and NO self-chosen identity
 *   P3  the form refuses what the server would refuse, before sending: no card, not a number, no reason, two lines, too long
 *   P4  every answer becomes words a person reads: 201 names the card and the seat the SERVER recorded; 401 says sign in and
 *       points at Settings; any other refusal shows the server's own reason; nothing is ever an empty message
 *   I1  the page's exact request with a signed-in cookie (and the page's Origin) attaches the claim as the human seat (201, the
 *       graph says attachedBy that seat); the same request with no cookie is 401 and the page would say sign in; a cookie
 *       request from a foreign Origin is refused and the page shows the server's reason; nothing is written by a refusal
 *   B1  in a real (headless) browser, by keyboard alone: the control opens its form, focus lands in the card field with a visible
 *       outline; a missing reason is refused on the page; unsigned, the attach says sign in and links to Settings; with the
 *       session cookie it says "Attached to #2 by hu" and the claim's list gains the link; a repeat shows the server's 409 reason
 *
 * No seat name here is a real one: `hu` is the human, `ada` an agent, `board` the system seat.
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
import { withBrowserServer } from './helpers/harness.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { linkIri, spanKey } from '../core/knowledge-linking.mjs';
import { seatActor } from '../core/graph-auth.mjs';
import { ATTACH_REASON_MAX as COMPILER_MAX } from '../core/graph-compiler.mjs';
import { ATTACH_REASON_MAX, attachRequest, checkAttachInput, attachOutcome } from '../core/reading-attach.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'reading.html'), 'utf8');

test('P1 reading.html has an "Attach to a card" control built from core/reading-attach.mjs, the reason capped at the server\'s max', () => {
  assert.equal(ATTACH_REASON_MAX, COMPILER_MAX, 'the page\'s cap is the compiler\'s (core/graph-compiler.mjs), not a guess');
  assert.match(PAGE, /from '\.\/core\/reading-attach\.mjs'/, 'the page imports the module the rows below test');
  assert.match(PAGE, /Attach to a card/, 'the control\'s label');
  assert.match(PAGE, /attachRequest\(/, 'the request is the module\'s, so P2 pins what the page sends');
  assert.match(PAGE, /attachOutcome\(/, 'the answer is the module\'s, so P4 pins what the page shows');
  assert.match(PAGE, /maxLength = ATTACH_REASON_MAX/, 'the reason field cannot take more than the server accepts');
  assert.match(PAGE, /settings\.html#signin-panel/, 'a 401 points at the sign-in panel');
  assert.match(PAGE, /aria-expanded/, 'the control says whether its form is open');
  assert.ok(!/\.innerHTML\b/.test(PAGE), 'still no innerHTML anywhere on the page');
  assert.ok(!/manyhands\.identity/.test(PAGE), 'the self-chosen identity is never read here');
});

test('P2 the request: POST /api/links/attach, same-origin credentials, JSON { claim, card, reason }, no identity', () => {
  const r = attachRequest({ claim: 'abc-123', card: '#12', reason: '  bears on the rule  ' });
  assert.equal(r.url, '/api/links/attach');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.credentials, 'same-origin');
  assert.equal(r.init.headers['content-type'], 'application/json');
  const body = JSON.parse(r.init.body);
  assert.deepEqual(body, { claim: 'abc-123', card: 12, reason: 'bears on the rule' });
  for (const k of ['by', 'onBehalfOf', 'author', 'owner', 'createdBy']) assert.ok(!(k in body), `no ${k}: the server takes the actor from the cookie`);
  assert.ok(!('authorization' in r.init.headers), 'no bearer from a page');
});

test('P3 the form refuses, before sending, what the server would refuse', () => {
  const ok = { card: '7', reason: 'one line' };
  assert.equal(checkAttachInput(ok), null);
  assert.equal(checkAttachInput({ card: '#7', reason: 'one line' }), null, 'a leading # is the way cards are written');
  assert.match(checkAttachInput({ ...ok, card: '' }), /card number/i);
  assert.match(checkAttachInput({ ...ok, card: 'seven' }), /card number/i);
  assert.match(checkAttachInput({ ...ok, card: '0' }), /card number/i);
  assert.match(checkAttachInput({ ...ok, card: '1.5' }), /card number/i);
  assert.match(checkAttachInput({ ...ok, reason: '   ' }), /reason/i);
  assert.match(checkAttachInput({ ...ok, reason: 'two\nlines' }), /one line/i);
  assert.match(checkAttachInput({ ...ok, reason: 'x'.repeat(ATTACH_REASON_MAX + 1) }), new RegExp(String(ATTACH_REASON_MAX)));
  assert.equal(checkAttachInput({ ...ok, reason: 'x'.repeat(ATTACH_REASON_MAX) }), null, 'exactly the max is accepted');
});

test('P4 every answer is words: success names the seat the server recorded; 401 says sign in; a refusal shows the server\'s reason', () => {
  const done = attachOutcome(201, { id: 'l1', card: 7, claim: 'c', reason: 'r', by: 'alice' });
  assert.equal(done.ok, true);
  assert.equal(done.text, 'Attached to #7 by alice');
  const anon = attachOutcome(401, { error: 'graph write refused: AUTH_REQUIRED', code: 'GRAPH_WRITE_UNAUTHENTICATED' });
  assert.equal(anon.ok, false);
  assert.equal(anon.signIn, true);
  assert.match(anon.text, /^Sign in this browser first \(Settings page\)/);
  const exists = attachOutcome(409, { error: 'this claim is already linked to card 7, as link l1: view it there', code: 'LINK_EXISTS', id: 'l1' });
  assert.equal(exists.ok, false);
  assert.match(exists.text, /already linked to card 7/);
  assert.equal(exists.signIn, false);
  const csrf = attachOutcome(403, { error: 'a write from a signed-in browser must come from this board\'s own pages', code: 'CSRF_ORIGIN' });
  assert.match(csrf.text, /own pages/);
  const off = attachOutcome(503, { error: 'links are off', code: 'LINKS_UNAVAILABLE' });
  assert.match(off.text, /links are off/);
  for (const [s, b] of [[500, null], [502, 'not json'], [400, {}], [201, null], [201, { card: 7 }]]) {
    const o = attachOutcome(s, b);
    assert.ok(typeof o.text === 'string' && o.text.trim().length > 0, `never an empty message (${s} ${JSON.stringify(b)})`);
  }
  assert.equal(attachOutcome(500, null).ok, false);
  assert.match(attachOutcome(500, null).text, /500/, 'a bodiless refusal still says what the board answered');
  assert.equal(attachOutcome(201, null).ok, false, 'a 201 that names no card is not shown as an attachment it cannot describe');
});

// ── I1: the page's request against a whole board ────────────────────────────────────────────────────────────────────────
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SCRIPT = path.join(ROOT, 'scripts', 'browser-signin-code.mjs');
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'rap1905-fix-'));
const ROSTER = path.join(FIX, 'roster.json');
fs.writeFileSync(ROSTER, JSON.stringify({ seats: {
  hu: { name: 'Hu', glyph: 'h', color: '#c4a07c', kind: 'human' },
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' },
} }));
const TOKENS = path.join(FIX, 'seat-tokens.json');
fs.writeFileSync(TOKENS, JSON.stringify({ seats: {} }));

let w, base, store, gc;
before(async () => {
  if (SKIP) return;
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' } });
  base = w.rest.baseUrl;
  store = path.join(path.dirname(w.boardFile), 'browser-sessions.json');
  gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'rap1905' });
});
after(async () => {
  if (w) await w.stop();
  fs.rmSync(FIX, { recursive: true, force: true });
});

function mint(seat) {
  const r = spawnSync(process.execPath, [SCRIPT, '--seat', seat, '--file', store, '--roster', ROSTER], { encoding: 'utf8', env: { ...process.env, SCRUM_BROWSER_SESSIONS: '', SCRUM_DATA_DIR: '', SCRUM_ROSTER_FILE: '' } });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout || '').trim();
}
async function signIn(seat) {
  const r = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code: mint(seat) }) });
  assert.equal(r.status, 201, await r.text());
  const line = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mh_session='));
  assert.ok(line, 'a session cookie');
  return line.slice('mh_session='.length).split(';')[0];
}
/** The page's own request, as a browser sends it from this board's page: the module's init, plus what the browser adds. */
async function pageAttach(input, { cookie, origin = base } = {}) {
  const { url, init } = attachRequest(input);
  const headers = { ...init.headers };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = `mh_session=${cookie}`;
  const r = await fetch(`${base}${url}`, { ...init, headers });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body, shown: attachOutcome(r.status, body) };
}
async function seedClaim() {
  const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  const span = `a claim a person read ${assertion}`;
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA { <${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} . }` });
  assert.equal(res.status, 200, await res.text());
  return { assertion, span, id: assertion.split('/').pop() };
}
const attachedBy = async (link) => (await gc.query(`SELECT ?by WHERE { <${link}> a <${RS}BearsOn> ; <${RS}attachedBy> ?by }`)).rows.map((x) => x.by.value);

test('I1 the page\'s request: signed in, it attaches as the human seat; anonymous is 401 "sign in"; a foreign origin is refused in words', T, async () => {
  const c = await seedClaim();
  const link = linkIri(spanKey(c.span, 'uuid-2'));
  const input = { claim: c.id, card: '2', reason: 'a person read this and it bears on card 2' };

  const anon = await pageAttach(input);
  assert.equal(anon.status, 401, JSON.stringify(anon.body));
  assert.equal(anon.shown.signIn, true, 'the page would say: sign in this browser first');
  assert.deepEqual(await attachedBy(link), [], 'nothing written');

  const cookie = await signIn('hu');
  const foreign = await pageAttach(input, { cookie, origin: 'http://attacker.example' });
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  assert.equal(foreign.shown.ok, false);
  assert.equal(foreign.shown.text, foreign.body.error, 'the server\'s reason, shown as it gave it');
  assert.deepEqual(await attachedBy(link), [], 'nothing written');

  const ok = await pageAttach(input, { cookie });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.by, 'hu', 'the server says who it recorded');
  assert.equal(ok.shown.text, 'Attached to #2 by hu');
  assert.deepEqual(await attachedBy(link), [seatActor('hu')], 'the graph records the cookie\'s seat, from proof');

  const again = await pageAttach(input, { cookie });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.match(again.shown.text, /already linked to card 2/, 'a second attach of the same pair is shown, not swallowed');
});

/** One extraction run with one claim, as core/knowledge-reading.mjs reads it (the shape tests/knowledge-reading-rest-1894 seeds). */
async function seedRun() {
  const u = () => crypto.randomUUID();
  const hex = crypto.createHash('sha256').update(u()).digest('hex');
  const run = `https://scrumboard.local/activity/run-${u()}`;
  const src = `https://scrumboard.local/source/${hex}`;
  const a = `https://scrumboard.local/assertion/${u()}`;
  const S = 'https://schema.org/'; const PROV = 'http://www.w3.org/ns/prov#';
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${u()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA {
      <${src}> <${RDF}type> <${RS}SourceVersion> ; <${RS}contentHash> "sha256:${hex}" ; <${S}url> "https://example.com/a" ; <${S}name> "A source" .
      <${run}> <${RDF}type> <${PROV}Activity> ; <${RS}op> "extract" ; <${PROV}used> <${src}> ; <${PROV}startedAtTime> "2026-11-14T09:59:00.000Z" .
      <${run}/extraction> <${RDF}type> <${RS}ExtractionReport> ; <${RS}ofRun> <${run}> ; <${RS}outcome> "complete" ; <${RS}at> "2026-11-14T10:00:00.000Z" ; <${RS}publishedCount> "1" .
      <${a}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; <${RS}expressedIn> <${src}/block/1> ; <${RS}anchorText> ${JSON.stringify(`the quote ${a}`)} ; <${RS}gist> "The gist." ; <${RS}assertionType> "definition" .
    }` });
  assert.equal(res.status, 200, await res.text());
  return { id: run.split('/').pop(), assertion: a };
}

test('B1 a real browser, keyboard only: open, refuse on the page, 401 says sign in, signed in attaches as hu, a repeat shows the 409', T, async () => {
  const r = await seedRun();
  await withBrowserServer(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${base}/reading.html?run=${r.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.claim .attach-toggle');
    const msg = () => page.$eval('.claim .attach-msg', (n) => ({ text: n.textContent, cls: n.className, href: n.querySelector('a')?.getAttribute('href') ?? null }));
    const state = () => page.evaluate(() => {
      const t = document.querySelector('.claim .attach-toggle'); const f = document.getElementById(t.getAttribute('aria-controls'));
      const a = document.activeElement;
      return { expanded: t.getAttribute('aria-expanded'), hidden: f.hidden, active: a?.id || a?.className || a?.tagName, outline: getComputedStyle(a).outlineStyle };
    });
    const settled = () => page.waitForFunction(() => { const b = document.querySelector('.claim .attach-go'); const m = document.querySelector('.claim .attach-msg'); return b && !b.disabled && m && m.textContent.trim(); });

    // reach the control by Tab, open it with Enter
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('attach-toggle'))) break;
    }
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Attach to a card', 'the control is reachable by Tab');
    assert.equal((await state()).outline, 'solid', 'a visible focus ring on the control');
    await page.keyboard.press('Enter');
    let s = await state();
    assert.equal(s.expanded, 'true'); assert.equal(s.hidden, false);
    assert.match(s.active, /-card$/, 'focus moves into the card field');
    assert.equal(s.outline, 'solid', 'and it shows');

    // the page refuses a missing reason itself
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    assert.match((await msg()).text, /Give a reason/);

    // unsigned: the board refuses 401, and the page says sign in, with a link to the Settings panel
    await page.keyboard.press('Tab');
    await page.keyboard.type('a person read this and it bears on card 2');
    await page.keyboard.press('Enter');
    await settled();
    let m = await msg();
    assert.match(m.text, /^Sign in this browser first \(Settings page\)/);
    assert.equal(m.href, 'settings.html#signin-panel');
    assert.match(m.cls, /\bbad\b/);

    // signed in (the cookie the Settings page would have set): the same submit attaches, as the seat the board recorded
    const cookie = await signIn('hu');
    await page.setCookie({ name: 'mh_session', value: cookie, url: base, httpOnly: true, sameSite: 'Strict' });
    await page.click('.claim .attach-go');
    await settled();
    m = await msg();
    assert.equal(m.text, 'Attached to #2 by hu', JSON.stringify(m));
    s = await state();
    assert.equal(s.hidden, true, 'the form closes'); assert.equal(s.expanded, 'false');
    assert.equal(s.active, 'attach-toggle', 'focus returns to the control');
    const bears = await page.$$eval('.claim .bears li', (ls) => ls.map((l) => l.textContent));
    assert.ok(bears.some((t) => /#2/.test(t) && /proposed/.test(t) && /attached by hu/.test(t)), JSON.stringify(bears));
    const link = linkIri(spanKey(`the quote ${r.assertion}`, 'uuid-2'));
    assert.deepEqual(await attachedBy(link), [seatActor('hu')], 'the graph records the cookie\'s seat');

    // a repeat: the server's 409, in its words
    await page.keyboard.press('Enter');
    await page.keyboard.type('2');
    await page.keyboard.press('Tab');
    await page.keyboard.type('again');
    await page.keyboard.press('Enter');
    await settled();
    m = await msg();
    assert.match(m.text, /already linked to card 2/);
    assert.match(m.cls, /\bbad\b/);
  }, { _startServer: async () => ({ baseUrl: base, stop: async () => {} }), launch: { headless: 'new' } });
});
