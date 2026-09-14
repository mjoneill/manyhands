/**
 * #1321 — the export exports the BOARD, not the board's two oldest tables.
 *
 * Before: `EXPORT_SPACES = ['commons','cards','wiki']` — a hardcoded list of
 * three against 38 registered kinds; memories, decisions, runs, model calls,
 * agents, deliveries and everything minted since silently absent from every
 * archive, and the menu offering two of the three. The owner opened the menu
 * and said "having it in the Board suggests it only exports the board" — and
 * the suggestion was true.
 *
 * After (decision: DERIVE): the exportable set is every registered kind that
 * has a collection on the board, read from the kind registry — so a kind
 * minted next month is exportable by construction; the archive INDEX names
 * every kind included and every kind excluded, with counts; anything present
 * on the board that the registry does not know is listed as
 * "present · unnamed · not exported" (the same census #1215 uses), so an
 * unregistered kind cannot be silently left out either. The control moves
 * from the board's action row to Settings, and the menu separates WHAT to
 * include from HOW MUCH to redact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';
import { exportableSpaces, describeExportSet } from '../core/export-spaces.mjs';

const EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-export-1321-'));
const rootEnv = { SCRUM_EXPORT_ROOT: EXPORT_ROOT };
const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// A board that holds more than cards and commons — the kinds the old export
// silently dropped — plus one entity of a type nobody registered (#804 keeps
// it verbatim; #1215 names it).
function richBoard() {
  const now = '2026-09-14T00:00:00.000Z';
  return makeBoardFixture({
    cards: [{ title: 'a card to export', by: 'ada' }], nextShortId: 2,
    conversations: [{ id: 'm1', author: 'ada', body: 'a commons line about the pear test', createdAt: now, attachedTo: null }],
    // A memory is a HEAD plus its versions (#1287's shape): the body lives on the version.
    memories: [
      { '@id': 'https://scrumboard.local/memory/mem-1', '@type': 'scrum:Memory', identifier: 'mem-1', name: 'the retro is on Tuesday', 'scrum:owner': 'ada', 'scrum:tag': ['agent-memory'], 'scrum:currentVersion': 'https://scrumboard.local/memory/mem-1/v1' },
      { '@id': 'https://scrumboard.local/memory/mem-1/v1', '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': 'https://scrumboard.local/memory/mem-1', 'scrum:version': 1, 'scrum:body': 'the retro is on Tuesday — the QUINCE memory', author: 'ada', dateCreated: now },
    ],
    decisions: [{ '@id': 'https://scrumboard.local/decision/dec-1', '@type': 'scrum:Decision', identifier: 'dec-1', 'scrum:statement': 'we export everything — the FIG decision', 'scrum:decidedBy': 'ada', 'scrum:constrains': ['export'], 'scrum:reopensIf': 'never', dateCreated: now }],
    modelCalls: [{ '@id': 'https://scrumboard.local/model-call/mc-1', '@type': 'scrum:ModelCall', 'scrum:agent': 'gizmo', 'scrum:model': 'fake', 'scrum:calledAt': now, 'scrum:tokensIn': 10, 'scrum:tokensOut': 2, 'scrum:cost': 0, 'scrum:ok': true, 'scrum:stopReason': 'stop' }],
    _unmodelled: [{ '@id': 'https://scrumboard.local/thing/x-1', '@type': 'scrum:Widget', name: 'a thing nobody registered' }],
  });
}

// ── the pure half: what is exportable is DERIVED ────────────────────────────
test('#1321 exportableSpaces is derived from the kind registry, never a typed list — every registered kind with a collection is a space, prose and machine marked, and the alias words still resolve', () => {
  const spaces = exportableSpaces();
  const names = spaces.map((s) => s.space);
  for (const must of ['commons', 'cards', 'memories', 'decisions', 'obligations', 'wakes', 'deliveries', 'model-calls', 'agents', 'agent-prompts', 'models', 'procedures', 'runs', 'artifacts']) {
    assert.ok(names.includes(must), `${must} must be exportable — it is a registered kind with a collection`);
  }
  const byName = Object.fromEntries(spaces.map((s) => [s.space, s]));
  assert.equal(byName.cards.prose, true); assert.equal(byName.memories.prose, true); assert.equal(byName.decisions.prose, true);
  assert.equal(byName['model-calls'].prose, false, 'a ledger row is machine state, unticked by default');
  assert.equal(byName.deliveries.prose, false);
  assert.ok(byName.memories.kind === 'scrum:Memory' && byName.memories.collection === 'memories', 'each space names its kind and its store key');
  assert.ok(byName.cards.definition.length > 40, 'the definition rides along — the menu can say what a thing IS');
  // the words people already type
  assert.equal(spaces.find((s) => s.aliases.includes('wiki')).space, 'cards');
  assert.equal(spaces.find((s) => s.aliases.includes('conversations')).space, 'commons');
});

test('#1321 describeExportSet — included, excluded, and PRESENT-BUT-UNREGISTERED, with counts from the document', () => {
  const doc = richBoard();
  const d = describeExportSet(doc, ['commons', 'memories']);
  const inc = Object.fromEntries(d.included.map((x) => [x.space, x.count]));
  assert.deepEqual(inc, { commons: 1, memories: 1 }, 'a memory counts once — the head; its versions ride inside it');
  const exc = Object.fromEntries(d.excluded.map((x) => [x.space, x.count]));
  assert.equal(exc.cards, 1); assert.equal(exc.decisions, 1); assert.equal(exc['model-calls'], 1);
  assert.equal(exc.wakes, 0, 'an empty collection is still named as excluded, with 0');
  assert.deepEqual(d.unregistered, [{ type: 'scrum:Widget', count: 1, example: 'https://scrumboard.local/thing/x-1' }],
    'a type the registry does not know is named as present · unnamed · not exported');
  const all = describeExportSet(doc, ['all']);
  assert.equal(all.excluded.length, 0, '"all" leaves nothing registered behind');
  assert.ok(all.included.some((x) => x.space === 'model-calls' && x.count === 1));
});

// ── the seam: the real endpoint, the real exporter, files on disk ───────────
test('#1321 SEAM — an export of memories + decisions writes them, the index names what was left out by kind and count, and the unregistered thing is named', async () => {
  const s = await startRestServer({ board: richBoard(), env: rootEnv });
  const out = path.join(EXPORT_ROOT, `derived-${process.pid}`);
  try {
    const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, raw: true, maxBytes: 200000, spaces: ['memories', 'decisions'] });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800));
    const parts = fs.readdirSync(out).filter((f) => /^part-\d+-of-\d+\.md$/.test(f)).sort();
    const whole = parts.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    assert.match(whole, /QUINCE memory/, 'the memory is in the archive');
    assert.match(whole, /FIG decision/, 'the decision is in the archive');
    assert.doesNotMatch(whole, /pear test/, 'commons was not asked for and is not there');
    const index = fs.readFileSync(path.join(out, '00-INDEX.md'), 'utf8');
    assert.match(index, /memories[^\n]*\b1\b/i, 'included kinds with counts');
    assert.match(index, /Not exported/i);
    assert.match(index, /cards[^\n]*\b1\b/i, 'the excluded card is named with its count');
    assert.match(index, /model-calls[^\n]*\b1\b/i);
    assert.match(index, /scrum:Widget[^\n]*(unnamed|unregistered|not exported)/i, 'the unregistered type is named in the index — an honest subset, never a silent one');
    assert.deepEqual(r.body.settings.spaces, ['memories', 'decisions']);
  } finally { fs.rmSync(out, { recursive: true, force: true }); await s.stop(); }
});

test('#1321 SEAM — "all" exports every registered kind; an unknown space is refused naming the derived set; the old words still work', async () => {
  const s = await startRestServer({ board: richBoard(), env: rootEnv });
  const out = path.join(EXPORT_ROOT, `all-${process.pid}`);
  try {
    const bad = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, raw: true, spaces: ['carrier-pigeons'] });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /memories/, 'the refusal lists the derived set, so the caller learns what exists');
    const legacy = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, raw: true, maxBytes: 200000, spaces: 'commons,wiki' });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body).slice(0, 400));
    assert.deepEqual(legacy.body.settings.spaces, ['commons', 'cards'], 'wiki still means cards');
    fs.rmSync(out, { recursive: true, force: true });
    const all = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, raw: true, maxBytes: 200000, spaces: 'all' });
    assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 800));
    const whole = fs.readdirSync(out).filter((f) => /^part-/.test(f)).sort().map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    for (const needle of ['pear test', 'a card to export', 'QUINCE memory', 'FIG decision', 'mc-1']) assert.match(whole, new RegExp(needle), `all ⇒ ${needle}`);
    const index = fs.readFileSync(path.join(out, '00-INDEX.md'), 'utf8');
    assert.doesNotMatch(index, /Not exported:\s*\n\s*- \w/, 'all ⇒ nothing registered is left out');
    assert.match(index, /scrum:Widget/, 'but the unregistered thing is still named — "all" is all REGISTERED kinds');
  } finally { fs.rmSync(out, { recursive: true, force: true }); await s.stop(); }
});

test('#1321 GET /api/export/spaces — the menu is served from the same derivation, with live counts, so the UI cannot drift from the exporter', async () => {
  const s = await startRestServer({ board: richBoard(), env: rootEnv });
  try {
    const r = await api(s.baseUrl, 'GET', '/api/export/spaces');
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.spaces.map((x) => [x.space, x]));
    assert.equal(by.memories.count, 1); assert.equal(by.cards.count, 1); assert.equal(by['model-calls'].count, 1);
    assert.equal(by.memories.prose, true); assert.equal(by['model-calls'].prose, false);
    assert.deepEqual(r.body.unregistered, [{ type: 'scrum:Widget', count: 1, example: 'https://scrumboard.local/thing/x-1' }]);
  } finally { await s.stop(); }
});

// ── the browser: Settings has it, the board does not, the two axes are apart ─
test('#1321 the control lives in SETTINGS with Include and Boundary as separate groups, the include list is derived, and the board action row no longer carries it', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    assert.equal(await page.$('#btn-export'), null, 'the board page has no export button — a control on the board reads as exporting the board');
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#export-panel [data-export-include] input[type=checkbox]', { timeout: 5000 });
    const boxes = await page.$$eval('#export-panel [data-export-include] input[type=checkbox]', (els) => els.map((i) => ({ v: i.value, on: i.checked })));
    const names = boxes.map((b) => b.v);
    for (const must of ['commons', 'cards', 'memories', 'decisions', 'model-calls', 'deliveries']) assert.ok(names.includes(must), `include offers ${must}`);
    assert.ok(boxes.find((b) => b.v === 'memories').on && !boxes.find((b) => b.v === 'model-calls').on, 'prose ticked by default, machine state not');
    const includeGroup = await page.$('#export-panel [data-export-include]');
    const boundaryGroup = await page.$('#export-panel [data-export-boundary]');
    assert.ok(includeGroup && boundaryGroup, 'two groups, two jobs');
    const rawInBoundary = await page.$('#export-panel [data-export-boundary] #export-raw');
    assert.ok(rawInBoundary, 'the un-scrubbed control is in the Boundary group, not among the include boxes');
    const rawInInclude = await page.$('#export-panel [data-export-include] #export-raw');
    assert.equal(rawInInclude, null);
    const unreg = await page.$eval('#export-panel [data-export-unregistered]', (e) => e.textContent);
    assert.match(unreg, /scrum:Widget/, 'the page says what is present and unnamed, before the press');
  }, { server: { board: richBoard(), env: rootEnv }, launch: { headless: 'new', args: ['--no-sandbox'] } });
});
