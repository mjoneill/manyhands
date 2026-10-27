/**
 * #1763 — the work ledger is RETIRED, not rebuilt. The test author's independent rows, written BLACK-BOX against "#1763 RETIREMENT
 * CONTRACT v2" (card, 2026-10-27 02:25Z) before the retirement is built. They replace the deleted tests of the ledger's behaviour
 * (work-gate, work-tools-wiring and the rest) with assertions about its ABSENCE, run the way an agent meets it: a real MCP server as a
 * subprocess, a real REST server, JSON-RPC between them.
 *
 * THE WORLD: the harness of tests/work-tools-wiring.test.mjs (REST + MCP subprocess, `session.listTools()` / `callTool`), and the fixture
 * board of tests/work-gate-enforced-op.test.mjs (cards #1 and #2). The "OLD PLIST" is the production MCP's own settings until the
 * morning restart: SCRUM_WORK_GATE=on and SCRUM_WORK_STORE=<dir>. A store directory here holds a hand-written work-objects.jsonl in the
 * on-disk line format (read from the live file: one line per transition, the object-level fields repeated on every line), with an OPEN
 * window by ada on card #1, which today refuses ada's card_update on #1.
 *
 * ROWS:
 *   A1  the seven work tools are ABSENT, in every gate x throttle combination (the old test's 2x2, inverted); the surface is not empty
 *   A2  OLD PLIST, NEW CODE: with the gate flag on and the store set to a file holding an open window, ada's card_update and card_move on
 *       the declared card are NOT refused (today they are), and the edits land
 *   C   nothing writes the file: its bytes and mtime are unchanged after create, update, move, claim, get and board_status
 *   B   board_status reports the ledger as retired, with the file made UNREADABLE (nothing reads it)
 *   E   (source) the four work modules are gone and nothing imports them; server.js no longer calls projectWorkLedger
 *   B2  board_status's counts come from the GRAPH (a seeded executor: 2 WorkObjects, 3 Actions), with the file unreadable and disagreeing
 *   D1/D2 the activity projector, with and without --work, runs to completion and writes no Action (--work is accepted but ignored, with a stderr line)
 *   F   GUARD: the claim throttle (kept) still refuses a second seat inside the cooldown, with the gate flags absent
 *
 * E2a/E2b the sprint review, without and with --work-store, exits 0 and reports signal 2 as RETIRED since 2026-08-18 (#1763), never counts it as
 *   measured, and says --work-store is ignored. (The review script reads no graph; the builder corrected that at 02:27Z. The no-import half is E.)
 *
 * No todo rows remain.
 *
 * NOT COVERED, BY NAME: the plist edits themselves (the morning window, with the owner present); the two WorkObjects whose
 * scrum:requiredRaw holds task descriptions (the owner's one-line question); cursors.json (kept, and mis-registered under
 * SCRUM_WORK_STORE, which the contract corrects; no row yet).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WORK_TOOLS = ['work_declare', 'work_bid', 'work_nobid', 'work_grant', 'work_withdraw', 'work_contest', 'work_list'];
const payload = (res) => JSON.parse(res.result.content[0].text);

// every temp folder this file makes is recorded here and removed by the `after` hook, so a failing row cannot leave one behind
// (the suite's temp-leak ratchet fails a run on a NEW leftover; the first version of this file left 12 entries)
const owned = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); owned.push(d); return d; };
after(() => { for (const d of owned) { try { fs.chmodSync(path.join(d, 'work-objects.jsonl'), 0o644); } catch { /* no file, or already readable */ } fs.rmSync(d, { recursive: true, force: true }); } });

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'the declared card', description: '', type: 'task', labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    { id: 'u-2', shortId: 2, title: 'an unrelated card', description: '', type: 'task', labels: [], assignees: [], column: 'backlog', order: 2, createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 3,
});

