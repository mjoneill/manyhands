/**
 * #1639 COLUMNS, from board-data.json to the executor, behind its own switch `SCRUM_GRAPH_UNIT_COLUMNS`. The separate test author's rows, written BEFORE the build, synthetic content. REST with a REAL executor behind a proxy, as the
 * other K13 rows. The node shape is the builder's decision of 2026-10-09 03:32Z on the card: columns keep their IRIs `https://scrumboard.local/column/<id>`, in the default graph
 * `<iri> a scrum:Column ; schema:identifier "<id>" ; schema:name "<name>" ; scrum:order <xsd:integer> ; scrum:inCollection "columns"`, with `ver` and `entityJson` in the bookkeeping graph (#1638). Without a python with pyoxigraph
 * the unit-on rows are SKIPPED, and a skip is NOT a pass.
 *
 *   C0  CONTROL (green today): with the unit OFF the column script answers as listed below, and a card's column is read from the file.
 *   C1  PARITY OF ANSWERS AND REFUSALS: the same script on a unit-on server answers the same statuses and masked wire (the list compared as a set; ids masked where the server mints them).
 *   C2  THE GRAPH HOLDS THE COLUMNS, THE FILE DOES NOT WRITE THEM: after the script the executor holds the four original columns plus the one the script creates (not a count to match against the file) as `scrum:Column` nodes with name and an xsd:integer order, EXACTLY ONCE
 *       each, and the board file's columns are exactly the fixture's (a control with the unit OFF changes them).
 *   C3  THE SHAPE: each column node carries the type, identifier, name, integer order and collection exactly as the card states, at the IRI `https://scrumboard.local/column/<id>`; `ver`/`entityJson`/receipt triples for a column
 *       are in the bookkeeping graph and NONE in the default graph.
 *   C4  A CARD MOVE READS BACK WITHOUT A FILE WRITE: a card is moved to another column; a GET of the card shows it; the board file's `columns` are untouched and the cards' column is read through the executor's `scrum:column`.
 *   C5  DELETE KEEPS ITS RULES: deleting a column that holds a card moves the card to the first remaining column (header `X-Cards-Moved`), deleting the last column is a 400, an unknown column a 404; unit-on equals unit-off.
 *   C6  FAIL LOUD: executor away: list, get, create, patch and delete answer 503 (never an empty list, never a 200/201/204); a malformed request is still a 400 on its own grounds; back: the create lands once.
 *   C7  NO DUPLICATES ON A RE-RUN: a dry run of the migration writes nothing; --apply writes the four original nodes exactly once each; a second --apply leaves exactly the same triples.
 *   C8  REFERENTIAL: after the script no card in the executor references a column IRI that has no node.
 *
 * KNOWN DEFECT PINNED, NOT FIXED HERE (#1654): `create non-string name` answers 500 today (handleCreateColumn calls `.trim()` before the shape validator). C0 pins the 500 and C1 requires unit-on to answer the same, so #1639 neither fixes nor hides it; when #1654 lands, this one value changes to 400.
 *
 * SCRIPT: list; get one; get unknown (404); create (201), create without a name (400), a 51-character name (400), a non-string name (400), a non-number order (400); patch name and order (200), an echo of the stored values (200, nothing
 * reported), an unknown field (200 with `ignoredFields`), an `id` change (200 with `refusedFields`), unknown column (404), a bad name (400); list.
 *
 * HOW THE FOUR FILE COLUMNS REACH THE EXECUTOR (the builder's answer, 2026-10-09 03:36Z): a migration entry point, not an import at boot: `node scripts/migrate-columns-1639.mjs --board-data <path> --executor <url> --dataset <id> [--apply]`;
 * a dry run writes nothing, `--apply` writes the four nodes in one update, and a second `--apply` is a no-op. `migrate()` below runs it, with the server stopped, before a unit-on server starts.
 *
 * NOT COVERED, by name: concurrent column writes; the migration CLI's backup check and the retirement of the file's column nodes (a second file of rows once the build names its migrate/retire entry point); the board page's reload
 * order in a browser; the MCP column tools; the order of the list (compared as a set, except C9 which names it).
 *
 *   C9  ORDER IS THE STORED ORDER: the list sorted by `order` is backlog, planned, in-progress, done, then the created column at the order it was given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE = path.join(REPO, 'scripts', 'migrate-columns-1639.mjs');
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_COLUMNS';
const COLUMN_NS = 'https://scrumboard.local/column/';
const BK_GRAPH = 'urn:scrum:bookkeeping:executor';
const ORIGINAL = [['backlog', 'Backlog', 0], ['planned', 'Planned', 1], ['in-progress', 'In Progress', 2], ['done', 'Done', 3]];
const ROSTER_FILE = path.join(os.tmpdir(), `c1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const maskDeep = (v) => {
  if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<time>');
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
};
const asSet = (v) => (Array.isArray(v) ? [...v].map((x) => JSON.stringify(maskDeep(x))).sort() : maskDeep(v));
const record = (out) => (label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' ? (Array.isArray(r.body) ? asSet(r.body) : maskDeep(r.body)) : null]);

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
/** stop a REST server but KEEP its board file: the harness's stop() unlinks the file, and "REST stopped, file on disk" is exactly the state the migration and rollback scripts run in */
async function stopKeeping(rest, boardFile) {
  let bytes = null; try { bytes = fs.readFileSync(boardFile); } catch { /* none */ }
  await rest.stop();
  if (bytes) fs.writeFileSync(boardFile, bytes);
}
/** run the migration entry point against a board file and an executor; resolves {code, out}. A missing script is a failed migration (the RED reason before the build), never a skip. */
function migrate({ boardFile, execUrl, dsid, apply }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [MIGRATE, '--board-data', boardFile, '--executor', execUrl, '--dataset', dsid, ...(apply ? ['--apply'] : [])], { timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });
}
/** run the rollback entry point (REST stopped); resolves {code, out, last} where `last` is the final stdout line parsed as JSON when it is one */
function rollback({ boardFile, execUrl, dsid, dryRun = false }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, 'scripts', 'rollback-columns-1639.mjs'), '--board-file', boardFile, '--executor-url', execUrl, '--dataset-id', dsid, ...(dryRun ? ['--dry-run'] : [])], { timeout: 120000 }, (err, stdout, stderr) => {
      const lines = String(stdout).trim().split('\n'); let last = null; try { last = JSON.parse(lines[lines.length - 1]); } catch { /* not json */ }
      resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}`, last });
    });
  });
}
/** `columns`: the unit under test (the four columns are migrated into the executor first, with the server stopped, as the builder said). `cards`: the cards unit, ON in production today, so the rows that touch cards run as production does. */
async function serve({ columns, cards = false }, body, dsid = 'c1k-test') {
  const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  let rest = null;
  try {
    if (columns) { const m = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true }); assert.equal(m.code, 0, `precondition: the migration entry point applies (exit ${m.code}): ${m.out.slice(0, 300)}`); }
    const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', ...(cards ? { SCRUM_GRAPH_UNIT_CARDS: '1' } : {}), ...(columns ? { [UNIT_ENV]: '1' } : {}) };
    rest = await startRestServer({ boardFile, env });
    return await body({ base: rest.baseUrl, rest, proxy, exec, boardFile, dsid });
  } finally { if (rest) await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
const unitOn = (body, dsid) => serve({ columns: true }, body, dsid);
/** the board file's columns, whichever shape it is in on disk (the fixture is the legacy `columns` array; a saved file is JSON-LD `@graph` nodes), as sorted {id,name,order} */
function fileColumns(rest) {
  const d = rest.readBoardFile();
  const list = Array.isArray(d.columns) ? d.columns.map((c) => ({ id: c.id, name: c.name, order: c.order }))
    : (d['@graph'] ?? []).filter((n) => [].concat(n['@type']).includes('scrum:Column')).map((n) => ({ id: n.identifier, name: n.name, order: n['scrum:order'] }));
  return list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
/** run a SPARQL SELECT against the executor's store, any graph, and return the bindings */
async function select(execUrl, query) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: query, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings;
}
/** every triple of a subject, tagged with its graph ('' for the default graph) */
async function triplesOf(execUrl, iri) {
  const rows = await select(execUrl, `SELECT ?g ?p ?o WHERE { { <${iri}> ?p ?o } UNION { GRAPH ?g { <${iri}> ?p ?o } } }`);
  return rows.map((b) => ({ g: b.g?.value ?? '', p: b.p.value, o: b.o.value, odt: b.o.datatype ?? null }));
}
const columnSubjects = async (execUrl) => (await select(execUrl, `SELECT ?s WHERE { ?s a <https://scrumboard.local/ns#Column> }`)).map((b) => b.s.value).sort();

async function columnScript(base, tag) {
  const out = []; const rec = record(out);
  const made = `c1${tag.slice(-8)}`;
  rec('list', await api(base, 'GET', '/api/columns'));
  rec('get', await api(base, 'GET', '/api/columns/backlog'));
  rec('get unknown', await api(base, 'GET', '/api/columns/no-such-column'));
  rec('create', await api(base, 'POST', '/api/columns', { id: made, name: `${tag} Review`, order: 4 }));
  rec('create no name', await api(base, 'POST', '/api/columns', { id: `${made}b` }));
  rec('create 51-char name', await api(base, 'POST', '/api/columns', { id: `${made}c`, name: 'x'.repeat(51) }));
  rec('create non-string name', await api(base, 'POST', '/api/columns', { id: `${made}d`, name: 7 }));
  rec('create non-number order', await api(base, 'POST', '/api/columns', { id: `${made}e`, name: 'Odd', order: 'first' }));
  rec('patch', await api(base, 'PATCH', `/api/columns/${made}`, { name: `${tag} Reviewing`, order: 5 }));
  rec('patch echo', await api(base, 'PATCH', `/api/columns/${made}`, { name: `${tag} Reviewing`, order: 5 }));
  rec('patch unknown field', await api(base, 'PATCH', `/api/columns/${made}`, { colour: 'red' }));
  rec('patch id change', await api(base, 'PATCH', `/api/columns/${made}`, { id: 'something-else' }));
  rec('patch unknown column', await api(base, 'PATCH', '/api/columns/no-such-column', { name: 'x' }));
  rec('patch bad name', await api(base, 'PATCH', `/api/columns/${made}`, { name: 'y'.repeat(51) }));
  rec('list after', await api(base, 'GET', '/api/columns'));
  return { out, made };
}
const WANT = { list: 200, get: 200, 'get unknown': 404, create: 201, 'create no name': 400, 'create 51-char name': 400, 'create non-string name': 500, 'create non-number order': 400, patch: 200, 'patch echo': 200, 'patch unknown field': 200, 'patch id change': 200, 'patch unknown column': 404, 'patch bad name': 400, 'list after': 200 };

test('C0 CONTROL: with the unit OFF every step of the script answers as listed in the header', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const { out } = await columnScript(rest.baseUrl, ALNUM());
    assert.deepEqual(Object.fromEntries(out.map(([l, c]) => [l, c])), WANT);
    assert.ok(fileColumns(rest).some((c) => String(c.id).startsWith('c1')), 'CONTROL: with the unit OFF the created column IS written to the board file (so C2 has something to fail on)');
  } finally { await rest.stop(); }
});

