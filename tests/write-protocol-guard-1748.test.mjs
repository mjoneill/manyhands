/**
 * #1748 — the BUILDER's tests for how the floor guard is built (the row author's tests/write-protocol-floor-1748.test.mjs holds the
 * contract rows, including M2e2's tamper shapes). The guard runs INSIDE the update it protects, so these pin what follows from that:
 * a refused tamper leaves a floor that a RESTART still reads; an engine error inside a floored update applies NOTHING (the guard
 * must not turn a half-applied update into a durable one); a floor that is not a plain string is refused at start, never
 * compared by its lexical value; a floor is honoured only beside the install record --install-write-floor writes, so one
 * that an UNFLOORED (unguarded) store took from an /update stops the next start with the fix named, rather than silently
 * refusing every writer; and a floored store's guard keeps that record too, and still accepts a body whose own text leaves
 * a `;` nothing to follow (the delta re-review, 46404).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { spawnExecutor, killExecutor, HAVE_PY, PY } from './helpers/graph-executor-proc.mjs';

const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 120000 };
const DSID = 'floor-guard-1748';
const BK = 'urn:scrum:bookkeeping:executor';
const F = '<urn:ex:write-floor> <urn:ex:write-floor/minProtocol>';

const owned = { stores: new Set(), children: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});
const freshStore = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-guard-')); owned.stores.add(d); fs.rmSync(d, { recursive: true }); return d; };
const start = async (store, extra = []) => { const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', DSID, ...extra]); owned.children.add(x); return x; };
const stop = async (x) => { await killExecutor(x); owned.children.delete(x); };
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
let n = 0;
const update = async (x, sparql, { protocol = WRITE_PROTOCOL } = {}) => {
  const op = `urn:ex:op/test/floor-guard-${process.pid}-${++n}`;
  const headers = { 'content-type': 'application/sparql-update', 'x-op-id': op, 'x-epoch': String((await health(x)).epoch) };
  if (protocol) headers[WRITE_PROTOCOL_HEADER] = protocol;
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers, body: sparql });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ask = async (x, q) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: q });
  return (await r.json()).boolean;
};
const counters = (h) => [h.updates, h.flushes, h.commitSeq];

test('#1748 (guard) a refused data-dependent tamper leaves a floor that a RESTART still enforces', T, async () => {
  const store = freshStore();
  let x = await start(store, ['--create', '--install-write-floor', WRITE_PROTOCOL]);
  assert.equal((await update(x, 'INSERT DATA { <urn:ex:card/1> <urn:ex:p> "a card" }')).status, 200, 'PRECONDITION: an ordinary write applies');
  const r = await update(x, `DELETE { GRAPH <${BK}> { ${F} ?v } } WHERE { <urn:ex:card/1> ?q ?r . GRAPH <${BK}> { ${F} ?v } }`);
  assert.equal(r.status, 409, `refused (${JSON.stringify(r.body)})`);
  assert.equal(r.body?.error, 'WRITE_FLOOR_PROTECTED');
  await stop(x);
  x = await start(store);
  assert.equal((await health(x)).writeFloor, WRITE_PROTOCOL, 'the restarted executor reads the floor back');
  const bare = await update(x, 'INSERT DATA { <urn:ex:card/2> <urn:ex:p> "b" }', { protocol: null });
  assert.equal(bare.status, 428, 'and still refuses a write without the protocol');
  await stop(x);
});

test('#1748 (guard) an ENGINE error inside a floored update applies nothing: no half of it becomes durable', T, async () => {
  const x = await start(freshStore(), ['--create', '--install-write-floor', WRITE_PROTOCOL]);
  const h0 = await health(x);
  const r = await update(x, 'INSERT DATA { <urn:ex:half> <urn:ex:p> "first half" } ; DROP GRAPH <urn:ex:g/never-created>');
  assert.equal(r.status, 500, `an engine error is not a floor refusal (${JSON.stringify(r.body)})`);
  assert.equal(await ask(x, 'ASK { <urn:ex:half> ?p ?o }'), false, 'the operation before the error was not applied');
  assert.deepEqual(counters(await health(x)), counters(h0), 'nothing counted or flushed');
  assert.equal(await ask(x, `ASK { GRAPH <${BK}> { ${F} "${WRITE_PROTOCOL}" } }`), true, 'the floor is untouched');
  await stop(x);
});

/** Writes straight into a STOPPED store with pyoxigraph: the only way to plant a floor now that /update refuses to. */
const plant = (store, nquad) => {
  const r = spawnSync(PY, ['-I', '-c', 'import sys, pyoxigraph as px; s = px.Store(sys.argv[1]); s.update(sys.argv[2]); s.flush()', store, `INSERT DATA { ${nquad} }`], { encoding: 'utf8' });
  assert.equal(r.status, 0, `PRECONDITION: planted (${r.stderr})`);
};

