/**
 * #1764 — the roster's human seats are GRAPH state: one node per configured seat, in the file's ORDER, imported once; REST
 * reads and writes the graph; MCP reads REST. The test author's independent RED rows, written black-box against the
 * "#1764 CONTRACT" (commons, 2026-10-26 21:31Z) before the build. ⚠️ Next to the auth boundary: the roster decides which
 * seats exist, so every row checks the ORDER and the set exactly, not "contains".
 *
 * THE CONTRACT (one table, so a rename is one edit): node https://scrumboard.local/seat/<key>, a scrum:RosterSeat, with
 * scrum:rosterOrder (xsd:integer) and the seat's name/glyph/color/kind; the roles as one node
 * https://scrumboard.local/config/roster-roles. GET /api/roster keeps its shape ({ seats, roles, usingDefaults }), seats in
 * rosterOrder then the invited agents (a configured seat wins a key collision). POST /api/roster validates as today and
 * writes the graph: named seats created or updated, omitted seats removed. RULED 2026-10-26 21:51Z (option A, built as A+1): after
 * every save, roster.json is rewritten UNDER THE SAME LOCK, LAST, as an exact export of the graph's roster (seats in rosterOrder,
 * plus roles), and a failed export fails the save (not 200: the graph change stands, the export is named stale, the next
 * successful save repairs it); the file is still never READ after the import. Boot imports
 * roster.json ONCE, only when NO seat node exists. MCP reads REST GET /api/roster on a timer.
 *
 * THE WORLD: a fresh executor with the conversations and small-kinds units on (the collections path, as the #1785 C1 row
 * runs), REST over a board fixture, one roster file kept across restarts.
 *
 * ROWS:
 *   R1  the import preserves the file's ORDER (deliberately not alphabetical) and its roles; one node per seat with
 *       rosterOrder 0..n-1
 *   R2  a POST that renames one seat, removes one and adds one: GET answers exactly the POSTed set in the POSTed order, the
 *       removed seat's node is gone, the file is an EXACT EXPORT of that roster (seats in order, kinds kept, roles), and a
 *       restart answers the same
 *   R3  the file edited after the import, then a restart: nothing changes (the file is never READ), and the next save
 *       rewrites it as the export again
 *   F1  the export made to FAIL (the file and its folder unwritable): the POST is not 200, the graph change stands (GET
 *       shows it), the file still holds the previous export; once writable again, the next successful save repairs it
 *   R4  an invited agent whose seatKey collides with a configured seat loses: GET shows the configured seat
 *   R5  a boot with NO file, a POSTed roster, then a file that appears: a restart does NOT import it over the saved seats
 *   M1  MCP (its own roster file path never written) lists a POSTed seat in a NEW session's tool descriptions within 5 s
 *   U1  the board page's "Post as" picker lists the configured seats in rosterOrder, the first one first
 *
 * NOT COVERED, BY NAME: MCP's roster before its first good read; MCP keeping the last good roster with REST down (the
 * #1784 rows hold that shape for the channel config); seat tokens of a removed seat (a separate auth question).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer, startMcpServer, mcpSession, withBrowserServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const DSID = 'ros-1764';
const RS = 'https://scrumboard.local/ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SEAT = (k) => `https://scrumboard.local/seat/${k}`;
const ROLES_NODE = 'https://scrumboard.local/config/roster-roles';

// a file order that is NOT alphabetical, so an implementation that sorts cannot pass
const FILE = { seats: { zed: { name: 'Zed', glyph: 'z', color: '#111111' }, amy: { name: 'Amy', glyph: 'a', color: '#222222' }, mo: { name: 'Mo', glyph: 'm', color: '#333333' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } }, roles: { po: 'amy' } };
const POSTED = { seats: { zed: { name: 'Zed', glyph: 'z', color: '#111111' }, amy: { name: 'Amelia', glyph: 'A', color: '#222222' }, kip: { name: 'Kip', glyph: 'k', color: '#444444' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } }, roles: { po: 'amy' } };

async function world(fileContent, body) {
  const store = tmpStore('ros-1764-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-1764-'));
  const file = path.join(dir, 'roster.json');
  if (fileContent) fs.writeFileSync(file, JSON.stringify(fileContent));
  const env = { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_ROSTER_FILE: file };
  const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, timeoutMs: 30000, label: 'ros-1764' });
  const q = async (s) => { const r = await gc.query(s); assert.ok(r.ok, r.reason); return r.rows; };
  const servers = [];
  let rest = null, boardFile = null;
  const start = async () => {
    if (rest) rest.kill();
    rest = await startRestServer(boardFile ? { boardFile, env } : { board: makeBoardFixture({ cards: [], conversations: [] }), env });
    boardFile = rest.boardFile; servers.push(rest);
    return rest;
  };
  const call = async (method, route, payload) => {
    const x = await fetch(`${rest.baseUrl}${route}`, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
    const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
  };
  try { await body({ q, start, call, file, dir, rest: () => rest, env }); }
  finally { for (const r of servers.reverse()) await r.stop().catch(() => {}); await killExecutor(exec); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
}

/** the seat nodes in the graph: key → { order, datatype, name, glyph, color, kind } */
async function seatNodes(q) {
  const rows = await q(`SELECT ?s ?o ?n ?g ?c ?k WHERE { ?s <${RDF_TYPE}> <${RS}RosterSeat> ; <${RS}rosterOrder> ?o . OPTIONAL { ?s ?pn ?n FILTER(STRENDS(STR(?pn), "name")) } OPTIONAL { ?s ?pk ?k FILTER(STRENDS(STR(?pk), "kind")) } }`);
  const m = {};
  for (const r of rows) m[r.s.value.slice(SEAT('').length)] = { order: Number(r.o.value), datatype: r.o.datatype ?? null, name: r.n?.value ?? null, kind: r.k?.value ?? null };
  return m;
}
const keysOf = (seats) => Object.keys(seats || {});
/** the file is an EXACT export of the roster GET answers: the configured seats in order, every field, and the roles */
function assertExport(file, roster, label) {
  const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
  const want = configured(roster.seats);
  assert.deepEqual(Object.keys(exp.seats || {}), Object.keys(want), `${label}: the export lists the seats in rosterOrder`);
  for (const [k, v] of Object.entries(want)) assert.deepEqual(exp.seats[k], v, `${label}: the export carries seat ${k} exactly (kind included)`);
  assert.deepEqual(exp.roles, roster.roles, `${label}: the export carries the roles`);
}
const configured = (seats) => Object.fromEntries(Object.entries(seats || {}).filter(([, v]) => v?.kind !== 'agent'));

