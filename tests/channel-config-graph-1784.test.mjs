/**
 * #1784 — the channel config is GRAPH state: one node, read and written through REST, imported once from the old file, and
 * read by the MCP scheduler from REST with a last-good fallback. The test author's independent RED rows, written black-box
 * against the "#1784 CONTRACT" (commons, 2026-10-26 20:13Z) before the build. The builder does not write these rows.
 *
 * THE WORLD: the whole-board fixture in a real executor, REST under all six units and the four executor sources, the board
 * document off, the allocator seeded, the reference index backfilled (production's mode), a seat token on every call. ONE
 * channel-config file is kept across REST restarts (harness `channelConfigFile`), so "the file is never read again" can be
 * tested by changing it between boots.
 *
 * THE CONTRACT (one table, so a rename is one edit): node https://scrumboard.local/config/channel, a scrum:ChannelConfig,
 * with scrum:channelMode, scrum:softMinMs, scrum:softMaxMs, scrum:hardTimeoutMs, scrum:tokenRingTimeoutMs, and on the one-time
 * import scrum:configImportedFrom / scrum:configImportedAt. GET /api/config keeps its pinned response shape and answers
 * DEFAULT_CONFIG with no node; POST /api/config validates as today (400 + message) and writes the graph. MCP reads REST
 * (MCP_CHANNEL_CONFIG_REFRESH_MS), keeps the LAST GOOD config when REST fails.
 *
 * ROWS:
 *   G0  no file, no node: GET is the default (mode soft); a POST creates the node, WITHOUT import facts, and writes no file
 *   G6  then a file appears and REST restarts: the UI-saved node is NOT overwritten (import only when there is no node at all)
 *   G1  a file at first boot is IMPORTED once: GET answers its values; the node carries them and the import facts
 *   G2  a valid POST: 200 with the clean config, GET agrees, the node agrees, and the file is byte-identical (never written)
 *   G3  an invalid POST: 400, and nothing changes (GET, the node's values and its graph version)
 *   G4  restart with the file still holding the old value: the POSTed value survives, and the import is NOT repeated
 *   G5  the file edited after the import, then a restart: nothing changes
 *   M1  MCP (stagger on, refresh 500 ms) reports the graph's mode on /channel/status, and a POSTed mode within 5 s
 *   M2  REST down: MCP keeps the LAST GOOD mode for several refresh periods, never falling back to the default
 *
 * The world runs with the collections unit ON (SCRUM_GRAPH_UNIT_SMALLKINDS=1, a real executor), so a boot import that writes
 * outside the write lock (refused in production, "#1624: a collection write outside withWriteLock") cannot pass G1 by being
 * swallowed.
 *
 * NOT COVERED, BY NAME: MCP's mode before its first good read; the
 * bearer-seat and resident-wake facts (their fields are passed through and compared via GET only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { startRestServer, startMcpServer } from './helpers/harness.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL = path.join(HERE, '..', 'scripts', 'card-ref-index-1744.mjs');
const BK = BOOKKEEPING_GRAPH;
const RS = 'https://scrumboard.local/ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// ── THE CONTRACT ──
const NODE = 'https://scrumboard.local/config/channel';
const P = { type: `${RS}ChannelConfig`, mode: `${RS}channelMode`, softMin: `${RS}softMinMs`, softMax: `${RS}softMaxMs`, hard: `${RS}hardTimeoutMs`, importedFrom: `${RS}configImportedFrom`, importedAt: `${RS}configImportedAt` };

const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const SOURCES = { SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
const ROSTER = path.join(os.tmpdir(), `cc-1784-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKENS = path.join(os.tmpdir(), `cc-1784-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
process.once('exit', () => { for (const f of [ROSTER, TOKENS]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } } });

const HARD = { mode: 'hard', soft: { minMs: 20000, maxMs: 40000 }, hard: { timeoutMs: 240000 } };
const OFFCFG = { mode: 'off', soft: { minMs: 25000, maxMs: 45000 }, hard: { timeoutMs: 200000 } };
const SOFTX = { mode: 'soft', soft: { minMs: 31000, maxMs: 61000 }, hard: { timeoutMs: 301000 } };
const INVALID = { mode: 'soft', soft: { minMs: 50000, maxMs: 10000 }, hard: { timeoutMs: 60000 } };

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a production-mode world; `start()` (re)starts REST against the same store and the same channel-config file */
async function world(cfgFile, body) {
  const w = await wholeBoardWorld({ env: { ...UNITS, ...SOURCES } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);   // the harness unlinks the board file on stop
  const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'cc-1784' });
  const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, `the executor answered (${r.reason})`); return r.rows; };
  const servers = [];
  let rest = null;
  try {
    const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
    const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-cc-1784';
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/cc-1784-allocator-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
    assert.equal(seed.status, 200, `PRECONDITION: the allocator is seeded (${await seed.text()})`);
    const b = await runNode([BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill']);
    assert.equal(b.status, 0, `PRECONDITION: the reference index is backfilled (exit ${b.status}: ${(b.err || b.out).slice(-300)})`);
    const start = async () => {
      if (rest) { await rest.stop().catch(() => {}); }
      try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
      if (!fs.existsSync(w.boardFile)) fs.writeFileSync(w.boardFile, kept);
      fs.chmodSync(w.boardFile, 0o000);
      rest = await startRestServer({ boardFile: w.boardFile, channelConfigFile: cfgFile, env: { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...SOURCES, SCRUM_BOARD_DOCUMENT: 'off', SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required' } });
      servers.push(rest);
      return rest;
    };
    const call = async (method, route, payload) => {
      const headers = { authorization: `Bearer ${TOK}`, ...(payload ? { 'content-type': 'application/json' } : {}) };
      const x = await fetch(`${rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
      const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
    };
    await body({ q, start, call, rest: () => rest });
  } finally {
    try { fs.chmodSync(w.boardFile, 0o644); } catch { /* absent */ }
    for (const r of servers) await r.stop().catch(() => {});
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    await w.stop();
  }
}

/** the node's facts: predicate → [values] (default graph) */
async function nodeFacts(q) {
  const m = {};
  for (const r of await q(`SELECT ?p ?o WHERE { <${NODE}> ?p ?o }`)) (m[r.p.value] ||= []).push(r.o.value);
  return m;
}
const nodeVersion = async (q) => (await q(`SELECT ?v WHERE { GRAPH <${BK}> { <${NODE}> <urn:ex:ver> ?v } }`)).map((r) => r.v.value);
/** the GET fields the contract pins, compared to a config */
const pinned = (got, want, label) => {
  assert.equal(got.mode, want.mode, `${label}: mode`);
  assert.deepEqual(got.soft, want.soft, `${label}: soft`);
  assert.deepEqual(got.hard, want.hard, `${label}: hard`);
};
const factsAre = (f, want, label) => {
  assert.ok((f[RDF_TYPE] || []).includes(P.type), `${label}: the node is a scrum:ChannelConfig`);
  assert.deepEqual(f[P.mode], [want.mode], `${label}: scrum:channelMode`);
  assert.deepEqual((f[P.softMin] || []).map(Number), [want.soft.minMs], `${label}: scrum:softMinMs`);
  assert.deepEqual((f[P.softMax] || []).map(Number), [want.soft.maxMs], `${label}: scrum:softMaxMs`);
  assert.deepEqual((f[P.hard] || []).map(Number), [want.hard.timeoutMs], `${label}: scrum:hardTimeoutMs`);
};

test('#1784 G0, G6 — no file and no node: GET is the default; a POST creates the node without import facts, writes no file, and a later file never overwrites it', T, async () => {
  const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-1784-g0-')), 'channel-config.json');
  try {
    await world(cfgFile, async ({ q, start, call }) => {
      await start();
      const g = await call('GET', '/api/config');
      assert.equal(g.status, 200, `G0 GET (${g.status})`);
      assert.equal(g.json.mode, 'soft', 'G0: with no node and no file the answer is the default (mode soft)');
      assert.equal(Object.keys(await nodeFacts(q)).length, 0, 'G0: no node yet');
      const p = await call('POST', '/api/config', OFFCFG);
      assert.equal(p.status, 200, `G0 POST (${p.status} ${p.text.slice(0, 200)})`);
      const f = await nodeFacts(q);
      factsAre(f, OFFCFG, 'G0');
      assert.equal((f[P.importedFrom] || []).length + (f[P.importedAt] || []).length, 0, 'G0: a POSTed node carries no import facts');
      assert.equal(fs.existsSync(cfgFile), false, 'G0: the POST wrote no file');

      // G6 a file appearing AFTER a node exists is never imported: import happens only when there is no node at all
      fs.writeFileSync(cfgFile, JSON.stringify(HARD));
      await start();
      pinned((await call('GET', '/api/config')).json, OFFCFG, 'G6: the UI-saved value survives a boot with a file present');
      const f6 = await nodeFacts(q);
      factsAre(f6, OFFCFG, 'G6 node');
      assert.equal((f6[P.importedFrom] || []).length + (f6[P.importedAt] || []).length, 0, 'G6: no import happened');
    });
  } finally { fs.rmSync(path.dirname(cfgFile), { recursive: true, force: true }); }
});

test('#1784 G1–G5, M1–M2 — imported once, then graph-only; MCP reads REST and keeps the last good mode', T, async () => {
  const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-1784-')), 'channel-config.json');
  const mcpCfg = path.join(path.dirname(cfgFile), 'mcp-must-not-read.json');   // the MCP's OWN file path: never written, so a file read answers the default
  let mcp = null;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify(HARD));
    await world(cfgFile, async ({ q, start, call, rest }) => {
      // G1 the first boot imports the file
      await start();
      const g1 = await call('GET', '/api/config');
      assert.equal(g1.status, 200, `G1 GET (${g1.status})`);
      pinned(g1.json, HARD, 'G1 GET answers the imported file');
      const f1 = await nodeFacts(q);
      factsAre(f1, HARD, 'G1 node');
      assert.equal((f1[P.importedFrom] || []).length, 1, 'G1: the node records where it was imported from');
      assert.equal((f1[P.importedAt] || []).length, 1, 'G1: and when');
      const importedAt = f1[P.importedAt][0];

      // G2 a valid POST writes the graph, never the file
      const fileBytes = fs.readFileSync(cfgFile);
      const p2 = await call('POST', '/api/config', OFFCFG);
      assert.equal(p2.status, 200, `G2 POST (${p2.status} ${p2.text.slice(0, 200)})`);
      pinned(p2.json, OFFCFG, 'G2 the POST answers the clean config');
      pinned((await call('GET', '/api/config')).json, OFFCFG, 'G2 GET');
      factsAre(await nodeFacts(q), OFFCFG, 'G2 node');
      assert.ok(fs.readFileSync(cfgFile).equals(fileBytes), 'G2: the file is byte-identical (never written)');

      // G3 an invalid POST changes nothing
      const v3 = await nodeVersion(q);
      const p3 = await call('POST', '/api/config', INVALID);
      assert.equal(p3.status, 400, `G3: refused (${p3.status} ${p3.text.slice(0, 200)})`);
      assert.ok(typeof p3.json?.error === 'string' && p3.json.error.length > 0, 'G3: with validateConfig\'s message');
      pinned((await call('GET', '/api/config')).json, OFFCFG, 'G3 GET unchanged');
      factsAre(await nodeFacts(q), OFFCFG, 'G3 node unchanged');
      assert.deepEqual(await nodeVersion(q), v3, 'G3: the node\'s graph version did not move');

      // G4 restart with the file still holding the old value
      await start();
      pinned((await call('GET', '/api/config')).json, OFFCFG, 'G4: the POSTed value survives a restart');
      assert.deepEqual((await nodeFacts(q))[P.importedAt], [importedAt], 'G4: the import was not repeated');

      // G5 the file edited after the import changes nothing
      fs.writeFileSync(cfgFile, JSON.stringify(SOFTX));
      await start();
      pinned((await call('GET', '/api/config')).json, OFFCFG, 'G5: a later file edit changes nothing');
      factsAre(await nodeFacts(q), OFFCFG, 'G5 node');

      // M1 MCP reports the graph's mode, and a POSTed mode within 5 s
      mcp = await startMcpServer({ restApiBase: rest().baseUrl, env: { SCRUM_CHANNEL_STAGGER: 'on', MCP_CHANNEL_CONFIG_REFRESH_MS: '500', SCRUM_CHANNEL_CONFIG_FILE: mcpCfg, SCRUM_SEAT_TOKENS: TOKENS } });
      const status = async () => { try { const r = await fetch(`${mcp.baseUrl}/channel/status`, { signal: AbortSignal.timeout(5000) }); return (await r.json()).mode; } catch (e) { return `ERR ${e.message}`; } };
      const waitMode = async (want, ms) => { let m; for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) { m = await status(); if (m === want) return m; } return m; };
      assert.equal(await waitMode('off', 5000), 'off', 'M1: MCP reports the graph\'s mode (off), not its own file\'s default');
      const p6 = await call('POST', '/api/config', HARD);
      assert.equal(p6.status, 200, `M1 POST (${p6.status})`);
      assert.equal(await waitMode('hard', 5000), 'hard', 'M1: a POSTed mode reaches MCP within 5 s');

      // M2 REST down: the last good mode holds
      rest().kill();
      await sleep(3000);   // six refresh periods
      assert.equal(await status(), 'hard', 'M2: with REST down MCP keeps the LAST GOOD mode, never the default');
    });
  } finally {
    if (mcp) await mcp.stop().catch(() => {});
    fs.rmSync(path.dirname(cfgFile), { recursive: true, force: true });
  }
});