test('#1748 (guard) a floor that is not a plain string (here language-tagged) is refused at start, not matched by its lexical value', T, async () => {
  const store = freshStore();
  await stop(await start(store, ['--create']));
  plant(store, `GRAPH <${BK}> { ${F} "${WRITE_PROTOCOL}"@en }`);
  await assert.rejects(start(store), (e) => /not a plain string literal/.test(e.stderr ?? e.message), 'the executor refuses to start');
});

test('#1748 (guard) an UNFLOORED store runs a floor-writing /update as sent, and the next start REFUSES it with the fix named; the fix works', T, async () => {
  const store = freshStore();
  let x = await start(store, ['--create']);
  const r = await update(x, `INSERT DATA { GRAPH <${BK}> { ${F} "postseq-typo" } }`, { protocol: null });
  assert.equal(r.status, 200, `unguarded, as before #1748 (${JSON.stringify(r.body)})`);
  await stop(x);
  await assert.rejects(start(store), (e) => /no install record/.test(e.stderr ?? e.message) && /--install-write-floor postseq-typo/.test(e.stderr ?? e.message),
    'a floor without its install record stops the start, naming the fix');
  x = await start(store, ['--install-write-floor', 'postseq-typo']);
  assert.equal((await health(x)).writeFloor, 'postseq-typo', 'the named fix records it');
  await stop(x);
  x = await start(store);
  assert.equal((await health(x)).writeFloor, 'postseq-typo', 'and a plain start then honours it');
  await stop(x);
});

test('#1748 (guard) a floored store refuses an /update that removes or rewrites the INSTALL RECORD: 409, nothing applied', T, async () => {
  const x = await start(freshStore(), ['--create', '--install-write-floor', WRITE_PROTOCOL]);
  const BY = '<urn:ex:write-floor> <urn:ex:write-floor/installedBy>';
  for (const [why, sparql] of Object.entries({
    'removed': `DELETE WHERE { GRAPH <${BK}> { ${BY} ?v } }`,
    'rewritten': `DELETE { GRAPH <${BK}> { ${BY} ?v } } INSERT { GRAPH <${BK}> { ${BY} "someone else" } } WHERE { GRAPH <${BK}> { ${BY} ?v } }`,
  })) {
    const h0 = await health(x);
    const r = await update(x, sparql);
    assert.equal(r.status, 409, `${why}: refused (${JSON.stringify(r.body)})`);
    assert.deepEqual(counters(await health(x)), counters(h0), `${why}: nothing applied`);
  }
  assert.equal(await ask(x, `ASK { GRAPH <${BK}> { ${BY} "install-write-floor" } }`), true, 'the record is intact');
  await stop(x);
});

