/**
 * #1607, THE OTHER TAB: `commons.html` HAS THE SAME POLL. The card asked "commons.html:655 has the same shape. Same change, or confirm it is only a one-shot." It is not a one-shot: `refreshBlocked()` is called at
 * load and then from `setInterval(refreshBlocked, 8000)`, and after its first full read it sends `GET /api/conversations?since=<newest>` with no `limit` on every tick, which with the graph unit on takes the
 * whole-store path (the card measured about 1 s of executor time per such request). So a Commons tab left open costs what a board tab cost before #1607, every 8 s. Kept in its own file so the 12 rows frozen at
 * `ab951d5f…` (which the builder's commit passes) stay as they were. A REAL REST server with the unit on, a REAL executor, a real headless browser. Without a python with pyoxigraph the row is SKIPPED, and a skip is NOT a pass.
 *
 *   P7  AN IDLE COMMONS TAB MAKES NO UNBOUNDED ?since= REQUEST: with `/commons.html` open and idle for 20 s (two of its 8 s ticks), the page sends no `GET /api/conversations?since=…` request. (Its one boot read of the
 *       full list is a one-off per load and is NOT asserted here; see below.)
 *
 * NOT COVERED, by name: the boot read itself (`GET /api/conversations` with no parameters, one per page load, ~45 MB on the live store); the `/api/cards?limit=500&updatedSince=` poll beside it (a card read, not the
 * post store); `pollDelivery` every 4 s (deliveries, #1617's side); what shape the replacement should take.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'p7-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `p7-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

test('P7 AN IDLE COMMONS TAB MAKES NO UNBOUNDED ?since= REQUEST: with commons.html open and idle for 20 s the page sends no GET /api/conversations?since=', { skip: SKIP, timeout: 240000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('p7-store-'), datasetId: DSID, create: true });
  try {
    await withBrowserServer(async ({ server, browser }) => {
      for (let i = 0; i < 4; i++) { const r = await fetch(`${server.baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: 'ada', body: `p7 seed ${i}` }) }); assert.equal(r.status, 201); }
      const page = await browser.newPage(); const log = [];
      await page.setRequestInterception(true);
      page.on('request', (req) => { const u = req.url(); if (u.includes('/api/conversations') && req.method() === 'GET') log.push(u.replace(server.baseUrl, '')); req.continue().catch(() => {}); });
      await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body', { timeout: 30000 });
      await sleep(20000);
      assert.ok(log.length >= 1, `CONTROL: the page read the conversations at all (${log.length} requests)`);
      const since = log.filter((u) => /[?&]since=/.test(u));
      assert.equal(since.length, 0, `an idle Commons tab sends no whole-history since poll (${since.length} in 20 s): ${since.slice(0, 2).join(' , ')}`);
      // and no REPEATED full read either: the raised-hands panel reads the whole list once at boot (that one is outside this row) and must not do it again on a tick
      const bare = log.filter((u) => u === '/api/conversations');
      assert.ok(bare.length <= 1, `at most one full read of the list in 20 s, the boot read (${bare.length})`);
    }, { server: { board: makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'a card', description: '', type: 'task', column: 'backlog', order: 1, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } }], nextShortId: 2, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } } });
  } finally { await killExecutor(exec); }
});
