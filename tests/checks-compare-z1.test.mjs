/**
 * THE `compare` TRIPWIRE FORM (#1610; the room's rulings 03:53-03:56Z: split #900's slow join into two cheap SELECTs and compare them in application code; keep the form NARROW; no JavaScript coercion;
 * dateTime compared as INSTANTS, never as strings; "absent apex -> error" is an intentional behaviour change, not equivalence with the ASK). Written by the separate test author, before the build.
 *
 * THE FORM (what the rows pin, nothing broader): a card tripwire `{ claim, compare: { left: <SELECT>, op: '<' | '>', right: <SELECT> }, expect: <boolean> }`. Each side is a SELECT with exactly ONE row and
 * exactly ONE variable, whose value is an `xsd:dateTime` literal; the two are compared as instants; `expect` is matched against the boolean result exactly as it is for an ASK. The result row has the ASK
 * row's shape: `{claim, status: 'holds' | 'stale' | 'error', expected, actual, ms}` (and `error` text when status is `error`).
 *
 * CONSTRAINTS I AM PROPOSING, for the contract owner to accept or change BEFORE the build (the rows follow whatever is ruled; a number I can move is a number I name):
 *   - an `xsd:dateTime` must carry an EXPLICIT timezone (`Z` or `+hh:mm`): a value without one is ambiguous and is an `error`, never "assumed UTC";
 *   - precision is MILLISECONDS: more than three fractional-second digits is an `error`, because a Date would silently round it;
 *   - only the types and operators #900 needs: dateTime and `<`, `>`; anything else (a string, an integer, `<=`, `=`) is an `error`.
 *
 *   Z1 EQUIVALENCE  #900's two halves, each CAST to xsd:dateTime in its own text, as a compare, beside #900's own ASK on the same board, three controls; and the SAME halves with no cast are an ERROR (the board projects
 *                   its dates as xsd:string; the evaluator refuses a string that merely looks like a timestamp). As-is: both HOLD. Flipped (the newest card is a member): both STALE. Apex ABSENT: the ASK is
 *                   STALE (false) and the compare is an ERROR (an unbound side): the intentional difference, pinned both ways.
 *   Z2 STRICTNESS   One table of cases, evaluated in ONE pass, with the POSITIVE cases asserted first (so on a build without the form the row fails at a positive control, not by passing every "error" case for
 *                   the wrong reason). Positives: `<` true, `>` true, instants across offsets (+01:00 vs Z, where a lexical compare gives the opposite answer), equal instants (neither `<` nor `>`). Errors: zero
 *                   rows, two rows, an unbound value, two columns, a dateTime against a string, two strings, two strings SPELLED like dateTimes, an xsd:string literal spelled like one, an integer pair, `<=`, `=`,
 *                   an invalid dateTime (each field's range ON ITS OWN: month 13 with a valid day, hour 25, minute 61, second 61: added after a kill check showed the range check could be dropped unnoticed), IMPOSSIBLE CALENDAR DATES (Feb 30, Feb 29 in a common year, April 31; plus a real leap day as a positive so the check is not just over-rejecting), an offset out of range, no
 *                   timezone, more than three fractional digits. The datatype is the contract: the replica's `queryGraph` flattens a term to its value (graph-replica.mjs:2569), so a build has to read the raw store term.
 *                   Every error case yields status `error` with a non-empty `error`, and does NOT stop the pass: a plain ASK check beside them still HOLDS.
 *   Z3 PASS FRESHNESS  Two forced passes in a row: each is `servedFrom: fresh`, `passes` rises by exactly one each time and `evaluatedAt` moves forward. (Guard: a containment that serves a forced pass from a cache
 *                   would break #1404's rule that the clock-driven checks are never stale.)
 *   Z4 COST         A board of 3,000 cards where #900's real ASK is heavy (the engine's join of two aggregates through a property path: 3.4 to 4.6 s in my measurements, 7.4 to 7.6 s on the live board). The
 *                   ASK-form pass is the SEMANTIC ORACLE only (no minimum duration is asserted on it; a floor is unstable across machines, the contract owner ruled at 04:12Z). The same board with #900 authored as a compare: the check holds with the SAME verdict, costs under 500 ms, the whole pass is under 3,000 ms, and `/api/health`, probed every 100 ms
 *                   throughout, never takes over 1,000 ms (REST's main thread is not frozen by it).
 *
 * REAL REST servers, no executor needed (the checks run on the in-process replica). Synthetic content only.
 * NOT COVERED, by name: the write path (whether a malformed `compare` is refused when a card is written or only fails when evaluated: these rows load it as data and pin the EVALUATION); caching or backoff of any check
 * (a separate option; Z3 only guards against silent staleness); `fresh=standing`; the other slow tripwires (#901, #902) and any authored check that is still a heavy ASK; the live store's data distribution (the
 * 3,000-card board reproduces the quirk's shape (the ASK took 3.4 to 4.6 s here at 3,000 cards); the 500 ms, 3,000 ms and 1,000 ms bounds are this CONTROLLED FIXTURE's acceptance criteria, not promises about every live pass); REST's other main-thread work (replica syncs, #1443).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const iso = (i) => new Date(Date.UTC(2026, 7, 1) + i * 60000).toISOString();
const card = (o) => ({ description: 'x', type: 'task', column: 'backlog', order: 0, assignees: [], labels: [], priority: null, version: 1, relationships: { relatedTo: [], blockedBy: [] }, updatedAt: iso(0), ...o });
const ASK_900 = 'ASK { ?a schema:identifier "857" . { SELECT (MAX(?d) AS ?newestMember) WHERE { ?a2 schema:identifier "857" . ?c schema:isPartOf+ ?a2 ; schema:dateCreated ?d } } { SELECT (MAX(?e) AS ?newestCard) WHERE { ?x a schema:CreativeWork ; schema:dateCreated ?e } } FILTER(?newestMember < ?newestCard) }';
// The board projects `schema:dateCreated` as xsd:string (measured by the builder on the live copy), so #900's halves STATE the type with an explicit cast, as the contract owner ruled at 04:12Z:
const LEFT_900 = `SELECT (MAX(<${XSD}dateTime>(?d)) AS ?v) WHERE { ?a2 schema:identifier "857" . ?c schema:isPartOf+ ?a2 ; schema:dateCreated ?d }`;
const RIGHT_900 = `SELECT (MAX(<${XSD}dateTime>(?e)) AS ?v) WHERE { ?x a schema:CreativeWork ; schema:dateCreated ?e }`;
const COMPARE_900 = { left: LEFT_900, op: '<', right: RIGHT_900 };
// The same halves WITHOUT the cast: the strings the board projects. The evaluator must refuse them (dateTime only), not accept them because they look like timestamps.
const LEFT_UNCAST = 'SELECT (MAX(?d) AS ?v) WHERE { ?a2 schema:identifier "857" . ?c schema:isPartOf+ ?a2 ; schema:dateCreated ?d }';
const RIGHT_UNCAST = 'SELECT (MAX(?e) AS ?v) WHERE { ?x a schema:CreativeWork ; schema:dateCreated ?e }';

async function pass(board, { probe = false } = {}) {
  const srv = await startRestServer({ board, env: {} });
  try {
    const base = srv.baseUrl; const lat = []; let stop = false;
    const prober = probe ? (async () => { while (!stop) { const t = Date.now(); try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(60000) }); } catch { /* counted by its latency */ } lat.push(Date.now() - t); await new Promise((r) => setTimeout(r, 100)); } })() : null;
    const t0 = Date.now(); const res = await fetch(`${base}/api/checks?fresh=1`, { signal: AbortSignal.timeout(120000) }); const json = await res.json(); const wall = Date.now() - t0;
    stop = true; await prober;
    const rows = Object.fromEntries((json.results || []).flatMap((x) => x.checks).map((c) => [c.claim, c]));
    return { status: res.status, json, rows, wall, healthMax: lat.length ? Math.max(...lat) : null, probes: lat.length };
  } finally { try { await srv.stop(); } catch { /* gone */ } }
}
const small = ({ flipped = false, apexAbsent = false, watcherChecks }) => {
  const apex = card({ id: 'z-apex', shortId: 857, title: 'apex', type: 'goal', createdAt: iso(0) });
  const members = [1, 2, 3].map((i) => card({ id: `z-m${i}`, shortId: 860 + i, title: `member ${i}`, createdAt: iso(i), parent: 'z-apex' }));
  const others = [4, 5].map((i) => card({ id: `z-n${i}`, shortId: 860 + i, title: `other ${i}`, createdAt: iso(i) }));
  const newest = flipped ? [card({ id: 'z-m6', shortId: 866, title: 'newest member', createdAt: iso(6), parent: 'z-apex' })] : [];
  const watcher = card({ id: 'z-w', shortId: 900, title: 'watcher', createdAt: iso(0), checks: watcherChecks });
  return makeBoardFixture({ cards: [...(apexAbsent ? [] : [apex]), ...members, ...others, ...newest, watcher], nextShortId: 2000 });
};

