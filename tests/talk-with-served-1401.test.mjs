/**
 * #1401 — "Talk with…": a 1:1 is a VIEW over the commons, not a container.
 *
 * The owner's ruling, 2026-09-17 13:36Z: "each post maybe gets tagged with a
 * 1:1 conversation attribute, but the rest of the room sees the messages
 * flowing in like any others… they are tagged so we can filter… cards are not
 * a prerequisite." So: a talk is a small node (title · with · opener); posts
 * stay board-level and carry `conversation: <talk id>`; `?conversation=<id>`
 * filters like a seat solo; the seat's reply defaults to the tag it was handed.
 *
 * The card's TEST, verbatim: served commons → Talk with → guest seat → post →
 * the post is board-level with conversation=<id> → the REAL guest runner's
 * reply carries the same tag → the view shows both and nothing else → the
 * plain commons shows both inline with the room's other posts → filter by
 * tag returns exactly two.
 *
 * Sabotages, distinct profiles: (a) drop the tag from the runner's reply →
 * the view shows ONE post (fails the "both" line); (b) the view ignores the
 * filter → the view shows the room's untagged post (fails "nothing else").
 * Plus the growth control: a talk must appear ONCE in /api/talks after every
 * later write, or the document duplicates it on each save (found on the
 * first smoke — the unmodelled residue re-spread it).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const SEATS = { ada: { name: 'Ada', color: '#7cc4a0' }, pip: { name: 'Pip', color: '#c47c7c' }, wiki: { name: 'Wiki', color: '#999', kind: 'system' } };

function fakeOllama(reply) {
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const list = (b) => (Array.isArray(b) ? b : b.conversations);

test('#1401 served: Talk with → a seat → a tagged board-level post → the real runner replies with the same tag → the view shows both and nothing else → the room shows both inline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-1401-'));
  const rosterFile = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS }));
  const board = makeBoardFixture({ cards: [], conversations: [
    { id: 'noise', author: 'ada', body: 'the room, talking about something else', createdAt: '2026-09-17T12:00:00.000Z', attachedTo: null },
  ] });
  const ollama = await fakeOllama('REPLY: The next sprint is three pulls; the meter lands first.');
  const stateFile = path.join(dir, 'pip.state.json');
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const api = async (method, p, body) => { const r = await fetch(`${server.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
      const c = await api('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are Pip. Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'guest', contextPolicy: 'artifact-only', deliveryMode: 'channel', by: 'ada' });
      assert.equal(c.status, 201, JSON.stringify(c.body));

      const page = await browser.newPage();
      page.on('dialog', async (d) => { await d.accept(); });
      await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });

      // ── the door: header → Talk with… → pick a seat, one line → the view opens ──
      await page.click('#talk-toggle');
      await page.waitForSelector('#talk-form:not([hidden]) #talk-with option', { timeout: 5000 });
      const options = await page.$$eval('#talk-with option', (os) => os.map((o) => o.value));
      assert.ok(options.includes('pip') && options.includes('ada'), `the roster is the seat list: ${options}`);
      assert.ok(!options.includes('wiki'), 'a system seat is not someone to talk with');
      await page.select('#talk-with', 'pip');
      await page.type('#talk-title', 'the next sprint');
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#talk-form button[type=submit]')]);
      const url = new URL(page.url());
      const talkId = url.searchParams.get('conversation');
      assert.ok(talkId, `the view opens on the minted talk: ${page.url()}`);
      const talks = await api('GET', '/api/talks');
      assert.equal(talks.body.talks.length, 1, 'one talk minted');
      assert.equal(talks.body.talks[0].with, 'pip');
      assert.equal(talks.body.talks[0].title, 'the next sprint');

      // ── the view: head first, composer addressed to the seat, the room's noise NOT shown ──
      await page.waitForSelector('#talk-head', { timeout: 5000 });
      assert.match(await page.$eval('#talk-head h2', (e) => e.textContent), /Talk with pip — the next sprint/);
      assert.equal(await page.$eval('.cv-form', (f) => f.dataset.talk), talkId, 'the composer knows its talk');
      assert.equal(await page.$eval('.cv-input', (e) => e.value), '@pip ', 'addressed to the seat');
      assert.equal(await page.$$eval('.cv-msg', (els) => els.length), 0, 'the room\'s untagged post is not in this view');

      // ── the post: board-level, tagged ──
      await page.evaluate(() => { const ta = document.querySelector('.cv-input'); ta.value = '@pip what is in the next sprint?'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('.cv-send');
      await page.waitForFunction(() => document.querySelector('.cv-input')?.value === '', { timeout: 5000 });
      const mine = list((await api('GET', `/api/conversations?conversation=${talkId}`)).body);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].attachedTo, null, 'board-level — no card is a prerequisite');
      assert.equal(mine[0].conversation, talkId, 'carries the tag');

      // ── the wake: the fanout offers the tagged post; the REAL runner answers WITH THE SAME TAG ──
      const offer = await api('POST', '/api/deliveries', { to: 'pip', conversation: mine[0].id, source: 'fanout', by: 'board' });
      assert.equal(offer.status, 201, JSON.stringify(offer.body));
      const r = await runOnce({ SCRUM_BOARD_URL: server.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, 'pip');
      assert.equal(r.code, 0, r.err + r.out);
      const tagged = list((await api('GET', `/api/conversations?conversation=${talkId}`)).body);
      assert.equal(tagged.length, 2, `the runner's reply carries the same tag: ${JSON.stringify(tagged.map((m) => [m.author, m.conversation]))} ${r.out}`);
      assert.equal(tagged[1].author, 'pip');
      assert.equal(tagged[1].attachedTo, null, 'still board-level');

      // ── the view shows both and NOTHING ELSE; the plain room shows both INLINE with the noise ──
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelectorAll('.cv-msg').length === 2, { timeout: 5000 });
      const inView = await page.$$eval('.cv-msg', (els) => els.map((e) => e.dataset.id));
      assert.deepEqual(new Set(inView), new Set(tagged.map((m) => m.id)), 'exactly the two tagged posts, not the room\'s noise');
      await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelectorAll('.cv-msg').length === 3, { timeout: 5000 });
      const inRoom = await page.$$eval('.cv-msg', (els) => els.map((e) => e.dataset.id));
      assert.ok(inRoom.includes('noise') && tagged.every((m) => inRoom.includes(m.id)), 'the room sees the talk inline with everything else');

      // ── growth control: the talk appears ONCE after later writes ──
      await api('POST', '/api/conversations', { author: 'ada', body: 'more room noise' });
      await api('POST', '/api/conversations', { author: 'ada', body: 'and more' });
      assert.equal((await api('GET', '/api/talks')).body.talks.length, 1, 'a talk is not duplicated by unrelated writes (the unmodelled-residue trap)');
      // and a bad tag is refused before anything is written
      const bad = await api('POST', '/api/conversations', { author: 'ada', body: 'x', conversation: 'no-such-talk' });
      assert.equal(bad.status, 400); assert.equal(bad.body.code, 'NO_SUCH_TALK');
    }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } }, launch: { headless: 'new' } });
  } finally { await ollama.stop(); }
});
