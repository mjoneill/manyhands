/**
 * THE `compare` FORM THROUGH THE WRITE ROUTE (#1610; the contract owner's 04:58Z: "the write-side validation is not covered by that result: inspect it before deploy, and keep live re-authoring/read-back of #900
 * before readiness and flag-on"). Written by the separate test author, before the verification run, to the form pinned in checks-compare-z1.test.mjs. The live step these rows rehearse is exactly "re-author #900 in
 * the compare form on the real card, read it back": a form the write route stores but a reload loses, or accepts but never evaluates, would make that step a silent no-op.
 *
 *   W1 ROUND TRIP    A card written through `POST /api/cards` with a compare tripwire is stored and read back with `compare` (left, op, right) and `expect` unchanged; the next forced pass evaluates it (a verdict, not an
 *                    error); the SERVER IS THEN KILLED and a second one is started on the same board file: the card still carries the compare, byte for byte, and the pass still evaluates it. An update through
 *                    `PATCH /api/cards/:id` replaces the check (flipping `expect`) and the pass answers `stale`.
 *   W2 REFUSALS      Each malformed form is refused with HTTP 400 on create AND on update, with a message that names the check, and the card is left exactly as it was (same version, same checks): both `ask` and
 *                    `compare`; `compare` that is not an object; a side that is not a SELECT (an ASK); a missing side; an operator outside `<` and `>`; no operator; no boolean `expect`.
 *   W3 THE ASK FORM IS UNCHANGED   A valid ASK check is accepted; a SELECT given as the `ask` is refused, as before.
 *
 * REAL REST servers on a document store; no executor. Synthetic content only.
 * NOT COVERED, by name: evaluation-time strictness (checks-compare-z1 owns it); the MCP tool's own argument schema (card_update's `checks` description does not yet name the compare form: that is a documentation
 * gap, not pinned here); authentication of the write; a compare whose SELECTs are valid SPARQL syntax but name nothing (an evaluation-time `error`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ROSTER_FILE = path.join(os.tmpdir(), `w1c-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const iso = (i) => new Date(Date.UTC(2026, 7, 1) + i * 60000).toISOString();
const card = (o) => ({ description: 'x', type: 'task', column: 'backlog', order: 0, assignees: [], labels: [], priority: null, version: 1, relationships: { relatedTo: [], blockedBy: [] }, updatedAt: iso(0), ...o });
const LEFT = `SELECT (MAX(<${XSD}dateTime>(?d)) AS ?v) WHERE { ?a2 schema:identifier "857" . ?c schema:isPartOf+ ?a2 ; schema:dateCreated ?d }`;
const RIGHT = `SELECT (MAX(<${XSD}dateTime>(?e)) AS ?v) WHERE { ?x a schema:CreativeWork ; schema:dateCreated ?e }`;
const GOOD = { claim: 'membership decays by growth', compare: { left: LEFT, op: '<', right: RIGHT }, expect: true };
const board = () => makeBoardFixture({ cards: [
  card({ id: 'w-apex', shortId: 857, title: 'apex', type: 'goal', createdAt: iso(0) }),
  card({ id: 'w-m1', shortId: 861, title: 'member', createdAt: iso(1), parent: 'w-apex' }),
  card({ id: 'w-n1', shortId: 862, title: 'newer, not a member', createdAt: iso(5) }),
], nextShortId: 2000 });
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const rowOf = (pass, claim) => (pass.body.results || []).flatMap((x) => x.checks).find((c) => c.claim === claim);
const start = (opts = {}) => startRestServer({ env: { SCRUM_ROSTER_FILE: ROSTER_FILE }, ...opts });

test('W1 ROUND TRIP: a compare written through the API is stored, read back unchanged, evaluated, still there after a kill and restart, and replaceable by an update', { timeout: 180000 }, async () => {
  const a = await start({ board: board() });
  let b = null;
  try {
    const made = await api(a.baseUrl, 'POST', '/api/cards', { title: 'watcher', description: 'x', createdBy: 'ada', checks: [GOOD] });
    assert.ok(made.status === 200 || made.status === 201, `the card is created with a compare check: ${made.status} ${made.text.slice(0, 300)}`);
    const id = made.body.id;
    const back = await api(a.baseUrl, 'GET', `/api/cards/${id}`);
    assert.deepEqual(back.body.checks?.[0]?.compare, GOOD.compare, `read back: the compare is stored unchanged: ${JSON.stringify(back.body.checks)?.slice(0, 300)}`);
    assert.equal(back.body.checks[0].expect, true);
    const p1 = await api(a.baseUrl, 'GET', '/api/checks?fresh=1');
    assert.equal(rowOf(p1, GOOD.claim)?.status, 'holds', `the pass evaluates it (a verdict, not an error): ${JSON.stringify(rowOf(p1, GOOD.claim))}`);
    a.kill();
    b = await start({ boardFile: a.boardFile });
    const again = await api(b.baseUrl, 'GET', `/api/cards/${id}`);
    assert.deepEqual(again.body.checks?.[0]?.compare, GOOD.compare, `after a kill and a restart on the same file the compare is still there, unchanged: ${JSON.stringify(again.body.checks)?.slice(0, 300)}`);
    const p2 = await api(b.baseUrl, 'GET', '/api/checks?fresh=1');
    assert.equal(rowOf(p2, GOOD.claim)?.status, 'holds', `and it still evaluates: ${JSON.stringify(rowOf(p2, GOOD.claim))}`);
    const upd = await api(b.baseUrl, 'PATCH', `/api/cards/${id}`, { checks: [{ ...GOOD, expect: false }], ifVersion: again.body.version, by: 'ada' });
    assert.equal(upd.status, 200, `the update is accepted: ${upd.status} ${upd.text.slice(0, 300)}`);
    const p3 = await api(b.baseUrl, 'GET', '/api/checks?fresh=1');
    assert.equal(rowOf(p3, GOOD.claim)?.status, 'stale', `the flipped expectation is evaluated: ${JSON.stringify(rowOf(p3, GOOD.claim))}`);
  } finally { try { await b?.stop(); } catch { /* gone */ } try { await a.stop(); } catch { /* gone */ } }
});