test('#1764 R1–R4 — imported once in the file\'s ORDER with its roles; a POST is graph-only; a later file edit changes nothing; a configured seat wins a collision', T, async () => {
  await world(FILE, async ({ q, start, call, file }) => {
    // R1 the import
    await start();
    const g1 = await call('GET', '/api/roster');
    assert.equal(g1.status, 200, `R1 GET (${g1.status})`);
    assert.deepEqual(keysOf(configured(g1.json.seats)), keysOf(FILE.seats), 'R1: GET lists the configured seats in the FILE\'s order (not sorted)');
    assert.deepEqual(g1.json.roles, FILE.roles, 'R1: the roles are the file\'s');
    const n1 = await seatNodes(q);
    assert.deepEqual(Object.keys(n1).sort(), keysOf(FILE.seats).sort(), 'R1: one scrum:RosterSeat node per configured seat');
    keysOf(FILE.seats).forEach((k, i) => {
      assert.equal(n1[k].order, i, `R1: ${k} has rosterOrder ${i}`);
      assert.equal(n1[k].datatype, `${XSD}integer`, `R1: ${k}'s rosterOrder is xsd:integer`);
      assert.equal(n1[k].name, FILE.seats[k].name, `R1: ${k}'s name`);
    });
    assert.equal(n1.board.kind, 'system', 'R1: a system seat keeps its kind');
    assert.ok((await q(`SELECT ?p WHERE { <${ROLES_NODE}> ?p ?o }`)).length > 0, 'R1: the roles live on their own node');

    // R2 a POST that renames, removes and adds
    const p2 = await call('POST', '/api/roster', POSTED);
    assert.equal(p2.status, 200, `R2 POST (${p2.status} ${p2.text.slice(0, 200)})`);
    const g2 = await call('GET', '/api/roster');
    assert.deepEqual(keysOf(configured(g2.json.seats)), keysOf(POSTED.seats), 'R2: GET lists exactly the POSTed seats in the POSTed order');
    assert.equal(g2.json.seats.amy.name, 'Amelia', 'R2: the renamed seat');
    assert.equal(g2.json.seats.mo, undefined, 'R2: the omitted seat is gone');
    const n2 = await seatNodes(q);
    assert.deepEqual(Object.keys(n2).sort(), keysOf(POSTED.seats).sort(), 'R2: the graph holds exactly the POSTed seats (the removed one\'s node is gone)');
    keysOf(POSTED.seats).forEach((k, i) => assert.equal(n2[k].order, i, `R2: ${k} has rosterOrder ${i}`));
    assertExport(file, g2.json, 'R2');
    await start();
    assert.deepEqual(keysOf(configured((await call('GET', '/api/roster')).json.seats)), keysOf(POSTED.seats), 'R2: a restart answers the same seats in the same order');

    // R3 a file edit after the import changes nothing
    fs.writeFileSync(file, JSON.stringify({ seats: { intruder: { name: 'Intruder', glyph: 'i', color: '#999999' } } }));
    await start();
    const g3 = await call('GET', '/api/roster');
    assert.deepEqual(keysOf(configured(g3.json.seats)), keysOf(POSTED.seats), 'R3: a later file edit changes nothing');
    assert.equal(g3.json.seats.intruder, undefined, 'R3: the file\'s new seat never appears');
    const p3 = await call('POST', '/api/roster', POSTED);
    assert.equal(p3.status, 200, `R3: a save (${p3.status})`);
    assertExport(file, (await call('GET', '/api/roster')).json, 'R3: the next save rewrote the edited file as the export');

    // F1 a failed export fails the save; the graph change stands; the next good save repairs the export
    const before = fs.readFileSync(file);
    const F1 = { ...POSTED, seats: { ...POSTED.seats, fay: { name: 'Fay', glyph: 'f', color: '#555555' } } };
    fs.chmodSync(file, 0o444); fs.chmodSync(path.dirname(file), 0o555);
    let pf;
    try { pf = await call('POST', '/api/roster', F1); }
    finally { fs.chmodSync(path.dirname(file), 0o755); fs.chmodSync(file, 0o644); }
    assert.notEqual(pf.status, 200, `F1: a save whose export fails is NOT acknowledged (${pf.status} ${pf.text.slice(0, 200)})`);
    assert.ok(fs.readFileSync(file).equals(before), 'F1: the file still holds the previous export');
    assert.ok((await call('GET', '/api/roster')).json.seats.fay, 'F1: the graph change stands (GET shows the new seat)');
    const pr = await call('POST', '/api/roster', F1);
    assert.equal(pr.status, 200, `F1: once writable, the save succeeds (${pr.status})`);
    assertExport(file, (await call('GET', '/api/roster')).json, 'F1: the next successful save repaired the export');

    // R4 an invited agent whose key collides with a configured seat loses
    const ag = await call('POST', '/api/agents', { seatKey: 'kip', by: 'amy', prompt: 'a colleague', model: { model: 'm-1764', protocol: 'openai' } });
    assert.ok(ag.status === 201 || ag.status === 200, `PRECONDITION: the agent is invited (${ag.status} ${ag.text.slice(0, 200)})`);
    const g4 = await call('GET', '/api/roster');
    assert.equal(g4.json.seats.kip?.name, 'Kip', 'R4: the configured seat wins the key collision');
    assert.notEqual(g4.json.seats.kip?.kind, 'agent', 'R4: and is not shown as the agent');
  });
});

