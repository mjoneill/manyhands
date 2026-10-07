/**
 * #1598 K3, FOURTH FILE: A CARD'S TEXT IS NEVER REFUSED OR CHANGED BY THE STORE. Written by the separate test author after the builder's K8 rehearsal on a copy of the live board found that 10 of 1,491 cards were REFUSED with "compiler rejected its own output:
 * multi-operation request": their text contains `; delete …` or the like, and the compiler's safety check scans the whole update, which carries the card as JSON. It was fixed by encoding (67ed589) and pinned by a builder row, and my first three files had no
 * row for it at all: my script's texts were plain. A card that cannot be saved because of what it says is the most direct way for a graph store to lose data, and the live board is full of text about SPARQL, code and shell, so this file puts the hostile
 * text through the real routes and requires it to come back BYTE FOR BYTE. Same template: REST with a REAL executor, a unit-off server as the control, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass.
 * Switch: `SCRUM_GRAPH_UNIT_CARDS`.
 *
 *   C11a  EVERY HOSTILE TEXT ROUND-TRIPS (control: unit off, green today): ten strings (a statement separator followed by `delete where`, a `CLEAR GRAPH; INSERT DATA`, quotes of every kind, backslashes, braces and `#`, CR LF and tab, an emoji and accented
 *         letters, an angle-bracket IRI and a `<script>`, a 6,000-character mixed run, a string that LOOKS like a SPARQL variable and a datatype tag) are used as a card's description at create, appended with `descriptionAppend`, used as part of a title
 *         with PATCH, and the card is claimed (its title goes into the announcement). Every write answers success and every read returns EXACTLY what was written.
 *   C11b  THE SAME THROUGH THE GRAPH (unit on): the identical script on a unit-on server, same results; and the text really reached the executor, not only the cache: the executor's store holds a distinctive fragment of the hostile text.
 *   C11c  A REFUSAL IS NEVER BECAUSE OF THE TEXT: for each hostile string, a create answers 201, never 400/500/503 (the builder's failure was a 503/500 for a valid card).
 *
 * NOT COVERED, by name: a NUL byte (JSON cannot carry it); text in a LABEL (labels are slugged by the board and are not free text); text in relationships, checks and acceptance (the same encoder is used, but I did not put hostile text through them); a card
 * body over 6,000 characters; a title that is exactly a SPARQL keyword; comments (posts), whose text path is the conversations unit's and is pinned by its own rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_CARDS';
const ROSTER_FILE = path.join(os.tmpdir(), `c4k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** the hostile texts, each with a distinctive FRAGMENT the executor's store must hold */
const HOSTILE = [
  ['semicolon then delete', 'before; delete where { ?s ?p ?o } ; after', 'delete where { ?s ?p ?o }'],
  ['clear graph and insert', 'x ; CLEAR GRAPH <urn:g> ; INSERT DATA { <urn:a> <urn:b> "c" } ; y', 'CLEAR GRAPH <urn:g>'],
  ['quotes', `double " single ' backtick \` triple """ and ''' done`, 'triple """'],
  ['backslashes', 'back\\slash \\\\ double \\n not-a-newline \\u0041 \\"', 'back\\slash'],
  ['braces and hash', 'open { close } # not a comment } { } \n# a real comment line', '# not a comment'],
  ['crlf and tab', 'line1\r\nline2\ttabbed\r\nline3\n\nline5', 'tabbed'],
  ['emoji and accents', 'lock 🔒 planet 🌍 ünïcödé façade 日本語 العربية', '🌍'],
  ['iri and markup', '<https://example.invalid/x> <script>alert(1)</script> <urn:a>', 'alert(1)'],
  ['variable and datatype lookalikes', 'a ?var and $dollar and "lit"^^<http://www.w3.org/2001/XMLSchema#integer> and "tag"@en', '^^<http://www.w3.org/2001/XMLSchema#integer>'],
  ['long mixed run', `${'x ; delete { } \\ " \' 🔒 # '.repeat(220)}END`, 'END'],
];

async function hostileScript(base, tag, execUrl = null) {
  const out = [];
  for (let i = 0; i < HOSTILE.length; i++) {
    const [label, text, fragment] = HOSTILE[i];
    const made = await api(base, 'POST', '/api/cards', { title: `${tag} H${i}`, description: text, createdBy: 'ada' });
    out.push({ label, step: 'create', status: made.status, ok: made.status === 201 });
    const id = made.body?.id; if (!id) continue;
    const got = (await api(base, 'GET', `/api/cards/${id}`)).body;
    out.push({ label, step: 'description round-trips', ok: got?.description === text, got: got?.description?.slice(0, 80) });
    const app = await api(base, 'PATCH', `/api/cards/${id}`, { by: 'ada', descriptionAppend: text });
    const after = (await api(base, 'GET', `/api/cards/${id}`)).body;
    out.push({ label, step: 'append', status: app.status, ok: app.status === 200 && after?.description === `${text}${text}` || app.status === 200 && after?.description === `${text}\n${text}`, got: after?.description?.slice(0, 80) });
    const t = `${tag} H${i} ${text}`;
    const ren = await api(base, 'PATCH', `/api/cards/${id}`, { by: 'ada', title: t });
    out.push({ label, step: 'title', status: ren.status, ok: ren.status === 200 && (await api(base, 'GET', `/api/cards/${id}`)).body?.title === t });
    const claim = await api(base, 'POST', `/api/cards/${id}/claim`, { by: 'ada' });
    out.push({ label, step: 'claim (the title goes into the announcement)', status: claim.status, ok: claim.status === 200 });
    if (execUrl) out.push({ label, step: 'the executor holds the fragment', ok: (await holders(execUrl, fragment)) >= 1 });
  }
  return out;
}
const failures = (rows) => rows.filter((r) => !r.ok).map((r) => `${r.label} / ${r.step}${r.status ? ` (${r.status})` : ''}${r.got ? ` got "${r.got}"` : ''}`);

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function unitOn(body, dsid = 'c4k-test') {
  const exec = await startExecutor({ store: tmpStore('c4k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}

test('C11a CONTROL: with the unit OFF every hostile text round-trips byte for byte through create, append, title and claim', { timeout: 240000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { assert.deepEqual(failures(await hostileScript(rest.baseUrl, ALNUM())), [], 'no step failed'); } finally { await rest.stop(); }
});

test('C11b + C11c THE SAME THROUGH THE GRAPH: no card is refused for what it says, every text comes back byte for byte, and the executor holds the text', { skip: SKIP, timeout: 400000 }, async () => {
  await unitOn(async ({ base, exec }) => { assert.deepEqual(failures(await hostileScript(base, ALNUM(), exec.baseUrl)), [], 'no step failed'); });
});
