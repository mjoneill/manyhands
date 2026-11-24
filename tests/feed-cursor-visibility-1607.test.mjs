/**
 * #1607 — THE VISIBILITY QUESTION, asked before the live feed's empty page may advance its cursor.
 * REAL executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: a live poll whose cursor is behind the head scans every operation receipt and, when it finds no post, echoes its
 * own cursor ("the LAST DELIVERED commit, never the head"). One non-post commit after the last post therefore sends every
 * idle poll to that scan until the next post. The proposed fix lets an empty page answer with a cursor at the head the
 * poll read first. That is safe ONLY IF nothing committed at or below that head can become a post the scan would deliver
 * AFTER the head was read. These rows ask that question of the store itself, independent of the fix.
 *
 *   V1  UNDER CONCURRENT POSTS: a reader reads the marker, then (a separate read) counts the post operations at or below
 *       it that a live scan would deliver. Once the writers stop, every sampled marker is counted again. No count may
 *       have grown: nothing at or below a marker the reader saw became deliverable later.
 *   V0  CONTROL, so V1 can fail: a post written in TWO updates (receipt and commit first, its post node later) IS caught
 *       by the same check. If V0 passes and V1 passes, V1's silence is a measurement, not a blind spot.
 *
 * The eligibility below is the live scan's own (core/post-discovery.mjs opBatch): an APPLIED receipt on a live post
 * operation, with a post node recorded by it that is a Comment or a redaction tombstone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnBoardServer, makeBoardFixture } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { BK } from '../core/graph-vocab.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'v1607-test';
const EX = 'urn:ex:';
const RS = 'https://scrumboard.local/ns#';
const COMMENT = 'https://schema.org/Comment';
const REDACTED = `${RS}RedactedPost`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LIVE_OPS = [`${EX}op/announce/`, `${EX}op/post/`];

async function exq(execUrl, sparql) {
  const r = await fetch(`${execUrl}/query`, { method: 'POST', body: sparql, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  assert.equal(r.status, 200, `executor query refused: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : (j.rows || j.results?.bindings || []);
}
const val = (row, k) => row?.[k]?.value ?? row?.[k];
async function marker(execUrl) {
  const rows = await exq(execUrl, `SELECT ?s WHERE { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s } }`);
  assert.equal(rows.length, 1, 'one marker');
  return Number(val(rows[0], 's'));
}
const bk = () => (BK.startsWith('<') ? BK : `<${BK}>`);
/** The live scan's eligibility, counted at or below `upTo`. */
async function deliverableAtOrBelow(execUrl, upTo) {
  const pre = LIVE_OPS.map((p) => `STRSTARTS(STR(?op), ${JSON.stringify(p)})`).join(' || ');
  const rows = await exq(execUrl, `SELECT (COUNT(DISTINCT ?op) AS ?n) WHERE {
  GRAPH ${bk()} { ?op <${EX}commitSeq> ?c ; <${EX}outcome> ?out }
  FILTER(STR(?out) = ${JSON.stringify(`${EX}APPLIED`)} && (${pre}) && ?c <= ${upTo})
  GRAPH ${bk()} { ?p <${EX}recordedBy> ?op } ?p <${RDF_TYPE}> ?pt . FILTER(?pt = <${COMMENT}> || ?pt = <${REDACTED}>)
}`);
  return Number(val(rows[0], 'n'));
}
async function exUpdate(execUrl, opIri, sparql) {
  const r = await fetch(`${execUrl}/update`, { method: 'POST', headers: { 'x-op-id': opIri }, body: sparql, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  assert.ok(r.status < 300, `executor update refused (${r.status}): ${text.slice(0, 300)}`);
}

async function spawnServer(boardFile, execUrl) {
  const attach = fs.mkdtempSync(path.join(os.tmpdir(), 'v1607-attach-'));
  const srv = await spawnBoardServer({ label: 'v1607 board server', readyTimeoutMs: 15000, env: (port) => ({ ...process.env, SCRUM_BOARD_FILE: boardFile,
    SCRUM_MCP_NOTIFY_URL: '', SCRUM_ATTACHMENTS_DIR: attach, SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `v1607-chan-${process.pid}-${port}.json`),
    SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' }) });   // #1833: the harness retries a lost port race
  return { base: srv.baseUrl, stop: srv.stop, stderr: srv.stderr };
}
async function stack(body) {
  const store = tmpStore('v1607-store-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1607-'));
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture({ conversations: [] }), null, 2));
  const srv = await spawnServer(file, exec.baseUrl);
  try { return await body({ base: srv.base, execUrl: exec.baseUrl, stderr: srv.stderr }); }
  finally { srv.stop(); await killExecutor(exec); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
}
const say = (base, i) => fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ author: 'ada', body: `v1607 post ${i}` }), signal: AbortSignal.timeout(30000) })
  .then(async (r) => { assert.equal(r.status, 201, `post ${i} refused: ${r.status} ${await r.text()}`); });

