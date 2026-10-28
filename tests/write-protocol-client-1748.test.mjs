/**
 * #1748 — the UPDATED client's explicit handling of a 428 (contract v2 F1: "New-client explicit non-application handling for HTTP428
 * remains part of the implementation contract; a raw SPARQL success alone never proves it"). BUILDER's test, beside the row author's
 * tests/write-protocol-floor-1748.test.mjs (whose M2k covers the matching-protocol positive): a store whose floor names a protocol this
 * client does NOT speak must give a definitive REJECTED, never UNKNOWN, and durableUpdate must not replay it, with nothing applied.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient, WRITE_PROTOCOL } from '../core/graph-client.mjs';
import { durableUpdate } from '../core/durable-update.mjs';
import { spawnExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 120000 };
const DSID = 'floor-client-1748';
const OTHER = 'postseq-v2-test';   // a floor this client does not speak

const owned = { stores: new Set(), children: new Set() };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});
const freshStore = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-client-')); owned.stores.add(d); fs.rmSync(d, { recursive: true }); return d; };
const start = async (store, extra) => { const x = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', DSID, ...extra]); owned.children.add(x); return x; };
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
const receipt = async (x, op) => (await (await fetch(`${x.baseUrl}/receipt/${encodeURIComponent(op)}`)).json()).receipt;
const rule = (tag) => ({ kind: 'rule', opId: `urn:ex:op/test/floor-client-${tag}-${process.pid}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/floor-client-${tag}` } });

test('#1748 (client) the client declares a protocol, and it is not the one this store\'s floor names (PRECONDITION)', () => {
  assert.equal(typeof WRITE_PROTOCOL, 'string');
  assert.notEqual(WRITE_PROTOCOL, OTHER);
});

test('#1748 (client) a floor naming ANOTHER protocol: the updated client gets a definitive REJECTED (never UNKNOWN), and nothing is applied', T, async () => {
  const x = await start(freshStore(), ['--create', '--install-write-floor', OTHER]);
  const h0 = await health(x);
  assert.equal(h0.writeFloor, OTHER, 'PRECONDITION: the store is floored at another protocol');
  const intent = rule('reject');
  const out = await createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID }).update(intent);
  assert.equal(out.outcome, 'REJECTED', `definitive, so no caller reconciles or replays it (${JSON.stringify(out).slice(0, 200)})`);
  assert.match(out.reason, /WRITE_PROTOCOL_REQUIRED/, 'and it is named');
  assert.equal(out.writeProtocolRequired, OTHER, 'naming the protocol the store needs');
  const h1 = await health(x);
  assert.deepEqual([h1.updates, h1.flushes, h1.commitSeq], [h0.updates, h0.flushes, h0.commitSeq], 'nothing was applied or flushed');
  assert.equal(await receipt(x, intent.opId), null, 'and no receipt was recorded');
});

test('#1748 (client) durableUpdate does not replay a 428: one request, REJECTED, nothing applied', T, async () => {
  const x = await start(freshStore(), ['--create', '--install-write-floor', OTHER]);
  const h0 = await health(x);
  const intent = rule('durable');
  const out = await durableUpdate(createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID }), intent);
  assert.equal(out.outcome, 'REJECTED', `REJECTED through durableUpdate too (${JSON.stringify(out).slice(0, 200)})`);
  const h1 = await health(x);
  assert.deepEqual([h1.updates, h1.flushes, h1.commitSeq], [h0.updates, h0.flushes, h0.commitSeq], 'no replay applied anything');
  assert.equal(await receipt(x, intent.opId), null, 'no receipt');
});
