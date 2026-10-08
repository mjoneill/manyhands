/**
 * #1598 K8, THE MIGRATION AND THE REMOVAL OF THE FILE'S CARDS. Written by the separate test author BEFORE the removal is run on the live file, as #1626's rows were for posts: the removal is the one irreversible step, and #1626's differential found two
 * read surfaces still answering from the file's copy before it ever ran on live. The scripts are `scripts/migrate-cards-1598.mjs` (copy the document's cards into the graph) and `scripts/retire-unit3-collections-1582.mjs --kinds cards` (remove them
 * from the file once the graph holds them). Real scripts, a real executor, real REST servers, synthetic content, no browser. Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass. Switch: `SCRUM_GRAPH_UNIT_CARDS`.
 *
 * THE WORLD (built per row): a unit-off server writes six document-born cards into a board file (a plain one; one whose description is hostile SPARQL-looking text; one in the `planned` column with labels; one claimed; one with checks and acceptance;
 * one with a long body), a fresh executor starts empty, and the migrate script copies the cards in.
 *
 *   M1  THE MIGRATION: a dry run sends nothing (the graph holds no card, the file is byte-identical); `--apply` brings in EVERY card; a unit-on server over the migrated graph serves every card exactly as the unit-off server served it (id, title,
 *       description, column, order, version, labels, claimedBy, checks, acceptance), the hostile text intact; a create afterwards gets the file's `nextShortId` (the counter was seeded); a second `--apply` changes nothing.
 *   R1  THE REMOVAL SCRIPT: a dry run reports N of N and writes NOTHING; `--apply` removes exactly the card nodes (every other node unchanged) and appends ONE event whose state NAMES the number of cards that left (step 4's said "0 and 0" and #1626's first
 *       version omitted posts); a second `--apply` is a no-op that appends nothing.
 *   R2  IT REFUSES WHAT IT CANNOT VOUCH FOR, and removes nothing (the file stays byte-identical, the refusal names the card), in three cases: (a) a card edited ONLY in the file, its graph copy still the migrated one; (b) **the reviewer's lineage case (06:27Z):** a
 *       card edited only in the file while its graph copy has ALSO advanced through the graph (version above 1): "version above 1" alone must not read as "migrated", or the file-only edit is discarded; (c) the control: a card whose GRAPH copy advanced and whose
 *       file copy is the unchanged migrated one IS removable (the file's copy is the stale ancestor), so the guard is not "refuse anything that moved".
 *   R3  THE DIFFERENTIAL AFTER THE REMOVAL: a unit-on server whose file STILL HOLDS the cards (A) and one whose file holds NONE (B, produced by the script), same graph, answer every card-reading surface identically (card list in variants, a card by id, the
 *       claim and column filters, `/api/board`, `/api/board/status`, `/api/load`, search, `/api/people`, `/api/insights`); each card-shaped surface must SHOW the cards (an equal pair of empty answers is not a pass; `/api/search` is compared but not required to show them, because it answers from an embedding index that a scratch server does not have); B's file is asserted to hold no card.
 *   R4  NO ORPHAN IS LEFT BEHIND: after the removal no node remaining in the file, other than a post (a post that is ABOUT a card names it by design), names a removed card (a card-owned release condition, check or blocker whose card is gone is garbage
 *       that a later reader could resurrect or trip on).
 *   R5  A CARD CREATED AFTER THE REMOVAL: numbered one past the highest shortId (no reuse), in the list and by id, in the executor and NOT in the file.
 *
 * NOT COVERED, by name: the live file's 1,491 cards (the dry run to N of N and an independent read-back before and after are the live measurement); a removal that is interrupted halfway (the write is one atomic rename); cards with attachments' bytes; the
 * relationship, blocker and acceptance WRITE routes after the removal; MCP; the page; the order of a plain list; the cold boot of REST's replica afterwards (step 4's lesson, a live-boot measurement); a claim's announcement post (a post, not a card).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeBoardFixture, startRestServer, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_CARDS'; const DSID = 'k8c-test';
const ROSTER_FILE = path.join(os.tmpdir(), `k8c-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const run = (script, args, env = {}) => { const r = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
const CARD = (n) => n && n['@type'] === 'CreativeWork';
const readGraphNodes = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))['@graph'];
const sha = (file) => fs.readFileSync(file);
const eventLines = (dir) => { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).flatMap((f) => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []; }); };
const query = async (exec, sparql) => { const res = await fetch(`${exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: sparql, signal: AbortSignal.timeout(30000) }); assert.equal(res.status, 200, `the store answers a query (${res.status})`); return (await res.json()).results.bindings; };
const graphCards = async (exec) => Number((await query(exec, 'SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a <https://scrumboard.local/ns#Card> . GRAPH <urn:scrum:bookkeeping:executor> { ?s <urn:ex:ver> ?v } }'))[0].n.value);   // #1638: `ver` is bookkeeping and lives in the bookkeeping graph; the question asked is unchanged
async function holders(exec, needle) { return (await query(exec, `SELECT ?s WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`)).length; }
const HOSTILE = 'before; delete where { ?s ?p ?o } ; CLEAR GRAPH <urn:g> " \' \\ 🔒 after';
const KEYS = ['id', 'shortId', 'title', 'description', 'column', 'order', 'version', 'labels', 'claimedBy', 'checks', 'acceptance'];
const view = (c) => Object.fromEntries(KEYS.map((k) => [k, c[k] ?? null]));

async function world(tag) {
  const s0 = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8c-')); const file = path.join(dir, 'board.json'); const cards = [];
  let served;
  try {
    const mk = async (extra) => { const r = await api(s0.baseUrl, 'POST', '/api/cards', { description: 'body', createdBy: 'ada', ...extra }); assert.equal(r.status, 201, `world: create ${extra.title} (${r.status} ${r.text.slice(0, 120)})`); cards.push(r.body); return r.body; };
    await mk({ title: `${tag} plain` });
    await mk({ title: `${tag} hostile`, description: HOSTILE });
    await mk({ title: `${tag} planned`, column: 'planned', labels: ['l1', 'l2'] });
    const claimed = await mk({ title: `${tag} claimed` }); assert.equal((await api(s0.baseUrl, 'POST', `/api/cards/${claimed.id}/claim`, { by: 'ada' })).status, 200);
    await mk({ title: `${tag} checks`, checks: [{ claim: 'k8c synthetic', ask: 'ASK { ?x a <https://schema.org/CreativeWork> }', expect: true }], acceptance: [{ condition: 'k8c acceptance', evidence: [] }] });
    await mk({ title: `${tag} long`, description: `${'long body; delete { } \\ " 🔒 # '.repeat(200)}END` });
    served = ((await api(s0.baseUrl, 'GET', '/api/cards?limit=500')).body); served = (Array.isArray(served) ? served : served.cards).filter((c) => String(c.title).startsWith(tag)).map((c) => view(c)).sort((a, b) => a.shortId - b.shortId);
    fs.copyFileSync(s0.boardFile, file);
  } finally { await s0.stop(); }
  const exec = await startExecutor({ store: tmpStore('k8c-store-'), datasetId: DSID, create: true });
  const eventsDir = path.join(dir, 'events'); const nFile = readGraphNodes(file).filter(CARD).length;
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1', SCRUM_EVENT_LOG_DIR: eventsDir };
  const copyOf = (src = file) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k8c-run-')); const f = path.join(d, 'board.json'); fs.copyFileSync(src, f); return f; };
  const W = { tag, dir, file, exec, eventsDir, cards, served, nFile, env, copyOf,
    serve: (src = file) => startRestServer({ boardFile: copyOf(src), env }),
    migrate: (f = file, apply = true) => run('migrate-cards-1598.mjs', ['--board-data', f, '--executor', exec.baseUrl, '--dataset', DSID, ...(apply ? ['--apply'] : [])]),
    retire: (f = file, apply = false) => run('retire-unit3-collections-1582.mjs', ['--board-data', f, '--executor', exec.baseUrl, '--dataset', DSID, '--kinds', 'cards', ...(apply ? ['--apply'] : [])], { SCRUM_EVENT_LOG_DIR: eventsDir }),
    stop: async () => { await killExecutor(exec); } };
  assert.ok(nFile >= 6, `world: the file holds the cards (${nFile})`);
  return W;
}
const served = async (W, base) => { const r = (await api(base, 'GET', '/api/cards?limit=500')).body; return (Array.isArray(r) ? r : r.cards).filter((c) => String(c.title).startsWith(W.tag)).map((c) => view(c)).sort((a, b) => a.shortId - b.shortId); };

test('M1 THE MIGRATION: a dry run sends nothing; --apply brings in every card faithfully; the counter is seeded; a second --apply changes nothing', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    const before = sha(W.file); const dry = W.migrate(W.file, false);
    assert.equal(dry.code, 0, `a dry run completes (${dry.code}): ${dry.out.slice(-300)}`); assert.equal(await graphCards(W.exec), 0, 'a dry run sent nothing: the graph holds no card'); assert.ok(before.equals(sha(W.file)), 'and the file is byte-identical');
    const ap = W.migrate(); assert.equal(ap.code, 0, `--apply completes (${ap.code}): ${ap.out.slice(-300)}`);
    assert.equal(await graphCards(W.exec), W.nFile, `every card is in the graph (${W.nFile})`);
    const B = await W.serve();
    try {
      assert.deepEqual(await served(W, B.baseUrl), W.served, 'a unit-on server over the migrated graph serves every card exactly as the unit-off server did');
      assert.ok(await holders(W.exec, 'CLEAR GRAPH <urn:g>') >= 1, 'the hostile text is in the graph');
      const made = await api(B.baseUrl, 'POST', '/api/cards', { title: `${W.tag} after`, description: 'x', createdBy: 'ada' }); assert.equal(made.status, 201, `a create works (${made.status} ${made.text.slice(0, 100)})`);
      assert.equal(made.body.shortId, Math.max(...W.served.map((c) => c.shortId)) + 1, `numbered one past the file's highest (the counter was seeded): ${made.body.shortId}`);
    } finally { await B.stop(); }
    const n1 = await graphCards(W.exec); const again = W.migrate(); assert.equal(again.code, 0, `a second --apply completes (${again.code}): ${again.out.slice(-200)}`); assert.equal(await graphCards(W.exec), n1, 'and the graph holds the same number of cards');
  } finally { await W.stop(); }
});

test('R1 THE REMOVAL SCRIPT: a dry run writes nothing; --apply removes exactly the cards, keeps every other node, appends ONE event naming how many cards left; a second run is a no-op', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'the cards are migrated first');
    const before = sha(W.file); const ev0 = eventLines(W.eventsDir).length; const others = JSON.stringify(readGraphNodes(W.file).filter((n) => !CARD(n)));
    const dry = W.retire(); assert.equal(dry.code, 0, `a dry run completes (${dry.code}): ${dry.out.slice(-300)}`);
    assert.ok(new RegExp(`${W.nFile} of ${W.nFile} verified`).test(dry.out), `it reports ${W.nFile} of ${W.nFile} verified: ${dry.out.slice(-300)}`);
    assert.ok(before.equals(sha(W.file)), 'a dry run leaves the file byte-identical'); assert.equal(eventLines(W.eventsDir).length, ev0, 'and appends no event');
    const ap = W.retire(W.file, true); assert.equal(ap.code, 0, `--apply completes (${ap.code}): ${ap.out.slice(-300)}`);
    assert.equal(readGraphNodes(W.file).filter(CARD).length, 0, 'the file holds no card afterwards');
    const events = eventLines(W.eventsDir).slice(ev0); assert.equal(events.length, 1, `exactly ONE event is appended (${events.length})`);
    const state = JSON.stringify(JSON.parse(events[0]).state); assert.ok(new RegExp(`card[a-z"']*"?\\s*:\\s*${W.nFile}\\b`, 'i').test(state), `the event's state names the number of cards that left (${W.nFile}); it reads: ${state.slice(0, 300)}`);
    const afterBytes = sha(W.file); const ev1 = eventLines(W.eventsDir).length; const again = W.retire(W.file, true);
    assert.equal(again.code, 0, `a second run exits 0 (${again.code}): ${again.out.slice(-200)}`); assert.ok(afterBytes.equals(sha(W.file)), 'and writes nothing'); assert.equal(eventLines(W.eventsDir).length, ev1, 'and appends no event');
    assert.ok(JSON.stringify(readGraphNodes(W.file).filter((n) => !CARD(n))).length > 0 && others.length > 0, 'CONTROL: there were other nodes to keep');
  } finally { await W.stop(); }
});

/** the file-only-edit scenarios: edit a card's title through a UNIT-OFF server over a copy of the file, which changes the FILE and nothing in the graph */
async function editInFile(W, idx, title) {
  const f = W.copyOf(); const s = await startRestServer({ boardFile: f, env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { const r = await api(s.baseUrl, 'PATCH', `/api/cards/${W.cards[idx].id}`, { by: 'ada', title }); assert.equal(r.status, 200, `a file-only edit (${r.status} ${r.text.slice(0, 100)})`); } finally { /* stop() removes the file, so keep a copy first */ fs.copyFileSync(f, `${f}.keep`); await s.stop(); }
  const out = path.join(W.dir, `edited-${idx}.json`); fs.copyFileSync(`${f}.keep`, out); return out;
}
async function advanceInGraph(W, idx, title) {
  const s = await W.serve(); try { const r = await api(s.baseUrl, 'PATCH', `/api/cards/${W.cards[idx].id}`, { by: 'ada', title }); assert.equal(r.status, 200, `a graph-side edit (${r.status} ${r.text.slice(0, 100)})`); } finally { await s.stop(); }
}
const refused = (r, before, file, id, label) => {
  assert.notEqual(r.code, 0, `${label}: the removal must REFUSE (exit ${r.code}): ${r.out.slice(-400)}`); assert.ok(before.equals(sha(file)), `${label}: the file is byte-identical, nothing was removed`); assert.ok(r.out.includes(id) || r.out.includes(id.slice(0, 8)), `${label}: the refusal names the card: ${r.out.slice(-400)}`);
};

test('R2a A CARD EDITED ONLY IN THE FILE (its graph copy is the migrated one) is not removed', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'migrated');
    const edited = await editInFile(W, 2, `${W.tag} planned EDITED IN THE FILE`); const before = sha(edited);
    refused(W.retire(edited, true), before, edited, W.cards[2].id, 'R2a');
  } finally { await W.stop(); }
});

