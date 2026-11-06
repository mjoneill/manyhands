/**
 * #1815 wiring, step B: the MCP arms the bell tick on its own interval, reading the schedule file, the seat state and the
 * bell's graph state through REST, and posting the opener as `board`.
 *
 * THE CONTRACT: SCRUM_CEREMONY_BELL=off disarms the bell in a process (the test harness sets it by default, so no other
 * MCP test can ring a bell into its fixture); anything else arms it. SCRUM_CEREMONY_SCHEDULE_FILE names the schedule
 * (default: ceremony-schedule.json beside mcp-server.mjs). MCP_BELL_TICK_MS sets the interval (default 60 s). The tick is
 * single-flight: a tick that would start while one runs is skipped, never queued (the #1388 lesson). The bell does NOT
 * ride the tending switch: it has its own `enabled` in the schedule file. Each process stamps its events with its own
 * bootId and bootAt.
 *
 * ROWS:
 *   M1  one MCP, a schedule whose slot is this minute, an SM declared: exactly one opener post by board naming the SM; a
 *       `fired` event in the graph carrying a bootId; tending is OFF and the bell still rings
 *   M2  two MCP processes, same board: still exactly one opener, and at least one suppressed-duplicate event; the two
 *       processes' events carry two different bootIds
 *   M3  the control: an MCP started with the harness default (bell off) over a due schedule posts nothing and records nothing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer, startMcpServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'cbm-1815';
const RS = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const H = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A schedule entry whose slot is the current UTC minute, waiting out a minute's last 10 s so a row never straddles one. */
async function thisMinute(kind) {
  if (60_000 - (Date.now() % 60_000) < 10_000) await sleep(60_000 - (Date.now() % 60_000) + 500);
  const d = new Date();
  return { kind, weekday: d.getUTCDay(), time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
}

async function world(body) {
  const store = tmpStore('cbm-1815-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-1815-'));
  const roster = path.join(dir, 'roster.json');
  fs.writeFileSync(roster, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c47ca0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
  const schedule = path.join(dir, 'ceremony-schedule.json');
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_ROSTER_FILE: roster };
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'cbm-1815' });
  const q = async (s) => { const r = await gc.query(s); assert.ok(r.ok, r.reason); return r.rows; };
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env });
  const mcps = [];
  const call = async (method, route, payload) => {
    const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
    const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
  };
  const mcp = async (extra = {}) => {
    const m = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_ROSTER_FILE: roster, SCRUM_CEREMONY_SCHEDULE_FILE: schedule, MCP_BELL_TICK_MS: '300', ...extra } });
    mcps.push(m); return m;
  };
  const openers = async () => {
    const r = await call('GET', '/api/conversations?attachedTo=null&limit=200');
    const list = Array.isArray(r.json) ? r.json : (r.json?.conversations ?? []);
    return list.filter((p) => p.author === 'board' && /^🔔/.test(p.body || ''));
  };
  const events = async () => (await q(`SELECT ?e ?o ?b WHERE { ?e <${RDF_TYPE}> <${RS}CeremonyBellEvent> . OPTIONAL { ?e <${RS}outcome> ?o } OPTIONAL { ?e <${RS}bootId> ?b } }`))
    .map((r) => ({ e: r.e.value, outcome: r.o?.value ?? null, bootId: r.b?.value ?? null }));
  try {
    const card = await call('POST', '/api/cards', { title: 'The scrum master role', by: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, `PRECONDITION: the role's card exists (${card.status} ${card.text.slice(0, 160)})`);
    const definedBy = (card.json?.card ?? card.json)?.shortId;
    const minted = await call('POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master', definition: 'Holds the cadence and opens the ceremonies; asks, never asserts.', definedBy });
    assert.ok(minted.status === 200 || minted.status === 201, `PRECONDITION: the role is minted (${minted.status} ${minted.text.slice(0, 160)})`);
    const declared = await call('PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, role: 'scrum-master', expiresAt: new Date(Date.now() + 2 * H).toISOString() });
    assert.equal(declared.status, 200, `PRECONDITION: ada holds the SM role (${declared.text.slice(0, 160)})`);
    const off = await call('POST', '/api/tending-config', { enabled: false, quietAfterMinutes: 60 });
    assert.equal(off.status, 200, `PRECONDITION: tending is off (${off.text.slice(0, 160)})`);
    await body({ q, call, mcp, schedule, openers, events, rest });
  } finally {
    for (const m of mcps) await m.stop().catch(() => {});
    await rest.stop().catch(() => {}); await killExecutor(exec);
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true });
  }
}
async function until(fn, ms = 20000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(200); } return v; }

test('#1815 M1–M2 — the MCP rings the bell once, across two processes, with tending off', T, async () => {
  await world(async ({ mcp, schedule, openers, events, call }) => {
    const entry = await thisMinute('review');
    fs.writeFileSync(schedule, JSON.stringify({ enabled: true, ceremonies: [entry] }));
    const now = new Date();
    const KEY = `review@${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), ...entry.time.split(':').map(Number))).toISOString()}`;
    await mcp({ SCRUM_CEREMONY_BELL: 'on' });
    const first = await until(async () => ((await openers()).length ? await openers() : null));
    assert.equal(first?.length, 1, `M1: exactly one opener post (${JSON.stringify(first)})`);
    assert.match(first[0].body, /@ada opens/, `M1: it names the SM (${first[0].body})`);
    const fired = await until(async () => (await events()).find((e) => e.outcome === 'fired'));
    assert.ok(fired, `M1: a fired event reached the graph (${(await events()).length} events)`);
    assert.ok(fired.bootId, 'M1: carrying its bootId');
    // R7 in production reads the stored createdAt, so the post's own id and createdAt must reach the bell's state
    const st = await until(async () => { const r = await call('GET', `/api/ceremony-bells?key=${encodeURIComponent(KEY)}`); return r.json?.value?.state === 'posted' ? r.json.value : null; });
    assert.equal(st?.postId, first[0].id, `M1: the stored postId is the opener's id (${JSON.stringify(st)})`);
    assert.equal(st?.createdAt, first[0].createdAt, 'M1: the stored createdAt is the server\'s own stamp on the post');

    // M2 a second process over the same board, same slot
    await mcp({ SCRUM_CEREMONY_BELL: 'on' });
    const dup = await until(async () => (await events()).find((e) => e.outcome === 'suppressed-duplicate'));
    assert.ok(dup, `M2: the second process records suppressed-duplicate (outcomes: ${JSON.stringify([...new Set((await events()).map((e) => e.outcome))])}, ${(await events()).length} events)`);
    await sleep(1500);
    assert.equal((await openers()).length, 1, 'M2: still exactly one opener across two processes');
    const boots = new Set((await events()).map((e) => e.bootId).filter(Boolean));
    assert.ok(boots.size >= 2, `M2: two processes, two bootIds (${[...boots]})`);
  });
});

test('#1815 M3 — the control: the harness default (bell off) rings nothing over a due schedule', T, async () => {
  await world(async ({ mcp, schedule, openers, events }) => {
    fs.writeFileSync(schedule, JSON.stringify({ enabled: true, ceremonies: [await thisMinute('review')] }));
    const m = await mcp();
    await sleep(2500);
    assert.equal((await openers()).length, 0, 'M3: no opener');
    assert.deepEqual(await events(), [], 'M3: no event');
    assert.match(m.stdoutText() + m.stderrText(), /ceremony bell: off/, 'M3: and the process says the bell is off');
  });
});
