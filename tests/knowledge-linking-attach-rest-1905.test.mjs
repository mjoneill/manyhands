/**
 * #1905 — A SEAT ATTACHES A CLAIM TO A CARD BY HAND, over REST with the log-born unit and required auth (prod's shape).
 * "The human finds it at ___": POST /api/links/attach (MCP link_attach), and the result in GET /api/links with its origin.
 *
 * INTERFACE PINNED HERE:
 *   POST /api/links/attach { claim: <assertion IRI>, card: <shortId>, reason, by } → 201 { id, card, claim, reason, by }
 *        400 no reason · 400 card names no card · 404 CLAIM_NOT_FOUND · 409 LINK_EXISTS (names the existing id) · 403 SEAT_NOT_SELF
 *   GET  /api/links rows gain { origin: 'hand'|'machine', attachedBy, reason }
 *
 *   R1  an attach: 201, and the graph holds a proposed BearsOn attachedBy the AUTHENTICATED seat, with the reason
 *   R2  the list shows the hand link with origin hand, who and why; a machine link shows origin machine and no attacher
 *   R3  attaching a pair that already has a link: 409 LINK_EXISTS naming that link, never suggesting a confirm, nothing written
 *   R4  an attach on behalf of ANOTHER seat: 403 SEAT_NOT_SELF, nothing written
 *   R5  no reason: 400 naming reason · a card that is not on the board: 400 · an unknown claim: 404
 *   R6  no bearer: 401, nothing written
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

const ROSTER = path.join(os.tmpdir(), `kl1905-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = mintToken();
const TOKENS = path.join(os.tmpdir(), `kl1905-tokens-${process.pid}.json`);
{ const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(TOKENS, JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); }
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });

let w, gc;
before(async () => {
  if (SKIP) return;
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required' } });
  gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kl1905' });
});
after(async () => { if (w) await w.stop(); });

const call = async (method, route, payload, { auth = true } = {}) => {
  const headers = { ...(auth ? { authorization: `Bearer ${TOK}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const x = await fetch(`${w.rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
};
const q = async (sparql) => { const r = await gc.query(sparql); assert.ok(r.ok, r.reason); return r.rows; };
const insert = async (triples) => {
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA { ${triples} }` });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
};
/** A claim the room read, with no link: the thing a seat attaches. */
async function seedClaim() {
  const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  const span = `a claim worth keeping ${assertion}`;
  await insert(`<${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} ; <${RS}gist> "the gist" .`);
  return { assertion, span };
}
const linksOn = async (assertion) => (await q(`SELECT ?l WHERE { ?l a <${RS}BearsOn> ; <${RS}fromAssertion> <${assertion}> }`)).map((r) => r.l.value);

test('R1 an attach: 201, and the graph holds a proposed link attached by the AUTHENTICATED seat, with the reason', T, async () => {
  const c = await seedClaim();
  const r = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: 'this is the rule card 2 forgot', by: 'ada' });
  assert.equal(r.status, 201, r.text);
  const link = linkIri(spanKey(c.span, 'uuid-2'));
  assert.deepEqual(r.json, { id: link.split('/').pop(), card: 2, claim: c.assertion, reason: 'this is the rule card 2 forgot', by: 'ada' });
  const g = await q(`SELECT ?st ?c ?by ?why WHERE { <${link}> a <${RS}BearsOn> ; <${RS}status> ?st ; <${RS}bearsOnCard> ?c ; <${RS}attachedBy> ?by ; <${RS}attachReason> ?why }`);
  assert.equal(g.length, 1, 'the link is in the graph');
  assert.deepEqual([g[0].st.value, g[0].c.value, g[0].by.value, g[0].why.value], ['proposed', cardIriOf('uuid-2'), seatActor('ada'), 'this is the rule card 2 forgot']);
});

test('R2 the list says where a link came from: hand (who and why) or machine', T, async () => {
  const c = await seedClaim();
  assert.equal((await call('POST', '/api/links/attach', { claim: c.assertion, card: 3, reason: 'card 3 needs this', by: 'ada' })).status, 201);
  const m = await seedClaim();
  const mlink = linkIri(spanKey(m.span, 'uuid-3'));
  await insert(`<${mlink}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${m.assertion}> ; <${RS}bearsOnCard> <${cardIriOf('uuid-3')}> ; <${RS}score> "0.7" ; <${RS}status> "proposed" .`);
  const rows = (await call('GET', '/api/links?card=3')).json.links;
  const hand = rows.find((l) => l.claim.iri === c.assertion);
  const machine = rows.find((l) => l.claim.iri === m.assertion);
  assert.ok(hand && machine, JSON.stringify(rows));
  assert.deepEqual({ origin: hand.origin, attachedBy: hand.attachedBy, reason: hand.reason }, { origin: 'hand', attachedBy: 'ada', reason: 'card 3 needs this' });
  assert.deepEqual({ origin: machine.origin, attachedBy: machine.attachedBy, reason: machine.reason }, { origin: 'machine', attachedBy: null, reason: null });
});