test('R2b THE LINEAGE CASE: a card edited only in the file while its graph copy ALSO advanced is not removed ("version above 1" is not "migrated")', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'migrated');
    await advanceInGraph(W, 2, `${W.tag} planned ADVANCED IN THE GRAPH`);   // the graph copy is now above version 1
    const edited = await editInFile(W, 2, `${W.tag} planned EDITED IN THE FILE`); const before = sha(edited);
    refused(W.retire(edited, true), before, edited, W.cards[2].id, 'R2b');
  } finally { await W.stop(); }
});

test('R2c THE CONTROL: a card whose GRAPH copy advanced and whose file copy is the unchanged migrated one IS removable', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'migrated');
    await advanceInGraph(W, 2, `${W.tag} planned ADVANCED IN THE GRAPH`);
    const ap = W.retire(W.file, true); assert.equal(ap.code, 0, `the removal goes ahead: the file's copy is the stale ancestor, not a lost edit (${ap.code}): ${ap.out.slice(-400)}`);
    assert.equal(readGraphNodes(W.file).filter(CARD).length, 0, 'and every card left the file');
  } finally { await W.stop(); }
});

const SURFACES = (W) => [['card list', 'GET', '/api/cards?limit=500', true], ['card list planned', 'GET', '/api/cards?column=planned&limit=500', true], ['card by id', 'GET', `/api/cards/${W.cards[2].id}`, true], ['card by shortId', 'GET', `/api/cards/${W.cards[1].shortId}`, true], ['claimed card', 'GET', `/api/cards/${W.cards[3].id}`, true],
  ['board', 'GET', '/api/board', true], ['board status', 'GET', '/api/board/status', false], ['load', 'GET', '/api/load', true], ['search', 'POST', '/api/search', false, { q: `${W.tag} plain` }], ['people', 'GET', '/api/people', false], ['insights', 'GET', '/api/insights', false]];