test('C1 PARITY OF ANSWERS AND REFUSALS: the script on a unit-on server answers the same statuses and masked wire', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const expected = (await columnScript(off.baseUrl, tag)).out;
    await unitOn(async ({ base }) => { assert.deepEqual((await columnScript(base, tag)).out, expected, 'every answer equals the unit-off answer'); });
  } finally { await off.stop(); }
});

test('C2 THE GRAPH HOLDS THE COLUMNS, THE FILE DOES NOT WRITE THEM: five nodes once each, the file`s columns unchanged', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const before = JSON.stringify(fileColumns(rest));
    const { made } = await columnScript(base, ALNUM());
    const subjects = await columnSubjects(exec.baseUrl);
    assert.deepEqual(subjects, [...ORIGINAL.map(([id]) => `${COLUMN_NS}${id}`), `${COLUMN_NS}${made}`].sort(), 'the executor holds the four original columns and the created one, each exactly once as a scrum:Column subject');
    for (const [id, name, order] of ORIGINAL) {
      const rows = (await triplesOf(exec.baseUrl, `${COLUMN_NS}${id}`)).filter((t) => t.g === '');
      assert.equal(rows.filter((t) => t.p.endsWith('#name') || t.p.endsWith('/name')).map((t) => t.o).join('|'), name, `${id}: one name`);
      const ord = rows.filter((t) => t.p.endsWith('#order'));
      assert.deepEqual(ord.map((t) => t.o), [String(order)], `${id}: one order`);
      assert.match(ord[0]?.odt ?? '', /#integer$/, `${id}: the order is an xsd:integer`);
    }
    assert.equal(JSON.stringify(fileColumns(rest)), before, 'the board file`s columns are exactly the fixture`s after every create, patch, delete and read');
  });
});