test('R3 a pair that already has a link: 409 LINK_EXISTS naming it, never suggesting a confirm, nothing written', T, async () => {
  const c = await seedClaim();
  const first = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: 'first', by: 'ada' });
  assert.equal(first.status, 201, first.text);
  const again = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: 'second', by: 'ada' });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'LINK_EXISTS');
  assert.equal(again.json.id, first.json.id);
  assert.doesNotMatch(again.json.error, /confirm/i, 'a duplicate points at the existing link, it does not ask for a verdict');
  const why = await q(`SELECT ?why WHERE { <${linkIri(spanKey(c.span, 'uuid-2'))}> <${RS}attachReason> ?why }`);
  assert.deepEqual(why.map((x) => x.why.value), ['first'], 'the first reason stands, alone');
});

test('R4 an attach on behalf of ANOTHER seat is refused (SEAT_NOT_SELF), nothing written', T, async () => {
  const c = await seedClaim();
  const r = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: 'not mine to say', by: 'bob' });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'SEAT_NOT_SELF');
  assert.deepEqual(await linksOn(c.assertion), []);
});

test('R5 refusals: no reason (400), a card not on the board (400), an unknown claim (404)', T, async () => {
  const c = await seedClaim();
  const noWhy = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: '  ', by: 'ada' });
  assert.equal(noWhy.status, 400, noWhy.text);
  assert.match(noWhy.text, /reason/);
  const noCard = await call('POST', '/api/links/attach', { claim: c.assertion, card: 99999, reason: 'x', by: 'ada' });
  assert.equal(noCard.status, 400, noCard.text);
  const noClaim = await call('POST', '/api/links/attach', { claim: `https://scrumboard.local/assertion/${crypto.randomUUID()}`, card: 2, reason: 'x', by: 'ada' });
  assert.equal(noClaim.status, 404, noClaim.text);
  assert.equal(noClaim.json.code, 'CLAIM_NOT_FOUND');
  assert.deepEqual(await linksOn(c.assertion), [], 'none of them wrote');
  const ok = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: 'x', by: 'ada' });
  assert.equal(ok.status, 201, `CONTROL: the same claim and card with a reason is accepted (${ok.text})`);
});

test('R6 no bearer: refused (401), nothing written', T, async () => {
  const c = await seedClaim();
  const r = await call('POST', '/api/links/attach', { claim: c.assertion, card: 2, reason: 'x', by: 'ada' }, { auth: false });
  assert.equal(r.status, 401, r.text);
  assert.deepEqual(await linksOn(c.assertion), []);
});

test('R7 OBSERVE mode, the shape prod runs (no SCRUM_AUTH): an attach on behalf of another seat is still refused, and the bearer\'s own is recorded as hers', T, async () => {
  const o = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '' } });
  try {
    const ogc = createGraphClient({ baseUrl: o.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'kl1905-observe' });
    const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
    const span = `observe ${assertion}`;
    const ep = (await (await fetch(`${o.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${o.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
      body: `INSERT DATA { <${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} . }` });
    assert.equal(seed.status, 200);
    const post = (body) => fetch(`${o.rest.baseUrl}/api/links/attach`, { method: 'POST', headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const foreign = await post({ claim: assertion, card: 2, reason: 'x', by: 'bob' });
    const ft = await foreign.text();
    assert.equal(foreign.status, 403, ft);
    assert.match(ft, /SEAT_NOT_SELF/);
    const link = linkIri(spanKey(span, 'uuid-2'));
    assert.equal((await ogc.query(`SELECT ?t WHERE { <${link}> a <${RS}BearsOn> }`)).rows.length, 0, 'nothing written');
    const own = await post({ claim: assertion, card: 2, reason: 'x', by: 'ada' });
    assert.equal(own.status, 201, `CONTROL: attaching as herself is accepted in observe too (${await own.text()})`);
    const by = await ogc.query(`SELECT ?by WHERE { <${link}> <${RS}attachedBy> ?by }`);
    assert.deepEqual(by.rows.map((x) => x.by.value), [seatActor('ada')]);
  } finally { await o.stop(); }
});

test('R8 the claim may be given as the Reading page shows it, its bare id: the same link as its full address', T, async () => {
  const c = await seedClaim();
  const r = await call('POST', '/api/links/attach', { claim: c.assertion.split('/').pop(), card: 2, reason: 'from the reading page', by: 'ada' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.claim, c.assertion, 'the answer names the full address');
  assert.equal(r.json.id, linkIri(spanKey(c.span, 'uuid-2')).split('/').pop());
  const bad = await call('POST', '/api/links/attach', { claim: '../card/2', card: 2, reason: 'x', by: 'ada' });
  assert.equal(bad.status, 404, `a value that is neither an id nor a claim address is no claim (${bad.text})`);
});