const VOLATILE = /^(generatedAt|asOf|now|serverTime|uptimeMs|startedAt|bootedAt|fetchedAt|since|ms|tookMs|elapsedMs|lastUpdated)$/;
const maskDeep = (v) => { if (Array.isArray(v)) return v.map(maskDeep); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.test(k)).map(([k, x]) => [k, maskDeep(x)])); return v; };
function firstDiff(x, y, at) { if (x === y) return null; if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[k], y[k], `${at}/${k}`); if (d) return d; } return null; } return `${at || '/'}  with the cards ${JSON.stringify(x)?.slice(0, 70)}  without ${JSON.stringify(y)?.slice(0, 70)}`; }

test('R3 THE DIFFERENTIAL AFTER THE REMOVAL: a server whose file holds the cards and one whose file holds none answer every card-reading surface identically', { skip: SKIP, timeout: 500000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'migrated'); const trimmed = path.join(W.dir, 'trimmed.json'); fs.copyFileSync(W.file, trimmed);
    assert.equal(W.retire(trimmed, true).code, 0, 'the script produces the trimmed file the live run would');
    assert.equal(readGraphNodes(trimmed).filter(CARD).length, 0, 'PREMISE: B\'s file holds no card'); assert.equal(readGraphNodes(W.file).filter(CARD).length, W.nFile, 'PREMISE: A\'s file still holds them');
    const A = await W.serve(W.file); const B = await W.serve(trimmed);
    try {
      const diffs = [];
      for (const [label, method, route, shows, body] of SURFACES(W)) {
        const a = await api(A.baseUrl, method, route, body); const b = await api(B.baseUrl, method, route, body);
        assert.equal(a.status, 200, `A: ${label} answers 200 (${a.status} ${a.text.slice(0, 100)})`);
        if (shows) assert.ok(a.text.includes(W.tag), `A: ${label} actually shows the cards (an empty pair is not a pass)`);
        if (b.status !== a.status) diffs.push(`${label}: status ${a.status} with the cards, ${b.status} without`);
        else { const d = firstDiff(maskDeep(a.body ?? a.text), maskDeep(b.body ?? b.text), ''); if (d) diffs.push(`${label}: ${d}`); }
      }
      assert.deepEqual(diffs, [], 'every surface answers the same without the file\'s cards as with them; the surfaces that differ, and the first difference in each:\n  ' + diffs.join('\n  '));
    } finally { await A.stop(); await B.stop(); }
  } finally { await W.stop(); }
});