test('C3 THE SHAPE: type, identifier, name, integer order and collection in the default graph; ver, entityJson and receipts only in the bookkeeping graph', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, exec }) => {
    await columnScript(base, ALNUM());
    const rows = await triplesOf(exec.baseUrl, `${COLUMN_NS}backlog`);
    const dflt = rows.filter((t) => t.g === ''); const bk = rows.filter((t) => t.g === BK_GRAPH);
    const has = (arr, suffix, value) => arr.some((t) => t.p.endsWith(suffix) && (value === undefined || t.o === value));
    assert.ok(has(dflt, '#type') || dflt.some((t) => t.p.endsWith('22-rdf-syntax-ns#type') && t.o.endsWith('#Column')), 'the node is typed scrum:Column');
    assert.ok(has(dflt, 'identifier', 'backlog'), 'schema:identifier is the id');
    assert.ok(has(dflt, 'inCollection', 'columns'), 'scrum:inCollection "columns" is in the default graph (domain)');
    const BOOKKEEPING = ['urn:ex:ver', 'urn:ex:recordedBy', 'urn:ex:retiredBy', 'https://scrumboard.local/ns#entityJson'];
    for (const bad of BOOKKEEPING) assert.ok(!dflt.some((t) => t.p === bad), `no ${bad} on the column in the default graph`);
    assert.ok(!dflt.some((t) => t.p.endsWith('selfCheck')), 'no selfCheck on the column in the default graph');
    for (const want of ['urn:ex:ver', 'https://scrumboard.local/ns#entityJson']) assert.ok(bk.some((t) => t.p === want), `the bookkeeping graph carries the column's ${want}`);
  });
});

test('C4 A CARD MOVE READS BACK WITHOUT A FILE WRITE: the file`s columns stay untouched and the card shows its new column', { skip: SKIP, timeout: 300000 }, async () => {
  await serve({ columns: true, cards: true }, async ({ base, rest }) => {
    const tag = ALNUM();
    const card = (await api(base, 'POST', '/api/cards', { title: `${tag} movable`, description: 'x', createdBy: 'ada' })).body;
    assert.ok(card?.id, 'precondition: a card is created');
    const before = JSON.stringify(fileColumns(rest));
    const moved = await api(base, 'PATCH', `/api/cards/${card.id}`, { column: 'planned', by: 'ada' });
    assert.equal(moved.status, 200, `the move answers 200 (${moved.status} ${moved.text.slice(0, 120)})`);
    const back = await api(base, 'GET', `/api/cards/${card.id}`);
    assert.equal(back.body?.column, 'planned', 'the card reads back in planned');
    assert.equal(JSON.stringify(fileColumns(rest)), before, 'the board file`s columns are unchanged by the move');
  });
});

test('C5 DELETE KEEPS ITS RULES: a held card moves to the first remaining column, the last column is a 400, unknown is a 404; unit-on equals unit-off', { skip: SKIP, timeout: 300000 }, async () => {
  const scenario = async (base, tag) => {
    const out = [];
    await api(base, 'POST', '/api/columns', { id: `c5${tag.slice(-6)}`, name: `${tag} Temp`, order: 9 });
    const card = (await api(base, 'POST', '/api/cards', { title: `${tag} held`, description: 'x', createdBy: 'ada', column: `c5${tag.slice(-6)}` })).body;
    const del = await api(base, 'DELETE', `/api/columns/c5${tag.slice(-6)}`);
    out.push(['delete a column that holds a card', del.status, del.headers.get('x-cards-moved') ?? null]);
    out.push(['the held card is in the first remaining column', (await api(base, 'GET', `/api/cards/${card.id}`)).body?.column]);
    out.push(['delete unknown', (await api(base, 'DELETE', '/api/columns/no-such-column')).status]);
    for (const id of ['planned', 'in-progress', 'done']) await api(base, 'DELETE', `/api/columns/${id}`);
    out.push(['delete the last remaining column', (await api(base, 'DELETE', '/api/columns/backlog')).status]);
    return out;
  };
  const tag = ALNUM();
  // unit OFF = production today: columns in the file, CARDS already in the executor
  const expected = await serve({ columns: false, cards: true }, ({ base }) => scenario(base, tag), 'c1k-off');
  assert.equal(expected[0][1], 204, 'CONTROL: unit-off deletes the column with a 204');
  assert.match(String(expected[0][2]), /1 to backlog/, 'CONTROL: the header names the move');
  await serve({ columns: true, cards: true }, async ({ base }) => { assert.deepEqual(await scenario(base, tag), expected, 'the delete scenario answers the same as the unit-off server'); }, 'c1k-on');
});

test('C6 FAIL LOUD: executor away: list, get, create, patch and delete answer 503, a malformed request still 400; back: the create lands once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const id = `c6${tag.slice(-6)}`;
    assert.equal((await api(base, 'POST', '/api/columns', { id, name: `${tag} before`, order: 6 })).status, 201, 'CONTROL: a column is created while the executor is up');
    await proxy.down();
    const attempts = [
      ['list', await api(base, 'GET', '/api/columns')],
      ['get', await api(base, 'GET', `/api/columns/${id}`)],
      ['create', await api(base, 'POST', '/api/columns', { id: `${id}x`, name: 'during', order: 7 })],
      ['patch', await api(base, 'PATCH', `/api/columns/${id}`, { name: 'renamed during' })],
      ['delete', await api(base, 'DELETE', `/api/columns/${id}`)],
    ];
    for (const [label, r] of attempts) assert.equal(r.status, 503, `${label} with the executor away is a 503, never an empty list or a 2xx (${r.status} ${r.text.slice(0, 120)})`);
    assert.equal((await api(base, 'POST', '/api/columns', { id: `${id}m` })).status, 400, 'a malformed request is still a 400, on its own grounds');
    await sleep(500); await proxy.up();
    assert.equal((await api(base, 'POST', '/api/columns', { id: `${id}y`, name: 'after', order: 8 })).status, 201, 'back: a create lands');
    const ids = ((await api(base, 'GET', '/api/columns')).body ?? []).map((c) => c.id);
    assert.ok(ids.includes(id) && ids.includes(`${id}y`), 'the list shows the earlier and the later column');
    assert.ok(!ids.includes(`${id}x`), 'but not the one refused while the executor was away');
    assert.equal(ids.filter((x) => x === `${id}y`).length, 1, 'the created column appears once');
  });
});

