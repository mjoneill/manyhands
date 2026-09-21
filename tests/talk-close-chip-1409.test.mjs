/**
 * #1409 — "Talk with…" slice 2: LEAVE and CLOSE a talk from its view, REOPEN
 * a closed one, and open a talk from a seat's constellation chip. The owner
 * used slice 1 within three hours of deploy and asked "how do I exit?" — the
 * only exit was a quiet link; these are the two things his hand reached for.
 *
 * Served, browser: open a talk → the head carries Leave and Close → Close
 * from the view → /api/talks omits it, ?all=1 shows closedAt, the browser is
 * back in the room → the closed view is read-only (no composer) with Reopen →
 * a post tagged into it is refused 409 TALK_CLOSED → Reopen clears closedAt
 * and the composer returns. Chip: the "🗣 talk" affordance on a seat's chip
 * opens the header door with that seat preselected. Negative: a seat that is
 * neither opener nor `with` cannot close it (403). Sabotage: (a) close writes
 * nothing → "omitted from the default list" red; (b) chip preselects the
 * wrong seat → "preselected" red; (c) closed talk still accepts posts → the
 * 409 line red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const SEATS = { ada: { name: 'Ada', color: '#7cc4a0' }, pip: { name: 'Pip', color: '#c47c7c' }, bo: { name: 'Bo', color: '#7c7cc4' } };
const api = async (base, method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('#1409 close a talk from its view (read-only + reopen after), and open one from a seat chip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-1409-'));
  const rosterFile = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS }));
  const board = makeBoardFixture({ cards: [], conversations: [
    { id: 'pip-was-here', author: 'pip', body: 'hello room', createdAt: '2026-09-18T10:00:00.000Z', attachedTo: null },
  ] });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.accept(); });
    const opened = await api(server.baseUrl, 'POST', '/api/talks', { with: 'pip', title: 'closing time', by: 'ada' });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const id = opened.body.id;
    await api(server.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip one line', conversation: id });

    // ── the view carries LEAVE and CLOSE ──
    await page.goto(`${server.baseUrl}/commons.html?conversation=${id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-form .talk-note #talk-leave', { timeout: 5000 });
    assert.ok(await page.$('#talk-close'), 'an open talk offers Close');
    await page.select('.cv-who', 'ada');   // the composer speaks as the opener, as it would for the human who opened it
    assert.equal(await page.$eval('.cv-form', (f) => f.hidden), false, 'an open talk has its composer');

    // ── CLOSE from the view → back in the room; the list omits it; ?all=1 shows closedAt ──
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#talk-close')]);
    assert.ok(!new URL(page.url()).searchParams.get('conversation'), `closing takes you back to the room: ${page.url()}`);
    const open = await api(server.baseUrl, 'GET', '/api/talks');
    assert.ok(!open.body.talks.some((t) => t.id === id), 'omitted from the default list once closed');
    const all = await api(server.baseUrl, 'GET', '/api/talks?all=1');
    const closed = all.body.talks.find((t) => t.id === id);
    assert.ok(closed && closed.closedAt, `?all=1 shows it with closedAt: ${JSON.stringify(closed)}`);

    // ── a post tagged into a closed talk is refused ──
    const late = await api(server.baseUrl, 'POST', '/api/conversations', { author: 'pip', body: 'too late', conversation: id });
    assert.equal(late.status, 409, JSON.stringify(late.body)); assert.equal(late.body.code, 'TALK_CLOSED');

    // ── the closed view is read-only with Reopen; Reopen clears it and the composer returns ──
    await page.goto(`${server.baseUrl}/commons.html?conversation=${id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#talk-head.talk-closed #talk-reopen', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-form', (f) => f.hidden), true, 'a closed talk shows no composer');
    assert.ok(await page.$('#talk-closed-note'), 'and says it is closed');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#talk-reopen')]);
    await page.waitForSelector('.cv-form .talk-note #talk-close', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-form', (f) => f.hidden), false, 'reopened: the composer is back');
    const again = await api(server.baseUrl, 'GET', '/api/talks/' + id);
    assert.equal(again.body.closedAt, null, 'reopen cleared closedAt');

    // ── negative: a non-participant cannot close (API) — and from the view the refusal is INLINE, never a modal ──
    const stranger = await api(server.baseUrl, 'PATCH', '/api/talks/' + id, { by: 'bo', closed: true });
    assert.equal(stranger.status, 403); assert.equal(stranger.body.code, 'NOT_A_PARTICIPANT');
    await page.select('.cv-who', 'bo');
    await page.click('#talk-close');
    await page.waitForFunction(() => (document.querySelector('#talk-head-error')?.textContent || '').length > 0, { timeout: 5000 });
    assert.match(await page.$eval('#talk-head-error', (e) => e.textContent), /neither the opener/, 'the refusal is shown in the head, inline');
    assert.ok(await page.$('#talk-close'), 'and the talk is still open');
    await page.select('.cv-who', 'ada');

    // ── chip: "🗣 talk" on a seat's chip opens the door with that seat preselected ──
    // (a chip is rendered for seats that spoke recently — #1241; pip speaks now)
    await api(server.baseUrl, 'POST', '/api/conversations', { author: 'pip', body: 'still here' });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.constellation .mind .mind-talk[data-seat="pip"]', { timeout: 5000 });
    await page.evaluate(() => { document.querySelector('.mind .mind-talk[data-seat="pip"]').click(); });
    await page.waitForSelector('#talk-form:not([hidden]) #talk-with option', { timeout: 5000 });
    assert.equal(await page.$eval('#talk-with', (s) => s.value), 'pip', 'the chip preselected its seat');
    await page.type('#talk-title', 'from the chip');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#talk-form button[type=submit]')]);
    const fromChip = new URL(page.url()).searchParams.get('conversation');
    assert.ok(fromChip, 'the chip door opened a talk');
    const minted = await api(server.baseUrl, 'GET', '/api/talks/' + fromChip);
    assert.equal(minted.body.with, 'pip'); assert.equal(minted.body.title, 'from the chip');
  }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } }, launch: { headless: 'new' } });
});

// #1409 (2026-09-21) + #1431 — the owner's screenshot: a laptop viewport, a talk
// with enough posts to scroll, a ten-line reply in the box. The feed had ONE
// row; Leave/Close were the first element of that feed, above its fold, and he
// said "I still don't see any mechanism to close the talks with mode." An
// element that is in the DOM but outside the viewport is not a control the
// human has. This test asks the browser where things ARE, not whether they exist.
test('#1409/#1431 on a laptop viewport with a scrolled talk and a long draft, Leave/Close are ON SCREEN and the feed keeps rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-1409-vp-'));
  const rosterFile = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS }));
  const board = makeBoardFixture({ cards: [], conversations: [] });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1232, height: 763 });   // his screenshot's size
    const opened = await api(server.baseUrl, 'POST', '/api/talks', { with: 'pip', title: 'long one', by: 'ada' });
    const id = opened.body.id;
    for (let i = 0; i < 30; i++) {
      await api(server.baseUrl, 'POST', '/api/conversations', { author: i % 2 ? 'pip' : 'ada', body: `line ${i} — ${'words '.repeat(30)}`, conversation: id });
    }
    await page.goto(`${server.baseUrl}/commons.html?conversation=${id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-form .talk-note #talk-close', { timeout: 5000 });
    // a long draft, typed
    await page.click('.cv-input');
    await page.type('.cv-input', Array.from({ length: 24 }, (_, i) => `draft line ${i} that runs on for a while so the box grows`).join('\n'));
    const m = await page.evaluate(() => {
      const vh = window.innerHeight;
      const inView = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh && r.height > 0; };
      const feed = document.querySelector('.cv-feed');
      const ta = document.querySelector('.cv-input');
      return {
        leaveInView: inView(document.querySelector('#talk-leave')),
        closeInView: inView(document.querySelector('#talk-close')),
        feedHeight: feed.getBoundingClientRect().height,
        composerHeight: ta.getBoundingClientRect().height,
        vh,
      };
    });
    assert.ok(m.leaveInView, `Leave is inside the viewport: ${JSON.stringify(m)}`);
    assert.ok(m.closeInView, `Close is inside the viewport: ${JSON.stringify(m)}`);
    assert.ok(m.feedHeight >= 120, `the feed keeps rows (>=120px): ${JSON.stringify(m)}`);
    assert.ok(m.composerHeight <= m.vh * 0.34 + 2, `the composer is capped near a third of the viewport: ${JSON.stringify(m)}`);
    await page.close();
  }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } }, launch: { headless: 'new' } });
});
