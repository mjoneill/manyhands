/**
 * #1850 (#1848 slice 1) — HOW OFTEN AN EXTRACTED CLAIM IS SHOWN TO A SEAT, AND HOW OFTEN IT IS USED: two numbers, never
 * merged, so putting a claim in front of a seat can never count as the claim being useful. Read from what #1851 records,
 * not from text: the 11-11 hand count found a text key wrong in BOTH directions (it counted pipeline debugging as use and
 * missed the one real use). Definition accepted by the Value Steward, commons 52810.
 *
 * INTERFACE PINNED HERE:
 *   GET /api/links/counts?since=<ISO instant>  → 200 { since, seats: [{ seat, shown, delivered, used }], deciders, label, means }
 *     shown  distinct links the seat DECIDED (confirmed or dismissed): a seat cannot decide a link it was never shown.
 *            Since #1852 also the links it was DELIVERED, with `delivered` as their own number: those rows are K1-K3 in
 *            knowledge-delivery-rest-1852, where a delivery can be made. Nothing here is delivered, so `delivered` is 0.
 *     used   distinct links the seat CONFIRMED at least once. A confirm must name the card the seat was working on, so it
 *            records the seat acting on the claim, not merely agreeing with it. A later dismiss does not unmake that act.
 *     deciders  how many distinct seats have decided any link in the window
 *     label  non-null while deciders < 3: the numbers are then self-attributed by the seats that built and reviewed the
 *            linker, and must be read that way (a count, never a list of names)
 *   400 a since that is not an ISO instant · 503 LINKS_UNAVAILABLE without the log-born unit
 *
 *   K1  a dismiss raises shown and not used
 *   K2  a confirm raises shown AND used
 *   K3  per seat: one seat's verdicts never move another seat's numbers
 *   K4  distinct links: deciding the same link twice counts once, and a dismiss after a confirm leaves it used
 *   K5  since: a window that starts after every decision counts nothing
 *   K6  the label is set while fewer than three seats have decided, and cleared once three have
 *   K7  a since that is not an ISO instant: 400
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
import { linkIri, spanKey } from '../core/knowledge-linking.mjs';
import { cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const SEATS = ['ada', 'bea', 'cal'];

const ROSTER = path.join(os.tmpdir(), `lc1850-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ...Object.fromEntries(SEATS.map((s) => [s, { name: s, glyph: s[0], color: '#7cc4a0' }])), board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = Object.fromEntries(SEATS.map((s) => [s, mintToken()]));
const TOKENS = path.join(os.tmpdir(), `lc1850-tokens-${process.pid}.json`);
{
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(TOKENS, JSON.stringify({ seats: Object.fromEntries(SEATS.map((s) => [s, { credentials: [{ tokenHash: hashToken(TOK[s]), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }])) }));
}
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });

let w;
before(async () => {
  if (SKIP) return;
  w = await wholeBoardWorld({ logborn: true, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: 'required' } });
});
after(async () => { if (w) await w.stop(); });

const call = async (seat, method, route, payload) => {
  const headers = { authorization: `Bearer ${TOK[seat]}`, ...(payload ? { 'content-type': 'application/json' } : {}) };
  const x = await fetch(`${w.rest.baseUrl}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j };
};
/** A claim and a proposed link from it to fixture card <shortId>, written raw: the linker is not under test here. */
async function seedLink(shortId) {
  const assertion = `https://scrumboard.local/assertion/${crypto.randomUUID()}`;
  const span = `a claim ${assertion}`;
  const link = linkIri(spanKey(span, `uuid-${shortId}`));
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${crypto.randomUUID()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA { <${assertion}> <${RDF}type> <${RS}Assertion> ; <${RS}anchorText> ${JSON.stringify(span)} .
      <${link}> <${RDF}type> <${RS}BearsOn> ; <${RS}fromAssertion> <${assertion}> ; <${RS}bearsOnCard> <${cardIriOf(`uuid-${shortId}`)}> ; <${RS}score> "0.7" ; <${RS}status> "proposed" . }` });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
  return link.split('/').pop();
}
const decide = async (seat, id, verdict) => {
  const r = await call(seat, 'POST', `/api/links/${id}/decide`, { verdict, ...(verdict === 'confirmed' ? { workingOn: 1 } : {}), by: seat });
  assert.equal(r.status, 200, r.text);
};
const counts = async (seat = 'ada', since = '2000-01-01T00:00:00.000Z') => {
  const r = await call(seat, 'GET', `/api/links/counts?since=${encodeURIComponent(since)}`);
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const of = (j, seat) => j.seats.find((s) => s.seat === seat) ?? { seat, shown: 0, used: 0 };
const delta = (a, b, seat) => ({ shown: of(b, seat).shown - of(a, seat).shown, used: of(b, seat).used - of(a, seat).used });

test('K1 a dismiss raises shown and not used', T, async () => {
  const id = await seedLink(2);
  const a = await counts();
  await decide('ada', id, 'dismissed');
  const b = await counts();
  assert.deepEqual(delta(a, b, 'ada'), { shown: 1, used: 0 });
  assert.equal(of(b, 'ada').delivered, 0, 'a link the seat found and decided herself was not delivered (#1852)');
});

test('K2 a confirm raises shown AND used', T, async () => {
  const id = await seedLink(3);
  const a = await counts();
  await decide('ada', id, 'confirmed');
  assert.deepEqual(delta(a, await counts(), 'ada'), { shown: 1, used: 1 });
});

test('K3 per seat: one seat\'s verdicts never move another seat\'s numbers', T, async () => {
  const id = await seedLink(4);
  const a = await counts();
  await decide('bea', id, 'confirmed');
  const b = await counts();
  assert.deepEqual(delta(a, b, 'bea'), { shown: 1, used: 1 });
  assert.deepEqual(delta(a, b, 'ada'), { shown: 0, used: 0 }, 'ada did nothing');
});

test('K4 distinct links: the same link decided twice counts once, and a dismiss after a confirm leaves it used', T, async () => {
  const id = await seedLink(5);
  const a = await counts();
  await decide('ada', id, 'confirmed');
  await decide('ada', id, 'confirmed');
  await decide('ada', id, 'dismissed');
  assert.deepEqual(delta(a, await counts(), 'ada'), { shown: 1, used: 1 });
});

test('K5 since: a window that starts after every decision counts nothing', T, async () => {
  const id = await seedLink(6);
  await decide('ada', id, 'confirmed');
  const later = await counts('ada', new Date(Date.now() + 3600_000).toISOString());
  assert.deepEqual(later.seats, [], JSON.stringify(later));
  assert.equal(later.deciders, 0);
  const all = await counts();
  assert.ok(of(all, 'ada').used >= 1, 'CONTROL: the same decision is counted in a window that contains it');
});

test('K6 the label is set while fewer than three seats have decided, and cleared once three have', T, async () => {
  const a = await counts();
  assert.ok(a.deciders >= 1 && a.deciders < 3, `two seats at most have decided so far (${a.deciders})`);
  assert.equal(typeof a.label, 'string');
  assert.match(a.label, /self-attributed/);
  await decide('cal', await seedLink(7), 'dismissed');
  const b = await counts();
  assert.equal(b.deciders, 3);
  assert.equal(b.label, null);
});

test('K7 a since that is not an ISO instant: 400', T, async () => {
  for (const bad of ['yesterday', '2026-13-45', '"} UNION {']) {
    const r = await call('ada', 'GET', `/api/links/counts?since=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `${bad}: ${r.text}`);
  }
});
