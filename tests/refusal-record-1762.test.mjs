// #1762 S2 — the builder's rows for the content-free refusal record (contract on #1762, "S2 CONTRACT"). Pure: no server,
// no executor. G1: every literal error code in the server and core is in the registry, so a new code is registered on
// purpose and is never silently stored as `unlisted`. G2: the compiler refuses prose in every field a caller sets, even a
// caller that skips core/refusal-record.mjs. G3: the route template carries no path segment a caller chose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../core/graph-compiler.mjs';
import { REFUSAL_CODES, refusalIntention, refusalSeat, routeTemplate, UNLISTED } from '../core/refusal-record.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = 'https://scrumboard.local/person/board';
const base = () => refusalIntention({ actor: BOARD, route: 'POST /api/cards/:p/claim', status: 409, code: 'WRITE_CONFLICT', rule: null,
  entityKind: 'card', entityId: '17', requestId: 'req-00000001', seat: refusalSeat({ authSeat: 'ada' }) });

test('#1762 G1 every literal error code in the server and core is a registered refusal code', () => {
  const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'core')).filter((f) => f.endsWith('.mjs')).map((f) => `core/${f}`)];
  const found = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\bcode: '([A-Z][A-Z0-9_]+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/export const [A-Z_]+ = '([A-Z][A-Z0-9_]*_[A-Z0-9_]+)';/g)) if (/(BUSY|REFUSED|UNAVAILABLE|CONFLICT|INVALID)$/.test(m[1])) found.add(m[1]);
  }
  assert.ok(found.size > 50, `PRECONDITION: the scan finds the codes (${found.size})`);
  const missing = [...found].filter((c) => !REFUSAL_CODES.has(c)).sort();
  assert.deepEqual(missing, [], `register these in core/refusal-record.mjs REFUSAL_CODES: ${missing.join(' ')}`);
});

test('#1762 G2 the compiler refuses prose in every caller-set field; an unregistered code is stored as unlisted', () => {
  assert.doesNotThrow(() => compile(base()), 'CONTROL: the shaped record compiles');
  const prose = 'the card is held by someone else';
  for (const k of ['route', 'code', 'rule', 'entityKind', 'entityId', 'requestId']) {
    const i = base();
    assert.throws(() => compile({ ...i, refusal: { ...i.refusal, [k]: prose } }), /not an allowlisted shape|opId/, `${k} refuses prose`);
  }
  const i = base();
  for (const extra of ['error', 'message', 'body', 'request', 'response']) {
    assert.throws(() => compile({ ...i, refusal: { ...i.refusal, [extra]: 'x' } }), /unknown field/, `no ${extra} field exists`);
  }
  assert.equal(refusalIntention({ actor: BOARD, route: 'unmatched', status: 400, code: 'NOT_A_REAL_CODE_X' }).refusal.code, UNLISTED);
  assert.equal(refusalIntention({ actor: BOARD, route: 'unmatched', status: 400, rule: 'some other rail' }).refusal.rule, UNLISTED);
  const sp = compile(base()).sparql;
  assert.ok(!/held by/.test(sp), 'CONTROL: no prose reaches the update');
});

test('#1762 G3 the route is the router\'s TEMPLATE: a raw path segment never survives', () => {
  assert.equal(routeTemplate('POST', 'POST ^\\/api\\/cards\\/([^\\/]+)\\/claim$'), 'POST /api/cards/:p/claim');
  assert.equal(routeTemplate('POST', 'POST ^\\/api\\/conversations$'), 'POST /api/conversations');
  assert.equal(routeTemplate('POST', undefined), 'unmatched', 'no matched route (a 404) is unmatched, never the raw path');
  assert.equal(routeTemplate('POST', 'POST ^\\/api\\/x\\/(.*)$'), 'unmatched', 'a template the shape cannot state is unmatched');
});

test('#1762 G4 the seat: authenticated first, a declared ROSTER seat second, otherwise unknown; the opId follows the requestId', () => {
  const roster = new Set(['ada']);
  assert.equal(refusalSeat({ authSeat: 'bo', declared: 'ada', rosterKeys: roster }), 'https://scrumboard.local/person/bo');
  assert.equal(refusalSeat({ declared: 'ada', rosterKeys: roster }), 'https://scrumboard.local/person/ada');
  assert.equal(refusalSeat({ declared: 'mallory', rosterKeys: roster }), 'https://scrumboard.local/ns#unknown');
  assert.equal(refusalSeat({ declared: 'Not A Seat', rosterKeys: new Set(['Not A Seat']) }), 'https://scrumboard.local/ns#unknown');
  assert.equal(base().opId, 'urn:ex:op/refused/req-00000001');
  const a = refusalIntention({ actor: BOARD, route: 'unmatched', status: 400 }), b = refusalIntention({ actor: BOARD, route: 'unmatched', status: 400 });
  assert.notEqual(a.opId, b.opId, 'without a requestId each refusal is its own record');
});