test('C7 NO DUPLICATES ON A RE-RUN: a dry run writes nothing, --apply writes the four nodes once each, a second --apply changes nothing', { skip: SKIP, timeout: 300000 }, async () => {
  const dsid = 'c1k-rerun'; const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const countTriples = async () => Number((await select(exec.baseUrl, `SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${COLUMN_NS}")) } UNION { GRAPH ?g { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${COLUMN_NS}")) } } }`))[0].n.value);
  try {
    const dry = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: false });
    assert.equal(dry.code, 0, `the dry run succeeds (exit ${dry.code}): ${dry.out.slice(0, 300)}`);
    assert.deepEqual(await columnSubjects(exec.baseUrl), [], 'a dry run wrote no column node');
    assert.equal(await countTriples(), 0, 'a dry run wrote no column triple at all');
    const first = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(first.code, 0, `--apply succeeds (exit ${first.code}): ${first.out.slice(0, 300)}`);
    assert.deepEqual(await columnSubjects(exec.baseUrl), ORIGINAL.map(([id]) => `${COLUMN_NS}${id}`).sort(), 'the four original nodes, each exactly once');
    const after1 = await countTriples(); assert.ok(after1 >= 4 * 4, `CONTROL: the apply wrote real triples (${after1}), so "unchanged" below is not vacuous`);
    const second = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(second.code, 0, `a second --apply succeeds (exit ${second.code}): ${second.out.slice(0, 300)}`);
    assert.equal(await countTriples(), after1, 'the second --apply leaves exactly the same number of column triples');
    assert.deepEqual(await columnSubjects(exec.baseUrl), ORIGINAL.map(([id]) => `${COLUMN_NS}${id}`).sort(), 'and still exactly the four nodes, once each');
  } finally { await killExecutor(exec); }
});

test('C8 REFERENTIAL: after the script no card in the executor references a column IRI that has no node', { skip: SKIP, timeout: 300000 }, async () => {
  await serve({ columns: true, cards: true }, async ({ base, exec }) => {
    const tag = ALNUM();
    await columnScript(base, tag);
    for (const column of ['backlog', 'planned', 'done']) await api(base, 'POST', '/api/cards', { title: `${tag} in ${column}`, description: 'x', createdBy: 'ada', column });
    const dangling = await select(exec.baseUrl, `SELECT DISTINCT ?col WHERE { ?c <https://scrumboard.local/ns#column> ?col FILTER NOT EXISTS { ?col a <https://scrumboard.local/ns#Column> } }`);
    assert.deepEqual(dangling.map((b) => b.col.value), [], 'every column a card points at is a scrum:Column node in the executor');
    const control = await select(exec.baseUrl, `SELECT DISTINCT ?col WHERE { ?c <https://scrumboard.local/ns#column> ?col }`);
    assert.ok(control.length >= 3, 'CONTROL: the query sees the cards` columns (a zero would make the check above vacuous)');
  });
});

test('C9 ORDER IS THE STORED ORDER: sorted by order the list is backlog, planned, in-progress, done, then the created column at the order it was given', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => {
    const { made } = await columnScript(base, ALNUM());
    const list = (await api(base, 'GET', '/api/columns')).body;
    const sorted = [...list].sort((a, b) => a.order - b.order).map((c) => c.id);
    assert.deepEqual(sorted, ['backlog', 'planned', 'in-progress', 'done', made], 'the stored order, not the insertion order');
    assert.deepEqual(list.map((c) => c.id), sorted, 'and the list is SERVED already in ascending stored order (the builder`s stated design: the order a board shows); sorting it here would have hidden a reversed sort');
    assert.ok(list.every((c) => typeof c.order === 'number'), 'every order is a JSON number');
  });
});

// ── rows added after the build existed (1316187), from reading its server.js and the builder's own list of known gaps ──

/** true when the server REFUSES to start; if it started, it is stopped (a row that fails must not leave a live server holding the test process open) */
async function refusesToStart(opts) {
  let rest = null;
  try { rest = await startRestServer(opts); } catch { return true; }
  try { await rest.stop(); } catch { /* gone */ }
  return false;
}

test('C10 AN UNMIGRATED GRAPH REFUSES TO SERVE: unit on, no column nodes in the executor, the server does not start; and the unit without the conversations unit does not start either', { skip: SKIP, timeout: 300000 }, async () => {
  const dsid = 'c1k-unmigrated'; const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  try {
    assert.equal(await refusesToStart({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } }), true,
      'a unit-on server with no migrated columns refuses to start; it must not serve the file`s columns in their place');
    // the graph is migrated NOW, so an empty graph cannot be what refuses the next start: only the missing conversations unit can
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json'); fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
    const m = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(m.code, 0, `precondition: the migration applies (exit ${m.code}): ${m.out.slice(0, 300)}`);
    assert.equal(await refusesToStart({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, [UNIT_ENV]: '1' } }), true,
      'the columns unit WITHOUT the conversations unit refuses to start even though the graph holds its columns (so it is the missing unit, not an empty graph, that refuses)');
    const control = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
    try { assert.equal((await api(control.baseUrl, 'GET', '/api/columns')).status, 200, 'CONTROL: the same executor and wiring WITHOUT the columns unit starts and answers, so the two refusals above are the unit`s and not the harness`s'); } finally { await control.stop(); }
  } finally { try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});

/** create columns with the given ids and orders; return statuses and the resulting list (compared as a set) */
async function oddColumns(base, tag, items) {
  const out = [];
  for (const [label, body] of items) { const r = await api(base, 'POST', '/api/columns', { name: `${tag} ${label}`, ...body }); out.push([label, r.status]); }
  const list = await api(base, 'GET', '/api/columns');
  return { statuses: out, listStatus: list.status, list: (list.body ?? []).map((c) => JSON.stringify({ id: c.id, order: c.order, name: String(c.name).replace(tag, '<tag>') })).sort() };
}

test('C11 AN ID THE FILE ACCEPTS, THE GRAPH ACCEPTS: ids with a space, a slash, a hash, a question mark, non-ASCII or angle brackets answer the same on unit on and unit off, and read back whole', { skip: SKIP, timeout: 300000 }, async () => {
  const tag = ALNUM(); const ids = [['space', 'has space'], ['slash', 'a/b'], ['hash', 'x#y'], ['query', 'a?b'], ['unicode', 'ünï-çøl'], ['angle', '<tag>'], ['quote', 'say"hi"']];
  const items = ids.map(([label, id]) => [label, { id: `${tag}${id}` }]);
  const off = await serve({ columns: false }, ({ base }) => oddColumns(base, tag, items), 'c1k-odd-off');
  assert.ok(off.statuses.every(([, s]) => s === 201), `CONTROL: the file path accepts every one of these ids today (${JSON.stringify(off.statuses)})`);
  assert.equal(off.list.filter((x) => x.includes(tag)).length, ids.length, 'CONTROL: and lists every one of them');
  await serve({ columns: true }, async ({ base }) => {
    const on = await oddColumns(base, tag, items);
    assert.deepEqual(on.statuses, off.statuses, 'every create answers the same status as the file path (a 500 here is a column the file would have taken)');
    assert.deepEqual(on.list, off.list, 'and the list is the same set');
  }, 'c1k-odd-on');
});