/** a store OUTSIDE the repo, holding a work-objects.jsonl with an OPEN window by ada on card #1 (the on-disk line format, read from the live file) */
function storeWithOpenWindow() {
  const dir = mk('work-retired-1763-');
  const at = new Date().toISOString();
  const replyBy = new Date(Date.now() + 3600_000).toISOString();
  const base = { id: 'w-1763-fixture', replyBy, required: ['ada', 'bo'], declaredBy: 'ada', sourceMessageId: null, card: 1 };
  const lines = [
    { ...base, seq: 0, transition: { type: 'declare', by: 'ada', at } },
    { ...base, seq: 1, transition: { type: 'bid', by: 'ada', at } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
  const file = path.join(dir, 'work-objects.jsonl');
  fs.writeFileSync(file, lines);
  return { dir, file };
}
const fileState = (file) => { const b = fs.readFileSync(file); return { sha: crypto.createHash('sha256').update(b).digest('hex'), bytes: b.length, mtimeMs: fs.statSync(file).mtimeMs }; };

async function withServers(env, fn) {
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env });
  try { await fn({ rest, mcp, session: await mcpSession(mcp.mcpUrl) }); }
  finally { await mcp.stop(); await rest.stop(); }
}
const oldPlist = (dir) => ({ SCRUM_WORK_GATE: 'on', SCRUM_WORK_STORE: dir });

// ── A1 ──
const MATRIX = [
  { gate: true, throttle: false }, { gate: true, throttle: true }, { gate: false, throttle: false }, { gate: false, throttle: true },
];
for (const { gate, throttle } of MATRIX) {
  test(`#1763 A1 — gate flag ${gate ? 'ON' : 'off'}, throttle ${throttle ? 'ON' : 'off'}: the seven work tools are ABSENT and the surface is not empty`, async () => {
    const env = {};
    if (gate) Object.assign(env, oldPlist(storeWithOpenWindow().dir));
    if (throttle) env.SCRUM_CLAIM_THROTTLE = 'on';
    await withServers(env, async ({ session }) => {
      const names = (await session.listTools()).result.tools.map((t) => t.name);
      assert.ok(names.includes('card_update') && names.includes('board_status') && names.length > 20, `CONTROL: the surface is real (${names.length} tools, card_update and board_status among them)`);
      const present = WORK_TOOLS.filter((t) => names.includes(t));
      assert.deepEqual(present, [], `A1: no work tool is registered, whatever the flags say (still present: ${present.join(', ')})`);
    });
  });
}

// ── A2 + C ──
test('#1763 A2 + C — OLD PLIST, NEW CODE: an open window on the card no longer refuses its declarer, the edits land, and the file is never written', async () => {
  const { dir, file } = storeWithOpenWindow();
  const before = fileState(file);
  await withServers(oldPlist(dir), async ({ session }) => {
    const upd = payload(await session.callTool('card_update', { id: '1', title: 'edited inside what used to be my open window', by: 'ada' }));
    assert.equal(upd.refused, undefined, `A2: card_update on the declared card is not refused (${JSON.stringify(upd).slice(0, 200)})`);
    assert.equal(upd.title, 'edited inside what used to be my open window', 'A2: and the edit landed');
    const mv = payload(await session.callTool('card_move', { id: '1', column: 'done', by: 'ada' }));
    assert.equal(mv.refused, undefined, `A2: card_move on the declared card is not refused (${JSON.stringify(mv).slice(0, 200)})`);
    const fresh = payload(await session.callTool('card_get', { id: '1' }));
    assert.equal(fresh.column, 'done', 'A2: the move landed');
    // C: create, claim, get and board_status as well; none of them writes the retired file
    payload(await session.callTool('card_create', { createdBy: 'ada', title: 'a card made in the retired world' }));
    await session.callTool('card_claim', { id: '2', by: 'ada' });
    await session.callTool('board_status', {});
    const after = fileState(file);
    assert.deepEqual(after, before, 'C: the retired file\'s bytes and mtime are unchanged after create, update, move, claim, get and board_status');
  });
});

// ── B ──
test('#1763 B — board_status reports the ledger as RETIRED, with the file made unreadable, so nothing read it', async () => {
  const { dir, file } = storeWithOpenWindow();
  fs.chmodSync(file, 0o000);
  try {
    await withServers(oldPlist(dir), async ({ session }) => {
      const reply = await session.callTool('board_status', {});
      const text = reply.result.content[0].text;
      let status; try { status = JSON.parse(text); } catch { assert.fail(`B: board_status did not answer JSON with the retired file unreadable; it said: ${text.slice(0, 160)}`); }
      assert.ok(status.workLedger && typeof status.workLedger === 'object', `B: board_status still carries a workLedger summary (keys: ${Object.keys(status).slice(0, 12).join(', ')})`);
      assert.equal(status.workLedger.retired, true, `B: it says retired (got ${JSON.stringify(status.workLedger).slice(0, 200)})`);
      assert.equal(status.workLedger.open, undefined, 'B: and no longer lists open windows from a file');
      assert.equal(status.workLedger.actions, null, 'B: with no executor the count is null, never a fabricated 0');
      assert.equal(status.workLedger.workObjects, null, 'B: and so is the WorkObject count');
      assert.equal(typeof status.workLedger.unavailable, 'string', 'B: and the reply says why (unavailable: <reason>)');
    });
  } finally { fs.chmodSync(file, 0o644); }
});

