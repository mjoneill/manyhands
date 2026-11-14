/**
 * #1894 — THE TWO ROUTES BEHIND reading.html, over REST with the log-born unit and required auth (the shape prod runs).
 * The owner cannot query the graph; these are how a page he can open reads the runs the room has read.
 *
 * INTERFACE PINNED HERE:
 *   GET /api/readings[?limit=N]  → { readings: [{ id, outcome, startedAt, finishedAt, title, url, claims, links, linksByStatus, askedIn }], truncated, means }
 *        newest first; a run that failed or never finished is listed too (claims 0), because "it was tried and did not read" is news
 *   GET /api/readings/:runId     → { run, source: { title, url, synopsis, iri, hasPages }, claims: [{ id, gist, quote, type, verb, block, page, links }], means }
 *        claims in SOURCE order; 400 a malformed run id · 404 no such run · 503 the log-born unit is off · 401 no bearer
 *
 *   L1  the list: newest first, with each run's claim count and its live link count, failed and unfinished runs included
 *   L2  `truncated` is honest about the cap; a bad limit is a 400
 *   D1  one run: its header, synopsis, the post that asked, and EVERY claim in numeric block order with gist, quote, type, links
 *   D2  a file's claims carry their page, computed from the kept text
 *   D3  a malformed run id is refused (400) before it reaches a query; an unknown one is 404; a run that is not an extraction is 404
 *   D4  no bearer: 401, the same door GET /api/links has
 *   U1  the log-born unit off: 503 with a code, never an empty list that reads as "nothing was read"
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const SCHEMA = 'https://schema.org/';

const ROSTER = path.join(os.tmpdir(), `kr1894-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKENS = path.join(os.tmpdir(), `kr1894-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });

let w; let dataDir;
before(async () => {
  if (SKIP) return;
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required' } });
  dataDir = path.dirname(w.boardFile);   // the server's data folder is the board file's folder
});
after(async () => { if (w) await w.stop(); });

const call = async (route, { auth = true, world = w } = {}) => {
  const x = await fetch(`${world.rest.baseUrl}${route}`, { headers: auth ? { authorization: `Bearer ${TOK}` } : {}, signal: AbortSignal.timeout(60000) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uuid = () => crypto.randomUUID();
const L = (s) => JSON.stringify(String(s));

/** Write raw triples the way the extractor's publish and the research verbs leave them; the writer is not under test here. */
async function seed(triples) {
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${uuid()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA { ${triples} }` });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
}

/**
 * One extraction run. `claims` are { block, gist, quote, type, verb }; `links` are { claim: <index>, card: <n>, status, score }.
 * `outcome: null` = the run never wrote a report; `op` lets a test seed a run that is not an extraction.
 */
async function seedRun({ title = 'A source', url = 'https://example.com/a', synopsis = 'About a thing.', at = '2026-11-14T10:00:00.000Z', outcome = 'complete', claims = [], links = [], post = true, hex = sha(uuid()), op = 'extract' } = {}) {
  const run = `https://scrumboard.local/activity/run-${uuid()}`;
  const src = `https://scrumboard.local/source/${hex}`;
  const postIri = `https://scrumboard.local/entity/${uuid()}`;
  const started = new Date(Date.parse(at) - 60_000).toISOString();
  const t = [];
  if (post) t.push(`<${postIri}> <${RDF}type> <${SCHEMA}Comment> ; <${RS}postSeq> "53116" ; <${SCHEMA}dateCreated> "2026-11-14T09:59:00.000000Z" .`);
  t.push(`<${src}> <${RDF}type> <${RS}SourceVersion> ; <${RS}contentHash> ${L(`sha256:${hex}`)} ; <${SCHEMA}url> ${L(url)} `
    + `${title ? `; <${SCHEMA}name> ${L(title)} ` : ''}${synopsis ? `; <${SCHEMA}abstract> ${L(synopsis)} ` : ''}${post ? `; <${PROV}wasDerivedFrom> <${postIri}> ` : ''}.`);
  t.push(`<${run}> <${RDF}type> <${PROV}Activity> ; <${RS}op> ${L(op)} ; <${PROV}used> <${src}> ; <${PROV}startedAtTime> ${L(started)} .`);
  if (outcome) t.push(`<${run}/extraction> <${RDF}type> <${RS}ExtractionReport> ; <${RS}ofRun> <${run}> ; <${RS}outcome> ${L(outcome)} ; <${RS}at> ${L(at)} ; <${RS}publishedCount> "${claims.length}" .`);
  const ids = claims.map((c) => {
    const a = `https://scrumboard.local/assertion/${uuid()}`;
    t.push(`<${a}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; <${RS}expressedIn> <${src}/block/${c.block}> ; <${RS}anchorText> ${L(c.quote)} ; <${RS}gist> ${L(c.gist)} ; <${RS}assertionType> ${L(c.type ?? 'definition')} `
      + `${c.verb ? `; <${RS}proposedPredicate> ${L(c.verb)} ` : ''}.`);
    return a;
  });
  for (const k of links) {
    const l = `https://scrumboard.local/link/${sha(uuid())}`;
    t.push(`<${l}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${ids[k.claim]}> ; <${RS}bearsOnCard> <${cardIriOf(`uuid-${k.card}`)}> ; <${RS}score> ${L(k.score ?? '0.6')} ; <${RS}status> ${L(k.status ?? 'proposed')} .`);
  }
  await seed(t.join('\n'));
  return { id: run.split('/').pop(), run, src, hex, ids };
}

const CLAIMS = [
  { block: 10, gist: 'Gist ten.', quote: 'quote at block ten', type: 'empirical', verb: 'causes' },
  { block: 2, gist: 'Gist two.', quote: 'quote at block two', type: 'definition' },
  { block: 100, gist: 'Gist hundred.', quote: 'quote at block hundred', type: 'analogy' },
  { block: 8, gist: 'Gist eight.', quote: 'quote at block eight', type: 'recommendation', verb: 'should_hold' },
  { block: 9, gist: 'Gist nine.', quote: 'quote at block nine', type: 'definition' },
];

test('D1 one run: header, synopsis, the post that asked, and EVERY claim in numeric block order with its links', T, async () => {
  const s = await seedRun({ title: 'How things fail', synopsis: 'A short treatise.', claims: CLAIMS, links: [{ claim: 3, card: 2, status: 'proposed', score: '0.681' }, { claim: 3, card: 3, status: 'confirmed', score: '0.9' }, { claim: 0, card: 2, status: 'dismissed', score: '0.5' }] });
  const r = await call(`/api/readings/${s.id}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.claims.map((c) => c.block), [2, 8, 9, 10, 100], 'source order, numerically: block 8 before block 10');
  assert.equal(r.json.claims.length, 5, 'every claim');
  assert.deepEqual({ id: r.json.run.id, outcome: r.json.run.outcome, claims: r.json.run.claims, links: r.json.run.links, finishedAt: r.json.run.finishedAt }, { id: s.id, outcome: 'complete', claims: 5, links: 2, finishedAt: '2026-11-14T10:00:00.000Z' });
  assert.deepEqual(r.json.run.askedIn, { postSeq: 53116, at: '2026-11-14T09:59:00.000000Z' });
  assert.deepEqual({ title: r.json.source.title, url: r.json.source.url, synopsis: r.json.source.synopsis, hasPages: r.json.source.hasPages }, { title: 'How things fail', url: 'https://example.com/a', synopsis: 'A short treatise.', hasPages: false });
  const eight = r.json.claims[1];
  assert.deepEqual({ gist: eight.gist, quote: eight.quote, type: eight.type, verb: eight.verb, page: eight.page }, { gist: 'Gist eight.', quote: 'quote at block eight', type: 'recommendation', verb: 'should_hold', page: null });
  assert.deepEqual(eight.links.map((l) => [l.card.shortId, l.card.title, l.status, l.score]), [[3, 'card 3', 'confirmed', 0.9], [2, 'card 2', 'proposed', 0.681]], 'the card\'s short id and title, best score first');
  const ten = r.json.claims[3];
  assert.deepEqual(ten.links.map((l) => l.status), ['dismissed'], 'a dismissed link is still shown on its claim');
  assert.equal(r.json.claims[0].links.length, 0);
  assert.ok(!('subject' in eight) && !('object' in eight), 'no sentence is built from the triple');
});

test('D2 a file\'s claims carry their page, computed from the kept text; a web article\'s carry none', T, async () => {
  const text = ['alpha line here', 'beta line here', '\fgamma line here', 'delta line here', '\fepsilon line here'].join('\n');
  const hex = sha(text);
  fs.mkdirSync(path.join(dataDir, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sources', `${hex}.txt`), text);
  const pdf = await seedRun({ hex, url: `urn:sha256:${sha('the original pdf')}`, claims: [{ block: 4, gist: 'g4', quote: 'epsilon line here' }, { block: 1, gist: 'g1', quote: 'beta line here' }, { block: 3, gist: 'g3', quote: 'delta line here' }] });
  const r = await call(`/api/readings/${pdf.id}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.claims.map((c) => [c.block, c.page]), [[1, 1], [3, 2], [4, 3]]);
  assert.equal(r.json.source.hasPages, true);
  assert.equal(r.json.source.url, `urn:sha256:${sha('the original pdf')}`, 'a file source keeps its urn: name');
  // CONTROL: the same kept text under a web url is not paged (page 1 for every claim would be a false number)
  const web = await seedRun({ hex, url: 'https://example.com/pdf-as-web', claims: [{ block: 4, gist: 'g4', quote: 'epsilon line here' }] });
  assert.equal((await call(`/api/readings/${web.id}`)).json.claims[0].page, null);
  // a file whose kept text is gone: still a page of claims, honestly without pages
  const gone = await seedRun({ url: `urn:sha256:${sha('another')}`, claims: [{ block: 1, gist: 'g', quote: 'q q q' }] });
  const g = await call(`/api/readings/${gone.id}`);
  assert.equal(g.status, 200, g.text);
  assert.equal(g.json.claims[0].page, null);
});

test('D3 a malformed run id is refused (400) before any query; an unknown one is 404; a run that is not an extraction is 404', T, async () => {
  for (const bad of ['nope', 'run-1234', encodeURIComponent('run-44d706e1-16af-4a45-8671-d4baef63563b> } SELECT'), 'RUN-44D706E1-16AF-4A45-8671-D4BAEF63563B', '44d706e1-16af-4a45-8671-d4baef63563b', encodeURIComponent('../api/links')]) {
    const r = await call(`/api/readings/${bad}`);
    assert.equal(r.status, 400, `${bad} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.json.code, 'BAD_RUN_ID');
  }
  const unknown = await call('/api/readings/run-00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.code, 'READING_NOT_FOUND');
  const other = await seedRun({ op: 'research', claims: [{ block: 1, gist: 'g', quote: 'q q q' }] });
  assert.equal((await call(`/api/readings/${other.id}`)).status, 404, 'a research run is not a reading');
  assert.ok(!(await call('/api/readings')).json.readings.some((x) => x.id === other.id), 'and it is not in the list');
});

test('L1 the list: newest first, with each run\'s claims and live links; failed and unfinished runs are listed with zero claims', T, async () => {
  const old = await seedRun({ title: 'Old one', at: '2026-01-01T10:00:00.000Z', claims: CLAIMS.slice(0, 2), links: [{ claim: 0, card: 2, status: 'proposed' }, { claim: 1, card: 3, status: 'dismissed' }] });
  const fresh = await seedRun({ title: 'Fresh one', at: '2099-01-01T10:00:00.000Z', claims: CLAIMS });
  const failed = await seedRun({ title: null, synopsis: null, at: '2098-12-01T10:00:00.000Z', outcome: 'failed', post: false });
  const dead = await seedRun({ title: null, synopsis: null, at: '2098-11-01T10:00:00.000Z', outcome: null, post: false });
  const r = await call('/api/readings?limit=200');
  assert.equal(r.status, 200, r.text);
  const ids = r.json.readings.map((x) => x.id);
  assert.deepEqual([fresh.id, failed.id, dead.id].map((i) => ids.indexOf(i)), [0, 1, 2], 'newest first: finish time, else start time');
  assert.ok(ids.indexOf(old.id) > 2);
  const row = (id) => r.json.readings.find((x) => x.id === id);
  assert.deepEqual({ title: row(fresh.id).title, url: row(fresh.id).url, claims: row(fresh.id).claims, links: row(fresh.id).links, outcome: row(fresh.id).outcome }, { title: 'Fresh one', url: 'https://example.com/a', claims: 5, links: 0, outcome: 'complete' });
  assert.deepEqual({ claims: row(old.id).claims, links: row(old.id).links, by: row(old.id).linksByStatus }, { claims: 2, links: 1, by: { proposed: 1, confirmed: 0, dismissed: 1 } });
  assert.deepEqual({ outcome: row(failed.id).outcome, claims: row(failed.id).claims, title: row(failed.id).title }, { outcome: 'failed', claims: 0, title: null });
  assert.deepEqual({ outcome: row(dead.id).outcome, claims: row(dead.id).claims, finishedAt: row(dead.id).finishedAt }, { outcome: 'unfinished', claims: 0, finishedAt: null });
  assert.deepEqual(row(fresh.id).askedIn, { postSeq: 53116, at: '2026-11-14T09:59:00.000000Z' });
});

test('L3 a source asked for in two posts is one reading in the list and in the run, naming the first post', T, async () => {
  const s = await seedRun({ claims: CLAIMS.slice(0, 1) });
  const later = `https://scrumboard.local/entity/${uuid()}`;
  await seed(`<${later}> <${RDF}type> <${SCHEMA}Comment> ; <${RS}postSeq> "70000" . <${s.src}> <${PROV}wasDerivedFrom> <${later}> .`);
  const list = await call('/api/readings?limit=200');
  assert.equal(list.json.readings.filter((x) => x.id === s.id).length, 1, 'one row, not one per post');
  assert.equal(list.json.readings.find((x) => x.id === s.id).askedIn.postSeq, 53116);
  const one = await call(`/api/readings/${s.id}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.run.askedIn.postSeq, 53116);
  assert.equal(one.json.claims.length, 1);
});

test('L2 truncated is honest about the cap, and a bad limit is a 400', T, async () => {
  await seedRun(); await seedRun();
  const one = await call('/api/readings?limit=1');
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.readings.length, 1);
  assert.equal(one.json.truncated, true);
  const all = await call('/api/readings?limit=200');
  assert.equal(all.json.truncated, false, 'CONTROL: every test run fits the cap');
  for (const bad of ['0', '-1', 'x', '201', '1.5']) assert.equal((await call(`/api/readings?limit=${bad}`)).status, 400, `limit=${bad}`);
});

test('D4 no bearer: 401 on both routes, the same door GET /api/links has', T, async () => {
  const s = await seedRun({ claims: CLAIMS.slice(0, 1) });
  const links = await call('/api/links', { auth: false });
  assert.equal(links.status, 401, 'PRECONDITION: the existing route refuses an anonymous caller here');
  for (const route of ['/api/readings', `/api/readings/${s.id}`]) {
    const r = await call(route, { auth: false });
    assert.equal(r.status, links.status, `${route}: ${r.text.slice(0, 120)}`);
    assert.ok(!r.text.includes('Gist'), 'nothing of a run leaks to an anonymous caller');
  }
});

test('P1 the page itself is served by the board', T, async () => {
  // under required auth every page needs the bearer (as settings.html does); prod runs observe mode, where a browser needs none
  const x = await fetch(`${w.rest.baseUrl}/reading.html`, { headers: { authorization: `Bearer ${TOK}` } });
  assert.equal(x.status, 200);
  assert.match(await x.text(), /<title>Reading/);
});

test('U1 the log-born unit off: 503 with a code on both routes, never an empty list that reads as "nothing was read"', T, async () => {
  const off = await wholeBoardWorld({ logborn: false, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required' } });
  try {
    for (const route of ['/api/readings', '/api/readings/run-00000000-0000-4000-8000-000000000000']) {
      const r = await call(route, { world: off });
      assert.equal(r.status, 503, `${route}: ${r.text}`);
      assert.equal(r.json.code, 'READINGS_UNAVAILABLE');
      assert.match(r.json.error, /SCRUM_GRAPH_UNIT_LOGBORN/);
    }
    const links = await call('/api/links', { world: off });
    assert.equal(links.status, 503, 'CONTROL: the existing links route answers the same way with the unit off');
  } finally { await off.stop(); }
});