test('Z1 EQUIVALENCE: #900 as a compare agrees with its ASK as-is (holds) and flipped (stale), and differs on purpose when the apex is absent (ASK stale, compare error)', { timeout: 120000 }, async () => {
  const checks = [{ claim: 'ASK form', ask: ASK_900, expect: true }, { claim: 'compare form', compare: COMPARE_900, expect: true }, { claim: 'compare form, uncast', compare: { left: LEFT_UNCAST, op: '<', right: RIGHT_UNCAST }, expect: true }];
  const asIs = await pass(small({ watcherChecks: checks }));
  assert.equal(asIs.status, 200);
  assert.equal(asIs.rows['ASK form']?.status, 'holds', `CONTROL: the ASK holds as-is: ${JSON.stringify(asIs.rows['ASK form'])}`);
  assert.equal(asIs.rows['compare form']?.status, 'holds', `the compare holds as-is: ${JSON.stringify(asIs.rows['compare form'])}`);
  assert.equal(asIs.rows['compare form']?.actual, true);
  assert.equal(asIs.rows['compare form, uncast']?.status, 'error', `the SAME halves without the cast return the board's xsd:string values and are REFUSED, not accepted because they look like timestamps: ${JSON.stringify(asIs.rows['compare form, uncast'])}`);
  assert.ok(String(asIs.rows['compare form, uncast']?.error || '').length > 0, 'and it says why');
  const flipped = await pass(small({ flipped: true, watcherChecks: checks }));
  assert.equal(flipped.rows['ASK form']?.status, 'stale', `CONTROL: the ASK is stale when the newest card is a member: ${JSON.stringify(flipped.rows['ASK form'])}`);
  assert.equal(flipped.rows['compare form']?.status, 'stale', `the compare is stale too: ${JSON.stringify(flipped.rows['compare form'])}`);
  assert.equal(flipped.rows['compare form']?.actual, false);
  const absent = await pass(small({ apexAbsent: true, watcherChecks: checks }));
  assert.equal(absent.rows['ASK form']?.status, 'stale', `CONTROL: with no apex the ASK says false (stale): ${JSON.stringify(absent.rows['ASK form'])}`);
  assert.equal(absent.rows['compare form']?.status, 'error', `with no apex the compare is an ERROR (an unbound side), by decision, not false: ${JSON.stringify(absent.rows['compare form'])}`);
  assert.ok(String(absent.rows['compare form']?.error || '').length > 0, 'and it says why');
});

