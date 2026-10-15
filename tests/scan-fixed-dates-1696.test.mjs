/**
 * #1696 — rows for the scan that looks for a fixed calendar date flowing, inside one test file, into something a real-clock process consumes. TEST AUTHOR's, written before the scanner.
 *
 * WHY: a fixed date is harmless when only pure functions see it, and a time bomb when it reaches a server or process that judges it against the real clock (the instance: a fixed
 * 2026-09-18 anchor gave credentials a fixed expiry that crossed a 72 h window at 2026-10-15T12:00Z). This scan is a LEXICAL GUARD, NOT A PROOF: it cannot follow a date computed at run time,
 * read from data, or defined in another file, and it says so in every report.
 *
 * THE CONTRACT (the builder may refine the wording, not these properties):
 *   node scripts/scan-fixed-dates-1696.mjs [--json] <file-or-directory>...
 *   exit 0  every file was read and nothing is flagged
 *   exit 1  something is flagged
 *   exit 2  it could not check: a file did not parse, a path is unreadable, no path was given, or no file was found (never a clean pass)
 *   --json  prints one JSON object: { guard, files, flagged: [{ file, line, statement, dateLiteral: { line, value }, dateLiterals: [{ line, value }], consumer: { line, name }, via: [names] }], unreadable: [{ file, error }] }
 *   text    one line per flagged site naming file:line of the date literal and file:line of the consumer call, the names between them, and the same `guard` sentence at the end.
 * A STATEMENT is a top-level statement of the file (each `test(...)` call, each top-level const or function). It is DATE-DERIVED if it contains a literal calendar date (an ISO `20xx-mm-dd` string) or
 * references a name that is; it reaches a CONSUMER if it calls one (startRestServer, startMcpServer, startExecutor, startExecutorOnCopy, spawn, spawnSync, execFile, fork, a browser launch) or references a
 * name that does. A statement that is both is FLAGGED.
 *
 *   S1  the pre-fix credentials file (kept as a .txt fixture): flags exactly its three served tests, naming the 2026-09-18 anchor (among every fixed date that reaches it) and a real-server start, and flags none of its pure rows or the script row
 *   S2  a planted fixed date into startRestServer: flagged, with the right lines; the pure row on the same anchor in the same file is not
 *   S3  the report: file:line for the date literal and for the consumer, the chain of names, and the "lexical guard, not a proof" sentence, in JSON and in text
 *   S4  relative times only (Date.now() arithmetic): not flagged
 *   S5  a fixed date that only a pure function sees: not flagged
 *   S6  THE LIMITS, pinned: a date read from data at run time is not flagged; a date defined in an imported helper is not flagged; the report says it cannot follow either
 *   S8  SHADOWING (control): a name bound locally in the served test (a const or a parameter) is NOT the top-level name of the same spelling, so no chain is made through it; the pure row that really uses the top-level name is still not flagged (nothing served)
 *   S9  INDIRECTION (control): a helper that holds a fixed date, reaching a real server only through two more helpers, is still found, with every name on the way; a served row that never touches the date is not
 *   S10 EVERY NAMED CONSUMER: a fixed date reaching each starter the header names (and a member-call form such as cp.spawn) is flagged with that consumer's name; nothing is trusted to the one case S1 happens to use
 *   S11 a calendar date that appears only in a test's TITLE is text, not data: not flagged
 *   S12 THE LIMIT, pinned: a date written as numbers (Date.UTC(2026, 8, 18), new Date(2026, 8, 18), an epoch literal) is NOT seen; the report's guard sentence says so
 *   S13 THE LIMIT, pinned: with the field list, a date set by assignment (card.expiresAt = WHEN) or under a computed key ({ ['expiresAt']: WHEN }) is NOT seen; the guard sentence says so
 *   S7  it never passes a check it could not make: an unparseable file, a missing path, no path, and an empty directory are all exit 2 with the reason
 *
 * NOT covered, by name: how many sites the scan flags on the real tests/ (a census, measured separately); whether it runs in the suite; an accepted-sites list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, '..', 'scripts', 'scan-fixed-dates-1696.mjs');
const FX = (n) => path.join(HERE, 'fixtures-1696', n);
const run = (...args) => spawnSync(process.execPath, [SCAN, ...args], { encoding: 'utf8', timeout: 60000 });
const json = (...paths) => { const r = run('--json', ...paths); let j = null; try { j = JSON.parse(r.stdout); } catch { /* reported by the caller's assertion */ } return { r, j }; };
const GUARD = /lexical guard, not a proof/i;
const titleOf = (f) => String(f.statement);

