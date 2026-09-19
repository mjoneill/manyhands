/**
 * #1396 slice 2 — the ring's SEATS on the Settings page (decision 327a18f6:
 * "any switch the owner is expected to flip lives on the Settings page").
 * Slice 1 put `tokenRing.bearerSeats` in the config validator and on
 * /channel/status and never on the page, so the only way to flip the thing
 * was a hand-edited JSON file — refused by the owner, 2026-09-17 23:56Z.
 *
 * Served, browser, one REST + one MCP sharing the channel-config file:
 * Settings → Channel Delivery shows a checkbox per terminal seat (no system
 * seats, no residents) → tick one → Save → /api/config carries
 * tokenRing.bearerSeats → a bearer-bound session with an open stream on the
 * MCP now shows ring:true on /channel/status → the page's live line names it
 * → untick → Save → the list is cleared and the seat leaves the ring.
 * Sabotage: (a) the page saves the field but the adapter never re-reads the
 * config ⇒ "ring:true" never arrives; (b) the save omits bearerSeats ⇒ the
 * config never carries it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer, startMcpServer, mcpSession, openChannelStream, freePort } from './helpers/harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-settings-1396-'));
const tmpFile = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, every = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await settle(every); } }

test('#1396 s2 — a terminal seat is ticked into the ring from Settings, joins it live, and is unticked out again', async () => {
  const tokens = tmpFile('seat-tokens.json', { tokens: { 'tok-alpha': { seat: 'alpha' } } });
  const cfg = tmpFile('channel-config.json', { mode: 'off', soft: { minMs: 60000, maxMs: 120000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 90000 } });
  const roster = tmpFile('roster.json', { seats: { alpha: { name: 'Alpha', color: '#7cc4a0' }, ada: { name: 'Ada', color: '#c47c7c' }, wiki: { name: 'Wiki', color: '#999', kind: 'system' } } });
  const mcpPort = await freePort();
  let mcp = null;
  try {
    await withBrowserServer(async ({ server, browser }) => {
      // The harness hands REST an ISOLATED config file (server.configFile) and
      // sets it LAST, over any env a test passes; the MCP must read that same
      // file or the page's save lands where the adapter never looks.
      fs.writeFileSync(server.configFile, fs.readFileSync(cfg));
      mcp = await startMcpServer({ port: mcpPort, restApiBase: server.baseUrl, env: { SCRUM_SEAT_TOKENS: tokens, SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: server.configFile } });
      const status = async () => (await fetch(`${new URL(mcp.mcpUrl).origin}/channel/status`)).json();
      const a = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
      const stream = await openChannelStream(mcp.mcpUrl, a.sessionId);
      let st = await status();
      assert.equal(st.seats.alpha.ring, false, 'control: bound + streaming but NOT listed ⇒ not in the ring');

      const page = await browser.newPage();
      await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ring-seats input[data-seat="alpha"]', { timeout: 5000 });
      const offered = await page.$$eval('#ring-seats input', (els) => els.map((e) => e.value));
      assert.ok(offered.includes('alpha') && offered.includes('ada'), `terminal seats are offered: ${offered}`);
      assert.ok(!offered.includes('wiki'), 'a system seat is not offered');
      assert.equal(await page.$eval('#ring-seats input[data-seat="alpha"]', (e) => e.checked), false, 'unlisted reads unticked');

      await page.click('#ring-seats input[data-seat="alpha"]');
      await page.click('#save');
      await page.waitForFunction(() => /Saved/.test(document.querySelector('#msg')?.textContent || ''), { timeout: 5000 });
      const saved = await (await fetch(`${server.baseUrl}/api/config`)).json();
      assert.deepEqual(saved.tokenRing.bearerSeats, ['alpha'], 'the save carried the ticked seat');

      // the adapter re-reads the config; a fresh stream open registers the seat
      stream.close();
      const stream2 = await openChannelStream(mcp.mcpUrl, a.sessionId);
      st = await until(async () => { const x = await status(); return x.seats.alpha.ring ? x : null; });
      assert.ok(st, 'ring:true — the seat joined from the page, no file edit');
      assert.deepEqual(st.ring.bearerSeats, ['alpha']);
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => /in the ring now: .*alpha/.test(document.querySelector('#ring-live')?.textContent || ''), { timeout: 6000 });
      assert.equal(await page.$eval('#ring-seats input[data-seat="alpha"]', (e) => e.checked), true, 'the page reads the saved list back');

      // untick → the list clears → the seat leaves on its next stream
      await page.click('#ring-seats input[data-seat="alpha"]');
      await page.click('#save');
      await page.waitForFunction(() => /Saved/.test(document.querySelector('#msg')?.textContent || ''), { timeout: 5000 });
      const cleared = await (await fetch(`${server.baseUrl}/api/config`)).json();
      assert.equal(cleared.tokenRing.bearerSeats, undefined, 'unticked ⇒ the list is gone from the config');
      stream2.close();
      const stream3 = await openChannelStream(mcp.mcpUrl, a.sessionId);
      st = await until(async () => { const x = await status(); return x.seats.alpha.ring === false ? x : null; });
      assert.ok(st, 'unlisted again ⇒ not in the ring');
      stream3.close();
    }, { server: { board: makeBoardFixture({ cards: [] }), mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify`, env: { SCRUM_ROSTER_FILE: roster } }, launch: { headless: 'new' } });
  } finally { if (mcp) await mcp.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// #1411 slice 2 — the residents' PAIR CAP is the owner's number, and it lives
// on the same page (decision 40daaa38 · 327a18f6): shown from the config with
// the runner's default when unset, saved with the form, refused out of range.
test('#1411 s2 — the resident reply cap is set from Settings: default shown, a number saved to /api/config, 0 allowed (= rule 1), out of range refused by the server', async () => {
  // The first test removes the shared temp dir in its finally; write the config straight into the harness's isolated file.
  const cfgJson = JSON.stringify({ mode: 'off', soft: { minMs: 60000, maxMs: 120000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 90000 } });
  await withBrowserServer(async ({ server, browser }) => {
    fs.writeFileSync(server.configFile, cfgJson);
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#residentPairCap', { timeout: 5000 });
    assert.equal(await page.$eval('#residentPairCap', (e) => e.value), '3', 'unset in the config ⇒ the runner default is shown, not a blank');
    const setAndSave = async (v) => {
      await page.$eval('#residentPairCap', (e, val) => { e.value = val; }, String(v));
      await page.click('#save');
      await page.waitForFunction(() => /Saved|Rejected/.test(document.querySelector('#msg')?.textContent || ''), { timeout: 5000 });
      return page.$eval('#msg', (e) => e.textContent);
    };
    assert.match(await setAndSave(5), /Saved/);
    let saved = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.equal(saved.residents?.replyWakesPerPairPerHour, 5, `the number is on the config: ${JSON.stringify(saved)}`);
    assert.match(await setAndSave(0), /Saved/);
    saved = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.equal(saved.residents?.replyWakesPerPairPerHour, 0, '0 is a valid number: residents never wake residents');
    // The server is the authority: a value past the bound is refused, and the config keeps the last good one.
    const bad = await fetch(`${server.baseUrl}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...saved, residents: { replyWakesPerPairPerHour: 61 } }) });
    assert.equal(bad.status, 400);
    saved = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.equal(saved.residents?.replyWakesPerPairPerHour, 0);
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.$eval('#residentPairCap', (e) => e.value), '0', 'the page shows what the config holds');
  }, { launch: {} });
});