test('C12 AN ORDER THE FILE ACCEPTS, THE GRAPH ACCEPTS: fractional, negative, zero and large orders answer the same and read back as the number that was sent', { skip: SKIP, timeout: 300000 }, async () => {
  const tag = ALNUM(); const items = [['half', 1.5], ['neg', -3], ['zero', 0], ['big', 100000], ['tenth', 0.1]].map(([label, order]) => [label, { id: `${tag}${label}`, order }]);
  const off = await serve({ columns: false }, ({ base }) => oddColumns(base, tag, items), 'c1k-ord-off');
  assert.ok(off.statuses.every(([, s]) => s === 201), `CONTROL: the file path accepts every one of these orders today (${JSON.stringify(off.statuses)})`);
  assert.ok(off.list.some((x) => x.includes('"order":1.5')), 'CONTROL: the file path reads 1.5 back as 1.5');
  await serve({ columns: true }, async ({ base }) => {
    const on = await oddColumns(base, tag, items);
    assert.deepEqual(on.statuses, off.statuses, 'every create answers the same status as the file path');
    assert.deepEqual(on.list, off.list, 'and every order reads back as the number sent (1.5 must not become 1 or 2)');
  }, 'c1k-ord-on');
});

test('C13 ROLLBACK LOSES NOTHING (#1639 review, 07:33Z on 1316187): create a column on the unit, move a card into it, switch the unit OFF with the same files, and the column the card sits in is still listed', { skip: SKIP, timeout: 300000 }, async () => {
  // The cutover bar (#1639 review, 07:33Z): switching the unit off alone is not a lossless rollback once columns were written on it. The builder chose a fenced copy back to the file at 07:33Z
  // (`scripts/rollback-columns-1639.mjs`, REST stopped, graph is the authority, modelled on rollback-posts-1574.mjs, whose CLI is `--board-file --executor-url --dataset-id [--dry-run]`).
  // This row is that sequence end to end: create a graph-only column, move a card into it, stop REST, run the rollback, switch the unit OFF with the same files, and REST shows the
  // column and the card in it. ASSUMPTION, named: the flag names follow rollback-posts-1574; if the build names them differently the `rollback()` helper is the one place to change.
  const dsid = 'c1k-rollback'; const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const envOn = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', [UNIT_ENV]: '1' };
  const { [UNIT_ENV]: _off, ...envOff } = envOn;
  const tag = ALNUM(); const made = `c13${tag.slice(-8)}`; let card = null;
  try {
    const m = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(m.code, 0, `precondition: the migration applies (exit ${m.code}): ${m.out.slice(0, 300)}`);
    const on = await startRestServer({ boardFile, env: envOn });
    try {
      const created = await api(on.baseUrl, 'POST', '/api/columns', { id: made, name: `${tag} Rollback`, order: 7 });
      assert.equal(created.status, 201, `precondition: a column is created on the unit (${created.status} ${created.text.slice(0, 160)})`);
      card = (await api(on.baseUrl, 'POST', '/api/cards', { title: `${tag} rides the new column`, description: 'x', createdBy: 'ada', column: made })).body;
      assert.ok(card?.id, 'precondition: a card is created in the new column');
      const moved = await api(on.baseUrl, 'PATCH', `/api/cards/${card.id}`, { column: made, by: 'ada' });
      assert.equal(moved.status, 200, `precondition: the card is in the new column (${moved.status})`);
    } finally { await stopKeeping(on, boardFile); }
    const rb = await rollback({ boardFile, execUrl: exec.baseUrl, dsid });
    assert.equal(rb.code, 0, `the rollback entry point applies (exit ${rb.code}): ${rb.out.slice(0, 300)}`);
    const off = await startRestServer({ boardFile, env: envOff });
    try {
      const ids = ((await api(off.baseUrl, 'GET', '/api/columns')).body ?? []).map((c) => c.id);
      const cardNow = (await api(off.baseUrl, 'GET', `/api/cards/${card.id}`)).body;
      assert.equal(cardNow?.column, made, 'CONTROL: the card still names the new column after the switch-off (the executor holds the card)');
      assert.ok(ids.includes(made), `the switch-off must not lose the column the card sits in: /api/columns lists [${ids.join(', ')}] without ${made}`);
      assert.ok(ORIGINAL.every(([id]) => ids.includes(id)), 'and the four original columns are still listed');
    } finally { await off.stop(); }
  } finally { try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});

test('C14 THE ROLLBACK IS FENCED AND REPEATABLE: --dry-run writes nothing, a run makes the file`s columns equal the graph`s (created, renamed, removed), a second run leaves the file byte-identical, a wrong dataset refuses with the file untouched', { skip: SKIP, timeout: 300000 }, async () => {
  const { createHash } = await import('node:crypto');
  const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const dsid = 'c1k-rb-props'; const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const envOn = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', [UNIT_ENV]: '1' };
  const tag = ALNUM(); const made = `c14${tag.slice(-8)}`;
  try {
    const m = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(m.code, 0, `precondition: the migration applies (exit ${m.code}): ${m.out.slice(0, 300)}`);
    const on = await startRestServer({ boardFile, env: envOn });
    try {
      assert.equal((await api(on.baseUrl, 'POST', '/api/columns', { id: made, name: `${tag} Added`, order: 8 })).status, 201, 'precondition: a column is created');
      assert.equal((await api(on.baseUrl, 'PATCH', '/api/columns/planned', { name: `${tag} Planned renamed` })).status, 200, 'precondition: a column is renamed');
      assert.equal((await api(on.baseUrl, 'DELETE', '/api/columns/done')).status, 204, 'precondition: an original column is deleted');
    } finally { await stopKeeping(on, boardFile); }
    const before = sha(boardFile);
    const dry = await rollback({ boardFile, execUrl: exec.baseUrl, dsid, dryRun: true });
    assert.equal(dry.code, 0, `--dry-run succeeds (exit ${dry.code}): ${dry.out.slice(0, 300)}`);
    assert.equal(sha(boardFile), before, '--dry-run wrote nothing: the file is byte-identical');
    assert.ok(dry.last && dry.last.changed, `--dry-run reports that a change is pending (last line: ${JSON.stringify(dry.last)})`);
    const wrong = await rollback({ boardFile, execUrl: exec.baseUrl, dsid: 'not-this-dataset' });
    assert.notEqual(wrong.code, 0, 'a wrong dataset id is refused (non-zero exit)');
    assert.equal(sha(boardFile), before, 'and the refusal left the file byte-identical');
    const run = await rollback({ boardFile, execUrl: exec.baseUrl, dsid });
    assert.equal(run.code, 0, `the rollback applies (exit ${run.code}): ${run.out.slice(0, 300)}`);
    const cols = Object.fromEntries(fileColumns({ readBoardFile: () => JSON.parse(fs.readFileSync(boardFile, 'utf8')) }).map((c) => [c.id, c]));
    assert.ok(cols[made] && cols[made].name === `${tag} Added`, 'the created column is in the file');
    assert.equal(cols.planned?.name, `${tag} Planned renamed`, 'the renamed column carries its new name in the file');
    assert.ok(!cols.done, 'the column the graph deleted is gone from the file');
    assert.ok(cols.backlog && cols['in-progress'], 'the untouched originals are still there');
    const settled = sha(boardFile);
    const again = await rollback({ boardFile, execUrl: exec.baseUrl, dsid });
    assert.equal(again.code, 0, 'a second run succeeds');
    assert.equal(sha(boardFile), settled, 'and leaves the file byte-identical');
    assert.ok(again.last && !again.last.changed, `and reports nothing changed (last line: ${JSON.stringify(again.last)})`);
  } finally { try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});

test('C15 THE MIGRATION NEVER OVERWRITES: a column the graph already holds with DIFFERENT content is reported by name, the run is INCOMPLETE (non-zero), and the graph`s content is untouched', { skip: SKIP, timeout: 300000 }, async () => {
  const dsid = 'c1k-diverge'; const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', [UNIT_ENV]: '1' };
  const tag = ALNUM(); const renamed = `${tag} Renamed in the graph`;
  try {
    const first = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(first.code, 0, `precondition: the first migration applies (exit ${first.code}): ${first.out.slice(0, 300)}`);
    const on = await startRestServer({ boardFile, env });
    try { assert.equal((await api(on.baseUrl, 'PATCH', '/api/columns/backlog', { name: renamed })).status, 200, 'precondition: the graph`s backlog is renamed on the unit'); } finally { await stopKeeping(on, boardFile); }
    const again = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.notEqual(again.code, 0, `the file still says "Backlog" and the graph says "${renamed}": the migration must be INCOMPLETE, not a success (exit ${again.code}): ${again.out.slice(0, 300)}`);
    assert.match(again.out, /backlog/i, 'and it names the column that differs');
    const holder = await select(exec.baseUrl, `SELECT ?n WHERE { <${COLUMN_NS}backlog> <https://schema.org/name> ?n }`);
    assert.deepEqual(holder.map((b) => b.n.value), [renamed], 'the graph`s content was NOT overwritten by the document`s');
  } finally { try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});

test('C16 IT IS DURABLE: after a create, a rename, a delete that moves a card and a card move, a REST restart on the same files answers the same list (in order) and the same card column', { skip: SKIP, timeout: 300000 }, async () => {
  const dsid = 'c1k-durable'; const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', [UNIT_ENV]: '1' };
  const tag = ALNUM(); const made = `c16${tag.slice(-8)}`; let before = null; let cardId = null;
  try {
    const m = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(m.code, 0, `precondition: the migration applies (exit ${m.code}): ${m.out.slice(0, 300)}`);
    const one = await startRestServer({ boardFile, env });
    try {
      assert.equal((await api(one.baseUrl, 'POST', '/api/columns', { id: made, name: `${tag} Added`, order: 9 })).status, 201, 'precondition: a column is created');
      assert.equal((await api(one.baseUrl, 'PATCH', '/api/columns/in-progress', { name: `${tag} Doing` })).status, 200, 'precondition: a column is renamed');
      const card = (await api(one.baseUrl, 'POST', '/api/cards', { title: `${tag} in planned`, description: 'x', createdBy: 'ada', column: 'planned' })).body; cardId = card?.id;
      assert.ok(cardId, 'precondition: a card is created in planned');
      assert.equal((await api(one.baseUrl, 'DELETE', '/api/columns/planned')).status, 204, 'precondition: planned is deleted and its card moves');
      const list = (await api(one.baseUrl, 'GET', '/api/columns')).body;
      before = { list: list.map((c) => `${c.id}:${c.order}:${c.name}`), card: (await api(one.baseUrl, 'GET', `/api/cards/${cardId}`)).body?.column };
      assert.ok(!before.list.some((x) => x.startsWith('planned:')) && before.list.some((x) => x.startsWith(`${made}:`)), 'precondition: the list shows the delete and the create');
    } finally { await stopKeeping(one, boardFile); }
    const two = await startRestServer({ boardFile, env });
    try {
      const list = (await api(two.baseUrl, 'GET', '/api/columns')).body;
      const after = { list: list.map((c) => `${c.id}:${c.order}:${c.name}`), card: (await api(two.baseUrl, 'GET', `/api/cards/${cardId}`)).body?.column };
      assert.deepEqual(after, before, 'after a restart the columns (in order) and the moved card are exactly what they were: nothing lives only in the first server`s memory');
    } finally { await two.stop(); }
  } finally { try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});

test('C17 graph_query SEES THE COLUMNS: on the unit, POST /api/graph answers the Column queries from the 03:12Z report with the graph`s columns, including one created after boot (the replica-has-more rows #1570 waits on)', { skip: SKIP, timeout: 300000 }, async () => {
  await serve({ columns: true, cards: true }, async ({ base }) => {
    const tag = ALNUM(); const made = `c17${tag.slice(-8)}`;
    assert.equal((await api(base, 'POST', '/api/columns', { id: made, name: `${tag} Seen`, order: 11 })).status, 201, 'precondition: a column is created');
    const q = await api(base, 'POST', '/api/graph', { query: 'SELECT ?c ?o WHERE { ?c a scrum:Column ; scrum:order ?o } ORDER BY ?o', limit: 50 });
    assert.equal(q.status, 200, `graph_query answers (${q.status} ${q.text.slice(0, 160)})`);
    const got = (q.body?.rows ?? []).map((r) => `${String(r.c).replace(/^.*[/:]/, '')}:${r.o}`);
    assert.deepEqual(got, ['backlog:0', 'planned:1', 'in-progress:2', 'done:3', `${made}:11`], 'the four original columns and the one created after boot, in order, from graph_query');
    const named = await api(base, 'POST', '/api/graph', { query: `SELECT ?n WHERE { ?c a scrum:Column ; schema:identifier "${made}" ; schema:name ?n }` });
    assert.deepEqual((named.body?.rows ?? []).map((r) => r.n), [`${tag} Seen`], 'and a column`s name is readable through graph_query');
  }, 'c1k-gq');
});

// ── the UNKNOWN-outcome rows (#1639 review, 08:12Z: a lost write reply can happen with ONE writer, so leaving that path untested was a decision nobody had made). Modelled on collection-uncertain-1624.test.mjs: a proxy that forwards a
//    write to the executor and then DROPS the answer, and drops every receipt read, so the REST server cannot tell whether the write happened. ──

async function startFaultProxy(execUrl) {
  const p = { mode: null, dropped: 0, dropReceipts: 0, receiptsDropped: 0 };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const isUpdate = req.method === 'POST' && req.url.split('?')[0] === '/update';
    if (req.method === 'GET' && req.url.startsWith('/receipt/') && p.dropReceipts > 0) { p.receiptsDropped++; try { req.socket.destroy(); } catch { /* gone */ } return; }
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text();
      if (isUpdate && p.mode === 'ack') { p.mode = null; p.dropped++; try { req.socket.destroy(); } catch { /* gone */ } return; }
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
/** a unit-on server (cards unit on, as production) behind the fault proxy, migrated first; resolves with everything the row needs */
async function faultServe(dsid, body) {
  const exec = await startExecutor({ store: tmpStore('c1k-store-'), datasetId: dsid, create: true });
  const proxy = await startFaultProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1k-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(makeBoardFixture(), null, 2));
  let rest = null;
  try {
    const m = await migrate({ boardFile, execUrl: exec.baseUrl, dsid, apply: true });
    assert.equal(m.code, 0, `precondition: the migration applies (exit ${m.code}): ${m.out.slice(0, 300)}`);
    rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', [UNIT_ENV]: '1' } });
    return await body({ base: rest.baseUrl, rest, proxy, exec });
  } finally { if (rest) await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
const columnNodeCount = async (execUrl, id) => Number((await select(execUrl, `SELECT (COUNT(*) AS ?n) WHERE { <${COLUMN_NS}${id}> a <https://scrumboard.local/ns#Column> }`))[0].n.value);

test('C18 A COLUMN WRITE LEFT UNKNOWN: the answer is 201 or 503, the write COMMITTED once, the columns read is then 200 and shows it, a non-column board read is 200 (the cache is reloaded first), and the next write works', { skip: SKIP, timeout: 300000 }, async () => {
  await faultServe('c1k-unk1', async ({ base, proxy, exec }) => {
    const tag = ALNUM(); const made = `c18${tag.slice(-8)}`;
    assert.equal((await api(base, 'GET', '/api/columns')).status, 200, 'CONTROL: the columns are served before the fault');
    proxy.mode = 'ack'; proxy.dropped = 0; proxy.dropReceipts = 1000;
    const r = await api(base, 'POST', '/api/columns', { id: made, name: `${tag} Unknown`, order: 12 });
    proxy.dropReceipts = 0;
    assert.equal(proxy.dropped, 1, 'PRECONDITION: the write`s answer was dropped');
    assert.ok(proxy.receiptsDropped >= 1, `PRECONDITION: a receipt read was dropped (${proxy.receiptsDropped}), so the outcome stayed undetermined`);
    assert.ok([201, 503].includes(r.status), `an undetermined write answers 201 or 503, never a bare 500 or a 4xx (got ${r.status} ${r.text.slice(0, 140)})`);
    assert.equal(await columnNodeCount(exec.baseUrl, made), 1, 'the write COMMITTED, exactly once (only its answer and the receipt reads were lost)');
    const other = await api(base, 'GET', '/api/cards?limit=1');
    assert.equal(other.status, 200, `a board-reading GET that is NOT a columns route is answered once the executor is back: the cache is reloaded before the route (got ${other.status} ${other.text.slice(0, 140)})`);
    const list = await api(base, 'GET', '/api/columns');
    assert.equal(list.status, 200, `the columns read is answered (got ${list.status})`);
    assert.equal((list.body ?? []).filter((c) => c.id === made).length, 1, 'and the list shows the committed column exactly once: never the list from before the write');
    assert.equal((await api(base, 'POST', '/api/columns', { id: `${made}b`, name: `${tag} After`, order: 13 })).status, 201, 'and the next write lands');
  });
});

test('C19 THE SAME UNKNOWN WRITE AND THEN THE EXECUTOR GONE: a columns read and a board read are 503, never the columns from before the write', { skip: SKIP, timeout: 300000 }, async () => {
  await faultServe('c1k-unk2', async ({ base, proxy, exec }) => {
    const tag = ALNUM(); const made = `c19${tag.slice(-8)}`;
    assert.equal((await api(base, 'GET', '/api/columns')).status, 200, 'CONTROL: the columns are served before the fault');
    proxy.mode = 'ack'; proxy.dropped = 0; proxy.dropReceipts = 1000;
    const r = await api(base, 'POST', '/api/columns', { id: made, name: `${tag} Unknown`, order: 12 });
    assert.equal(proxy.dropped, 1, 'PRECONDITION: the write`s answer was dropped');
    assert.ok(proxy.receiptsDropped >= 1, 'PRECONDITION: a receipt read was dropped, so the outcome stayed undetermined');
    assert.ok([201, 503].includes(r.status), `an undetermined write answers 201 or 503 (got ${r.status})`);
    await proxy.down();
    assert.equal(await columnNodeCount(exec.baseUrl, made), 1, 'the write COMMITTED: the store holds the column');
    const list = await api(base, 'GET', '/api/columns');
    assert.equal(list.status, 503, `with the outcome undetermined and the executor away, the columns read refuses instead of serving the list from before the write (got ${list.status} ${list.text.slice(0, 140)})`);
    const other = await api(base, 'GET', '/api/cards?limit=1');
    assert.equal(other.status, 503, `and so does a board read that is not a columns route (got ${other.status} ${other.text.slice(0, 140)})`);
  });
});

test('C20 A DELETE THAT MOVES A CARD, LEFT UNKNOWN: the column is gone and the card moved in the store (one update), and what REST then serves is the store`s truth, never the list from before the delete', { skip: SKIP, timeout: 300000 }, async () => {
  await faultServe('c1k-unk3', async ({ base, proxy, exec }) => {
    const tag = ALNUM();
    const card = (await api(base, 'POST', '/api/cards', { title: `${tag} held`, description: 'x', createdBy: 'ada', column: 'planned' })).body;
    assert.ok(card?.id, 'precondition: a card is created in planned');
    assert.equal(await columnNodeCount(exec.baseUrl, 'planned'), 1, 'CONTROL: planned exists in the store before the delete');
    proxy.mode = 'ack'; proxy.dropped = 0; proxy.dropReceipts = 1000;
    const r = await api(base, 'DELETE', '/api/columns/planned');
    proxy.dropReceipts = 0;
    assert.equal(proxy.dropped, 1, 'PRECONDITION: the write`s answer was dropped');
    assert.ok(proxy.receiptsDropped >= 1, 'PRECONDITION: a receipt read was dropped, so the outcome stayed undetermined');
    assert.ok([204, 503].includes(r.status), `an undetermined delete answers 204 or 503 (got ${r.status} ${r.text.slice(0, 140)})`);
    assert.equal(await columnNodeCount(exec.baseUrl, 'planned'), 0, 'the delete COMMITTED in the store (column and card move in ONE update)');
    const list = await api(base, 'GET', '/api/columns');
    assert.equal(list.status, 200, `the columns read is answered once the executor is back (got ${list.status} ${list.text.slice(0, 140)})`);
    assert.ok(!(list.body ?? []).some((c) => c.id === 'planned'), 'and the list does NOT show the deleted column: never the list from before the delete');
    const after = await api(base, 'GET', `/api/cards/${card.id}`);
    assert.equal(after.status, 200, `the card is readable (got ${after.status})`);
    assert.notEqual(after.body?.column, 'planned', 'and it no longer sits in the deleted column');
  });
});

test('C21 ONE IRI RULE FOR A COLUMN: a column whose id needs encoding (space, slash), a card moved into it, and graph_query JOINS them: the card is found through its column node, and per-column counts include it (#1639 review, 08:21Z on 3ba32dc)', { skip: SKIP, timeout: 300000 }, async () => {
  await serve({ columns: true, cards: true }, async ({ base, exec }) => {
    const tag = ALNUM();
    for (const [label, rawId] of [['space', `${tag} has space`], ['slash', `${tag}a/b`]]) {
      assert.equal((await api(base, 'POST', '/api/columns', { id: rawId, name: `${tag} ${label}`, order: 20 })).status, 201, `precondition (${label}): the column is created`);
      const card = (await api(base, 'POST', '/api/cards', { title: `${tag} in ${label}`, description: 'x', createdBy: 'ada', column: rawId })).body;
      assert.ok(card?.id, `precondition (${label}): a card is created in it`);
      assert.equal((await api(base, 'GET', `/api/cards/${card.id}`)).body?.column, rawId, `precondition (${label}): the card reads back in the column by its plain id`);
      // the graph join, asked of the EXECUTOR directly (any IRI a card points at must be the IRI some column node has)
      const dangling = await select(exec.baseUrl, `SELECT DISTINCT ?col WHERE { ?c <https://scrumboard.local/ns#column> ?col FILTER NOT EXISTS { ?col a <https://scrumboard.local/ns#Column> } }`);
      assert.deepEqual(dangling.map((b) => b.col.value), [], `(${label}) every column IRI a card points at is a column node: a card in an encoded-id column must not dangle`);
      const joined = await select(exec.baseUrl, `SELECT ?t WHERE { ?col a <https://scrumboard.local/ns#Column> ; <https://schema.org/identifier> ${JSON.stringify(rawId)} . ?card <https://scrumboard.local/ns#column> ?col ; <https://schema.org/name> ?t }`);
      assert.deepEqual(joined.map((b) => b.t.value), [`${tag} in ${label}`], `(${label}) the card is found by joining through its column node`);
      // and through the REST graph_query route, as a reader of the board would ask it
      const q = await api(base, 'POST', '/api/graph', { query: `SELECT ?t WHERE { ?col a scrum:Column ; schema:identifier ${JSON.stringify(rawId)} . ?card scrum:column ?col ; schema:name ?t }` });
      assert.deepEqual((q.body?.rows ?? []).map((r) => r.t), [`${tag} in ${label}`], `(${label}) the same join through graph_query`);
    }
  }, 'c1k-iri');
});

test('C22 THE READY VERDICT NAMES THE COLUMN BY ITS ID: a card in a column whose id needs encoding is reported by GET /api/ready with the plain id, not the IRI`s percent-encoded tail, and a card blocked by it stays blocked (probe on 9af4935, 08:32Z)', { skip: SKIP, timeout: 300000 }, async () => {
  await serve({ columns: true, cards: true }, async ({ base }) => {
    const tag = ALNUM(); const colId = `${tag}wip/done`;
    assert.equal((await api(base, 'POST', '/api/columns', { id: colId, name: `${tag} WIP done`, order: 21 })).status, 201, 'precondition: the column is created');
    const blocker = (await api(base, 'POST', '/api/cards', { title: `${tag} blocker`, description: 'x', createdBy: 'ada', column: colId })).body;
    const blocked = (await api(base, 'POST', '/api/cards', { title: `${tag} blocked`, description: 'x', createdBy: 'ada', column: 'backlog' })).body;
    assert.ok(blocker?.shortId && blocked?.shortId, 'precondition: two cards are created');
    assert.equal((await api(base, 'PATCH', `/api/cards/${blocked.id}`, { relationships: { blockedBy: [blocker.shortId] }, by: 'ada' })).status, 200, 'precondition: the second card is blocked by the first');
    const ready = await api(base, 'GET', '/api/ready');
    assert.equal(ready.status, 200, `ready answers (${ready.status} ${ready.text.slice(0, 160)})`);
    const mine = (ready.body?.ready ?? []).find((c) => c.shortId === blocker.shortId);
    assert.ok(mine, `CONTROL: the unblocked card in the encoded-id column is listed as ready (ready: ${JSON.stringify((ready.body?.ready ?? []).map((c) => c.shortId))})`);
    assert.equal(mine.column, colId, `the ready verdict names the column by its id "${colId}", not by the text of its IRI (got "${mine.column}")`);
    assert.ok((ready.body?.excluded ?? []).some((e) => e.shortId === blocked.shortId && /open-blocker/.test(e.reason)), 'and the card it blocks is excluded as blocked: an open blocker in a column named "…/done" must not be read as done');
  }, 'c1k-ready');
});
