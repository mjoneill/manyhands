// #1762 S2 — the builder's rows for the refusal record (contract on #1762, "S2 CONTRACT v2.2"). Pure: no server, no
// executor. G1/G5: the code registry and the route-template table are CLOSED and kept equal to the source. G2: a direct
// compile that skips the builder cannot store an unregistered value. G3: templates and actions. G4: scoped identity.
// G6: the audit meter and its in-flight bound. requestId, entityId and the adapter label are bounded retained-data
// exceptions (v2.2), not proof that no client string survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../core/graph-compiler.mjs';
import { REFUSAL_CODES, ROUTE_TEMPLATES, REFUSAL_AUDIT_TOKEN, createRefusalAuditMeter, refusalIntention, refusalSeat, refusedActionOf, routeTemplate, UNLISTED } from '../core/refusal-record.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = 'https://scrumboard.local/person/board';
const base = () => refusalIntention({ actor: BOARD, route: 'POST /api/cards/:p/claim', status: 409, code: 'WRITE_CONFLICT', rule: '#755 work gate',
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

test('#1762 G2 a direct refusal.record (skipping the builder) cannot store an unregistered code, rule, route or action', () => {
  assert.doesNotThrow(() => compile(base()), 'CONTROL: the registered record compiles');
  const i = base();
  for (const [k, v] of [['code', 'NOT_A_REGISTERED_CODE'], ['rule', '#999 arbitrary prose'], ['route', 'mcp arbitrary_tool_name'],
    ['route', 'POST /api/secret-words'], ['refusedAction', 'move'], ['entityId', 'a.b'], ['entityId', 'a'.repeat(65)]]) {
    assert.throws(() => compile({ ...i, refusal: { ...i.refusal, [k]: v } }), /registry|id shape|names|opId/, `${k}=${v} is refused`);
  }
  for (const extra of ['error', 'message', 'body', 'request', 'response']) {
    assert.throws(() => compile({ ...i, refusal: { ...i.refusal, [extra]: 'x' } }), /unknown field/, `no ${extra} field exists`);
  }
  assert.doesNotThrow(() => compile({ ...i, refusal: { ...i.refusal, entityId: 'a'.repeat(64) } }), 'CONTROL: 64 is inside the id shape');
  const u = refusalIntention({ actor: BOARD, route: 'POST /api/cards', status: 400, code: 'NOT_A_REAL_CODE_X', rule: 'some other rail', seat: refusalSeat({}) });
  assert.equal(u.refusal.code, UNLISTED); assert.equal(u.refusal.rule, UNLISTED);
  assert.match(compile(u).sparql, /<https:\/\/scrumboard\.local\/ns#unlisted>/, 'unlisted is the IRI scrum:unlisted');
  const none = refusalIntention({ actor: BOARD, route: 'POST /api/cards/:p/claim', status: 409, seat: refusalSeat({}) });
  assert.equal(none.refusal.code, null, 'NO code is absent, not unlisted');
  assert.ok(!/ns#code>/.test(compile(none).sparql), 'and no scrum:code triple is written');
});

test('#1762 G3 the route is a TEMPLATE from the closed table: a raw path segment never survives; the action follows it', () => {
  assert.equal(routeTemplate('POST', 'POST ^\\/api\\/cards\\/([^\\/]+)\\/claim$'), 'POST /api/cards/:p/claim');
  assert.equal(routeTemplate('POST', 'POST ^\\/api\\/conversations$'), 'POST /api/conversations');
  assert.equal(routeTemplate('POST', undefined), UNLISTED, 'no matched route (a 404) is unlisted, never the raw path');
  assert.equal(routeTemplate('POST', 'POST ^\\/api\\/x\\/(.*)$'), UNLISTED, 'a template outside the table is unlisted');
  assert.equal(refusedActionOf('POST /api/cards/:p/claim'), 'claim');
  assert.equal(refusedActionOf('PATCH /api/cards/:p'), 'update');
  assert.equal(refusedActionOf('POST /api/cards'), 'create');
  assert.equal(refusedActionOf('mcp card-targeting gate'), 'card-targeting');
  assert.equal(refusedActionOf(UNLISTED), UNLISTED);
});

test('#1762 G4 identity is scoped to (seat, route, requestId): another seat or route is another record; no requestId is fresh', () => {
  const roster = new Set(['ada']);
  assert.equal(refusalSeat({ authSeat: 'bo', declared: 'ada', rosterKeys: roster }), 'https://scrumboard.local/person/bo');
  assert.equal(refusalSeat({ declared: 'ada', rosterKeys: roster }), 'https://scrumboard.local/person/ada');
  assert.equal(refusalSeat({ declared: 'mallory', rosterKeys: roster }), 'https://scrumboard.local/ns#unknown');
  const mk = (seat, route) => refusalIntention({ actor: BOARD, route, status: 409, requestId: 'req-00000001', seat });
  const a = mk(refusalSeat({ authSeat: 'ada' }), 'POST /api/cards/:p/claim');
  assert.equal(a.opId, mk(refusalSeat({ authSeat: 'ada' }), 'POST /api/cards/:p/claim').opId, 'an identical retry is the same op');
  assert.notEqual(a.opId, mk(refusalSeat({ authSeat: 'bo' }), 'POST /api/cards/:p/claim').opId, 'another seat is another record');
  assert.notEqual(a.opId, mk(refusalSeat({ authSeat: 'ada' }), 'POST /api/cards').opId, 'another route is another record');
  assert.throws(() => compile({ ...a, refusal: { ...a.refusal, associatedWith: 'https://scrumboard.local/person/bo' } }), /opId/, 'the compiler re-derives the scope');
  const f1 = refusalIntention({ actor: BOARD, route: UNLISTED, status: 400, seat: refusalSeat({}) }), f2 = refusalIntention({ actor: BOARD, route: UNLISTED, status: 400, seat: refusalSeat({}) });
  assert.notEqual(f1.opId, f2.opId, 'without a requestId each refusal is its own record');
  assert.doesNotThrow(() => compile(f1));
});

test('#1762 G5 every write route in server.js is in the closed template table, and the table names no route that is gone', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const live = new Set();
  for (const m of src.matchAll(/\{ method: '(POST|PATCH|PUT|DELETE)',\s+re: \/(.+?)\/,\s+fn:/g)) {
    const t = routeTemplate(m[1], `${m[1]} ${m[2]}`);
    if (t === UNLISTED) {
      const raw = `${m[1]} ${m[2].replace(/^\^/, '').replace(/\$$/, '').replace(/\(\[\^\\?\/\]\+\)/g, ':p').replace(/\\\//g, '/')}`;
      assert.ok(!/^\S+ \/api(\/(?:[a-z0-9][a-z0-9-]*|:p))*$/.test(raw), `register ${raw} in core/refusal-record.mjs ROUTE_TEMPLATES`);
    } else live.add(t);
  }
  assert.ok(live.size > 50, `PRECONDITION: the scan finds the write routes (${live.size})`);
  const gone = [...ROUTE_TEMPLATES].filter((t) => !live.has(t));
  assert.deepEqual(gone, [], `remove routes that no longer exist: ${gone.join(', ')}`);
});

test('#1762 G6 the audit meter counts failures, keeps the first time, logs at most once a minute, and drops past the cap', async () => {
  let t = 1_000_000; const lines = [];
  const m = createRefusalAuditMeter({ log: (l) => lines.push(l), now: () => t, maxInFlight: 1 });
  assert.deepEqual(m.stats(), { count: 0, since: null });
  m.unavailable('x'); t += 1000; m.unavailable('y');
  assert.equal(m.stats().count, 2); assert.equal(m.stats().since, new Date(1_000_000).toISOString());
  assert.equal(lines.length, 1, 'one line within the minute'); assert.ok(lines[0].startsWith(REFUSAL_AUDIT_TOKEN));
  let release; const held = m.run(() => new Promise((r) => { release = r; }));
  assert.equal(await m.run(async () => true), false, 'a write past the cap is dropped');
  assert.equal(m.stats().count, 3, 'and counted');
  release(true); assert.equal(await held, true);
  assert.equal(await m.run(async () => true), true, 'CONTROL: under the cap a write runs');
});