// ── E (source) ──
test('#1763 E — the four work modules are gone, nothing imports them, and server.js no longer calls projectWorkLedger', () => {
  for (const m of ['work-tools', 'work-gate', 'work-store', 'work-auction']) assert.equal(fs.existsSync(path.join(ROOT, 'core', `${m}.mjs`)), false, `E: core/${m}.mjs is deleted`);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', '.git', 'tests', 'graph-executor'].includes(e.name)) return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (/\.(mjs|js|cjs)$/.test(e.name) ? [p] : []);
  });
  const importers = walk(ROOT).filter((f) => /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*work-(?:tools|gate|store|auction)(?:\.mjs)?['"]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(importers.map((f) => path.relative(ROOT, f)), [], 'E: nothing outside the tests imports a deleted work module');
  assert.ok(!/projectWorkLedger\s*\(/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'E: server.js no longer calls projectWorkLedger');
});

// ── F (guard) ──
test('#1763 F — GUARD: the claim throttle is KEPT: a second seat inside the cooldown is refused, with the gate flags absent', async () => {
  await withServers({ SCRUM_CLAIM_THROTTLE: 'on' }, async ({ session }) => {
    const first = payload(await session.callTool('card_create', { createdBy: 'ada', title: 'first in' }));
    assert.equal(first.refused, undefined, `PRECONDITION: the first create is accepted (${JSON.stringify(first).slice(0, 160)})`);
    const second = payload(await session.callTool('card_create', { createdBy: 'bo', title: 'racing bo' }));
    assert.equal(second.refused, true, `F: the throttle still refuses a second seat inside the cooldown (${JSON.stringify(second).slice(0, 200)})`);
  });
});

// ── executor-backed rows: B2, D1, D2 ──
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const TX = { skip: SKIP, timeout: 300000 };
const RS = 'https://scrumboard.local/ns#';
const ACTION = 'https://schema.org/Action', WORKOBJ = `${RS}WorkObject`, OFWORK = `${RS}ofWork`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DS = 'wl-1763';
async function withExecutor(fn) {
  const store = tmpStore('wl-1763-');
  const exec = await startExecutor({ store, datasetId: DS, create: true });
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DS, timeoutMs: 30000, label: 'wl-1763' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  const counts = async () => { const a = await q(`SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a <${RDF_TYPE}> <${ACTION}> }`); const w = await q(`SELECT (COUNT(DISTINCT ?w) AS ?n) WHERE { ?w <${RDF_TYPE}> <${WORKOBJ}> }`); return { actions: Number(a[0].n.value), workObjects: Number(w[0].n.value) }; };
  try { await fn({ exec, q, counts, store }); } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(`${store}.checkpoints`, { recursive: true, force: true }); }
}
const runProjector = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'activity-projector.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

