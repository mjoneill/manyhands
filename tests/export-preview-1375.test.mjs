/**
 * #1375 — "I don't understand how it's scrubbed if it just errors out."
 *
 * The scrub is fail-closed (#523): transform, then REFUSE if anything the rules
 * recognise survives. That refusal is the boundary working — and until now the
 * page showed it as a red export error, after the press, with no way to know
 * beforehand which selections could pass. Three things, all tested here:
 *
 *   1. `POST /api/export/preview` — a DRY RUN: the same transform-then-check
 *      over the selected kinds, returning {residue, byKind, samples, wouldPass}
 *      and writing nothing.
 *   2. A press refused for residue is a 409 `refusedBy: 'scrub'` with the count
 *      and the per-kind split — distinguishable from a real failure (a dead
 *      child, a bad path), which stays a 500.
 *   3. The page: a line under the Boundary group, computed from the LIVE
 *      selection, that says before the press whether the scrub will pass or
 *      refuse; and a refusal rendered as the boundary working, offering
 *      un-scrubbed, not as "did not produce a readable archive".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-export-1375-'));
const rootEnv = { SCRUM_EXPORT_ROOT: EXPORT_ROOT };
const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// A rule set that can DETECT a term but not rewrite it — the commons shape
// (seat names, sigils) that made the owner's first press refuse.
const RULES = { rules: [], forbidden: [{ note: 'a room term with no rewrite', pattern: 'QUINCE', flags: 'g', specimen: 'the QUINCE memory' }] };
const now = '2026-09-14T00:00:00.000Z';
const board = () => makeBoardFixture({
  cards: [{ title: 'a clean card', by: 'ada', description: 'nothing here the rules recognise' }], nextShortId: 2,
  conversations: [{ id: 'm1', author: 'ada', body: 'the commons says QUINCE twice: QUINCE', createdAt: now, attachedTo: null }],
  memories: [
    { '@id': 'https://scrumboard.local/memory/mem-1', '@type': 'scrum:Memory', identifier: 'mem-1', name: 'a memory', 'scrum:owner': 'ada', 'scrum:tag': ['agent-memory'], 'scrum:currentVersion': 'https://scrumboard.local/memory/mem-1/v1' },
    { '@id': 'https://scrumboard.local/memory/mem-1/v1', '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': 'https://scrumboard.local/memory/mem-1', 'scrum:version': 1, 'scrum:body': 'the QUINCE memory', author: 'ada', dateCreated: now },
  ],
});
const withRules = (srv) => fs.writeFileSync(path.join(path.dirname(srv.boardFile), 'EXPORT_TRANSFORMS.json'), JSON.stringify(RULES));

test('#1375 PREVIEW is a dry run: residue counted per kind from the live selection, nothing written; a clean selection reads 0 and would pass', async () => {
  const srv = await startRestServer({ board: board(), env: rootEnv });
  try {
    withRules(srv);
    const out = path.join(EXPORT_ROOT, `p-${process.pid}`);
    const full = await api(srv.baseUrl, 'POST', '/api/export/preview', { by: 'ada', out, spaces: ['commons', 'cards', 'memories'] });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.equal(full.body.mode, 'scrub');
    assert.equal(full.body.wouldPass, false);
    assert.equal(full.body.residue, 3, `two in the commons line, one in the memory — got ${JSON.stringify(full.body)}`);
    assert.deepEqual(full.body.byKind, { commons: 2, memories: 1 }, 'the split names WHICH selections carry the residue');
    assert.ok(Array.isArray(full.body.samples) && full.body.samples.length >= 1 && /QUINCE/.test(full.body.samples[0].match));
    assert.equal(fs.existsSync(out), false, 'a preview writes nothing');

    const clean = await api(srv.baseUrl, 'POST', '/api/export/preview', { by: 'ada', out, spaces: ['cards'] });
    assert.equal(clean.status, 200, JSON.stringify(clean.body));
    assert.equal(clean.body.residue, 0);
    assert.equal(clean.body.wouldPass, true);
    assert.deepEqual(clean.body.byKind, {});

    const raw = await api(srv.baseUrl, 'POST', '/api/export/preview', { by: 'ada', out, spaces: ['commons'], raw: true });
    assert.equal(raw.status, 200);
    assert.equal(raw.body.mode, 'raw');
    assert.equal(raw.body.wouldPass, true, 'raw never refuses');
    assert.equal(raw.body.residue, 2, 'and still says how many terms the scrub WOULD have refused — the reader deserves the number');
    assert.equal(fs.existsSync(out), false);
  } finally { await srv.stop(); }
});

test('#1375 a press refused for residue is 409 refusedBy:scrub with the count and split — not the 500 a real failure gets', async () => {
  const srv = await startRestServer({ board: board(), env: rootEnv });
  try {
    withRules(srv);
    const out = path.join(EXPORT_ROOT, `r-${process.pid}`);
    const refused = await api(srv.baseUrl, 'POST', '/api/export', { by: 'ada', out, maxBytes: 200000, spaces: ['commons', 'memories'] });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.refusedBy, 'scrub');
    assert.equal(refused.body.residue, 3);
    assert.deepEqual(refused.body.byKind, { commons: 2, memories: 1 });
    assert.match(refused.body.error, /refused by the scrub boundary/i);
    assert.doesNotMatch(refused.body.error, /did not produce a readable archive/, 'the boundary working is not an export failure');
    assert.equal(fs.existsSync(path.join(out, '00-INDEX.md')), false, 'fail-closed: nothing written');

    const ok = await api(srv.baseUrl, 'POST', '/api/export', { by: 'ada', out, maxBytes: 200000, spaces: ['cards'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.scrub, 'scrubbed');
  } finally { await srv.stop(); }
});

test('#1375 the PAGE says it before the press, from the live selection; a refusal reads as the boundary working and offers un-scrubbed', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    withRules(server);
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#export-panel [data-export-include] input[type=checkbox]', { timeout: 5000 });
    // default ticks are the prose kinds: commons + cards + memories (+ decisions) → residue
    await page.waitForFunction(() => /refuse/i.test(document.querySelector('#export-panel [data-export-preview]')?.textContent || ''), { timeout: 8000 });
    const before = await page.$eval('#export-panel [data-export-preview]', (e) => e.textContent);
    assert.match(before, /refuse/i);
    assert.match(before, /\b3\b/, `the count is on the page — ${before}`);
    assert.match(before, /commons/, `and which selection carries it — ${before}`);
    assert.match(before, /un-scrubbed/i, 'and the door for the owner is named');

    // narrow the selection to cards only → the same line flips to "will pass"
    await page.$$eval('#export-panel [data-export-include] input[type=checkbox]', (els) => { for (const i of els) { if (i.checked !== (i.value === 'cards')) i.click(); } });
    await page.waitForFunction(() => /pass/i.test(document.querySelector('#export-panel [data-export-preview]')?.textContent || ''), { timeout: 8000 });
    const narrowed = await page.$eval('#export-panel [data-export-preview]', (e) => e.textContent);
    assert.match(narrowed, /pass/i, narrowed);

    // back to commons and press: the status is the boundary, not a failure
    await page.$$eval('#export-panel [data-export-include] input[type=checkbox]', (els) => { for (const i of els) { if (i.value === 'commons' && !i.checked) i.click(); } });
    await page.$eval('#export-max-bytes', (e) => { e.value = '200000'; });
    await page.click('#export-run');
    await page.waitForFunction(() => /refused by the scrub boundary/i.test(document.querySelector('#export-status')?.textContent || ''), { timeout: 30000 });
    const status = await page.$eval('#export-status', (e) => e.textContent);
    assert.match(status, /scrub working|the scrub is working/i, status);
    assert.match(status, /un-scrubbed/i, 'the way out is on the same screen');
    assert.doesNotMatch(status, /did not produce a readable archive/);
  }, { server: { board: board(), env: rootEnv }, launch: { headless: 'new', args: ['--no-sandbox'] } });
});