test('V1 UNDER CONCURRENT POSTS: nothing at or below a marker the reader saw becomes deliverable after it was read', { skip: SKIP }, async () => {
  await stack(async (s) => {
    const POSTS = 60, WIDTH = 6;
    let done = false;
    const samples = [];
    const reader = (async () => {
      while (!done) {
        const m = await marker(s.execUrl);                 // read 1: the head
        const n = await deliverableAtOrBelow(s.execUrl, m); // read 2: what a scan finds at or below it
        samples.push({ m, n });
      }
    })();
    let next = 0;
    await Promise.all(Array.from({ length: WIDTH }, async () => { while (next < POSTS) await say(s.base, next++); }));
    done = true; await reader;
    assert.equal(await deliverableAtOrBelow(s.execUrl, await marker(s.execUrl)), POSTS, `control: every post is deliverable once the writers stop\n${s.stderr()}`);
    const moved = new Set(samples.map((x) => x.m));
    assert.ok(samples.length >= 20 && moved.size >= 10, `the reader must have sampled while the head moved (samples ${samples.length}, distinct heads ${moved.size})`);
    for (const { m, n } of samples) {
      assert.equal(await deliverableAtOrBelow(s.execUrl, m), n, `a post committed at or below head ${m} became deliverable after that head was read`);
    }
  });
});

/** A redaction the live scan would deliver: an APPLIED receipt on a redaction operation and a tombstone that names it. */
async function redactionsAtOrBelow(execUrl, upTo) {
  const rows = await exq(execUrl, `SELECT (COUNT(DISTINCT ?op) AS ?n) WHERE {
  GRAPH ${bk()} { ?op <${EX}commitSeq> ?c ; <${EX}outcome> ?out }
  FILTER(STR(?out) = ${JSON.stringify(`${EX}APPLIED`)} && STRSTARTS(STR(?op), ${JSON.stringify(`${EX}op/redact/`)}) && ?c <= ${upTo})
  ?q <${RS}redactedBy> ?op .
}`);
  return Number(val(rows[0], 'n'));
}