// ---- Z2: the strictness table. Each side is a SELECT over VALUES, so no board data is needed.
const dt = (s) => `"${s}"^^<${XSD}dateTime>`;
const one = (lit) => `SELECT (?x AS ?v) WHERE { VALUES ?x { ${lit} } }`;
const sel = (op, l, r, expect) => ({ compare: { left: one(l), op, right: one(r) }, expect });
const CASES = [
  // [name, check, expected status]
  ['ok <', sel('<', dt('2026-01-01T00:00:00Z'), dt('2026-01-02T00:00:00Z'), true), 'holds'],
  ['ok >', sel('>', dt('2026-01-02T00:00:00Z'), dt('2026-01-01T00:00:00Z'), true), 'holds'],
  ['instants across offsets: 01:00+01:00 is BEFORE 00:30Z (a lexical compare says after)', sel('<', dt('2026-01-01T01:00:00+01:00'), dt('2026-01-01T00:30:00Z'), true), 'holds'],
  ['a real leap day (2028-02-29) is accepted', sel('<', dt('2028-02-29T00:00:00Z'), dt('2028-03-01T00:00:00Z'), true), 'holds'],
  ['equal instants are not <', sel('<', dt('2026-01-01T01:00:00+01:00'), dt('2026-01-01T00:00:00Z'), false), 'holds'],
  ['equal instants are not >', sel('>', dt('2026-01-01T01:00:00+01:00'), dt('2026-01-01T00:00:00Z'), false), 'holds'],
  ['zero rows', { compare: { left: 'SELECT ?v WHERE { VALUES ?v { } }', op: '<', right: one(dt('2026-01-02T00:00:00Z')) }, expect: true }, 'error'],
  ['two rows', { compare: { left: `SELECT ?v WHERE { VALUES ?v { ${dt('2026-01-01T00:00:00Z')} ${dt('2026-01-03T00:00:00Z')} } }`, op: '<', right: one(dt('2026-01-02T00:00:00Z')) }, expect: true }, 'error'],
  ['unbound value (MAX over nothing)', { compare: { left: 'SELECT (MAX(?d) AS ?v) WHERE { ?q <urn:z:nothing> ?d }', op: '<', right: one(dt('2026-01-02T00:00:00Z')) }, expect: true }, 'error'],
  ['two columns on a side', { compare: { left: `SELECT ?v ?w WHERE { VALUES (?v ?w) { (${dt('2026-01-01T00:00:00Z')} 1) } }`, op: '<', right: one(dt('2026-01-02T00:00:00Z')) }, expect: true }, 'error'],
  ['a dateTime against a plain string', sel('<', dt('2026-01-01T00:00:00Z'), '"2026-01-02T00:00:00Z"', true), 'error'],
  ['two plain strings', sel('<', '"2026-01-01"', '"2026-01-02"', true), 'error'],
  ['two plain strings SPELLED EXACTLY LIKE dateTimes (the datatype is the contract, not the syntax)', sel('<', '"2026-01-01T00:00:00Z"', '"2026-01-02T00:00:00Z"', true), 'error'],
  ['an xsd:string-typed literal spelled like a dateTime', sel('<', `"2026-01-01T00:00:00Z"^^<${XSD}string>`, dt('2026-01-02T00:00:00Z'), true), 'error'],
  ['an impossible calendar date, Feb 30 (a Date would roll it to Mar 2)', sel('<', dt('2026-02-30T00:00:00Z'), dt('2026-03-05T00:00:00Z'), true), 'error'],
  ['Feb 29 in a year that is not a leap year', sel('<', dt('2026-02-29T12:00:00Z'), dt('2026-03-05T00:00:00Z'), true), 'error'],
  ['April 31', sel('<', dt('2026-04-31T00:00:00Z'), dt('2026-05-05T00:00:00Z'), true), 'error'],
  ['month 13 with a perfectly valid day (the month range, on its own)', sel('<', dt('2026-13-01T00:00:00Z'), dt('2027-02-01T00:00:00Z'), true), 'error'],
  ['hour 25 (the hour range, on its own)', sel('<', dt('2026-01-01T25:00:00Z'), dt('2026-01-03T00:00:00Z'), true), 'error'],
  ['minute 61 (the minute range, on its own)', sel('<', dt('2026-01-01T00:61:00Z'), dt('2026-01-03T00:00:00Z'), true), 'error'],
  ['second 61 (the second range, on its own)', sel('<', dt('2026-01-01T00:00:61Z'), dt('2026-01-03T00:00:00Z'), true), 'error'],
  ['an offset out of range (+25:00)', sel('<', dt('2026-01-01T00:00:00+25:00'), dt('2026-01-02T00:00:00Z'), true), 'error'],
  ['an integer pair', sel('<', `"1"^^<${XSD}integer>`, `"2"^^<${XSD}integer>`, true), 'error'],
  ['operator <= is not supported', sel('<=', dt('2026-01-01T00:00:00Z'), dt('2026-01-02T00:00:00Z'), true), 'error'],
  ['operator = is not supported', sel('=', dt('2026-01-01T00:00:00Z'), dt('2026-01-01T00:00:00Z'), true), 'error'],
  ['an invalid dateTime (month 13)', sel('<', dt('2026-13-45T25:61:00Z'), dt('2026-01-02T00:00:00Z'), true), 'error'],
  ['no timezone', sel('<', dt('2026-01-01T00:00:00'), dt('2026-01-02T00:00:00Z'), true), 'error'],
  ['more than three fractional digits', sel('<', dt('2026-01-01T00:00:00.1234567Z'), dt('2026-01-02T00:00:00Z'), true), 'error'],
];
test('Z2 STRICTNESS: the positives hold, every unsupported or malformed case is an error with a reason, and none of them stops the pass', { timeout: 120000 }, async () => {
  const checks = [{ claim: 'plain ASK beside them', ask: 'ASK { ?c schema:identifier "857" }', expect: true }, ...CASES.map(([name, c]) => ({ claim: `case: ${name}`, ...c }))];
  const r = await pass(small({ watcherChecks: checks }));
  assert.equal(r.status, 200, 'the pass answers');
  const get = (name) => r.rows[`case: ${name}`];
  for (const [name, , want] of CASES.filter((c) => c[2] === 'holds')) assert.equal(get(name)?.status, 'holds', `POSITIVE CASE "${name}": ${JSON.stringify(get(name))}`);
  for (const [name, , want] of CASES.filter((c) => c[2] === 'error')) {
    const row = get(name);
    assert.equal(row?.status, 'error', `ERROR CASE "${name}" must be an error, never coerced: ${JSON.stringify(row)}`);
    assert.ok(String(row?.error || '').length > 0, `and say why: "${name}"`);
  }
  assert.equal(r.rows['plain ASK beside them']?.status, 'holds', 'a plain ASK beside the bad ones is still evaluated and holds');
});