test('#1696 (S1) the pre-fix credentials file: exactly its three served tests are flagged, with the 2026-09-18 anchor and a real-server start; its pure rows and the script row are not', () => {
  const { r, j } = json(FX('prefix-credentials-1343.txt'));
  assert.ok(j, `PRECONDITION: the scan printed JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 1, 'something is flagged: exit 1');
  const titles = j.flagged.map(titleOf);
  assert.equal(j.flagged.length, 3, `exactly three statements are flagged: ${JSON.stringify(titles)}`);
  for (const prefix of ['#1343 served (observe)', '#1343 served (required)', '#1343 served (required, MCP)']) assert.ok(titles.some((t) => t.startsWith(prefix)), `${prefix} is flagged`);
  for (const f of j.flagged) {
    assert.ok(Array.isArray(f.dateLiterals) && f.dateLiterals.some((d) => d.line === 30 && /2026-09-18/.test(String(d.value))), `the dates reported include the NOW anchor on line 30: ${JSON.stringify(f.dateLiterals)}`);
    assert.match(f.consumer.name, /^(startRestServer|startMcpServer)$/, 'the consumer is a real server start');
    assert.ok(Array.isArray(f.via) && f.via.includes('tokensFile'), 'the chain runs through tokensFile');
  }
  for (const pure of ['#1343 format', '#1343 load', '#1343 resolve', '#1343 decision', '#1343 needFor', '#1343 assertActor', '#1343 credentialExpiryRows', '#1343 migrateCredentialsDoc', '#1343 readAuthMode', '#1343 redactSecrets', '#1343 scripts/credential.mjs', '#1343 SECRET_SHAPES']) {
    assert.ok(!titles.some((t) => t.startsWith(pure)), `${pure} is NOT flagged (it shares the anchor or the helper but has no real clock in reach, or no fixed date)`);
  }
});

test('#1696 (S2) a planted fixed date into startRestServer is flagged at the right lines, and the pure row on the same anchor in the same file is not', () => {
  const { r, j } = json(FX('planted-rest.txt'));
  assert.ok(j, `PRECONDITION: JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`); assert.equal(r.status, 1);
  assert.equal(j.flagged.length, 1, JSON.stringify(j.flagged.map(titleOf)));
  const f = j.flagged[0];
  assert.match(titleOf(f), /^planted: a fixed date reaches a real server/);
  assert.equal(f.dateLiteral.line, 5, 'the literal is on line 5'); assert.match(String(f.dateLiteral.value), /2026-08-01/);
  assert.equal(f.consumer.name, 'startRestServer'); assert.equal(f.consumer.line, 9);
  assert.ok(f.via.includes('WHEN') && f.via.includes('card'), `the chain names the anchor and the fixture helper: ${JSON.stringify(f.via)}`);
});

test('#1696 (S3) the report names file and line for the date and the consumer, the chain, and says plainly that it is a lexical guard and not a proof', () => {
  const { j } = json(FX('planted-rest.txt'));
  assert.ok(j && GUARD.test(String(j.guard)), `the JSON carries the guard sentence: ${j && j.guard}`);
  assert.ok(Number.isInteger(j.files) && j.files === 1, 'and how many files it read');
  const t = run(FX('planted-rest.txt'));
  assert.equal(t.status, 1);
  assert.match(t.stdout, /planted-rest\.txt:5\b/, 'text names file:line of the date literal'); assert.match(t.stdout, /planted-rest\.txt:9\b/, 'and of the consumer call');
  assert.match(t.stdout, /startRestServer/); assert.match(t.stdout, /WHEN/);
  assert.match(t.stdout, GUARD, 'and the last thing it says is that it is a guard, not a proof');
  assert.match(t.stdout, /computed at run time|read from data/i, 'naming what it cannot follow');
});

test('#1696 (S4) relative times only (Date.now() plus an offset) reaching a real server: not flagged, exit 0', () => {
  const { r, j } = json(FX('relative-only.txt'));
  assert.ok(j, `PRECONDITION: JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 0); assert.equal(j.flagged.length, 0); assert.equal(j.files, 1, 'and it did read the file');
});

test('#1696 (S5) a fixed date that only a pure function ever sees: not flagged, exit 0', () => {
  const { r, j } = json(FX('pure-date-only.txt'));
  assert.ok(j, `PRECONDITION: JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 0); assert.equal(j.flagged.length, 0); assert.equal(j.files, 1);
});

test('#1696 (S6) THE LIMITS, pinned: a date read from data at run time, and a date defined in an imported helper, are not flagged, and the report says it cannot follow them', () => {
  for (const name of ['computed-date.txt', 'imported-date.txt']) {
    const { r, j } = json(FX(name));
    assert.ok(j, `PRECONDITION (${name}): JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
    assert.equal(r.status, 0, `${name}: not flagged`); assert.equal(j.flagged.length, 0);
    assert.equal(j.files, 1);
  }
  const t = run(FX('computed-date.txt'), FX('imported-date.txt'));
  assert.match(t.stdout, /computed at run time/i, 'it states the first limit'); assert.match(t.stdout, /(another file|import)/i, 'and the second'); assert.match(t.stdout, GUARD);
});