test('#1763 B2 — board_status\'s ledger counts come from the GRAPH: seeded Actions and WorkObjects are counted, with the file unreadable', TX, async () => {
  await withExecutor(async ({ exec }) => {
    const { dir, file } = storeWithOpenWindow();   // a file that disagrees with the graph on purpose: it is never read
    fs.chmodSync(file, 0o000);
    const ep = (await (await fetch(`${exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/wl-1763-seed-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) },
      body: `INSERT DATA { <entity:work/wl-a> <${RDF_TYPE}> <${WORKOBJ}> . <entity:work/wl-b> <${RDF_TYPE}> <${WORKOBJ}> .
        <urn:wl:action/1> <${RDF_TYPE}> <${ACTION}> ; <${OFWORK}> <entity:work/wl-a> . <urn:wl:action/2> <${RDF_TYPE}> <${ACTION}> ; <${OFWORK}> <entity:work/wl-a> . <urn:wl:action/3> <${RDF_TYPE}> <${ACTION}> ; <${OFWORK}> <entity:work/wl-b> . }` });
    assert.equal(seed.status, 200, `PRECONDITION: the graph is seeded with 2 WorkObjects and 3 Actions (${seed.status} ${(await seed.text()).slice(0, 160)})`);
    const rest = await startRestServer({ board: board(), env: { SCRUM_GRAPH_DATASET_ID: DS, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_QUERY_SOURCE: 'executor' } });
    const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: oldPlist(dir) });
    try {
      const session = await mcpSession(mcp.mcpUrl);
      const text = (await session.callTool('board_status', {})).result.content[0].text;
      let status; try { status = JSON.parse(text); } catch { assert.fail(`B2: board_status did not answer JSON; it said: ${text.slice(0, 160)}`); }
      assert.deepEqual({ retired: status.workLedger?.retired, actions: status.workLedger?.actions, workObjects: status.workLedger?.workObjects }, { retired: true, actions: 3, workObjects: 2 }, `B2: the ledger summary is the graph's counts (got ${JSON.stringify(status.workLedger).slice(0, 200)})`);
    } finally { await mcp.stop(); await rest.stop(); fs.chmodSync(file, 0o644); }
  });
});

// D: the projector's work half is gone. Today the CLI REQUIRES --work (exit 2 without it) and, given it, projects every line as Actions.
for (const withWork of [false, true]) {
  test(`#1763 D${withWork ? '2' : '1'} — the activity projector ${withWork ? 'WITH' : 'WITHOUT'} --work runs to completion and writes NO Action${withWork ? ', saying that --work is ignored' : ''}`, TX, async () => {
    await withExecutor(async ({ exec, counts }) => {
      const { dir } = storeWithOpenWindow();
      const logDir = mk('wl-1763-log-');
      const before = await counts();
      const r = await runProjector(['--log', logDir, ...(withWork ? ['--work', dir] : []), '--executor', exec.baseUrl, '--once']);
      assert.equal(r.status, 0, `D: the projector ${withWork ? 'accepts' : 'no longer requires'} --work and exits 0 (exit ${r.status}: ${(r.err || r.out).slice(-200)})`);
      assert.deepEqual(await counts(), before, `D: the graph's Action and WorkObject counts are unchanged (${JSON.stringify(before)})`);
      if (withWork) assert.ok(r.err.includes('work ledger retired (#1763): --work ignored'), `D2: it says so on stderr (stderr: ${r.err.slice(0, 200)})`);
    });
  });
}

// ── E2: the sprint review's signal 2 is RETIRED (the script takes --since --events --seats [--work-store]; it does not talk to REST) ──
const runReview = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'sprint-review.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});
for (const withStore of [false, true]) {
  test(`#1763 E2${withStore ? 'b' : 'a'} — the sprint review ${withStore ? 'WITH' : 'WITHOUT'} --work-store exits 0 and reports signal 2 as RETIRED${withStore ? ', saying --work-store is ignored' : ''}; retired is never counted as measured`, async () => {
    const events = mk('wl-1763-events-');
    const store = withStore ? storeWithOpenWindow().dir : null;
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const r = await runReview(['--since', since, '--events', events, '--seats', 'ada,bo', ...(withStore ? ['--work-store', store] : [])]);
    assert.equal(r.status, 0, `E2: the review exits 0 (exit ${r.status}: ${(r.err || r.out).slice(-200)})`);
    const line = r.out.split('\n').find((l) => /^SIGNAL 2/.test(l));
    assert.ok(line, `E2: the report has a SIGNAL 2 line (output starts: ${r.out.slice(0, 160)})`);
    assert.ok(/RETIRED since 2026-08-18 \(#1763\)/.test(line), `E2: signal 2 reads RETIRED since 2026-08-18 (#1763) (got: ${line.slice(0, 200)})`);
    const measurable = /(\d+) of (\d+) signals measurable/.exec(r.out);
    assert.ok(measurable && Number(measurable[1]) === 0, `E2: with nothing measured the report says 0 measurable, so a retired signal is not counted as measured (got: ${measurable ? measurable[0] : 'no such line'})`);
    if (withStore) assert.ok(r.err.includes('work ledger retired (#1763): --work-store ignored'), `E2: and it says --work-store is ignored on stderr (stderr: ${r.err.slice(0, 200)})`);
    else assert.ok(!r.err.includes('ignored'), 'E2: without the flag there is no such note');
  });
}

// ── TODO rows: node:test reports them as todo, never as a pass ──
const TODO = (why) => ({ todo: why });