test('R4 NO ORPHAN IS LEFT BEHIND: after the removal no node remaining in the file names a removed card', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'migrated'); const ap = W.retire(W.file, true); assert.equal(ap.code, 0, `removed (${ap.code}): ${ap.out.slice(-300)}`);
    const rest = readGraphNodes(W.file).filter((n) => n['@type'] !== 'Comment');   // a POST that is ABOUT a card (the claim announcement) names it by design; posts have their own removal (#1626)
    const text = JSON.stringify(rest);
    const orphans = W.cards.filter((c) => text.includes(c.id)).map((c) => `${c.title} (${c.id})`);
    assert.deepEqual(orphans, [], `these removed cards are still named by a node left in the file (a card-owned check, release condition or blocker, or a reference): ${rest.filter((n) => W.cards.some((c) => JSON.stringify(n).includes(c.id))).map((n) => `${JSON.stringify(n['@type'])} ${String(n['@id']).slice(0, 60)}`).slice(0, 6).join('; ')}`);
  } finally { await W.stop(); }
});

test('R5 A CARD CREATED AFTER THE REMOVAL: numbered one past the highest, in the list and by id, in the executor and not in the file', { skip: SKIP, timeout: 400000 }, async () => {
  const W = await world(ALNUM());
  try {
    assert.equal(W.migrate().code, 0, 'migrated'); assert.equal(W.retire(W.file, true).code, 0, 'removed'); const B = await W.serve(W.file);
    try {
      const mark = `${W.tag}-after-removal`; const made = await api(B.baseUrl, 'POST', '/api/cards', { title: mark, description: `${mark} body`, createdBy: 'ada' }); assert.equal(made.status, 201, `a create is accepted (${made.status} ${made.text.slice(0, 100)})`);
      assert.equal(made.body.shortId, Math.max(...W.served.map((c) => c.shortId)) + 1, `numbered one past the highest (no reuse): ${made.body.shortId}`);
      assert.equal((await api(B.baseUrl, 'GET', `/api/cards/${made.body.id}`)).body.title, mark, 'it reads by id');
      const list = (await api(B.baseUrl, 'GET', '/api/cards?limit=500')).body; assert.ok((Array.isArray(list) ? list : list.cards).some((c) => c.title === mark), 'it is in the list');
      assert.ok(await holders(W.exec, `${mark} body`) >= 1, 'the executor holds it'); assert.ok(!fs.readFileSync(B.boardFile ?? W.file, 'utf8').includes(`${mark} body`), 'and the board file does not');
    } finally { await B.stop(); }
  } finally { await W.stop(); }
});