test('#1696 (S7) it never passes a check it could not make: an unparseable file, a missing path, no path and an empty directory are all exit 2 with the reason', () => {
  const bad = json(FX('unreadable.txt'));
  assert.equal(bad.r.status, 2, `unparseable file: exit 2 (got ${bad.r.status}): ${bad.r.stderr.slice(0, 200)}`);
  assert.ok(bad.j && bad.j.unreadable.length === 1 && /unreadable\.txt$/.test(bad.j.unreadable[0].file), 'and the file is named'); assert.ok(bad.j.unreadable[0].error, 'with the parser\'s reason');
  assert.equal(bad.j.flagged.length, 0, 'it does not claim a flag it could not read');
  const missing = run('--json', path.join(HERE, 'fixtures-1696', 'no-such-file.txt'));
  assert.equal(missing.status, 2, 'a missing path: exit 2');
  const none = run('--json'); assert.equal(none.status, 2, 'no path at all: exit 2');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan1696-empty-'));
  try { const empty = run('--json', dir); assert.equal(empty.status, 2, 'an empty directory: exit 2, never "0 files, clean"'); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const mixed = run('--json', FX('planted-rest.txt'), FX('unreadable.txt'));
  assert.equal(mixed.status, 2, 'one flagged file and one unreadable file: exit 2 (it could not check everything), not 1');
});


// ---- THE NARROWING (PO ruling A, 2026-10-15): a curated list of fields the product compares with the clock, each with a source line; the scan then flags only a fixed date that reaches one of those fields ----
// Plain reachability flagged 891 sites in 164 files on the real tests/, mostly a fixed createdAt or updatedAt reaching a server that stores it and never compares it with now. With the list the prototype left 38.
//   node scripts/scan-fixed-dates-1696.mjs [--json] --fields scripts/windowed-fields-1696.json [--baseline <accepted.json>] <path>...
//   --fields    a JSON list { fields: [{ name, source: "path:line", why }] }. A statement is flagged only if it is date-derived, reaches a consumer, AND a fixed date is the value of a property named in the list.
//               JSON flagged entries then carry `field`. Fields NOT on the list are UNCOVERED, NOT SAFE, and every report says so and names the list.
//   --baseline  accepted sites { accepted: [{ file, statement, field, reason }] }, a reason each. A flagged site that matches an entry is reported as accepted (exit 0 if nothing else); an entry that matches
//               no site is STALE and fails (exit 1) so the list cannot rot; an entry without a reason, a malformed list or baseline, or an unreadable one is exit 2.
//   N1  a fixed date into createdAt reaching a server: flagged without the list, NOT flagged with it (so the narrowing is the list and nothing else)
//   N2  a fixed date into expiresAt reaching a server: flagged with the list, the field named, the pure row beside it not flagged
//   N3  the pre-fix credentials file with the list: still EXACTLY the three served tests, the NOW anchor on line 30 still on their chain, the pure rows still unflagged (the controls the reviewer asked to keep)
//   N4  the report says unlisted fields are uncovered, not safe, and names the list; the JSON carries the field names it covered
//   N5  the committed list: each entry has a name, a `path:line` source and a reason; the cited file exists; the cited line (give or take three) names the field AND a clock expression; the name appears in non-test code.
//       This is a LEXICAL check that the citation still points at a comparison; it cannot verify the comparison's meaning, and says so.
//   N6  a malformed list, an entry without a name, and a missing list file: exit 2
//   N7  the accepted-sites list: accepted is exit 0 and lists the reason; unlisted is exit 1; a stale entry is exit 1; an entry without a reason is exit 2
//   N8  an accepted entry is BOUND to its fixed dates, consumer, field and a fingerprint of the source it depends on: a changed date at the same location is NOT inherited (exit 1, reported as changed)
//   N9  the fingerprint covers the whole chain, not only the flagged statement: editing a helper on the chain (the tokensFile-reverted case) un-accepts the site; editing an unrelated statement does not
//   N11 the fingerprint covers the full local dependency closure, not only the date and consumer chains: a NUMBER the expiry is computed from (WHEN + DAYS) changing from 30 to 3 un-accepts the site; an unrelated constant changing does not
//   N10 an entry missing its dates, consumer, field or fingerprint is refused (exit 2); a changed entry is never reported as merely stale
const LIST = path.join(HERE, '..', 'scripts', 'windowed-fields-1696.json');
const withTmp = (fn) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scan1696-')); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };

test('#1696 (N1) a fixed date into createdAt reaching a server is flagged WITHOUT the list and NOT flagged WITH it', () => {
  const plain = json(FX('planted-createdat.txt'));
  assert.ok(plain.j, `PRECONDITION: JSON: ${plain.r.stderr.slice(0, 200)}`); assert.equal(plain.r.status, 1, 'CONTROL: plain reachability flags it'); assert.equal(plain.j.flagged.length, 1);
  const narrowed = json('--fields', LIST, FX('planted-createdat.txt'));
  assert.ok(narrowed.j, `JSON with the list (exit ${narrowed.r.status}): ${narrowed.r.stderr.slice(0, 300)}`);
  assert.equal(narrowed.r.status, 0, 'with the list: not flagged'); assert.equal(narrowed.j.flagged.length, 0); assert.equal(narrowed.j.files, 1);
});

test('#1696 (N2) a fixed date into expiresAt reaching a server is flagged with the list, the field named; the pure row beside it is not', () => {
  const { r, j } = json('--fields', LIST, FX('planted-expiresat.txt'));
  assert.ok(j, `JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`); assert.equal(r.status, 1);
  assert.equal(j.flagged.length, 1, JSON.stringify(j.flagged.map(titleOf)));
  const f = j.flagged[0];
  assert.match(titleOf(f), /^planted expiresAt: a fixed expiry reaches a real server/); assert.equal(f.field, 'expiresAt');
  assert.ok(f.dateLiterals.some((d) => d.line === 5 && /2026-09-18/.test(String(d.value))), 'the NOW anchor on line 5 is on the chain'); assert.equal(f.consumer.name, 'startRestServer');
  assert.ok(f.via.includes('cred') && f.via.includes('at') && f.via.includes('NOW'), JSON.stringify(f.via));
});

test('#1696 (N3) the pre-fix credentials file with the list: exactly the three served tests, the NOW anchor still on their chain, the pure rows still unflagged', () => {
  const { r, j } = json('--fields', LIST, FX('prefix-credentials-1343.txt'));
  assert.ok(j, `JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`); assert.equal(r.status, 1);
  const titles = j.flagged.map(titleOf); assert.equal(j.flagged.length, 3, JSON.stringify(titles));
  for (const prefix of ['#1343 served (observe)', '#1343 served (required)', '#1343 served (required, MCP)']) assert.ok(titles.some((t) => t.startsWith(prefix)), `${prefix} is flagged`);
  for (const f of j.flagged) {
    assert.equal(f.field, 'expiresAt', 'the field is named');
    assert.ok(f.dateLiterals.some((d) => d.line === 30 && /2026-09-18/.test(String(d.value))), 'the original NOW anchor (line 30) is required on the served test\'s chain');
    assert.ok(f.via.includes('tokensFile') && f.via.includes('cred') && f.via.includes('at') && f.via.includes('NOW'), JSON.stringify(f.via));
  }
  for (const pure of ['#1343 format', '#1343 load', '#1343 resolve', '#1343 decision', '#1343 needFor', '#1343 assertActor', '#1343 credentialExpiryRows', '#1343 migrateCredentialsDoc', '#1343 readAuthMode', '#1343 redactSecrets', '#1343 scripts/credential.mjs', '#1343 SECRET_SHAPES']) {
    assert.ok(!titles.some((t) => t.startsWith(pure)), `${pure} is NOT flagged`);
  }
});

test('#1696 (N4) the report says unlisted fields are uncovered, not safe, and names the list; the JSON carries the field names it covered', () => {
  const { j } = json('--fields', LIST, FX('planted-expiresat.txt'));
  assert.ok(j && Array.isArray(j.fields) && j.fields.includes('expiresAt') && j.fields.includes('parkedUntil') && j.fields.includes('claimedAt'), `fields: ${j && JSON.stringify(j.fields)}`);
  assert.match(String(j.uncovered), /uncovered, not safe/i); assert.match(String(j.uncovered), /windowed-fields-1696\.json/);
  const t = run('--fields', LIST, FX('planted-expiresat.txt'));
  assert.match(t.stdout, /uncovered, not safe/i); assert.match(t.stdout, GUARD);
});

test('#1696 (N5) the committed list: each entry has a name, a path:line source and a reason; the cited line still names the field beside a clock expression; the name is used in non-test code', () => {
  assert.ok(fs.existsSync(LIST), 'PRECONDITION: the list file exists');
  const list = JSON.parse(fs.readFileSync(LIST, 'utf8')); assert.ok(Array.isArray(list.fields) && list.fields.length >= 4, 'at least expiresAt, parkedUntil, claimedAt, quietUntil');
  const root = path.join(HERE, '..'); const product = ['core', 'server.js', 'mcp-server.mjs'].flatMap((p) => { const abs = path.join(root, p); return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).filter((f) => f.endsWith('.mjs')).map((f) => path.join(abs, f)) : [abs]; });
  for (const e of list.fields) {
    assert.ok(typeof e.name === 'string' && e.name, 'name'); assert.ok(typeof e.why === 'string' && e.why.length > 10, `${e.name}: a reason`);
    const m = /^(.+):(\d+)$/.exec(String(e.source)); assert.ok(m, `${e.name}: source is path:line (${e.source})`);
    const file = path.join(root, m[1]); assert.ok(fs.existsSync(file), `${e.name}: ${m[1]} exists`); assert.ok(!/(^|\/)tests\//.test(m[1]), `${e.name}: the source is product code, not a test`);
    const lines = fs.readFileSync(file, 'utf8').split('\n'); const at = Number(m[2]); const near = lines.slice(Math.max(0, at - 4), at + 3).join('\n');
    assert.match(near, new RegExp(`\\b${e.name}\\b`), `${e.name}: the cited line (give or take three) names the field`);
    assert.match(near, /Date\.now\(\)|new Date\(\)|\bnowMs\b|\bnow\b/, `${e.name}: and a clock expression`);
    assert.ok(product.some((f) => new RegExp(`\\b${e.name}\\b`).test(fs.readFileSync(f, 'utf8'))), `${e.name}: used in non-test code`);
  }
});

test('#1696 (N6) a malformed list, an entry without a name, and a missing list file are all exit 2', () => withTmp((d) => {
  const bad = path.join(d, 'bad.json'); fs.writeFileSync(bad, '{ not json');
  const noName = path.join(d, 'noname.json'); fs.writeFileSync(noName, JSON.stringify({ fields: [{ source: 'core/credentials.mjs:138', why: 'x' }] }));
  const control = run('--json', '--fields', LIST, FX('planted-expiresat.txt'));
  assert.equal(control.status, 1, `CONTROL: the same invocation with the committed list flags the planted site (exit 1, got ${control.status}): ${control.stderr.slice(0, 200)}`);
  for (const [what, args, name] of [['malformed list', ['--fields', bad], 'bad.json'], ['entry without a name', ['--fields', noName], 'noname.json'], ['missing list', ['--fields', path.join(d, 'nope.json')], 'nope.json']]) {
    const r = run('--json', ...args, FX('planted-expiresat.txt')); assert.equal(r.status, 2, `${what}: exit 2 (got ${r.status}): ${r.stderr.slice(0, 200)}`);
    assert.ok(r.stderr.includes(name), `${what}: the message names the LIST file (${name}), not the file being scanned: ${r.stderr.slice(0, 200)}`);
  }
}));

/** An accepted-sites entry bound to a flagged site: its file, statement, field, consumer, the fixed dates it carries and the chain fingerprint the scan reported. */
const bind = (site, reason) => ({ file: site.file, statement: site.statement, field: site.field, consumer: site.consumer.name, dates: site.dates, fingerprint: site.fingerprint, reason });

test('#1696 (N7) the accepted-sites list: accepted is exit 0 with its reason, unlisted is exit 1, a stale entry is exit 1, an entry without a reason is exit 2', () => withTmp((d) => {
  const first = json('--fields', LIST, FX('planted-expiresat.txt')); assert.ok(first.j && first.j.flagged.length === 1, 'PRECONDITION: one flagged site');
  const site = first.j.flagged[0]; const entry = bind(site, 'the expiry is overridden by the caller in the one row that matters');
  const write = (name, doc) => { const p = path.join(d, name); fs.writeFileSync(p, JSON.stringify(doc)); return p; };
  const ok = json('--fields', LIST, '--baseline', write('ok.json', { accepted: [entry] }), FX('planted-expiresat.txt'));
  assert.equal(ok.r.status, 0, `accepted: exit 0 (got ${ok.r.status}): ${ok.r.stderr.slice(0, 200)}`); assert.equal(ok.j.flagged.length, 0);
  assert.equal(ok.j.accepted.length, 1); assert.match(String(ok.j.accepted[0].reason), /overridden by the caller/);
  const none = json('--fields', LIST, '--baseline', write('other.json', { accepted: [{ ...entry, statement: 'some other test' }] }), FX('planted-expiresat.txt'));
  assert.equal(none.r.status, 1, 'an entry for a different site does not accept this one'); assert.equal(none.j.flagged.length, 1);
  assert.equal(none.j.staleBaseline.length, 1, 'and the unmatched entry is reported stale');
  const stale = json('--fields', LIST, '--baseline', write('stale.json', { accepted: [entry, { ...entry, statement: 'a test that no longer exists' }] }), FX('planted-expiresat.txt'));
  assert.equal(stale.r.status, 1, 'a stale entry fails even when every site is accepted'); assert.equal(stale.j.staleBaseline.length, 1); assert.equal(stale.j.flagged.length, 0);
  const { reason, ...noReason } = entry;
  const nr = run('--json', '--fields', LIST, '--baseline', write('noreason.json', { accepted: [noReason] }), FX('planted-expiresat.txt'));
  assert.equal(nr.status, 2, `an entry without a reason: exit 2 (got ${nr.status}): ${nr.stderr.slice(0, 200)}`);
}));

test('#1696 (S8) a name bound locally in a served test is not the top-level name of the same spelling: no false chain', () => {
  const { r, j } = json(FX('shadowed-name.txt'));
  assert.ok(j, `PRECONDITION: the scan printed JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.deepEqual(j.flagged.map(titleOf), [], `nothing is flagged: the served tests bind their own NOW (${JSON.stringify(j.flagged.map(titleOf))})`);
  assert.equal(r.status, 0);
  // CONTROL: the same file with the local binding removed IS flagged, so the fixture can fail.
  const un = fs.mkdtempSync(path.join(os.tmpdir(), 's8-'));
  try {
    const f = path.join(un, 'unshadowed.txt');
    fs.writeFileSync(f, fs.readFileSync(FX('shadowed-name.txt'), 'utf8').replace("  const NOW = new Date().toISOString();\n", '').replace('const boot = async (NOW) =>', 'const boot = async (X) =>'));
    const c = json(f);
    assert.equal(c.r.status, 1, `CONTROL: with the local NOW gone the served test is flagged (${c.r.stdout.slice(0, 200)})`);
    assert.ok(c.j.flagged.some((x) => /shadowed const/.test(titleOf(x))), 'and it is the const row that is flagged');
  } finally { fs.rmSync(un, { recursive: true, force: true }); }
});

test('#1696 (S9) a helper holding a fixed date, reaching a real server only through further helpers, is found with every name on the way; a served row without the date is not', () => {
  const { r, j } = json(FX('indirect-consumer.txt'));
  assert.ok(j, `PRECONDITION: the scan printed JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 1);
  const titles = j.flagged.map(titleOf);
  assert.ok(titles.some((t) => t.startsWith('indirect:')), `the indirect row is flagged: ${JSON.stringify(titles)}`);
  assert.ok(!titles.some((t) => t.startsWith('control, same file')), `the served row that never touches the date is not flagged: ${JSON.stringify(titles)}`);
  const f = j.flagged.find((x) => titleOf(x).startsWith('indirect:'));
  for (const n of ['withWorld', 'seedCard']) assert.ok(f.via.includes(n), `the chain names ${n}: ${JSON.stringify(f.via)}`);
  assert.equal(f.consumer.name, 'startRestServer');
  assert.ok(f.dateLiterals.some((d) => d.line === 5), 'and the date literal is the WHEN on line 5');
});

const CONSUMER_NAMES = ['startRestServer', 'startMcpServer', 'startExecutor', 'startExecutorOnCopy', 'world', 'worldWithEnv', 'labelWorld', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'launch'];

test('#1696 (S10) every starter the header names is a consumer: a fixed date into each is flagged with that starter\'s name, plain and as a member call', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's10-'));
  try {
    const one = (call, tag) => {
      const f = path.join(d, `${tag}.txt`);
      fs.writeFileSync(f, `import { test } from 'node:test';\nconst WHEN = '2026-09-18T12:00:00.000Z';\ntest('planted ${tag}', async () => { await ${call}({ at: WHEN }); });\n`);
      return json(f);
    };
    for (const name of CONSUMER_NAMES) {
      const { r, j } = one(name, name);
      assert.equal(r.status, 1, `${name}: flagged (exit ${r.status}) ${r.stderr.slice(0, 160)}`);
      assert.equal(j.flagged[0].consumer.name, name, `${name}: the consumer is named`);
    }
    const m = one('cp.spawn', 'member');
    assert.equal(m.r.status, 1, 'cp.spawn (a member call) is flagged'); assert.equal(m.j.flagged[0].consumer.name, 'spawn');
    const neg = one('notAStarter', 'control');
    assert.equal(neg.r.status, 0, 'CONTROL: a call that is not a starter is not flagged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('#1696 (S11) a calendar date that appears only in a test title is text, not data: not flagged', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's11-'));
  try {
    const f = path.join(d, 'title.txt');
    fs.writeFileSync(f, "import { test } from 'node:test';\nimport { startRestServer } from './h.mjs';\ntest('the 2026-09-18 incident, replayed', async () => { await startRestServer({}); });\n");
    const { r, j } = json(f);
    assert.equal(r.status, 0, `title-only date is not flagged (exit ${r.status}): ${r.stdout.slice(0, 200)}`); assert.deepEqual(j.flagged, []);
    const c = path.join(d, 'title-and-data.txt');
    fs.writeFileSync(c, "import { test } from 'node:test';\nimport { startRestServer } from './h.mjs';\ntest('the 2026-09-18 incident, replayed', async () => { await startRestServer({ at: '2026-09-18' }); });\n");
    assert.equal(json(c).r.status, 1, 'CONTROL: the same test with the date in its DATA is flagged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('#1696 (S13) THE LIMIT, pinned: with the field list, a fixed date set by assignment (card.expiresAt = WHEN) or under a computed key is not seen, and the guard sentence says so', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's13-'));
  const list = path.join(d, 'fields.json'); fs.writeFileSync(list, JSON.stringify({ fields: [{ name: 'expiresAt', source: 'x:1', why: 'x' }] }));
  try {
    const mk = (tag, body) => { const f = path.join(d, `${tag}.txt`); fs.writeFileSync(f, `import { test } from 'node:test';\nimport { startRestServer } from './h.mjs';\nconst WHEN = '2026-09-18T12:00:00.000Z';\ntest('${tag}', async () => { ${body} await startRestServer({ card }); });\n`); return f; };
    const ctl = run('--json', '--fields', list, mk('literal', "const card = { expiresAt: WHEN };"));
    assert.equal(ctl.status, 1, `CONTROL: the same date under a literal key IS flagged with the list (exit ${ctl.status})`);
    for (const [tag, body] of [['assign', "const card = {}; card.expiresAt = WHEN;"], ['computed', "const card = { ['expiresAt']: WHEN };"]]) {
      const r = run('--json', '--fields', list, mk(tag, body)); const j = JSON.parse(r.stdout);
      assert.equal(r.status, 0, `${tag}: NOT flagged, as the limit says (exit ${r.status})`); assert.deepEqual(j.flagged, []);
      assert.match(j.guard, /by assignment|computed key/i, `${tag}: the guard sentence names this limit`);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('#1696 (S12) THE LIMIT, pinned: a date written as numbers is not seen, and the guard sentence says so', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's12-'));
  try {
    for (const [tag, expr] of [['utc', 'Date.UTC(2026, 8, 18)'], ['parts', 'new Date(2026, 8, 18).toISOString()'], ['epoch', '1789689600000']]) {
      const f = path.join(d, `${tag}.txt`);
      fs.writeFileSync(f, `import { test } from 'node:test';\nimport { startRestServer } from './h.mjs';\nconst WHEN = ${expr};\ntest('numeric date ${tag}', async () => { await startRestServer({ at: WHEN }); });\n`);
      const { r, j } = json(f);
      assert.equal(r.status, 0, `${tag}: NOT flagged, as the limit says (exit ${r.status})`); assert.deepEqual(j.flagged, []);
      assert.match(j.guard, /written as numbers|epoch/i, `${tag}: the guard sentence names this limit`);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('#1696 (N8) an accepted entry is bound to its dates, consumer, field and a source fingerprint: a changed date at the same location is not inherited as safe', () => withTmp((d) => {
  const f = path.join(d, 'site.txt'); const orig = fs.readFileSync(FX('planted-expiresat.txt'), 'utf8'); fs.writeFileSync(f, orig);
  const a = json('--fields', LIST, f); assert.equal(a.j.flagged.length, 1, 'PRECONDITION: one flagged site');
  assert.ok(Array.isArray(a.j.flagged[0].dates) && a.j.flagged[0].dates.includes('2026-09-18T12:00:00.000Z'), `the report carries the fixed dates: ${JSON.stringify(a.j.flagged[0].dates)}`);
  assert.match(String(a.j.flagged[0].fingerprint), /^[0-9a-f]{16,}$/, 'and a chain fingerprint');
  const base = path.join(d, 'accepted.json'); fs.writeFileSync(base, JSON.stringify({ accepted: [bind(a.j.flagged[0], 'reviewed')] }));
  const ok = json('--fields', LIST, '--baseline', base, f); assert.equal(ok.r.status, 0, `CONTROL: the unchanged site is accepted (exit ${ok.r.status}): ${ok.r.stdout.slice(0, 200)}`);
  fs.writeFileSync(f, orig.replace('2026-09-18T12:00:00.000Z', '2027-01-05T12:00:00.000Z'));   // same file, same statement, same line: a different date
  const moved = json('--fields', LIST, '--baseline', base, f);
  assert.equal(moved.r.status, 1, `a changed date at the same location is NOT accepted (exit ${moved.r.status})`); assert.equal(moved.j.flagged.length, 1);
  assert.equal(moved.j.changed.length, 1, 'and it is reported as CHANGED, needing review'); assert.ok(moved.j.changed[0].differs.includes('dates'), `naming what differs: ${JSON.stringify(moved.j.changed[0].differs)}`);
  assert.equal(moved.j.staleBaseline.length, 0, 'a changed entry is not also reported stale');
  const text = run('--fields', LIST, '--baseline', base, f); assert.equal(text.status, 1); assert.match(text.stdout, /CHANGED since accepted \([^)]*\bdates\b[^)]*differ\)/, 'the text report says so, naming what differs');
}));

test('#1696 (N9) the fingerprint covers the whole chain: editing a helper the site depends on un-accepts it; editing an unrelated statement does not', () => withTmp((d) => {
  const f = path.join(d, 'chain.txt'); const orig = fs.readFileSync(FX('planted-expiresat.txt'), 'utf8'); fs.writeFileSync(f, orig);
  const a = json('--fields', LIST, f); const base = path.join(d, 'accepted.json'); fs.writeFileSync(base, JSON.stringify({ accepted: [bind(a.j.flagged[0], 'reviewed')] }));
  // the flagged statement itself is untouched; the helper that feeds expiresAt changes (the case where a caller's override is reverted)
  fs.writeFileSync(f, orig.replace("expiresAt: at(24 * 30)", "expiresAt: at(24 * 3)"));
  const edited = json('--fields', LIST, '--baseline', base, f);
  assert.equal(edited.r.status, 1, `a change on the chain un-accepts the site (exit ${edited.r.status})`); assert.ok(edited.j.changed.length === 1 && edited.j.changed[0].differs.includes('fingerprint'), JSON.stringify(edited.j.changed));
  // CONTROL: an edit to the pure row, which is NOT on the chain, leaves the acceptance standing
  fs.writeFileSync(f, orig.replace("throw new Error('never')", "throw new Error('still never')"));
  const unrelated = json('--fields', LIST, '--baseline', base, f);
  assert.equal(unrelated.r.status, 0, `CONTROL: an unrelated edit does not un-accept (exit ${unrelated.r.status}): ${unrelated.r.stdout.slice(0, 200)}`);
}));

test('#1696 (N10) an accepted entry missing its dates, consumer, field or fingerprint is refused (exit 2), naming the list', () => withTmp((d) => {
  const a = json('--fields', LIST, FX('planted-expiresat.txt')); const full = bind(a.j.flagged[0], 'reviewed');
  for (const missing of ['dates', 'consumer', 'field', 'fingerprint']) {
    const { [missing]: _drop, ...partial } = full; const p = path.join(d, `no-${missing}.json`); fs.writeFileSync(p, JSON.stringify({ accepted: [partial] }));
    const r = run('--json', '--fields', LIST, '--baseline', p, FX('planted-expiresat.txt'));
    assert.equal(r.status, 2, `an entry without ${missing}: exit 2 (got ${r.status}): ${r.stdout.slice(0, 120)}`); assert.match(r.stderr, new RegExp(`no-${missing}\\.json`), 'the message names the list file');
  }
}));

test('#1696 (N11) the fingerprint covers the full local dependency closure: changing a number an accepted expiry is computed from un-accepts it; changing an unrelated constant does not', () => withTmp((d) => {
  const f = path.join(d, 'numeric.txt'); const orig = fs.readFileSync(FX('numeric-dependency.txt'), 'utf8'); fs.writeFileSync(f, orig);
  const a = json('--fields', LIST, f); assert.equal(a.j.flagged.length, 1, `PRECONDITION: the numeric-dependency site is flagged (${a.r.stdout.slice(0, 200)})`); assert.ok(a.j.flagged[0].dates.includes('2026-09-18T12:00:00.000Z'));
  const base = path.join(d, 'accepted.json'); fs.writeFileSync(base, JSON.stringify({ accepted: [bind(a.j.flagged[0], 'reviewed')] }));
  assert.equal(json('--fields', LIST, '--baseline', base, f).r.status, 0, 'CONTROL: unchanged, accepted');
  fs.writeFileSync(f, orig.replace('const DAYS = 30;', 'const DAYS = 3;'));
  const slid = json('--fields', LIST, '--baseline', base, f);
  assert.equal(slid.r.status, 1, `the expiry moved from +30 d to +3 d with the SAME fixed date: it must need review (exit ${slid.r.status})`); assert.equal(slid.j.changed.length, 1); assert.ok(slid.j.changed[0].differs.includes('fingerprint'), JSON.stringify(slid.j.changed));
  fs.writeFileSync(f, orig.replace('const UNRELATED = 5;', 'const UNRELATED = 6;'));
  assert.equal(json('--fields', LIST, '--baseline', base, f).r.status, 0, 'CONTROL: a constant the site does not depend on may change without un-accepting it');
}));