test('#1748 (guard) a floored store never reports a false success: a body that is invalid alone is a 500 with NOTHING applied, never fused with the guard into something valid', T, async () => {
  const x = await start(freshStore(), ['--create', '--install-write-floor', WRITE_PROTOCOL]);
  const ok = {
    'an ordinary body': 'INSERT DATA { <urn:ex:t/1> <urn:ex:p> "x" }',
    'a `#` inside an IRI on the last line': 'INSERT DATA { <urn:ex:t/2#frag> <urn:ex:p> "x" }',
    'a trailing `;`': 'INSERT DATA { <urn:ex:t/3> <urn:ex:p> "x" } ;',
    'empty': '   ',
  };
  for (const [why, sparql] of Object.entries(ok)) assert.equal((await update(x, sparql)).status, 200, `${why}: applied`);
  for (const s of ['urn:ex:t/1', 'urn:ex:t/2#frag', 'urn:ex:t/3']) assert.equal(await ask(x, `ASK { <${s}> ?p ?o }`), true, `${s} is stored`);
  // the delta re-review's finding 3 (46427): each of these is invalid on its own; a join that let the guard complete it
  // answered 200 having applied part or none of it
  const refused = {
    'a DELETE template with no WHERE': 'DELETE { GRAPH <urn:ex:g> { <urn:ex:a> <urn:ex:b> <urn:ex:c> } }',
    'an INSERT, then a dangling DELETE template': 'INSERT DATA { <urn:ex:t/9> <urn:ex:p> "x" } ; DELETE { <urn:ex:t/1> <urn:ex:p> "x" }',
    'an INSERT, then a dangling WITH': 'INSERT DATA { <urn:ex:t/10> <urn:ex:p> "x" } ; WITH <urn:ex:g>',
    'a comment after the final `;`': 'INSERT DATA { <urn:ex:t/11> <urn:ex:p> "x" } ; # trailing',
    'comment-only': '# nothing to do',
    'prologue-only': 'PREFIX ex: <urn:ex:>',
  };
  for (const [why, sparql] of Object.entries(refused)) {
    const h0 = await health(x);
    const r = await update(x, sparql);
    assert.equal(r.status, 500, `${why}: an engine error, never a success (${r.status} ${JSON.stringify(r.body)})`);
    assert.deepEqual(counters(await health(x)), counters(h0), `${why}: nothing applied`);
  }
  for (const s of ['urn:ex:t/9', 'urn:ex:t/10', 'urn:ex:t/11']) assert.equal(await ask(x, `ASK { <${s}> ?p ?o }`), false, `${s}: the valid half was NOT applied`);
  assert.equal(await ask(x, 'ASK { <urn:ex:t/1> ?p ?o }'), true, 'and nothing was deleted');
  await stop(x);
});

test('#1748 (guard) an /update on an UNFLOORED store cannot set up a later brick: an EMPTY sentinel graph or a stray install record is refused at install; a stray SECOND record is refused at start', T, async () => {
  const empty = freshStore();
  let x = await start(empty, ['--create']);
  assert.equal((await update(x, 'CREATE GRAPH <urn:ex:write-floor/violation>', { protocol: null })).status, 200, 'PRECONDITION: unguarded');
  await stop(x);
  await assert.rejects(start(empty, ['--install-write-floor', WRITE_PROTOCOL]), (e) => /write-floor\/violation/.test(e.stderr ?? e.message), 'an EMPTY sentinel graph refuses the install');
  const stray = freshStore();
  x = await start(stray, ['--create']);
  assert.equal((await update(x, `INSERT DATA { GRAPH <${BK}> { <urn:ex:write-floor> <urn:ex:write-floor/installedBy> "something-else" } }`, { protocol: null })).status, 200, 'PRECONDITION: unguarded');
  await stop(x);
  await assert.rejects(start(stray, ['--install-write-floor', WRITE_PROTOCOL]), (e) => /install record for a floor it does not have/.test(e.stderr ?? e.message), 'a stray record refuses the install');
  x = await start(stray);
  assert.equal((await health(x)).writeFloor, null, 'BEFORE writing anything: the store is still unfloored');
  await stop(x);
  const second = freshStore();
  await stop(await start(second, ['--create', '--install-write-floor', WRITE_PROTOCOL]));
  plant(second, `GRAPH <${BK}> { <urn:ex:write-floor> <urn:ex:write-floor/installedBy> "install-write-floor"@en }`);
  await assert.rejects(start(second), (e) => /not exactly as --install-write-floor wrote/.test(e.stderr ?? e.message), 'a second record value refuses the start, by the guard\'s own pattern');
});

test('#1748 (guard) a store holding the guard\'s sentinel graph is refused a floor at install, and refused at start if already floored', T, async () => {
  const store = freshStore();
  await stop(await start(store, ['--create']));
  plant(store, 'GRAPH <urn:ex:write-floor/violation> { <urn:ex:s> <urn:ex:p> <urn:ex:o> }');
  await assert.rejects(start(store, ['--install-write-floor', WRITE_PROTOCOL]), (e) => /write-floor\/violation/.test(e.stderr ?? e.message), 'install refuses');
  const after = await start(store);
  assert.equal((await health(after)).writeFloor, null, 'BEFORE writing anything: the store is still unfloored');
  await stop(after);
  const floored = freshStore();
  await stop(await start(floored, ['--create', '--install-write-floor', WRITE_PROTOCOL]));
  plant(floored, 'GRAPH <urn:ex:write-floor/violation> { <urn:ex:s> <urn:ex:p> <urn:ex:o> }');
  await assert.rejects(start(floored), (e) => /write-floor\/violation/.test(e.stderr ?? e.message), 'a floored start refuses');
});