const BAD = [
  ['both ask and compare', { claim: 'bad both', ask: 'ASK { ?s ?p ?o }', compare: GOOD.compare, expect: true }],
  ['compare is a string, not an object', { claim: 'bad string', compare: 'left < right', expect: true }],
  ['a side is an ASK, not a SELECT', { claim: 'bad ask side', compare: { left: 'ASK { ?s ?p ?o }', op: '<', right: RIGHT }, expect: true }],
  ['a side is missing', { claim: 'bad missing side', compare: { left: LEFT, op: '<' }, expect: true }],
  ['an operator outside < and >', { claim: 'bad op', compare: { left: LEFT, op: '<=', right: RIGHT }, expect: true }],
  ['no operator', { claim: 'bad no op', compare: { left: LEFT, right: RIGHT }, expect: true }],
  ['no boolean expect', { claim: 'bad expect', compare: GOOD.compare }],
];
test('W2 REFUSALS: every malformed compare is a 400 that names the check, on create and on update, and leaves the card exactly as it was', { timeout: 180000 }, async () => {
  const s = await start({ board: board() });
  try {
    const made = await api(s.baseUrl, 'POST', '/api/cards', { title: 'subject', description: 'x', createdBy: 'ada', checks: [GOOD] });
    assert.ok(made.status === 200 || made.status === 201, `CONTROL: a good compare is accepted: ${made.status} ${made.text.slice(0, 200)}`);
    const id = made.body.id;
    const before = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    for (const [name, check] of BAD) {
      const c = await api(s.baseUrl, 'POST', '/api/cards', { title: `bad ${name}`, description: 'x', createdBy: 'ada', checks: [check] });
      assert.equal(c.status, 400, `CREATE refuses "${name}": ${c.status} ${c.text.slice(0, 200)}`);
      assert.ok(String(c.body?.error || c.text).includes(check.claim), `and the message names the check "${check.claim}": ${c.text.slice(0, 200)}`);
      const u = await api(s.baseUrl, 'PATCH', `/api/cards/${id}`, { checks: [check], ifVersion: before.body.version, by: 'ada' });
      assert.equal(u.status, 400, `UPDATE refuses "${name}": ${u.status} ${u.text.slice(0, 200)}`);
      const after = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
      assert.equal(after.body.version, before.body.version, `the refused update changed nothing (version ${before.body.version} -> ${after.body.version})`);
      assert.deepEqual(after.body.checks, before.body.checks, 'and the checks are exactly as they were');
    }
  } finally { await s.stop(); }
});

test('W3 THE ASK FORM IS UNCHANGED: a valid ASK check is accepted and a SELECT given as the ask is refused', { timeout: 120000 }, async () => {
  const s = await start({ board: board() });
  try {
    const ok = await api(s.baseUrl, 'POST', '/api/cards', { title: 'ask form', description: 'x', createdBy: 'ada', checks: [{ claim: 'plain ask', ask: 'ASK { ?c schema:identifier "857" }', expect: true }] });
    assert.ok(ok.status === 200 || ok.status === 201, `a valid ASK is accepted: ${ok.status} ${ok.text.slice(0, 200)}`);
    const bad = await api(s.baseUrl, 'POST', '/api/cards', { title: 'select as ask', description: 'x', createdBy: 'ada', checks: [{ claim: 'select as ask', ask: 'SELECT ?s WHERE { ?s ?p ?o }', expect: true }] });
    assert.equal(bad.status, 400, `a SELECT given as the ask is refused, as before: ${bad.status} ${bad.text.slice(0, 200)}`);
  } finally { await s.stop(); }
});