test('Z3 PASS FRESHNESS: two forced passes in a row are each served fresh, `passes` rises by one each time and `evaluatedAt` moves forward', { timeout: 120000 }, async () => {
  const srv = await startRestServer({ board: small({ watcherChecks: [{ claim: 'compare form', compare: COMPARE_900, expect: true }] }), env: {} });
  try {
    const get = async () => (await fetch(`${srv.baseUrl}/api/checks?fresh=1`)).json();
    const a = await get(); await new Promise((r) => setTimeout(r, 50)); const b = await get();
    assert.equal(a.servedFrom, 'fresh'); assert.equal(b.servedFrom, 'fresh', 'the second forced pass is evaluated, not served from a cache');
    assert.equal(b.passes, a.passes + 1, `passes rises by exactly one (${a.passes} -> ${b.passes})`);
    assert.ok(Date.parse(b.evaluatedAt) > Date.parse(a.evaluatedAt), 'and evaluatedAt moved forward');
  } finally { await srv.stop(); }
});

function heavy(compareForm) {
  const N = 3000; const cards = [card({ id: 'h-apex', shortId: 857, title: 'apex', type: 'goal', createdAt: iso(0) })];
  for (let i = 1; i <= N; i++) {
    const member = i <= Math.floor(N * 0.7);
    cards.push(card({ id: `h-c-${i}`, shortId: 1000 + i, title: `card ${i}`, createdAt: iso(i), order: i, ...(member ? { parent: i % 4 === 1 ? 'h-apex' : `h-c-${i - 1}` } : {}) }));
  }
  cards.push(card({ id: 'h-w', shortId: 900, title: 'watcher', createdAt: iso(0), checks: [compareForm ? { claim: 'membership decays', compare: COMPARE_900, expect: true } : { claim: 'membership decays', ask: ASK_900, expect: true }] }));
  return makeBoardFixture({ cards, nextShortId: 9000 });
}
test('Z4 COST: on a board where #900 as an ASK is heavy, the same check as a compare holds with the same verdict in under 500 ms and REST is never frozen over 1 s', { timeout: 240000 }, async () => {
  const asAsk = await pass(heavy(false));
  const ask = asAsk.rows['membership decays'];
  assert.equal(ask?.status, 'holds', `CONTROL: the ASK holds on the heavy board: ${JSON.stringify(ask)}`);
  // (No minimum duration is asserted on the old ASK: its blocking cost is measured elsewhere, and a duration floor is unstable across machines. It stays here as the SEMANTIC ORACLE, and its cost is printed in the messages.)
  const asCompare = await pass(heavy(true), { probe: true });
  const cmp = asCompare.rows['membership decays'];
  assert.equal(cmp?.status, 'holds', `the compare holds on the heavy board: ${JSON.stringify(cmp)}`);
  assert.equal(cmp.actual, ask.actual, 'with the SAME verdict as the ASK');
  assert.ok(cmp.ms < 500, `and costs ${cmp.ms} ms (the ASK cost ${ask.ms} ms)`);
  assert.ok(asCompare.json.evaluationMs < 3000, `the whole pass takes ${asCompare.json.evaluationMs} ms`);
  assert.ok(asCompare.healthMax <= 1000, `REST was not frozen: /api/health took at most ${asCompare.healthMax} ms over ${asCompare.probes} probes (the ASK form took ${ask.ms} ms on this board)`);
});
