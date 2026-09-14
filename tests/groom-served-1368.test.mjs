/**
 * #1368 — grooming happens ON the board. The card's own TEST:
 *
 *   Post "Groom this" on a card as the owner → the PO seat's runner sees a
 *   wake for that comment (real runner, fake model) → its reply lands
 *   ATTACHED TO THE CARD → a "ruling" from a comment creates a decision
 *   constraining the card, readable on the card.
 *
 * The PO here is a resident in channel mode (the shape the guest runner
 * serves); the fanout's offer is made the way mcp-server makes it (POST
 * /api/deliveries), then the real scripts/guest-once.mjs runs against a fake
 * Ollama. For an MCP-stream PO the wake is the fanout itself (chat_id = the
 * card), which the MCP suites already cover; nothing new there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeBoardFixture, startRestServer, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title, description = '') => ({
  id: `c${shortId}`, shortId, title, description, type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts, version: 1,
});
const SEATS = { ada: { name: 'Ada', color: '#7cc4a0' }, pip: { name: 'Pip', color: '#c47c7c' } };

function fakeOllama(reply) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: raw });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ calls, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#1368 served: Groom this → PO mentioned and focused → the PO runner answers IN the thread → a ruling becomes a decision on the card', async () => {
  const rosterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'groom-')), 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS, roles: { po: 'pip' } }));
  const board = makeBoardFixture({ cards: [card(1, 'the card being groomed', 'what exists')], nextShortId: 2 });
  const ollama = await fakeOllama('REPLY: Start with the read path; the write path is a sibling card.');
  const stateFile = path.join(path.dirname(rosterFile), 'pip.state.json');
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const api = async (method, p, body) => { const r = await fetch(`${server.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
      // the PO is a resident in channel mode, served by the guest runner
      const c = await api('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are the PO. Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'guest', contextPolicy: 'artifact-only', deliveryMode: 'channel', by: 'ada' });
      assert.equal(c.status, 201, JSON.stringify(c.body));

      const page = await browser.newPage();
      page.on('dialog', async (d) => { await d.accept(); });

      // ── the door: pop-out → Groom this ──
      await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.board-header', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('.card[data-id="c1"]').click());
      await page.waitForSelector('#card-detail-backdrop:not([hidden]) #card-detail', { timeout: 5000 });
      const door = await page.$eval('#card-detail .card-detail-groom', (a) => a.getAttribute('href'));
      assert.equal(door, 'commons.html?node=c1&groom=1', 'SURFACE pop-out: the grooming door');
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#card-detail .card-detail-groom')]);

      // ── the thread: composer focused, PO mentioned, from the ROSTER not a constant ──
      await page.waitForSelector('.cv-form[data-groom="1"] .cv-input', { timeout: 5000 });
      assert.equal(await page.$eval('.cv-input', (e) => e.value), '@pip ', 'the PO seat from roles.po is mentioned');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('cv-input')), true, 'and the composer has focus');
      await page.evaluate(() => { const ta = document.querySelector('.cv-input'); ta.value = '@pip Groom this: where do I start — the read path or the write path?'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('.cv-send');
      await page.waitForFunction(() => document.querySelector('.cv-input')?.value === '', { timeout: 5000 });
      const thread = await api('GET', '/api/conversations?attachedTo=c1');
      const asks = (Array.isArray(thread.body) ? thread.body : thread.body.conversations).filter((m) => m.author === 'alex' || m.author === 'ada' || /Groom this/.test(m.body));
      assert.equal(asks.length, 1, 'the ask is on the card');
      const ask = asks[0];

      // ── the wake: the fanout offers the card-thread post to the resident; the REAL runner answers IN the thread ──
      const offer = await api('POST', '/api/deliveries', { to: 'pip', conversation: ask.id, source: 'fanout', by: 'board' });
      assert.equal(offer.status, 201, JSON.stringify(offer.body));
      const r = await runOnce({ SCRUM_BOARD_URL: server.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, 'pip');
      assert.equal(r.code, 0, r.err + r.out);
      const after = await api('GET', '/api/conversations?attachedTo=c1');
      const replies = (Array.isArray(after.body) ? after.body : after.body.conversations).filter((m) => m.author === 'pip');
      assert.equal(replies.length, 1, `the PO's reply is ATTACHED TO THE CARD, not on the commons: ${r.out} ${r.err}`);
      assert.match(replies[0].body, /read path/);
      const boardLevel = await api('GET', '/api/conversations?attachedTo=null&limit=100');
      assert.equal((Array.isArray(boardLevel.body) ? boardLevel.body : boardLevel.body.conversations).filter((m) => m.author === 'pip').length, 0, 'and nothing leaked to the commons');

      // ── the thread renders as a thread: the PO's answer is badged ──
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.cv-msg .cv-po-badge', { timeout: 5000 });
      const badged = await page.$$eval('.cv-msg', (els) => els.filter((e) => e.querySelector('.cv-po-badge')).map((e) => e.querySelector('.cv-msg-author').textContent));
      assert.equal(badged.length, 1, 'exactly the PO\'s message is badged');
      assert.match(badged[0], /Pip/);

      // ── the ruling: one affordance on the PO's comment → a decision constraining the card ──
      await page.click(`.cv-msg[data-id="${replies[0].id}"] .cv-ruling-btn`);
      await page.waitForSelector('.cv-ruling-form', { timeout: 5000 });
      assert.match(await page.$eval('.cv-ruling-statement', (e) => e.value), /read path/, 'the statement is the comment, prefilled');
      await page.evaluate(() => { const r = document.querySelector('.cv-ruling-reopens'); r.value = 'the write path turns out to be the blocker'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.evaluate(() => { const s = document.querySelector('.cv-ruling-by'); s.value = 'pip'; });
      await page.click('.cv-ruling-record');
      await page.waitForFunction(() => /Recorded/.test(document.querySelector('.cv-ruling-status')?.textContent || ''), { timeout: 8000 });
      const decisions = await api('GET', '/api/decisions?constrains=1');
      assert.equal(decisions.status, 200);
      assert.equal(decisions.body.length, 1, 'one decision constrains #1');
      assert.match(decisions.body[0].statement, /read path/);
      assert.equal(decisions.body[0].decidedBy, 'pip');

      // ── readable on the card ──
      await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.board-header', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('.card[data-id="c1"]').click());
      await page.waitForSelector('#card-detail .card-detail-decisions:not([hidden])', { timeout: 8000 });
      const shown = await page.$eval('#card-detail .card-detail-decisions', (e) => e.textContent);
      assert.match(shown, /Rulings on this card \(1\)/);
      assert.match(shown, /read path/);
      assert.match(shown, /reopens if: the write path/);

      // ── wiki page has the same door ──
      const p2 = await browser.newPage();
      await p2.goto(`${server.baseUrl}/wiki.html?node=c1`, { waitUntil: 'networkidle0' });
      await p2.waitForFunction(() => [...document.querySelectorAll('a.btn')].some((a) => /Groom this/.test(a.textContent)), { timeout: 5000 });
      assert.equal(await p2.$$eval('a.btn', (as) => as.find((a) => /Groom this/.test(a.textContent)).getAttribute('href')), '/commons.html?node=c1&groom=1', 'SURFACE wiki: the grooming door');
    }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } } });
  } finally { await ollama.stop(); }
});

test('#1368 a draft already in the box WINS over the PO prefill — Groom this never overwrites the operator\'s words', async () => {
  const rosterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'groom2-')), 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS, roles: { po: 'pip' } }));
  const board = makeBoardFixture({ cards: [card(1, 'a card')], nextShortId: 2 });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.accept(); });   // #1366's leave-ask on the way to ?groom=1 — answered "leave"; the draft survives regardless
    await page.goto(`${server.baseUrl}/commons.html?node=c1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    await page.evaluate(() => { const ta = document.querySelector('.cv-input'); ta.value = 'my half-written question'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.goto(`${server.baseUrl}/commons.html?node=c1&groom=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-input', (e) => e.value), 'my half-written question');
  }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } } });
});