test('#1764 R5 — a file that appears AFTER a POSTed roster is never imported over it', T, async () => {
  await world(null, async ({ start, call, file }) => {
    await start();
    const p = await call('POST', '/api/roster', POSTED);
    assert.equal(p.status, 200, `PRECONDITION: the POST (${p.status} ${p.text.slice(0, 200)})`);
    fs.writeFileSync(file, JSON.stringify(FILE));
    await start();
    const g = await call('GET', '/api/roster');
    assert.deepEqual(keysOf(configured(g.json.seats)), keysOf(POSTED.seats), 'R5: the saved seats survive a boot with a file present');
    assert.equal(g.json.seats.amy.name, 'Amelia', 'R5: the file\'s older values were not imported');
  });
});

test('#1764 M1, U1 — MCP lists a POSTed seat in a new session within 5 s; the page\'s Post-as picker follows rosterOrder', T, async () => {
  await world(FILE, async ({ start, call, dir, rest, env }) => {
    await start();
    const mcp = await startMcpServer({ restApiBase: rest().baseUrl, env: { SCRUM_ROSTER_FILE: path.join(dir, 'mcp-must-not-read.json'), MCP_ROSTER_REFRESH_MS: '500' } });
    try {
      const p = await call('POST', '/api/roster', POSTED);
      assert.equal(p.status, 200, `PRECONDITION: the POST (${p.status})`);
      let seen = false;
      for (const t0 = Date.now(); !seen && Date.now() - t0 < 5000; await new Promise((r) => setTimeout(r, 250))) {
        const s = await mcpSession(mcp.mcpUrl);
        const listed = await s.listTools();
        // the seat list an agent is told, from card_create's assignees description: "Array of assignee keys (a, b, …, unassigned)"
        const tools = listed.result?.tools ?? listed.tools ?? [];
        const desc = tools.find((t) => t.name === 'card_create')?.inputSchema?.properties?.assignees?.description || '';
        const keys = ((/assignee keys \(([^)]*)\)/.exec(desc) || [])[1] || '').split(',').map((x) => x.trim());
        seen = keys.includes('kip') && !keys.includes('mo');
      }
      assert.ok(seen, 'M1: a NEW MCP session lists the POSTed seat (kip) and no longer the removed one (mo) within 5 s');
    } finally { await mcp.stop(); }
    // U1 the page picker: the configured seats in rosterOrder, the first one first (REST stopped first: one server on the store)
    rest().kill();
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#convs-author option', { timeout: 10000 });
      const opts = await page.$$eval('#convs-author option', (os) => os.map((o) => o.value));
      const want = keysOf(POSTED.seats).filter((k) => POSTED.seats[k].kind !== 'system');
      assert.equal(opts[0], want[0], `U1: the picker's first option is the first configured seat (${opts})`);
      assert.deepEqual(opts.filter((o) => want.includes(o)), want, 'U1: the configured seats appear in rosterOrder');
    }, { server: { boardFile: rest().boardFile, env }, launch: { headless: 'new' } });
  });
});
