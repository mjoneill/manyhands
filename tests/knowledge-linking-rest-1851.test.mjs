/**
 * #1851 (#1848 slice 2) — WHERE A SEAT FINDS A PROPOSED LINK, AND HOW SHE ANSWERS IT, over REST with the log-born unit and
 * required auth (the shape prod runs: SCRUM_GRAPH_UNIT_LOGBORN=1, a seat bearer). "The human finds it at ___": GET
 * /api/links (MCP link_list); she answers at POST /api/links/:id/decide (MCP link_decide, bound to her session's seat).
 *
 * INTERFACE PINNED HERE:
 *   GET  /api/links?status=proposed|confirmed|dismissed&card=<shortId>  → { links: [{ id, status, dismissals, score, card: { shortId, title },
 *        claim: { iri, span, gist } }] }   id = the 64-hex tail of the link IRI
 *   POST /api/links/:id/decide { verdict: confirmed|dismissed, workingOn?: <shortId>, by } → 200 { id, verdict, workingOn, by, hidden? }
 *        (#1852: a dismiss is one seat's; `dismissals` and `hidden` are pinned in knowledge-linking-dismiss-1852)
 *        400 a confirm with no workingOn · 400 workingOn names no card · 404 no such link · 401 no bearer
 *
 *   H1  GET lists a proposed link with its card (short id + title) and its claim's span and gist
 *   H2  a confirm with workingOn: 200, and the graph holds status confirmed and a LinkDecision decidedBy the AUTHENTICATED seat
 *   H3  a verdict on behalf of another seat is refused: 403 SEAT_NOT_SELF, nothing written
 *   H4  an unknown link id: 404
 *   H5  a confirm with no workingOn: 400 naming workingOn
 *   H6  no bearer: refused (401), nothing written
 *   H7  the list filters: status=confirmed shows the H2 link and not a still-proposed one; card=<shortId> narrows to that card
 *   H8  the list says when it was cut: `truncated` (review 52723 point 2)
 *   H9  in OBSERVE mode (prod's shape), a verdict on behalf of another seat is still refused (review 52726)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { createGraphClient, WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { linkIri, spanKey } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';
import { seatActor } from '../core/graph-auth.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';

const ROSTER = path.join(os.tmpdir(), `kl1851-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKENS = path.join(os.tmpdir(), `kl1851-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });

let w, gc;
before(async () => {
  if (SKIP) return;
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required' } });
  gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kl1851' });
});
after(async () => { if (w) await w.stop(); });

const call = async (method, route, payload, { auth = true } = {}) => {
  const headers = { ...(auth ? { authorization: `Bearer ${TOK}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const x = await fetch(`${w.rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
};
const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, r.reason); return r.rows; };
/** A claim and a proposed link from it to fixture card <shortId> (uuid-<n>), written raw: the linker is not under test here. */
async function seedLink(shortId) {
  const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  const span = `keep the top layer small ${assertion}`;
  const cardId = `uuid-${shortId}`;
  const link = linkIri(spanKey(span, cardId));
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA { <${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} ; <${RS}gist> "the gist" .
      <${link}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${assertion}> ; <${RS}bearsOnCard> <${cardIriOf(cardId)}> ; <${RS}score> "0.681" ; <${RS}status> "proposed" . }` });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
  return { link, id: link.split('/').pop(), assertion, span, cardId };
}

test('H1 GET /api/links lists a proposed link with its card and its claim', T, async () => {
  const s = await seedLink(2);
  const r = await call('GET', '/api/links?status=proposed');
  assert.equal(r.status, 200, r.text);
  const row = r.json.links.find((l) => l.id === s.id);
  assert.ok(row, `the link is listed (${r.text.slice(0, 300)})`);
  assert.equal(row.status, 'proposed');
  assert.equal(row.score, 0.681);
  assert.deepEqual(row.card, { shortId: 2, title: 'card 2' });
  assert.deepEqual(row.claim, { iri: s.assertion, span: s.span, gist: 'the gist' });
});

test('H2 a confirm with workingOn: 200, and the graph records it as the AUTHENTICATED seat\'s', T, async () => {
  const s = await seedLink(3);
  const r = await call('POST', `/api/links/${s.id}/decide`, { verdict: 'confirmed', workingOn: 1, by: 'ada' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ id: r.json.id, verdict: r.json.verdict, workingOn: r.json.workingOn }, { id: s.id, verdict: 'confirmed', workingOn: 1 });
  assert.deepEqual((await q(`SELECT ?s WHERE { <${s.link}> <${RS}status> ?s }`)).map((x) => x.s.value), ['confirmed']);
  const d = await q(`SELECT ?by ?wo WHERE { ?d <${RS}ofLink> <${s.link}> ; <${RS}decidedBy> ?by ; <${RS}workingOn> ?wo }`);
  assert.equal(d.length, 1);
  assert.equal(d[0].by.value, seatActor('ada'), 'the actor is the bearer\'s seat');
  assert.equal(d[0].wo.value, cardIriOf('uuid-1'));
});

test('H3 a verdict on behalf of ANOTHER seat is refused (SEAT_NOT_SELF), nothing written (review 52723 point 1, 52724)', T, async () => {
  // under enforced auth the server rewrites a foreign `by` to the key's seat and keeps the claim as onBehalfOf (#1569); a
  // verdict is counted per seat, so one seat answering for another is refused rather than silently re-signed
  const s = await seedLink(2);
  const r = await call('POST', `/api/links/${s.id}/decide`, { verdict: 'dismissed', by: 'bob' });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'SEAT_NOT_SELF');
  assert.deepEqual((await q(`SELECT ?s WHERE { <${s.link}> <${RS}status> ?s }`)).map((x) => x.s.value), ['proposed']);
  assert.equal((await q(`SELECT ?d WHERE { ?d <${RS}ofLink> <${s.link}> }`)).length, 0);
  const own = await call('POST', `/api/links/${s.id}/decide`, { verdict: 'dismissed', by: 'ada' });
  assert.equal(own.status, 200, `CONTROL: the bearer answering for herself is accepted (${own.text})`);
  assert.equal(own.json.by, 'ada');
});

test('H4 an unknown link id: 404', T, async () => {
  const r = await call('POST', `/api/links/${'0'.repeat(64)}/decide`, { verdict: 'dismissed', by: 'ada' });
  assert.equal(r.status, 404, r.text);
});

test('H5 a confirm with no workingOn: 400 naming workingOn', T, async () => {
  const s = await seedLink(2);
  const r = await call('POST', `/api/links/${s.id}/decide`, { verdict: 'confirmed', by: 'ada' });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /workingOn/);
});

test('H6 no bearer: refused, nothing written', T, async () => {
  const s = await seedLink(2);
  const r = await call('POST', `/api/links/${s.id}/decide`, { verdict: 'dismissed', by: 'ada' }, { auth: false });
  assert.equal(r.status, 401, r.text);
  assert.deepEqual((await q(`SELECT ?s WHERE { <${s.link}> <${RS}status> ?s }`)).map((x) => x.s.value), ['proposed']);
});

test('H8 the list says when it was cut: limit=1 over two or more links returns one and truncated:true (review 52723 point 2)', T, async () => {
  await seedLink(2); await seedLink(3);
  const r = await call('GET', '/api/links?limit=1');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.links.length, 1);
  assert.equal(r.json.truncated, true);
  const all = await call('GET', '/api/links');
  assert.equal(all.json.truncated, false, 'CONTROL: the default page holds every test link');
});

test('H9 OBSERVE mode, the shape prod runs (no SCRUM_AUTH): a verdict on behalf of another seat is still refused (review 52726)', T, async () => {
  const o = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' } });
  try {
    const ogc = createGraphClient({ baseUrl: o.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kl1851-observe' });
    const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
    const link = linkIri(spanKey(`observe ${assertion}`, 'uuid-2'));
    const ep = (await (await fetch(`${o.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${o.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
      body: `INSERT DATA { <${link}> <${RDF}type> <${RS}BearsOn> ; <${RS}status> "proposed" . }` });
    assert.equal(seed.status, 200);
    const id = link.split('/').pop();
    const post = (body) => fetch(`${o.rest.baseUrl}/api/links/${id}/decide`, { method: 'POST', headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const foreign = await post({ verdict: 'dismissed', by: 'bob' });
    const ft = await foreign.text();
    assert.equal(foreign.status, 403, ft);
    assert.match(ft, /SEAT_NOT_SELF/);
    const st = await ogc.query(`SELECT ?s WHERE { <${link}> <${RS}status> ?s }`);
    assert.deepEqual(st.rows.map((x) => x.s.value), ['proposed'], 'nothing written');
    const own = await post({ verdict: 'dismissed', by: 'ada' });
    assert.equal(own.status, 200, `CONTROL: answering for herself is accepted in observe too (${await own.text()})`);
  } finally { await o.stop(); }
});

test('H7 the list filters by status and by card', T, async () => {
  const kept = await seedLink(2);
  const done = await seedLink(3);
  assert.equal((await call('POST', `/api/links/${done.id}/decide`, { verdict: 'confirmed', workingOn: 1, by: 'ada' })).status, 200);
  const confirmed = (await call('GET', '/api/links?status=confirmed')).json.links.map((l) => l.id);
  assert.ok(confirmed.includes(done.id) && !confirmed.includes(kept.id), JSON.stringify(confirmed));
  const onCard2 = (await call('GET', '/api/links?card=2')).json.links;
  assert.ok(onCard2.length >= 1 && onCard2.every((l) => l.card.shortId === 2), JSON.stringify(onCard2));
});