test('V2 UNDER CONCURRENT POSTS AND REDACTIONS: nothing at or below a marker the reader saw, post OR redaction, becomes deliverable after it was read', { skip: SKIP }, async () => {
  await stack(async (s) => {
    const client = createGraphClient({ baseUrl: s.execUrl, expectedDatasetId: DSID });
    const POSTS = 40, WIDTH = 4;
    const ids = [];
    let done = false;
    const samples = [];
    const reader = (async () => {
      while (!done) {
        const m = await marker(s.execUrl);
        samples.push({ m, n: await deliverableAtOrBelow(s.execUrl, m), r: await redactionsAtOrBelow(s.execUrl, m) });
      }
    })();
    let next = 0, redacted = 0;
    const redact = async (id, k) => {
      const r = await client.update({ kind: 'post.redact', opId: `${EX}op/redact/v1607-${k}`, actor: 'https://scrumboard.local/person/ada',
        post: { id }, authorityRef: 'test-authority-ref', occurredAt: '2026-11-24T00:00:00.000Z' });
      assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); redacted++;
    };
    const toRedact = [];
    try {
      await Promise.all(Array.from({ length: WIDTH }, async (_, w) => {
        while (next < POSTS) {
          const i = next++;
          const r = await fetch(`${s.base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ author: 'ada', body: `v1607 v2 post ${i}` }), signal: AbortSignal.timeout(30000) });
          const text = await r.text();
          assert.equal(r.status, 201, text);
          ids.push(JSON.parse(text).id);
          if (i % 3 === 0 && toRedact.length < ids.length - 1) { const id = ids[toRedact.length]; toRedact.push(id); await redact(id, `${w}-${i}`); }   // redact an earlier post, each once, while posting continues
        }
      }));
    } catch (e) { done = true; await reader.catch(() => {}); throw e; }   // a writer's own error is the one reported, not the reader's teardown reset
    done = true; await reader;   // the writers succeeded: a reader failure is a failure, never masked by earlier samples
    const h = await marker(s.execUrl);
    assert.equal(await redactionsAtOrBelow(s.execUrl, h), redacted, `control: every redaction is deliverable once the writers stop\n${s.stderr()}`);
    assert.ok(redacted >= 8, `control: redactions ran (${redacted})`);
    assert.ok(samples.length >= 20 && new Set(samples.map((x) => x.m)).size >= 10, `sampled while the head moved (samples ${samples.length})`);
    for (const { m, n, r } of samples) {
      assert.equal(await deliverableAtOrBelow(s.execUrl, m), n, `a post at or below head ${m} became deliverable after that head was read`);
      assert.equal(await redactionsAtOrBelow(s.execUrl, m), r, `a redaction at or below head ${m} became deliverable after that head was read`);
    }
  });
});

test('V0 CONTROL: a post whose node lands in a LATER update than its receipt IS caught by the same check', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await say(s.base, 0);
    const op = `${EX}op/post/v1607-control`;
    // update 1: the commit and an APPLIED receipt, and NO post node yet
    await exUpdate(s.execUrl, op, `DELETE { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s } }
INSERT { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s1 . <${op}> <${EX}commitSeq> ?s1 ; <${EX}outcome> <${EX}APPLIED> } }
WHERE { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s } BIND(?s + 1 AS ?s1) }`);
    const m = await marker(s.execUrl);
    const n = await deliverableAtOrBelow(s.execUrl, m);
    // update 2: the node, recorded by that op
    const node = 'https://scrumboard.local/entity/v1607-control';
    await exUpdate(s.execUrl, `${EX}op/raw/v1607-node`, `INSERT DATA { GRAPH ${bk()} { <${node}> <${EX}recordedBy> <${op}> } <${node}> <${RDF_TYPE}> <${COMMENT}> }`);
    const later = await deliverableAtOrBelow(s.execUrl, m);
    assert.equal(later, n + 1, 'the check sees a post at or below an already-read head become deliverable later: the case V1 rules out');
  });
});

test('V0R CONTROL: a redaction whose tombstone lands in a LATER update than its receipt IS caught by the same check', { skip: SKIP }, async () => {
  await stack(async (s) => {
    await say(s.base, 0);
    const op = `${EX}op/redact/v1607-control`;
    // update 1: the commit and an APPLIED receipt for a redaction operation, and NO tombstone naming it yet
    await exUpdate(s.execUrl, op, `DELETE { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s } }
INSERT { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s1 . <${op}> <${EX}commitSeq> ?s1 ; <${EX}outcome> <${EX}APPLIED> } }
WHERE { GRAPH ${bk()} { <${EX}dataset> <${EX}commitSeq> ?s } BIND(?s + 1 AS ?s1) }`);
    const m = await marker(s.execUrl);
    const r = await redactionsAtOrBelow(s.execUrl, m);
    // update 2: the tombstone that names the redaction
    await exUpdate(s.execUrl, `${EX}op/raw/v1607-tombstone`, `INSERT DATA { <https://scrumboard.local/entity/v1607-redacted> <${RS}redactedBy> <${op}> }`);
    assert.equal(await redactionsAtOrBelow(s.execUrl, m), r + 1, 'the check sees a redaction at or below an already-read head become deliverable later: the case V2 rules out');
  });
});
